import { Ring } from './ring.js';
import {
  BUFFER_SIZE,
  type CauseRecord,
  type ClickKind,
  type ClickRecord,
  type DispatchOrigin,
  type EnvInfo,
  type FocusRecord,
  type InputRecord,
  type KeyClass,
  type KeyRecord,
  type MoveSample,
  type PointerKind,
  type ScrollCauseKind,
  type ScrollRecord,
  type Snapshot,
  type SourceCaps,
  type TargetGeometry,
  type WheelRecord,
} from './records.js';

/**
 * Passive, capture-phase event capture into bounded ring buffers.
 *
 * Every handler is wrapped in try/catch, never calls preventDefault and does
 * O(1) work (plus one getBoundingClientRect pair per click). Interpretation
 * happens later in the pure feature extraction (`features.ts`).
 */

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CaptureDeps {
  win: Window;
  doc: Document;
  /** Trust check (jsdom cannot dispatch trusted events, so tests inject this). */
  isTrusted(e: Event): boolean;
  /** Same clock as Event.timeStamp (performance.now()). */
  now(): number;
  visibilityState(): string;
  prerendering(): boolean;
  rect(el: Element): RectLike | null;
  dpr(): number;
  /** `new Error().stack` (overridable in tests). */
  stack(): string | undefined;
  /** Event time (defaults to e.timeStamp). */
  timeOf(e: Event): number;
  chromium: boolean;
  finePointer: boolean;
  sourceCapsSupported: boolean;
  /** URL prefixes of the site's own scripts (config.trustedScriptOrigins). */
  trustedScriptOrigins: string[];
}

export interface CaptureHooks {
  /** Something was recorded; `click` asks for an immediate recompute. */
  dirty(kind: 'click' | 'other'): void;
  /** pagehide / visibility hidden: flush summaries. */
  pageHidden(): void;
}

export interface Capture {
  snapshot(): Snapshot;
  /** Total events recorded (monotonic; used to detect activity windows). */
  eventCount(): number;
  /** Time of the first trusted interaction (click/key/wheel/move), or null. */
  firstInteraction(): number | null;
  dispose(): void;
}

const LISTEN: AddEventListenerOptions = { capture: true, passive: true };
const INTERACTIVE =
  'button,a[href],input,select,textarea,label,summary,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],[role="menuitem"],[role="option"],[role="switch"],[onclick],[tabindex]';
const PM_DOC_SELECTOR =
  'com-1password-button,[data-com-onepassword-filled],[data-lastpass-icon-root],[data-lastpass-root],[data-dashlane-rid],[data-dashlanecreated],[data-dashlane-uid],.com-bitwarden-browser-animated-fill';
/** A click belongs to the pending press when it follows its pointerup within this window (long drags are fine). */
const CLICK_AFTER_UP_MS = 1000;
/** Without a pointerup, the press stays valid this long. */
const PRESS_TTL_MS = 5000;
const HIDDEN_GRACE_MS = 100;

export function keyClass(e: Event, KeyboardEventCtor: typeof KeyboardEvent | undefined): KeyClass {
  const ke = e as KeyboardEvent;
  if ((KeyboardEventCtor && !(e instanceof KeyboardEventCtor)) || typeof ke.key !== 'string' || ke.key === '') return 'generic';
  const k = ke.key;
  if (k === 'Tab') return 'tab';
  if (k === 'Enter') return 'enter';
  if (k === ' ' || k === 'Spacebar') return 'space';
  if (k === 'Backspace' || k === 'Delete') return 'backspace';
  if (/^(Arrow|Page|Home$|End$)/.test(k)) return 'nav';
  if (k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'Meta' || k === 'CapsLock' || k === 'AltGraph' || k === 'Fn') return 'modifier';
  if (k.length === 1) return /[\p{L}\p{N}]/u.test(k) ? 'char' : 'punct';
  return 'other';
}

/**
 * Attribute a synthetic (untrusted) dispatch from a stack captured inside our
 * listener. Leading frames from the SDK itself are skipped; extension or
 * URL-less frames (CDP Runtime.evaluate, javascript_tool, pptr:) are foreign;
 * any http(s) frame is site code (first or third party embedded by the site).
 */
export function classifyStack(stack: string | undefined, ownUrl: string | undefined): DispatchOrigin {
  if (!stack) return 'unknown';
  const lines = stack.split('\n').map((l) => l.trim()).filter((l) => l.length > 0 && !/^Error\b/.test(l));
  let i = 0;
  if (ownUrl) while (i < lines.length && lines[i]!.includes(ownUrl)) i++;
  let foreign = false;
  let site = false;
  let anyFrame = false;
  for (; i < lines.length; i++) {
    const l = lines[i]!;
    anyFrame = true;
    if (/(chrome|moz|safari-web)-extension:\/\/|webkit-masked-url:|pptr:|UtilityScript|__puppeteer_evaluation_script__|__playwright/.test(l)) foreign = true;
    else if (/https?:\/\//.test(l)) site = true;
    else if (/<anonymous>|\beval\b|VM\d+/.test(l)) foreign = true;
  }
  if (foreign) return 'foreign';
  if (site) return 'site';
  return anyFrame ? 'foreign' : 'unknown';
}

function firstUrl(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  const m = /((?:https?|file|chrome-extension):\/\/[^\s):]+(?::\d+)?[^\s):]*?)(?::\d+:\d+)?\)?$/m.exec(stack.split('\n').slice(1).join('\n'));
  if (!m) return undefined;
  // Strip trailing :line:col.
  return m[1]!.replace(/:\d+:\d+$/, '').replace(/:\d+$/, '');
}

function isField(el: Element | null): el is HTMLElement {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable === true;
}

function valueLength(el: HTMLElement): number {
  const v = (el as HTMLInputElement).value;
  if (typeof v === 'string') return v.length;
  return (el.textContent ?? '').length;
}

function hasPmMarker(el: Element): boolean {
  if (el.classList?.contains('com-bitwarden-browser-animated-fill')) return true;
  const names = el.getAttributeNames?.() ?? [];
  for (const n of names) {
    if (n.startsWith('data-com-onepassword') || n.startsWith('data-dashlane') || n.startsWith('data-lastpass') || n === 'data-bwautofill') return true;
  }
  return false;
}

function pointerKind(t: unknown): PointerKind {
  if (t === 'mouse' || t === 'pen' || t === 'touch' || t === '') return t;
  return 'unknown';
}

interface PendingPress {
  downT: number;
  upT: number | null;
  x: number;
  y: number;
  sx: number;
  sy: number;
  pointerType: PointerKind;
  pressure: number | null;
  buttons: number | null;
  mdDetail: number | null;
  overT: number | null;
  focusBeforeDown: boolean;
  target: EventTarget | null;
  trusted: boolean;
}

export function createCapture(deps: CaptureDeps, hooks: CaptureHooks): Capture {
  const { win, doc } = deps;
  const moves = new Ring<MoveSample>(BUFFER_SIZE);
  const clicks = new Ring<ClickRecord>(BUFFER_SIZE);
  const keys = new Ring<KeyRecord>(BUFFER_SIZE);
  const inputs = new Ring<InputRecord>(BUFFER_SIZE);
  const wheels = new Ring<WheelRecord>(BUFFER_SIZE);
  const scrolls = new Ring<ScrollRecord>(BUFFER_SIZE);
  const causes = new Ring<CauseRecord>(BUFFER_SIZE);
  const focuses = new Ring<FocusRecord>(BUFFER_SIZE);
  const pastes = new Ring<number>(200);
  const compositions = new Ring<number>(200);
  const selects = new Ring<{ t: number; field: number }>(200);
  const hiddenSpans = new Ring<[number, number]>(200);

  const fieldIds = new WeakMap<Element, number>();
  const lengths = new WeakMap<Element, number>();
  const openKeys = new Map<string, KeyRecord>();
  let nextField = 1;
  let pending: PendingPress | null = null;
  let lastOverT: number | null = null;
  let lastClickT = -Infinity;
  let lastTabT = -Infinity;
  let lastActivationKeyT = -Infinity;
  let lastFocusin: { t: number; target: EventTarget | null; trusted: boolean } | null = null;
  let hiddenSince: number | null = null;
  let segmentStart = deps.now();
  let loadT = doc.readyState === 'complete' ? navLoadEnd(win) ?? deps.now() : deps.now();
  let hiddenTrustedInputs = 0;
  let count = 0;
  let firstInteraction: number | null = null;
  let pmCache: { at: number; value: boolean } | null = null;
  const ownUrl = firstUrl(deps.stack());
  const KE = (win as unknown as { KeyboardEvent?: typeof KeyboardEvent }).KeyboardEvent;
  const IE = (win as unknown as { InputEvent?: typeof InputEvent }).InputEvent;
  let autofillSelector: string | null | undefined;

  if (safe(() => deps.prerendering() || deps.visibilityState() === 'hidden', false)) hiddenSince = deps.now();

  function navLoadEnd(w: Window): number | undefined {
    try {
      const nav = w.performance?.getEntriesByType?.('navigation')?.[0] as PerformanceNavigationTiming | undefined;
      return nav && nav.loadEventEnd > 0 ? nav.loadEventEnd : undefined;
    } catch {
      return undefined;
    }
  }

  function safe<T>(fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch {
      return fallback;
    }
  }

  function time(e: Event): number {
    const t = safe(() => deps.timeOf(e), NaN);
    return Number.isFinite(t) && t > 0 ? t : deps.now();
  }

  function isHidden(): boolean {
    return safe(() => deps.visibilityState() === 'hidden', false);
  }

  function noteHiddenInput(t: number, trusted: boolean): void {
    if (!trusted || !isHidden()) return;
    if (hiddenSince !== null && t - hiddenSince < HIDDEN_GRACE_MS) return;
    hiddenTrustedInputs++;
  }

  function cause(t: number, kind: ScrollCauseKind): void {
    causes.push({ t, kind });
  }

  function touch(t: number, trusted: boolean, kind: 'click' | 'other' = 'other'): void {
    count++;
    if (trusted && firstInteraction === null) firstInteraction = t;
    hooks.dirty(kind);
  }

  function fieldId(el: Element | null): number {
    if (!isField(el)) return 0;
    let id = fieldIds.get(el);
    if (id === undefined) {
      id = nextField++;
      fieldIds.set(el, id);
    }
    return id;
  }

  function ensureLength(el: Element | null): void {
    if (isField(el) && !lengths.has(el)) lengths.set(el, valueLength(el));
  }

  function matchesAutofill(el: Element): boolean {
    if (autofillSelector === undefined) {
      autofillSelector = null;
      for (const sel of [':autofill', ':-webkit-autofill']) {
        try {
          el.matches(sel);
          autofillSelector = sel;
          break;
        } catch {
          /* unsupported pseudo-class */
        }
      }
    }
    if (!autofillSelector) return false;
    try {
      return el.matches(autofillSelector);
    } catch {
      return false;
    }
  }

  function geometry(target: EventTarget | null, x: number, y: number): TargetGeometry | null {
    if (!target || !(target as Element).getBoundingClientRect) return null;
    const el = target as Element;
    const candidates: Element[] = [el];
    const anc = safe(() => el.closest(INTERACTIVE), null);
    if (anc && anc !== el) candidates.push(anc);
    let best: TargetGeometry | null = null;
    let bestScore = Infinity;
    for (const c of candidates) {
      const r = safe(() => deps.rect(c), null);
      if (!r) continue;
      const g: TargetGeometry = { w: r.width, h: r.height, dx: x - (r.left + r.width / 2), dy: y - (r.top + r.height / 2) };
      // Prefer eligible (>= 24 px) candidates, then the smallest offset.
      const score = (r.width >= 24 && r.height >= 24 ? 0 : 1e6) + Math.abs(g.dx) + Math.abs(g.dy);
      if (score < bestScore) {
        bestScore = score;
        best = g;
      }
    }
    return best;
  }

  function sourceCaps(e: Event): SourceCaps {
    if (!deps.sourceCapsSupported) return 'unsupported';
    const sc = (e as UIEvent & { sourceCapabilities?: unknown }).sourceCapabilities;
    if (sc === null) return 'null';
    return sc === undefined ? 'unsupported' : 'present';
  }

  function related(a: EventTarget | null, b: EventTarget | null): boolean {
    if (!a || !b) return false;
    if (a === b) return true;
    const na = a as Node;
    const nb = b as Node;
    return safe(() => (typeof na.contains === 'function' && na.contains(nb)) || (typeof nb.contains === 'function' && nb.contains(na)), false);
  }

  // ───────────── handlers ─────────────

  const onPointerMove = (ev: Event): void => {
    const e = ev as PointerEvent;
    const t = time(e);
    const trusted = deps.isTrusted(e);
    let coalesced = -1;
    if (typeof e.getCoalescedEvents === 'function') coalesced = safe(() => e.getCoalescedEvents().length, -1);
    const buttons = e.buttons ?? 0;
    moves.push({
      t,
      x: e.clientX,
      y: e.clientY,
      sx: e.screenX,
      sy: e.screenY,
      pointerType: pointerKind(e.pointerType),
      mx: e.movementX ?? 0,
      my: e.movementY ?? 0,
      coalesced,
      buttons,
      trusted,
      hidden: isHidden(),
    });
    if (buttons !== 0) cause(t, 'pointer');
    touch(t, trusted);
  };

  const onPointerOver = (ev: Event): void => {
    lastOverT = time(ev);
  };

  const onPointerDown = (ev: Event): void => {
    const e = ev as PointerEvent;
    const t = time(e);
    const trusted = deps.isTrusted(e);
    cause(t, 'pointer');
    noteHiddenInput(t, trusted);
    if (e.button !== 0 && e.button !== undefined) return touch(t, trusted);
    const f = lastFocusin;
    pending = {
      downT: t,
      upT: null,
      x: e.clientX,
      y: e.clientY,
      sx: e.screenX,
      sy: e.screenY,
      pointerType: pointerKind(e.pointerType),
      pressure: typeof e.pressure === 'number' ? e.pressure : null,
      buttons: typeof e.buttons === 'number' ? e.buttons : null,
      mdDetail: null,
      overT: lastOverT,
      focusBeforeDown: !!f && f.trusted && t - f.t >= 0 && t - f.t <= 50 && related(f.target, e.target),
      target: e.target,
      trusted,
    };
    touch(t, trusted);
  };

  const onMouseDown = (ev: Event): void => {
    const e = ev as MouseEvent;
    const t = time(e);
    if (e.button !== 0) return;
    if (pending && t - pending.downT <= 50 && pending.mdDetail === null) {
      pending.mdDetail = e.detail;
      return;
    }
    // No Pointer Events support: build the press from mousedown.
    const trusted = deps.isTrusted(e);
    cause(t, 'pointer');
    noteHiddenInput(t, trusted);
    pending = {
      downT: t,
      upT: null,
      x: e.clientX,
      y: e.clientY,
      sx: e.screenX,
      sy: e.screenY,
      pointerType: 'mouse',
      pressure: null,
      buttons: e.buttons ?? null,
      mdDetail: e.detail,
      overT: lastOverT,
      focusBeforeDown: false,
      target: e.target,
      trusted,
    };
    touch(t, trusted);
  };

  const onPointerUp = (ev: Event): void => {
    const e = ev as PointerEvent;
    const t = time(e);
    const trusted = deps.isTrusted(e);
    if (ev.type === 'pointerup') {
      noteHiddenInput(t, trusted);
      cause(t, 'pointer');
    }
    if (pending && pending.upT === null && (e.button === 0 || e.button === undefined)) pending.upT = t;
  };

  const onClick = (ev: Event): void => {
    const e = ev as MouseEvent & { pointerType?: string };
    if (e.button !== 0 && e.button !== undefined) return;
    const t = time(e);
    const trusted = deps.isTrusted(e);
    cause(t, 'pointer');
    noteHiddenInput(t, trusted);
    const p =
      pending && t >= pending.downT - 1 && (pending.upT !== null ? t - pending.upT <= CLICK_AFTER_UP_MS : t - pending.downT <= PRESS_TTL_MS)
        ? pending
        : null;
    pending = null;
    const keyBefore = t - lastActivationKeyT >= 0 && t - lastActivationKeyT <= 100;
    let kind: ClickKind;
    if (!trusted) kind = 'untrusted';
    else if (p) kind = 'pointer';
    else if (keyBefore) kind = 'keyboard';
    else if (t - lastClickT >= 0 && t - lastClickT <= 20) kind = 'derived';
    else kind = 'sr';
    if (trusted) lastClickT = t;
    const x = p ? p.x : e.clientX;
    const y = p ? p.y : e.clientY;
    const rec: ClickRecord = {
      t,
      kind,
      trusted,
      pointerType: p ? p.pointerType : pointerKind(e.pointerType),
      x,
      y,
      sx: p ? p.sx : e.screenX,
      sy: p ? p.sy : e.screenY,
      downT: p ? p.downT : null,
      upT: p ? p.upT : null,
      overT: p ? p.overT : null,
      pressure: p ? p.pressure : null,
      buttons: p ? p.buttons : null,
      detail: e.detail ?? 0,
      mdDetail: p ? p.mdDetail : null,
      sourceCaps: sourceCaps(e),
      focusBeforeDown: p ? p.focusBeforeDown : false,
      keyBefore,
      onField: isField(e.target as Element | null),
      hidden: isHidden(),
      geometry: kind === 'keyboard' ? null : geometry(e.target, x, y),
    };
    if (!trusted) rec.origin = classifyStack(safe(() => deps.stack(), undefined), ownUrl);
    clicks.push(rec);
    touch(t, trusted, 'click');
  };

  const onKeyDown = (ev: Event): void => {
    const e = ev as KeyboardEvent;
    const t = time(e);
    const trusted = deps.isTrusted(e);
    const cls = keyClass(e, KE);
    const target = e.target as Element | null;
    ensureLength(target);
    const rec: KeyRecord = {
      t,
      up: null,
      code: typeof e.code === 'string' && e.code ? e.code : typeof e.key === 'string' ? e.key : '',
      cls,
      trusted,
      repeat: e.repeat === true,
      field: fieldId(target),
      hidden: isHidden(),
    };
    if (!trusted) rec.origin = classifyStack(safe(() => deps.stack(), undefined), ownUrl);
    keys.push(rec);
    if (rec.code) openKeys.set(rec.code, rec);
    if (trusted) {
      cause(t, 'key');
      if (cls === 'tab') lastTabT = t;
      if (cls === 'enter' || cls === 'space') lastActivationKeyT = t;
      if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) pastes.push(t);
    }
    noteHiddenInput(t, trusted);
    touch(t, trusted);
  };

  const onKeyUp = (ev: Event): void => {
    const e = ev as KeyboardEvent;
    const t = time(e);
    const trusted = deps.isTrusted(e);
    noteHiddenInput(t, trusted);
    const code = typeof e.code === 'string' && e.code ? e.code : typeof e.key === 'string' ? e.key : '';
    const rec = code ? openKeys.get(code) : undefined;
    if (rec && rec.up === null && t >= rec.t && t - rec.t < 5000) {
      rec.up = t;
      openKeys.delete(code);
    }
  };

  const onInput = (ev: Event): void => {
    const target = ev.target as Element | null;
    if (!isField(target)) return;
    const t = time(ev);
    const trusted = deps.isTrusted(ev);
    const kind = ev.type as InputRecord['kind'];
    let delta = 0;
    if (kind === 'beforeinput') {
      ensureLength(target);
    } else {
      const len = valueLength(target);
      const prev = lengths.get(target) ?? 0;
      delta = len - prev;
      lengths.set(target, len);
    }
    const isInputEvent = IE ? ev instanceof IE : typeof (ev as InputEvent).inputType === 'string';
    inputs.push({
      t,
      kind,
      trusted,
      isInputEvent,
      inputType: isInputEvent ? (ev as InputEvent).inputType ?? '' : '',
      delta,
      field: fieldId(target),
      fieldType: ((target as HTMLInputElement).type || target.tagName.toLowerCase()).toLowerCase(),
      autocomplete: (target.getAttribute('autocomplete') ?? '').toLowerCase(),
      autofill: kind === 'beforeinput' ? false : matchesAutofill(target),
      pmMarker: hasPmMarker(target),
    });
    touch(t, trusted);
  };

  const onFocusIn = (ev: Event): void => {
    const t = time(ev);
    const trusted = deps.isTrusted(ev);
    const target = ev.target as Element | null;
    ensureLength(target);
    lastFocusin = { t, target, trusted };
    focuses.push({ t, viaTab: trusted && t - lastTabT >= 0 && t - lastTabT <= 150, field: fieldId(target), trusted });
    if (trusted) cause(t, 'focus');
    touch(t, trusted);
  };

  const onWheel = (ev: Event): void => {
    const e = ev as WheelEvent & { wheelDeltaY?: number };
    const t = time(e);
    const trusted = deps.isTrusted(e);
    wheels.push({ t, dx: e.deltaX ?? 0, dy: e.deltaY ?? 0, mode: e.deltaMode ?? 0, wdy: typeof e.wheelDeltaY === 'number' ? e.wheelDeltaY : null, trusted });
    if (trusted) cause(t, 'wheel');
    noteHiddenInput(t, trusted);
    touch(t, trusted);
  };

  const onTouch = (ev: Event): void => {
    if (deps.isTrusted(ev)) cause(time(ev), 'touch');
  };

  const onScroll = (ev: Event): void => {
    const t = time(ev);
    const target = ev.target as Element | Document | null;
    let pos = 0;
    if (!target || target === doc || (target as Node).nodeType === 9) pos = safe(() => win.scrollY || win.pageYOffset || 0, 0);
    else pos = safe(() => (target as Element).scrollTop || 0, 0);
    scrolls.push({ t, pos });
    count++;
    hooks.dirty('other');
  };

  const onNav = (ev: Event): void => cause(time(ev), 'nav');
  const onResize = (ev: Event): void => cause(time(ev), 'resize');
  const onPaste = (ev: Event): void => {
    pastes.push(time(ev));
    count++;
  };
  const onComposition = (ev: Event): void => {
    compositions.push(time(ev));
  };
  const onSelect = (ev: Event): void => {
    const target = ev.target as Element | null;
    if (isField(target)) selects.push({ t: time(ev), field: fieldId(target) });
  };

  const onVisibility = (): void => {
    const t = deps.now();
    const hidden = safe(() => deps.visibilityState() === 'hidden' || deps.prerendering(), false);
    if (hidden) {
      if (hiddenSince === null) hiddenSince = t;
      hooks.pageHidden();
    } else if (hiddenSince !== null) {
      hiddenSpans.push([hiddenSince, t]);
      hiddenSince = null;
    }
    hooks.dirty('other');
  };

  const onPageShow = (ev: Event): void => {
    if ((ev as PageTransitionEvent).persisted) {
      const t = deps.now();
      segmentStart = t;
      loadT = t;
      pending = null;
      hooks.dirty('other');
    }
  };
  const onLoad = (ev: Event): void => {
    loadT = Math.max(loadT, time(ev));
  };
  const onPageHide = (): void => hooks.pageHidden();

  const listeners: [EventTarget, string, (e: Event) => void][] = [
    [win, 'pointermove', onPointerMove],
    [win, 'pointerover', onPointerOver],
    [win, 'pointerdown', onPointerDown],
    [win, 'pointerup', onPointerUp],
    [win, 'mousedown', onMouseDown],
    [win, 'mouseup', onPointerUp],
    [win, 'click', onClick],
    [win, 'keydown', onKeyDown],
    [win, 'keyup', onKeyUp],
    [win, 'beforeinput', onInput],
    [win, 'input', onInput],
    [win, 'change', onInput],
    [win, 'focusin', onFocusIn],
    [win, 'wheel', onWheel],
    [win, 'touchstart', onTouch],
    [win, 'touchmove', onTouch],
    [win, 'scroll', onScroll],
    [win, 'hashchange', onNav],
    [win, 'popstate', onNav],
    [win, 'resize', onResize],
    [win, 'paste', onPaste],
    [win, 'compositionstart', onComposition],
    [win, 'compositionend', onComposition],
    [win, 'select', onSelect],
    [doc, 'visibilitychange', onVisibility],
    [doc, 'prerenderingchange', onVisibility],
    [win, 'pageshow', onPageShow],
    [win, 'pagehide', onPageHide],
    [win, 'load', onLoad],
  ];
  const wrapped = listeners.map(([target, type, fn]) => {
    const h = (e: Event): void => {
      try {
        fn(e);
      } catch {
        /* never throw into the host page */
      }
    };
    try {
      target.addEventListener(type, h, LISTEN);
    } catch {
      /* ignore */
    }
    return [target, type, h] as const;
  });

  function env(): EnvInfo {
    const dpr = safe(() => deps.dpr(), 1) || 1;
    const windowed = safe(
      () => deps.finePointer && (win.screenY > 0 || win.screenX > 0 || win.outerHeight - win.innerHeight > 0),
      false,
    );
    return { chromium: deps.chromium, dpr, finePointer: deps.finePointer, sourceCapsSupported: deps.sourceCapsSupported, windowed };
  }

  function pmMarkersPresent(now: number): boolean {
    if (inputs.size === 0) return false;
    if (pmCache && now - pmCache.at < 5000) return pmCache.value;
    const value = safe(() => doc.querySelector(PM_DOC_SELECTOR) !== null, false);
    pmCache = { at: now, value };
    return value;
  }

  return {
    snapshot(): Snapshot {
      const now = deps.now();
      return {
        now,
        moves: moves.toArray(),
        clicks: clicks.toArray(),
        keys: keys.toArray(),
        inputs: inputs.toArray(),
        wheels: wheels.toArray(),
        scrolls: scrolls.toArray(),
        causes: causes.toArray(),
        focuses: focuses.toArray(),
        pastes: pastes.toArray(),
        compositions: compositions.toArray(),
        selects: selects.toArray(),
        hiddenSpans: hiddenSpans.toArray(),
        hiddenSince,
        segmentStart,
        loadT,
        hiddenTrustedInputs,
        pmMarkersPresent: pmMarkersPresent(now),
        env: env(),
      };
    },
    eventCount: () => count,
    firstInteraction: () => firstInteraction,
    dispose() {
      for (const [target, type, h] of wrapped) {
        try {
          target.removeEventListener(type, h, LISTEN);
        } catch {
          /* ignore */
        }
      }
    },
  };
}
