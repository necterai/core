import type { SignalInput } from '@necterai/core';
import type { AnalyzerApi, RequestAnalyzer, RequestContext, TlsHints } from '../types.js';
import { getKnowledge, type AgentRecord, type HttpLibraryProfile, type IpRangeSet, type Knowledge, type SharedEgressList } from '../knowledge.js';
import { createCidrMatcher, isPrivateOrReservedIp, parseIp, type CidrMatcher } from '../net/cidr.js';
import { createRdnsVerifier, type DnsLike, type RdnsVerifier } from '../net/rdns.js';
import { BROWSER_PSEUDO_ORDER, ja4RawHasGrease, parseAkamai, parseJa4 } from '../net/ja4.js';
import { resolveDeclaredAgent } from './user-agent.js';
import { uaFamily } from './header-shape.js';

/**
 * Network identity (detection-spec §9, server-fingerprints.md §3–5):
 *
 * - Provider-range verification: a UA that declares a product whose operator
 *   publishes IP ranges is checked against them → `network.ip-range-verified`
 *   (details.verification = 'passed', method 'ip-range'), or, when the
 *   published list is complete and the IP is outside it,
 *   `network.declared-but-unverified`.
 * - Optional FCrDNS (Node only, `options.rdns`) for operators that publish rDNS
 *   suffixes (Google, Apple, Common Crawl, Bing...) → `network.rdns-verified`.
 * - An undeclared client inside an AI operator's published egress range →
 *   `network.known-agent-asn` with a provider hint.
 * - Hosting ranges / hosting ASNs → `network.datacenter-ip`; shared egress
 *   (iCloud Private Relay, WARP, Zscaler) suppresses it (detail 'shared-egress',
 *   zero weight) and tags the session `shared-egress`.
 * - TLS / HTTP2 (edge-supplied JA4, GREASE flag, Akamai h2): library cipher hash
 *   or library h2 settings under a browser UA → `network.tls-ua-mismatch`;
 *   library UA + library fingerprint → `network.tls-fingerprint-library`.
 *   Enterprise TLS-intercepting proxies (Zscaler list) damp these.
 *
 * Private, loopback and documentation addresses are never attributed.
 */

export interface NetworkAnalyzerOptions {
  knowledge?: Knowledge;
  /** Prebuilt rDNS verifier (shared cache, tests). Default: created on first use when `options.rdns` is true. */
  rdnsVerifier?: RdnsVerifier;
  /** DNS implementation for the default rDNS verifier (tests). Default: node:dns/promises when available. */
  dns?: DnsLike;
}

interface SharedHit {
  id: string;
  name: string;
  kind: SharedEgressList['kind'];
  prefix?: string;
  asn?: number;
}

const matcherCache = new WeakMap<object, CidrMatcher>();
function matcherFor(obj: { prefixes: string[] }): CidrMatcher {
  let m = matcherCache.get(obj);
  if (!m) {
    m = createCidrMatcher(obj.prefixes ?? []);
    matcherCache.set(obj, m);
  }
  return m;
}

function feedKey(url: string): string {
  return url.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
}

/** Range sets that publish egress for the declared product (specific) and for the operator at large. */
export function candidateRangeSets(kb: Knowledge, record: AgentRecord): { specific: IpRangeSet[]; provider: IpRangeSet[] } {
  const provider = kb.ipRanges.filter((s) => (s.kind ?? 'agent') === 'agent' && s.provider === record.provider);
  const urls = new Set((record.ipRangeUrls ?? []).map(feedKey));
  const specific = provider.filter((s) => urls.has(feedKey(s.source)) || (s.product !== undefined && s.product.toLowerCase() === record.product.toLowerCase()));
  return { specific, provider };
}

function findShared(kb: Knowledge, ip: string, asn: number | undefined): SharedHit | undefined {
  for (const list of kb.sharedEgress) {
    const prefix = list.prefixes?.length ? matcherFor(list).find(ip) : undefined;
    if (prefix) return { id: list.id, name: list.name, kind: list.kind, prefix };
    if (asn !== undefined && list.asns?.includes(asn)) return { id: list.id, name: list.name, kind: list.kind, asn };
  }
  for (const set of kb.ipRanges) {
    if (set.kind !== 'shared-egress') continue;
    const prefix = matcherFor(set).find(ip);
    if (prefix) return { id: set.product ?? set.provider, name: set.product ?? set.provider, kind: 'relay', prefix };
  }
  if (asn !== undefined) {
    const a = kb.hostingAsns.find((h) => h.asn === asn && h.kind === 'shared-egress');
    if (a) return { id: `as${a.asn}`, name: a.name, kind: 'relay', asn };
  }
  return undefined;
}

interface Finding {
  summary: string;
  reliability: number;
  details: Record<string, unknown>;
  value?: unknown;
}

function merge(id: string, findings: Finding[], damp?: { factor: number; shared: SharedHit }): SignalInput | undefined {
  if (!findings.length) return undefined;
  const best = findings.reduce((a, b) => (b.reliability > a.reliability ? b : a));
  const others = findings.filter((f) => f !== best);
  let reliability = Math.min(1, best.reliability + 0.1 * others.length);
  const details: Record<string, unknown> = { ...best.details, checks: findings.map((f) => f.summary) };
  if (damp) {
    reliability *= damp.factor;
    details['sharedEgress'] = damp.shared.id;
    details['damped'] = 'enterprise TLS-intercepting proxy';
  }
  const sig: SignalInput = {
    id,
    summary: (others.length ? `${best.summary} (+${others.length} more: ${others.map((f) => f.summary).join('; ')})` : best.summary).slice(0, 300),
    reliability: Math.round(reliability * 1000) / 1000,
    details,
  };
  if (best.value !== undefined) sig.value = best.value;
  return sig;
}

/** Akamai h2 fingerprints that real browsers send (never evidence of a library on their own). */
function browserAkamai(kb: Knowledge): Set<string> {
  return new Set(kb.browserHeaderProfiles.flatMap((b) => b.akamai));
}

/** TLS / HTTP2 consistency (checks C1–C4 of server-fingerprints.md §4). Pure; exported for tests. */
export function analyzeTls(tls: TlsHints | undefined, ua: string, opts: { knowledge?: Knowledge; declaredLibrary?: boolean; shared?: SharedHit } = {}): SignalInput[] {
  if (!tls) return [];
  const kb = opts.knowledge ?? getKnowledge();
  const fam = uaFamily(ua);
  const claimsBrowser = fam.family === 'chromium' || fam.family === 'firefox' || fam.family === 'safari';
  const mismatch: Finding[] = [];
  const library: Finding[] = [];
  const parts = parseJa4(tls.ja4);
  const uaMatches = (p: HttpLibraryProfile) => {
    if (!p.uaPattern) return false;
    try {
      return new RegExp(p.uaPattern, 'i').test(ua);
    } catch {
      return false;
    }
  };

  if (parts) {
    const ja4 = tls.ja4!.trim().toLowerCase();
    const exact = kb.httpLibraryProfiles.find((p) => p.ja4?.some((j) => j.toLowerCase() === ja4));
    const byCipher = kb.httpLibraryProfiles.filter((p) => p.ja4Cipher?.includes(parts.cipherHash) && !p.cipherSharedWithBrowser);
    // An exact JA4 of a profile whose cipher list is shared with a browser only counts when it cannot be
    // that browser: impersonation stacks (curl_cffi chrome/safari/firefox) negotiate h2 and may equal the
    // real browser byte for byte, Bun's BoringSSL hello is HTTP/1.1-only.
    const exactCounts = exact !== undefined && (!exact.cipherSharedWithBrowser || parts.alpn !== 'h2');
    const lib = exactCounts ? exact : byCipher[0];
    const hashFamily = kb.browserHeaderProfiles.find((b) => b.ja4Cipher.includes(parts.cipherHash))?.family;
    const libNames = exactCounts ? exact!.name : byCipher.map((p) => p.name).slice(0, 3).join(' / ');
    if (claimsBrowser) {
      if (lib) {
        mismatch.push({ summary: `${fam.family} UA but JA4 ${ja4} is ${libNames || lib.name} (${exactCounts ? 'exact JA4' : `cipher hash ${parts.cipherHash}`})`, reliability: 1, details: { check: 'C1', library: lib.name, ja4, match: exactCounts ? 'ja4' : 'cipher-hash' }, value: ja4 });
      } else if (hashFamily && hashFamily !== fam.family) {
        mismatch.push({ summary: `${fam.family} UA but the TLS cipher list is ${hashFamily}'s (${parts.cipherHash})`, reliability: 0.8, details: { check: 'C1', tlsFamily: hashFamily, ja4 }, value: ja4 });
      } else if (!hashFamily && !lib && (parts.cipherCount > 40 || parts.cipherCount < 8)) {
        mismatch.push({ summary: `${fam.family} UA but ClientHello offers ${parts.cipherCount} cipher suites (browsers offer 15–21)`, reliability: 0.6, details: { check: 'C1', ja4, ciphers: parts.cipherCount }, value: ja4 });
      }
      if (parts.alpn === '00') {
        mismatch.push({ summary: `${fam.family} UA but the ClientHello has no ALPN (Scrapy, wget, Go/Java HTTP/1.1, node:https)`, reliability: 0.9, details: { check: 'C3', ja4 }, value: ja4 });
      } else if (tls.alpn === 'h2' && parts.alpn === 'h1') {
        mismatch.push({ summary: 'ALPN offers http/1.1 before h2 yet the connection is h2 (httpx / undici allowH2), no browser does this', reliability: 0.9, details: { check: 'C3', ja4 }, value: ja4 });
      }
    } else if (lib) {
      const own = uaMatches(lib) || byCipher.some(uaMatches);
      library.push({
        summary: `JA4 ${ja4} matches ${libNames || lib.name}${own ? ' (consistent with the User-Agent)' : ''}`,
        reliability: own || opts.declaredLibrary ? 1 : 0.8,
        details: { check: 'C1', library: lib.name, ja4, match: exactCounts ? 'ja4' : 'cipher-hash', uaMatchesLibrary: own },
        value: ja4,
      });
    } else if (tls.alpn === 'h2' && parts.alpn === 'h1') {
      library.push({ summary: 'ALPN offers http/1.1 before h2 on an h2 connection (httpx[http2] / undici allowH2)', reliability: 0.7, details: { check: 'C3', ja4 }, value: ja4 });
    }
  }

  // C4: Chromium and WebKit always GREASE; libraries never do.
  const grease = tls.grease ?? ja4RawHasGrease(tls.ja4_r);
  if (grease === false && (fam.family === 'chromium' || fam.family === 'safari')) {
    mismatch.push({ summary: `${fam.family} UA but the ClientHello carries no GREASE values (Chromium/WebKit always GREASE)`, reliability: 0.9, details: { check: 'C4' } });
  }

  // C2: HTTP/2 SETTINGS and pseudo-header order.
  const ak = parseAkamai(tls.h2);
  if (ak) {
    const browserFps = browserAkamai(kb);
    const libAk = browserFps.has(ak.raw) ? undefined : kb.httpLibraryProfiles.find((p) => p.akamai?.includes(ak.raw) && !p.cipherSharedWithBrowser);
    if (claimsBrowser) {
      const expected = BROWSER_PSEUDO_ORDER[fam.family as 'chromium' | 'firefox' | 'safari'];
      if (libAk) {
        mismatch.push({ summary: `${fam.family} UA but HTTP/2 fingerprint is ${libAk.name}'s (${ak.raw.slice(0, 60)})`, reliability: 1, details: { check: 'C2', library: libAk.name, akamai: ak.raw }, value: ak.raw });
      } else if (expected && ak.pseudoOrder && ak.pseudoOrder !== expected) {
        mismatch.push({ summary: `${fam.family} UA but HTTP/2 pseudo-header order ${ak.pseudoOrder} (expected ${expected})`, reliability: 0.8, details: { check: 'C2', pseudoOrder: ak.pseudoOrder, expected }, value: ak.raw });
      }
    } else if (libAk) {
      library.push({ summary: `HTTP/2 fingerprint matches ${libAk.name}`, reliability: uaMatches(libAk) || opts.declaredLibrary ? 1 : 0.8, details: { check: 'C2', library: libAk.name, akamai: ak.raw }, value: ak.raw });
    }
  }

  const damp = opts.shared?.kind === 'enterprise-proxy' ? { factor: 0.2, shared: opts.shared } : undefined;
  const out: SignalInput[] = [];
  const m = merge('network.tls-ua-mismatch', mismatch, damp);
  if (m) out.push(m);
  const l = merge('network.tls-fingerprint-library', library, damp);
  if (l) out.push(l);
  return out;
}

export function networkAnalyzer(opts: NetworkAnalyzerOptions = {}): RequestAnalyzer {
  let rdns: RdnsVerifier | undefined = opts.rdnsVerifier;
  const getRdns = (api: AnalyzerApi): RdnsVerifier => {
    rdns ??= createRdnsVerifier({ timeoutMs: api.options.rdnsTimeoutMs, ...(opts.dns ? { dns: opts.dns } : {}) });
    return rdns;
  };

  return {
    name: 'network',
    async analyze(ctx: RequestContext, api: AnalyzerApi) {
      const kb = opts.knowledge ?? getKnowledge();
      const ua = (ctx.headers.get('user-agent') ?? '').trim();
      const declared = ua ? resolveDeclaredAgent(ua, kb) : undefined;
      const parsed = ctx.ip ? parseIp(ctx.ip) : undefined;
      const ip = parsed && !isPrivateOrReservedIp(parsed.text) ? parsed.text : undefined;
      const shared = ip ? findShared(kb, ip, ctx.asn) : undefined;

      if (ip) {
        let verified = false;
        const record = declared?.record;
        // ── Declared product ↔ published ranges / rDNS ──
        if (record && record.provider !== 'unknown' && record.kind !== 'http-library' && record.kind !== 'headless') {
          const { specific, provider } = candidateRangeSets(kb, record);
          const hitSpecific = specific.map((s) => ({ s, prefix: matcherFor(s).find(ip) })).find((h) => h.prefix);
          const hitProvider = hitSpecific ? undefined : provider.map((s) => ({ s, prefix: matcherFor(s).find(ip) })).find((h) => h.prefix);
          const hit = hitSpecific ?? hitProvider;
          if (hit) {
            verified = true;
            api.emit({
              id: 'network.ip-range-verified',
              summary: `${ip} is inside ${record.product}'s published range ${hit.prefix} (${hit.s.source})${hitProvider ? ` [${hit.s.product ?? record.provider} list]` : ''}`,
              value: ip,
              details: {
                verification: 'passed',
                method: 'ip-range',
                prefix: hit.prefix,
                source: hit.s.source,
                product: record.product,
                ...(hitProvider ? { productMismatch: true, rangeProduct: hit.s.product ?? null } : {}),
              },
              provider: { id: record.provider, product: record.product, confidence: hitProvider ? 0.9 : 0.99 },
            });
          }
          let rdnsFailure: { reason?: string; ptr?: string } | undefined;
          if (!verified && api.options.rdns && record.rdnsSuffixes?.length) {
            try {
              const r = await getRdns(api).verify(ip, record.rdnsSuffixes);
              if (r.status === 'verified') {
                verified = true;
                api.emit({
                  id: 'network.rdns-verified',
                  summary: `FCrDNS: ${ip} → ${r.ptr} → ${ip} (suffix ${r.matchedSuffix}) for ${record.product}`,
                  value: r.ptr,
                  details: { verification: 'passed', method: 'rdns', ptr: r.ptr, suffix: r.matchedSuffix, product: record.product, ...(r.cached ? { cached: true } : {}) },
                  provider: { id: record.provider, product: record.product, confidence: 0.99 },
                });
              } else if (r.status === 'failed') {
                rdnsFailure = { ...(r.reason ? { reason: r.reason } : {}), ...(r.ptr ? { ptr: r.ptr } : {}) };
              }
            } catch (err) {
              api.log('rdns error', err);
            }
          }
          const complete = specific.length > 0 && specific.every((s) => !s.partial);
          if (!verified && (complete || rdnsFailure)) {
            api.emit({
              id: 'network.declared-but-unverified',
              summary: `UA claims ${record.product} but ${ip} ${complete ? `is outside its published ranges (${specific.map((s) => s.source).join(', ')})` : ''}${complete && rdnsFailure ? ' and ' : ''}${rdnsFailure ? `failed FCrDNS (${rdnsFailure.reason ?? 'failed'})` : ''}`.slice(0, 300),
              value: ip,
              details: {
                verification: 'failed',
                method: complete ? 'ip-range' : 'rdns',
                product: record.product,
                claimedProvider: record.provider,
                ...(complete ? { sources: specific.map((s) => s.source) } : {}),
                ...(rdnsFailure ? { rdns: rdnsFailure } : {}),
              },
            });
          }
        }

        // ── Undeclared traffic from an AI operator's published egress ──
        if (!verified) {
          for (const set of kb.ipRanges) {
            if ((set.kind ?? 'agent') !== 'agent' || set.provider === record?.provider) continue;
            const prefix = matcherFor(set).find(ip);
            if (!prefix) continue;
            api.emit({
              id: 'network.known-agent-asn',
              summary: `${ip} is inside ${set.provider}${set.product ? ` ${set.product}` : ''} published egress ${prefix} although the UA does not declare it`,
              value: ip,
              details: { prefix, source: set.source, rangeProvider: set.provider, ...(set.product ? { rangeProduct: set.product } : {}) },
              provider: { id: set.provider, ...(set.product ? { product: set.product } : {}), confidence: 0.6 },
            });
            break;
          }
        }

        // ── Hosting / shared egress ──
        if (!verified) {
          const hostingSet = kb.ipRanges.find((s) => s.kind === 'hosting' && matcherFor(s).find(ip));
          const asnHit = ctx.asn !== undefined ? kb.hostingAsns.find((a) => a.asn === ctx.asn && (a.kind === 'cloud' || a.kind === 'hosting')) : undefined;
          if (shared) {
            api.session.tags.add('shared-egress');
            api.emit({
              id: 'network.datacenter-ip',
              summary: `${ip} is shared egress (${shared.name}); datacenter signal suppressed`,
              value: ip,
              automation: 0,
              reliability: 0,
              details: {
                suppressed: 'shared-egress',
                sharedEgress: shared.id,
                sharedKind: shared.kind,
                ...(shared.prefix ? { prefix: shared.prefix } : {}),
                ...(shared.asn !== undefined ? { asn: shared.asn } : {}),
                ...(hostingSet ? { hostingProvider: hostingSet.provider } : asnHit ? { hostingProvider: asnHit.provider ?? asnHit.name } : {}),
              },
            });
          } else if (hostingSet || asnHit) {
            const prefix = hostingSet ? matcherFor(hostingSet).find(ip) : undefined;
            api.emit({
              id: 'network.datacenter-ip',
              summary: hostingSet ? `${ip} is in ${hostingSet.provider} hosting range ${prefix}` : `AS${asnHit!.asn} (${asnHit!.name}) is a ${asnHit!.kind} network`,
              value: ip,
              details: {
                hostingProvider: hostingSet?.provider ?? asnHit?.provider ?? asnHit?.name,
                ...(prefix ? { prefix, source: hostingSet!.source } : {}),
                ...(asnHit ? { asn: asnHit.asn, asnName: asnHit.name } : {}),
              },
            });
          }
        }
      }

      // ── TLS / HTTP2 ──
      for (const s of analyzeTls(ctx.tls, ua, { knowledge: kb, declaredLibrary: declared?.record.kind === 'http-library', ...(shared ? { shared } : {}) })) api.emit(s);
    },
  };
}
