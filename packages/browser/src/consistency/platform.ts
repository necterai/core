/**
 * UA vs platform vs client hints vs WebGL vs fonts (spec §7). Each check yields a
 * contradicting pair; the strongest pair becomes the signal's `value`, all pairs
 * go into `details`. Guards from false-positive-traps.md §7.5 (UA reduction
 * freezes the OS token, so only the OS *family* is compared), §7.2 (Firefox RFP
 * spoofs UA/platform: privacy-gated) and §4 (iPadOS desktop-mode Safari reports a
 * Macintosh UA with MacIntel and maxTouchPoints > 1).
 */
import type { EnvWebGL } from '../collectors/env.js';
import type { Finding } from '../collectors/finding.js';
import { summarizeFonts } from '../collectors/fonts.js';
import { gpuFamily } from '../collectors/graphics.js';
import { humanOs, platformMatchesOs, uaDataPlatformMatchesOs, type ParsedUA } from '../collectors/ua.js';

export interface PlatformFacts {
  ua: ParsedUA;
  platform: string;
  maxTouchPoints: number;
  userAgentData: { brands: string[]; mobile: boolean; platform: string } | undefined;
  /** platform from getHighEntropyValues when it resolved. */
  highEntropyPlatform: string | undefined;
  webgl: EnvWebGL | null | undefined;
  fonts: Map<string, boolean> | undefined;
}

export interface MismatchPair {
  a: [string, string];
  b: [string, string];
  reliability: number;
}

export function platformMismatches(f: PlatformFacts): MismatchPair[] {
  const pairs: MismatchPair[] = [];
  const ua: [string, string] = ['userAgent', humanOs(f.ua.os)];

  // navigator.platform vs UA OS family.
  const platOk = platformMatchesOs(f.platform, f.ua.os);
  if (platOk === false) pairs.push({ a: ua, b: ['navigator.platform', f.platform], reliability: 1 });

  if (f.userAgentData) {
    const d = f.userAgentData;
    if (f.ua.engine !== 'blink' && f.ua.engine !== 'unknown') {
      // Firefox and Safari have no userAgentData at all: a Chromium API under a Gecko/WebKit UA is a lie.
      pairs.push({ a: ['userAgent', f.ua.browser], b: ['userAgentData', 'present'], reliability: 0.9 });
    } else if (d.platform === '' && d.brands.length === 0) {
      // Emulation.setUserAgentOverride without metadata (Puppeteer page.setUserAgent) blanks the hints.
      pairs.push({ a: ua, b: ['userAgentData.platform', ''], reliability: 0.8 });
    } else if (d.platform && uaDataPlatformMatchesOs(d.platform, f.ua.os) === false) {
      pairs.push({ a: ua, b: ['userAgentData.platform', d.platform], reliability: 1 });
    }
    if (f.highEntropyPlatform && uaDataPlatformMatchesOs(f.highEntropyPlatform, f.ua.os) === false) {
      pairs.push({ a: ua, b: ['getHighEntropyValues.platform', f.highEntropyPlatform], reliability: 1 });
    }
    // Mobile flag: only compared where the UA is unambiguous (explicit "Mobile" token or desktop class).
    if (/\bMobile\b/.test(f.ua.raw) && f.ua.engine === 'blink' && d.mobile === false && d.brands.length > 0) {
      pairs.push({ a: ['userAgent', 'Mobile'], b: ['userAgentData.mobile', 'false'], reliability: 0.6 });
    } else if (f.ua.desktop && d.mobile === true) {
      pairs.push({ a: ['userAgent', 'desktop'], b: ['userAgentData.mobile', 'true'], reliability: 0.6 });
    }
  }

  // WebGL renderer family vs UA OS family.
  const gpu = gpuFamily(f.webgl);
  const renderer = f.webgl ? f.webgl.renderer : '';
  if (gpu === 'apple' && f.ua.os !== 'macos' && f.ua.os !== 'ios' && f.ua.os !== 'unknown') {
    pairs.push({ a: ua, b: ['webgl.renderer', renderer], reliability: 0.9 });
  } else if (gpu === 'direct3d' && f.ua.os !== 'windows' && f.ua.os !== 'unknown') {
    pairs.push({ a: ua, b: ['webgl.renderer', renderer], reliability: 1 });
  } else if (gpu === 'mesa-linux' && (f.ua.os === 'macos' || f.ua.os === 'windows' || f.ua.os === 'ios')) {
    pairs.push({ a: ua, b: ['webgl.renderer', renderer], reliability: 0.7 });
  } else if (gpu === 'mobile' && f.ua.os === 'macos') {
    // Windows-on-ARM laptops carry Adreno GPUs and Linux ARM boards carry Mali: only macOS is impossible.
    pairs.push({ a: ua, b: ['webgl.renderer', renderer], reliability: 0.9 });
  }

  // Font set vs UA OS family.
  if (f.fonts && f.ua.desktop) {
    const s = summarizeFonts(f.fonts);
    if (f.ua.os === 'macos' && s.windows.length >= 2 && s.mac.length === 0) {
      pairs.push({ a: ua, b: ['fonts', s.windows.join(', ')], reliability: 0.8 });
    } else if (f.ua.os === 'windows' && s.mac.length >= 2 && s.windows.length === 0) {
      pairs.push({ a: ua, b: ['fonts', s.mac.join(', ')], reliability: 0.8 });
    } else if (f.ua.os === 'linux' && s.mac.length >= 2 && s.linux.length === 0) {
      pairs.push({ a: ua, b: ['fonts', s.mac.join(', ')], reliability: 0.6 });
    }
  }

  return pairs;
}

export function analyzePlatform(f: PlatformFacts): Finding[] {
  const pairs = platformMismatches(f);
  if (pairs.length === 0) return [];
  const best = pairs.reduce((a, b) => (b.reliability > a.reliability ? b : a));
  return [
    {
      id: 'consistency.ua-platform-mismatch',
      summary: `${best.a[0]} says ${best.a[1]} but ${best.b[0]} is "${best.b[1]}"${pairs.length > 1 ? ` (+${pairs.length - 1} more)` : ''}`,
      value: [best.a, best.b],
      details: { pairs: pairs.map((p) => ({ a: p.a, b: p.b, reliability: p.reliability })) },
      reliability: Math.min(1, best.reliability + (pairs.length - 1) * 0.05),
      privacyGated: true,
    },
  ];
}
