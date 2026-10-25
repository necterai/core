/**
 * Dependency-free IPv4/IPv6 parsing and CIDR matching. Addresses are normalised
 * to 128-bit BigInts (IPv4 is embedded as ::ffff:a.b.c.d) so one sorted table
 * serves both families. Matching is a binary search over sorted (start, end)
 * ranges; the tables we bundle are small (tens to a few thousand prefixes).
 */

export interface ParsedIp {
  family: 4 | 6;
  value: bigint;
  /** Canonical textual form (IPv4 dotted quad, IPv6 lower-case with :: compression). */
  text: string;
}

const V4_MAPPED_PREFIX = 0xffffn << 32n;
const MAX128 = (1n << 128n) - 1n;

export function parseIp(input: string): ParsedIp | undefined {
  if (!input) return undefined;
  let s = input.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  // Strip an IPv6 zone id (fe80::1%eth0).
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  if (s.includes(':')) return parseV6(s);
  return parseV4(s);
}

function parseV4(s: string): ParsedIp | undefined {
  const parts = s.split('.');
  if (parts.length !== 4) return undefined;
  let v = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return undefined;
    const n = Number(p);
    if (n > 255) return undefined;
    v = (v << 8n) | BigInt(n);
  }
  return { family: 4, value: V4_MAPPED_PREFIX | v, text: parts.map((p) => String(Number(p))).join('.') };
}

function parseV6(s: string): ParsedIp | undefined {
  // Embedded IPv4 tail (::ffff:1.2.3.4).
  let tail: bigint | undefined;
  const lastColon = s.lastIndexOf(':');
  if (lastColon !== -1 && s.slice(lastColon + 1).includes('.')) {
    const v4 = parseV4(s.slice(lastColon + 1));
    if (!v4) return undefined;
    tail = v4.value & 0xffffffffn;
    s = s.slice(0, lastColon + 1) + '0:0';
  }
  const dbl = s.indexOf('::');
  if (dbl !== -1 && s.indexOf('::', dbl + 1) !== -1) return undefined;
  let head: string[];
  let rest: string[];
  if (dbl !== -1) {
    head = s.slice(0, dbl) ? s.slice(0, dbl).split(':') : [];
    rest = s.slice(dbl + 2) ? s.slice(dbl + 2).split(':') : [];
    if (head.length + rest.length > 7) return undefined;
  } else {
    head = s.split(':');
    rest = [];
    if (head.length !== 8) return undefined;
  }
  const groups: number[] = [];
  for (const g of head) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
    groups.push(parseInt(g, 16));
  }
  const missing = 8 - head.length - rest.length;
  for (let i = 0; i < missing; i++) groups.push(0);
  for (const g of rest) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
    groups.push(parseInt(g, 16));
  }
  if (groups.length !== 8) return undefined;
  let v = 0n;
  for (const g of groups) v = (v << 16n) | BigInt(g);
  if (tail !== undefined) v = (v & ~0xffffffffn) | tail;
  // ::ffff:a.b.c.d is an IPv4 address for matching purposes.
  if ((v >> 32n) === 0xffffn) {
    const v4 = v & 0xffffffffn;
    return { family: 4, value: v, text: [24n, 16n, 8n, 0n].map((sh) => String((v4 >> sh) & 0xffn)).join('.') };
  }
  return { family: 6, value: v, text: formatV6(v) };
}

export function formatV6(v: bigint): string {
  const groups: number[] = [];
  for (let i = 7; i >= 0; i--) groups.push(Number((v >> BigInt(i * 16)) & 0xffffn));
  // Longest run of zeros for :: compression.
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) {
      bestLen = j - i;
      bestStart = i;
    }
    i = j;
  }
  if (bestLen < 2) return groups.map((g) => g.toString(16)).join(':');
  const left = groups.slice(0, bestStart).map((g) => g.toString(16)).join(':');
  const right = groups.slice(bestStart + bestLen).map((g) => g.toString(16)).join(':');
  return `${left}::${right}`;
}

export interface CidrRange {
  start: bigint;
  end: bigint;
  prefix: string;
}

export function parseCidr(prefix: string): CidrRange | undefined {
  const p = prefix.trim();
  const slash = p.lastIndexOf('/');
  const addr = parseIp(slash === -1 ? p : p.slice(0, slash));
  if (!addr) return undefined;
  const totalBits = addr.family === 4 ? 32 : 128;
  let bits = slash === -1 ? totalBits : Number(p.slice(slash + 1));
  if (!Number.isInteger(bits) || bits < 0 || bits > totalBits) return undefined;
  if (addr.family === 4) bits += 96; // IPv4 lives in the low 32 bits of the 128-bit space.
  const hostBits = BigInt(128 - bits);
  const mask = hostBits === 0n ? MAX128 : (MAX128 >> hostBits) << hostBits;
  const start = addr.value & mask;
  const end = start | (hostBits === 0n ? 0n : (1n << hostBits) - 1n);
  return { start, end, prefix: p };
}

export interface CidrMatcher {
  (ip: string): boolean;
  /** Returns the matching prefix string, if any. */
  find(ip: string): string | undefined;
  readonly size: number;
}

/** Build a matcher over a list of CIDR prefixes (bare IPs are accepted as /32 or /128). */
export function createCidrMatcher(prefixes: Iterable<string>): CidrMatcher {
  const ranges: CidrRange[] = [];
  for (const p of prefixes) {
    const r = parseCidr(p);
    if (r) ranges.push(r);
  }
  ranges.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.end > b.end ? -1 : a.end < b.end ? 1 : 0));
  // Merge nested/overlapping ranges so binary search on `start` is sufficient.
  const merged: CidrRange[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      if (r.end > last.end) last.end = r.end;
      continue;
    }
    merged.push({ ...r });
  }
  const find = (ip: string): string | undefined => {
    const parsed = typeof ip === 'string' ? parseIp(ip) : undefined;
    if (!parsed || merged.length === 0) return undefined;
    let lo = 0;
    let hi = merged.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = merged[mid]!;
      if (parsed.value < r.start) hi = mid - 1;
      else if (parsed.value > r.end) lo = mid + 1;
      else return r.prefix;
    }
    return undefined;
  };
  const fn = ((ip: string) => find(ip) !== undefined) as CidrMatcher;
  Object.defineProperty(fn, 'find', { value: find });
  Object.defineProperty(fn, 'size', { value: merged.length });
  return fn;
}

const PRIVATE_V4 = createCidrMatcher([
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
  '192.0.0.0/24', '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24',
  '224.0.0.0/4', '240.0.0.0/4',
]);
const PRIVATE_V6 = createCidrMatcher(['::/128', '::1/128', 'fc00::/7', 'fe80::/10', 'ff00::/8', '2001:db8::/32', '100::/64']);

/** True for loopback, private, link-local, documentation and multicast space (never geolocate or attribute these). */
export function isPrivateOrReservedIp(ip: string): boolean {
  const parsed = parseIp(ip);
  if (!parsed) return true;
  return parsed.family === 4 ? PRIVATE_V4(parsed.text) : PRIVATE_V6(parsed.text);
}

/** Documentation ranges (RFC 5737 / RFC 3849) are "public-looking" and useful in tests; everything else reserved is not. */
export function isDocumentationIp(ip: string): boolean {
  const parsed = parseIp(ip);
  if (!parsed) return false;
  return createCidrMatcher(['192.0.2.0/24', '198.51.100.0/24', '203.0.113.0/24', '2001:db8::/32'])(parsed.text);
}

export function isIpLiteral(host: string): boolean {
  return parseIp(host) !== undefined;
}
