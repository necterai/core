/**
 * Screen / window geometry tells (spec §1): automation default viewports, missing
 * window chrome and "screen equals viewport". Research anchors:
 *  - cdp-leak-techniques.md §9.3: headless screen is 800x600, Puppeteer viewport 800x600,
 *    Playwright 1280x720; chrome-headless-shell has inner == outer.
 *  - computer-use-agents.md §11.5: ChatGPT agent 1280x960, Browser Use cloud 1512x982,
 *    OpenAI/Anthropic samples 1024x768, H Company 1200x1200.
 *  - false-positive-traps.md §6.1: Safari advanced protection sets outer == inner by design,
 *    kiosk/fullscreen/mobile/WebView also do; BotD requires document focus.
 */
import type { Env } from './env.js';
import { fmtSize, type Finding } from './finding.js';
import type { ParsedUA } from './ua.js';

export interface AutomationViewport {
  w: number;
  h: number;
  label: string;
  /** Reliability when only screen.width x screen.height matches (a real display of that size exists). */
  screenOnly: number;
}

/** Exact sizes listed in detection-spec.md §1; 1366x768 is special-cased below. */
export const AUTOMATION_VIEWPORTS: readonly AutomationViewport[] = [
  { w: 1280, h: 720, label: 'Playwright default viewport', screenOnly: 0.5 },
  { w: 800, h: 600, label: 'Puppeteer default viewport / headless default screen', screenOnly: 1 },
  { w: 1024, h: 768, label: 'computer-use default (OpenAI CUA, Anthropic demo Xvfb)', screenOnly: 0.5 },
  { w: 1280, h: 960, label: 'ChatGPT agent hosted screen', screenOnly: 1 },
  { w: 1512, h: 982, label: 'Browser Use cloud screen', screenOnly: 1 },
  { w: 1200, h: 1200, label: 'H Company cloud browser viewport', screenOnly: 1 },
];

export interface GeometryInput {
  ua: ParsedUA;
  screen: Env['screen'];
  window: Env['window'];
  fullscreen: boolean;
  hasFocus: boolean;
  privacyKinds: readonly string[];
}

export function geometryInputFromEnv(env: Env, ua: ParsedUA, privacyKinds: readonly string[]): GeometryInput {
  return { ua, screen: env.screen, window: env.window, fullscreen: env.fullscreen(), hasFocus: env.hasFocus(), privacyKinds };
}

export function analyzeGeometry(i: GeometryInput): Finding[] {
  const out: Finding[] = [];
  const { innerWidth: iw, innerHeight: ih, outerWidth: ow, outerHeight: oh } = i.window;
  const sw = i.screen.width;
  const sh = i.screen.height;
  const screenEqualsViewport = sw > 0 && sw === iw && sh === ih;

  // 1) Exact automation defaults.
  let viewportHit: Finding | undefined;
  for (const v of AUTOMATION_VIEWPORTS) {
    if (iw === v.w && ih === v.h) {
      viewportHit = {
        id: 'env.default-automation-viewport',
        summary: `viewport ${fmtSize(iw, ih)} matches ${v.label}`,
        value: fmtSize(iw, ih),
        details: { match: 'viewport', screen: fmtSize(sw, sh), outer: fmtSize(ow, oh) },
      };
      break;
    }
    if (sw === v.w && sh === v.h) {
      viewportHit = {
        id: 'env.default-automation-viewport',
        summary: `screen ${fmtSize(sw, sh)} matches ${v.label}`,
        value: fmtSize(sw, sh),
        details: { match: 'screen', viewport: fmtSize(iw, ih), outer: fmtSize(ow, oh) },
        reliability: v.screenOnly,
      };
    }
  }
  // 1366x768 is the most common laptop panel: only counts when the window has no chrome at all.
  if (!viewportHit && ((iw === 1366 && ih === 768) || (sw === 1366 && sh === 768 && screenEqualsViewport)) && oh === ih && oh > 0) {
    viewportHit = {
      id: 'env.default-automation-viewport',
      summary: `viewport ${fmtSize(iw, ih)} with outerHeight === innerHeight (1366x768 automation window)`,
      value: fmtSize(iw, ih),
      details: { match: 'viewport', screen: fmtSize(sw, sh), outer: fmtSize(ow, oh) },
    };
  }
  if (viewportHit) out.push(viewportHit);

  const webkitDesktop = i.ua.engine === 'webkit';
  const safariProtection = i.privacyKinds.includes('safari-advanced-protection');

  // 2) outer == inner on a desktop UA: no browser UI around the viewport.
  //    Guards: desktop only, not fullscreen/kiosk, document focused (background tabs can report 0x0),
  //    never on WebKit (Safari advanced protection makes outer == inner by design), never for 0 sizes.
  if (
    i.ua.desktop &&
    !webkitDesktop &&
    !i.fullscreen &&
    i.hasFocus &&
    ow > 0 &&
    oh > 0 &&
    ow === iw &&
    oh === ih
  ) {
    out.push({
      id: 'env.no-window-chrome',
      summary: `outerWidth/outerHeight ${fmtSize(ow, oh)} equal innerWidth/innerHeight on a ${i.ua.os} desktop UA`,
      value: fmtSize(ow, oh),
      details: { screen: fmtSize(sw, sh) },
    });
  }

  // 3) screen == viewport with no OS chrome (availTop/availLeft 0, availHeight == height).
  if (
    i.ua.desktop &&
    !webkitDesktop &&
    !safariProtection &&
    !i.fullscreen &&
    screenEqualsViewport &&
    (i.screen.availTop ?? 0) === 0 &&
    (i.screen.availLeft ?? 0) === 0 &&
    i.screen.availHeight === sh
  ) {
    out.push({
      id: 'env.screen-equals-viewport',
      summary: `screen ${fmtSize(sw, sh)} equals the viewport with availTop/availLeft 0 and availHeight ${i.screen.availHeight}`,
      value: fmtSize(sw, sh),
    });
  }

  return out;
}
