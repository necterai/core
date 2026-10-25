import { ACTOR_CLASSES, AUTOMATION_CLASSES, type ActorClass, type ProviderId } from './taxonomy.js';
import {
  STRENGTH_LOG_ODDS,
  type Signal,
  type SignalLayer,
  type SignalRegistry,
  type SignalStrength,
} from './signals.js';
import { clamp, sigmoid } from './util.js';

/** How mature the verdict is. Policies may require a minimum stage before blocking. */
export type VerdictStage =
  /** Only the HTTP request has been seen (server side). */
  | 'request'
  /** The SDK booted and environment/probe signals arrived. */
  | 'load'
  /** Behavioural evidence is accumulating. */
  | 'interaction'
  /** Enough evidence or an explicit finalisation (challenge outcome, canary hit). */
  | 'final';

export interface EvidenceItem {
  signalId: string;
  layer: SignalLayer;
  strength: SignalStrength;
  summary: string;
  /** Effective automation log-odds after family and layer caps. */
  contribution: number;
  /** Weight before caps. */
  rawWeight: number;
  source: Signal['source'];
  ts: number;
  provider?: Signal['provider'];
  details?: Record<string, unknown>;
}

export interface ProviderAttribution {
  id: ProviderId;
  product?: string;
  /** 0..1 */
  confidence: number;
  /** Whether a cryptographic or network verification backs the attribution. */
  verified: boolean;
  method?: string;
  basis: string[];
}

export interface Verdict {
  sessionId: string;
  ts: number;
  stage: VerdictStage;
  /** Probability (0..1) that the session is NOT operated by a person. */
  automation: number;
  /** 0..100 convenience score = round(automation * 100). */
  score: number;
  /** Final log-odds (after prior and caps). */
  logit: number;
  actorClass: ActorClass;
  /** 0..1 confidence in actorClass given the automation decision. */
  classConfidence: number;
  /** Normalised class distribution among automation classes (sums to 1 when any class evidence exists). */
  classScores: Partial<Record<ActorClass, number>>;
  provider?: ProviderAttribution;
  /** True when at least one deterministic signal fired. */
  deterministic: boolean;
  evidence: EvidenceItem[];
  signalCount: number;
  layers: SignalLayer[];
}

export interface LayerCap {
  pos: number;
  neg: number;
}

export interface EngineOptions {
  registry: SignalRegistry;
  /** Prior log-odds that a session is automated. Default logit(0.08). */
  priorAutomation?: number;
  /** Max |contribution| from any single non-deterministic signal (default 4). */
  maxSingle?: number;
  /** Default per-family cap for non-deterministic signals. */
  familyCap?: LayerCap;
  /** Per-layer caps for non-deterministic signals. */
  layerCaps?: Partial<Record<SignalLayer, LayerCap>>;
  /** Hard clamp of the final logit (default 12 => 0.999994). */
  maxLogit?: number;
  /** Threshold that counts a weight as deterministic (default 6). */
  deterministicThreshold?: number;
  now?: () => number;
}

export const DEFAULT_LAYER_CAPS: Record<SignalLayer, LayerCap> = {
  // Self-declared UAs are honest more often than not, but trivially spoofed either way.
  declared: { pos: 4.5, neg: 1.0 },
  request: { pos: 4.0, neg: 2.0 },
  network: { pos: 4.5, neg: 2.0 },
  // Environment tells are correlated and privacy browsers trip several at once: keep the lid on.
  environment: { pos: 3.5, neg: 2.5 },
  probe: { pos: 5.0, neg: 1.5 },
  // Behaviour is the strongest human-favouring layer, so allow it to pull hard both ways.
  behavior: { pos: 5.0, neg: 4.5 },
  harvest: { pos: 4.0, neg: 0.5 },
  canary: { pos: 5.0, neg: 0.5 },
  extension: { pos: 4.5, neg: 1.0 },
  consistency: { pos: 4.0, neg: 1.5 },
  tie: { pos: 4.5, neg: 2.0 },
  challenge: { pos: 5.0, neg: 5.0 },
};

/** Multiplier on browser-agent class mass when a session has no in-page driver evidence. */
export const DRIVERLESS_BROWSER_AGENT_DAMPING = 0.4;

export const DEFAULT_FAMILY_CAP: LayerCap = { pos: 3.5, neg: 3.0 };

interface Scored {
  signal: Signal;
  rawWeight: number;
  deterministic: boolean;
  family: string;
}

function weightOf(signal: Signal, registry: SignalRegistry): number {
  const def = registry.get(signal.id);
  const base = signal.automation ?? def?.automation ?? STRENGTH_LOG_ODDS[signal.strength];
  const reliability = clamp(signal.reliability ?? 1, 0, 1);
  return base * reliability;
}

function classProfile(signal: Signal, registry: SignalRegistry): Partial<Record<ActorClass, number>> | undefined {
  return signal.classes ?? registry.get(signal.id)?.classes;
}

/** Keep the newest observation per signal id. */
export function dedupeSignals(signals: Iterable<Signal>): Signal[] {
  const map = new Map<string, Signal>();
  for (const s of signals) {
    const prev = map.get(s.id);
    if (!prev || s.ts >= prev.ts) map.set(s.id, s);
  }
  return [...map.values()];
}

/** Merge two signal lists, newest per id wins. */
export function mergeSignals(a: Iterable<Signal>, b: Iterable<Signal>): Signal[] {
  return dedupeSignals([...a, ...b]);
}

function capSum(values: number[], cap: LayerCap): { total: number; scale: number } {
  let pos = 0;
  let neg = 0;
  for (const v of values) {
    if (v > 0) pos += v;
    else neg += v;
  }
  const cappedPos = Math.min(pos, cap.pos);
  const cappedNeg = Math.max(neg, -cap.neg);
  const raw = pos + neg;
  const total = cappedPos + cappedNeg;
  const scale = raw === 0 ? 1 : total / raw;
  return { total, scale: Number.isFinite(scale) ? scale : 1 };
}

export interface Engine {
  evaluate(signals: Iterable<Signal>, ctx: { sessionId: string; stage: VerdictStage; ts?: number }): Verdict;
  readonly options: Required<Omit<EngineOptions, 'layerCaps' | 'familyCap' | 'now'>> & {
    layerCaps: Record<SignalLayer, LayerCap>;
    familyCap: LayerCap;
    now: () => number;
  };
}

export function createEngine(opts: EngineOptions): Engine {
  const options = {
    registry: opts.registry,
    priorAutomation: opts.priorAutomation ?? -2.44, // ~8% prior automation
    maxSingle: opts.maxSingle ?? 4,
    familyCap: opts.familyCap ?? DEFAULT_FAMILY_CAP,
    layerCaps: { ...DEFAULT_LAYER_CAPS, ...(opts.layerCaps ?? {}) },
    maxLogit: opts.maxLogit ?? 12,
    deterministicThreshold: opts.deterministicThreshold ?? 6,
    now: opts.now ?? Date.now,
  };

  function evaluate(input: Iterable<Signal>, ctx: { sessionId: string; stage: VerdictStage; ts?: number }): Verdict {
    const registry = options.registry;
    const signals = dedupeSignals(input);
    const scored: Scored[] = signals.map((signal) => {
      const raw = weightOf(signal, registry);
      const deterministic = Math.abs(raw) >= options.deterministicThreshold;
      const w = deterministic ? raw : clamp(raw, -options.maxSingle, options.maxSingle);
      return { signal, rawWeight: w, deterministic, family: signal.family ?? registry.get(signal.id)?.family ?? signal.id };
    });

    // 1) Family capping: correlated tells share one budget.
    const families = new Map<string, Scored[]>();
    for (const s of scored) {
      const list = families.get(s.family) ?? [];
      list.push(s);
      families.set(s.family, list);
    }
    const perSignalContribution = new Map<Scored, number>();
    const perLayerFamilyTotals = new Map<SignalLayer, { det: number; nonDet: number[] }>();
    for (const members of families.values()) {
      const det = members.filter((m) => m.deterministic);
      const nonDet = members.filter((m) => !m.deterministic);
      // Deterministic members: take the single strongest (they prove the same thing).
      let detTotal = 0;
      if (det.length) {
        const strongest = det.reduce((a, b) => (Math.abs(b.rawWeight) > Math.abs(a.rawWeight) ? b : a));
        for (const m of det) perSignalContribution.set(m, m === strongest ? m.rawWeight : 0);
        detTotal = strongest.rawWeight;
      }
      const { total, scale } = capSum(nonDet.map((m) => m.rawWeight), options.familyCap);
      for (const m of nonDet) perSignalContribution.set(m, m.rawWeight * scale);
      const layer = members[0]!.signal.layer;
      const entry = perLayerFamilyTotals.get(layer) ?? { det: 0, nonDet: [] };
      entry.det += detTotal;
      entry.nonDet.push(total);
      perLayerFamilyTotals.set(layer, entry);
    }

    // 2) Layer capping: each layer has one failure mode; bound its say.
    let logitSum = options.priorAutomation;
    const layerScale = new Map<SignalLayer, number>();
    for (const [layer, entry] of perLayerFamilyTotals) {
      const cap = options.layerCaps[layer];
      const { total, scale } = capSum(entry.nonDet, cap);
      layerScale.set(layer, scale);
      logitSum += total + entry.det;
    }
    const finalLogit = clamp(logitSum, -options.maxLogit, options.maxLogit);
    const automation = sigmoid(finalLogit);

    // 3) Evidence list with effective contributions.
    const evidence: EvidenceItem[] = scored.map((s) => {
      const fam = perSignalContribution.get(s) ?? 0;
      const contribution = s.deterministic ? fam : fam * (layerScale.get(s.signal.layer) ?? 1);
      const item: EvidenceItem = {
        signalId: s.signal.id,
        layer: s.signal.layer,
        strength: s.signal.strength,
        summary: s.signal.summary,
        contribution: round4(contribution),
        rawWeight: round4(s.rawWeight),
        source: s.signal.source,
        ts: s.signal.ts,
      };
      if (s.signal.provider) item.provider = s.signal.provider;
      if (s.signal.details) item.details = s.signal.details;
      return item;
    });
    evidence.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

    // 4) Class attribution among automation classes.
    const classRaw: Partial<Record<ActorClass, number>> = {};
    let assisted = 0;
    for (const s of scored) {
      const profile = classProfile(s.signal, registry);
      if (!profile) continue;
      const rel = clamp(s.signal.reliability ?? 1, 0, 1);
      for (const [cls, delta] of Object.entries(profile) as [ActorClass, number][]) {
        if (cls === 'human-assisted') {
          assisted += delta * rel;
          continue;
        }
        if (cls === 'human' || cls === 'unknown') continue;
        classRaw[cls] = (classRaw[cls] ?? 0) + delta * rel;
      }
    }
    // "browser-agent" means an in-page driver (CDP, Playwright, Selenium). When nothing points to a driver
    // (no probe, declared, harvest or webdriver evidence), automation seen only in behaviour and environment
    // most likely comes from OS-level input (xdotool, screenshot loops): a computer-use agent. Damp
    // browser-agent so the shared behaviour signals stop defaulting to it.
    if ((classRaw['browser-agent'] ?? 0) > 0 && (classRaw['computer-use-agent'] ?? 0) > 0) {
      const driverEvidence = scored.some((s) => {
        const p = classProfile(s.signal, registry);
        if (!p || !(p['browser-agent']! > 0)) return false;
        const layer = s.signal.layer ?? registry.get(s.signal.id)?.layer;
        return layer === 'probe' || layer === 'declared' || layer === 'harvest' || s.signal.id === 'env.webdriver';
      });
      if (!driverEvidence) classRaw['browser-agent'] = classRaw['browser-agent']! * DRIVERLESS_BROWSER_AGENT_DAMPING;
    }
    const classScores: Partial<Record<ActorClass, number>> = {};
    let topClass: ActorClass = 'unknown';
    let classConfidence = 0;
    const entries = AUTOMATION_CLASSES.map((c) => [c, classRaw[c] ?? 0] as const).filter(([, v]) => v !== 0);
    if (entries.length) {
      const max = Math.max(...entries.map(([, v]) => v));
      if (max > 0) {
        // Softmax over classes with any evidence; absent classes get a floor of 0.
        let denom = 0;
        const exps = entries.map(([c, v]) => {
          const e = Math.exp(v - max);
          denom += e;
          return [c, e] as const;
        });
        for (const [c, e] of exps) classScores[c] = round4(e / denom);
        const best = exps.reduce((a, b) => (b[1] > a[1] ? b : a));
        topClass = best[0];
        classConfidence = round4(best[1] / denom);
      }
    }

    const deterministic = scored.some((s) => s.deterministic && s.rawWeight > 0);
    let actorClass: ActorClass;
    if (automation < 0.5) {
      actorClass = assisted >= 1 ? 'human-assisted' : 'human';
      classConfidence = round4(1 - automation);
    } else {
      actorClass = topClass;
    }

    // 5) Provider attribution via noisy-OR over hints, verified hints dominate.
    const providers = new Map<string, { miss: number; product?: string; basis: string[]; verified: boolean; method?: string; best: number }>();
    for (const s of scored) {
      const hint = s.signal.provider;
      if (!hint) continue;
      const key = hint.id;
      const entry = providers.get(key) ?? { miss: 1, basis: [], verified: false, best: 0 };
      const conf = clamp(hint.confidence, 0, 1);
      entry.miss *= 1 - conf;
      entry.basis.push(s.signal.id);
      if (conf >= entry.best) {
        entry.best = conf;
        if (hint.product) entry.product = hint.product;
      }
      const verification = s.signal.details?.['verification'];
      if (verification === 'passed') {
        entry.verified = true;
        const m = s.signal.details?.['method'];
        if (typeof m === 'string') entry.method = m;
      }
      providers.set(key, entry);
    }
    let provider: ProviderAttribution | undefined;
    for (const [id, e] of providers) {
      const confidence = round4(1 - e.miss);
      if (!provider || e.verified && !provider.verified || (e.verified === provider.verified && confidence > provider.confidence)) {
        provider = { id, confidence, verified: e.verified, basis: e.basis };
        if (e.product) provider.product = e.product;
        if (e.method) provider.method = e.method;
      }
    }

    const layers = [...new Set(signals.map((s) => s.layer))];
    const verdict: Verdict = {
      sessionId: ctx.sessionId,
      ts: ctx.ts ?? options.now(),
      stage: ctx.stage,
      automation: round4(automation),
      score: Math.round(automation * 100),
      logit: round4(finalLogit),
      actorClass,
      classConfidence,
      classScores,
      deterministic,
      evidence,
      signalCount: signals.length,
      layers,
    };
    if (provider) verdict.provider = provider;
    return verdict;
  }

  return { evaluate, options };
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

export { ACTOR_CLASSES };
