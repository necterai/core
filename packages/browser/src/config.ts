import { DEFAULT_ENDPOINT_PREFIX, defaultPolicy } from '@necterai/core';
import type { NecterConfig, ModuleName, ResolvedConfig } from './types.js';

const MODULE_NAMES: ModuleName[] = ['environment', 'probes', 'behavior', 'harvest', 'canary', 'extension', 'consistency'];

export function resolveConfig(input: NecterConfig = {}): ResolvedConfig {
  const mode = input.mode ?? 'monitor';
  const modules = {} as Record<ModuleName, false | Record<string, unknown>>;
  for (const name of MODULE_NAMES) {
    const v = input.modules?.[name];
    modules[name] = v === false ? false : typeof v === 'object' && v !== null ? v : {};
  }
  const endpoint = (input.endpoint ?? DEFAULT_ENDPOINT_PREFIX).replace(/\/$/, '');
  const cfg: ResolvedConfig = {
    endpoint,
    mode,
    policy: input.policy ?? defaultPolicy({ mode }),
    modules,
    beacon: {
      enabled: input.beacon?.enabled ?? true,
      intervalMs: input.beacon?.intervalMs ?? 5000,
      maxBatch: input.beacon?.maxBatch ?? 50,
      includeVerdict: input.beacon?.includeVerdict ?? true,
    },
    canary: {
      enabled: input.canary?.enabled ?? true,
      forms: input.canary?.forms ?? true,
      instructions: input.canary?.instructions ?? true,
      ...(input.canary?.path ? { path: input.canary.path } : {}),
    },
    challenge: {
      kind: input.challenge?.kind ?? 'kinematic',
      attempts: input.challenge?.attempts ?? 2,
      onFail: input.challenge?.onFail ?? 'block',
      ...(input.challenge?.run ? { run: input.challenge.run } : {}),
    },
    trustedScriptOrigins: input.trustedScriptOrigins ?? [],
    sensitiveSelectors: input.sensitiveSelectors ?? ['[data-sensitive]', '.price', 'article', 'main table'],
    debug: input.debug ?? false,
    evaluateThrottleMs: input.evaluateThrottleMs ?? 750,
    text: {
      blockTitle: 'Automated access is not permitted',
      blockBody: 'This site does not allow automated agents. If you are a person, reload the page or contact the site owner.',
      challengeTitle: 'Quick check',
      challengeBody: 'Drag the handle to the end to continue.',
      gatewayUrl: '/.well-known/agent-access',
      ...(input.text ?? {}),
    },
    interventions: input.interventions ?? {},
  };
  if (input.siteKey) cfg.siteKey = input.siteKey;
  if (input.onVerdict) cfg.onVerdict = input.onVerdict;
  if (input.onDecision) cfg.onDecision = input.onDecision;
  if (input.onSignal) cfg.onSignal = input.onSignal;
  if (input.onIntervention) cfg.onIntervention = input.onIntervention;
  return cfg;
}
