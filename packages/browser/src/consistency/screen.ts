/**
 * Screen geometry impossibilities (spec §7, cdp-leak-techniques.md §9.3).
 *  - innerWidth > outerWidth: viewport emulation over a smaller window (Puppeteer 800x600 on a
 *    756x556 window, Playwright 1280x720). Page zoom-out also inflates CSS px, so a width ratio
 *    sitting on a browser zoom level (90/80/75/67/50/33/25 %) is down-weighted.
 *  - outerWidth > screen.width: --window-size larger than the 800x600 headless screen. Windows
 *    spanning two monitors can exceed the current screen: reliability 1 only from 1.5x.
 *  - colorDepth outside {24, 30, 32} (16-bit RDP sessions exist: 0.6) and absurd devicePixelRatio.
 */
import type { Env } from '../collectors/env.js';
import { fmtSize, type Finding } from '../collectors/finding.js';

/** innerWidth/outerWidth ratios produced by Chrome, Firefox and Safari zoom-out levels. */
export const ZOOM_RATIOS: readonly number[] = [1 / 0.9, 1 / 0.85, 1 / 0.8, 1 / 0.75, 1 / 0.67, 1 / 0.5, 1 / 0.33, 1 / 0.3, 1 / 0.25];
const SANE_COLOR_DEPTHS: ReadonlySet<number> = new Set([24, 30, 32]);

export function looksLikeZoom(ratio: number): boolean {
  return ZOOM_RATIOS.some((z) => Math.abs(ratio - z) / z < 0.015);
}

export interface ScreenFacts {
  window: Env['window'];
  screen: Env['screen'];
  fullscreen: boolean;
}

export function analyzeScreenGeometry(f: ScreenFacts): Finding[] {
  const out: Finding[] = [];
  const { innerWidth: iw, innerHeight: ih, outerWidth: ow, outerHeight: oh, devicePixelRatio: dpr } = f.window;
  const { width: sw, height: sh } = f.screen;

  if (ow > 0 && oh > 0 && (iw > ow + 1 || ih > oh + 1)) {
    const widthRatio = iw / ow;
    const zoom = iw > ow + 1 && looksLikeZoom(widthRatio);
    out.push({
      id: 'consistency.screen-geometry-impossible',
      summary: `viewport ${fmtSize(iw, ih)} is larger than the window ${fmtSize(ow, oh)}${zoom ? ' (ratio matches a browser zoom level)' : ''}`,
      value: { inner: fmtSize(iw, ih), outer: fmtSize(ow, oh) },
      details: { widthRatio: Math.round(widthRatio * 1000) / 1000, zoomLike: zoom },
      reliability: zoom ? 0.3 : 1,
      privacyGated: true,
    });
  } else if (sw > 0 && sh > 0 && ow > 0 && oh > 0 && !f.fullscreen) {
    const ratio = Math.max(ow / sw, oh / sh);
    if (ratio > 1.02) {
      out.push({
        id: 'consistency.screen-geometry-impossible',
        summary: `window ${fmtSize(ow, oh)} is larger than the screen ${fmtSize(sw, sh)} (${ratio.toFixed(2)}x)`,
        value: { outer: fmtSize(ow, oh), screen: fmtSize(sw, sh) },
        details: { ratio: Math.round(ratio * 100) / 100 },
        reliability: ratio >= 1.5 ? 1 : 0.5,
        privacyGated: true,
      });
    }
  }

  if (f.screen.colorDepth && !SANE_COLOR_DEPTHS.has(f.screen.colorDepth)) {
    out.push({
      id: 'consistency.screen-geometry-impossible',
      summary: `screen.colorDepth ${f.screen.colorDepth} is outside {24, 30, 32}`,
      value: { colorDepth: f.screen.colorDepth },
      reliability: 0.6,
      privacyGated: true,
    });
  }

  if (!(dpr > 0) || dpr > 6) {
    out.push({
      id: 'consistency.screen-geometry-impossible',
      summary: `devicePixelRatio ${dpr} is not a plausible display ratio`,
      value: { devicePixelRatio: dpr },
      privacyGated: true,
    });
  }

  // Latest-per-id wins in the runtime: keep the most reliable finding only.
  if (out.length > 1) {
    const best = out.reduce((a, b) => ((b.reliability ?? 1) > (a.reliability ?? 1) ? b : a));
    best.details = { ...(best.details ?? {}), others: out.filter((o) => o !== best).map((o) => o.summary) };
    return [best];
  }
  return out;
}
