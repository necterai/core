import type { ActorClass, ProviderId } from './taxonomy.js';

/**
 * Where a signal was observed. Layers matter for two reasons: (1) each layer
 * has an independent failure mode, so the engine caps how much any one layer
 * can contribute, and (2) the review UI groups evidence by layer.
 */
export type SignalLayer =
  /** Self-declaration: User-Agent, Signature-Agent, robots token, From header. */
  | 'declared'
  /** HTTP request forensics: header set/order, client hints, Accept-*, Sec-Fetch-*. */
  | 'request'
  /** Network identity: IP ranges, ASN, rDNS, TLS / h2 fingerprints, Web Bot Auth verification. */
  | 'network'
  /** Passive browser environment: navigator, screen, WebGL, media devices, fonts, timezone... */
  | 'environment'
  /** Active automation-leak probes: CDP Runtime leak, stack markers, globals, tamper checks. */
  | 'probe'
  /** Behaviour and kinematics: pointer, keyboard, scroll, timing. */
  | 'behavior'
  /** DOM-harvesting instrumentation: bursts of layout/style/text reads from foreign code. */
  | 'harvest'
  /** Semantic canaries and honeypots: hidden instructions, links, fields that only agents act on. */
  | 'canary'
  /** Extension / agentic-browser artifacts. */
  | 'extension'
  /** Cross-signal consistency ("lie detection"): UA vs platform vs hints vs WebGL vs timezone vs IP. */
  | 'consistency'
  /** Server <-> client ties: HTML served but no SDK beacon, hint/JS mismatch, session continuity. */
  | 'tie'
  /** Outcome of an interactive challenge. */
  | 'challenge';

export const SIGNAL_LAYERS: readonly SignalLayer[] = [
  'declared', 'request', 'network', 'environment', 'probe', 'behavior', 'harvest',
  'canary', 'extension', 'consistency', 'tie', 'challenge',
];

/**
 * How much a single observation of the signal proves on its own.
 * Weights (log-odds) are suggested per strength; definitions may override.
 */
export type SignalStrength = 'deterministic' | 'strong' | 'moderate' | 'weak' | 'informational';

/** Suggested automation log-odds per strength. Positive supports automation. */
export const STRENGTH_LOG_ODDS: Record<SignalStrength, number> = {
  deterministic: 7.5, // sigmoid(7.5) = 0.9994
  strong: 3.0, //       sigmoid(3.0) = 0.95
  moderate: 1.5, //     sigmoid(1.5) = 0.82
  weak: 0.6, //         sigmoid(0.6) = 0.65
  informational: 0,
};

export type SignalSource = 'client' | 'server';

export interface ProviderHint {
  id: ProviderId;
  product?: string;
  /** 0..1: how sure this signal alone is about the provider. */
  confidence: number;
}

/**
 * Static definition of a signal: the registry entry that gives it a default
 * weight, class profile and documentation. Definitions live in core so the
 * client and server score identically and docs can be generated.
 */
export interface SignalDefinition {
  id: string;
  layer: SignalLayer;
  strength: SignalStrength;
  /** Default automation log-odds delta. Negative values support "human". */
  automation: number;
  /**
   * Relative log-score deltas among automation classes. Only matters once
   * the session is believed to be automated; used for class attribution.
   */
  classes?: Partial<Record<ActorClass, number>>;
  /**
   * Signals in the same family share a root cause (e.g. ten "looks like a
   * Linux container" tells). The engine caps the total contribution of a
   * family so correlated evidence is not counted many times.
   */
  family?: string;
  /** Short human-readable description for docs and the review UI. */
  description: string;
  /** Known false-positive traps and how the implementation guards them. */
  falsePositives?: string;
  /** Which side can observe it. */
  source: SignalSource | 'both';
}

/** A concrete observation of a signal in a session. */
export interface Signal {
  id: string;
  layer: SignalLayer;
  strength: SignalStrength;
  source: SignalSource;
  /** Epoch milliseconds. */
  ts: number;
  /** One line of evidence, e.g. "navigator.webdriver === true". */
  summary: string;
  /** Raw observed value (JSON-serialisable). */
  value?: unknown;
  /** Extra structured context (JSON-serialisable). */
  details?: Record<string, unknown>;
  /** Override of the registry automation weight; omit to use the default. */
  automation?: number;
  /** Override of the registry class profile; omit to use the default. */
  classes?: Partial<Record<ActorClass, number>>;
  /** 0..1 reliability multiplier for this observation (default 1). */
  reliability?: number;
  provider?: ProviderHint;
  family?: string;
}

/** Input shape accepted by `createSignal`: everything optional except id and summary. */
export type SignalInput = Partial<Omit<Signal, 'id' | 'summary'>> & { id: string; summary: string };

export interface SignalRegistry {
  get(id: string): SignalDefinition | undefined;
  all(): SignalDefinition[];
  register(def: SignalDefinition): void;
  registerAll(defs: Iterable<SignalDefinition>): void;
}

export function createRegistry(initial: Iterable<SignalDefinition> = []): SignalRegistry {
  const map = new Map<string, SignalDefinition>();
  const registry: SignalRegistry = {
    get: (id) => map.get(id),
    all: () => [...map.values()],
    register(def) {
      map.set(def.id, def);
    },
    registerAll(defs) {
      for (const d of defs) map.set(d.id, d);
    },
  };
  registry.registerAll(initial);
  return registry;
}

/**
 * Build a Signal from a partial input, filling layer/strength/family from the
 * registry when available. Unknown ids are allowed (strength defaults to
 * "weak") so experiments can emit signals before they are documented.
 */
export function createSignal(
  input: SignalInput,
  registry: SignalRegistry,
  defaults: { source: SignalSource; now?: () => number },
): Signal {
  const def = registry.get(input.id);
  const now = defaults.now ?? Date.now;
  const signal: Signal = {
    id: input.id,
    layer: input.layer ?? def?.layer ?? 'environment',
    strength: input.strength ?? def?.strength ?? 'weak',
    source: input.source ?? defaults.source,
    ts: input.ts ?? now(),
    summary: input.summary,
  };
  if (input.value !== undefined) signal.value = input.value;
  if (input.details) signal.details = input.details;
  if (input.automation !== undefined) signal.automation = input.automation;
  if (input.classes) signal.classes = input.classes;
  if (input.reliability !== undefined) signal.reliability = input.reliability;
  if (input.provider) signal.provider = input.provider;
  const family = input.family ?? def?.family;
  if (family) signal.family = family;
  return signal;
}
