import type { SignalInput } from '@necterai/core';

/**
 * Probe-layer geometry impossibilities (docs/research/raw/cdp-leak-techniques.md section 9.3):
 *   - `innerWidth > outerWidth` / `innerHeight > outerHeight`: a device-metrics override larger
 *     than the window (Puppeteer 800x600 and Playwright 1280x720 over the 756x556 headless window);
 *   - `outerWidth > screen.width` / `outerHeight > screen.height`: `--window-size` larger than
 *     the 800x600 default headless screen.
 * Everything else about headless geometry belongs to the environment module (env.*).
 */

export interface GeometrySnapshot {
  innerWidth: number;
  innerHeight: number;
  outerWidth: number;
  outerHeight: number;
  screenWidth: number;
  screenHeight: number;
  devicePixelRatio: number;
  visualViewportScale?: number;
  fullscreen: boolean;
}

export function readGeometry(w: Window & typeof globalThis): GeometrySnapshot {
  return {
    innerWidth: w.innerWidth,
    innerHeight: w.innerHeight,
    outerWidth: w.outerWidth,
    outerHeight: w.outerHeight,
    screenWidth: w.screen?.width ?? 0,
    screenHeight: w.screen?.height ?? 0,
    devicePixelRatio: w.devicePixelRatio,
    visualViewportScale: w.visualViewport?.scale,
    fullscreen: Boolean(w.document?.fullscreenElement) || Boolean(w.matchMedia?.('(display-mode: fullscreen)')?.matches),
  };
}

export function checkViewportOverride(g: GeometrySnapshot): SignalInput | undefined {
  if (g.fullscreen) return undefined;
  if (!(g.outerWidth > 0 && g.outerHeight > 0)) return undefined; // mobile / jsdom report 0
  const tells: string[] = [];
  let reliability = 1;
  // Page zoom < 100% inflates CSS-px innerWidth above the device-independent outerWidth.
  const zoomSuspect =
    !Number.isInteger(g.devicePixelRatio) ||
    g.devicePixelRatio < 1 ||
    (g.visualViewportScale !== undefined && g.visualViewportScale !== 1) ||
    zoomExplains(g);
  if (g.innerWidth > g.outerWidth || g.innerHeight > g.outerHeight) {
    tells.push(`inner ${g.innerWidth}x${g.innerHeight} > outer ${g.outerWidth}x${g.outerHeight}`);
    if (zoomSuspect) reliability = Math.min(reliability, 0.5);
  }
  if (g.screenWidth > 0 && g.screenHeight > 0 && (g.outerWidth > g.screenWidth || g.outerHeight > g.screenHeight)) {
    tells.push(`outer ${g.outerWidth}x${g.outerHeight} > screen ${g.screenWidth}x${g.screenHeight}`);
    const ratio = Math.max(g.outerWidth / g.screenWidth, g.outerHeight / g.screenHeight);
    if (ratio < 2) reliability = Math.min(reliability, 0.6); // a window spanning two monitors
  }
  if (!tells.length) return undefined;
  const input: SignalInput = {
    id: 'probe.viewport-override',
    summary: `Impossible window geometry: ${tells.join('; ')}`,
    value: tells,
    details: { innerWidth: g.innerWidth, innerHeight: g.innerHeight, outerWidth: g.outerWidth, outerHeight: g.outerHeight, screenWidth: g.screenWidth, screenHeight: g.screenHeight, dpr: g.devicePixelRatio },
  };
  if (reliability < 1) input.reliability = reliability;
  return input;
}

/** Device scale factors real displays use (Windows 100-300 %, macOS 1x/2x, phones 3x). */
const DEVICE_SCALES = [1, 1.25, 1.5, 2, 2.5, 3];

/**
 * Could browser zoom explain inner > outer? With zoom z, CSS innerWidth ~= outerWidth / z
 * (no horizontal chrome) and devicePixelRatio = deviceScale * z. If dpr / z lands on a
 * real device scale (within 3 %) and the implied vertical chrome is 0-200 px, it is
 * probably a zoomed-out person (e.g. 50 % zoom on a 2x display reports dpr 1).
 * Puppeteer 800x600 over 756x556 gives 1.058 and Playwright 1280x720 gives 1.69: neither fits.
 */
export function zoomExplains(g: GeometrySnapshot): boolean {
  if (!(g.innerWidth > 0 && g.outerWidth > 0 && g.devicePixelRatio > 0)) return false;
  const z = g.outerWidth / g.innerWidth;
  if (!(z > 0 && z < 1)) return false;
  const base = g.devicePixelRatio / z;
  const fits = DEVICE_SCALES.some((d) => Math.abs(base - d) / d <= 0.03);
  const chrome = g.outerHeight - g.innerHeight * z;
  return fits && chrome >= 0 && chrome <= 200;
}
