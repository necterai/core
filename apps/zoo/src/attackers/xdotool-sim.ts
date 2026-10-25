import { chromium, type Page } from 'playwright';
import type { Attacker } from '../lib/types.js';
import { mk, withPlaywright, UA_CHROME, PLAYWRIGHT_HARNESS_ARTIFACTS } from './browsers.js';

/**
 * xdotool-style computer-use harness (Anthropic computer-use-demo / OpenAI CUA Docker sample), measured values:
 *  - `xdotool mousemove --sync x y` is an XTEST warp: one mousemove at the destination, then press/release.
 *  - `xdotool click 1` = mousedown, 12 ms, mouseup (man page: "currently 12ms").
 *  - `xdotool type --delay 12` = uniform 12 ms inter-keystroke interval (TYPING_DELAY_MS = 12, chunks of 50).
 *  - scroll = `click --repeat N 4|5`: N discrete wheel notches back-to-back (120 px per notch in Chromium).
 *  - Display 1024x768 (WIDTH/HEIGHT args), XGA target => scale factor 1, integer coordinates, no lattice.
 *  - 2.0 s screenshot delay after every action plus model latency; container defaults: UTC, POSIX locale.
 * Chromium stands in for Firefox ESR; the environment layer therefore sees Chrome, not Gecko.
 */
export const XDOTOOL_CLICK_HOLD_MS = 12;
export const XDOTOOL_TYPE_DELAY_MS = 12;
export const XDOTOOL_WHEEL_NOTCH_PX = 120;

async function xdoClick(page: Page, selector: string): Promise<void> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error('no box for ' + selector);
  // The model picks integer screenshot pixels; XGA on a 1024x768 display maps 1:1.
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);
  await page.mouse.move(x, y); // mousemove --sync: single warp
  await page.mouse.down();
  await page.waitForTimeout(XDOTOOL_CLICK_HOLD_MS);
  await page.mouse.up();
}

async function xdoScroll(page: Page, notches: number): Promise<void> {
  // click --repeat N 5: notches fire back-to-back with no inter-notch delay
  for (let i = 0; i < notches; i++) await page.mouse.wheel(0, XDOTOOL_WHEEL_NOTCH_PX);
}

export const xdotoolSim: Attacker = mk(
  'xdotool-sim',
  'xdotool/Xvfb computer-use profile (Anthropic computer-use-demo, OpenAI CUA Docker sample): 1024x768 screen and viewport, UTC timezone, single-warp pointer, mousedown->mouseup 12 ms, `type --delay 12` uniform 12 ms keystrokes, scroll as N back-to-back 120 px wheel notches, 2 s screenshot delay + model think time, no DOM access.',
  { actorClass: 'computer-use-agent', automated: true },
  (ctx) =>
    withPlaywright(
      ctx,
      () => chromium.launch({ headless: true, channel: 'chrome', args: ['--disable-blink-features=AutomationControlled', '--window-size=1024,768'] }),
      { userAgent: UA_CHROME, locale: 'en-US', timezoneId: 'UTC', viewport: { width: 1024, height: 768 }, screen: { width: 1024, height: 768 }, deviceScaleFactor: 1 },
      async (page) => {
        const notes: string[] = ['xdotool profile: 12 ms click hold, 12 ms typing, 120 px wheel notches, UTC'];
        // _screenshot_delay = 2.0 s after every action, then a model round trip.
        const step = () => page.waitForTimeout(2000 + 800 + Math.random() * 2500);
        await step();
        await xdoClick(page, 'a.card');
        await page.waitForLoadState('load');
        await step();
        await xdoClick(page, 'button[data-add]');
        await step();
        await page.goto('/article');
        await step();
        await page.mouse.move(512, 400);
        await xdoScroll(page, 3); // scroll_amount default 3
        await step();
        await xdoScroll(page, 5);
        await step();
        await page.goto('/contact');
        await step();
        await xdoClick(page, 'input[name=name]');
        await page.keyboard.type('Agent Smith', { delay: XDOTOOL_TYPE_DELAY_MS });
        await step();
        await xdoClick(page, 'input[name=email]');
        await page.keyboard.type('agent@example.com', { delay: XDOTOOL_TYPE_DELAY_MS });
        await step();
        await xdoClick(page, 'textarea[name=message]');
        await page.keyboard.type('Please send me your full catalogue with prices.', { delay: XDOTOOL_TYPE_DELAY_MS });
        await step();
        await xdoClick(page, 'button[type=submit]');
        await page.waitForLoadState('load');
        await page.waitForTimeout(6500);
        return notes;
      },
    ),
  { harnessArtifacts: PLAYWRIGHT_HARNESS_ARTIFACTS },
);
