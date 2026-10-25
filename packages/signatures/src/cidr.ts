/**
 * CIDR matching for IPv4 and IPv6 with sorted, merged ranges and binary search.
 * Pure (no Node APIs) so it runs in browsers, Workers and Node.
 */

export interface ParsedIp {
  version: 4 | 6;
  value: bigint;
}

export interface CidrMatcher {
  (ip: string): boolean;
  /** The outermost configured prefix covering `ip` (nested prefixes are folded into their parent). */
  find(ip: string): string | undefined;
  /** Number of merged ranges. */
  readonly size: number;
}

const V4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function parseV4(s: string): bigint | undefined {
  const m = V4_RE.exec(s);
  if (!m) return undefined;
  let v = 0n;
  for (let i = 1; i <= 4; i++) {
    const part = m[i]!;
    if (part.length > 1 && part.startsWith('0')) return undefined; // reject octal-looking octets
    const n = Number(part);
    if (n > 255) return undefined;
    v = (v << 8n) | BigInt(n);
  }
  return v;
}

function parseV6(input: string): bigint | undefined {
  let s = input;
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (!s.includes(':')) return undefined;
  // Embedded IPv4 tail (::ffff:1.2.3.4, 64:ff9b::1.2.3.4): rewrite it as two hex groups.
  const lastColon = s.lastIndexOf(':');
  const maybeV4 = s.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    const v4 = parseV4(maybeV4);
    if (v4 === undefined) return undefined;
    s = `${s.slice(0, lastColon + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const dbl = s.indexOf('::');
  if (dbl !== s.lastIndexOf('::')) return undefined;
  const parseGroups = (part: string): number[] | undefined => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  let groups: number[];
  if (dbl !== -1) {
    const head = parseGroups(s.slice(0, dbl));
    const rest = parseGroups(s.slice(dbl + 2));
    if (!head || !rest) return undefined;
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return undefined;
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  } else {
    const all = parseGroups(s);
    if (!all) return undefined;
    groups = all;
  }
  if (groups.length !== 8) return undefined;
  let v = 0n;
  for (const g of groups) v = (v << 16n) | BigInt(g);
  return v;
}

/** Parse an IPv4 / IPv6 address. IPv4-mapped IPv6 (::ffff:a.b.c.d) is returned as IPv4. */
export function parseIp(input: string): ParsedIp | undefined {
  if (typeof input !== 'string') return undefined;
  const s = input.trim();
  if (!s) return undefined;
  const v4 = parseV4(s);
  if (v4 !== undefined) return { version: 4, value: v4 };
  const v6 = parseV6(s);
  if (v6 === undefined) return undefined;
  if (v6 >> 32n === 0xffffn) return { version: 4, value: v6 & 0xffffffffn };
  return { version: 6, value: v6 };
}

export interface CidrRange {
  version: 4 | 6;
  start: bigint;
  end: bigint;
  prefix: string;
}

/** Parse `a.b.c.d/n` or `x::/n`; a bare address is treated as /32 or /128. Host bits are masked off. */
export function parseCidr(input: string): CidrRange | undefined {
  if (typeof input !== 'string') return undefined;
  const s = input.trim();
  const slash = s.indexOf('/');
  const addr = parseIp(slash === -1 ? s : s.slice(0, slash));
  if (!addr) return undefined;
  // A mapped address written as IPv6 with an IPv6-sized prefix length: convert the length.
  const isMappedSyntax = addr.version === 4 && s.includes(':');
  const max = addr.version === 4 ? 32 : 128;
  let bits = max;
  if (slash !== -1) {
    const raw = s.slice(slash + 1);
    if (!/^\d{1,3}$/.test(raw)) return undefined;
    bits = Number(raw);
    if (isMappedSyntax) {
      if (bits < 96) return undefined;
      bits -= 96;
    }
    if (bits > max) return undefined;
  }
  const hostBits = BigInt(max - bits);
  const all = (1n << BigInt(max)) - 1n;
  const mask = all ^ ((1n << hostBits) - 1n);
  const start = addr.value & mask;
  const end = start | ((1n << hostBits) - 1n);
  return { version: addr.version, start, end, prefix: s };
}

/** True when `s` parses as a CIDR prefix or bare IP. */
export function isValidCidr(s: string): boolean {
  return parseCidr(s) !== undefined;
}

/** Canonical text for a prefix: bare IPs get /32 or /128, host bits are kept as published. */
export function canonicalPrefix(s: string): string | undefined {
  const r = parseCidr(s);
  if (!r) return undefined;
  const t = s.trim();
  if (t.includes('/')) return t;
  return `${t}/${r.version === 4 && !t.includes(':') ? 32 : 128}`;
}

function buildIndex(ranges: CidrRange[]): CidrRange[] {
  ranges.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.end > b.end ? -1 : a.end < b.end ? 1 : 0));
  const merged: CidrRange[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      if (r.end > last.end) last.end = r.end;
      continue;
    }
    merged.push({ ...r });
  }
  return merged;
}

function search(index: CidrRange[], value: bigint): CidrRange | undefined {
  let lo = 0;
  let hi = index.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = index[mid]!;
    if (value < r.start) hi = mid - 1;
    else if (value > r.end) lo = mid + 1;
    else return r;
  }
  return undefined;
}

/**
 * Build a matcher over CIDR prefixes (IPv4 + IPv6; bare IPs accepted). Invalid entries are
 * ignored. Ranges are sorted and merged per address family, lookups are O(log n).
 */
export function createCidrMatcher(prefixes: Iterable<string>): CidrMatcher {
  const v4: CidrRange[] = [];
  const v6: CidrRange[] = [];
  for (const p of prefixes) {
    const r = parseCidr(p);
    if (!r) continue;
    (r.version === 4 ? v4 : v6).push(r);
  }
  const idx4 = buildIndex(v4);
  const idx6 = buildIndex(v6);
  const find = (ip: string): string | undefined => {
    const parsed = parseIp(ip);
    if (!parsed) return undefined;
    return search(parsed.version === 4 ? idx4 : idx6, parsed.value)?.prefix;
  };
  const fn = ((ip: string) => find(ip) !== undefined) as CidrMatcher;
  Object.defineProperty(fn, 'find', { value: find });
  Object.defineProperty(fn, 'size', { value: idx4.length + idx6.length });
  return fn;
}
