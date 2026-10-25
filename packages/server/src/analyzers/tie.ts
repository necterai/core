import type { ClientHints, SignalInput } from '@necterai/core';
import { isGreaseBrand, parseSecChUa } from './header-shape.js';

/**
 * Tie analysis (check C11): values the browser SDK reads from JavaScript
 * (navigator.userAgentData.brands, languages[0], userAgentData.platform,
 * userAgent) must agree with the HTTP headers of the same session's last
 * document request (sec-ch-ua, accept-language, sec-ch-ua-platform,
 * user-agent). A contradiction means header-level spoofing (curl_cffi,
 * tls-client, proxies rewriting headers) or a UA override applied to only one
 * side. Worker/main-thread platform mismatches are a client-side signal and are
 * not considered here.
 */

export const TIE_HEADER_NAMES = ['user-agent', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-ch-ua-full-version-list', 'accept-language'] as const;

/** Copy the headers the tie analyzer compares, lower-case names. */
export function captureTieHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of TIE_HEADER_NAMES) {
    const v = headers.get(name);
    if (v) out[name] = v.slice(0, 512);
  }
  return out;
}

export interface TiePair {
  field: 'brands' | 'language' | 'platform' | 'ua' | 'mobile';
  client: string;
  header: string;
  reliability: number;
}

function normLang(tag: string): { full: string; primary: string } {
  const full = tag.trim().toLowerCase().replace(/_/g, '-');
  return { full, primary: full.split('-')[0] ?? full };
}

/** Compare SDK-reported hints with the stored request headers; returns the contradicting pairs. */
export function compareHints(headers: Record<string, string> | undefined, hints: ClientHints, fallbackUa?: string): TiePair[] {
  const pairs: TiePair[] = [];
  if (!hints || typeof hints !== 'object') return pairs;
  const h = headers ?? {};

  // UA string: CDP Network.setUserAgentOverride and Playwright's userAgent option change both sides;
  // only header-level spoofing or proxies make them differ.
  const headerUa = h['user-agent'] ?? fallbackUa;
  if (typeof hints.ua === 'string' && hints.ua && headerUa && hints.ua !== headerUa) {
    // UA-switcher extensions rewrite only the header (or only navigator.userAgent), so a UA-only
    // mismatch is moderate evidence; brands/platform contradictions stay strong.
    pairs.push({ field: 'ua', client: hints.ua.slice(0, 160), header: headerUa.slice(0, 160), reliability: 0.6 });
  }

  // Brands: compare the non-GREASE brand names and majors.
  if (Array.isArray(hints.brands) && hints.brands.length && h['sec-ch-ua']) {
    const headerBrands = parseSecChUa(h['sec-ch-ua']).filter((b) => !isGreaseBrand(b.brand));
    const clientBrands = hints.brands
      .filter((b) => b && typeof b.brand === 'string' && !isGreaseBrand(b.brand))
      .map((b) => ({ brand: b.brand, major: Number(String(b.version ?? '').split('.')[0]) || 0 }));
    if (headerBrands.length && clientBrands.length) {
      const key = (list: { brand: string; major: number }[]) => list.map((b) => `${b.brand}/${b.major}`).sort().join(',');
      if (key(headerBrands) !== key(clientBrands)) {
        pairs.push({ field: 'brands', client: key(clientBrands), header: key(headerBrands), reliability: 1 });
      }
    }
  }

  // Language: navigator.languages[0] equals the first Accept-Language token in every major browser.
  if (Array.isArray(hints.languages) && typeof hints.languages[0] === 'string' && h['accept-language']) {
    const first = h['accept-language'].split(',')[0]!.split(';')[0]!;
    const a = normLang(hints.languages[0]);
    const b = normLang(first);
    if (b.full && a.full !== b.full) {
      pairs.push({ field: 'language', client: hints.languages[0], header: first.trim(), reliability: a.primary === b.primary ? 0.5 : 1 });
    }
  }

  // Platform: navigator.userAgentData.platform must equal Sec-CH-UA-Platform (same source in Chromium).
  if (typeof hints.uaPlatform === 'string' && hints.uaPlatform && h['sec-ch-ua-platform']) {
    const hp = h['sec-ch-ua-platform'].replace(/"/g, '').trim();
    if (hp && hp.toLowerCase() !== hints.uaPlatform.trim().toLowerCase()) {
      pairs.push({ field: 'platform', client: hints.uaPlatform, header: hp, reliability: 1 });
    }
  }

  if (typeof hints.mobile === 'boolean' && h['sec-ch-ua-mobile']) {
    const hm = h['sec-ch-ua-mobile'].trim();
    if ((hm === '?1') !== hints.mobile && (hm === '?1' || hm === '?0')) {
      pairs.push({ field: 'mobile', client: String(hints.mobile), header: hm, reliability: 0.8 });
    }
  }
  return pairs;
}

/** Signals for a beacon's client hints against the session's document headers. */
export function tieSignals(headers: Record<string, string> | undefined, hints: ClientHints, fallbackUa?: string): SignalInput[] {
  const pairs = compareHints(headers, hints, fallbackUa);
  if (!pairs.length) return [];
  const strongest = pairs.reduce((a, b) => (b.reliability > a.reliability ? b : a));
  const summary = pairs.map((p) => `${p.field}: JS "${p.client}" vs header "${p.header}"`).join('; ');
  return [
    {
      id: 'tie.hint-js-mismatch',
      summary: summary.slice(0, 300),
      value: pairs.map((p) => ({ field: p.field, client: p.client, header: p.header })),
      details: { pairs: pairs.length, fields: pairs.map((p) => p.field), check: 'C11' },
      reliability: Math.min(1, strongest.reliability + 0.1 * (pairs.length - 1)),
    },
  ];
}
