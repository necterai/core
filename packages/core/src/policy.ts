import type { ActorClass, ProviderId } from './taxonomy.js';
import type { SignalLayer } from './signals.js';
import type { Verdict, VerdictStage } from './engine.js';
import { globMatch } from './util.js';

/**
 * Interventions. The browser SDK and the server SDK each implement the subset
 * that makes sense on their side; `decide()` only picks them.
 */
export type ActionKind =
  /** Let the request/session through untouched. */
  | 'allow'
  /** Log and keep watching; no user-visible effect. */
  | 'observe'
  /** Tag the request/session (header, cookie, JS flag) so the application can decide. */
  | 'label'
  /** Present an interactive proof-of-presence challenge; escalate on failure. */
  | 'challenge'
  /** Keep serving but reduce value: strip prices, scramble text glyphs, summary-only. */
  | 'degrade'
  /** Serve plausible but fake content (honeypot / labyrinth). */
  | 'decoy'
  /** Slow the session down (delayed responses, throttled API). */
  | 'tarpit'
  /** Rate limit by fingerprint/session rather than IP. */
  | 'limit'
  /** Send to an agent gateway / licensing page (HTTP 402 or 3xx). */
  | 'redirect'
  /** Deny: 403 / blocking overlay / abort API calls. */
  | 'block'
  /** Fire a webhook or callback. */
  | 'notify';

export interface Action {
  kind: ActionKind;
  params?: Record<string, unknown>;
}

export interface RuleMatch {
  classes?: ActorClass[];
  notClasses?: ActorClass[];
  providers?: ProviderId[];
  /** Inclusive lower bound on verdict.automation (0..1). */
  minAutomation?: number;
  /** Exclusive upper bound on verdict.automation. */
  maxAutomation?: number;
  minClassConfidence?: number;
  /** Require (true) or forbid (false) a deterministic signal. */
  deterministic?: boolean;
  /** Require (true) or forbid (false) a verified provider attribution. */
  verified?: boolean;
  /** Any of these signal ids present in evidence. */
  anySignal?: string[];
  /** Evidence must include at least one signal from each of these layers. */
  requireLayers?: SignalLayer[];
  /** Glob patterns on the request path. */
  paths?: string[];
  notPaths?: string[];
  methods?: string[];
  stages?: VerdictStage[];
  /** Arbitrary tags the integrator sets on the context (e.g. 'authenticated'). */
  tags?: string[];
}

export interface PolicyRule {
  id: string;
  description?: string;
  when: RuleMatch;
  actions: Action[];
  /** Stop evaluating further rules when matched (default true). */
  terminal?: boolean;
  /** Disabled rules are skipped; handy for staged rollouts. */
  enabled?: boolean;
}

export interface Policy {
  /** Evaluated in order. */
  rules: PolicyRule[];
  /** Used when no rule matched. */
  defaultActions: Action[];
  /** Global mode: 'enforce' applies actions, 'monitor' downgrades everything to observe+label. */
  mode?: 'enforce' | 'monitor';
}

export interface PolicyContext {
  path?: string;
  method?: string;
  host?: string;
  tags?: string[];
}

export interface Decision {
  actions: Action[];
  matchedRules: string[];
  /** The most severe action kind, for quick branching. */
  primary: ActionKind;
  mode: 'enforce' | 'monitor';
}

const SEVERITY: Record<ActionKind, number> = {
  allow: 0,
  observe: 1,
  notify: 2,
  label: 3,
  limit: 4,
  tarpit: 5,
  degrade: 6,
  decoy: 7,
  challenge: 8,
  redirect: 9,
  block: 10,
};

export function actionSeverity(kind: ActionKind): number {
  return SEVERITY[kind];
}

export function ruleMatches(rule: RuleMatch, verdict: Verdict, ctx: PolicyContext = {}): boolean {
  if (rule.classes && !rule.classes.includes(verdict.actorClass)) return false;
  if (rule.notClasses && rule.notClasses.includes(verdict.actorClass)) return false;
  if (rule.providers) {
    if (!verdict.provider || !rule.providers.includes(verdict.provider.id)) return false;
  }
  if (rule.minAutomation !== undefined && verdict.automation < rule.minAutomation) return false;
  if (rule.maxAutomation !== undefined && verdict.automation >= rule.maxAutomation) return false;
  if (rule.minClassConfidence !== undefined && verdict.classConfidence < rule.minClassConfidence) return false;
  if (rule.deterministic !== undefined && verdict.deterministic !== rule.deterministic) return false;
  if (rule.verified !== undefined && Boolean(verdict.provider?.verified) !== rule.verified) return false;
  if (rule.anySignal && !verdict.evidence.some((e) => rule.anySignal!.includes(e.signalId))) return false;
  if (rule.requireLayers && !rule.requireLayers.every((l) => verdict.layers.includes(l))) return false;
  if (rule.stages && !rule.stages.includes(verdict.stage)) return false;
  if (rule.paths) {
    const p = ctx.path ?? '/';
    if (!rule.paths.some((g) => globMatch(g, p))) return false;
  }
  if (rule.notPaths) {
    const p = ctx.path ?? '/';
    if (rule.notPaths.some((g) => globMatch(g, p))) return false;
  }
  if (rule.methods && ctx.method && !rule.methods.map((m) => m.toUpperCase()).includes(ctx.method.toUpperCase())) return false;
  if (rule.tags && !rule.tags.every((t) => ctx.tags?.includes(t))) return false;
  return true;
}

export function decide(verdict: Verdict, policy: Policy, ctx: PolicyContext = {}): Decision {
  const mode = policy.mode ?? 'enforce';
  const actions: Action[] = [];
  const matchedRules: string[] = [];
  for (const rule of policy.rules) {
    if (rule.enabled === false) continue;
    if (!ruleMatches(rule.when, verdict, ctx)) continue;
    matchedRules.push(rule.id);
    actions.push(...rule.actions);
    if (rule.terminal !== false) break;
  }
  if (actions.length === 0) actions.push(...policy.defaultActions);
  let effective = actions;
  if (mode === 'monitor') {
    // Monitor mode never changes what the visitor sees, but keeps the labels and logs.
    effective = [
      { kind: 'observe', params: { wouldHave: actions.map((a) => a.kind) } },
      ...actions.filter((a) => a.kind === 'label' || a.kind === 'notify'),
    ];
  }
  const primary = effective.reduce<ActionKind>((best, a) => (SEVERITY[a.kind] > SEVERITY[best] ? a.kind : best), 'allow');
  return { actions: effective, matchedRules, primary, mode };
}

/**
 * Sensible defaults: welcome verified search/utility bots, keep AI crawlers and
 * fetch agents out (or send them to an agent gateway), challenge browser-driven
 * agents unless the evidence is deterministic, and never act on weak evidence.
 */
export function defaultPolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    mode: 'enforce',
    rules: [
      {
        id: 'allow-verified-search',
        description: 'Verified search engine crawlers and utility bots are welcome.',
        when: { classes: ['search-crawler', 'utility-bot'], verified: true },
        actions: [{ kind: 'allow' }, { kind: 'label' }],
      },
      {
        id: 'block-ai-crawlers',
        description: 'Training / AI-search crawlers are refused with a clear 403 and a pointer to the agent gateway.',
        when: { classes: ['ai-crawler'], minAutomation: 0.9 },
        actions: [{ kind: 'block', params: { reason: 'ai-crawler' } }, { kind: 'label' }],
      },
      {
        id: 'gateway-fetch-agents',
        description: 'On-demand fetchers are redirected to the agent gateway where terms/licensing apply.',
        when: { classes: ['fetch-agent'], minAutomation: 0.85 },
        actions: [{ kind: 'redirect', params: { to: '/.well-known/agent-access', status: 402 } }, { kind: 'label' }],
      },
      {
        id: 'block-deterministic-automation',
        description: 'A deterministic automation proof (CDP binding, Playwright/Puppeteer marker, failed challenge, canary hit) is blocked outright.',
        when: { classes: ['browser-agent', 'computer-use-agent', 'extension-agent', 'scripted-automation', 'unknown'], deterministic: true, minAutomation: 0.97 },
        actions: [{ kind: 'block', params: { reason: 'automation' } }, { kind: 'label' }, { kind: 'notify' }],
      },
      {
        id: 'challenge-likely-agents',
        description: 'Strong but not deterministic evidence gets a proof-of-presence challenge.',
        when: { classes: ['browser-agent', 'computer-use-agent', 'extension-agent', 'scripted-automation', 'unknown'], minAutomation: 0.9 },
        actions: [{ kind: 'challenge' }, { kind: 'label' }],
      },
      {
        id: 'observe-unverified-crawler-claims',
        description: 'Clients claiming to be search/utility bots without passing verification are observed and labelled; flip to challenge/block once network verification is enabled for your traffic.',
        when: { classes: ['search-crawler', 'utility-bot'], verified: false },
        actions: [{ kind: 'observe' }, { kind: 'label', params: { unverifiedClaim: true } }],
      },
      {
        id: 'degrade-suspicious',
        description: 'Moderate evidence: keep serving, but degrade and label; the app can decide.',
        when: { minAutomation: 0.7, notClasses: ['human', 'human-assisted', 'search-crawler', 'utility-bot'] },
        actions: [{ kind: 'degrade', params: { level: 'light' } }, { kind: 'label' }, { kind: 'limit' }],
      },
      {
        id: 'observe-human-assisted',
        description: 'A person with an AI assistant: allowed, but labelled so the app may hide sensitive data from the assistant.',
        when: { classes: ['human-assisted'] },
        actions: [{ kind: 'label', params: { assisted: true } }, { kind: 'observe' }],
      },
    ],
    defaultActions: [{ kind: 'allow' }],
    ...overrides,
  };
}
