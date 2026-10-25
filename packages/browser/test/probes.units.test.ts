import { SIGNAL_CATALOG } from '@necterai/core';
import { afterEach, describe, expect, it } from 'vitest';
import { consoleIsNative, isV8, judgeLeak, runLeakProbe, type ConsoleLike } from '../src/probes/cdp-leak.js';
import { checkViewportOverride, zoomExplains, type GeometrySnapshot } from '../src/probes/geometry.js';
import { createGlobalsReportState, globalsToSignals, isBindingResidue, scanGlobals, snapshotGlobals } from '../src/probes/globals.js';
import { ResizeBurstDetector, type ResizeSample } from '../src/probes/infobar.js';
import { matchKnownGlobal } from '../src/probes/known-globals.js';
import { DomArtifactAggregator, classifyElement, matchesFromMutations, sweepDocument } from '../src/probes/dom-artifacts.js';
import { checkFunctionShape, checkTarget, checkToStringIntegrity, diffRealms, openFreshRealm, readRealmValues, type RealmValues } from '../src/probes/tamper.js';
import { definitions } from '../src/probes/definitions.js';

afterEach(() => {
  document.body.innerHTML = '';
});

// ───────────────────────── residue globals ─────────────────────────

/** A real native anonymous function whose [[Prototype]] is Function.prototype (same shape as a Runtime.addBinding function). */
function nativeAnonymous(): () => void {
  return Proxy.revocable({}, {}).revoke;
}

function fakeWindow(extra: Record<string, PropertyDescriptor> = {}): Record<string, unknown> {
  const w: Record<string, unknown> = {};
  Object.defineProperty(w, 'location', { value: {}, enumerable: true });
  Object.defineProperty(w, 'Array', { value: Array, enumerable: false });
  for (const [k, d] of Object.entries(extra)) Object.defineProperty(w, k, { configurable: true, ...d });
  return w;
}

describe('residue globals', () => {
  it('matches chromedriver, Playwright, Puppeteer, agent and legacy names', () => {
    expect(matchKnownGlobal('cdc_adoQpoasnfa76pfcZLmcfl_Array', 'window')?.rule.signal).toBe('probe.selenium-artifact');
    expect(matchKnownGlobal('abc_adoQpoasnfa76pfcZLmcfl_Promise', 'window')?.rule.provider?.product).toBe('undetected-chromedriver');
    expect(matchKnownGlobal('__playwright__binding__', 'window')?.rule.signal).toBe('probe.playwright-artifact');
    expect(matchKnownGlobal('__pwInitScripts', 'window')?.rule.signal).toBe('probe.playwright-artifact');
    expect(matchKnownGlobal('puppeteer_exposed', 'window')?.rule.signal).toBe('probe.puppeteer-artifact');
    expect(matchKnownGlobal('__browserUseClipboard_0123abcd', 'window')?.rule.signal).toBe('probe.main-world-agent-global');
    expect(matchKnownGlobal('__cursorBrowserAutomationInjected', 'window')?.rule.signal).toBe('probe.main-world-agent-global');
    expect(matchKnownGlobal('__PW_CURSOR_VIS__', 'window')?.rule.provider?.id).toBe('skyvern');
    expect(matchKnownGlobal('callPhantom', 'window')?.rule.signal).toBe('probe.legacy-automation-artifact');
    expect(matchKnownGlobal('$cdc_asdjflasutopfhvcZLmcfl_', 'document')?.rule.signal).toBe('probe.selenium-artifact');
    expect(matchKnownGlobal('__codexNativeWebMcpState', 'document')?.rule.signal).toBe('probe.main-world-agent-global');
    expect(matchKnownGlobal('$cdc_asdjflasutopfhvcZLmcf', 'document')?.rule.signal).toBe('probe.selenium-artifact');
    expect(matchKnownGlobal('cdc_metrics', 'window')).toBeUndefined(); // ordinary naming (cdc.gov)
    expect(matchKnownGlobal('dataLayer', 'window')).toBeUndefined();
    expect(matchKnownGlobal('jQuery', 'window')).toBeUndefined();
  });

  it('recognises the Runtime.addBinding shape but not Function.prototype or page functions', () => {
    const w = fakeWindow({
      __binding: { value: nativeAnonymous(), enumerable: true, writable: true },
      noop: { value: Function.prototype, enumerable: true, writable: true },
      pageFn: { value: function () {}, enumerable: true, writable: true },
      hidden: { value: nativeAnonymous(), enumerable: false, writable: true },
    });
    expect(isBindingResidue(w, '__binding')).toBe(true);
    expect(isBindingResidue(w, 'noop')).toBe(false);
    expect(isBindingResidue(w, 'pageFn')).toBe(false);
    expect(isBindingResidue(w, 'hidden')).toBe(false);
  });

  it('scans baseline on the first pass, only new names afterwards, and reports cumulatively', () => {
    const w = fakeWindow({ cdc_adoQpoasnfa76pfcZLmcfl_Array: { value: Array, enumerable: true, writable: true } });
    const doc = { documentElement: document.createElement('html') } as unknown as Record<string, unknown> & { documentElement: Element };
    doc.documentElement.setAttribute('webdriver', '');
    const baseline = snapshotGlobals(w);
    const state = createGlobalsReportState();
    const first = globalsToSignals(scanGlobals({ win: w, doc }, baseline, { matchBaseline: true }), state);
    const sel = first.find((s) => s.id === 'probe.selenium-artifact')!;
    expect(sel.value).toEqual(['cdc_adoQpoasnfa76pfcZLmcfl_Array', '<html webdriver>']);
    expect(sel.summary).toMatch(/^2 automation residue artifacts in the page: cdc_adoQpoasnfa76pfcZLmcfl_Array/);
    expect(sel.provider?.id).toBe('selenium');

    // Nothing new: nothing re-emitted.
    expect(globalsToSignals(scanGlobals({ win: w, doc }, baseline), state)).toEqual([]);

    Object.defineProperty(w, 'cdc_adoQpoasnfa76pfcZLmcfl_Promise', { value: Promise, enumerable: true, configurable: true });
    Object.defineProperty(w, '__pb', { value: nativeAnonymous(), enumerable: true, configurable: true, writable: true });
    const later = globalsToSignals(scanGlobals({ win: w, doc }, baseline), state);
    expect(later.find((s) => s.id === 'probe.selenium-artifact')!.value).toEqual(['cdc_adoQpoasnfa76pfcZLmcfl_Array', '<html webdriver>', 'cdc_adoQpoasnfa76pfcZLmcfl_Promise']);
    expect(later.find((s) => s.id === 'probe.cdp-binding-residue')!.value).toEqual(['__pb']);
  });

  it('detects Puppeteer/Playwright exposeFunction wrappers by source', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const pptr = function (...args: unknown[]) { /* This is the Puppeteer binding */ return args; };
    const w = fakeWindow({ myExposed: { value: pptr, enumerable: true, writable: true } });
    const out = globalsToSignals(scanGlobals({ win: w }, new Set(), { matchBaseline: true }), createGlobalsReportState());
    expect(out[0]).toMatchObject({ id: 'probe.puppeteer-artifact', value: ['myExposed'] });
  });

  it('new ids are documented definitions in the probe layer', () => {
    // The browser registers the description-free lite entries; the prose lives in the core catalog.
    expect(definitions.length).toBe(3);
    for (const d of definitions) {
      expect(d.id.startsWith('probe.')).toBe(true);
      expect(d.layer).toBe('probe');
      expect(SIGNAL_CATALOG.find((c) => c.id === d.id)?.description.length).toBeGreaterThan(20);
    }
  });
});

// ───────────────────────── Runtime.enable leak ─────────────────────────

/** Simulates what V8's inspector does when a CDP client has Runtime enabled (Chrome >= 138). */
function inspectorConsole(enabled: boolean): ConsoleLike {
  return {
    debug(v: unknown) {
      if (!(v instanceof Error)) return;
      void v.name; // Error.prototype.toString for the message text (baseline, always)
      if (!enabled) return;
      void v.name;
      void v.message;
      void v.name;
      void v.stack; // builtin accessor -> prepareStackTrace
    },
    groupEnd() {},
  };
}

describe('Runtime.enable console leak', () => {
  it('runs on V8 (Node) and is quiet without a client', () => {
    expect(isV8()).toBe(true);
    const r = runLeakProbe({ console: inspectorConsole(false) });
    expect(judgeLeak(r)).toEqual({ leaked: false, channels: [], reliability: 0 });
    expect(r.nameReads).toBe(1);
  });

  it('fires the modern channels with a simulated inspector', () => {
    const r = runLeakProbe({ console: inspectorConsole(true) });
    expect(r.prepareStackTrace).toBe(1);
    expect(r.nameReads).toBeGreaterThanOrEqual(3); // + the header read when V8 formats the stack
    expect(r.messageReads).toBeGreaterThanOrEqual(2);
    const v = judgeLeak(r);
    expect(v.leaked).toBe(true);
    expect(v.reliability).toBe(1);
    expect(v.channels[0]).toBe('prepareStackTrace x1');
  });

  it('restores Error.prepareStackTrace and ignores reads outside its console call', () => {
    const before = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
    let leaked: Error | undefined;
    runLeakProbe({ console: { debug: (v: unknown) => void (leaked = v as Error) } });
    expect(Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace')).toEqual(before);
    void leaked?.name; // read later by "the page": not counted
  });

  it('legacy-only hits are discounted', () => {
    expect(judgeLeak({ prepareStackTrace: 0, nameReads: 1, messageReads: 1, legacyStackReads: 1, legacyGetterReads: 0, legacyProxyOwnKeys: 0 })).toMatchObject({ leaked: true, reliability: 0.5 });
  });

  it('only trusts a native console.debug', () => {
    expect(consoleIsNative({ debug: Math.max })).toBe(true);
    expect(consoleIsNative({ debug: (...a: unknown[]) => a })).toBe(false);
  });
});

// ───────────────────────── debugger infobar ─────────────────────────

/** Measured on Chrome 155 / macOS (extension-agents.md §3.2). */
const MEASURED_T = [0, 8, 16, 25, 33, 41, 45, 53, 61, 70, 78, 86, 94];
const MEASURED_H = [908, 904, 900, 896, 892, 888, 885, 881, 877, 873, 869, 865, 863];
const at = (t: number, innerHeight: number, innerWidth = 1728, outerHeight = 1006): ResizeSample => ({ t, innerHeight, innerWidth, outerHeight });

function play(d: ResizeBurstDetector, t0: number, hs: number[], ts = MEASURED_T, w = 1728, oh = 1006) {
  hs.forEach((h, i) => d.push(at(t0 + ts[i]!, h, w, oh)));
  return d.settle();
}

describe('debugger infobar burst', () => {
  it('detects the measured appear sequence (919 -> 863, -56 px)', () => {
    const d = new ResizeBurstDetector();
    d.prime(at(0, 919));
    const r = play(d, 1000, MEASURED_H);
    expect(r).toMatchObject({ kind: 'appeared', steps: 13, deltaTotal: -56, fromHeight: 919, toHeight: 863, innerWidth: 1728, outerHeight: 1006 });
    expect(r!.durationMs).toBe(94);
  });

  it('detects the mirror image as closed', () => {
    const d = new ResizeBurstDetector();
    d.prime(at(0, 863));
    const up = [...MEASURED_H].reverse().slice(1).concat([908, 919]);
    const r = play(d, 6000, up);
    expect(r?.kind).toBe('closed');
    expect(r?.deltaTotal).toBe(56);
  });

  it('ignores a user drag (both axes, large steps), a DevTools dock (one jump) and outerHeight changes', () => {
    const drag = new ResizeBurstDetector();
    drag.prime(at(0, 900, 1400));
    for (let i = 1; i <= 12; i++) drag.push(at(i * 8, 900 - i * 4, 1400 - i * 7));
    expect(drag.settle()).toBeUndefined();

    const dock = new ResizeBurstDetector();
    dock.prime(at(0, 900));
    dock.push(at(10, 600));
    expect(dock.settle()).toBeUndefined();

    const win = new ResizeBurstDetector();
    win.prime(at(0, 900, 1400, 1000));
    for (let i = 1; i <= 12; i++) win.push(at(i * 8, 900 - i * 4, 1400, 1000 - i * 4));
    expect(win.settle()).toBeUndefined();
  });

  it('needs at least 8 steps within the window and a 40-60 px total', () => {
    const few = new ResizeBurstDetector();
    few.prime(at(0, 919));
    expect(play(few, 100, [915, 911, 907, 903, 899], [0, 8, 16, 24, 32])).toBeUndefined();

    const slow = new ResizeBurstDetector();
    slow.prime(at(0, 919));
    const ts = MEASURED_H.map((_, i) => i * 60); // 13 steps over 720 ms: outside the 200 ms window
    expect(play(slow, 100, MEASURED_H, ts)).toBeUndefined();

    const big = new ResizeBurstDetector();
    big.prime(at(0, 919));
    expect(play(big, 100, MEASURED_H.map((h) => h - 30))).toBeUndefined();
  });
});

// ───────────────────────── geometry ─────────────────────────

const geo = (g: Partial<GeometrySnapshot>): GeometrySnapshot => ({
  innerWidth: 1440,
  innerHeight: 800,
  outerWidth: 1440,
  outerHeight: 900,
  screenWidth: 1440,
  screenHeight: 900,
  devicePixelRatio: 2,
  fullscreen: false,
  ...g,
});

describe('impossible geometry', () => {
  it('flags device-metrics overrides over the headless window', () => {
    const pw = checkViewportOverride(geo({ innerWidth: 1280, innerHeight: 720, outerWidth: 756, outerHeight: 556, screenWidth: 800, screenHeight: 600, devicePixelRatio: 1 }));
    expect(pw?.id).toBe('probe.viewport-override');
    expect(pw?.reliability).toBeUndefined();
    expect(pw?.summary).toContain('inner 1280x720 > outer 756x556');
    const pptr = checkViewportOverride(geo({ innerWidth: 800, innerHeight: 600, outerWidth: 756, outerHeight: 556, screenWidth: 800, screenHeight: 600, devicePixelRatio: 1 }));
    expect(pptr?.reliability).toBeUndefined();
  });

  it('flags --window-size beyond the 800x600 headless screen (hard at >= 2x)', () => {
    expect(checkViewportOverride(geo({ innerWidth: 1920, innerHeight: 993, outerWidth: 1920, outerHeight: 1080, screenWidth: 800, screenHeight: 600, devicePixelRatio: 1 }))?.reliability).toBeUndefined();
    expect(checkViewportOverride(geo({ innerWidth: 1700, innerHeight: 1000, outerWidth: 1700, outerHeight: 1080, screenWidth: 1440, screenHeight: 900, devicePixelRatio: 1 }))?.reliability).toBe(0.6);
  });

  it('discounts browser zoom and skips normal, fullscreen and zero-size windows', () => {
    // 50 % zoom on a 2x display: dpr 1, inner = 2 x outer.
    const zoomed = geo({ innerWidth: 2880, innerHeight: 1640, outerWidth: 1440, outerHeight: 900, devicePixelRatio: 1 });
    expect(zoomExplains(zoomed)).toBe(true);
    expect(checkViewportOverride(zoomed)?.reliability).toBe(0.5);
    expect(checkViewportOverride(geo({}))).toBeUndefined();
    expect(checkViewportOverride(geo({ innerWidth: 2000, outerWidth: 1000, fullscreen: true }))).toBeUndefined();
    expect(checkViewportOverride(geo({ outerWidth: 0, outerHeight: 0 }))).toBeUndefined();
  });
});

// ───────────────────────── DOM artifacts ─────────────────────────

describe('agent-framework DOM artifacts', () => {
  it('classifies ids, classes, tags and stamped attributes', () => {
    const el = (html: string) => {
      document.body.innerHTML = html;
      return document.body.firstElementChild!;
    };
    expect(classifyElement(el('<div id="playwright-highlight-container"></div>'))).toMatchObject({ signal: 'probe.agent-framework-artifact', artifact: '#playwright-highlight-container' });
    expect(classifyElement(el('<div class="playwright-highlight-label"></div>'))?.artifact).toBe('.playwright-highlight-label');
    expect(classifyElement(el('<x-pw-glass></x-pw-glass>'))).toMatchObject({ signal: 'probe.playwright-artifact' });
    expect(classifyElement(el('<div id="codex-agent-overlay-root"></div>'))?.signal).toBe('probe.main-world-agent-global');
    expect(classifyElement(el('<button data-cursor-ref="e12"></button>'))).toMatchObject({ signal: 'probe.main-world-agent-global', artifact: '[data-cursor-ref]' });
    expect(classifyElement(el('<button data-cursor-ref="nope"></button>'))).toBeUndefined();
    expect(classifyElement(el('<a unique_id="aB3x"></a>'))?.provider?.id).toBe('skyvern');
    expect(classifyElement(el('<div class="hero playwright-docs"></div>'))).toBeUndefined(); // not overlay-shaped
    expect(classifyElement(el('<div id="app"></div>'))).toBeUndefined();
  });

  it('keyword-only overlays stay below deterministic until a specific artifact corroborates', () => {
    const agg = new DomArtifactAggregator();
    document.body.innerHTML = '<div class="stagehand-cursor" style="position:fixed;z-index:99999"></div><div class="stagehand-label" style="position:fixed;z-index:99999"></div>';
    const [a, b] = Array.from(document.body.children).map((c) => classifyElement(c)!);
    expect(a!.reliability).toBe(0.5);
    expect(agg.add(a!)?.reliability).toBe(0.5);
    expect(agg.add(b!)?.reliability).toBe(0.5); // two keyword hits are not enough
    const specific = classifyElement(Object.assign(document.createElement('div'), { id: 'browser-use-demo-panel' }))!;
    expect(specific.signal).toBe('probe.agent-framework-artifact');
    expect(agg.add(specific)?.reliability).toBeUndefined(); // corroborated -> full weight
  });

  it('attribute stamping counts fully only from three elements', () => {
    const agg = new DomArtifactAggregator();
    document.body.innerHTML = '<b data-cursor-ref="e1"></b><b data-cursor-ref="e2"></b><b data-cursor-ref="e3"></b>';
    const ms = sweepDocument(document);
    expect(ms).toHaveLength(3);
    expect(agg.add(ms[0]!)?.reliability).toBe(0.5);
    expect(agg.add(ms[1]!)?.reliability).toBe(0.75);
    const third = agg.add(ms[2]!)!;
    expect(third.reliability).toBeUndefined();
    expect(third.summary).toContain('3 elements stamped');
  });

  it('extracts matches from mutation records, pre-filtering class churn', () => {
    const container = document.createElement('div');
    container.innerHTML = '<span class="playwright-highlight-label"></span>';
    const plain = document.createElement('p');
    const records = [
      { type: 'childList', addedNodes: [container, document.createTextNode('x')], target: document.body },
      { type: 'attributes', attributeName: 'class', target: plain },
      { type: 'attributes', attributeName: '__elementId', target: Object.assign(document.createElement('i'), {}) },
    ] as unknown as MutationRecord[];
    (records[2]!.target as Element).setAttribute('__elementId', '17');
    plain.className = 'btn active';
    const out = matchesFromMutations(records);
    expect(out.map((m) => m.artifact)).toEqual(['.playwright-highlight-label', '[__elementId]']);
  });
});

// ───────────────────────── tamper / fresh realm ─────────────────────────

describe('tamper detection', () => {
  const sizeGetter = Object.getOwnPropertyDescriptor(Map.prototype, 'size')!.get!;

  it('passes untouched native getters (Map.prototype.size as a stand-in)', () => {
    expect(checkTarget({ label: 'Map.size', instance: new Map(), proto: Map.prototype, property: 'size', kind: 'getter' })).toEqual([]);
    expect(checkFunctionShape(Array.prototype.map, 'map', Function.prototype.toString as (this: unknown) => string)).toEqual([]);
  });

  it('catches JS replacements, instance overrides, proxies and missing descriptors', () => {
    class FakeNav {}
    Object.defineProperty(FakeNav.prototype, 'webdriver', { get: () => false, configurable: true });
    const nav = new FakeNav();
    expect(checkTarget({ label: 'navigator.webdriver', instance: nav, proto: FakeNav.prototype, property: 'webdriver', kind: 'getter' })[0]?.tell).toBe('non-native-source');

    const inst = new Map();
    Object.defineProperty(inst, 'size', { value: 3 });
    expect(checkTarget({ label: 'Map.size', instance: inst, proto: Map.prototype, property: 'size', kind: 'getter' }).map((f) => f.tell)).toContain('own-on-instance');

    const proxied = new Proxy(sizeGetter, {});
    expect(checkFunctionShape(proxied, 'proxied', Function.prototype.toString as (this: unknown) => string).map((f) => f.tell)).toContain('proxy-anonymous-native');

    class Empty {}
    expect(checkTarget({ label: 'x', proto: Empty.prototype, property: 'missing', kind: 'getter' })[0]?.tell).toBe('missing-descriptor');
  });

  it('flags a getter that does not throw for the prototype receiver', () => {
    // A real native getter that passes every shape check but has no WebIDL brand check.
    const lenient = Object.getOwnPropertyDescriptor(Object.prototype, '__proto__')!.get!; // native, does not brand-check
    class P {}
    Object.defineProperty(P.prototype, 'thing', { get: lenient, configurable: true });
    const out = checkTarget({ label: 'P.thing', instance: new P(), proto: P.prototype, property: 'thing', kind: 'getter' });
    expect(out.map((f) => f.tell)).toEqual(['no-illegal-invocation']);
  });

  it('checks Function.prototype.toString integrity', () => {
    const native = Function.prototype.toString as (this: unknown) => string;
    expect(checkToStringIntegrity(native, native)).toEqual([]);
    const patched = function toString(this: unknown) {
      return native.call(this);
    };
    expect(checkToStringIntegrity(patched, native).length).toBeGreaterThan(0);
  });

  it('compares the main realm with a fresh iframe realm', () => {
    const main: RealmValues = { webdriver: false, platform: 'Win32', hardwareConcurrency: 8, languages: 'en-US,en', userAgent: 'UA', pluginsLength: 5 };
    expect(diffRealms(main, { ...main })).toEqual([]);
    expect(diffRealms(main, { ...main, webdriver: true, platform: 'MacIntel' })).toEqual(['webdriver', 'platform']);
    const realm = openFreshRealm(document);
    expect(realm).toBeDefined();
    expect(realm!.windowIsParent).toBe(false);
    expect(diffRealms(readRealmValues(navigator), realm!.values)).toEqual([]);
    expect(document.querySelector('iframe')).toBeNull(); // removed after the read
  });
});
