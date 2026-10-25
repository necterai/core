import type {
  Action,
  ActionKind,
  Decision,
  Policy,
  SessionEvent,
  Signal,
  SignalInput,
  SignalRegistry,
  Verdict,
  VerdictStage,
} from '@necterai/core';

export type ModuleName =
  | 'environment'
  | 'probes'
  | 'behavior'
  | 'harvest'
  | 'canary'
  | 'extension'
  | 'consistency';

export interface BeaconConfig {
  enabled: boolean;
  /** Flush interval in ms (default 5000). */
  intervalMs: number;
  /** Max events per batch (default 50). */
  maxBatch: number;
  /** Include the full verdict in every beacon (default true). */
  includeVerdict: boolean;
}

export interface CanaryConfig {
  enabled: boolean;
  /** Where hidden canary links point; the server records hits. Default `${endpoint}/canary/`. */
  path?: string;
  /** Add a visually hidden honeypot field to forms (default true). */
  forms: boolean;
  /** Insert the hidden instruction block (default true). */
  instructions: boolean;
}

export interface ChallengeConfig {
  /** 'kinematic' (built-in slider) or 'custom' (integrator supplies `run`). */
  kind: 'kinematic' | 'custom';
  run?: () => Promise<boolean>;
  /** Max attempts before escalation to block (default 2). */
  attempts: number;
  /** Action to apply when the challenge fails (default block). */
  onFail: ActionKind;
}

export interface InterventionUIText {
  blockTitle: string;
  blockBody: string;
  challengeTitle: string;
  challengeBody: string;
  gatewayUrl: string;
}

export interface NecterConfig {
  /** Base path of the server endpoints. Default '/__necter'. */
  endpoint?: string;
  /** Optional tenant / site identifier forwarded in beacons. */
  siteKey?: string;
  /** 'monitor' only labels and reports; 'enforce' applies interventions locally. Default 'monitor'. */
  mode?: 'monitor' | 'enforce';
  /** Client-side policy. Defaults to the core default policy in the configured mode. */
  policy?: Policy;
  /** Enable/disable modules or pass module options. All enabled by default. */
  modules?: Partial<Record<ModuleName, boolean | Record<string, unknown>>>;
  beacon?: Partial<BeaconConfig>;
  canary?: Partial<CanaryConfig>;
  challenge?: Partial<ChallengeConfig>;
  /** Origins (or URL prefixes) of the site's own scripts; DOM reads from them are not "harvesting". */
  trustedScriptOrigins?: string[];
  /** CSS selectors of sensitive content for the `degrade` action (prices, emails, article bodies...). */
  sensitiveSelectors?: string[];
  /** Verbose console logging and the floating evidence panel. */
  debug?: boolean;
  /** Minimum ms between evaluations triggered by behavioural signals. Default 750. */
  evaluateThrottleMs?: number;
  /** Provide a session id (e.g. from a server cookie) instead of generating one. */
  sessionId?: string;
  /** Text shown by the built-in interventions. */
  text?: Partial<InterventionUIText>;
  /** Override or extend intervention handlers. */
  interventions?: Partial<Record<ActionKind, InterventionHandler>>;
  /** Extra signal definitions to register. */
  signalDefinitions?: import('@necterai/core').SignalDefinition[];
  onVerdict?(verdict: Verdict): void;
  onDecision?(decision: Decision, verdict: Verdict): void;
  onSignal?(signal: Signal): void;
  onIntervention?(action: Action, ok: boolean): void;
}

export interface ResolvedConfig {
  endpoint: string;
  siteKey?: string;
  mode: 'monitor' | 'enforce';
  policy: Policy;
  modules: Record<ModuleName, false | Record<string, unknown>>;
  beacon: BeaconConfig;
  canary: CanaryConfig;
  challenge: ChallengeConfig;
  trustedScriptOrigins: string[];
  sensitiveSelectors: string[];
  debug: boolean;
  evaluateThrottleMs: number;
  text: InterventionUIText;
  interventions: Partial<Record<ActionKind, InterventionHandler>>;
  onVerdict?: NecterConfig['onVerdict'];
  onDecision?: NecterConfig['onDecision'];
  onSignal?: NecterConfig['onSignal'];
  onIntervention?: NecterConfig['onIntervention'];
}

export interface Session {
  id: string;
  /** True when no prior storage/cookie state existed for this origin. */
  firstVisit: boolean;
  /** Epoch ms when the session was created in this tab. */
  startedAt: number;
  /** Page views counted in this session (persisted). */
  pageViews: number;
}

export interface Scheduler {
  /** Run when the main thread is idle (requestIdleCallback or a timeout fallback). */
  idle(fn: () => void, timeoutMs?: number): () => void;
  timeout(fn: () => void, ms: number): () => void;
  every(fn: () => void, ms: number): () => void;
  raf(fn: (t: number) => void): () => void;
  /** Cancel everything scheduled through this scheduler. */
  dispose(): void;
}

export type EventInput =
  | { type: 'interaction'; data: Extract<SessionEvent, { type: 'interaction' }>['data'] }
  | { type: 'canary'; data: Extract<SessionEvent, { type: 'canary' }>['data'] }
  | { type: 'challenge'; data: Extract<SessionEvent, { type: 'challenge' }>['data'] }
  | { type: 'intervention'; data: Extract<SessionEvent, { type: 'intervention' }>['data'] }
  | { type: 'recording'; data: Extract<SessionEvent, { type: 'recording' }>['data'] }
  | { type: 'error'; data: Extract<SessionEvent, { type: 'error' }>['data'] };

export interface ModuleContext {
  readonly config: ResolvedConfig;
  readonly session: Session;
  readonly registry: SignalRegistry;
  readonly schedule: Scheduler;
  /** Module-specific options from config.modules[name] (empty object when enabled with `true`). */
  readonly options: Record<string, unknown>;
  now(): number;
  /** Record a signal (latest per id wins) and schedule an evaluation. */
  emit(input: SignalInput): Signal;
  /** Remove a previously emitted signal (e.g. a behavioural hypothesis that no longer holds). */
  retract(id: string): void;
  /** Emit a non-signal session event (interaction summaries, canary hits, errors...). */
  event(e: EventInput): void;
  /** Ask for an evaluation; throttled unless `immediate`. */
  requestEvaluate(reason: string, opts?: { stage?: VerdictStage; immediate?: boolean }): void;
  /** Mark the session as finally decided (deterministic proof, challenge outcome). */
  finalize(reason: string): void;
  log(...args: unknown[]): void;
  /** Current verdict snapshot. */
  verdict(): Verdict;
}

export interface Module {
  name: ModuleName;
  start(ctx: ModuleContext): void | Promise<void>;
  stop?(): void;
}

export interface InterventionContext {
  config: ResolvedConfig;
  verdict: Verdict;
  decision: Decision;
  session: Session;
  /** Run the configured challenge; resolves with pass/fail. */
  challenge(): Promise<boolean>;
  /** Apply another action (e.g. escalate to block after a failed challenge). */
  apply(action: Action): Promise<boolean>;
  log(...args: unknown[]): void;
  event(e: EventInput): void;
}

export type InterventionHandler = (action: Action, ctx: InterventionContext) => boolean | Promise<boolean>;

export type NecterEventMap = {
  signal: Signal;
  verdict: Verdict;
  decision: { decision: Decision; verdict: Verdict };
  intervention: { action: Action; ok: boolean };
  final: Verdict;
};

export interface Necter {
  readonly version: string;
  readonly sessionId: string;
  readonly config: ResolvedConfig;
  /** Latest verdict (re-evaluated as evidence arrives). */
  readonly verdict: Verdict;
  /** Current signals (latest per id). */
  readonly signals: Signal[];
  on<K extends keyof NecterEventMap>(event: K, handler: (payload: NecterEventMap[K]) => void): () => void;
  /** Force an evaluation now and return the verdict. */
  evaluate(stage?: VerdictStage): Verdict;
  /** Apply an action through the intervention runner. */
  intervene(action: Action): Promise<boolean>;
  /** Run the challenge flow; resolves with pass/fail. */
  challenge(): Promise<boolean>;
  /** Headers the application can attach to its own API calls (session id + label). */
  headers(): Record<string, string>;
  /** Flush pending beacons now. */
  flush(): Promise<void>;
  destroy(): void;
}
