import type { ActorClass, ProviderHint, SignalInput } from '@necterai/core';
import { PRIVACY_RELIABILITY } from './privacy.js';

/**
 * A collector's decision before it becomes a Signal: the pure analysis functions
 * return Findings so tests can assert on them without a ModuleContext, and the
 * module applies the privacy-browser gating when it emits.
 */
export interface Finding {
  id: string;
  /** One evidence sentence with the measured values. */
  summary: string;
  value?: unknown;
  details?: Record<string, unknown>;
  /** 0..1 reliability of this observation (default 1). */
  reliability?: number;
  provider?: ProviderHint;
  /** Override of the registry class profile (hosted profiles attribute per vendor). */
  classes?: Partial<Record<ActorClass, number>>;
  /** Multiply reliability by PRIVACY_RELIABILITY while an anti-fingerprinting mode is active. */
  privacyGated?: boolean;
}

export function toSignalInput(f: Finding, privacyActive: boolean): SignalInput {
  const input: SignalInput = { id: f.id, summary: f.summary };
  if (f.value !== undefined) input.value = f.value;
  if (f.details) input.details = f.details;
  if (f.provider) input.provider = f.provider;
  if (f.classes) input.classes = f.classes;
  let reliability = f.reliability ?? 1;
  if (f.privacyGated && privacyActive) reliability *= PRIVACY_RELIABILITY;
  if (reliability !== 1) input.reliability = round3(reliability);
  return input;
}

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function fmtSize(w: number, h: number): string {
  return `${w}x${h}`;
}
