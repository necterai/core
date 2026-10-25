import { describe, expect, it } from 'vitest';
import {
  createEngine,
  createRegistry,
  createSignal,
  decide,
  defaultPolicy,
  globMatch,
  mergeSignals,
  sigmoid,
  type Signal,
  type SignalDefinition,
} from '../src/index.js';

const defs: SignalDefinition[] = [
  { id: 'probe.playwright-binding', layer: 'probe', strength: 'deterministic', automation: 8, classes: { 'browser-agent': 6 }, description: 'Playwright binding present', source: 'client' },
  { id: 'env.webdriver', layer: 'environment', strength: 'strong', automation: 3, classes: { 'browser-agent': 2 }, family: 'env.automation-flag', description: 'navigator.webdriver', source: 'client' },
  { id: 'env.headless-ua', layer: 'environment', strength: 'strong', automation: 3, classes: { 'browser-agent': 1.5 }, family: 'env.automation-flag', description: 'HeadlessChrome UA', source: 'client' },
  { id: 'env.swiftshader', layer: 'environment', strength: 'moderate', automation: 1.5, family: 'env.container', description: 'software GL', source: 'client' },
  { id: 'env.no-media-devices', layer: 'environment', strength: 'moderate', automation: 1.2, family: 'env.container', description: 'no mic/cam', source: 'client' },
  { id: 'env.utc-timezone', layer: 'environment', strength: 'weak', automation: 0.6, family: 'env.container', description: 'UTC', source: 'client' },
  { id: 'env.linux-fonts', layer: 'environment', strength: 'weak', automation: 0.6, family: 'env.container', description: 'container fonts', source: 'client' },
  { id: 'beh.natural-pointer', layer: 'behavior', strength: 'strong', automation: -3, description: 'human kinematics', source: 'client' },
  { id: 'beh.center-clicks', layer: 'behavior', strength: 'strong', automation: 2.5, classes: { 'browser-agent': 2, 'computer-use-agent': 0.5 }, description: 'clicks at exact centres', source: 'client' },
  { id: 'beh.teleport-clicks', layer: 'behavior', strength: 'strong', automation: 2.5, classes: { 'computer-use-agent': 2.5 }, description: 'no mousemove before click', source: 'client' },
  { id: 'declared.ai-ua', layer: 'declared', strength: 'strong', automation: 3.5, classes: { 'fetch-agent': 2 }, description: 'AI UA', source: 'server' },
  { id: 'network.ip-range-verified', layer: 'network', strength: 'deterministic', automation: 7, classes: { 'fetch-agent': 2 }, description: 'published IP range', source: 'server' },
  { id: 'extension.assistant-present', layer: 'extension', strength: 'weak', automation: 0, classes: { 'human-assisted': 1.5 }, description: 'AI browser assistant detected', source: 'client' },
];

const registry = createRegistry(defs);
const engine = createEngine({ registry, now: () => 1000 });
const mk = (id: string, extra: Partial<Signal> = {}): Signal =>
  createSignal({ id, summary: id, ...extra }, registry, { source: 'client', now: () => 1000 });

describe('engine', () => {
  it('starts near the human prior with no signals', () => {
    const v = engine.evaluate([], { sessionId: 's', stage: 'load' });
    expect(v.actorClass).toBe('human');
    expect(v.automation).toBeCloseTo(sigmoid(-2.44), 3);
    expect(v.deterministic).toBe(false);
  });

  it('a deterministic probe yields a near-certain browser-agent verdict', () => {
    const v = engine.evaluate([mk('probe.playwright-binding')], { sessionId: 's', stage: 'load' });
    expect(v.automation).toBeGreaterThan(0.99);
    expect(v.actorClass).toBe('browser-agent');
    expect(v.deterministic).toBe(true);
    expect(v.evidence[0]!.signalId).toBe('probe.playwright-binding');
  });

  it('caps correlated environment tells so a privacy browser is not blocked', () => {
    const v = engine.evaluate(
      ['env.swiftshader', 'env.no-media-devices', 'env.utc-timezone', 'env.linux-fonts'].map((id) => mk(id)),
      { sessionId: 's', stage: 'load' },
    );
    // raw sum = 3.9 but family cap 3.5 and layer cap 3.5 apply: logit = -2.44 + 3.5
    expect(v.logit).toBeCloseTo(-2.44 + 3.5, 3);
    expect(v.automation).toBeLessThan(0.8);
    const sum = v.evidence.reduce((s, e) => s + e.contribution, 0);
    expect(sum).toBeCloseTo(3.5, 3);
  });

  it('deterministic signals in a family do not stack', () => {
    const a = mk('probe.playwright-binding');
    const b = mk('probe.playwright-binding', { ts: 2000 });
    const v = engine.evaluate([a, b], { sessionId: 's', stage: 'load' });
    expect(v.signalCount).toBe(1);
    expect(v.logit).toBeCloseTo(-2.44 + 8, 3);
  });

  it('human kinematics pull the score down against environment tells', () => {
    const v = engine.evaluate([mk('env.webdriver'), mk('beh.natural-pointer')], { sessionId: 's', stage: 'interaction' });
    expect(v.automation).toBeLessThan(0.5);
    expect(v.actorClass).toBe('human');
  });

  it('attributes classes by relative evidence', () => {
    const v = engine.evaluate([mk('env.webdriver'), mk('beh.teleport-clicks')], { sessionId: 's', stage: 'interaction' });
    expect(v.automation).toBeGreaterThan(0.5);
    expect(v.actorClass).toBe('computer-use-agent');
    expect(v.classScores['computer-use-agent']).toBeGreaterThan(v.classScores['browser-agent'] ?? 0);
  });

  it('aggregates provider hints and prefers verified ones', () => {
    const declared = mk('declared.ai-ua', { source: 'server', provider: { id: 'openai', product: 'ChatGPT-User', confidence: 0.6 } });
    const verified = mk('network.ip-range-verified', {
      source: 'server',
      provider: { id: 'openai', product: 'ChatGPT-User', confidence: 0.99 },
      details: { verification: 'passed', method: 'ip-range' },
    });
    const v = engine.evaluate([declared, verified], { sessionId: 's', stage: 'request' });
    expect(v.provider?.id).toBe('openai');
    expect(v.provider?.verified).toBe(true);
    expect(v.provider?.method).toBe('ip-range');
    expect(v.provider?.confidence).toBeGreaterThan(0.99);
    expect(v.actorClass).toBe('fetch-agent');
  });

  it('labels human-assisted sessions without raising automation', () => {
    const v = engine.evaluate([mk('extension.assistant-present')], { sessionId: 's', stage: 'load' });
    expect(v.actorClass).toBe('human-assisted');
    expect(v.automation).toBeLessThan(0.2);
  });

  it('respects reliability multipliers', () => {
    const v = engine.evaluate([mk('env.webdriver', { reliability: 0.5 })], { sessionId: 's', stage: 'load' });
    expect(v.logit).toBeCloseTo(-2.44 + 1.5, 3);
  });

  it('merges by id keeping the newest', () => {
    const merged = mergeSignals([mk('env.webdriver', { ts: 1 })], [mk('env.webdriver', { ts: 5, summary: 'new' })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.summary).toBe('new');
  });
});

describe('policy', () => {
  const policy = defaultPolicy();
  it('blocks deterministic browser agents', () => {
    const v = engine.evaluate([mk('probe.playwright-binding')], { sessionId: 's', stage: 'load' });
    const d = decide(v, policy, { path: '/products' });
    expect(d.primary).toBe('block');
    expect(d.matchedRules).toContain('block-deterministic-automation');
  });
  it('allows humans by default', () => {
    const v = engine.evaluate([], { sessionId: 's', stage: 'load' });
    expect(decide(v, policy).primary).toBe('allow');
  });
  it('monitor mode never enforces', () => {
    const v = engine.evaluate([mk('probe.playwright-binding')], { sessionId: 's', stage: 'load' });
    const d = decide(v, defaultPolicy({ mode: 'monitor' }));
    expect(d.primary).toBe('label');
    expect(d.actions[0]!.params?.['wouldHave']).toContain('block');
  });
  it('redirects fetch agents to the gateway', () => {
    const v = engine.evaluate(
      [mk('network.ip-range-verified', { source: 'server', provider: { id: 'openai', confidence: 0.99 }, details: { verification: 'passed', method: 'ip-range' } })],
      { sessionId: 's', stage: 'request' },
    );
    const d = decide(v, policy, { path: '/article' });
    expect(d.primary).toBe('redirect');
  });
  it('matches path globs', () => {
    expect(globMatch('/api/**', '/api/v1/items')).toBe(true);
    expect(globMatch('/api/*', '/api/v1/items')).toBe(false);
    expect(globMatch('/products/*.json', '/products/1.json')).toBe(true);
  });
});

describe('driverless class attribution', () => {
  const defs2: SignalDefinition[] = [
    { id: 'probe.cdp', layer: 'probe', strength: 'strong', automation: 3.5, classes: { 'browser-agent': 3 }, description: 'cdp leak', source: 'client' },
    { id: 'beh.center', layer: 'behavior', strength: 'strong', automation: 2.5, classes: { 'browser-agent': 2.5 }, description: 'centre clicks', source: 'client' },
    { id: 'beh.nopath', layer: 'behavior', strength: 'strong', automation: 2.5, classes: { 'computer-use-agent': 2.5, 'browser-agent': 1.5 }, description: 'no path', source: 'client' },
    { id: 'beh.typing', layer: 'behavior', strength: 'moderate', automation: 1.5, classes: { 'browser-agent': 1.5, 'computer-use-agent': 1 }, description: 'metronomic', source: 'client' },
  ];
  const reg = createRegistry(defs2);
  const eng = createEngine({ registry: reg, now: () => 1000 });
  const s = (id: string) => createSignal({ id, summary: id }, reg, { source: 'client', now: () => 1000 });

  it('attributes behaviour-only automation to a computer-use agent', () => {
    const v = eng.evaluate([s('beh.center'), s('beh.nopath'), s('beh.typing')], { sessionId: 's', stage: 'final' });
    expect(v.automation).toBeGreaterThan(0.5);
    expect(v.actorClass).toBe('computer-use-agent');
  });

  it('keeps browser-agent when an in-page driver is evident', () => {
    const v = eng.evaluate([s('probe.cdp'), s('beh.center'), s('beh.nopath'), s('beh.typing')], { sessionId: 's', stage: 'final' });
    expect(v.actorClass).toBe('browser-agent');
  });
});
