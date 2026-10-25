import type { SessionEvent, SignalLayer } from '@necterai/core';
import type { SessionSummary, SessionVerdictSummary } from './types.js';

/** Automation probability at or above which a verdict counts as an "automation verdict" for time-to-detect. */
export const AUTOMATION_VERDICT_THRESHOLD = 0.9;

export type LayerCounts = Partial<Record<SignalLayer | string, number>>;

/** Timestamp of the first request the server saw for these sessions (falls back to the earliest event of any kind). */
export function firstRequestTs(events: readonly SessionEvent[]): number | undefined {
  let first: number | undefined;
  let any: number | undefined;
  for (const e of events) {
    if (any === undefined || e.ts < any) any = e.ts;
    if (e.type === 'request' && (first === undefined || e.ts < first)) first = e.ts;
  }
  return first ?? any;
}

/**
 * Milliseconds from the first request to the first verdict event whose automation probability
 * reaches `threshold`. `undefined` when no such verdict exists.
 */
export function timeToFirstAutomationVerdict(events: readonly SessionEvent[], threshold = AUTOMATION_VERDICT_THRESHOLD): number | undefined {
  const t0 = firstRequestTs(events);
  if (t0 === undefined) return undefined;
  let hit: number | undefined;
  for (const e of events) {
    if (e.type !== 'verdict') continue;
    const automation = e.data?.verdict?.automation;
    if (typeof automation !== 'number' || automation < threshold) continue;
    if (hit === undefined || e.ts < hit) hit = e.ts;
  }
  return hit === undefined ? undefined : Math.max(0, hit - t0);
}

/** Evidence items per layer in a verdict (what the engine actually counted). */
export function verdictLayerCounts(verdict: SessionVerdictSummary | undefined): LayerCounts {
  const out: LayerCounts = {};
  if (!verdict) return out;
  for (const e of verdict.evidence) {
    const layer = e.layer ?? layerOf(e.signalId);
    out[layer] = (out[layer] ?? 0) + 1;
  }
  return out;
}

/** Signals observed per layer across the whole event stream (what the SDKs emitted, counted before caps). */
export function signalLayerCounts(events: readonly SessionEvent[]): LayerCounts {
  const out: LayerCounts = {};
  for (const e of events) {
    if (e.type !== 'signal') continue;
    for (const s of e.data.signals) {
      const layer = (s as { layer?: string }).layer ?? layerOf(s.id);
      out[layer] = (out[layer] ?? 0) + 1;
    }
  }
  return out;
}

/** Signal ids are `<layer>.<what>`; used when an evidence item carries no explicit layer. */
export function layerOf(signalId: string): string {
  const dot = signalId.indexOf('.');
  return dot > 0 ? signalId.slice(0, dot) : 'unknown';
}

export function formatLayerCounts(counts: LayerCounts): string {
  const short: Record<string, string> = {
    declared: 'decl',
    request: 'req',
    network: 'net',
    environment: 'env',
    probe: 'probe',
    behavior: 'beh',
    harvest: 'harv',
    canary: 'can',
    extension: 'ext',
    consistency: 'cons',
    tie: 'tie',
    challenge: 'chal',
  };
  return Object.entries(counts)
    .filter((kv): kv is [string, number] => typeof kv[1] === 'number' && kv[1] > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, v]) => `${short[k] ?? k}:${v}`)
    .join(' ');
}

/** Merge the event streams of all sessions matched to one attacker run, ordered by time. */
export function mergedEvents(sessions: readonly SessionSummary[]): SessionEvent[] {
  const all: SessionEvent[] = [];
  for (const s of sessions) if (s.events) all.push(...s.events);
  return all.sort((a, b) => a.ts - b.ts);
}

export interface RepeatRowLike {
  attacker: string;
  detected: boolean;
  classMatch: boolean;
  skipped?: string;
  verdict?: { score: number } | undefined;
  ttfvMs?: number | undefined;
}

export interface RepeatSummary {
  attacker: string;
  runs: number;
  skipped: number;
  detected: number;
  classMatched: number;
  /** detected / runs (runs excludes skipped iterations). 0 when nothing ran. */
  detectionRate: number;
  classRate: number;
  medianScore: number | undefined;
  medianTtfvMs: number | undefined;
  /** Share of runs that produced an automation verdict at all. */
  verdictRate: number;
}

/** Collapse per-iteration rows into one summary per attacker (insertion order preserved). */
export function summarizeRepeats(rows: readonly RepeatRowLike[]): RepeatSummary[] {
  const order: string[] = [];
  const by = new Map<string, RepeatRowLike[]>();
  for (const r of rows) {
    if (!by.has(r.attacker)) {
      by.set(r.attacker, []);
      order.push(r.attacker);
    }
    by.get(r.attacker)!.push(r);
  }
  return order.map((attacker) => {
    const all = by.get(attacker)!;
    const ran = all.filter((r) => !r.skipped);
    const detected = ran.filter((r) => r.detected).length;
    const classMatched = ran.filter((r) => r.classMatch).length;
    const scores = ran.map((r) => r.verdict?.score).filter((s): s is number => typeof s === 'number');
    const ttfv = ran.map((r) => r.ttfvMs).filter((s): s is number => typeof s === 'number');
    return {
      attacker,
      runs: ran.length,
      skipped: all.length - ran.length,
      detected,
      classMatched,
      detectionRate: ran.length ? detected / ran.length : 0,
      classRate: ran.length ? classMatched / ran.length : 0,
      medianScore: median(scores),
      medianTtfvMs: median(ttfv),
      verdictRate: ran.length ? ttfv.length / ran.length : 0,
    };
  });
}

export function median(xs: readonly number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function fmtMs(ms: number | undefined): string {
  if (ms === undefined) return '';
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

export function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}
