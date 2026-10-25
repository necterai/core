import type { SignalInput } from '@necterai/core';
import type { RequestAnalyzer } from '../types.js';
import { getKnowledge, type HttpLibraryProfile, type Knowledge } from '../knowledge.js';

/**
 * Header-shape forensics (checks C5–C10 of docs/research/raw/server-fingerprints.md §4).
 * Browsers send a recognisable header set, order and casing; HTTP libraries do
 * not, and libraries that copy a browser UA rarely copy the rest. Every check
 * is a weighted vector entry, never a kill switch: findings are merged per
 * signal id so one request produces at most one signal per id.
 */

export type BrowserFamily = 'chromium' | 'firefox' | 'safari' | 'other' | 'none';

export interface UaFamily {
  family: BrowserFamily;
  /** Chrome/Chromium major (0 when not Chromium). */
  chromeMajor: number;
  firefoxMajor: number;
  safariMajor: number;
  /** Chromium shell brand the UA claims. */
  brand: 'chrome' | 'edge' | 'opera' | 'samsung' | 'chromium' | 'headless' | 'other';
  os: 'Windows' | 'macOS' | 'Android' | 'Linux' | 'iOS' | 'Chrome OS' | '';
  mobile: boolean;
  /** iOS WebKit shells (CriOS/FxiOS) and WebViews: skip client-hint and header-order expectations. */
  webkitShell: boolean;
}

export function uaFamily(ua: string): UaFamily {
  const out: UaFamily = { family: 'none', chromeMajor: 0, firefoxMajor: 0, safariMajor: 0, brand: 'other', os: '', mobile: /Mobile|Android|iPhone|iPad/.test(ua), webkitShell: false };
  if (!ua) return out;
  out.os = /Windows/.test(ua) ? 'Windows' : /Macintosh/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /CrOS/.test(ua) ? 'Chrome OS' : /Linux|X11/.test(ua) ? 'Linux' : '';
  if (!/Mozilla\/5\.0/.test(ua)) {
    out.family = 'other';
    return out;
  }
  if (/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua) || (out.os === 'iOS' && !/Safari\//.test(ua))) {
    out.family = 'safari';
    out.webkitShell = true;
    const v = /Version\/(\d+)/.exec(ua);
    out.safariMajor = v ? Number(v[1]) : 0;
    return out;
  }
  const fx = /Firefox\/(\d+)/.exec(ua);
  if (fx && !/Seamonkey/i.test(ua)) {
    out.family = 'firefox';
    out.firefoxMajor = Number(fx[1]);
    return out;
  }
  const cr = /(?:Chrome|Chromium|HeadlessChrome)\/(\d+)/.exec(ua);
  if (cr) {
    out.family = 'chromium';
    out.chromeMajor = Number(cr[1]);
    out.brand = /HeadlessChrome/.test(ua) ? 'headless' : /Edg\//.test(ua) ? 'edge' : /OPR\//.test(ua) ? 'opera' : /SamsungBrowser\//.test(ua) ? 'samsung' : /Chromium\//.test(ua) ? 'chromium' : 'chrome';
    if (/\bwv\b/.test(ua)) out.webkitShell = true; // Android WebView
    return out;
  }
  if (/Safari\//.test(ua) && /Version\/(\d+)/.test(ua)) {
    out.family = 'safari';
    out.safariMajor = Number(/Version\/(\d+)/.exec(ua)![1]);
    return out;
  }
  out.family = 'other';
  return out;
}

/** Header names a proxy, CDN or the application adds; excluded from order fingerprints. */
const ORDER_NOISE = /^(cookie|referer|authorization|content-length|content-type|transfer-encoding|forwarded|via|true-client-ip|cdn-loop|cache-control|pragma|range|origin|expect|x-.*|cf-.*|fly-.*|if-.*|proxy-.*|sec-necter-.*|:.*)$/i;

export function normaliseOrder(headerOrder: readonly string[]): string[] {
  return headerOrder.map((n) => n.toLowerCase()).filter((n) => !ORDER_NOISE.test(n));
}

/** Library Accept-Encoding literals (exact string → library). Browser values are excluded. */
export const LIBRARY_ACCEPT_ENCODING: Record<string, string> = {
  'gzip, compress, deflate, br': 'axios',
  'gzip, compress, deflate': 'axios (no brotli)',
  'zstd,gzip,deflate,br': 'Rust reqwest',
  identity: 'Python urllib / urllib3 / GNU Wget',
  'gzip, deflate': 'python-requests / aiohttp / Node fetch over http',
  gzip: 'Go net/http / OkHttp',
  'br, gzip, deflate': 'Node fetch (bundled undici) over https',
  'br, gzip, deflate, zstd': 'undici fetch over https',
  'gzip,br': 'Deno fetch',
  'deflate, gzip, br, zstd': 'curl --compressed',
};

const CHROME_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';

export interface HeaderShapeInput {
  headers: Headers;
  headerOrder?: string[];
  isDocument: boolean;
  alpn?: string;
  /**
   * Whether the browser saw a potentially trustworthy origin (https or localhost). Over plain http
   * real browsers send no Sec-Fetch-* and Chromium/Firefox advertise only `gzip, deflate`, so those
   * checks are skipped when this is false. Default true.
   */
  secureContext?: boolean;
  knowledge?: Knowledge;
}

/** https, localhost, or a TLS-terminating proxy that says so; a Sec-Fetch-* header also proves the browser considered it trustworthy. */
export function isSecureContextRequest(url: URL, headers: Headers): boolean {
  if (url.protocol === 'https:') return true;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]' || host === '::1') return true;
  if (/(^|,)\s*https\s*($|,)/i.test(headers.get('x-forwarded-proto') ?? '') || /"scheme"\s*:\s*"https"/.test(headers.get('cf-visitor') ?? '') || /proto=https/i.test(headers.get('forwarded') ?? '')) return true;
  return Boolean(headers.get('sec-fetch-mode') || headers.get('sec-fetch-dest') || headers.get('sec-fetch-site'));
}

interface Finding {
  id: string;
  summary: string;
  reliability: number;
  details?: Record<string, unknown>;
  value?: unknown;
}

/** Decode an HTTP2-Settings (base64url, RFC 7540 §3.2.1) payload to an Akamai-style `id:value;...` string. */
export function decodeHttp2Settings(b64: string): string | undefined {
  try {
    const norm = b64.replace(/-/g, '+').replace(/_/g, '/');
    const bin = typeof atob === 'function' ? atob(norm) : Buffer.from(norm, 'base64').toString('binary');
    if (bin.length % 6 !== 0) return undefined;
    const parts: string[] = [];
    for (let i = 0; i < bin.length; i += 6) {
      const id = (bin.charCodeAt(i) << 8) | bin.charCodeAt(i + 1);
      const value = ((bin.charCodeAt(i + 2) << 24) | (bin.charCodeAt(i + 3) << 16) | (bin.charCodeAt(i + 4) << 8) | bin.charCodeAt(i + 5)) >>> 0;
      parts.push(`${id}:${value}`);
    }
    return parts.join(';');
  } catch {
    return undefined;
  }
}

export function analyzeHeaderShape(input: HeaderShapeInput): SignalInput[] {
  const kb = input.knowledge ?? getKnowledge();
  const h = input.headers;
  const ua = h.get('user-agent') ?? '';
  const fam = uaFamily(ua);
  const claimsBrowser = fam.family === 'chromium' || fam.family === 'firefox' || fam.family === 'safari';
  const accept = h.get('accept') ?? '';
  const lang = h.get('accept-language');
  const enc = (h.get('accept-encoding') ?? '').trim();
  const order = input.headerOrder ? normaliseOrder(input.headerOrder) : undefined;
  const rawOrder = input.headerOrder;
  const secure = input.secureContext !== false;
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);

  // HTTP version guess: ALPN from the edge, else pseudo-headers (h2) / Connection header (h1 only).
  const version: 'h1' | 'h2' | 'unknown' = input.alpn === 'http/1.1' ? 'h1' : input.alpn === 'h2' || input.alpn === 'h3' ? 'h2' : rawOrder?.some((n) => n.startsWith(':')) ? 'h2' : rawOrder?.some((n) => /^connection$/i.test(n)) ? 'h1' : 'unknown';

  // ── Library literals and signatures (apply to every request) ──
  // C7: Accept-Language "*" is appended by undici (Node fetch) and Deno; no browser sends it.
  if (lang && lang.trim() === '*') {
    add({ id: 'request.no-browser-headers', summary: 'Accept-Language "*" (undici/Node fetch or Deno default)', reliability: 1, details: { library: 'undici/Deno', check: 'C7' }, value: lang });
  }
  // C6: undici sends sec-fetch-mode: cors with no Sec-Fetch-Site / Sec-Fetch-Dest.
  const sfMode = h.get('sec-fetch-mode');
  if (sfMode && !h.get('sec-fetch-site') && !h.get('sec-fetch-dest')) {
    add({ id: 'request.no-browser-headers', summary: `sec-fetch-mode: ${sfMode} with no Sec-Fetch-Site/Dest (undici fetch signature)`, reliability: 1, details: { library: 'undici', check: 'C6' } });
  }
  // C8: h2c upgrade on plaintext = Java HttpClient or curl-impersonate/curl_cffi.
  const upgrade = h.get('upgrade');
  const h2settings = h.get('http2-settings');
  if ((upgrade && /\bh2c\b/i.test(upgrade)) || h2settings) {
    const decoded = h2settings ? decodeHttp2Settings(h2settings.trim()) : undefined;
    const profile = h2settings ? kb.httpLibraryProfiles.find((p) => p.http2Settings?.includes(h2settings.trim())) : undefined;
    const details: Record<string, unknown> = { check: 'C8', ...(decoded ? { settings: decoded } : {}), ...(profile ? { library: profile.name } : {}) };
    let summary = `Upgrade: h2c${h2settings ? ' + HTTP2-Settings' : ''} on a plaintext request (no browser does this)`;
    if (profile) summary += `; settings match ${profile.name}`;
    if (profile?.id.startsWith('curl-cffi') && claimsBrowser) details['impersonation'] = profile.name;
    add({ id: 'request.h2c-upgrade', summary, reliability: 1, details, value: decoded ?? upgrade ?? '' });
  }
  // C7: Accept-Encoding literals.
  if (enc) {
    const lib = LIBRARY_ACCEPT_ENCODING[enc];
    // Over plain http Chromium and Firefox advertise only `gzip, deflate` (br/zstd are https-only).
    const insecureBrowserDefault = !secure && claimsBrowser && enc === 'gzip, deflate';
    if (insecureBrowserDefault) {
      /* real browser behaviour on http:// — not evidence */
    } else if (lib) {
      add({ id: 'request.library-accept-encoding', summary: `Accept-Encoding "${enc}" is the ${lib} default`, reliability: claimsBrowser ? 1 : 0.9, details: { library: lib, check: 'C7' }, value: enc });
    } else if (enc === 'gzip, deflate, br' && (fam.family === 'chromium' && fam.chromeMajor >= 123 || fam.family === 'firefox' && fam.firefoxMajor >= 126)) {
      add({ id: 'request.library-accept-encoding', summary: `Accept-Encoding "${enc}" lacks zstd although ${fam.family} ${fam.chromeMajor || fam.firefoxMajor} sends it (node-fetch / curl_cffi default value)`, reliability: 0.6, details: { check: 'C7' }, value: enc });
    } else if (secure && claimsBrowser && !/br|zstd/i.test(enc) && (fam.chromeMajor >= 50 || fam.firefoxMajor >= 44)) {
      add({ id: 'request.library-accept-encoding', summary: `Modern browser UA without br/zstd in Accept-Encoding (${enc})`, reliability: 0.7, details: { check: 'C7' }, value: enc });
    }
  }
  // curl_cffi without impersonation: Chrome's h2 SETTINGS, but no UA and no Accept, Accept-Encoding "gzip, deflate, br".
  if (!h.has('user-agent') && !h.has('accept') && enc === 'gzip, deflate, br') {
    add({ id: 'request.no-browser-headers', summary: 'No User-Agent, no Accept, Accept-Encoding "gzip, deflate, br" (curl_cffi default profile)', reliability: 1, details: { library: 'curl_cffi (no impersonation)' } });
  }
  // Header order identical to a library default (works even when the UA is spoofed).
  if (order && order.length >= 2) {
    const key = order.join('|');
    const lib = kb.httpLibraryProfiles.find((p) => p.headerOrder && p.headerOrder.length >= 2 && p.headerOrder.join('|') === key);
    if (lib) {
      const uaMatchesLib = lib.uaPattern ? new RegExp(lib.uaPattern, 'i').test(ua) : false;
      add({
        id: 'request.header-order-anomaly',
        summary: `Header order identical to ${lib.name} (${rawOrder!.filter((n) => !ORDER_NOISE.test(n)).join(', ')})${claimsBrowser ? ` under a ${fam.family} UA` : ''}`,
        reliability: claimsBrowser ? 1 : uaMatchesLib ? 0.5 : 0.8,
        details: { library: lib.name, check: 'order', uaMatchesLibrary: uaMatchesLib },
        value: order.slice(0, 16),
      });
    }
  }

  // ── Browser-claim checks (documents only: subresources legitimately differ) ──
  if (input.isDocument) {
    const secFetch = h.get('sec-fetch-mode') || h.get('sec-fetch-dest') || h.get('sec-fetch-site');
    const chUa = h.get('sec-ch-ua');
    const missing: string[] = [];
    if (!lang) missing.push('Accept-Language');
    if (!accept.includes('text/html')) missing.push('browser Accept');
    if (secure && !secFetch && (fam.chromeMajor >= 76 || fam.firefoxMajor >= 90 || fam.safariMajor >= 16.4)) missing.push('Sec-Fetch-*');
    if (claimsBrowser && missing.length) {
      add({ id: 'request.no-browser-headers', summary: `${fam.family} UA without ${missing.join(', ')}`, reliability: Math.min(1, 0.5 + 0.25 * missing.length), details: { missing, check: 'C6/C7' }, value: missing });
    } else if (!claimsBrowser && !lang && !accept.includes('text/html')) {
      add({ id: 'request.no-browser-headers', summary: 'Non-browser header set (no Accept-Language, no HTML Accept)', reliability: 1, details: { accept, lang } });
    }
    if (claimsBrowser && accept.trim() === '*/*') {
      add({ id: 'request.no-browser-headers', summary: 'Accept "*/*" on a document navigation (library default)', reliability: 0.8, details: { check: 'C7' }, value: accept });
    }

    // C9: Chrome/Firefox send `priority: u=0, i` on h2/h3 navigations (RFC 9218). Weak.
    if (version === 'h2' && !h.get('priority') && ((fam.family === 'chromium' && fam.chromeMajor >= 120 && !fam.webkitShell) || (fam.family === 'firefox' && fam.firefoxMajor >= 120))) {
      add({ id: 'request.no-browser-headers', summary: `${fam.family} ${fam.chromeMajor || fam.firefoxMajor} navigation over ${input.alpn ?? 'h2'} without a Priority header (weak)`, reliability: 0.3, details: { check: 'C9' } });
    }

    // C5: client hints. Chromium >= 89 always sends the low-entropy trio (https only); Firefox and Safari never send sec-ch-ua.
    // UA client hints are a secure-context feature: never expected on plain http.
    if (fam.family === 'chromium' && fam.chromeMajor >= 89 && !fam.webkitShell && secure) {
      if (!chUa) {
        add({ id: 'request.client-hints-mismatch', summary: `Chrome ${fam.chromeMajor} UA without Sec-CH-UA client hints`, reliability: 0.8, details: { check: 'C5' } });
      } else {
        const brands = parseSecChUa(chUa);
        const real = brands.filter((b) => !isGreaseBrand(b.brand));
        const brandsMajor = real.reduce((m, b) => Math.max(m, b.major), 0);
        if (/HeadlessChrome/i.test(chUa)) add({ id: 'declared.headless-ua', summary: 'Sec-CH-UA brands include HeadlessChrome', reliability: 1, value: chUa });
        if (brandsMajor && Math.abs(brandsMajor - fam.chromeMajor) > 1) {
          add({ id: 'request.client-hints-mismatch', summary: `Sec-CH-UA major ${brandsMajor} vs UA Chrome ${fam.chromeMajor}`, reliability: 1, details: { check: 'C5' }, value: chUa });
        }
        if (brands.length && !brands.some((b) => isGreaseBrand(b.brand))) {
          add({ id: 'request.client-hints-mismatch', summary: 'Sec-CH-UA has no GREASE brand ("Not_A Brand"...) although Chromium always adds one', reliability: 0.6, details: { check: 'C5' }, value: chUa });
        }
        const names = real.map((b) => b.brand);
        const expectedShell = fam.brand === 'edge' ? 'Microsoft Edge' : fam.brand === 'opera' ? 'Opera' : fam.brand === 'samsung' ? 'Samsung Internet' : fam.brand === 'chrome' ? 'Google Chrome' : undefined;
        if (expectedShell && names.length && !names.includes(expectedShell)) {
          const onlyChromium = names.every((n) => n === 'Chromium');
          add({
            id: 'request.client-hints-mismatch',
            summary: onlyChromium ? `Sec-CH-UA lists only "Chromium" while the UA claims ${expectedShell} (plain Chromium build: hosted/automation browser)` : `Sec-CH-UA brands ${JSON.stringify(names)} lack "${expectedShell}" claimed by the UA`,
            reliability: onlyChromium ? 0.5 : 0.8,
            details: { check: 'C5', brands: names, ...(onlyChromium ? { profile: 'chromium-only-brands' } : {}) },
            value: chUa,
          });
        }
        const mobileHint = h.get('sec-ch-ua-mobile');
        if (mobileHint === '?1' && !fam.mobile) add({ id: 'request.client-hints-mismatch', summary: 'Sec-CH-UA-Mobile ?1 but desktop UA', reliability: 1, details: { check: 'C5' }, value: mobileHint });
        if (mobileHint === '?0' && /Android.*Mobile/.test(ua)) add({ id: 'request.client-hints-mismatch', summary: 'Sec-CH-UA-Mobile ?0 but Android Mobile UA', reliability: 0.8, details: { check: 'C5' }, value: mobileHint });
        const platform = h.get('sec-ch-ua-platform');
        if (platform) {
          const p = platform.replace(/"/g, '');
          if (fam.os && p !== fam.os && !(fam.os === 'Linux' && p === 'Chrome OS')) {
            const hosted = fam.os === 'macOS' && p === 'Linux';
            add({
              id: 'request.client-hints-mismatch',
              summary: `Sec-CH-UA-Platform "${p}" vs UA ${fam.os}${hosted ? ' (macOS UA on a Linux host: hosted agent browser pattern)' : ''}`,
              reliability: 1,
              details: { check: 'C5', ...(hosted ? { profile: 'hosted-chromium' } : {}) },
              value: platform,
            });
          }
        }
      }
    } else if ((fam.family === 'firefox' || fam.family === 'safari') && chUa) {
      add({ id: 'request.client-hints-mismatch', summary: `${fam.family} UA with Sec-CH-UA client hints (only Chromium sends them)`, reliability: 1, details: { check: 'C5' }, value: chUa });
    }

    // Accept string family check (Chrome ships image/avif + signed-exchange; Scrapy/Safari-style Accept under a Chrome UA is odd).
    if (fam.family === 'chromium' && fam.chromeMajor >= 100 && !fam.webkitShell && accept.includes('text/html') && accept !== CHROME_ACCEPT && !accept.includes('image/avif')) {
      add({ id: 'request.header-order-anomaly', summary: `Chrome ${fam.chromeMajor} UA with a non-Chrome navigation Accept ("${accept.slice(0, 60)}")`, reliability: 0.4, details: { check: 'C7' }, value: accept });
    }
    // `te: trailers` is Firefox-only.
    if (fam.family === 'chromium' && /trailers/i.test(h.get('te') ?? '')) {
      add({ id: 'request.header-order-anomaly', summary: 'TE: trailers under a Chrome UA (Firefox-only header)', reliability: 0.6, details: { check: 'C7' } });
    }

    // Header order and casing per family (needs the raw wire order).
    if (order && claimsBrowser && !fam.webkitShell) {
      const idx = (n: string) => order.indexOf(n);
      const iUa = idx('user-agent');
      const iAcc = idx('accept');
      const iChu = idx('sec-ch-ua');
      const iLang = idx('accept-language');
      if (fam.family === 'chromium') {
        if (fam.chromeMajor >= 89 && iChu !== -1 && iUa !== -1 && iChu > iUa) {
          add({ id: 'request.header-order-anomaly', summary: 'sec-ch-ua after user-agent (Chromium sends client hints first)', reliability: 1, details: { check: 'order' }, value: order.slice(0, 12) });
        } else if (iAcc !== -1 && iUa !== -1 && iAcc < iUa) {
          add({ id: 'request.header-order-anomaly', summary: 'accept before user-agent (library ordering under a Chrome UA)', reliability: 0.6, details: { check: 'order' }, value: order.slice(0, 12) });
        }
      } else if (fam.family === 'firefox') {
        if ((iAcc !== -1 && iUa !== -1 && iAcc < iUa) || (iLang !== -1 && iAcc !== -1 && iLang < iAcc)) {
          add({ id: 'request.header-order-anomaly', summary: 'Firefox UA but header order is not User-Agent, Accept, Accept-Language, Accept-Encoding', reliability: 0.8, details: { check: 'order' }, value: order.slice(0, 12) });
        }
      }
      // C10: casing. Chromium h1 sends Title-Case for User-Agent/Accept (sec-ch-* lower); Firefox Title-Case throughout.
      if (version === 'h1' && (fam.family === 'chromium' || fam.family === 'firefox')) {
        const named = rawOrder!.filter((n) => /^(user-agent|accept|accept-language|accept-encoding|host|connection)$/i.test(n));
        if (named.length >= 2 && named.every((n) => n === n.toLowerCase())) {
          add({ id: 'request.header-order-anomaly', summary: `All-lowercase header names on HTTP/1.1 under a ${fam.family} UA (undici, node-fetch, got, Deno, reqwest emit lowercase)`, reliability: 1, details: { check: 'C10' }, value: rawOrder!.slice(0, 12) });
        }
      }
    }
  }

  return mergeFindings(findings);
}

export interface SecChUaBrand {
  brand: string;
  major: number;
}
export function parseSecChUa(value: string): SecChUaBrand[] {
  const out: SecChUaBrand[] = [];
  const re = /"([^"]*)"\s*;\s*v\s*=\s*"?(\d+)[^",]*"?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) out.push({ brand: m[1]!, major: Number(m[2]) });
  return out;
}
/** GREASE brands look like "Not_A Brand", "Not)A;Brand", "Not;A=Brand", "Not/A)Brand": arbitrary punctuation between Not, A and Brand. */
export function isGreaseBrand(brand: string): boolean {
  return /^not[\W_]?a[\W_]?brand$/i.test(brand.trim());
}

function mergeFindings(findings: Finding[]): SignalInput[] {
  const byId = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = byId.get(f.id) ?? [];
    list.push(f);
    byId.set(f.id, list);
  }
  const out: SignalInput[] = [];
  for (const [id, list] of byId) {
    const best = list.reduce((a, b) => (b.reliability > a.reliability ? b : a));
    const checks = list.map((f) => f.summary);
    const sig: SignalInput = {
      id,
      summary: list.length === 1 ? best.summary : `${best.summary} (+${list.length - 1} more: ${list.filter((f) => f !== best).map((f) => f.summary).join('; ')})`.slice(0, 300),
      reliability: Math.min(1, best.reliability + (list.length > 1 ? 0.1 * (list.length - 1) : 0)),
      details: { ...(best.details ?? {}), checks },
    };
    if (best.value !== undefined) sig.value = best.value;
    out.push(sig);
  }
  return out;
}

export interface HeaderShapeAnalyzerOptions {
  knowledge?: Knowledge;
}

export function headerShapeAnalyzer(opts: HeaderShapeAnalyzerOptions = {}): RequestAnalyzer {
  return {
    name: 'header-shape',
    analyze(ctx, api) {
      const signals = analyzeHeaderShape({
        headers: ctx.headers,
        ...(ctx.headerOrder ? { headerOrder: ctx.headerOrder } : {}),
        isDocument: ctx.isDocument,
        ...(ctx.tls?.alpn ? { alpn: ctx.tls.alpn } : {}),
        secureContext: isSecureContextRequest(ctx.url, ctx.headers),
        ...(opts.knowledge ? { knowledge: opts.knowledge } : {}),
      });
      for (const s of signals) api.emit(s);
    },
  };
}

export type { HttpLibraryProfile };
