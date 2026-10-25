import {
  LABEL_HEADERS,
  SESSION_HEADER,
  createEngine,
  createRegistry,
  createSignal,
  decide,
  randomId,
  SIGNAL_CATALOG_LITE,
  type Action,
  type Decision,
  type Engine,
  type SessionEvent,
  type Signal,
  type SignalInput,
  type SignalRegistry,
  type Verdict,
  type VerdictStage,
} from '@necterai/core';
import type {
  Necter,
  NecterEventMap,
  EventInput,
  InterventionContext,
  Module,
  ModuleContext,
  ResolvedConfig,
  Session,
} from './types.js';
import { createScheduler } from './scheduler.js';
import { createTransport, type Transport } from './transport.js';
import { createInterventionRunner } from './intervene/index.js';
import { createDebugPanel } from './intervene/debug-panel.js';
import { BROWSER_SDK_VERSION } from './version.js';

type AnyHandler = (payload: unknown) => void;

export interface RuntimeDeps {
  config: ResolvedConfig;
  session: Session;
  modules: Module[];
  registry?: SignalRegistry;
  now?: () => number;
}

/**
 * The runtime owns the signal store, the engine, evaluation scheduling, policy
 * decisions, interventions and the beacon transport. Modules only `emit`.
 */
export function createRuntime(deps: RuntimeDeps): Necter {
  const { config, session, modules } = deps;
  const now = deps.now ?? (() => Date.now());
  const registry = deps.registry ?? createRegistry(SIGNAL_CATALOG_LITE);
  const engine: Engine = createEngine({ registry, now });
  const scheduler = createScheduler();
  const signals = new Map<string, Signal>();
  const handlers = new Map<keyof NecterEventMap, Set<AnyHandler>>();
  const log = (...args: unknown[]) => {
    if (config.debug) console.debug('[necter]', ...args);
  };

  let stage: VerdictStage = 'load';
  let finalized = false;
  let destroyed = false;
  let verdict: Verdict = engine.evaluate([], { sessionId: session.id, stage, ts: now() });
  let lastDecisionKey = '';
  let lastEvalAt = 0;
  let pendingEval: (() => void) | undefined;
  let appliedActions = new Set<string>();

  const transport: Transport = createTransport({
    endpoint: config.endpoint,
    sessionId: session.id,
    config: config.beacon,
    log,
    ...(config.siteKey ? { siteKey: config.siteKey } : {}),
  });

  function emitEvent(partial: Omit<SessionEvent, 'id' | 'sessionId' | 'ts' | 'source' | 'url'> & { url?: string }): void {
    const event = {
      id: randomId(),
      sessionId: session.id,
      ts: now(),
      source: 'client',
      url: typeof location !== 'undefined' ? location.href : undefined,
      ...partial,
    } as SessionEvent;
    transport.push(event);
  }

  function fire<K extends keyof NecterEventMap>(name: K, payload: NecterEventMap[K]): void {
    const set = handlers.get(name);
    if (!set) return;
    for (const h of set) {
      try {
        h(payload);
      } catch (err) {
        log('handler error', name, err);
      }
    }
  }

  const runner = createInterventionRunner(config);
  const panel = config.debug ? createDebugPanel() : undefined;

  async function applyAction(action: Action, decision: Decision): Promise<boolean> {
    const ictx: InterventionContext = {
      config,
      verdict,
      decision,
      session,
      challenge: () => runner.challenge(ictx),
      apply: (a) => applyAction(a, decision),
      log,
      event: (e) => emitEvent(e as Omit<SessionEvent, 'id' | 'sessionId' | 'ts' | 'source' | 'url'>),
    };
    let ok = false;
    try {
      ok = await runner.run(action, ictx);
    } catch (err) {
      log('intervention failed', action.kind, err);
      emitEvent({ type: 'error', data: { message: String(err), where: `intervention:${action.kind}` } });
    }
    emitEvent({ type: 'intervention', data: { kind: action.kind, ok, ...(action.params ? { params: action.params } : {}) } });
    fire('intervention', { action, ok });
    config.onIntervention?.(action, ok);
    return ok;
  }

  function evaluateNow(reason: string, nextStage?: VerdictStage): Verdict {
    if (destroyed) return verdict;
    if (nextStage && rank(nextStage) > rank(stage)) stage = nextStage;
    lastEvalAt = now();
    verdict = engine.evaluate(signals.values(), { sessionId: session.id, stage, ts: lastEvalAt });
    log('evaluate', reason, verdict.score, verdict.actorClass, verdict.provider?.id);
    emitEvent({ type: 'verdict', data: { verdict } });
    fire('verdict', verdict);
    config.onVerdict?.(verdict);
    panel?.update(verdict);

    const decision = decide(verdict, config.policy, { path: typeof location !== 'undefined' ? location.pathname : '/' });
    const key = decision.primary + '|' + decision.matchedRules.join(',');
    if (key !== lastDecisionKey) {
      lastDecisionKey = key;
      emitEvent({ type: 'decision', data: { decision, verdictTs: verdict.ts, path: typeof location !== 'undefined' ? location.pathname : undefined } });
      fire('decision', { decision, verdict });
      config.onDecision?.(decision, verdict);
      // Apply each action once per session unless it is a label/observe refresh.
      for (const action of decision.actions) {
        const once = action.kind !== 'label' && action.kind !== 'observe';
        if (once && appliedActions.has(action.kind)) continue;
        if (once) appliedActions.add(action.kind);
        void applyAction(action, decision);
      }
    }
    if (finalized && stage !== 'final') stage = 'final';
    return verdict;
  }

  function requestEvaluate(reason: string, opts: { stage?: VerdictStage; immediate?: boolean } = {}): void {
    if (destroyed) return;
    if (opts.stage && rank(opts.stage) > rank(stage)) stage = opts.stage;
    if (opts.immediate) {
      pendingEval?.();
      pendingEval = undefined;
      evaluateNow(reason);
      return;
    }
    if (pendingEval) return;
    const wait = Math.max(0, config.evaluateThrottleMs - (now() - lastEvalAt));
    pendingEval = scheduler.timeout(() => {
      pendingEval = undefined;
      evaluateNow(reason);
    }, wait);
  }

  function makeContext(mod: Module): ModuleContext {
    const options = (config.modules[mod.name] || {}) as Record<string, unknown>;
    const modLog = (...args: unknown[]) => log(`[${mod.name}]`, ...args);
    const ctx: ModuleContext = {
      config,
      session,
      registry,
      schedule: scheduler,
      options,
      now,
      emit(input: SignalInput) {
        const signal = createSignal(input, registry, { source: 'client', now });
        const prev = signals.get(signal.id);
        signals.set(signal.id, signal);
        emitEvent({ type: 'signal', data: { signals: [signal] } });
        fire('signal', signal);
        config.onSignal?.(signal);
        // Same rule as the engine: effective weight = base weight x reliability.
        const base = signal.automation ?? registry.get(signal.id)?.automation ?? 0;
        const reliability = Math.min(1, Math.max(0, signal.reliability ?? 1));
        const deterministic = Math.abs(base * reliability) >= engine.options.deterministicThreshold;
        if (deterministic) finalized = true;
        requestEvaluate(`signal:${signal.id}`, {
          immediate: deterministic || !prev && signal.layer !== 'behavior',
          ...(signal.layer === 'behavior' || signal.layer === 'harvest' || signal.layer === 'canary' ? { stage: 'interaction' as const } : {}),
        });
        return signal;
      },
      retract(id: string) {
        if (signals.delete(id)) requestEvaluate(`retract:${id}`);
      },
      event(e: EventInput) {
        emitEvent(e as Omit<SessionEvent, 'id' | 'sessionId' | 'ts' | 'source' | 'url'>);
      },
      requestEvaluate,
      finalize(reason: string) {
        finalized = true;
        modLog('finalize', reason);
        requestEvaluate(`finalize:${reason}`, { stage: 'final', immediate: true });
      },
      log: modLog,
      verdict: () => verdict,
    };
    return ctx;
  }

  // Boot modules; a failing module never takes the SDK down.
  for (const mod of modules) {
    if (config.modules[mod.name] === false) continue;
    try {
      const r = mod.start(makeContext(mod));
      if (r && typeof (r as Promise<void>).catch === 'function') {
        (r as Promise<void>).catch((err) => {
          log('module failed', mod.name, err);
          emitEvent({ type: 'error', data: { message: String(err), where: `module:${mod.name}` } });
        });
      }
    } catch (err) {
      log('module failed', mod.name, err);
      emitEvent({ type: 'error', data: { message: String(err), where: `module:${mod.name}` } });
    }
  }

  emitEvent({
    type: 'session',
    data: {
      action: session.pageViews > 1 ? 'resume' : 'start',
      firstVisit: session.firstVisit,
      ua: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
      referrer: typeof document !== 'undefined' ? document.referrer : undefined,
      hints: collectHints(),
    },
  });
  // Initial evaluation shortly after boot so synchronous collectors are included.
  scheduler.timeout(() => evaluateNow('boot'), 0);

  const api: Necter = {
    version: BROWSER_SDK_VERSION,
    sessionId: session.id,
    config,
    get verdict() {
      return verdict;
    },
    get signals() {
      return [...signals.values()];
    },
    on(name, handler) {
      let set = handlers.get(name);
      if (!set) {
        set = new Set();
        handlers.set(name, set);
      }
      const h = handler as AnyHandler;
      set.add(h);
      return () => {
        set!.delete(h);
      };
    },
    evaluate(nextStage) {
      return evaluateNow('manual', nextStage);
    },
    intervene(action) {
      const decision = decide(verdict, config.policy);
      return applyAction(action, decision);
    },
    challenge() {
      const decision = decide(verdict, config.policy);
      const ictx: InterventionContext = {
        config,
        verdict,
        decision,
        session,
        challenge: () => runner.challenge(ictx),
        apply: (a) => applyAction(a, decision),
        log,
        event: (e) => emitEvent(e as Omit<SessionEvent, 'id' | 'sessionId' | 'ts' | 'source' | 'url'>),
      };
      return runner.challenge(ictx);
    },
    headers() {
      const h: Record<string, string> = { [SESSION_HEADER]: session.id, [LABEL_HEADERS.score]: String(verdict.score), [LABEL_HEADERS.actorClass]: verdict.actorClass };
      if (verdict.provider) h[LABEL_HEADERS.provider] = verdict.provider.id;
      return h;
    },
    flush: () => transport.flush(),
    destroy() {
      destroyed = true;
      for (const mod of modules) {
        try {
          mod.stop?.();
        } catch {
          /* ignore */
        }
      }
      scheduler.dispose();
      panel?.destroy();
      void transport.flush({ unload: true });
      transport.dispose();
      appliedActions = new Set();
    },
  };
  return api;
}

/** Cheap, synchronous values the server cross-checks against request headers. */
function collectHints(): import('@necterai/core').ClientHints {
  const hints: import('@necterai/core').ClientHints = {};
  try {
    if (typeof navigator !== 'undefined') {
      hints.ua = navigator.userAgent;
      hints.languages = [...(navigator.languages ?? [])];
      hints.platform = navigator.platform;
      hints.hardwareConcurrency = navigator.hardwareConcurrency;
      const dm = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
      if (dm !== undefined) hints.deviceMemory = dm;
      const uad = (navigator as Navigator & { userAgentData?: { brands?: { brand: string; version: string }[]; mobile?: boolean; platform?: string } }).userAgentData;
      if (uad) {
        if (uad.brands) hints.brands = uad.brands.map((b) => ({ brand: b.brand, version: b.version }));
        if (uad.mobile !== undefined) hints.mobile = uad.mobile;
        if (uad.platform) hints.uaPlatform = uad.platform;
      }
    }
    if (typeof Intl !== 'undefined') hints.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof screen !== 'undefined') hints.screen = { width: screen.width, height: screen.height, dpr: typeof devicePixelRatio === 'number' ? devicePixelRatio : 1 };
    if (typeof window !== 'undefined') hints.viewport = { width: window.innerWidth, height: window.innerHeight };
  } catch {
    /* partial hints are fine */
  }
  return hints;
}

function rank(s: VerdictStage): number {
  return s === 'request' ? 0 : s === 'load' ? 1 : s === 'interaction' ? 2 : 3;
}
