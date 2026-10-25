/**
 * Forward-confirmed reverse DNS (FCrDNS) for crawlers that publish rDNS
 * suffixes (Google, Apple, Common Crawl, Bing, You.com, Mistral...). Algorithm
 * from server-fingerprints.md §5.5: PTR → suffix allow-list → A/AAAA of the PTR
 * name must contain the client IP; positive results cached 24 h, negative 1 h;
 * never trust a PTR alone. Node only: `node:dns/promises` is loaded lazily
 * through a non-literal dynamic import so bundlers for edge runtimes leave it
 * out, and the verifier reports `unavailable` elsewhere.
 */
import { parseIp } from './cidr.js';

export interface DnsLike {
  reverse(ip: string): Promise<string[]>;
  resolve4(name: string): Promise<string[]>;
  resolve6(name: string): Promise<string[]>;
}

export type RdnsStatus = 'verified' | 'failed' | 'unavailable';

export interface RdnsResult {
  status: RdnsStatus;
  ptr?: string;
  matchedSuffix?: string;
  forward?: string[];
  reason?: string;
  cached?: boolean;
}

export interface RdnsVerifierOptions {
  dns?: DnsLike;
  /** Loader used when `dns` is not supplied (default: node:dns/promises if available). */
  loadDns?: () => Promise<DnsLike | undefined>;
  timeoutMs?: number;
  positiveTtlMs?: number;
  negativeTtlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export interface RdnsVerifier {
  verify(ip: string, suffixes: readonly string[]): Promise<RdnsResult>;
  readonly cache: Map<string, { result: RdnsResult; expiresAt: number }>;
}

export async function loadNodeDns(): Promise<DnsLike | undefined> {
  try {
    const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
    if (!proc?.versions?.node) return undefined;
    const specifier = 'node:dns/promises';
    const mod = (await import(/* @vite-ignore */ specifier)) as { reverse(ip: string): Promise<string[]>; resolve4(n: string): Promise<string[]>; resolve6(n: string): Promise<string[]> };
    return { reverse: (ip) => mod.reverse(ip), resolve4: (n) => mod.resolve4(n), resolve6: (n) => mod.resolve6(n) };
  } catch {
    return undefined;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rdns-timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export function nameMatchesSuffix(name: string, suffix: string): boolean {
  const n = name.toLowerCase().replace(/\.$/, '');
  const s = suffix.toLowerCase().replace(/^\./, '').replace(/\.$/, '');
  return n === s || n.endsWith('.' + s);
}

export function createRdnsVerifier(opts: RdnsVerifierOptions = {}): RdnsVerifier {
  const now = opts.now ?? (() => Date.now());
  const timeoutMs = opts.timeoutMs ?? 1500;
  const positiveTtl = opts.positiveTtlMs ?? 24 * 3600_000;
  const negativeTtl = opts.negativeTtlMs ?? 3600_000;
  const maxEntries = opts.maxEntries ?? 20_000;
  const cache = new Map<string, { result: RdnsResult; expiresAt: number }>();
  let dnsPromise: Promise<DnsLike | undefined> | undefined = opts.dns ? Promise.resolve(opts.dns) : undefined;

  async function verify(ip: string, suffixes: readonly string[]): Promise<RdnsResult> {
    const parsed = parseIp(ip);
    if (!parsed || !suffixes.length) return { status: 'unavailable', reason: parsed ? 'no-suffixes' : 'bad-ip' };
    const key = `${parsed.text}|${[...suffixes].sort().join(',')}`;
    const t = now();
    const hit = cache.get(key);
    if (hit && hit.expiresAt > t) return { ...hit.result, cached: true };
    dnsPromise ??= (opts.loadDns ?? loadNodeDns)();
    const dns = await dnsPromise;
    if (!dns) return { status: 'unavailable', reason: 'dns-unavailable' };
    const result = await lookup(dns, parsed.text, parsed.family, suffixes);
    if (result.status !== 'unavailable') {
      if (cache.size >= maxEntries) cache.delete(cache.keys().next().value as string);
      cache.set(key, { result, expiresAt: t + (result.status === 'verified' ? positiveTtl : negativeTtl) });
    }
    return result;
  }

  async function lookup(dns: DnsLike, ip: string, family: 4 | 6, suffixes: readonly string[]): Promise<RdnsResult> {
    let names: string[];
    try {
      names = await withTimeout(dns.reverse(ip), timeoutMs);
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      if (msg === 'rdns-timeout') return { status: 'unavailable', reason: 'timeout' };
      // ENOTFOUND / ENODATA: no PTR at all is a definitive failure.
      return { status: 'failed', reason: 'no-ptr' };
    }
    if (!names.length) return { status: 'failed', reason: 'no-ptr' };
    const candidates = names.map((n) => ({ name: n, suffix: suffixes.find((s) => nameMatchesSuffix(n, s)) })).filter((c) => c.suffix);
    if (!candidates.length) return { status: 'failed', reason: 'ptr-outside-suffixes', ptr: names[0]! };
    for (const c of candidates) {
      try {
        const addrs = await withTimeout(family === 4 ? dns.resolve4(c.name) : dns.resolve6(c.name), timeoutMs);
        const normalised = addrs.map((a) => parseIp(a)?.text ?? a);
        if (normalised.includes(ip)) return { status: 'verified', ptr: c.name, matchedSuffix: c.suffix!, forward: normalised };
      } catch (err) {
        if ((err as Error)?.message === 'rdns-timeout') return { status: 'unavailable', reason: 'timeout', ptr: c.name };
      }
    }
    return { status: 'failed', reason: 'forward-mismatch', ptr: candidates[0]!.name };
  }

  return { verify, cache };
}

/** True when running on Node (where `node:dns/promises` exists). */
export function isNodeRuntime(): boolean {
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  return Boolean(proc?.versions?.node);
}

/**
 * Host → addresses resolver backed by `node:dns/promises` `lookup(host, { all: true })` (honours
 * /etc/hosts like the fetch that follows). Returns undefined off Node. Used as the DNS-level SSRF
 * guard of the Web Bot Auth directory fetcher.
 */
export function createNodeResolveHost(): ((host: string) => Promise<string[]>) | undefined {
  if (!isNodeRuntime()) return undefined;
  let mod: Promise<{ lookup(host: string, opts: { all: true }): Promise<{ address: string }[]> } | undefined> | undefined;
  return async (host: string) => {
    mod ??= (async () => {
      try {
        const specifier = 'node:dns/promises';
        return (await import(/* @vite-ignore */ specifier)) as { lookup(host: string, opts: { all: true }): Promise<{ address: string }[]> };
      } catch {
        return undefined;
      }
    })();
    const m = await mod;
    if (!m) throw new Error('dns-unavailable');
    const res = await m.lookup(host, { all: true });
    return res.map((r) => r.address);
  };
}
