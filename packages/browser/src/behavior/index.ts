import type { Module, ModuleContext } from '../types.js';
import { createCapture, type Capture, type CaptureDeps, type RectLike } from './capture.js';
import { computeFeatures, type Features } from './features.js';
import { AT_SUPPRESSED, NEVER_RETRACT, decide, type Decision } from './score.js';
import { buildSummary, type InteractionSummaryWithRaw } from './summary.js';

export * from './records.js';
export * from './features.js';
export * from './score.js';
export * from './summary.js';
export { createCapture, classifyStack, keyClass } from './capture.js';
export type { Capture, CaptureDeps, CaptureHooks, RectLike } from './capture.js';
export { Ring } from './ring.js';

/** Injection points for tests and exotic hosts; every field is optional. */
export interface BehaviorModuleDeps {
  win?: Window;
  doc?: Document;
  isTrusted?: (e: Event) => boolean;
  now?: () => number;
  visibilityState?: () => string;
  prerendering?: () => boolean;
  rect?: (el: Element) => RectLike | null;
  dpr?: () => number;
  stack?: () => string | undefined;
  timeOf?: (e: Event) => number;
  hasFocus?: () => boolean;
  chromium?: boolean;
  finePointer?: boolean;
  sourceCapsSupported?: boolean;
}

export interface BehaviorModuleOptions {
  /** Attach raw pointer/key samples to InteractionSummary events (default false: aggregates only). */
  rawSamples?: boolean;
  /** Minimum ms between recomputations when dirty (default 750; clicks recompute immediately). */
  recomputeMs?: number;
  /** InteractionSummary cadence while the page is active (default 10,000). */
  summaryMs?: number;
}

export interface BehaviorModule extends Module {
  /** Recompute features and apply signal decisions now; returns the features (null before start). */
  evaluateNow(): Features | null;
  /** Build and emit an InteractionSummary for the current window now. */
  summaryNow(): InteractionSummaryWithRaw | null;
}

/**
 * Behaviour module (detection-spec §3): passive pointer/keyboard/scroll capture, pure feature extraction,
 * catalog-mapped decisions with AT-possible gating, and periodic InteractionSummary events.
 */
export function createBehaviorModule(deps: BehaviorModuleDeps = {}): BehaviorModule {
  let capture: Capture | null = null;
  let ctxRef: ModuleContext | null = null;
  let stopped = false;
  const cancels: (() => void)[] = [];
  let pendingCancel: (() => void) | null = null;
  let pendingAt = Infinity;
  let lastRun = -Infinity;
  let lastFeatures: Features | null = null;
  let summaryFrom = 0;
  let summaryCount = 0;
  const emitted = new Map<string, string>();
  const latched = new Set<string>();
  let opts: Required<BehaviorModuleOptions> = { rawSamples: false, recomputeMs: 750, summaryMs: 10_000 };
  let nowFn: () => number = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let visible: () => boolean = () => true;
  let hasFocus: () => boolean = () => true;

  function apply(ctx: ModuleContext, decisions: Decision[], at: boolean): void {
    for (const d of decisions) {
      if (d.active) {
        const rel = d.reliability === undefined ? 1 : Math.round(d.reliability * 100) / 100;
        // Re-emit only when reliability or the order of magnitude of a count changes (each emit triggers
        // an engine evaluation and a beacon event).
        const v = typeof d.value === 'number' && Number.isInteger(d.value) ? Math.floor(Math.log2(d.value + 1)) : d.value ?? null;
        const key = JSON.stringify([v, rel]);
        if (emitted.get(d.id) !== key) {
          ctx.emit({
            id: d.id,
            summary: d.summary,
            ...(d.value !== undefined ? { value: d.value } : {}),
            ...(d.reliability !== undefined ? { reliability: rel } : {}),
            ...(d.details ? { details: d.details } : {}),
          });
          emitted.set(d.id, key);
        }
        if (d.latch) latched.add(d.id);
      } else if (emitted.has(d.id) && !NEVER_RETRACT.has(d.id)) {
        const suppressed = at && AT_SUPPRESSED.includes(d.id);
        if (!latched.has(d.id) || suppressed) {
          ctx.retract(d.id);
          emitted.delete(d.id);
          latched.delete(d.id);
        }
      }
    }
  }

  function recompute(): Features | null {
    pendingCancel = null;
    pendingAt = Infinity;
    const ctx = ctxRef;
    if (!capture || !ctx || stopped) return null;
    lastRun = nowFn();
    try {
      const snap = capture.snapshot();
      const f = computeFeatures(snap);
      lastFeatures = f;
      apply(ctx, decide(f), f.at.possible);
      // Scroll provenance is decided once a burst is 200 ms old: come back for unsettled bursts.
      const lastScroll = snap.scrolls[snap.scrolls.length - 1];
      if (lastScroll && snap.now - lastScroll.t < 300) schedule(300);
      return f;
    } catch (err) {
      ctx.log('behavior recompute failed', err);
      return null;
    }
  }

  function schedule(delay: number): void {
    const ctx = ctxRef;
    if (!ctx || stopped) return;
    const at = nowFn() + delay;
    if (pendingCancel && pendingAt <= at) return;
    pendingCancel?.();
    pendingAt = at;
    pendingCancel = ctx.schedule.timeout(recompute, delay);
  }

  function summaryNow(force = false): InteractionSummaryWithRaw | null {
    const ctx = ctxRef;
    if (!capture || !ctx || stopped) return null;
    const count = capture.eventCount();
    if (!force && count === summaryCount) return null;
    try {
      const f = recompute() ?? lastFeatures;
      if (!f) return null;
      const snap = capture.snapshot();
      const data = buildSummary(snap, f, {
        from: summaryFrom,
        firstInteraction: capture.firstInteraction(),
        hasFocus: hasFocus(),
        visible: visible(),
        rawSamples: opts.rawSamples,
      });
      summaryFrom = snap.now;
      summaryCount = count;
      ctx.event({ type: 'interaction', data });
      return data;
    } catch (err) {
      ctx.log('behavior summary failed', err);
      return null;
    }
  }

  return {
    name: 'behavior',
    start(ctx: ModuleContext) {
      const win = deps.win ?? (typeof window !== 'undefined' ? window : undefined);
      const doc = deps.doc ?? win?.document;
      if (!win || !doc) return;
      ctxRef = ctx;
      stopped = false;
      const o = ctx.options as BehaviorModuleOptions;
      opts = {
        rawSamples: o.rawSamples === true,
        recomputeMs: typeof o.recomputeMs === 'number' && o.recomputeMs >= 0 ? o.recomputeMs : 750,
        summaryMs: typeof o.summaryMs === 'number' && o.summaryMs > 0 ? o.summaryMs : 10_000,
      };
      const perf = (win as Window & { performance?: Performance }).performance;
      nowFn = deps.now ?? (() => (perf ? perf.now() : Date.now()));
      const visibilityState = deps.visibilityState ?? (() => doc.visibilityState);
      const prerendering = deps.prerendering ?? (() => (doc as Document & { prerendering?: boolean }).prerendering === true);
      visible = () => {
        try {
          return visibilityState() !== 'hidden' && !prerendering();
        } catch {
          return true;
        }
      };
      hasFocus =
        deps.hasFocus ??
        (() => {
          try {
            return doc.hasFocus();
          } catch {
            return false;
          }
        });
      let finePointer = deps.finePointer;
      if (finePointer === undefined) {
        try {
          finePointer = typeof win.matchMedia === 'function' ? win.matchMedia('(pointer: fine)').matches : true;
        } catch {
          finePointer = true;
        }
      }
      const uiProto = (win as unknown as { UIEvent?: { prototype: object } }).UIEvent?.prototype;
      const cdeps: CaptureDeps = {
        win,
        doc,
        isTrusted: deps.isTrusted ?? ((e) => e.isTrusted),
        now: nowFn,
        visibilityState,
        prerendering,
        rect: deps.rect ?? ((el) => el.getBoundingClientRect()),
        dpr: deps.dpr ?? (() => win.devicePixelRatio || 1),
        stack: deps.stack ?? (() => new Error().stack),
        timeOf: deps.timeOf ?? ((e) => e.timeStamp),
        chromium: deps.chromium ?? 'onpointerrawupdate' in win,
        finePointer,
        sourceCapsSupported: deps.sourceCapsSupported ?? (!!uiProto && 'sourceCapabilities' in uiProto),
        trustedScriptOrigins: ctx.config?.trustedScriptOrigins ?? [],
      };
      summaryFrom = nowFn();
      capture = createCapture(cdeps, {
        dirty(kind) {
          if (kind === 'click') schedule(0);
          else schedule(Math.max(0, opts.recomputeMs - (nowFn() - lastRun)));
        },
        pageHidden() {
          summaryNow();
        },
      });
      // Periodic summary (also advances time-based features: think time, idle motion).
      cancels.push(
        ctx.schedule.every(() => {
          if (visible()) summaryNow();
          else recompute();
        }, opts.summaryMs),
      );
    },
    stop() {
      stopped = true;
      pendingCancel?.();
      pendingCancel = null;
      for (const c of cancels.splice(0)) c();
      capture?.dispose();
      capture = null;
    },
    evaluateNow: () => recompute(),
    summaryNow: () => summaryNow(true),
  };
}
