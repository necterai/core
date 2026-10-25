import { chromium as patchright } from 'patchright';
import type { Browser, Page } from 'playwright';
import type { Attacker } from '../lib/types.js';
import { humanClick, humanClickNavigate, humanMove, humanScroll, idleFidget } from '../lib/human.js';
import { mk, withPlaywright, UA_CHROME, PLAYWRIGHT_HARNESS_ARTIFACTS } from './browsers.js';

/**
 * Bitwarden-style autofill (false-positive probe, expected `human`). From `insert-autofill-content.service.ts`
 * (confirmed): per field the content script calls element.click(), element.focus(), dispatches
 * `new KeyboardEvent('keydown', {bubbles: true})` and `keyup` (no `key`), assigns element.value = value, dispatches
 * keydown/keyup again, then `new Event('input', {bubbles: true})` and `change`; actions are sequenced with
 * `delayActionsInMilliseconds = 20`; the fill animation class `com-bitwarden-browser-animated-fill` is removed after
 * 200 ms. All of these are isTrusted === false. The human clicks the first field (real pointer) before the fill.
 */
export const BITWARDEN_ACTION_DELAY_MS = 20;
export const BITWARDEN_FILL_CLASS = 'com-bitwarden-browser-animated-fill';

/** Builds the fill-train function body; exported so tests can check the exact event sequence. */
export function bitwardenFillScript(): string {
  return `async ([fills, delayMs, cls]) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const dispatchKey = (el, type) => el.dispatchEvent(new KeyboardEvent(type, { bubbles: true }));
    const log = [];
    for (const [selector, value] of fills) {
      const el = document.querySelector(selector);
      if (!el) continue;
      el.click(); await sleep(delayMs);
      el.focus(); await sleep(delayMs);
      dispatchKey(el, 'keydown'); dispatchKey(el, 'keyup'); await sleep(delayMs);
      el.value = value; await sleep(delayMs);
      dispatchKey(el, 'keydown'); dispatchKey(el, 'keyup'); await sleep(delayMs);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.classList.add(cls);
      setTimeout(() => el.classList.remove(cls), 200);
      log.push(selector);
      await sleep(delayMs);
    }
    return log;
  }`;
}

export const BITWARDEN_EVENT_SEQUENCE = ['click', 'focus', 'keydown', 'keyup', 'value', 'keydown', 'keyup', 'input', 'change'] as const;

async function bitwardenFill(page: Page, fills: [string, string][]): Promise<string[]> {
  // The content script runs in an isolated world; the DOM events it dispatches are identical from the page's view.
  const fn = new Function('return ' + bitwardenFillScript())() as (args: [[string, string][], number, string]) => Promise<string[]>;
  return page.evaluate(fn, [fills, BITWARDEN_ACTION_DELAY_MS, BITWARDEN_FILL_CLASS] as [[string, string][], number, string]);
}

export const passwordManagerSim: Attacker = mk(
  'password-manager-sim',
  'Human with Bitwarden autofill (false-positive probe): human-sim pointer kinematics (Bezier paths, hover, off-centre clicks, wheel momentum, fidgeting), then after a real click on the first field an instant fill of name/email/message with the Bitwarden event train (untrusted click/focus/keydown/keyup/value/keydown/keyup/input/change at 20 ms spacing, animated-fill class for 200 ms).',
  { actorClass: 'human', automated: false },
  (ctx) =>
    withPlaywright(
      ctx,
      () => patchright.launch({ headless: !ctx.headed, channel: 'chrome', args: ['--disable-blink-features=AutomationControlled'] }) as unknown as Promise<Browser>,
      { userAgent: UA_CHROME, locale: 'en-US', viewport: { width: 1440, height: 900 }, timezoneId: 'America/Los_Angeles' },
      async (page) => {
        const notes: string[] = ['password-manager-sim: expected human; untrusted 20 ms fill train after a real click'];
        let cursor = { x: 420, y: 260 };
        await page.mouse.move(cursor.x, cursor.y);
        cursor = await idleFidget(page, cursor, 1200);
        cursor = await humanClickNavigate(page, 'a.card', cursor);
        cursor = await idleFidget(page, cursor, 1000);
        cursor = await humanClick(page, 'button[data-add]', cursor);
        cursor = await idleFidget(page, cursor, 700);
        cursor = await humanClickNavigate(page, 'nav a[href="/article"]', cursor);
        await humanScroll(page, 700);
        cursor = await idleFidget(page, cursor, 900);
        cursor = await humanClickNavigate(page, 'nav a[href="/contact"]', cursor);
        cursor = await idleFidget(page, cursor, 800);
        // Human clicks into the first field, then picks the identity from the Bitwarden inline menu (~0.6-1.2 s).
        cursor = await humanClick(page, 'input[name=name]', cursor);
        await page.waitForTimeout(600 + Math.random() * 600);
        const filled = await bitwardenFill(page, [
          ['input[name=name]', 'Priya Natarajan'],
          ['input[name=email]', 'priya@example.com'],
          ['textarea[name=message]', 'Hello, could you confirm the lead time on the oak shelf?'],
        ]);
        notes.push(`bitwarden filled: ${filled.join(', ')}`);
        // The user glances over the filled form, then submits with a real click.
        cursor = await idleFidget(page, cursor, 1500);
        cursor = await humanClickNavigate(page, 'button[type=submit]', cursor);
        await humanMove(page, cursor, { x: cursor.x + 60, y: cursor.y - 30 });
        await page.waitForTimeout(6500);
        return notes;
      },
    ),
  { harnessArtifacts: PLAYWRIGHT_HARNESS_ARTIFACTS },
);
