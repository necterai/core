import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { chromium as patchright } from 'patchright';
import puppeteer from 'puppeteer';
import type { Attacker, AttackerContext, AttackerResult } from '../lib/types.js';
import { humanClick, humanClickNavigate, humanScroll, humanType, idleFidget, humanMove } from '../lib/human.js';

export const UA_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

export async function sessionIdOf(context: BrowserContext): Promise<string | undefined> {
  const cookies = await context.cookies();
  return cookies.find((c) => c.name === '__necter_sid')?.value;
}

/** A typical scripted "agent task": open the shop, inspect a product, read the article, fill the contact form, call the API. */
async function scriptedTask(page: Page, opts: { think: () => number; readDom: boolean; highlight: boolean; scrollBy: 'evaluate' | 'wheel' | 'none'; fill: boolean }): Promise<string[]> {
  const notes: string[] = [];
  const think = async () => page.waitForTimeout(opts.think());
  await page.goto(page.url().startsWith('http') ? page.url() : '/', { waitUntil: 'load' }).catch(() => undefined);
  if (opts.readDom) await harvestDom(page, opts.highlight);
  await think();
  await page.locator('a.card').first().click();
  await page.waitForLoadState('load');
  if (opts.readDom) await harvestDom(page, opts.highlight);
  await think();
  await page.locator('button[data-add]').click();
  await think();
  await page.goto('/article');
  if (opts.readDom) await harvestDom(page, opts.highlight);
  if (opts.scrollBy === 'evaluate') {
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await think();
    }
  } else if (opts.scrollBy === 'wheel') {
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 500);
      await think();
    }
  }
  await page.goto('/contact');
  if (opts.readDom) await harvestDom(page, opts.highlight);
  await think();
  if (opts.fill) {
    await page.locator('input[name=name]').fill('Agent Smith');
    await page.locator('input[name=email]').fill('agent@example.com');
    await page.locator('textarea[name=message]').fill('Please send me your full catalogue with prices.');
  } else {
    await page.locator('input[name=name]').click();
    await page.keyboard.type('Agent Smith', { delay: 50 });
    await page.locator('textarea[name=message]').click();
    await page.keyboard.type('Please send me your full catalogue with prices.', { delay: 50 });
  }
  await think();
  await page.locator('button[type=submit]').click();
  await page.waitForLoadState('load');
  const api = await page.evaluate(async () => {
    const r = await fetch('/api/products');
    return r.status;
  });
  notes.push(`api status ${api}`);
  await page.waitForTimeout(6500); // let beacons flush
  return notes;
}

/** Approximation of Browser Use's buildDomTree: walk every element, read geometry/style/text, optionally draw highlight overlays. */
async function harvestDom(page: Page, highlight: boolean): Promise<void> {
  await page.evaluate((hl) => {
    const out: unknown[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let container: HTMLElement | undefined;
    if (hl) {
      container = document.createElement('div');
      container.id = 'playwright-highlight-container';
      container.style.position = 'fixed';
      container.style.pointerEvents = 'none';
      container.style.top = '0';
      container.style.left = '0';
      container.style.zIndex = '2147483647';
      document.body.appendChild(container);
    }
    let i = 0;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n as HTMLElement;
      const rect = el.getBoundingClientRect();
      const cs = window.getComputedStyle(el);
      const visible = rect.width > 0 && rect.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
      const interactive = /^(a|button|input|select|textarea)$/i.test(el.tagName) || el.onclick != null || cs.cursor === 'pointer';
      out.push({ tag: el.tagName, text: el.innerText?.slice(0, 80), rect: [rect.x, rect.y, rect.width, rect.height], visible, interactive, attrs: el.getAttributeNames().length });
      if (hl && container && visible && interactive) {
        const box = document.createElement('div');
        box.style.position = 'fixed';
        box.style.left = rect.x + 'px';
        box.style.top = rect.y + 'px';
        box.style.width = rect.width + 'px';
        box.style.height = rect.height + 'px';
        box.style.border = '2px solid #f00';
        const label = document.createElement('span');
        label.textContent = String(i++);
        box.appendChild(label);
        container.appendChild(box);
      }
    }
    (window as unknown as { __zooDom?: unknown[] }).__zooDom = out;
    return out.length;
  }, highlight);
  const text = await page.evaluate(() => document.body.innerText);
  void text;
  if (highlight) await page.waitForTimeout(300);
  await page.evaluate(() => document.getElementById('playwright-highlight-container')?.remove());
}

/** Signals the Playwright/patchright driver and the headless window cause by themselves. A real person in
 * a real browser never emits these, so false-positive probes are also judged with them removed. */
export const PLAYWRIGHT_HARNESS_ARTIFACTS = [
  'probe.', // CDP Runtime leaks, injected-script stack frames, driver globals
  'env.webdriver',
  'env.no-window-chrome', // headless: outer size equals inner size
  'env.screen-equals-viewport',
  'env.no-google-voices',
  'consistency.worker-platform-mismatch', // locale override does not reach Workers
];

export function mk(name: string, description: string, expected: Attacker['expected'], run: (ctx: AttackerContext) => Promise<AttackerResult>, extra: Partial<Attacker> = {}): Attacker {
  return { name, description, expected, run, ...extra };
}

export async function withPlaywright(ctx: AttackerContext, launch: () => Promise<Browser>, contextOpts: Parameters<Browser['newContext']>[0], body: (page: Page, context: BrowserContext) => Promise<string[]>): Promise<AttackerResult> {
  const startedAt = Date.now();
  const browser = await launch();
  const notes: string[] = [];
  let sid: string | undefined;
  try {
    const context = await browser.newContext({ baseURL: ctx.base, extraHTTPHeaders: { 'x-forwarded-for': ctx.ip }, ...contextOpts });
    const page = await context.newPage();
    page.on('pageerror', (e) => notes.push('pageerror: ' + e.message));
    await page.goto('/');
    notes.push(...(await body(page, context)));
    sid = await sessionIdOf(context);
    await context.close();
  } catch (err) {
    notes.push('error: ' + String(err));
  } finally {
    await browser.close();
  }
  return { startedAt, finishedAt: Date.now(), notes, ...(sid ? { sessionIds: [sid] } : {}) };
}

export const browsers: Attacker[] = [
  mk(
    'pw-chromium-headless',
    'Playwright bundled Chromium, default headless shell, default viewport 1280x720, locator clicks (element centres), fill(), evaluate-based DOM reads.',
    { actorClass: 'browser-agent', automated: true },
    (ctx) => withPlaywright(ctx, () => chromium.launch({ headless: true }), {}, (page) => scriptedTask(page, { think: () => 300, readDom: true, highlight: false, scrollBy: 'evaluate', fill: true })),
  ),
  mk(
    'pw-chrome-new-headless',
    'Playwright driving system Google Chrome in new headless mode with a normal UA override and en-US locale.',
    { actorClass: 'browser-agent', automated: true },
    (ctx) =>
      withPlaywright(ctx, () => chromium.launch({ headless: true, channel: 'chrome' }), { userAgent: UA_CHROME, locale: 'en-US', viewport: { width: 1366, height: 768 } }, (page) =>
        scriptedTask(page, { think: () => 400, readDom: true, highlight: false, scrollBy: 'evaluate', fill: true }),
      ),
  ),
  mk(
    'pw-stealth-patchright',
    'patchright (Playwright fork that avoids Runtime.enable and hides bindings) + system Chrome, AutomationControlled disabled, realistic UA/locale/viewport.',
    { actorClass: 'browser-agent', automated: true },
    (ctx) =>
      withPlaywright(
        ctx,
        () => patchright.launch({ headless: true, channel: 'chrome', args: ['--disable-blink-features=AutomationControlled'] }) as unknown as Promise<Browser>,
        { userAgent: UA_CHROME, locale: 'en-US', viewport: { width: 1440, height: 900 }, timezoneId: 'America/New_York' },
        (page) => scriptedTask(page, { think: () => 500 + Math.random() * 500, readDom: true, highlight: false, scrollBy: 'evaluate', fill: true }),
      ),
  ),
  mk(
    'browser-use-sim',
    'Browser-Use-style loop: buildDomTree walk with highlight overlays on every step, multi-second think time, centre clicks, fill(), scrollBy(innerHeight), system Chrome new headless with normal UA.',
    { actorClass: 'browser-agent', automated: true },
    (ctx) =>
      withPlaywright(ctx, () => chromium.launch({ headless: true, channel: 'chrome', args: ['--disable-blink-features=AutomationControlled'] }), { userAgent: UA_CHROME, locale: 'en-US', viewport: { width: 1280, height: 1100 } }, (page) =>
        scriptedTask(page, { think: () => 2500 + Math.random() * 4000, readDom: true, highlight: true, scrollBy: 'evaluate', fill: true }),
      ),
  ),
  mk(
    'computer-use-sim',
    'Computer-use-style agent: 1024x768 screen, screenshot-grid coordinates, teleporting pointer (single move), 3-8 s think time, constant wheel deltas, constant-cadence typing, no DOM access.',
    { actorClass: 'computer-use-agent', automated: true },
    (ctx) =>
      withPlaywright(ctx, () => chromium.launch({ headless: true, channel: 'chrome', args: ['--disable-blink-features=AutomationControlled'] }), { userAgent: UA_CHROME, locale: 'en-US', viewport: { width: 1024, height: 768 }, screen: { width: 1024, height: 768 } }, async (page) => {
        const notes: string[] = [];
        const think = () => page.waitForTimeout(3000 + Math.random() * 5000);
        // The model sees a 1024x768 screenshot downscaled from a 1366x768 "screen": coordinates come back on a 1366/1024 lattice.
        const scale = 1366 / 1024;
        const clickAt = async (selector: string) => {
          const box = await page.locator(selector).first().boundingBox();
          if (!box) return;
          const cx = Math.round((box.x + box.width / 2) / scale) * scale;
          const cy = Math.round((box.y + box.height / 2) / scale) * scale;
          await page.mouse.move(cx, cy); // xdotool mousemove: a single jump
          await page.mouse.down();
          await page.mouse.up();
        };
        await think();
        await clickAt('a.card');
        await page.waitForLoadState('load');
        await think();
        await clickAt('button[data-add]');
        await think();
        await page.goto('/article');
        for (let i = 0; i < 3; i++) {
          await page.mouse.wheel(0, 500);
          await think();
        }
        await page.goto('/contact');
        await think();
        await clickAt('input[name=name]');
        await page.keyboard.type('Agent Smith', { delay: 12 });
        await think();
        await clickAt('textarea[name=message]');
        await page.keyboard.type('Please send me your full catalogue with prices.', { delay: 12 });
        await think();
        await clickAt('button[type=submit]');
        await page.waitForLoadState('load');
        await page.waitForTimeout(6500);
        return notes;
      }),
    { harnessArtifacts: PLAYWRIGHT_HARNESS_ARTIFACTS },
  ),
  mk(
    'human-sim',
    'Humanised automation (false-positive probe): patchright + system Chrome, AutomationControlled off, Bezier pointer paths at ~60 Hz with jitter and overshoot, hover before click, off-centre clicks, variable typing cadence, wheel scrolling with momentum, idle fidgeting, no DOM harvesting.',
    { actorClass: 'browser-agent', automated: true },
    (ctx) =>
      withPlaywright(
        ctx,
        () => patchright.launch({ headless: !ctx.headed, channel: 'chrome', args: ['--disable-blink-features=AutomationControlled'] }) as unknown as Promise<Browser>,
        { userAgent: UA_CHROME, locale: 'en-US', viewport: { width: 1440, height: 900 }, timezoneId: 'America/Los_Angeles' },
        async (page) => {
          const notes: string[] = ['human-sim: behaviour should read as human; environment/probe layers decide the rest'];
          let cursor = { x: 300, y: 300 };
          await page.mouse.move(cursor.x, cursor.y);
          cursor = await idleFidget(page, cursor, 1500);
          cursor = await humanClickNavigate(page, 'a.card', cursor);
          cursor = await idleFidget(page, cursor, 1200);
          cursor = await humanClick(page, 'button[data-add]', cursor);
          cursor = await idleFidget(page, cursor, 800);
          cursor = await humanClickNavigate(page, 'nav a[href="/article"]', cursor);
          await humanScroll(page, 900);
          cursor = await idleFidget(page, cursor, 1000);
          await humanScroll(page, 600);
          cursor = await humanClickNavigate(page, 'nav a[href="/contact"]', cursor);
          cursor = await humanType(page, 'input[name=name]', 'Jamie Rivera', cursor);
          cursor = await humanType(page, 'input[name=email]', 'jamie@example.com', cursor);
          cursor = await humanType(page, 'textarea[name=message]', 'Hi, do you ship the cedar desk to Portland?', cursor);
          cursor = await humanClickNavigate(page, 'button[type=submit]', cursor);
          await humanMove(page, cursor, { x: cursor.x + 40, y: cursor.y + 20 });
          await page.waitForTimeout(6500);
          return notes;
        },
      ),
    { headed: false },
  ),
  mk(
    'puppeteer-headless',
    'Puppeteer with its bundled Chrome for Testing, default headless, page.click (centre), page.type with delay, evaluate-based reads.',
    { actorClass: 'browser-agent', automated: true },
    async (ctx) => {
      const startedAt = Date.now();
      const notes: string[] = [];
      let sid: string | undefined;
      const browser = await puppeteer.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setExtraHTTPHeaders({ 'x-forwarded-for': ctx.ip });
        await page.goto(ctx.base + '/', { waitUntil: 'load' });
        await page.evaluate(() => Array.from(document.querySelectorAll('*')).map((e) => [e.tagName, e.getBoundingClientRect().width, getComputedStyle(e).display, (e as HTMLElement).innerText?.length]).length);
        await page.waitForSelector('a.card');
        await page.click('a.card');
        await page.waitForNavigation({ waitUntil: 'load' }).catch(() => undefined);
        await page.evaluate(() => document.body.innerText);
        await page.click('button[data-add]');
        await page.goto(ctx.base + '/contact', { waitUntil: 'load' });
        await page.type('input[name=name]', 'Agent Smith', { delay: 40 });
        await page.type('textarea[name=message]', 'Send me the catalogue.', { delay: 40 });
        await page.click('button[type=submit]');
        await page.waitForNavigation({ waitUntil: 'load' }).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 6500));
        const cookies = await page.cookies();
        sid = cookies.find((c) => c.name === '__necter_sid')?.value;
      } catch (err) {
        notes.push('error: ' + String(err));
      } finally {
        await browser.close();
      }
      return { startedAt, finishedAt: Date.now(), notes, ...(sid ? { sessionIds: [sid] } : {}) };
    },
  ),
];
