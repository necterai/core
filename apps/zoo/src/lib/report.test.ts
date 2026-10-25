import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@necterai/core';
import { evaluateRow, renderMarkdown, renderRepeatTable, renderTable } from './report.js';
import type { Attacker, SessionSummary, SessionVerdictSummary } from './types.js';

const attacker: Attacker = {
  name: 'pw-test',
  description: 'test attacker',
  expected: { actorClass: 'browser-agent', automated: true },
  run: async () => ({ startedAt: 0, finishedAt: 0 }),
};
const humanProbe: Attacker = { ...attacker, name: 'at-test', expected: { actorClass: 'human', automated: false } };

function verdict(automation: number, actorClass: string, extra: Partial<SessionVerdictSummary> = {}): SessionVerdictSummary {
  return { score: Math.round(automation * 100), automation, actorClass, classConfidence: 0.8, stage: 'fused', deterministic: false, evidence: [{ signalId: 'behavior.teleport-click', layer: 'behavior', contribution: 2.1, summary: 'one move then click' }], ...extra };
}
function session(id: string, v: SessionVerdictSummary | undefined, events: SessionEvent[] = []): SessionSummary {
  return { id, last: 10, requests: 3, ...(v ? { verdict: v } : {}), events };
}
const E = (type: SessionEvent['type'], ts: number, data: unknown): SessionEvent => ({ id: `${type}${ts}`, sessionId: 's', ts, source: 'server', type, data }) as unknown as SessionEvent;

describe('evaluateRow', () => {
  it('passes an automated attacker when the best session verdict is above the threshold and the class matches', () => {
    const events = [E('request', 1000, {}), E('verdict', 1400, { verdict: verdict(0.95, 'browser-agent') }), E('signal', 1100, { signals: [{ id: 'probe.x' }, { id: 'behavior.y' }] })];
    const row = evaluateRow(attacker, { startedAt: 0, finishedAt: 1 }, [session('a', verdict(0.3, 'human')), session('b', verdict(0.95, 'browser-agent'), events)], 0.75, 2);
    expect(row.detected).toBe(true);
    expect(row.classMatch).toBe(true);
    expect(row.verdict?.score).toBe(95);
    expect(row.iteration).toBe(2);
    expect(row.ttfvMs).toBe(400);
    expect(row.layerCounts).toEqual({ behavior: 1 });
    expect(row.signalCounts).toEqual({ probe: 1, behavior: 1 });
    expect(row.eventCount).toBe(3);
    expect(row.providerMatch).toBeNull();
  });
  it('fails an automated attacker with no session at all', () => {
    const row = evaluateRow(attacker, { startedAt: 0, finishedAt: 1 }, [], 0.75);
    expect(row.detected).toBe(false);
    expect(row.verdict).toBeUndefined();
    expect(row.ttfvMs).toBeUndefined();
  });
  it('treats a human probe as detected only when the verdict stays below the threshold', () => {
    expect(evaluateRow(humanProbe, { startedAt: 0, finishedAt: 1 }, [session('a', verdict(0.2, 'human'))], 0.75).detected).toBe(true);
    expect(evaluateRow(humanProbe, { startedAt: 0, finishedAt: 1 }, [session('a', verdict(0.9, 'computer-use-agent'))], 0.75).detected).toBe(false);
    expect(evaluateRow(humanProbe, { startedAt: 0, finishedAt: 1 }, [session('a', verdict(0.2, 'human'))], 0.75).classMatch).toBe(true);
  });
  it('accepts any of several expected classes and checks provider attribution', () => {
    const multi: Attacker = { ...attacker, expected: { actorClass: ['fetch-agent', 'scripted-automation'], automated: true, provider: 'openai' } };
    const ok = evaluateRow(multi, { startedAt: 0, finishedAt: 1 }, [session('a', verdict(0.99, 'scripted-automation', { provider: { id: 'openai', confidence: 0.9, verified: false } }))], 0.75);
    expect(ok.classMatch).toBe(true);
    expect(ok.providerMatch).toBe(true);
    const wrong = evaluateRow(multi, { startedAt: 0, finishedAt: 1 }, [session('a', verdict(0.99, 'browser-agent'))], 0.75);
    expect(wrong.classMatch).toBe(false);
    expect(wrong.providerMatch).toBe(false);
  });
  it('carries a runtime skip reason into the row', () => {
    const row = evaluateRow(attacker, { startedAt: 0, finishedAt: 1, skipped: 'needs @playwright/mcp' }, [], 0.75);
    expect(row.skipped).toBe('needs @playwright/mcp');
  });
});

describe('rendering', () => {
  const rows = [
    evaluateRow(attacker, { startedAt: 0, finishedAt: 1 }, [session('a', verdict(0.95, 'browser-agent'), [E('request', 0, {}), E('verdict', 250, { verdict: verdict(0.95, 'browser-agent') })])], 0.75, 1),
    evaluateRow(attacker, { startedAt: 0, finishedAt: 1 }, [session('b', verdict(0.5, 'human'))], 0.75, 2),
    evaluateRow(humanProbe, { startedAt: 0, finishedAt: 1, skipped: 'needs --headed' }, [], 0.75, 1),
  ];
  it('renders a console table with ttfv and layer columns', () => {
    const t = renderTable(rows);
    expect(t).toContain('ttfv');
    expect(t).toContain('250ms');
    expect(t).toContain('beh:1');
    expect(t).toContain('SKIPPED');
  });
  it('renders the repeat summary with detection rates', () => {
    const t = renderRepeatTable(rows);
    expect(t).toContain('1/2 (50%)');
    expect(t).toContain('at-test');
  });
  it('renders markdown with the summary line, repeat section and skipped list', () => {
    const md = renderMarkdown(rows, { repeat: 2, base: 'http://x' });
    expect(md).toContain('**Detection: 1/2. Class attribution: 1/2.**');
    expect(md).toContain('## Detection rate over 2 repeats');
    expect(md).toContain('| pw-test | 2 | 1/2 (50%)');
    expect(md).toContain('- **at-test**: needs --headed');
    expect(md).toContain('time to first automation verdict: 250ms');
  });
});
