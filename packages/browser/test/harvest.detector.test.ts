import { afterEach, describe, expect, it } from 'vitest';
import { SIGNAL_CATALOG, createRegistry, createSignal, type Signal, type SignalInput } from '@necterai/core';
import { createHarvestModule } from '../src/harvest/index.js';
import { burstReliability, createBurstDetector, type BurstReport, type TreeWalkReport } from '../src/harvest/detector.js';
import { isInstrumented, setStackSource, type ReadEvent } from '../src/harvest/instrument.js';
import { aggregateVerdicts, classifyStack, parseStack, providerForMarkers, type StackEnv, type StackVerdict } from '../src/harvest/stack.js';
import { createScheduler } from '../src/scheduler.js';
import type { Module, ModuleContext } from '../src/types.js';

const ENV: StackEnv = { pageOrigin: 'https://shop.example', pageUrl: 'https://shop.example/p', trustedScriptOrigins: ['https://cdn.shop-assets.example'] };

const STACKS = {
  trusted: 'Error\n    at measure (https://shop.example/static/app.js:10:5)\n    at <anonymous>:1:1',
  trustedCdn: 'Error\n    at measure (https://cdn.shop-assets.example/v2/bundle.js:1:1)',
  playwright: 'Error\n    at UtilityScript.evaluate (<anonymous>:1:44)\n    at <anonymous>:1:109',
  puppeteer: 'Error\n    at pptr:evaluate;Page.evaluate%20(file%3A%2F%2F%2Fbot.js%3A3%3A9):1:10',
  legacyPuppeteer: 'Error\n    at __puppeteer_evaluation_script__:1:10',
  anonymous: 'Error\n    at <anonymous>:1:10\n    at <anonymous>:3:5',
  thirdParty: 'Error\n    at track (https://heatmaps.example/h.js:1:1)',
  extension: 'Error\n    at read (chrome-extension://abcdefghijklmnop/content.js:4:2)',
  siteNamedUtilityScript: 'Error\n    at UtilityScript.run (https://shop.example/app.js:1:1)',
};

describe('stack classification', () => {
  it('classifies synthetic stacks', () => {
    expect(classifyStack(STACKS.trusted, ENV).cls).toBe('trusted');
    expect(classifyStack(STACKS.trustedCdn, ENV).cls).toBe('trusted');
    expect(classifyStack(STACKS.playwright, ENV)).toMatchObject({ cls: 'automation', markers: ['UtilityScript'] });
    expect(classifyStack(STACKS.puppeteer, ENV)).toMatchObject({ cls: 'automation', markers: ['pptr:'] });
    expect(classifyStack(STACKS.legacyPuppeteer, ENV)).toMatchObject({ cls: 'automation', markers: ['__puppeteer_evaluation_script__'] });
    expect(classifyStack(STACKS.anonymous, ENV).cls).toBe('anonymous');
    expect(classifyStack(STACKS.thirdParty, ENV)).toMatchObject({ cls: 'page-script', origins: ['https://heatmaps.example'] });
    expect(classifyStack(STACKS.extension, ENV).cls).toBe('extension');
    expect(classifyStack(undefined, ENV).cls).toBe('none');
    expect(classifyStack('Error', ENV).cls).toBe('none');
  });

  it('only counts markers on URL-less frames (a site class called UtilityScript is not automation)', () => {
    expect(classifyStack(STACKS.siteNamedUtilityScript, ENV).cls).toBe('trusted');
  });

  it('treats eval from a page script as that script, and drops own frames', () => {
    const evalStack = 'Error\n    at eval (eval at run (https://shop.example/app.js:1:1), <anonymous>:1:1)';
    expect(classifyStack(evalStack, ENV).cls).toBe('trusted');
    const withOwn = 'Error\n    at captureStack (https://shop.example/sdk.js:1:1)\n    at observe (https://shop.example/sdk.js:2:1)\n    at m (https://shop.example/sdk.js:3:1)\n    at <anonymous>:1:10';
    expect(classifyStack(withOwn, ENV, 3).cls).toBe('anonymous');
    expect(parseStack(withOwn)).toHaveLength(4);
  });

  it('maps markers to providers and aggregates samples with automation > trusted > anonymous', () => {
    expect(providerForMarkers(['pptr:'])?.id).toBe('puppeteer');
    expect(providerForMarkers(['UtilityScript'])?.id).toBe('playwright');
    const v = (s: string): StackVerdict => classifyStack(s, ENV);
    expect(aggregateVerdicts([v(STACKS.anonymous), v(STACKS.playwright)]).cls).toBe('automation');
    expect(aggregateVerdicts([v(STACKS.anonymous), v(STACKS.trusted)]).cls).toBe('trusted');
    expect(aggregateVerdicts([v(STACKS.anonymous), v('')]).cls).toBe('anonymous');
    expect(aggregateVerdicts([]).cls).toBe('none');
  });
});

describe('burst detector (pure)', () => {
  function setup(thresholds = {}) {
    let t = 0;
    const bursts: BurstReport[] = [];
    const walks: TreeWalkReport[] = [];
    const det = createBurstDetector({ now: () => t, onBurst: (b) => bursts.push(b), onTreeWalk: (w) => walks.push(w), thresholds });
    const cache = new Map<number, Element>();
    const el = (i: number) => {
      if (!cache.has(i)) cache.set(i, { nodeType: 1, id: i } as unknown as Element);
      return cache.get(i)!;
    };
    return {
      det,
      bursts,
      walks,
      advance: (ms: number) => (t += ms),
      read: (kind: ReadEvent['kind'], target: unknown = el(0), args: unknown[] = []) => det.record({ kind, target, args }),
      el,
    };
  }

  it('opens a burst at 300 layout reads in a window, samples the next 5 calls, classifies at flush', () => {
    const s = setup();
    let wanted = 0;
    for (let i = 0; i < 299; i++) if (s.read('rect')) wanted++;
    expect(s.det.snapshot().burstOpen).toBe(false);
    expect(s.read('rect')).toBe(true); // the crossing call is sampled
    wanted++;
    for (let i = 0; i < 10; i++) if (s.read('rect')) wanted++;
    expect(wanted).toBe(5);
    const ev = { kind: 'rect' as const, target: s.el(1), args: [] };
    for (let i = 0; i < 5; i++) s.det.onStack(ev, classifyStack(STACKS.anonymous, ENV), 'sample');
    s.det.flush(true);
    expect(s.bursts).toHaveLength(1);
    expect(s.bursts[0]).toMatchObject({ kind: 'layout', count: 310, samples: expect.any(Array) });
    expect(s.bursts[0]!.verdict.cls).toBe('anonymous');
  });

  it('does not open a burst when the reads are spread over windows', () => {
    const s = setup();
    for (let w = 0; w < 4; w++) {
      for (let i = 0; i < 200; i++) s.read('style');
      s.advance(260);
    }
    s.det.flush(true);
    expect(s.bursts).toHaveLength(0);
  });

  it('counts text reads across distinct nodes only', () => {
    const s = setup();
    for (let i = 0; i < 400; i++) s.read('textContent', s.el(i % 100));
    expect(s.det.snapshot()).toMatchObject({ text: 100, burstOpen: false });
    for (let i = 100; i < 150; i++) s.read('innerText', s.el(i));
    expect(s.det.snapshot().burstOpen).toBe(true);
  });

  it('reliability: no stack 0.6, high count or second burst 1.0', () => {
    const none: StackVerdict = { cls: 'none', markers: [], origins: [], frames: 0 };
    const base = { kind: 'layout' as const, totalReads: 300, distinctTargets: 0, windowMs: 250, samples: [], verdict: none };
    expect(burstReliability({ ...base, count: 320, burstIndex: 1 })).toBe(0.6);
    expect(burstReliability({ ...base, count: 1200, burstIndex: 1 })).toBe(1);
    expect(burstReliability({ ...base, count: 320, burstIndex: 2 })).toBe(1);
  });

  it('tree-walk rule: TreeWalker over body from non-trusted code + 100 reads, unless the user scrolls', () => {
    const s = setup();
    const body = document.body;
    expect(s.read('treeWalker', document, [body, 1])).toBe(true);
    s.det.onStack({ kind: 'treeWalker', target: document, args: [body, 1] }, classifyStack(STACKS.anonymous, ENV), 'sample');
    for (let i = 0; i < 100; i++) s.read('attr', s.el(i));
    expect(s.walks).toHaveLength(1);
    expect(s.walks[0]).toMatchObject({ trigger: 'treeWalker', reads: 100 });

    // Trusted trigger: ignored.
    s.read('qsa', document, ['*']);
    s.det.onStack({ kind: 'qsa', target: document, args: ['*'] }, classifyStack(STACKS.trusted, ENV), 'sample');
    for (let i = 0; i < 150; i++) s.read('attr', s.el(i));
    expect(s.walks).toHaveLength(1);

    // Scroll between trigger and reads: ignored.
    s.read('qsa', document, ['*']);
    s.det.onStack({ kind: 'qsa', target: document, args: ['*'] }, classifyStack(STACKS.anonymous, ENV), 'sample');
    s.advance(10);
    s.det.noteScroll();
    for (let i = 0; i < 150; i++) s.read('attr', s.el(i));
    expect(s.walks).toHaveLength(1);

    // Reads arriving after the 1 s window: ignored.
    s.read('qsa', document, ['*']);
    s.det.onStack({ kind: 'qsa', target: document, args: ['*'] }, classifyStack(STACKS.anonymous, ENV), 'sample');
    s.advance(1500);
    for (let i = 0; i < 150; i++) s.read('attr', s.el(i));
    expect(s.walks).toHaveLength(1);
  });

  it('ignores narrow selectors and subtree walkers', () => {
    const s = setup();
    expect(s.read('qsa', document, ['.price'])).toBe(false);
    const div = document.createElement('div');
    expect(s.read('treeWalker', document, [div, 1])).toBe(false);
  });
});

// ───────────────────────── module wiring (real jsdom prototypes, synthetic stacks) ─────────────────────────

interface Harness {
  signals: Signal[];
  finalized: string[];
  mod: Module;
  byId(id: string): Signal | undefined;
  stop(): void;
}

function harness(options: Record<string, unknown> = {}, trusted: string[] = []): Harness {
  const registry = createRegistry(SIGNAL_CATALOG);
  const schedule = createScheduler();
  const signals: Signal[] = [];
  const finalized: string[] = [];
  const ctx = {
    config: { trustedScriptOrigins: trusted, modules: { harvest: options } } as unknown as ModuleContext['config'],
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
    finalize(reason: string) {
      finalized.push(reason);
    },
    log() {},
    verdict: () => ({}) as ReturnType<ModuleContext['verdict']>,
  } as ModuleContext;
  const mod = createHarvestModule();
  mod.start(ctx);
  return {
    signals,
    finalized,
    mod,
    byId: (id) => [...signals].reverse().find((s) => s.id === id),
    stop() {
      mod.stop?.();
      schedule.dispose();
    },
  };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAST = { windowMs: 60, layout: 50, style: 50, text: 30, treeWalkReads: 20 };

function burst(n = 60): void {
  const el = document.createElement('div');
  document.body.appendChild(el);
  for (let i = 0; i < n; i++) el.getBoundingClientRect();
}

let current: Harness | undefined;
afterEach(() => {
  current?.stop();
  current = undefined;
  setStackSource(undefined);
  document.body.innerHTML = '';
});

describe('harvest module', () => {
  it('ignores a burst from a trusted origin (same origin as the page)', async () => {
    current = harness(FAST);
    setStackSource(() => `Error\n    at layout (${location.origin}/static/app.js:1:1)`, 0);
    burst();
    await tick(140);
    expect(current.signals).toEqual([]);
  });

  it('ignores a burst from a configured trusted script origin', async () => {
    current = harness(FAST, ['https://cdn.trusted.example']);
    setStackSource(() => 'Error\n    at layout (https://cdn.trusted.example/lib.js:1:1)', 0);
    burst();
    await tick(140);
    expect(current.signals).toEqual([]);
  });

  it('automation marker in the sampled stack -> probe.automation-stack-frame (deterministic, finalised)', async () => {
    current = harness(FAST);
    setStackSource(() => STACKS.playwright, 0);
    burst();
    await tick(140);
    const s = current.byId('probe.automation-stack-frame');
    expect(s).toBeDefined();
    expect(s!.provider?.id).toBe('playwright');
    expect(s!.value).toEqual(['UtilityScript']);
    expect(current.finalized).toContain('automation-stack-frame');
    expect(current.byId('harvest.dom-read-burst')).toBeUndefined();
  });

  it('anonymous-only frames -> harvest.foreign-evaluate', async () => {
    current = harness(FAST);
    setStackSource(() => STACKS.anonymous, 0);
    burst();
    await tick(140);
    const s = current.byId('harvest.foreign-evaluate');
    expect(s).toBeDefined();
    expect(s!.summary).toMatch(/getBoundingClientRect.*anonymous evaluated code/);
    expect(s!.details).toMatchObject({ kind: 'layout', stackClass: 'anonymous' });
  });

  it('no stack at all -> harvest.dom-read-burst with reliability 0.6', async () => {
    current = harness(FAST);
    setStackSource(() => undefined, 0);
    burst();
    await tick(140);
    const s = current.byId('harvest.dom-read-burst');
    expect(s).toBeDefined();
    expect(s!.reliability).toBe(0.6);
    expect(s!.details).toMatchObject({ stackClass: 'none' });
  });

  it('third-party script burst is reported at low reliability with its origin', async () => {
    current = harness(FAST);
    setStackSource(() => STACKS.thirdParty, 0);
    burst();
    await tick(140);
    const s = current.byId('harvest.dom-read-burst');
    expect(s?.reliability).toBe(0.3);
    expect(s?.summary).toContain('https://heatmaps.example');
  });

  it('tree walk from anonymous code followed by attribute reads -> harvest.accessibility-tree-walk', async () => {
    current = harness(FAST);
    setStackSource(() => STACKS.anonymous, 0);
    document.body.innerHTML = Array.from({ length: 30 }, (_, i) => `<button aria-label="b${i}" role="button">x</button>`).join('');
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let n: Node | null;
    while ((n = walker.nextNode())) {
      (n as Element).getAttribute('role');
      (n as Element).getAttribute('aria-label');
    }
    await tick(20);
    const s = current.byId('harvest.accessibility-tree-walk');
    expect(s).toBeDefined();
    expect(s!.details).toMatchObject({ trigger: 'treeWalker', stackClass: 'anonymous' });
  });

  it('stop() releases the instrumentation and restores prototypes', () => {
    const original = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect')!.value;
    current = harness(FAST);
    expect(isInstrumented()).toBe(true);
    expect(Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect')!.value).not.toBe(original);
    current.stop();
    current = undefined;
    expect(isInstrumented()).toBe(false);
    expect(Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect')!.value).toBe(original);
  });
});
