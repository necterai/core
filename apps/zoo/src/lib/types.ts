import type { ActorClass, SessionEvent } from '@necterai/core';

export interface AttackerContext {
  base: string;
  /** Unique run tag appended to UAs or query strings so sessions can be attributed. */
  tag: string;
  /** Synthetic client IP (X-Forwarded-For) so each attacker is a distinct network client. */
  ip: string;
  headed: boolean;
  /** 1-based repeat iteration (see --repeat). */
  iteration: number;
  log(...args: unknown[]): void;
}

export interface AttackerResult {
  /** Session ids this attacker produced (cookie values seen), if known. */
  sessionIds?: string[];
  /** Substring of the UA used, to find sessions when cookies were not kept. */
  uaMarker?: string;
  startedAt: number;
  finishedAt: number;
  notes?: string[];
  error?: string;
  /** Set when the attacker decided at run time that it cannot execute here (missing tool, headless limitation...). */
  skipped?: string;
}

export interface Attacker {
  name: string;
  /** What a perfect detector should say. */
  expected: { actorClass: ActorClass | ActorClass[]; automated: boolean; provider?: string };
  /** Short description for the report. */
  description: string;
  /** Needs a visible window. */
  headed?: boolean;
  /** Needs external commands on PATH (python3, curl...). */
  requires?: string[];
  /** Richer availability check: resolves to a skip reason when the attacker cannot run on this machine. */
  check?: () => Promise<string | undefined>;
  /** False-positive probes only: signal ids (or "prefix." prefixes) produced by the test driver itself
   * (Playwright/CDP, headless window), which a real human would never emit. The row is also scored with
   * these removed, and that adjusted score decides PASS/FAIL. */
  harnessArtifacts?: string[];
  run(ctx: AttackerContext): Promise<AttackerResult>;
}

export interface SessionVerdictSummary {
  score: number;
  automation: number;
  actorClass: string;
  classConfidence: number;
  stage: string;
  deterministic: boolean;
  provider?: { id: string; confidence: number; verified: boolean };
  evidence: { signalId: string; layer?: string; contribution: number; summary: string }[];
}

export interface SessionSummary {
  id: string;
  verdict?: SessionVerdictSummary;
  last: number;
  requests: number;
  ua?: string;
  /** Full event stream for the session (fetched from /__zoo/events when available). */
  events?: SessionEvent[];
}
