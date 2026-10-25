import { afterEach, describe, expect, it } from 'vitest';
import { SIGNAL_CATALOG, createRegistry, createSignal, type Signal, type SignalInput } from '@necterai/core';
import { createProbesModule, startStackMarkerProbe, type ProbesModuleDeps, type StackMarkerHit } from '../src/probes/index.js';
import type { ConsoleLike } from '../src/probes/cdp-leak.js';
import type { RealmValues, TamperTarget } from '../src/probes/tamper.js';
import { isInstrumented, setStackSource } from '../src/harvest/instrument.js';
import { createScheduler } from '../src/scheduler.js';
import type { Module, ModuleContext } from '../src/types.js';

interface Harness {
  signals: Signal[];
  mod: Module;
  registry: ReturnType<typeof createRegistry>;
  byId(id: string): Signal | undefined;
  stop(): void;
}

const quietConsole: ConsoleLike = { debug() {}, groupEnd() {} };
/** Inspector simulation: what V8 does with Runtime enabled (see probes.units.test.ts). */
const cdpConsole: ConsoleLike = {
  debug(v: unknown) {
    if (!(v instanceof Error)) return;
    void v.name;
    void v.name;
    void v.message;
    void v.name;
    void v.stack;
  },
};

const SAFE_DEPS: ProbesModuleDeps = {
  console: quietConsole,
  isV8: () => true,
  consoleCheck: () => true,
  measureDebuggerPause: () => 0,
  tamperTargets: () => [],
  openFreshRealm: () => undefined,
  random: () => 1,
};

function harness(deps: ProbesModuleDeps = {}, options: Record<string, unknown> = {}): Harness {
  const registry = createRegistry(SIGNAL_CATALOG);
  const schedule = createScheduler();
  const signals: Signal[] = [];
  const ctx = {
    config: { trustedScriptOrigins: [], modules: { probes: options } } as unknown as ModuleContext['config'],
    session: { id: 's1', firstVisit: true, startedAt: Date.now(), pageViews: 1 },
    registry,
    schedule,
    options,
    now: () => Date.now(),
    emit(input: SignalInput) {
      const s = createSignal(input, registry, { source: 'client' });
      signals.push(s);
      return s;
    },
    retract() {},
    event() {},
    requestEvaluate() {},
    finalize() {},
    log() {},
    verdict: () => ({ evidence: [] }) as unknown as ReturnType<ModuleContext['verdict']>,
  } as ModuleContext;
  const mod = createProbesModule({ ...SAFE_DEPS, ...deps });
  mod.start(ctx);
  return {
    signals,
    mod,
    registry,
    byId: (id) => [...signals].reverse().find((s) => s.id === id),
    stop() {
      mod.stop?.();
      schedule.dispose();
    },
  };
}

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const w = window as unknown as Record<string, unknown>;
const cleanupGlobals: string[] = [];
function setGlobal(name: string, value: unknown, enumerable = true): void {
  Object.defineProperty(window, name, { value, enumerable, configurable: true, writable: true });
  cleanupGlobals.push(name);
}

function setGeometry(innerHeight: number, innerWidth = 1728, outerHeight = 1006): void {
  Object.defineProperty(window, 'innerHeight', { value: innerHeight, configurable: true });
  Object.defineProperty(window, 'innerWidth', { value: innerWidth, configurable: true });
  Object.defineProperty(window, 'outerHeight', { value: outerHeight, configurable: true });
  Object.defineProperty(window, 'outerWidth', { value: innerWidth, configurable: true });
}

let current: Harness | undefined;
afterEach(() => {
  current?.stop();
  current = undefined;
  setStackSource(undefined);
  for (const n of cleanupGlobals.splice(0)) delete w[n];
  for (const k of ['innerHeight', 'innerWidth', 'outerHeight', 'outerWidth']) delete w[k];
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('webdriver');
});

describe('probes module wiring', () => {
  it('is named "probes", registers its definitions and emits nothing on a clean jsdom page', async () => {
    current = harness();
    expect(current.mod.name).toBe('probes');
    expect(current.registry.get('probe.cdp-binding-residue')?.layer).toBe('probe');
    document.body.innerHTML = '<main><h1 class="title">Hello</h1><button id="buy">Buy</button></main>';
    document.body.querySelector('h1')!.getBoundingClientRect();
    await tick(120);
    expect(current.signals.map((s) => s.id)).toEqual([]);
  });

  it('reports residue present at start (chromedriver) and residue added later (Playwright binding)', async () => {
    setGlobal('cdc_adoQpoasnfa76pfcZLmcfl_Array', Array);
    document.documentElement.setAttribute('webdriver', 'true');
    current = harness();
    const sel = current.byId('probe.selenium-artifact');
    expect(sel?.value).toEqual(['cdc_adoQpoasnfa76pfcZLmcfl_Array', '<html webdriver>']);
    setGlobal('__playwright__binding__', Proxy.revocable({}, {}).revoke);
    await tick(150); // idle tick (jsdom: no requestIdleCallback -> 50 ms timeout)
    const pw = current.byId('probe.playwright-artifact');
    expect(pw?.value).toEqual(['__playwright__binding__']);
    expect(pw?.provider?.id).toBe('playwright');
  });

  it('reports an anonymous Runtime.addBinding function with an unknown name', async () => {
    current = harness();
    setGlobal('xq_7f3a', Proxy.revocable({}, {}).revoke);
    await tick(150);
    expect(current.byId('probe.cdp-binding-residue')?.value).toEqual(['xq_7f3a']);
  });

  it('weak observations of deterministic ids are emitted below the deterministic threshold', async () => {
    setGlobal('__dvdAnimationRunning', true); // rule reliability 0.7 -> 8 x 0.7 = 5.6
    current = harness();
    const s = current.byId('probe.agent-framework-artifact')!;
    expect(s.automation).toBeCloseTo(5.6);
    expect(s.reliability).toBeUndefined();
    expect(s.details?.reliability).toBe(0.7);
  });

  it('Runtime.enable leak -> probe.cdp-runtime-leak when debugger; does not block', () => {
    current = harness({ console: cdpConsole, measureDebuggerPause: () => 0 });
    const s = current.byId('probe.cdp-runtime-leak');
    expect(s).toBeDefined();
    expect(s!.summary).toMatch(/prepareStackTrace x1, name getter x\d/);
    expect(current.byId('probe.devtools-open')).toBeUndefined();
  });

  it('Runtime.enable leak with a blocking debugger; -> probe.devtools-open only', () => {
    let pauses = 0;
    current = harness({ console: cdpConsole, measureDebuggerPause: () => (pauses++, 507) });
    expect(current.byId('probe.cdp-runtime-leak')).toBeUndefined();
    const s = current.byId('probe.devtools-open');
    expect(s?.summary).toContain('507 ms');
    expect(pauses).toBe(1);
  });

  it('does not probe through a wrapped console or on non-V8 engines', () => {
    current = harness({ console: cdpConsole, consoleCheck: () => false });
    expect(current.signals).toEqual([]);
    current.stop();
    current = harness({ console: cdpConsole, isV8: () => false });
    expect(current.signals).toEqual([]);
  });

  it('debugger infobar: measured resize burst -> probe.debugger-attached, mirror after 5 s noted as detach', async () => {
    setGeometry(919);
    current = harness();
    for (const h of [908, 904, 900, 896, 892, 888, 885, 881, 877, 873, 869, 865, 863]) {
      setGeometry(h);
      window.dispatchEvent(new Event('resize'));
    }
    await tick(160);
    const s = current.byId('probe.debugger-attached');
    expect(s).toBeDefined();
    expect(s!.summary).toMatch(/innerHeight 919 -> 863 \(-56 px/);
    expect(s!.details).toMatchObject({ kind: 'appeared', innerWidth: 1728, outerHeight: 1006 });
    for (const h of [865, 869, 873, 877, 881, 885, 888, 892, 896, 900, 904, 908, 919]) {
      setGeometry(h);
      window.dispatchEvent(new Event('resize'));
    }
    await tick(160);
    const closed = current.byId('probe.debugger-attached')!;
    expect(closed.details?.closed).toMatchObject({ kind: 'closed', deltaTotal: 56 });
  });

  it('agent DOM artifacts are picked up by the MutationObserver', async () => {
    current = harness();
    const overlay = document.createElement('div');
    overlay.id = 'playwright-highlight-container';
    document.body.appendChild(overlay);
    for (let i = 1; i <= 3; i++) {
      const b = document.createElement('button');
      document.body.appendChild(b);
      b.setAttribute('data-cursor-ref', `e${i}`);
    }
    await tick(20);
    expect(current.byId('probe.agent-framework-artifact')?.value).toEqual(['#playwright-highlight-container']);
    const cursor = current.byId('probe.main-world-agent-global')!;
    expect(cursor.provider?.id).toBe('cursor');
    expect(cursor.reliability).toBeUndefined();
  });

  it('stack markers through the shared instrumentation -> probe.automation-stack-frame', () => {
    current = harness();
    setStackSource(() => 'Error\n    at pptr:evaluate;Page.evaluate:1:10', 0);
    document.body.innerHTML = '<p>x</p>';
    void document.body.firstElementChild!.textContent;
    const s = current.byId('probe.automation-stack-frame');
    expect(s?.provider?.id).toBe('puppeteer');
    expect(s?.summary).toContain('Node.textContent called from an automation evaluation frame (pptr:)');
  });

  it('tamper and fresh-realm checks run at idle', async () => {
    class FakeNav {}
    Object.defineProperty(FakeNav.prototype, 'webdriver', { get: () => false, configurable: true });
    Object.defineProperty(FakeNav.prototype, 'plugins', { get: () => [], configurable: true });
    const nav = new FakeNav();
    const targets: TamperTarget[] = [
      { label: 'navigator.webdriver', instance: nav, proto: FakeNav.prototype, property: 'webdriver', kind: 'getter' },
      { label: 'navigator.plugins', instance: nav, proto: FakeNav.prototype, property: 'plugins', kind: 'getter' },
    ];
    const main: RealmValues = { webdriver: false, platform: 'Win32', hardwareConcurrency: 8, languages: 'en-US', userAgent: 'UA', pluginsLength: 5 };
    current = harness({
      tamperTargets: () => targets,
      openFreshRealm: () => ({ values: { ...main, webdriver: true, platform: 'Linux x86_64' }, toString: undefined, windowIsParent: false }),
      readMainRealm: () => main,
    });
    await tick(120);
    const t = current.byId('probe.prototype-tampered');
    expect(t?.value).toEqual(['navigator.webdriver', 'navigator.plugins']);
    expect(t?.summary).toMatch(/^2 native APIs replaced/);
    const f = current.byId('probe.fresh-realm-mismatch');
    expect(f?.value).toEqual(['webdriver', 'platform']);
    expect(f?.summary).toContain('webdriver false vs true');
  });

  it('stop() removes listeners/observers/timers and restores prototypes', async () => {
    const original = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent')!.get;
    setGeometry(919);
    current = harness();
    expect(isInstrumented()).toBe(true);
    current.stop();
    const h = current;
    current = undefined;
    expect(isInstrumented()).toBe(false);
    expect(Object.getOwnPropertyDescriptor(Node.prototype, 'textContent')!.get).toBe(original);
    const overlay = document.createElement('div');
    overlay.id = 'playwright-highlight-container';
    document.body.appendChild(overlay);
    setGlobal('__playwright__binding__', Proxy.revocable({}, {}).revoke);
    for (const x of [908, 904, 900, 896, 892, 888, 885, 881, 877, 873, 869, 865, 863]) {
      setGeometry(x);
      window.dispatchEvent(new Event('resize'));
    }
    await tick(200);
    expect(h.signals).toEqual([]);
  });

  it('module options switch probes off', () => {
    setGlobal('cdc_adoQpoasnfa76pfcZLmcfl_Array', Array);
    current = harness({ console: cdpConsole }, { globals: false, leak: false, stackMarkers: false });
    expect(current.signals).toEqual([]);
    expect(isInstrumented()).toBe(false);
  });
});

describe('stack-marker sampler', () => {
  it('samples thresholds within the first 200 calls per second and stops after the first hit', () => {
    const hits: StackMarkerHit[] = [];
    let t = 0;
    let stack: string | undefined = 'Error\n    at <anonymous>:1:10';
    setStackSource(() => stack, 0);
    const probe = startStackMarkerProbe({ onHit: (h) => hits.push(h), random: () => 1, now: () => t });
    const el = document.createElement('div');
    for (let i = 0; i < 300; i++) el.getBoundingClientRect();
    expect(probe.samples).toBe(10); // 1,2,3,5,10,20,50,100,150,200
    expect(hits).toEqual([]); // anonymous frames are harvest's business, not a marker
    t = 1500;
    stack = 'Error\n    at UtilityScript.evaluate (<anonymous>:1:44)';
    el.getBoundingClientRect();
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ target: 'rect', markers: ['UtilityScript'], provider: { id: 'playwright' } });
    el.getBoundingClientRect();
    el.getBoundingClientRect();
    expect(probe.samples).toBe(11);
    probe.stop();
    expect(isInstrumented()).toBe(false);
  });
});
