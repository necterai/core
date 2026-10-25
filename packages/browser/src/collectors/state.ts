/**
 * Shared environment state. The environment module fills it (synchronously at
 * start, then as deferred collectors finish); the consistency module reads it to
 * apply the privacy-browser gating and to reuse WebGL / font / worker facts
 * without probing twice. Boot order is environment -> probes -> consistency, but
 * `ensureEnvironmentState` also works when the environment module is disabled.
 */
import { createRealEnv, type Env, type EnvWebGL, type WorkerSnapshot } from './env.js';
import { detectPrivacyMode, privacyInputFromEnv, type PrivacyResult } from './privacy.js';
import { parseUA, type ParsedUA } from './ua.js';

/** Facts the deferred collectors contribute; consumed by hosted-profile matching and consistency. */
export interface EnvironmentFeatures {
  webgl?: EnvWebGL | null;
  /** Font probe results (font name -> present). */
  fonts?: Map<string, boolean>;
  /** Share of permissions.query calls that rejected (0..1). */
  permissionsQueryFailRate?: number;
  /** Share of permissions.query calls resolving 'denied'. */
  permissionsDeniedRate?: number;
  worker?: WorkerSnapshot | null;
  /** Main-thread vs worker navigator.platform differ. */
  workerPlatformMismatch?: boolean;
  voices?: { total: number; google: number };
  mediaDevices?: number;
}

export interface EnvironmentState {
  readonly env: Env;
  readonly ua: ParsedUA;
  privacy: PrivacyResult;
  readonly features: EnvironmentFeatures;
  /** Subscribe to changes (privacy mode flips, new features). Returns an unsubscribe. */
  onChange(fn: (state: EnvironmentState) => void): () => void;
  /** Merge features and notify. */
  update(features: Partial<EnvironmentFeatures>): void;
  /** Re-run privacy detection with an optional canvas-noise observation; notifies when the result changes. */
  refreshPrivacy(canvasNoise?: boolean): PrivacyResult;
  /** Force a privacy result (e.g. Brave isBrave() confirmation). */
  setPrivacy(result: PrivacyResult): void;
}

let current: EnvironmentState | undefined;

export function createEnvironmentState(env: Env): EnvironmentState {
  const listeners = new Set<(s: EnvironmentState) => void>();
  const features: EnvironmentFeatures = {};
  let canvasNoiseSeen: boolean | undefined;
  const state: EnvironmentState = {
    env,
    ua: parseUA(env.userAgent),
    privacy: detectPrivacyMode(privacyInputFromEnv(env)),
    features,
    onChange(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    update(partial) {
      Object.assign(features, partial);
      notify();
    },
    refreshPrivacy(canvasNoise) {
      if (canvasNoise !== undefined) canvasNoiseSeen = canvasNoise;
      const next = detectPrivacyMode(privacyInputFromEnv(env, canvasNoiseSeen));
      if (next.active !== state.privacy.active || next.kinds.join() !== state.privacy.kinds.join()) {
        state.privacy = next;
        notify();
      }
      return state.privacy;
    },
    setPrivacy(result) {
      state.privacy = result;
      notify();
    },
  };
  function notify(): void {
    for (const fn of listeners) {
      try {
        fn(state);
      } catch {
        /* listeners never break the host page */
      }
    }
  }
  return state;
}

/** Installs a state as the shared singleton (the environment module does this at start). */
export function setEnvironmentState(state: EnvironmentState): EnvironmentState {
  current = state;
  return state;
}

/** Returns the shared state, creating one over the real environment when none exists yet. */
export function ensureEnvironmentState(env?: Env): EnvironmentState {
  if (!current) current = createEnvironmentState(env ?? createRealEnv());
  return current;
}

/** Test hook: drop the shared singleton. */
export function resetEnvironmentState(): void {
  current = undefined;
}
