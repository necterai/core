/**
 * Generates docs/design/evaluation.md from the latest zoo results JSON.
 *
 *   corepack pnpm evaluation                 # latest results/zoo-*.json -> docs/design/evaluation.md
 *   corepack pnpm evaluation -- --in results/zoo-2026-10-24T23-16-13-145Z.json --out /tmp/eval.md
 *
 * Deliberately separate from the runner so a partial or --only run never overwrites the published evaluation.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { fmtMs, formatLayerCounts, pct, summarizeRepeats } from '../src/lib/analysis.js';
import { fmtExpected, type RunRow } from '../src/lib/report.js';

const here = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(here, '../results');
const DEFAULT_OUT = join(here, '../../../docs/design/evaluation.md');

interface ResultsFile {
  meta: Record<string, unknown> & { base?: string; mode?: string; threshold?: number; repeat?: number; attackers?: string[]; startedAt?: number; finishedAt?: number };
  rows: RunRow[];
}

export function latestResultsFile(dir = RESULTS_DIR): string | undefined {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /^zoo-.*\.json$/.test(f));
  } catch {
    return undefined;
  }
  files.sort();
  const last = files[files.length - 1];
  return last ? join(dir, last) : undefined;
}

export function renderEvaluation(data: ResultsFile, sourceName: string): string {
  const { meta, rows } = data;
  const scored = rows.filter((r) => !r.skipped);
  const pass = scored.filter((r) => r.detected).length;
  const cls = scored.filter((r) => r.classMatch).length;
  const automatedRows = scored.filter((r) => r.expected.automated);
  const humanRows = scored.filter((r) => !r.expected.automated);
  const fp = humanRows.filter((r) => !r.detected).length;
  const repeat = typeof meta.repeat === 'number' ? meta.repeat : 1;
  const ttfvs = scored.map((r) => r.ttfvMs).filter((x): x is number => typeof x === 'number');
  const medianTtfv = ttfvs.length ? [...ttfvs].sort((a, b) => a - b)[ttfvs.length >> 1] : undefined;

  const out: string[] = [];
  out.push('# Evaluation: agent zoo results', '');
  out.push(`Status: generated ${new Date().toISOString()} by \`apps/zoo/scripts/write-evaluation.ts\` from \`${sourceName}\`. Do not edit by hand; re-run \`pnpm --filter @necterai/zoo evaluation\`.`, '');
  out.push('## 1. Setup', '');
  out.push(`* Target: demo shop at \`${meta.base ?? '?'}\`, mode \`${meta.mode ?? '?'}\`, detection threshold automation >= ${meta.threshold ?? '?'}.`);
  out.push(`* Attackers: ${meta.attackers?.length ?? rows.length} selected, ${scored.length} executed, ${rows.length - scored.length} skipped${repeat > 1 ? `, ${repeat} repeats each` : ''}.`);
  if (typeof meta.startedAt === 'number' && typeof meta.finishedAt === 'number') out.push(`* Wall clock: ${fmtMs(meta.finishedAt - meta.startedAt)}.`);
  out.push('* "ttfv" = time from the first request the server saw to the first verdict with automation >= 0.9. "layers" = evidence items per layer in the final verdict.', '');

  out.push('## 2. Headline numbers', '');
  out.push(`| metric | value |`, `| --- | --- |`);
  out.push(`| detection (automated attackers flagged) | ${automatedRows.filter((r) => r.detected).length}/${automatedRows.length} |`);
  out.push(`| false positives (human probes flagged) | ${fp}/${humanRows.length} |`);
  out.push(`| class attribution | ${cls}/${scored.length} |`);
  out.push(`| overall pass | ${pass}/${scored.length} |`);
  out.push(`| median ttfv (sessions that reached 0.9) | ${medianTtfv === undefined ? 'n/a' : fmtMs(medianTtfv)} |`);
  out.push('');

  out.push('## 3. Per-attacker results', '');
  out.push('| attacker | expected | got | score | provider | detection | class | ttfv | layers | top evidence |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of rows) {
    if (r.skipped) {
      out.push(`| ${r.attacker} | ${fmtExpected(r)} | skipped | | | | | | | ${r.skipped} |`);
      continue;
    }
    const v = r.verdict;
    out.push(
      `| ${r.attacker}${repeat > 1 ? ` #${r.iteration}` : ''} | ${fmtExpected(r)} | ${v?.actorClass ?? '(none)'} | ${v?.score ?? ''} | ${v?.provider ? v.provider.id + (v.provider.verified ? ' ✓' : '') : ''} | ${v ? (r.detected ? 'PASS' : 'FAIL') : 'FAIL'} | ${v ? (r.classMatch ? 'match' : 'miss') : ''} | ${fmtMs(r.ttfvMs)} | ${formatLayerCounts(r.layerCounts ?? {})} | ${v ? v.evidence.slice(0, 3).map((e) => `\`${e.signalId}\` ${e.contribution > 0 ? '+' : ''}${e.contribution.toFixed(1)}`).join(', ') : (r.result.error ?? '')} |`,
    );
  }
  out.push('');

  if (repeat > 1) {
    out.push(`## 4. Detection rate over ${repeat} repeats`, '', '| attacker | runs | detection rate | class rate | median score | median ttfv |', '| --- | --- | --- | --- | --- | --- |');
    for (const s of summarizeRepeats(rows)) out.push(`| ${s.attacker} | ${s.runs} | ${s.runs ? `${s.detected}/${s.runs} (${pct(s.detectionRate)})` : ''} | ${s.runs ? `${s.classMatched}/${s.runs} (${pct(s.classRate)})` : ''} | ${s.medianScore ?? ''} | ${fmtMs(s.medianTtfvMs)} |`);
    out.push('');
  }

  const misses = scored.filter((r) => !r.detected || !r.classMatch);
  out.push(`## ${repeat > 1 ? 5 : 4}. Misses and what the verdict saw`, '');
  if (!misses.length) out.push('Every executed attacker was detected and attributed to the expected class.', '');
  for (const r of misses) {
    out.push(`### ${r.attacker}${repeat > 1 ? ` (iteration ${r.iteration})` : ''}`, '', r.description, '');
    out.push(`Expected ${fmtExpected(r)}; got ${r.verdict ? `${r.verdict.actorClass} at score ${r.verdict.score}` : 'no verdict'}. Signals emitted by layer: ${formatLayerCounts(r.signalCounts ?? {}) || 'none'}.`, '');
    if (r.verdict?.evidence.length) {
      for (const e of r.verdict.evidence.slice(0, 10)) out.push(`- \`${e.signalId}\` (${e.contribution > 0 ? '+' : ''}${e.contribution.toFixed(2)}): ${e.summary}`);
      out.push('');
    }
  }

  const skipped = rows.filter((r) => r.skipped);
  if (skipped.length) {
    out.push(`## ${repeat > 1 ? 6 : 5}. Skipped attackers`, '');
    const seen = new Set<string>();
    for (const r of skipped) {
      if (seen.has(r.attacker)) continue;
      seen.add(r.attacker);
      out.push(`- **${r.attacker}**: ${r.skipped}`);
    }
    out.push('');
  }
  return out.join('\n');
}

function main(): void {
  const argv = process.argv.slice(2);
  let input: string | undefined;
  let out = DEFAULT_OUT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--in') input = resolve(argv[++i]!);
    else if (argv[i] === '--out') out = resolve(argv[++i]!);
  }
  input ??= latestResultsFile();
  if (!input) {
    console.error('no results/zoo-*.json found; run the zoo first');
    process.exit(1);
  }
  const data = JSON.parse(readFileSync(input, 'utf8')) as ResultsFile;
  const md = renderEvaluation(data, input.split('/').slice(-1)[0]!);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, md);
  console.log(`wrote ${out} from ${input}`);
}

if (process.argv[1] && /write-evaluation\.(ts|js|mjs)$/.test(process.argv[1])) main();
