import { chromium as patchright } from 'patchright';
import type { Browser, Page } from 'playwright';
import type { Attacker } from '../lib/types.js';
import { mk, withPlaywright, UA_CHROME, PLAYWRIGHT_HARNESS_ARTIFACTS } from './browsers.js';

/**
 * NVDA + Chrome screen-reader user (false-positive probe, expected `human`). Measured behaviour
 * (adobe/react-spectrum #10310, NVDA 2026.2, Chrome 155): Enter in browse mode "simulates a real mouse click":
 * the pointer jumps to the element centre (~1 ms before pointerdown, fractional centre such as 173.67,357.5),
 * pointerdown->pointerup < 1 ms (0.8 / 0.7 ms), events are isTrusted with pointerType mouse, pressure 0.5,
 * detail 1, and NO keydown/keyup for Enter reaches the page; ~5 ms after pointerup the pointer jumps back.
 * Navigation between controls is Tab/Shift+Tab (trusted keydown/keyup), focus moves before every activation,
 * reading dwell is seconds, there is no pointer trail at all and no DOM harvesting.
 */
async function tabTo(page: Page, selector: string, maxTabs = 40): Promise<boolean> {
  for (let i = 0; i < maxTabs; i++) {
    const focused = await page.evaluate((sel) => document.activeElement === document.querySelector(sel), selector);
    if (focused) return true;
    await page.keyboard.press('Tab');
    // The screen reader announces the control; the user listens before moving on.
    await page.waitForTimeout(350 + Math.random() * 700);
  }
  return false;
}

/** NVDA browse-mode Enter: teleport to the centre, sub-ms press, no Enter key events, jump back 5 ms later. */
async function nvdaActivate(page: Page, selector: string, restTo: { x: number; y: number }): Promise<void> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error('no box for ' + selector);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.waitForTimeout(1);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(5);
  await page.mouse.move(restTo.x, restTo.y);
}

async function typeInFormsMode(page: Page, text: string): Promise<void> {
  // Forms mode passes real keystrokes through; a screen-reader user types at a normal human cadence.
  for (const ch of text) {
    await page.keyboard.type(ch);
    const base = /[ .,@]/.test(ch) ? 150 : 80;
    await page.waitForTimeout(base + Math.random() * 110 + (Math.random() < 0.08 ? 350 : 0));
  }
}

export const atNvdaSim: Attacker = mk(
  'at-nvda-sim',
  'NVDA screen-reader user (false-positive probe): Tab/Shift+Tab navigation with trusted key events and seconds of reading dwell, activations as a pointer teleport to the exact element centre + down/up within 1 ms with NO Enter keydown (NVDA browse-mode click), pointer jumps back 5 ms later, focus moves before clicks, human typing cadence in forms mode, no DOM harvesting.',
  { actorClass: 'human', automated: false },
  (ctx) =>
    withPlaywright(
      ctx,
      () => patchright.launch({ headless: !ctx.headed, channel: 'chrome', args: ['--disable-blink-features=AutomationControlled'] }) as unknown as Promise<Browser>,
      { userAgent: UA_CHROME, locale: 'en-US', viewport: { width: 1536, height: 864 }, timezoneId: 'America/Chicago' },
      async (page) => {
        const notes: string[] = ['at-nvda-sim: expected human; teleport centre clicks with sub-ms press and no Enter key'];
        const rest = { x: 640, y: 20 }; // where the physical mouse sits, untouched, the whole session
        await page.mouse.move(rest.x, rest.y);
        const read = (ms: number) => page.waitForTimeout(ms + Math.random() * ms);
        await read(2500); // page summary is read aloud
        if (await tabTo(page, 'a.card')) await nvdaActivate(page, 'a.card', rest);
        await page.waitForLoadState('load');
        await read(3000);
        if (await tabTo(page, 'button[data-add]')) await nvdaActivate(page, 'button[data-add]', rest);
        await read(1500);
        if (await tabTo(page, 'nav a[href="/article"]')) await nvdaActivate(page, 'nav a[href="/article"]', rest);
        await page.waitForLoadState('load');
        // Reading by heading/paragraph: the screen reader consumes the arrow keys; the page sees only focus-driven scroll.
        await read(4000);
        for (let i = 0; i < 4; i++) {
          await page.keyboard.press('Tab');
          await read(900);
        }
        if (await tabTo(page, 'nav a[href="/contact"]')) await nvdaActivate(page, 'nav a[href="/contact"]', rest);
        await page.waitForLoadState('load');
        await read(2000);
        if (await tabTo(page, 'input[name=name]')) {
          await read(500);
          await typeInFormsMode(page, 'Dana Whitfield');
        }
        await page.keyboard.press('Tab');
        await read(700);
        await typeInFormsMode(page, 'dana@example.com');
        await page.keyboard.press('Tab');
        await read(700);
        await typeInFormsMode(page, 'Is the oak shelf available in walnut?');
        await read(1200);
        if (await tabTo(page, 'button[type=submit]')) await nvdaActivate(page, 'button[type=submit]', rest);
        await page.waitForLoadState('load');
        await read(3000);
        await page.waitForTimeout(6500);
        return notes;
      },
    ),
  { harnessArtifacts: PLAYWRIGHT_HARNESS_ARTIFACTS },
);
