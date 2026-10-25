import { writeFileSync, mkdirSync } from 'node:fs';
import { createEngine, createRegistry, dedupeSignals, SIGNAL_CATALOG, type SessionEvent, type Signal } from '@necterai/core';
import type { Attacker, AttackerResult, SessionSummary } from './types.js';
import { fmtMs, formatLayerCounts, mergedEvents, pct, signalLayerCounts, summarizeRepeats, timeToFirstAutomationVerdict, verdictLayerCounts, type LayerCounts } from './analysis.js';

export interface RunRow {
  attacker: string;
  description: string;
  expected: Attacker['expected'];
  sessions: SessionSummary[];
  result: AttackerResult;
  /** Best (highest score) session verdict. */
  verdict?: SessionSummary['verdict'];
  detected: boolean;
  classMatch: boolean;
  providerMatch: boolean | null;
  skipped?: string;
  /** 1-based repeat iteration. */
  iteration: number;
  /** ms from the first request to the first verdict with automation >= 0.9; undefined when never reached. */
  ttfvMs?: number;
  /** Evidence items per layer in the best verdict. */
  layerCounts: LayerCounts;
  /** Signals emitted per layer over the whole session (pre-cap). */
  signalCounts: LayerCounts;
  /** Number of events the server stored for the matched sessions. */
  eventCount: number;
  /** Score with the attacker's declared harness artifacts removed (false-positive probes). */
  adjusted?: { score: number; automation: number; actorClass: string; removed: string[] };
}

export function evaluateRow(attacker: Attacker, result: AttackerResult, sessions: SessionSummary[], threshold: number, iteration = 1): RunRow {
  const withVerdict = sessions.filter((s) => s.verdict);
  const best = withVerdict.sort((a, b) => b.verdict!.score - a.verdict!.score || b.last - a.last)[0];
  const v = best?.verdict;
  const expectedClasses = Array.isArray(attacker.expected.actorClass) ? attacker.expected.actorClass : [attacker.expected.actorClass];
  const events: SessionEvent[] = mergedEvents(sessions);
  const adjusted = attacker.harnessArtifacts?.length && v ? harnessAdjusted(events, attacker.harnessArtifacts) : undefined;
  const judged = adjusted ?? v;
  const automated = judged ? judged.automation >= threshold : false;
  const detected = attacker.expected.automated ? automated : !automated;
  const classMatch = judged ? expectedClasses.includes(judged.actorClass as never) : false;
  const providerMatch = attacker.expected.provider ? v?.provider?.id === attacker.expected.provider : null;
  const row: RunRow = {
    attacker: attacker.name,
    description: attacker.description,
    expected: attacker.expected,
    sessions,
    result,
    detected,
    classMatch,
    providerMatch,
    iteration,
    layerCounts: verdictLayerCounts(v),
    signalCounts: signalLayerCounts(events),
    eventCount: events.length,
  };
  if (v) row.verdict = v;
  if (adjusted) row.adjusted = adjusted;
  const ttfv = timeToFirstAutomationVerdict(events);
  if (ttfv !== undefined) row.ttfvMs = ttfv;
  if (result.skipped) row.skipped = result.skipped;
  return row;
}

export function renderTable(rows: RunRow[]): string {
  const head = ['attacker', 'expected', 'got', 'score', 'provider', 'ok', 'class', 'ttfv', 'layers', 'top evidence'];
  const lines = rows.map((r) => {
    if (r.skipped) return [r.attacker, fmtExpected(r), 'SKIPPED', '', '', '', '', '', '', r.skipped];
    const v = r.verdict;
    return [
      r.attacker,
      fmtExpected(r),
      v ? v.actorClass : '(no session)',
      v ? (r.adjusted ? `${v.score}→${r.adjusted.score}` : String(v.score)) : '',
      v?.provider ? `${v.provider.id}${v.provider.verified ? '✓' : ''}` : '',
      v ? (r.detected ? 'PASS' : 'FAIL') : 'FAIL',
      v ? (r.classMatch ? 'match' : 'miss') : '',
      fmtMs(r.ttfvMs),
      formatLayerCounts(r.layerCounts),
      v ? v.evidence.slice(0, 3).map((e) => `${e.signalId}(${e.contribution > 0 ? '+' : ''}${e.contribution.toFixed(1)})`).join(' ') : (r.result.error ?? ''),
    ];
  });
  const widths = head.map((h, i) => Math.max(h.length, ...lines.map((l) => (l[i] ?? '').length)));
  const fmt = (cols: string[]) => cols.map((c, i) => (c ?? '').padEnd(widths[i]!)).join('  ');
  return [fmt(head), fmt(widths.map((w) => '-'.repeat(w))), ...lines.map(fmt)].join('\n');
}

export function renderRepeatTable(rows: RunRow[]): string {
  const sums = summarizeRepeats(rows);
  const head = ['attacker', 'runs', 'detection', 'class', 'median score', 'median ttfv'];
  const lines = sums.map((s) => [s.attacker, s.skipped ? `${s.runs} (+${s.skipped} skipped)` : String(s.runs), s.runs ? `${s.detected}/${s.runs} (${pct(s.detectionRate)})` : '', s.runs ? `${s.classMatched}/${s.runs}` : '', s.medianScore === undefined ? '' : String(s.medianScore), fmtMs(s.medianTtfvMs)]);
  const widths = head.map((h, i) => Math.max(h.length, ...lines.map((l) => (l[i] ?? '').length)));
  const fmt = (cols: string[]) => cols.map((c, i) => (c ?? '').padEnd(widths[i]!)).join('  ');
  return [fmt(head), fmt(widths.map((w) => '-'.repeat(w))), ...lines.map(fmt)].join('\n');
}

export function renderMarkdown(rows: RunRow[], meta: Record<string, unknown>): string {
  const out: string[] = ['# Agent zoo results', '', `Generated: ${new Date().toISOString()}`, '', '```json', JSON.stringify(meta, null, 2), '```', ''];
  const repeat = typeof meta['repeat'] === 'number' ? (meta['repeat'] as number) : 1;
  out.push('| attacker | it | expected | got | score | provider | detection | class | ttfv | layers | top evidence |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of rows) {
    if (r.skipped) {
      out.push(`| ${r.attacker} | ${r.iteration} | ${fmtExpected(r)} | skipped | | | | | | | ${r.skipped} |`);
      continue;
    }
    const v = r.verdict;
    out.push(
      `| ${r.attacker} | ${r.iteration} | ${fmtExpected(r)} | ${v?.actorClass ?? '(none)'} | ${v?.score ?? ''} | ${v?.provider ? v.provider.id + (v.provider.verified ? ' ✓' : '') : ''} | ${v ? (r.detected ? 'PASS' : 'FAIL') : 'FAIL'} | ${v ? (r.classMatch ? 'match' : 'miss') : ''} | ${fmtMs(r.ttfvMs)} | ${formatLayerCounts(r.layerCounts)} | ${v ? v.evidence.slice(0, 4).map((e) => `\`${e.signalId}\` ${e.contribution > 0 ? '+' : ''}${e.contribution.toFixed(1)}`).join(', ') : (r.result.error ?? '')} |`,
    );
  }
  const scored = rows.filter((r) => !r.skipped);
  const pass = scored.filter((r) => r.detected).length;
  const cls = scored.filter((r) => r.classMatch).length;
  out.push('', `**Detection: ${pass}/${scored.length}. Class attribution: ${cls}/${scored.length}.**`, '');
  if (repeat > 1) {
    out.push(`## Detection rate over ${repeat} repeats`, '', '| attacker | runs | detection rate | class rate | median score | median ttfv |', '| --- | --- | --- | --- | --- | --- |');
    for (const s of summarizeRepeats(rows)) out.push(`| ${s.attacker} | ${s.runs}${s.skipped ? ` (+${s.skipped} skipped)` : ''} | ${s.runs ? `${s.detected}/${s.runs} (${pct(s.detectionRate)})` : ''} | ${s.runs ? `${s.classMatched}/${s.runs} (${pct(s.classRate)})` : ''} | ${s.medianScore ?? ''} | ${fmtMs(s.medianTtfvMs)} |`);
    out.push('');
  }
  const skipped = rows.filter((r) => r.skipped);
  if (skipped.length) {
    out.push('## Skipped', '');
    for (const r of skipped) out.push(`- **${r.attacker}**: ${r.skipped}`);
    out.push('');
  }
  const seen = new Set<string>();
  for (const r of scored) {
    const key = `${r.attacker}#${r.iteration}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`## ${r.attacker}${repeat > 1 ? ` (iteration ${r.iteration})` : ''}`, '', r.description, '');
    out.push(`Sessions: ${r.sessions.length}; events: ${r.eventCount}; time to first automation verdict: ${fmtMs(r.ttfvMs) || 'never'}; verdict evidence by layer: ${formatLayerCounts(r.layerCounts) || 'none'}; signals emitted by layer: ${formatLayerCounts(r.signalCounts) || 'none'}.`, '');
    if (r.verdict) {
      out.push('Evidence:', '');
      for (const e of r.verdict.evidence.slice(0, 15)) out.push(`- \`${e.signalId}\` (${e.contribution > 0 ? '+' : ''}${e.contribution.toFixed(2)}): ${e.summary}`);
      out.push('');
    }
    if (r.result.notes?.length) out.push(...r.result.notes.slice(0, 40).map((n) => `> ${n}`), '');
  }
  return out.join('\n');
}

export function writeResults(dir: string, name: string, rows: RunRow[], meta: Record<string, unknown>): { json: string; md: string } {
  mkdirSync(dir, { recursive: true });
  const json = `${dir}/${name}.json`;
  const md = `${dir}/${name}.md`;
  // Events are written to the dataset file, not the results JSON (keeps results small and diffable).
  const slim = rows.map((r) => ({ ...r, sessions: r.sessions.map(({ events: _e, ...s }) => s) }));
  writeFileSync(json, JSON.stringify({ meta, rows: slim }, null, 2));
  writeFileSync(md, renderMarkdown(rows, meta));
  return { json, md };
}

/** One JSON line per event, annotated with the attacker that produced it: the calibration dataset. */
export function writeDataset(dir: string, name: string, rows: RunRow[], meta: Record<string, unknown>): string {
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/${name}-events.jsonl`;
  const lines: string[] = [JSON.stringify({ kind: 'meta', ...meta })];
  for (const r of rows) {
    for (const s of r.sessions) {
      for (const e of s.events ?? []) {
        lines.push(JSON.stringify({ kind: 'event', attacker: r.attacker, iteration: r.iteration, expected: r.expected, sessionId: s.id, event: e }));
      }
    }
  }
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

export function fmtExpected(r: { expected: Attacker['expected'] }): string {
  const c = Array.isArray(r.expected.actorClass) ? r.expected.actorClass.join('|') : r.expected.actorClass;
  return r.expected.provider ? `${c}/${r.expected.provider}` : c;
}

const adjustEngine = createEngine({ registry: createRegistry(SIGNAL_CATALOG) });

/** Re-score a session from its raw signal events, dropping signals the test driver itself caused. */
export function harnessAdjusted(events: SessionEvent[], artifacts: string[]): NonNullable<RunRow['adjusted']> {
  const all: Signal[] = [];
  for (const e of events) if (e.type === 'signal' && Array.isArray(e.data?.signals)) all.push(...e.data.signals);
  const isArtifact = (id: string) => artifacts.some((a) => (a.endsWith('.') ? id.startsWith(a) : id === a));
  const signals = dedupeSignals(all);
  const removed = [...new Set(signals.filter((s) => isArtifact(s.id)).map((s) => s.id))];
  const v = adjustEngine.evaluate(signals.filter((s) => !isArtifact(s.id)), { sessionId: 'harness-adjusted', stage: 'final' });
  return { score: v.score, automation: v.automation, actorClass: v.actorClass, removed };
}
