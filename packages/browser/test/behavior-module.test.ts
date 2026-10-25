import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SIGNAL_CATALOG, createRegistry, createSignal, type Signal, type SignalInput } from '@necterai/core';
import { createBehaviorModule, type BehaviorModule, type BehaviorModuleDeps, type InteractionSummaryWithRaw, type RectLike } from '../src/behavior/index.js';
import { createScheduler } from '../src/scheduler.js';
import type { ModuleContext } from '../src/types.js';

// ───────────────────────── harness ─────────────────────────

interface Harness {
  mod: BehaviorModule;
  signals: Signal[];
  retracted: string[];
  events: { type: string; data: unknown }[];
  /** Ids emitted at any point during the run. */
  everEmitted: Set<string>;
  active(id: string): Signal | undefined;
  clock: { t: number };
  setVisibility(v: 'visible' | 'hidden'): void;
  stop(): void;
}

const trusted = new WeakSet<Event>();
const rects = new WeakMap<Element, RectLike>();
const STACK_EXTENSION = 'Error\n    at onClick (https://site.example/sdk.js:1:10)\n    at chrome-extension://abcdefghijklmnop/content.js:5:3';
const STACK_SITE = 'Error\n    at onClick (https://site.example/sdk.js:1:10)\n    at HTMLElement.click (https://site.example/app.js:20:7)';
let stackText = STACK_EXTENSION;

function harness(options: Record<string, unknown> = {}, deps: BehaviorModuleDeps = {}): Harness {
  const registry = createRegistry(SIGNAL_CATALOG);
  const schedule = createScheduler();
  const signals: Signal[] = [];
  const current = new Map<string, Signal>();
  const retracted: string[] = [];
  const events: { type: string; data: unknown }[] = [];
  const everEmitted = new Set<string>();
  const clock = { t: 1 };
  let vis: 'visible' | 'hidden' = 'visible';
  const ctx = {
    config: { modules: { behavior: options }, trustedScriptOrigins: [] } as unknown as ModuleContext['config'],
    session: { id: 's1', firstVisit: true, startedAt: Date.now(), pageViews: 1 },
    registry,
    schedule,
    options,
    now: () => Date.now(),
    emit(input: SignalInput) {
      const s = createSignal(input, registry, { source: 'client' });
      signals.push(s);
      current.set(s.id, s);
      everEmitted.add(s.id);
      return s;
    },
    retract(id: string) {
      retracted.push(id);
      current.delete(id);
    },
    event(e: { type: string; data: unknown }) {
      events.push(e);
    },
    requestEvaluate() {},
    finalize() {},
    log() {},
    verdict: () => ({}) as ReturnType<ModuleContext['verdict']>,
  } as unknown as ModuleContext;
  const mod = createBehaviorModule({
    isTrusted: (e) => trusted.has(e),
    now: () => clock.t,
    visibilityState: () => vis,
    prerendering: () => false,
    rect: (el) => rects.get(el) ?? null,
    dpr: () => 1,
    stack: () => stackText,
    chromium: false,
    finePointer: true,
    sourceCapsSupported: true,
    hasFocus: () => true,
    ...deps,
  });
  mod.start(ctx);
  return {
    mod,
    signals,
    retracted,
    events,
    everEmitted,
    active: (id) => current.get(id),
    clock,
    setVisibility(v) {
      vis = v;
      document.dispatchEvent(new Event('visibilitychange'));
    },
    stop() {
      mod.stop?.();
      schedule.dispose();
    },
  };
}

/** Dispatch with a fixed timeStamp; `trust` marks the event as isTrusted for the module. */
function fire<T extends Event>(h: Harness, target: EventTarget, ev: T, t: number, trust = true, extra: Record<string, unknown> = {}): T {
  Object.defineProperty(ev, 'timeStamp', { value: t });
  for (const [k, v] of Object.entries(extra)) Object.defineProperty(ev, k, { value: v });
  if (trust) trusted.add(ev);
  if (t > h.clock.t) h.clock.t = t;
  target.dispatchEvent(ev);
  return ev;
}

const SCREEN_DX = 0;
const SCREEN_DY = 85;

function move(h: Harness, x: number, y: number, t: number, o: { mx?: number; my?: number; buttons?: number; pointerType?: string; target?: EventTarget; trust?: boolean } = {}): void {
  fire(
    h,
    o.target ?? document.body,
    new PointerEvent('pointermove', {
      clientX: x,
      clientY: y,
      screenX: x + SCREEN_DX,
      screenY: y + SCREEN_DY,
      movementX: o.mx ?? 0,
      movementY: o.my ?? 0,
      buttons: o.buttons ?? 0,
      pointerType: o.pointerType ?? 'mouse',
      bubbles: true,
    }),
    t,
    o.trust ?? true,
  );
}

interface ClickOpts {
  /** pointerover → pointerdown (ms); the single pre-click move happens at the same time. */
  overDown?: number;
  downUp?: number;
  pressure?: number;
  /** Emit the single teleport pointermove before the press (default true). */
  teleportMove?: boolean;
  from?: { x: number; y: number };
  detail?: number;
  mdDetail?: number;
  pointerType?: string;
  sourceCapabilities?: unknown;
  trust?: boolean;
}

/** One driver-style click at (x, y) on `el`, pressing at time t. */
function click(h: Harness, el: Element, x: number, y: number, t: number, o: ClickOpts = {}): void {
  const overDown = o.overDown ?? 2;
  const downUp = o.downUp ?? 0.6;
  const pt = o.pointerType ?? 'mouse';
  const trust = o.trust ?? true;
  if (o.teleportMove !== false) {
    const from = o.from ?? { x: 0, y: 0 };
    fire(h, el, new PointerEvent('pointerover', { clientX: x, clientY: y, pointerType: pt, bubbles: true }), t - overDown, trust);
    move(h, x, y, t - overDown, { mx: x - from.x, my: y - from.y, pointerType: pt, target: el, trust });
  }
  const pOpts = { clientX: x, clientY: y, screenX: x + SCREEN_DX, screenY: y + SCREEN_DY, pointerType: pt, bubbles: true, button: 0 };
  const sc = 'sourceCapabilities' in o ? { sourceCapabilities: o.sourceCapabilities } : { sourceCapabilities: { firesTouchEvents: false } };
  fire(h, el, new PointerEvent('pointerdown', { ...pOpts, buttons: 1, pressure: o.pressure ?? 0.5 }), t, trust);
  fire(h, el, new MouseEvent('mousedown', { ...pOpts, buttons: 1, detail: o.mdDetail ?? 1 }), t, trust, sc);
  fire(h, el, new PointerEvent('pointerup', { ...pOpts, buttons: 0, pressure: 0 }), t + downUp, trust);
  fire(h, el, new MouseEvent('mouseup', { ...pOpts, detail: o.detail ?? 1 }), t + downUp, trust, sc);
  fire(h, el, new PointerEvent('click', { ...pOpts, detail: o.detail ?? 1 }), t + downUp, trust, sc);
}

function button(left: number, top: number, w = 120, hgt = 40, tag = 'button'): HTMLElement {
  const el = document.createElement(tag);
  document.body.appendChild(el);
  rects.set(el, { left, top, width: w, height: hgt });
  return el;
}

function field(type = 'text', autocomplete?: string): HTMLInputElement {
  const el = document.createElement('input');
  el.type = type;
  if (autocomplete) el.setAttribute('autocomplete', autocomplete);
  document.body.appendChild(el);
  rects.set(el, { left: 50, top: 400, width: 200, height: 30 });
  return el;
}

function key(h: Harness, target: EventTarget, k: string, code: string, down: number, up: number | null, trust = true): void {
  fire(h, target, new KeyboardEvent('keydown', { key: k, code, bubbles: true }), down, trust);
  if (up !== null) fire(h, target, new KeyboardEvent('keyup', { key: k, code, bubbles: true }), up, trust);
}

function codeFor(ch: string): string {
  if (ch === ' ') return 'Space';
  if (/[a-z]/i.test(ch)) return `Key${ch.toUpperCase()}`;
  if (/[0-9]/.test(ch)) return `Digit${ch}`;
  return 'Period';
}

/** Type `text` into `el` with explicit per-key down times and dwell; input events carry insertText. */
function typeText(h: Harness, el: HTMLInputElement, text: string, downs: number[], dwell: number | number[]): void {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const d = downs[i]!;
    const dw = Array.isArray(dwell) ? dwell[i]! : dwell;
    fire(h, el, new KeyboardEvent('keydown', { key: ch, code: codeFor(ch), bubbles: true }), d);
    fire(h, el, new InputEvent('beforeinput', { inputType: 'insertText', data: ch, bubbles: true }), d);
    el.value += ch;
    fire(h, el, new InputEvent('input', { inputType: 'insertText', data: ch, bubbles: true }), d);
    fire(h, el, new KeyboardEvent('keyup', { key: ch, code: codeFor(ch), bubbles: true }), d + dw);
  }
}

function focus(h: Harness, el: Element, t: number, trust = true): void {
  fire(h, el, new FocusEvent('focusin', { bubbles: true }), t, trust);
}

let rng = 12345;
function rand(): number {
  rng = (rng * 1103515245 + 12345) % 2 ** 31;
  return rng / 2 ** 31;
}

async function readDataset(rel: string): Promise<string> {
  const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as { readFileSync(p: string, enc: string): string };
  // Plain path (Vite rewrites `new URL(..., import.meta.url)` as an asset reference).
  const testDir = decodeURIComponent(import.meta.url.replace(/^file:\/\//, '')).replace(/\/[^/]+$/, '');
  return fs.readFileSync(`${testDir}/../../../docs/research/datasets/${rel}`, 'utf8');
}

afterEach(() => {
  document.body.innerHTML = '';
  stackText = STACK_EXTENSION;
  vi.useRealTimers();
});

// ───────────────────────── wiring ─────────────────────────

describe('behavior module wiring', () => {
  it('has the module name "behavior" and emits nothing without input', () => {
    const h = harness();
    expect(h.mod.name).toBe('behavior');
    h.clock.t = 30_000;
    const f = h.mod.evaluateNow();
    expect(f).not.toBeNull();
    expect(h.signals).toEqual([]);
    h.stop();
  });

  it('never throws into the page when a dependency fails', () => {
    const h = harness({}, { rect: () => { throw new Error('boom'); } });
    const b = button(100, 100);
    expect(() => click(h, b, 160, 120, 1000)).not.toThrow();
    expect(() => h.mod.evaluateNow()).not.toThrow();
    h.stop();
  });

  it('stops listening after stop()', () => {
    const h = harness();
    h.stop();
    const b = button(100, 100);
    for (let i = 0; i < 5; i++) click(h, b, 160, 120, 2000 + i * 3000);
    expect(h.mod.evaluateNow()).toBeNull();
    expect(h.signals).toEqual([]);
  });
});

// ───────────────────────── automation profiles ─────────────────────────

/** Five targets at distinct positions; the driver clicks each exact centre. */
function targets(): { el: HTMLElement; cx: number; cy: number }[] {
  return [
    [80, 120],
    [400, 160],
    [220, 420],
    [640, 300],
    [120, 600],
  ].map(([l, t]) => ({ el: button(l!, t!), cx: l! + 60, cy: t! + 20 }));
}

describe('Playwright steps=1 click profile', () => {
  it('fires no-pointer-path, center-clicks and robotic-input-timing; never natural-pointer', () => {
    const h = harness();
    let from = { x: 0, y: 0 };
    targets().forEach(({ el, cx, cy }, i) => {
      click(h, el, cx, cy, 3000 + i * 1500, { overDown: 2, downUp: 0.4, pressure: 0.5, from });
      from = { x: cx, y: cy };
      h.mod.evaluateNow();
    });
    expect(h.active('beh.no-pointer-path')?.reliability).toBe(1);
    expect(h.active('beh.center-clicks')).toBeDefined();
    const robotic = h.active('beh.robotic-input-timing');
    expect(robotic).toBeDefined();
    expect((robotic?.details?.['criteria'] as string[]).join(' ')).toMatch(/down→up/);
    expect(h.everEmitted.has('beh.natural-pointer')).toBe(false);
    expect(h.everEmitted.has('beh.synthetic-event-properties')).toBe(false); // pressure 0.5 + real movement deltas
    expect(h.everEmitted.has('beh.at-possible')).toBe(false);
    expect(h.active('beh.no-pointer-path')?.summary).toMatch(/5 of the last 5 clicks/);
    h.stop();
  });
});

describe('Puppeteer profile', () => {
  it('pressure 0 on press fires synthetic-event-properties', () => {
    const h = harness();
    targets().forEach(({ el, cx, cy }, i) => click(h, el, cx, cy, 3000 + i * 1500, { pressure: 0, overDown: 1, downUp: 0.3 }));
    h.mod.evaluateNow();
    const s = h.active('beh.synthetic-event-properties');
    expect(s?.summary).toMatch(/pressure 0 on 5 mouse presses/);
    expect(s?.reliability).toBe(1);
    expect(h.active('beh.no-pointer-path')).toBeDefined();
    h.stop();
  });

  it('mouse.move steps=10 produces beh.linear-pointer-path', () => {
    const h = harness();
    const ts = targets();
    let from = { x: 10, y: 10 };
    ts.slice(0, 3).forEach(({ el, cx, cy }, i) => {
      const t0 = 4000 + i * 2000;
      for (let s = 1; s <= 10; s++) {
        const x = from.x + ((cx - from.x) * s) / 10;
        const y = from.y + ((cy - from.y) * s) / 10;
        move(h, x, y, t0 + s * 1.7 + (s % 3) * 0.4, { mx: (cx - from.x) / 10, my: (cy - from.y) / 10 });
      }
      click(h, el, cx, cy, t0 + 20, { teleportMove: false, pressure: 0, downUp: 0.5 });
      from = { x: cx, y: cy };
    });
    h.mod.evaluateNow();
    expect(h.active('beh.linear-pointer-path')?.value).toBe(3);
    expect(h.active('beh.natural-pointer')).toBeUndefined();
    h.stop();
  });
});

describe('CDP extension profile (Claude in Chrome)', () => {
  it('3 ms keys with identical timestamps and 4.8 ms presses fire robotic-input-timing', () => {
    const h = harness();
    const ts = targets();
    click(h, ts[0]!.el, ts[0]!.cx, ts[0]!.cy, 2000, { overDown: 9, downUp: 4.8 });
    click(h, ts[1]!.el, ts[1]!.cx, ts[1]!.cy, 3500, { overDown: 9, downUp: 4.8 });
    const input = field();
    focus(h, input, 3600);
    // Wall spacing ≈ 3 ms but several keys share one event timeStamp (extension-agents §3.4).
    const downs = [5000, 5000, 5000.2, 5003.1, 5003.1, 5006.3, 5006.3, 5006.4, 5009.5, 5009.5, 5009.6];
    typeText(h, input, 'hello world', downs, 0);
    h.mod.evaluateNow();
    const s = h.active('beh.robotic-input-timing');
    expect(s).toBeDefined();
    const criteria = (s?.details?.['criteria'] as string[]).join(' | ');
    expect(criteria).toMatch(/sharing a timeStamp/);
    expect(criteria).toMatch(/median inter-key/);
    expect(s?.details?.['keyProfile']).toBe('cdp-back-to-back');
    expect(h.everEmitted.has('beh.natural-typing')).toBe(false);
    h.stop();
  });

  it('form_input (trusted focus, untrusted plain input/change) fires beh.untrusted-form-fill', () => {
    const h = harness();
    const input = field();
    focus(h, input, 1000);
    input.value = 'zzz@example.org';
    fire(h, input, new Event('change', { bubbles: true }), 1003.8, false);
    fire(h, input, new Event('input', { bubbles: true }), 1003.8, false);
    h.clock.t = 2000;
    h.mod.evaluateNow();
    expect(h.active('beh.untrusted-form-fill')).toBeDefined();
    expect(h.active('beh.human-input-evidence')).toBeUndefined();
    expect(h.active('beh.instant-fill')).toBeUndefined();
    h.stop();
  });
});

describe('xdotool (computer-use harness) profile', () => {
  it('12 ms typing, sub-ms presses and 100 ms wheel ticks', () => {
    const h = harness();
    const ts = targets();
    let from = { x: 512, y: 384 };
    ts.forEach(({ el, cx, cy }, i) => {
      // mousemove --sync (warp) then a separate `xdotool click 1` process ~20 ms later; press→release 12 µs.
      click(h, el, cx, cy, 3000 + i * 4000, { overDown: 18 + (i % 3) * 3, downUp: 0.1 + (i % 2) * 0.1, from });
      from = { x: cx, y: cy };
    });
    const input = field();
    focus(h, input, 30_000);
    const text = 'the quick brown fox jumps';
    const downs = Array.from(text, (_, i) => 31_000 + i * 12 + (i % 2 ? 0.3 : -0.2));
    typeText(h, input, text, downs, 6);
    for (let i = 0; i < 6; i++) {
      const w = new WheelEvent('wheel', { deltaY: 120, deltaMode: 0, bubbles: true });
      fire(h, document, w, 40_000 + i * 100 + (i % 2) * 0.4, true, { wheelDeltaY: -120 });
    }
    h.clock.t = 41_000;
    h.mod.evaluateNow();
    const met = h.active('beh.metronomic-typing');
    expect(met?.details?.['profile']).toBe('xdotool-type-delay-12');
    expect(h.active('beh.no-pointer-path')).toBeDefined();
    expect(h.active('beh.robotic-input-timing')).toBeDefined();
    const wheel = h.active('beh.quantised-wheel');
    expect(wheel?.summary).toMatch(/timer cadence/);
    expect(wheel?.reliability).toBe(0.8);
    h.stop();
  });
});

describe('Browser Use profile (fixed 80 ms click + fill)', () => {
  it('fires no-pointer-path, center-clicks, pressure-0 synthetic properties, robotic timing and instant-fill', () => {
    const h = harness();
    const ts = targets();
    ts.forEach(({ el, cx, cy }, i) => click(h, el, cx, cy, 3000 + i * 2500, { overDown: 50, downUp: 80 + [0.4, -1.1, 1.6, 0.2, -0.7][i]!, pressure: 0 }));
    // send_keys: keyDown → 5 ms → char → keyUp → 1 ms (fixed constants).
    const input = field();
    focus(h, input, 20_000);
    const text = 'browseruse';
    typeText(h, input, text, Array.from(text, (_, i) => 20_100 + i * 6.1), 5);
    // _set_value_directly / CDP insertText into a second field: one trusted input, no keys.
    const other = field();
    focus(h, other, 22_000);
    fire(h, other, new Event('select', { bubbles: true }), 22_001);
    other.value = 'Jane Q. Example';
    fire(h, other, new InputEvent('beforeinput', { inputType: 'insertText', data: other.value, bubbles: true }), 22_010);
    fire(h, other, new InputEvent('input', { inputType: 'insertText', data: other.value, bubbles: true }), 22_010);
    h.clock.t = 23_000;
    h.mod.evaluateNow();
    expect(h.active('beh.no-pointer-path')).toBeDefined();
    expect(h.active('beh.center-clicks')).toBeDefined();
    expect(h.active('beh.synthetic-event-properties')?.summary).toMatch(/pressure 0/);
    const robotic = h.active('beh.robotic-input-timing');
    expect((robotic?.details?.['criteria'] as string[]).join(' ')).toMatch(/press duration 80/);
    const fill = h.active('beh.instant-fill');
    expect(fill).toBeDefined();
    expect(fill?.reliability).toBe(0.75); // select() before insertText adds 0.25
    h.stop();
  });
});

describe('computer-use coordinate lattice', () => {
  it('screen coordinates on round(k × 1.5) fire beh.coordinate-lattice with stride 1.5', () => {
    const h = harness();
    const big = button(0, 0, 1280, 800, 'div');
    rng = 99;
    let from = { x: 0, y: 0 };
    // Python round(): half to even.
    const pyRound = (v: number): number => (Math.abs(v - Math.floor(v) - 0.5) < 1e-9 ? (Math.floor(v) % 2 === 0 ? Math.floor(v) : Math.floor(v) + 1) : Math.round(v));
    for (let i = 0; i < 24; i++) {
      // Model sees a 1280x720 screenshot of a 1920x1080 display; the harness scales by 1.5 and rounds
      // (Anthropic scale_coordinates).
      const kx = 40 + Math.floor(rand() * 800);
      const ky = 80 + Math.floor(rand() * 400);
      const sx = pyRound(kx * 1.5);
      const sy = pyRound(ky * 1.5);
      const x = sx - SCREEN_DX;
      const y = sy - SCREEN_DY;
      click(h, big, x, y, 3000 + i * 3500, { overDown: 15, downUp: 0.2, from });
      from = { x, y };
    }
    h.mod.evaluateNow();
    const s = h.active('beh.coordinate-lattice');
    expect(s?.value).toBe(1.5);
    expect(s?.details?.['frame']).toBe('screen');
    expect(s?.details?.['mapping']).toBe('round-even');
    expect(s?.reliability).toBeGreaterThan(0.7);
    h.stop();
  });
});

describe('touch input', () => {
  it('never fires pointer signals for touch taps', () => {
    const h = harness();
    targets().forEach(({ el, cx, cy }, i) => click(h, el, cx, cy, 3000 + i * 1500, { pointerType: 'touch', downUp: 0.1, pressure: 0 }));
    h.mod.evaluateNow();
    for (const id of ['beh.no-pointer-path', 'beh.center-clicks', 'beh.robotic-input-timing', 'beh.synthetic-event-properties', 'beh.coordinate-lattice']) {
      expect(h.everEmitted.has(id)).toBe(false);
    }
    h.stop();
  });
});

// ───────────────────────── human datasets ─────────────────────────

const BALABIT = ['balabit/user12_session_2144641057.csv', 'balabit/user15_session_0205904470.csv', 'balabit/user16_session_0735651357.csv'];
// Third-party datasets, not in the repo: `pnpm datasets` downloads them. Without them these replays are skipped.
const HAVE_DATASETS = await (async () => {
  try {
    await readDataset('cmu/DSL-StrongPasswordData.csv');
    for (const f of BALABIT) await readDataset(f);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!HAVE_DATASETS).each(BALABIT)('human replay: full Balabit session %s', (file) => {
  let rows: { t: number; button: string; state: string; x: number; y: number }[] = [];
  beforeAll(async () => {
    const csv = await readDataset(file);
    rows = csv
      .trim()
      .split('\n')
      .slice(1)
      .map((l) => {
        const [, client, button, state, x, y] = l.split(',');
        return { t: 1000 + Number(client) * 1000, button: button!, state: state!, x: Number(x), y: Number(y) };
      });
  });

  it('does not fire no-pointer-path / linear-pointer-path and fires natural-pointer', () => {
    const h = harness();
    const surface = document.body;
    let last = { x: rows[0]!.x, y: rows[0]!.y };
    let clicks = 0;
    for (const r of rows) {
      if (r.state === 'Move' || r.state === 'Drag') {
        move(h, r.x, r.y, r.t, { mx: r.x - last.x, my: r.y - last.y, buttons: r.state === 'Drag' ? 1 : 0, target: surface });
        last = { x: r.x, y: r.y };
      } else if (r.button === 'Left' && r.state === 'Pressed') {
        const o = { clientX: r.x, clientY: r.y, screenX: r.x, screenY: r.y + SCREEN_DY, pointerType: 'mouse', bubbles: true, button: 0 };
        fire(h, surface, new PointerEvent('pointerdown', { ...o, buttons: 1, pressure: 0.5 }), r.t);
        fire(h, surface, new MouseEvent('mousedown', { ...o, buttons: 1, detail: 1 }), r.t, true, { sourceCapabilities: {} });
      } else if (r.button === 'Left' && r.state === 'Released') {
        const o = { clientX: r.x, clientY: r.y, screenX: r.x, screenY: r.y + SCREEN_DY, pointerType: 'mouse', bubbles: true, button: 0 };
        fire(h, surface, new PointerEvent('pointerup', { ...o, pressure: 0 }), r.t);
        fire(h, surface, new MouseEvent('mouseup', { ...o, detail: 1 }), r.t, true, { sourceCapabilities: {} });
        fire(h, surface, new PointerEvent('click', { ...o, detail: 1 }), r.t, true, { sourceCapabilities: {} });
        clicks++;
        if (clicks % 3 === 0) h.mod.evaluateNow();
      } else if (r.button === 'Scroll') {
        const down = r.state === 'Down';
        fire(h, surface, new WheelEvent('wheel', { deltaY: down ? 100 : -100, bubbles: true }), r.t, true, { wheelDeltaY: down ? -120 : 120 });
        fire(h, document, new Event('scroll'), r.t + 8);
      }
    }
    h.mod.evaluateNow();
    expect(clicks).toBeGreaterThan(300);
    expect(h.everEmitted.has('beh.no-pointer-path')).toBe(false);
    expect(h.everEmitted.has('beh.linear-pointer-path')).toBe(false);
    expect(h.active('beh.natural-pointer')?.reliability).toBe(1);
    for (const id of ['beh.robotic-input-timing', 'beh.coordinate-lattice', 'beh.quantised-wheel', 'beh.programmatic-scroll', 'beh.llm-think-time', 'beh.no-idle-motion', 'beh.synthetic-event-properties']) {
      expect(h.everEmitted.has(id), id).toBe(false);
    }
    h.stop();
  }, 60_000);
});

describe.skipIf(!HAVE_DATASETS)('human replay: CMU keystroke timings', () => {
  it('never fires metronomic-typing and fires natural-typing', async () => {
    const csv = await readDataset('cmu/DSL-StrongPasswordData.csv');
    const lines = csv.trim().split('\n');
    const hdr = lines[0]!.split(',');
    const H = hdr.map((c, i) => (c.startsWith('H.') ? i : -1)).filter((i) => i >= 0);
    const DD = hdr.map((c, i) => (c.startsWith('DD.') ? i : -1)).filter((i) => i >= 0);
    const keys: [string, string][] = [
      ['.', 'Period'],
      ['t', 'KeyT'],
      ['i', 'KeyI'],
      ['e', 'KeyE'],
      ['5', 'Digit5'],
      ['R', 'KeyR'],
      ['o', 'KeyO'],
      ['a', 'KeyA'],
      ['n', 'KeyN'],
      ['l', 'KeyL'],
      ['Enter', 'Enter'],
    ];
    const h = harness();
    let t = 1000;
    // Every 25th repetition across all 51 subjects (816 password entries, 8,976 keystrokes).
    for (let row = 1; row < lines.length; row += 25) {
      const c = lines[row]!.split(',');
      const input = field('password');
      focus(h, input, t);
      let down = t + 300;
      for (let k = 0; k < keys.length; k++) {
        const hold = Number(c[H[k]!]) * 1000;
        key(h, input, keys[k]![0], keys[k]![1], down, down + hold);
        if (k < DD.length) down += Number(c[DD[k]!]) * 1000;
      }
      t = down + 3000;
      if (row % 500 === 1) h.mod.evaluateNow();
      input.remove();
    }
    h.mod.evaluateNow();
    expect(h.everEmitted.has('beh.metronomic-typing')).toBe(false);
    expect(h.everEmitted.has('beh.robotic-input-timing')).toBe(false);
    expect(h.active('beh.natural-typing')).toBeDefined();
    h.stop();
  });
});

// ───────────────────────── assistive technology ─────────────────────────

describe('NVDA teleport-click profile', () => {
  it('sets beh.at-possible and never emits no-pointer-path, center-clicks or robotic-input-timing', () => {
    const h = harness();
    const ts = targets();
    const rest = { x: 900, y: 700 };
    move(h, rest.x, rest.y, 500, { mx: 3, my: 1 }); // where the user's mouse rests
    let t = 2000;
    // Browse/focus navigation with Tab between activations (keys reach the page in forms mode).
    for (let i = 0; i < 6; i++) {
      key(h, document.body, 'Tab', 'Tab', t, t + 90);
      focus(h, ts[i % ts.length]!.el, t + 2);
      t += 1800;
    }
    for (const { el, cx, cy } of ts) {
      // Enter in browse mode: pointer jumps to the centre ~1 ms before pointerdown, release < 1 ms,
      // jump back ~5 ms after pointerup; no keydown for Enter reaches the page (false-positive-traps §3.1).
      click(h, el, cx - 0.33, cy + 0.5, t, { overDown: 1, downUp: 0.8, pressure: 0.5, from: rest });
      move(h, rest.x, rest.y, t + 0.8 + 5, { mx: rest.x - cx, my: rest.y - cy });
      h.mod.evaluateNow();
      key(h, document.body, 'Tab', 'Tab', t + 1500, t + 1590);
      focus(h, el, t + 1502);
      t += 4000;
    }
    h.mod.evaluateNow();
    const at = h.active('beh.at-possible');
    expect(at).toBeDefined();
    expect(at?.value).toContain('pointer-jump-back');
    for (const id of ['beh.no-pointer-path', 'beh.center-clicks', 'beh.robotic-input-timing', 'beh.coordinate-lattice', 'beh.llm-think-time']) {
      expect(h.everEmitted.has(id), id).toBe(false);
    }
    h.stop();
  });

  it('UIA Invoke clicks (detail 0, sourceCapabilities null) set AT-possible and retract earlier hypotheses', () => {
    const h = harness();
    const ts = targets();
    ts.forEach(({ el, cx, cy }, i) => click(h, el, cx, cy, 3000 + i * 1500));
    h.mod.evaluateNow();
    expect(h.active('beh.no-pointer-path')).toBeDefined();
    expect(h.active('beh.center-clicks')).toBeDefined();
    const b = button(300, 700);
    focus(h, b, 20_000);
    click(h, b, 360, 720, 20_001, { teleportMove: false, mdDetail: 0, sourceCapabilities: null, downUp: 0.2 });
    h.mod.evaluateNow();
    expect(h.active('beh.at-possible')?.value).toEqual(expect.arrayContaining(['source-capabilities-null', 'mousedown-detail-0']));
    expect(h.retracted).toEqual(expect.arrayContaining(['beh.no-pointer-path', 'beh.center-clicks', 'beh.robotic-input-timing']));
    expect(h.active('beh.no-pointer-path')).toBeUndefined();
    h.stop();
  });

  it('keyboard-only navigation sets beh.keyboard-only and beh.at-possible', () => {
    const h = harness();
    const ts = targets();
    let t = 1000;
    for (let i = 0; i < 6; i++) {
      key(h, document.body, 'Tab', 'Tab', t, t + 80);
      focus(h, ts[i % ts.length]!.el, t + 1);
      t += 900;
    }
    key(h, ts[0]!.el, 'Enter', 'Enter', t, t + 70);
    fire(h, ts[0]!.el, new PointerEvent('click', { pointerType: '', detail: 0, bubbles: true }), t + 1, true, { sourceCapabilities: null });
    h.mod.evaluateNow();
    expect(h.active('beh.keyboard-only')?.value).toBe(6);
    expect(h.active('beh.at-possible')?.value).toContain('keyboard-only');
    h.stop();
  });
});

// ───────────────────────── fills ─────────────────────────

describe('password managers and autofill', () => {
  it('a Bitwarden fill train produces beh.human-input-evidence, not instant-fill / untrusted signals', () => {
    const h = harness();
    const user = field('text', 'username');
    const pass = field('password', 'current-password');
    let t = 5000;
    for (const [el, value] of [
      [user, 'jane@example.org'],
      [pass, 'correct horse battery'],
    ] as const) {
      fire(h, el, new MouseEvent('click', { bubbles: true }), t, false);
      focus(h, el, t + 0.2); // element.focus() → trusted focus events
      fire(h, el, new KeyboardEvent('keydown', { bubbles: true }), t + 0.4, false);
      fire(h, el, new KeyboardEvent('keyup', { bubbles: true }), t + 0.5, false);
      el.value = value;
      fire(h, el, new KeyboardEvent('keydown', { bubbles: true }), t + 0.7, false);
      fire(h, el, new KeyboardEvent('keyup', { bubbles: true }), t + 0.8, false);
      fire(h, el, new Event('input', { bubbles: true }), t + 1, false);
      fire(h, el, new Event('change', { bubbles: true }), t + 1.1, false);
      t += 20; // delayActionsInMilliseconds = 20
    }
    h.clock.t = 7000;
    h.mod.evaluateNow();
    expect(h.active('beh.human-input-evidence')?.value).toBe(2);
    for (const id of ['beh.instant-fill', 'beh.untrusted-form-fill', 'beh.untrusted-input']) expect(h.everEmitted.has(id), id).toBe(false);
    h.stop();
  });

  it('Chrome autofill (generic trusted keydown, input, keyup) is human evidence', () => {
    const h = harness();
    const name = field('text', 'name');
    focus(h, name, 1000);
    fire(h, name, new Event('keydown', { bubbles: true }), 1001);
    name.value = 'Jane Example';
    fire(h, name, new Event('input', { bubbles: true }), 1001.1);
    fire(h, name, new Event('change', { bubbles: true }), 1001.2);
    fire(h, name, new Event('keyup', { bubbles: true }), 1001.3);
    h.clock.t = 2000;
    h.mod.evaluateNow();
    expect(h.active('beh.human-input-evidence')).toBeDefined();
    expect(h.active('beh.instant-fill')).toBeUndefined();
    h.stop();
  });

  it('1Password-marked fields are human evidence', () => {
    const h = harness();
    const el = field('email', 'email');
    el.setAttribute('data-com-onepassword-filled', 'light');
    focus(h, el, 1000);
    el.value = 'jane@example.org';
    fire(h, el, new Event('input', { bubbles: true }), 1010, false);
    h.clock.t = 2000;
    h.mod.evaluateNow();
    expect(h.active('beh.human-input-evidence')).toBeDefined();
    expect(h.active('beh.untrusted-form-fill')).toBeUndefined();
    h.stop();
  });
});

describe('untrusted input attribution', () => {
  it('a foreign-stack element.click() fires beh.untrusted-input; a site-stack one does not', () => {
    const h = harness();
    const b = button(10, 10);
    stackText = STACK_SITE;
    fire(h, b, new MouseEvent('click', { bubbles: true }), 1000, false);
    h.mod.evaluateNow();
    expect(h.everEmitted.has('beh.untrusted-input')).toBe(false);
    stackText = STACK_EXTENSION;
    fire(h, b, new MouseEvent('click', { bubbles: true }), 2000, false);
    h.mod.evaluateNow();
    const s = h.active('beh.untrusted-input');
    expect(s?.value).toBe(1);
    expect(s?.details?.['origins']).toEqual({ foreign: 1 });
    h.stop();
  });
});

// ───────────────────────── scroll & wheel ─────────────────────────

describe('scroll provenance', () => {
  it('wheel-caused bursts are not programmatic; uncaused bursts after load are', () => {
    const h = harness();
    move(h, 300, 300, 1200, { mx: 2, my: 1 });
    // Wheel-driven smooth scroll (wheel dispatched after the first scroll, earlier timeStamp).
    for (let i = 0; i < 10; i++) fire(h, document, new Event('scroll'), 3000 + i * 16);
    fire(h, document, new WheelEvent('wheel', { deltaY: 100, bubbles: true }), 2994, true, { wheelDeltaY: -120 });
    // Within 1 s of load: ignored. (loadT is the module start in this harness: t=1)
    h.clock.t = 3500;
    h.mod.evaluateNow();
    expect(h.everEmitted.has('beh.programmatic-scroll')).toBe(false);
    // scrollIntoView({behavior:'smooth'}) with no input cause.
    for (let i = 0; i < 12; i++) fire(h, document, new Event('scroll'), 6000 + i * 16);
    h.clock.t = 6100; // burst younger than 200 ms: not decided yet
    h.mod.evaluateNow();
    expect(h.everEmitted.has('beh.programmatic-scroll')).toBe(false);
    h.clock.t = 6500;
    h.mod.evaluateNow();
    expect(h.active('beh.programmatic-scroll')?.reliability).toBe(0.5);
    // Hash navigation is a cause.
    fire(h, window, new Event('hashchange'), 8000);
    fire(h, document, new Event('scroll'), 8010);
    // A second uncaused burst raises reliability.
    fire(h, document, new Event('scroll'), 9000);
    h.clock.t = 9500;
    h.mod.evaluateNow();
    expect(h.active('beh.programmatic-scroll')?.value).toBe(2);
    expect(h.active('beh.programmatic-scroll')?.reliability).toBe(1);
    h.stop();
  });
});

describe('wheel quantisation', () => {
  it('CDP mouseWheel (deltaY 300, wheelDeltaY -120) fires beh.quantised-wheel', () => {
    const h = harness();
    [1000, 2300, 2900, 4400, 5100].forEach((t) => fire(h, document, new WheelEvent('wheel', { deltaY: 300, bubbles: true }), t, true, { wheelDeltaY: -120 }));
    h.mod.evaluateNow();
    const s = h.active('beh.quantised-wheel');
    expect(s?.reliability).toBe(1);
    expect(s?.value).toBe(300);
    h.stop();
  });

  it('a Windows notched wheel (deltaY 100, wheelDeltaY 120, irregular cadence) does not', () => {
    const h = harness();
    [1000, 1090, 1230, 1300, 1520, 1610, 2400].forEach((t) => fire(h, document, new WheelEvent('wheel', { deltaY: 100, bubbles: true }), t, true, { wheelDeltaY: -120 }));
    h.mod.evaluateNow();
    expect(h.everEmitted.has('beh.quantised-wheel')).toBe(false);
    h.stop();
  });
});

// ───────────────────────── session timing ─────────────────────────

describe('think time and idle motion', () => {
  it('multi-second gaps with no pointer activity before teleport clicks fire llm-think-time and no-idle-motion', () => {
    const h = harness();
    const ts = targets();
    let t = 2000;
    let from = { x: 0, y: 0 };
    for (const [i, gap] of [5200, 7400, 6100, 9800, 4600].entries()) {
      t += gap;
      const { el, cx, cy } = ts[i]!;
      click(h, el, cx, cy, t, { overDown: 3, downUp: 0.5, from });
      from = { x: cx, y: cy };
    }
    h.clock.t = t + 1000;
    h.mod.evaluateNow();
    const think = h.active('beh.llm-think-time');
    expect(think?.value).toBe(4);
    expect(h.active('beh.no-idle-motion')).toBeDefined();
    h.stop();
  });

  it('a reader moving the mouse between clicks fires neither', () => {
    const h = harness();
    const ts = targets();
    let t = 2000;
    for (const [i, gap] of [5200, 7400, 6100, 9800, 4600].entries()) {
      for (let k = 0; k < 30; k++) move(h, 300 + k * 3, 300 + (k % 5), t + 200 + k * 120, { mx: 3, my: 1 });
      t += gap;
      const { el, cx, cy } = ts[i]!;
      for (let k = 12; k >= 1; k--) move(h, cx - k * 9 + (k % 3), cy - k * 5, t - k * 16 - 120, { mx: 9, my: 5 });
      click(h, el, cx + 7, cy - 4, t, { teleportMove: false, downUp: 96 });
    }
    h.clock.t = t + 1000;
    h.mod.evaluateNow();
    expect(h.everEmitted.has('beh.llm-think-time')).toBe(false);
    expect(h.everEmitted.has('beh.no-idle-motion')).toBe(false);
    expect(h.everEmitted.has('beh.no-pointer-path')).toBe(false);
    h.stop();
  });

  it('pauses think-time clocks while the tab is hidden', () => {
    const h = harness();
    const ts = targets();
    let t = 2000;
    for (let i = 0; i < 5; i++) {
      t += 1500;
      h.clock.t = t - 1400;
      h.setVisibility('hidden');
      h.clock.t = t - 300;
      h.setVisibility('visible');
      click(h, ts[i]!.el, ts[i]!.cx, ts[i]!.cy, t, { overDown: 3, downUp: 50 });
    }
    h.clock.t = t + 500;
    h.mod.evaluateNow();
    expect(h.everEmitted.has('beh.llm-think-time')).toBe(false);
    h.stop();
  });
});

describe('hidden-tab input', () => {
  it('two trusted events while hidden fire extension.hidden-tab-input', () => {
    const h = harness();
    h.clock.t = 1000;
    h.setVisibility('hidden');
    key(h, document.body, 'a', 'KeyA', 1050, 1060); // inside the 100 ms grace window: ignored
    expect(h.mod.evaluateNow()?.hiddenInputs).toBe(0);
    key(h, document.body, 'b', 'KeyB', 1500, 1510);
    h.mod.evaluateNow();
    expect(h.active('extension.hidden-tab-input')?.value).toBe(2);
    h.stop();
  });
});

// ───────────────────────── InteractionSummary ─────────────────────────

describe('InteractionSummary emission', () => {
  it('emits every 10 s while active, aggregates only, and on pagehide', () => {
    vi.useFakeTimers();
    const h = harness();
    const ts = targets();
    ts.slice(0, 3).forEach(({ el, cx, cy }, i) => click(h, el, cx, cy, 1000 + i * 1000));
    const input = field();
    typeText(h, input, 'abcdefgh', [5000, 5180, 5420, 5600, 5790, 6050, 6230, 6500], 90);
    h.clock.t = 9000;
    vi.advanceTimersByTime(10_000);
    const ev = h.events.filter((e) => e.type === 'interaction');
    expect(ev).toHaveLength(1);
    const data = ev[0]!.data as InteractionSummaryWithRaw;
    expect(data.pointer.clicks).toBe(3);
    expect(data.pointer.centerClickRatio).toBe(1);
    expect(data.pointer.meanMovesBeforeClick).toBe(1);
    expect(data.keyboard.keydowns).toBe(8);
    expect(data.keyboard.interKeyCv).toBeGreaterThan(0.1);
    expect(data.focus).toEqual({ hasFocus: true, visible: true });
    expect(data.raw).toBeUndefined();
    expect(JSON.stringify(data)).not.toMatch(/"x"|clientX/);
    // No activity in the next window: nothing emitted.
    vi.advanceTimersByTime(10_000);
    expect(h.events.filter((e) => e.type === 'interaction')).toHaveLength(1);
    // pagehide flushes the window.
    move(h, 10, 10, 25_000, { mx: 1, my: 1 });
    window.dispatchEvent(new Event('pagehide'));
    expect(h.events.filter((e) => e.type === 'interaction')).toHaveLength(2);
    h.stop();
  });

  it('attaches raw samples only with options.rawSamples', () => {
    const h = harness({ rawSamples: true });
    const ts = targets();
    click(h, ts[0]!.el, ts[0]!.cx, ts[0]!.cy, 1000);
    const data = h.mod.summaryNow();
    expect(data?.raw?.clicks).toHaveLength(1);
    expect(data?.raw?.clicks[0]?.slice(1, 3)).toEqual([ts[0]!.cx, ts[0]!.cy]);
    expect(h.events.filter((e) => e.type === 'interaction')).toHaveLength(1);
    h.stop();
  });
});
