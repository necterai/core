/**
 * window.chrome shape (spec §1, cdp-leak-techniques.md §7). chrome-headless-shell
 * has no window.chrome at all; new headless and headed Chrome both expose
 * {loadTimes, csi, app} and `chrome.runtime` is only present when an extension
 * exposes messaging to the page, so a missing runtime is *not* evidence (the
 * research corrects the spec here; we record it as a detail only).
 */
import type { Env } from './env.js';
import type { Finding } from './finding.js';
import type { ParsedUA } from './ua.js';

export function analyzeChromeObject(chrome: Env['chromeObject'], ua: ParsedUA): Finding[] {
  // Only Chromium desktop builds carry window.chrome; iOS Chrome (CriOS) is WebKit, WebViews differ.
  if (ua.engine !== 'blink' || !ua.desktop) return [];
  if (chrome === undefined) {
    return [
      {
        id: 'env.missing-chrome-runtime',
        summary: `window.chrome is undefined on a ${ua.browser} ${ua.os} desktop UA`,
        value: null,
      },
    ];
  }
  return [];
}
