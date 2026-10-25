import type { Signal } from './signals.js';
import type { Verdict } from './engine.js';
import type { Decision } from './policy.js';

/**
 * Session event schema. Everything the review/replay service will need is
 * emitted now, in this shape, so the backend can be added later without
 * changing the SDKs.
 */
export type SessionEventType =
  | 'session' // session created / resumed / ended
  | 'request' // server saw an HTTP request
  | 'signal' // one or more signals observed
  | 'verdict' // engine evaluated
  | 'decision' // policy picked actions
  | 'intervention' // an action was executed (client or server)
  | 'interaction' // compact behavioural summary (for replay timelines)
  | 'challenge' // challenge issued / passed / failed
  | 'canary' // canary token touched
  | 'recording' // raw recorder chunk (rrweb-compatible later)
  | 'error';

export interface SessionEventBase {
  id: string;
  sessionId: string;
  ts: number;
  source: 'client' | 'server';
  type: SessionEventType;
  /** Page URL or request URL when relevant. */
  url?: string;
}

export interface SignalEvent extends SessionEventBase {
  type: 'signal';
  data: { signals: Signal[] };
}
export interface VerdictEvent extends SessionEventBase {
  type: 'verdict';
  data: { verdict: Verdict };
}
export interface DecisionEvent extends SessionEventBase {
  type: 'decision';
  data: { decision: Decision; verdictTs: number; path?: string };
}
export interface InterventionEvent extends SessionEventBase {
  type: 'intervention';
  data: { kind: string; params?: Record<string, unknown>; ok: boolean; detail?: string };
}
export interface RequestEvent extends SessionEventBase {
  type: 'request';
  data: {
    method: string;
    path: string;
    status?: number;
    ip?: string;
    ua?: string;
    headers?: Record<string, string>;
    /** Duration in ms if known. */
    durationMs?: number;
  };
}
export interface InteractionEvent extends SessionEventBase {
  type: 'interaction';
  data: InteractionSummary;
}
export interface ChallengeEvent extends SessionEventBase {
  type: 'challenge';
  data: { challengeId: string; kind: string; outcome: 'issued' | 'passed' | 'failed' | 'abandoned'; detail?: Record<string, unknown> };
}
export interface CanaryEvent extends SessionEventBase {
  type: 'canary';
  data: { token: string; kind: 'link' | 'field' | 'instruction' | 'endpoint' | 'text-selection' | 'other'; detail?: Record<string, unknown> };
}
export interface RecordingEvent extends SessionEventBase {
  type: 'recording';
  data: { format: 'rrweb' | 'necter-lite'; chunk: unknown };
}
/** Values the browser SDK reports so the server can cross-check them against request headers (tie layer). */
export interface ClientHints {
  ua?: string;
  languages?: string[];
  platform?: string;
  brands?: { brand: string; version: string }[];
  mobile?: boolean;
  uaPlatform?: string;
  timezone?: string;
  screen?: { width: number; height: number; dpr: number };
  viewport?: { width: number; height: number };
  hardwareConcurrency?: number;
  deviceMemory?: number;
}

export interface SessionLifecycleEvent extends SessionEventBase {
  type: 'session';
  data: { action: 'start' | 'resume' | 'end'; firstVisit?: boolean; ua?: string; referrer?: string; hints?: ClientHints };
}
export interface ErrorEvent extends SessionEventBase {
  type: 'error';
  data: { message: string; where?: string };
}

export type SessionEvent =
  | SignalEvent
  | VerdictEvent
  | DecisionEvent
  | InterventionEvent
  | RequestEvent
  | InteractionEvent
  | ChallengeEvent
  | CanaryEvent
  | RecordingEvent
  | SessionLifecycleEvent
  | ErrorEvent;

/**
 * Compact behavioural summary emitted periodically by the browser SDK. This is
 * intentionally aggregate (no raw coordinates by default) so it is cheap and
 * privacy-preserving, yet enough to reconstruct a timeline during review.
 */
export interface InteractionSummary {
  windowMs: number;
  pointer: {
    moves: number;
    clicks: number;
    /** Fraction of clicks within 1px of the target element centre. */
    centerClickRatio: number;
    /** Mean straightness of pre-click paths (1 = perfectly straight). */
    meanPathLinearity: number;
    /** Mean number of mousemove events in the 500 ms before a click. */
    meanMovesBeforeClick: number;
    /** Median hover dwell before click in ms. */
    medianHoverMs: number;
    /** Share of pointer events whose coordinates are integers (vs fractional). */
    integerCoordRatio: number;
    /** Estimated coordinate lattice spacing in CSS px if quantisation detected, else 0. */
    latticeSpacing: number;
    /** Share of clicks that are isTrusted. */
    trustedRatio: number;
  };
  keyboard: {
    keydowns: number;
    inputsWithoutKeys: number;
    /** Coefficient of variation of inter-key intervals (0 = metronome). */
    interKeyCv: number;
    pastes: number;
  };
  scroll: {
    wheelEvents: number;
    scrollEvents: number;
    programmaticScrolls: number;
    /** Most common |deltaY|, 0 if none. */
    modalDelta: number;
  };
  timing: {
    firstInteractionMs: number;
    /** Inter-action gaps in ms (p50/p90). */
    gapP50: number;
    gapP90: number;
    idleMoves: number;
  };
  focus: { hasFocus: boolean; visible: boolean };
}

export interface EventSink {
  write(events: SessionEvent[]): void | Promise<void>;
  flush?(): void | Promise<void>;
}

export function createMemorySink(limit = 10_000): EventSink & { events: SessionEvent[]; clear(): void } {
  const events: SessionEvent[] = [];
  return {
    events,
    write(batch) {
      for (const e of batch) {
        events.push(e);
        if (events.length > limit) events.shift();
      }
    },
    clear() {
      events.length = 0;
    },
  };
}

export function createConsoleSink(log: (line: string) => void = (l) => console.log(l)): EventSink {
  return {
    write(batch) {
      for (const e of batch) log(JSON.stringify(e));
    },
  };
}

export function createFanoutSink(...sinks: EventSink[]): EventSink {
  return {
    async write(batch) {
      await Promise.all(sinks.map((s) => s.write(batch)));
    },
    async flush() {
      await Promise.all(sinks.map((s) => s.flush?.()));
    },
  };
}
