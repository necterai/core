/**
 * Prototype instrumentation shared by the harvest, canary (sensitive-node reads)
 * and behaviour (programmatic-scroll provenance) modules.
 *
 * Guarantees (see detection-spec.md §4 and the tests in test/harvest.instrument.test.ts):
 * - idempotent and reference counted: `installInstrumentation()` returns a release
 *   function; prototypes are restored when the last user releases;
 * - wrappers preserve `name`, `length` and `toString()` (Function.prototype.toString
 *   is patched to answer with the original's source for our wrappers, and for itself);
 * - wrappers never change return values or exceptions: the original is invoked with
 *   the same `this` and arguments, and all instrumentation work is wrapped in try/catch;
 * - re-entrant reads from inside our own listeners are not observed (depth guard);
 * - CSP-safe: no eval, no injected script text.
 *
 * Research: automation-stacks.md §2.5/§4.3/§27.1 (what shows up in `new Error().stack`
 * from main-world evaluate), extension-agents.md §2.3 (isolated-world content scripts
 * do not call page prototypes, so their reads are invisible here).
 */

import { classifyStack, parseStack, type StackClass, type StackEnv, type StackVerdict } from './stack.js';

export type ReadKind =
  | 'rect'
  | 'rects'
  | 'visibility'
  | 'style'
  | 'innerText'
  | 'textContent'
  | 'qsa'
  | 'treeWalker'
  | 'elementFromPoint'
  | 'attrNames'
  | 'attr'
  | 'scrollIntoView'
  | 'scrollBy'
  | 'scrollTo';

export interface ReadEvent {
  kind: ReadKind;
  /** `this` of the call (an Element, Node, Document or the Window). */
  target: unknown;
  /** The call's arguments (the live `arguments` object; do not retain). */
  args: ArrayLike<unknown>;
}

/** Return true to request a stack sample for this call (delivered to stack listeners). */
export type ReadListener = (ev: ReadEvent) => boolean | void;
export type StackReason = 'sample' | 'sensitive' | 'scroll';
export type StackListener = (ev: ReadEvent, verdict: StackVerdict, reason: StackReason) => void;

export interface SensitiveReadInfo {
  api: 'innerText' | 'textContent';
  /** True when the read targeted the sensitive node itself or one of its descendants. */
  direct: boolean;
  /** The node whose text was read. */
  target: Node;
  stack: StackVerdict;
}
export type SensitiveCallback = (info: SensitiveReadInfo) => void;

export interface ProgrammaticScroll {
  api: 'scrollIntoView' | 'scrollBy' | 'scrollTo';
  /** `performance.now()` based timestamp (comparable with `Event.timeStamp`). */
  ts: number;
  origin: StackClass;
  /** True when the call came from the site's own (trusted) code. */
  trusted: boolean;
  target: 'window' | 'element';
  /** Representative stack frame when available. */
  sample?: string;
  /** Automation markers when the scroll came from an automation evaluate frame. */
  markers: string[];
}

/**
 * "Wrapped" marker for every function the SDK installs on a prototype. Another
 * copy of the SDK (or the probes module) checks it before wrapping, so a slot is
 * never wrapped twice. The mark is kept in a WeakSet registered under the global
 * symbol `Symbol.for('__necter_wrapped')` rather than as an own property: an own
 * key would break the native shape (own keys exactly `length`,`name`) that the
 * wrappers must preserve against CreepJS-style lie detection. Functions carrying a
 * legacy own `__necter_wrapped === true` property are honoured too. Identity of
 * *this* copy's wrappers is tracked privately (`isSdkWrapper`).
 */
export const WRAPPED_MARKER = '__necter_wrapped';
const MARK_KEY = Symbol.for(WRAPPED_MARKER);

function markRegistry(): WeakSet<object> | undefined {
  try {
    const g = globalThis as unknown as Record<symbol, unknown>;
    const existing = g[MARK_KEY];
    if (existing instanceof WeakSet) return existing as WeakSet<object>;
    const set = new WeakSet<object>();
    Object.defineProperty(g, MARK_KEY, { value: set, configurable: true, enumerable: false, writable: false });
    return set;
  } catch {
    return undefined;
  }
}

export function hasWrappedMarker(fn: unknown): boolean {
  if (typeof fn !== 'function') return false;
  try {
    if (markRegistry()?.has(fn)) return true;
    return (fn as unknown as Record<string, unknown>)[WRAPPED_MARKER] === true;
  } catch {
    return false;
  }
}

export function setWrappedMarker(fn: unknown): void {
  if (typeof fn !== 'function') return;
  try {
    markRegistry()?.add(fn);
  } catch {
    /* ignore */
  }
}

interface Patched {
  obj: object;
  key: string;
  original: PropertyDescriptor;
  wrapper: PropertyDescriptor;
}

/**
 * Number of frames our own code contributes above the caller:
 * `captureStack` + `observe` + the wrapper. Calibrated at install time (engines
 * agree today, but the measured value wins over the constant).
 */
const OWN_FRAMES_DEFAULT = 3;
let ownFramesCalibrated: number | undefined;
let calibrating: { raw?: string } | undefined;

let refCount = 0;
let depth = 0;
let hotAttr = false;
let patched: Patched[] = [];
let toStringPatched: { proto: typeof Function.prototype; original: () => string; patched: () => string } | undefined;
const sources = new WeakMap<Function, Function>();
const readListeners = new Set<ReadListener>();
const stackListeners = new Set<StackListener>();
const sensitive: { node: Node; cb: SensitiveCallback }[] = [];
let lastScroll: ProgrammaticScroll | undefined;
let automationClaimed = false;
let lastScrollVerdict: { ts: number; verdict: StackVerdict } | undefined;
let stackSource: (() => string | undefined) | undefined;
let ownFramesOverride: number | undefined;

const env: StackEnv = {
  pageOrigin: safe(() => (typeof location !== 'undefined' ? location.origin : ''), ''),
  pageUrl: safe(() => (typeof location !== 'undefined' ? location.href : ''), ''),
  trustedScriptOrigins: [],
  selfUrl: detectSelfUrl(),
};

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function detectSelfUrl(): string | undefined {
  try {
    const cs = typeof document !== 'undefined' ? (document.currentScript as HTMLScriptElement | null) : null;
    if (cs && cs.src) return cs.src;
  } catch {
    /* ignore */
  }
  try {
    const stack = new Error().stack ?? '';
    const m = /([a-z][a-z0-9+.-]*:\/\/[^\s()]+?)(?::\d+){1,2}\)?\s*$/im.exec(stack);
    if (m && m[1]) return m[1];
  } catch {
    /* ignore */
  }
  return undefined;
}

function nowMs(): number {
  try {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
  } catch {
    /* ignore */
  }
  return Date.now();
}

/** Capture a raw stack. Overridable for tests via `setStackSource`. */
function captureStack(): string | undefined {
  if (stackSource) return stackSource();
  try {
    return new Error().stack ?? undefined;
  } catch {
    return undefined;
  }
}

function ownFrames(): number {
  return ownFramesOverride ?? ownFramesCalibrated ?? OWN_FRAMES_DEFAULT;
}

function classify(raw: string | undefined): StackVerdict {
  return classifyStack(raw, env, ownFrames());
}

/**
 * Measure how many frames sit between a caller and `captureStack` by calling a
 * wrapped method from here and comparing frame counts. Falls back to the default
 * when the engine gives no usable stack.
 */
function calibrateOwnFrames(): void {
  if (typeof document === 'undefined') return;
  try {
    const el = document.createElement('div');
    const outer = parseStack(new Error().stack).length;
    calibrating = {};
    try {
      el.getBoundingClientRect();
    } finally {
      const raw = calibrating.raw;
      calibrating = undefined;
      if (raw) {
        const inner = parseStack(raw).length;
        const diff = inner - outer;
        if (diff >= 1 && diff <= 6) ownFramesCalibrated = diff;
      }
    }
  } catch {
    /* keep the default */
  }
}

function notifyRead(ev: ReadEvent): boolean {
  let want = false;
  for (const l of readListeners) {
    try {
      if (l(ev)) want = true;
    } catch {
      /* listener errors never reach the page */
    }
  }
  return want;
}

function notifyStack(ev: ReadEvent, verdict: StackVerdict, reason: StackReason): void {
  for (const l of stackListeners) {
    try {
      l(ev, verdict, reason);
    } catch {
      /* ignore */
    }
  }
}

function matchSensitive(target: unknown): { entry: (typeof sensitive)[number]; direct: boolean }[] | undefined {
  if (sensitive.length === 0) return undefined;
  const t = target as Node | null;
  if (!t || typeof t !== 'object' || typeof (t as Node).nodeType !== 'number') return undefined;
  let hits: { entry: (typeof sensitive)[number]; direct: boolean }[] | undefined;
  for (const entry of sensitive) {
    const node = entry.node;
    try {
      if (!node.isConnected) continue;
      if (t === node || node.contains(t)) {
        (hits ??= []).push({ entry, direct: true });
      } else if (typeof t.contains === 'function' && t.contains(node)) {
        (hits ??= []).push({ entry, direct: false });
      }
    } catch {
      /* ignore */
    }
  }
  return hits;
}

/**
 * Core observation step shared by all wrappers. Runs inside the depth guard so
 * listeners cannot re-trigger instrumentation, and never throws.
 * Returns nothing; the wrapper then invokes the original.
 */
function observe(kind: ReadKind, target: unknown, args: ArrayLike<unknown>, raw: () => string | undefined): void {
  if (calibrating) {
    calibrating.raw = raw();
    return;
  }
  const ev: ReadEvent = { kind, target, args };
  const isScroll = kind === 'scrollIntoView' || kind === 'scrollBy' || kind === 'scrollTo';
  const want = notifyRead(ev);
  const hits = kind === 'innerText' || kind === 'textContent' ? matchSensitive(target) : undefined;
  if (!want && !hits && !isScroll) return;
  let verdict: StackVerdict | undefined;
  if (isScroll) {
    const t = nowMs();
    if (lastScrollVerdict && t - lastScrollVerdict.ts < 50) verdict = lastScrollVerdict.verdict;
    else {
      verdict = classify(raw());
      lastScrollVerdict = { ts: t, verdict };
    }
    const ps: ProgrammaticScroll = {
      api: kind,
      ts: t,
      origin: verdict.cls,
      trusted: verdict.cls === 'trusted',
      target: typeof Window !== 'undefined' && target instanceof Window ? 'window' : target && typeof (target as Node).nodeType === 'number' ? 'element' : 'window',
      markers: verdict.markers,
    };
    if (verdict.sample) ps.sample = verdict.sample;
    lastScroll = ps;
    notifyStack(ev, verdict, 'scroll');
    return;
  }
  verdict = classify(raw());
  if (hits) {
    for (const h of hits) {
      try {
        h.entry.cb({ api: kind as 'innerText' | 'textContent', direct: h.direct, target: target as Node, stack: verdict });
      } catch {
        /* ignore */
      }
    }
    notifyStack(ev, verdict, 'sensitive');
    if (!want) return;
  }
  notifyStack(ev, verdict, 'sample');
}

/** Copy `name`/`length` from the original so `fn.name`/`fn.length` checks pass. */
function mirrorIdentity(wrapper: Function, original: Function): void {
  try {
    Object.defineProperty(wrapper, 'name', { value: original.name, configurable: true });
  } catch {
    /* ignore */
  }
  try {
    Object.defineProperty(wrapper, 'length', { value: original.length, configurable: true });
  } catch {
    /* ignore */
  }
  sources.set(wrapper, original);
  setWrappedMarker(wrapper);
}

function makeMethod(original: Function, kind: ReadKind, gated: boolean): Function {
  // Object-literal method: no `prototype` property, like a native method.
  const holder = {
    m(this: unknown) {
      if (depth === 0 && (!gated || hotAttr)) {
        depth++;
        try {
          // eslint-disable-next-line prefer-rest-params
          const a = arguments;
          observe(kind, this, a, captureStack);
        } catch {
          /* never reach the page */
        } finally {
          depth--;
        }
      }
      // eslint-disable-next-line prefer-rest-params
      return original.apply(this, arguments as unknown as unknown[]);
    },
  };
  const wrapper = holder.m as unknown as Function;
  mirrorIdentity(wrapper, original);
  return wrapper;
}

function makeGetter(original: () => unknown, kind: ReadKind): () => unknown {
  // Accessor syntax gives a native-shaped getter (no `prototype`, own keys length/name).
  // TS forbids a `this` annotation on accessors; `this` is the receiver at runtime.
  const holder = {
    get g() {
      if (depth === 0) {
        depth++;
        try {
          observe(kind, this as unknown, [], captureStack);
        } catch {
          /* ignore */
        } finally {
          depth--;
        }
      }
      return original.call(this as unknown);
    },
  };
  const getter = Object.getOwnPropertyDescriptor(holder, 'g')!.get as () => unknown;
  mirrorIdentity(getter, original);
  return getter;
}

function wrapMethod(obj: object | undefined, key: string, kind: ReadKind, gated = false): boolean {
  if (!obj) return false;
  try {
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (!desc || typeof desc.value !== 'function' || !desc.configurable) return false;
    // Already wrapped by another SDK instance: share it rather than stacking wrappers.
    if (hasWrappedMarker(desc.value)) return false;
    const wrapper = makeMethod(desc.value, kind, gated);
    const newDesc: PropertyDescriptor = { ...desc, value: wrapper };
    Object.defineProperty(obj, key, newDesc);
    patched.push({ obj, key, original: desc, wrapper: newDesc });
    return true;
  } catch {
    return false;
  }
}

function wrapGetter(obj: object | undefined, key: string, kind: ReadKind): boolean {
  if (!obj) return false;
  try {
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (!desc || typeof desc.get !== 'function' || !desc.configurable) return false;
    if (hasWrappedMarker(desc.get)) return false;
    const getter = makeGetter(desc.get as () => unknown, kind);
    const newDesc: PropertyDescriptor = { ...desc, get: getter };
    Object.defineProperty(obj, key, newDesc);
    patched.push({ obj, key, original: desc, wrapper: newDesc });
    return true;
  } catch {
    return false;
  }
}

function patchToString(): void {
  if (toStringPatched) return;
  try {
    const proto = Function.prototype;
    const original = proto.toString;
    // Another SDK copy already answers natively for its wrappers; do not stack patches.
    if (hasWrappedMarker(original)) return;
    const holder = {
      toString(this: unknown) {
        const o = typeof this === 'function' ? sources.get(this as Function) : undefined;
        return original.call((o ?? this) as Function);
      },
    };
    const patchedFn = holder.toString as unknown as () => string;
    mirrorIdentity(patchedFn, original);
    Object.defineProperty(proto, 'toString', { value: patchedFn, writable: true, configurable: true, enumerable: false });
    toStringPatched = { proto, original, patched: patchedFn };
  } catch {
    /* ignore */
  }
}

function restoreToString(): void {
  if (!toStringPatched) return;
  try {
    if (toStringPatched.proto.toString === toStringPatched.patched) {
      Object.defineProperty(toStringPatched.proto, 'toString', {
        value: toStringPatched.original,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
  } catch {
    /* ignore */
  }
  toStringPatched = undefined;
}

function windowHost(key: string): object | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    if (Object.getOwnPropertyDescriptor(window, key)) return window;
    const proto = Object.getPrototypeOf(window) as object | null;
    if (proto && Object.getOwnPropertyDescriptor(proto, key)) return proto;
  } catch {
    /* ignore */
  }
  return undefined;
}

function doInstall(): void {
  if (typeof window === 'undefined' || typeof Element === 'undefined') return;
  // Patch toString first so the wrappers never reveal their source, even mid-install.
  patchToString();
  const g = globalThis as unknown as Record<string, { prototype?: object } | undefined>;
  const E = Element.prototype;
  const H = g['HTMLElement']?.prototype;
  const N = g['Node']?.prototype;
  const D = g['Document']?.prototype;

  wrapMethod(E, 'getBoundingClientRect', 'rect');
  wrapMethod(E, 'getClientRects', 'rects');
  wrapMethod(E, 'checkVisibility', 'visibility');
  wrapMethod(windowHost('getComputedStyle'), 'getComputedStyle', 'style');
  wrapGetter(H, 'innerText', 'innerText');
  wrapGetter(N, 'textContent', 'textContent');
  wrapMethod(D, 'querySelectorAll', 'qsa');
  wrapMethod(E, 'querySelectorAll', 'qsa');
  wrapMethod(D, 'createTreeWalker', 'treeWalker');
  wrapMethod(D, 'elementFromPoint', 'elementFromPoint');
  wrapMethod(E, 'getAttributeNames', 'attrNames');
  wrapMethod(E, 'getAttribute', 'attr', true);
  wrapMethod(E, 'scrollIntoView', 'scrollIntoView');
  wrapMethod(E, 'scrollBy', 'scrollBy');
  wrapMethod(E, 'scrollTo', 'scrollTo');
  wrapMethod(E, 'scroll', 'scrollTo');
  wrapMethod(windowHost('scrollBy'), 'scrollBy', 'scrollBy');
  wrapMethod(windowHost('scrollTo'), 'scrollTo', 'scrollTo');
  wrapMethod(windowHost('scroll'), 'scroll', 'scrollTo');
  calibrateOwnFrames();
}

function doUninstall(): void {
  for (let i = patched.length - 1; i >= 0; i--) {
    const p = patched[i]!;
    try {
      const current = Object.getOwnPropertyDescriptor(p.obj, p.key);
      // Only restore when nobody else re-wrapped the slot after us.
      const ours = current && (current.value === p.wrapper.value || (current.get !== undefined && current.get === p.wrapper.get));
      if (ours) Object.defineProperty(p.obj, p.key, p.original);
    } catch {
      /* ignore */
    }
  }
  patched = [];
  restoreToString();
  readListeners.clear();
  stackListeners.clear();
  sensitive.length = 0;
  lastScroll = undefined;
  lastScrollVerdict = undefined;
  hotAttr = false;
  ownFramesCalibrated = undefined;
  automationClaimed = false;
}

/**
 * Install (or join) the shared instrumentation. Returns a release function;
 * prototypes are restored when the last holder releases. Safe to call multiple
 * times and from several modules.
 */
export function installInstrumentation(options: { trustedScriptOrigins?: readonly string[] } = {}): () => void {
  if (options.trustedScriptOrigins) configureStackEnv({ trustedScriptOrigins: options.trustedScriptOrigins });
  if (refCount === 0) {
    try {
      doInstall();
    } catch {
      /* ignore */
    }
  }
  refCount++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    refCount = Math.max(0, refCount - 1);
    if (refCount === 0) doUninstall();
  };
}

export function isInstrumented(): boolean {
  return refCount > 0 && patched.length > 0;
}

/** Names of the slots currently wrapped, e.g. `Element.getBoundingClientRect`. */
export function instrumentedSlots(): string[] {
  return patched.map((p) => {
    const ctor = (p.obj as { constructor?: { name?: string } }).constructor?.name ?? 'object';
    const isWindow = typeof window !== 'undefined' && p.obj === window;
    return `${isWindow ? 'window' : ctor}.${p.key}`;
  });
}

/** Subscribe to every instrumented call. Return true from the listener to request a stack sample. */
export function onRead(listener: ReadListener): () => void {
  readListeners.add(listener);
  return () => void readListeners.delete(listener);
}

/** Subscribe to classified stack samples (burst samples, sensitive-node reads, programmatic scrolls). */
export function onStack(listener: StackListener): () => void {
  stackListeners.add(listener);
  return () => void stackListeners.delete(listener);
}

/**
 * Watch a node: any `innerText`/`textContent` read that covers it (the node, a
 * descendant, or an ancestor such as `document.body`) invokes `cb` with the
 * classified stack of the caller. Used by the canary module for hidden text.
 */
export function registerSensitiveNode(node: Node, cb: SensitiveCallback): () => void {
  const entry = { node, cb };
  sensitive.push(entry);
  return () => {
    const i = sensitive.indexOf(entry);
    if (i >= 0) sensitive.splice(i, 1);
  };
}

/** Most recent programmatic scroll call (scrollIntoView / scrollBy / scrollTo) and its provenance. */
export function getLastProgrammaticScroll(): ProgrammaticScroll | undefined {
  return lastScroll;
}

/** Run `fn` with instrumentation muted (for the SDK's own DOM reads). */
export function quiet<T>(fn: () => T): T {
  depth++;
  try {
    return fn();
  } finally {
    depth--;
  }
}

/** Enable counting of `Element.prototype.getAttribute` calls (hot path; off by default). */
export function setHotAttributeCounting(on: boolean): void {
  hotAttr = on;
}

/** True for functions this SDK installed (wrappers and the toString patch). Not spoofable by the page. */
export function isSdkWrapper(fn: unknown): boolean {
  return typeof fn === 'function' && sources.has(fn as Function);
}

/**
 * The `Function.prototype.toString` that was in place before our patch (the
 * current one when instrumentation is not installed). Tamper checks inspect
 * this one, so our own patch never hides a stealth plugin's.
 */
export function getOriginalToString(): (this: unknown) => string {
  if (toStringPatched) return toStringPatched.original as (this: unknown) => string;
  return Function.prototype.toString as (this: unknown) => string;
}

/** Original (unwrapped) function behind one of our wrappers, else the function itself. */
export function unwrapSdk<T>(fn: T): T {
  const o = typeof fn === 'function' ? sources.get(fn as unknown as Function) : undefined;
  return (o as unknown as T) ?? fn;
}

/**
 * `probe.automation-stack-frame` can be observed by both the harvest and the
 * probes module; the first caller claims the report so it is emitted once.
 */
export function claimAutomationReport(): boolean {
  if (automationClaimed) return false;
  automationClaimed = true;
  return true;
}

export function configureStackEnv(partial: Partial<StackEnv>): void {
  if (partial.pageOrigin !== undefined) env.pageOrigin = partial.pageOrigin;
  if (partial.pageUrl !== undefined) env.pageUrl = partial.pageUrl;
  if (partial.trustedScriptOrigins !== undefined) env.trustedScriptOrigins = [...partial.trustedScriptOrigins];
  if ('selfUrl' in partial) env.selfUrl = partial.selfUrl;
}

export function getStackEnv(): Readonly<StackEnv> {
  return env;
}

/**
 * Test hook: replace the stack source. `ownFrames` is the number of leading
 * frames to drop (0 for synthetic stacks). Pass `undefined` to restore.
 */
export function setStackSource(fn: (() => string | undefined) | undefined, own?: number): void {
  stackSource = fn;
  ownFramesOverride = fn ? own ?? 0 : undefined;
}

/** The number of own frames currently dropped before classification (calibrated at install). */
export function getOwnFrameCount(): number {
  return ownFrames();
}

/** Classify a raw stack with the current environment (exported for other modules and tests). */
export function classifyRawStack(raw: string | undefined, ownFrames = 0): StackVerdict {
  return classifyStack(raw, env, ownFrames);
}

export type { StackClass, StackEnv, StackVerdict } from './stack.js';
