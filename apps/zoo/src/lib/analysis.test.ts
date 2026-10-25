import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@necterai/core';
import { firstRequestTs, formatLayerCounts, layerOf, median, mergedEvents, signalLayerCounts, summarizeRepeats, timeToFirstAutomationVerdict, verdictLayerCounts } from './analysis.js';
import type { SessionSummary, SessionVerdictSummary } from './types.js';

function ev(type: SessionEvent['type'], ts: number, data: unknown, sessionId = 's1'): SessionEvent {
  return { id: `${type}-${ts}`, sessionId, ts, source: 'server', type, data } as unknown as SessionEvent;
}
function verdictEv(ts: number, automation: number): SessionEvent {
  return ev('verdict', ts, { verdict: { automation, score: Math.round(automation * 100), evidence: [] } });
}

describe('firstRequestTs', () => {
  it('prefers the earliest request event over earlier non-request events', () => {
    const events = [ev('session', 50, {}), ev('request', 120, { method: 'GET', path: '/' }), ev('request', 100, { method: 'GET', path: '/a' })];
    expect(firstRequestTs(events)).toBe(100);
  });
  it('falls back to the earliest event when there is no request', () => {
    expect(firstRequestTs([ev('signal', 300, { signals: [] }), ev('verdict', 200, { verdict: { automation: 0.1, evidence: [] } })])).toBe(200);
  });
  it('is undefined for an empty stream', () => {
    expect(firstRequestTs([])).toBeUndefined();
  });
});

describe('timeToFirstAutomationVerdict', () => {
  it('measures from the first request to the first verdict at or above 0.9', () => {
    const events = [ev('request', 1000, {}), verdictEv(1200, 0.4), verdictEv(1900, 0.95), verdictEv(2500, 0.99)];
    expect(timeToFirstAutomationVerdict(events)).toBe(900);
  });
  it('is undefined when no verdict reaches the threshold', () => {
    expect(timeToFirstAutomationVerdict([ev('request', 1000, {}), verdictEv(1500, 0.89)])).toBeUndefined();
  });
  it('honours a custom threshold and clamps negative deltas to zero', () => {
    const events = [verdictEv(900, 0.8), ev('request', 1000, {})];
    expect(timeToFirstAutomationVerdict(events, 0.75)).toBe(0);
  });
  it('ignores verdicts with a non-numeric automation', () => {
    const bad = ev('verdict', 1100, { verdict: { automation: 'high', evidence: [] } });
    expect(timeToFirstAutomationVerdict([ev('request', 1000, {}), bad, verdictEv(1300, 0.9)])).toBe(300);
  });
});

describe('layer counts', () => {
  const verdict: SessionVerdictSummary = {
    score: 97,
    automation: 0.97,
    actorClass: 'browser-agent',
    classConfidence: 0.8,
    stage: 'fused',
    deterministic: false,
    evidence: [
      { signalId: 'behavior.teleport-click', layer: 'behavior', contribution: 2, summary: '' },
      { signalId: 'behavior.constant-press', layer: 'behavior', contribution: 1, summary: '' },
      { signalId: 'environment.headless-ua', contribution: 3, summary: '' },
      { signalId: 'weird-no-dot', contribution: 0.1, summary: '' },
    ],
  };
  it('counts verdict evidence per layer, inferring the layer from the id when absent', () => {
    expect(verdictLayerCounts(verdict)).toEqual({ behavior: 2, environment: 1, unknown: 1 });
    expect(verdictLayerCounts(undefined)).toEqual({});
  });
  it('counts emitted signals per layer across signal events', () => {
    const events = [
      ev('signal', 1, { signals: [{ id: 'probe.cdp-runtime-leak', layer: 'probe' }, { id: 'probe.webdriver' }] }),
      ev('signal', 2, { signals: [{ id: 'behavior.no-hover' }] }),
      ev('request', 3, {}),
    ];
    expect(signalLayerCounts(events)).toEqual({ probe: 2, behavior: 1 });
  });
  it('formats counts in descending order with short labels', () => {
    expect(formatLayerCounts({ behavior: 2, environment: 5, probe: 2, challenge: 0 })).toBe('env:5 beh:2 probe:2');
    expect(formatLayerCounts({})).toBe('');
  });
  it('derives a layer from the signal id prefix', () => {
    expect(layerOf('tie.no-js-execution')).toBe('tie');
    expect(layerOf('nodot')).toBe('unknown');
  });
});

describe('mergedEvents', () => {
  it('merges every session stream in time order', () => {
    const sessions: SessionSummary[] = [
      { id: 'a', last: 0, requests: 0, events: [ev('request', 30, {}, 'a'), ev('request', 10, {}, 'a')] },
      { id: 'b', last: 0, requests: 0, events: [ev('request', 20, {}, 'b')] },
      { id: 'c', last: 0, requests: 0 },
    ];
    expect(mergedEvents(sessions).map((e) => e.ts)).toEqual([10, 20, 30]);
  });
});

describe('summarizeRepeats', () => {
  it('computes detection and class rates per attacker, excluding skipped iterations', () => {
    const rows = [
      { attacker: 'x', detected: true, classMatch: true, verdict: { score: 90 }, ttfvMs: 1000 },
      { attacker: 'x', detected: false, classMatch: false, verdict: { score: 40 } },
      { attacker: 'x', detected: false, classMatch: false, skipped: 'needs --headed' },
      { attacker: 'y', detected: true, classMatch: false, verdict: { score: 99 }, ttfvMs: 200 },
      { attacker: 'y', detected: true, classMatch: true, verdict: { score: 95 }, ttfvMs: 400 },
    ];
    const s = summarizeRepeats(rows);
    expect(s.map((r) => r.attacker)).toEqual(['x', 'y']);
    const x = s[0]!;
    expect(x.runs).toBe(2);
    expect(x.skipped).toBe(1);
    expect(x.detectionRate).toBe(0.5);
    expect(x.classRate).toBe(0.5);
    expect(x.medianScore).toBe(65);
    expect(x.medianTtfvMs).toBe(1000);
    expect(x.verdictRate).toBe(0.5);
    const y = s[1]!;
    expect(y.detectionRate).toBe(1);
    expect(y.classRate).toBe(0.5);
    expect(y.medianTtfvMs).toBe(300);
  });
  it('yields zero rates when every iteration was skipped', () => {
    const s = summarizeRepeats([{ attacker: 'z', detected: false, classMatch: false, skipped: 'missing python3' }]);
    expect(s[0]).toMatchObject({ runs: 0, skipped: 1, detectionRate: 0, medianScore: undefined });
  });
});

describe('median', () => {
  it('handles odd, even and empty inputs', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeUndefined();
  });
});
