/**
 * Timing tells (spec §1):
 *  - requestAnimationFrame cadence that matches no display refresh rate (weak).
 *    Headless Chrome drives a synthetic 60 Hz BeginFrame source, Firefox RFP locks
 *    60 Hz, so the only thing this catches is a cadence off every real refresh
 *    rate (Xvfb without vsync, throttled virtual displays).
 *  - document.hasFocus() staying false for 3 s while the page is visible and
 *    interactions arrive (headless Puppeteer before the first click; impossible
 *    for a person whose input reaches the page). Focus held by a payment / 3-D
 *    Secure iframe is excluded through document.activeElement.
 */
import type { Finding } from './finding.js';

/** Display refresh rates whose frame period a real browser may follow; 30 Hz covers low-power / throttled panels. */
export const REFRESH_RATES: readonly number[] = [30, 60, 75, 90, 120, 144, 165, 240];
export const RAF_FRAMES = 30;
const RAF_TOLERANCE = 0.08;

export interface RafAnalysis {
  median: number;
  matchedHz: number | undefined;
  findings: Finding[];
}

export function analyzeRafIntervals(intervals: readonly number[]): RafAnalysis {
  const clean = intervals.filter((d) => Number.isFinite(d) && d > 0);
  if (clean.length < 10) return { median: 0, matchedHz: undefined, findings: [] };
  // A gap above 100 ms means the tab was hidden or the thread stalled: the sample is not a cadence.
  if (clean.some((d) => d > 100)) return { median: 0, matchedHz: undefined, findings: [] };
  const sorted = [...clean].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  let matchedHz: number | undefined;
  for (const hz of REFRESH_RATES) {
    const period = 1000 / hz;
    if (Math.abs(median - period) <= period * RAF_TOLERANCE) {
      matchedHz = hz;
      break;
    }
  }
  const findings: Finding[] = [];
  if (matchedHz === undefined) {
    findings.push({
      id: 'env.raf-no-vsync',
      summary: `requestAnimationFrame median interval ${median.toFixed(2)} ms matches no refresh rate in ${REFRESH_RATES.join('/')} Hz`,
      value: Math.round(median * 100) / 100,
      details: { frames: clean.length, min: Math.round(sorted[0]! * 100) / 100, max: Math.round(sorted[sorted.length - 1]! * 100) / 100 },
    });
  }
  return { median, matchedHz, findings };
}

export interface FocusSample {
  visible: boolean;
  hasFocus: boolean;
  activeElementIsFrame: boolean;
  interacted: boolean;
}

/**
 * Tracks consecutive unfocused-but-visible seconds. Returns a Finding once the
 * window has been unfocused for `thresholdMs` with at least one interaction seen.
 */
export function createFocusTracker(thresholdMs = 3000) {
  let unfocusedSince: number | undefined;
  return {
    sample(now: number, s: FocusSample): Finding | undefined {
      if (!s.visible || s.hasFocus || s.activeElementIsFrame) {
        unfocusedSince = undefined;
        return undefined;
      }
      if (unfocusedSince === undefined) unfocusedSince = now;
      const elapsed = now - unfocusedSince;
      if (elapsed >= thresholdMs && s.interacted) {
        return {
          id: 'env.document-unfocused',
          summary: `document.hasFocus() false for ${(elapsed / 1000).toFixed(1)} s while visible and receiving input`,
          value: Math.round(elapsed),
        };
      }
      return undefined;
    },
  };
}
