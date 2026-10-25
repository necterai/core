import type { Page } from 'playwright';

/** Human-like pointer motion: curved Bezier path, bell-shaped speed, jitter, ~60 Hz sampling, small overshoot. */
export async function humanMove(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, opts: { durationMs?: number } = {}): Promise<void> {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const duration = opts.durationMs ?? Math.max(180, Math.min(900, 120 + dist * 1.2 + Math.random() * 150));
  const steps = Math.max(8, Math.round(duration / 16));
  const c1 = { x: from.x + (to.x - from.x) * (0.25 + Math.random() * 0.2) + (Math.random() - 0.5) * dist * 0.3, y: from.y + (to.y - from.y) * (0.1 + Math.random() * 0.2) + (Math.random() - 0.5) * dist * 0.3 };
  const c2 = { x: from.x + (to.x - from.x) * (0.7 + Math.random() * 0.2) + (Math.random() - 0.5) * dist * 0.15, y: from.y + (to.y - from.y) * (0.8 + Math.random() * 0.15) + (Math.random() - 0.5) * dist * 0.15 };
  const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  let last = performance.now();
  for (let i = 1; i <= steps; i++) {
    const t = ease(i / steps);
    const x = cubic(from.x, c1.x, c2.x, to.x, t) + (i < steps ? (Math.random() - 0.5) * 1.2 : 0);
    const y = cubic(from.y, c1.y, c2.y, to.y, t) + (i < steps ? (Math.random() - 0.5) * 1.2 : 0);
    await page.mouse.move(x, y);
    const now = performance.now();
    const wait = Math.max(0, 16 + (Math.random() - 0.5) * 8 - (now - last - 16));
    last = now;
    await page.waitForTimeout(wait);
  }
  // Slight overshoot and correction on longer moves.
  if (dist > 200 && Math.random() < 0.6) {
    await page.mouse.move(to.x + (Math.random() - 0.5) * 6, to.y + (Math.random() - 0.5) * 6);
    await page.waitForTimeout(30 + Math.random() * 40);
    await page.mouse.move(to.x, to.y);
  }
}

function cubic(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

export async function humanClick(page: Page, selector: string, cursor: { x: number; y: number }): Promise<{ x: number; y: number }> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error('no box for ' + selector);
  // Humans land off-centre, biased towards the centre: a truncated normal.
  const gx = clampN(randn() * 0.18 + 0.5, 0.12, 0.88);
  const gy = clampN(randn() * 0.2 + 0.5, 0.15, 0.85);
  const target = { x: box.x + box.width * gx, y: box.y + box.height * gy };
  await humanMove(page, cursor, target);
  await page.waitForTimeout(80 + Math.random() * 220); // hover dwell
  await page.mouse.down();
  await page.waitForTimeout(60 + Math.random() * 60);
  await page.mouse.up();
  return target;
}

export async function humanType(page: Page, selector: string, text: string, cursor: { x: number; y: number }): Promise<{ x: number; y: number }> {
  const pos = await humanClick(page, selector, cursor);
  await page.waitForTimeout(200 + Math.random() * 300);
  for (const ch of text) {
    await page.keyboard.type(ch);
    const base = /[ .,]/.test(ch) ? 140 : 70;
    await page.waitForTimeout(base + Math.random() * 120 + (Math.random() < 0.08 ? 300 : 0));
  }
  return pos;
}

export async function humanScroll(page: Page, totalPx: number): Promise<void> {
  let done = 0;
  while (done < totalPx) {
    const chunk = Math.min(totalPx - done, 40 + Math.random() * 120);
    await page.mouse.wheel(0, chunk);
    done += chunk;
    await page.waitForTimeout(20 + Math.random() * 60);
  }
  await page.waitForTimeout(400 + Math.random() * 800);
}

export async function idleFidget(page: Page, cursor: { x: number; y: number }, ms: number): Promise<{ x: number; y: number }> {
  const end = Date.now() + ms;
  let c = cursor;
  while (Date.now() < end) {
    const next = { x: c.x + (Math.random() - 0.5) * 40, y: c.y + (Math.random() - 0.5) * 30 };
    await humanMove(page, c, next, { durationMs: 150 + Math.random() * 200 });
    c = next;
    await page.waitForTimeout(300 + Math.random() * 900);
  }
  return c;
}

export function randn(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function clampN(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** humanClick on a link, then wait until the URL has actually changed and the new page has loaded.
 * waitForLoadState alone resolves against the old page, and input sent mid-navigation can hang. */
export async function humanClickNavigate(page: Page, selector: string, cursor: { x: number; y: number }): Promise<{ x: number; y: number }> {
  const before = page.url();
  const navigated = page.waitForURL((u) => u.toString() !== before, { waitUntil: 'load', timeout: 15_000 });
  const pos = await humanClick(page, selector, cursor);
  await navigated;
  return pos;
}
