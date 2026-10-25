import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { latestResultsFile, renderEvaluation } from './write-evaluation.js';
import type { RunRow } from '../src/lib/report.js';

function row(partial: Partial<RunRow> & Pick<RunRow, 'attacker' | 'expected' | 'detected' | 'classMatch'>): RunRow {
  return { description: 'd', sessions: [], result: { startedAt: 0, finishedAt: 1 }, providerMatch: null, iteration: 1, layerCounts: {}, signalCounts: {}, eventCount: 0, ...partial };
}

describe('renderEvaluation', () => {
  const rows: RunRow[] = [
    row({ attacker: 'a', expected: { actorClass: 'browser-agent', automated: true }, detected: true, classMatch: true, verdict: { score: 98, automation: 0.98, actorClass: 'browser-agent', classConfidence: 0.9, stage: 'fused', deterministic: true, evidence: [{ signalId: 'probe.x', layer: 'probe', contribution: 6, summary: 'binding' }] }, ttfvMs: 320, layerCounts: { probe: 1 } }),
    row({ attacker: 'h', expected: { actorClass: 'human', automated: false }, detected: false, classMatch: false, verdict: { score: 91, automation: 0.91, actorClass: 'computer-use-agent', classConfidence: 0.5, stage: 'fused', deterministic: false, evidence: [{ signalId: 'behavior.teleport', layer: 'behavior', contribution: 2, summary: 'teleport' }] }, signalCounts: { behavior: 4 } }),
    row({ attacker: 's', expected: { actorClass: 'browser-agent', automated: true }, detected: false, classMatch: false, skipped: 'needs @playwright/mcp' }),
  ];
  it('reports detection, false positives, misses and skipped attackers', () => {
    const md = renderEvaluation({ meta: { base: 'http://127.0.0.1:8800', mode: 'monitor', threshold: 0.75, repeat: 1, attackers: ['a', 'h', 's'] }, rows }, 'zoo-x.json');
    expect(md).toContain('| detection (automated attackers flagged) | 1/1 |');
    expect(md).toContain('| false positives (human probes flagged) | 1/1 |');
    expect(md).toContain('| median ttfv (sessions that reached 0.9) | 320ms |');
    expect(md).toContain('### h');
    expect(md).toContain('Signals emitted by layer: beh:4');
    expect(md).toContain('- **s**: needs @playwright/mcp');
    expect(md).not.toContain('## 4. Detection rate');
  });
  it('adds the repeat section when the run used --repeat', () => {
    const md = renderEvaluation({ meta: { repeat: 3 }, rows: [rows[0]!, { ...rows[0]!, iteration: 2, detected: false }] }, 'zoo-y.json');
    expect(md).toContain('## 4. Detection rate over 3 repeats');
    expect(md).toContain('| a | 2 | 1/2 (50%)');
  });
});

describe('latestResultsFile', () => {
  it('picks the lexicographically latest zoo-*.json and ignores other files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zoo-eval-'));
    try {
      writeFileSync(join(dir, 'zoo-2026-01-01T00-00-00-000Z.json'), '{}');
      writeFileSync(join(dir, 'zoo-2026-02-01T00-00-00-000Z.json'), '{}');
      writeFileSync(join(dir, 'zoo-2026-02-01T00-00-00-000Z.md'), '');
      writeFileSync(join(dir, 'zoo-2026-03-01T00-00-00-000Z-events.jsonl'), '');
      expect(latestResultsFile(dir)).toBe(join(dir, 'zoo-2026-02-01T00-00-00-000Z.json'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(latestResultsFile(join(dir, 'missing'))).toBeUndefined();
  });
});
