/**
 * Privacy-browser mode detection (spec §0, false-positive-traps.md §7).
 *
 * Brave farbling, Firefox resistFingerprinting / fingerprintingProtection, Safari
 * advanced tracking and fingerprinting protection and Tor letterboxing all break
 * fingerprint *consistency* on purpose. We detect that such a mode is present and
 * then down-weight consistency.* and container/fingerprint tells for the session
 * (reliability x 0.3) instead of scoring "inconsistent fingerprint" as a bot.
 */
import type { Env } from './env.js';
import { parseUA, type ParsedUA } from './ua.js';

export type PrivacyKind = 'brave' | 'firefox-rfp' | 'tor-letterboxing' | 'safari-advanced-protection' | 'canvas-noise';

export interface PrivacyResult {
  active: boolean;
  kinds: PrivacyKind[];
  /** Short evidence strings, one per observation ("tz Atlantic/Reykjavik"). */
  evidence: string[];
}

/** Reliability multiplier applied to fingerprint-consistency signals while a privacy mode is active. */
export const PRIVACY_RELIABILITY = 0.3;

/** Timezones Firefox RFP (and Tor Browser) report: UTC before FF128, Atlantic/Reykjavik since (Bugzilla 1835987). */
export const SPOOFED_TIMEZONES: ReadonlySet<string> = new Set(['UTC', 'Etc/UTC', 'Atlantic/Reykjavik', 'Etc/GMT', 'GMT']);

/** Firefox `privacy.window.maxInnerWidth` / `maxInnerHeight` defaults (StaticPrefList.yaml). */
const RFP_MAX_INNER_WIDTH = 1400;
const RFP_MAX_INNER_HEIGHT = 900;

export interface PrivacyInput {
  ua: ParsedUA;
  braveObject: boolean;
  timezone: string | undefined;
  hardwareConcurrency: number | undefined;
  innerWidth: number;
  innerHeight: number;
  outerWidth: number;
  outerHeight: number;
  screenWidth: number;
  screenHeight: number;
  screenX: number;
  screenY: number;
  fullscreen: boolean;
  /** Two canvas renders differed within one page (CanvasBlocker-style per-read noise). */
  canvasNoise?: boolean;
}

export function privacyInputFromEnv(env: Env, canvasNoise?: boolean): PrivacyInput {
  const input: PrivacyInput = {
    ua: parseUA(env.userAgent),
    braveObject: env.braveObject,
    timezone: env.timezone(),
    hardwareConcurrency: env.hardwareConcurrency,
    innerWidth: env.window.innerWidth,
    innerHeight: env.window.innerHeight,
    outerWidth: env.window.outerWidth,
    outerHeight: env.window.outerHeight,
    screenWidth: env.screen.width,
    screenHeight: env.screen.height,
    screenX: env.window.screenX,
    screenY: env.window.screenY,
    fullscreen: env.fullscreen(),
  };
  if (canvasNoise !== undefined) input.canvasNoise = canvasNoise;
  return input;
}

/** Pure decision: which anti-fingerprinting modes the observations point at. */
export function detectPrivacyMode(i: PrivacyInput): PrivacyResult {
  const kinds: PrivacyKind[] = [];
  const evidence: string[] = [];

  // Brave exposes navigator.brave on every page (brave-core brave_navigator.ts); farbling is always on by default.
  if (i.braveObject) {
    kinds.push('brave');
    evidence.push('navigator.brave present');
  }

  if (i.ua.engine === 'gecko') {
    // RFP bundle: several of {spoofed timezone, inner window rounded to 200x100 under 1400x900, hwConcurrency 4/8}.
    let score = 0;
    const tzSpoofed = !!i.timezone && SPOOFED_TIMEZONES.has(i.timezone);
    if (tzSpoofed) {
      score += 2;
      evidence.push(`tz ${i.timezone}`);
    }
    const rounded =
      i.innerWidth > 0 &&
      i.innerHeight > 0 &&
      i.innerWidth % 200 === 0 &&
      i.innerHeight % 100 === 0 &&
      i.innerWidth <= RFP_MAX_INNER_WIDTH &&
      i.innerHeight <= RFP_MAX_INNER_HEIGHT;
    if (rounded) {
      score += 1;
      evidence.push(`inner ${i.innerWidth}x${i.innerHeight} rounded to 200x100`);
    }
    if (i.hardwareConcurrency === 4 || i.hardwareConcurrency === 8) {
      score += 0.5;
      evidence.push(`hardwareConcurrency ${i.hardwareConcurrency}`);
    }
    if (score >= 2) {
      kinds.push('firefox-rfp');
      // Tor Browser letterboxes: rounded inner window with margins inside a larger outer window.
      if (rounded && tzSpoofed && (i.outerWidth > i.innerWidth || i.outerHeight - i.innerHeight > 120)) {
        kinds.push('tor-letterboxing');
        evidence.push(`letterbox outer ${i.outerWidth}x${i.outerHeight}`);
      }
    }
  }

  // Safari Private Browsing 2.0 / advanced protection fixes screen to the viewport and screenX/Y to 0 (WebKit blog 15697).
  if (
    i.ua.engine === 'webkit' &&
    !i.fullscreen &&
    i.screenWidth > 0 &&
    i.screenWidth === i.innerWidth &&
    i.screenHeight === i.innerHeight &&
    i.screenX === 0 &&
    i.screenY === 0
  ) {
    kinds.push('safari-advanced-protection');
    evidence.push(`screen == viewport ${i.innerWidth}x${i.innerHeight}, screenX/Y 0`);
  }

  if (i.canvasNoise) {
    kinds.push('canvas-noise');
    evidence.push('two canvas reads differ');
  }

  return { active: kinds.length > 0, kinds, evidence };
}
