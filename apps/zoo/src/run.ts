import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { SessionEvent } from '@necterai/core';
import { ALL_ATTACKERS } from './attackers/index.js';
import { startDemo } from './lib/server.js';
import { evaluateRow, renderRepeatTable, renderTable, writeDataset, writeResults, type RunRow } from './lib/report.js';
import type { Attacker, AttackerContext, AttackerResult, SessionSummary } from './lib/types.js';

const here = dirname(fileURLToPath(import.meta.url));

interface Args {
  command: 'run' | 'dataset' | 'list';
  base?: string;
  only?: string[];
  skip?: string[];
  mode: 'monitor' | 'enforce';
  headed: boolean;
  threshold: number;
  timeoutMs: number;
  port: number;
  out: string;
  repeat: number;
  dataset: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { command: 'run', mode: 'monitor', headed: false, threshold: 0.75, timeoutMs: 120_000, port: 8790, out: join(here, '../results'), repeat: 1, dataset: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => argv[++i]!;
    if (a === 'dataset') {
      args.command = 'dataset';
      args.dataset = true;
    } else if (a === 'list' || a === '--list') args.command = 'list';
    else if (a === 'run') args.command = 'run';
    else if (a === '--base') args.base = next();
    else if (a === '--only') args.only = next().split(',');
    else if (a === '--skip') args.skip = next().split(',');
    else if (a === '--mode') args.mode = next() as Args['mode'];
    else if (a === '--headed') args.headed = true;
    else if (a === '--threshold') args.threshold = Number(next());
    else if (a === "--timeout") args.timeoutMs = Number(next()) * 1000;
    else if (a === '--port') args.port = Number(next());
    else if (a === '--out') args.out = next();
    else if (a === '--repeat') args.repeat = Math.max(1, Math.floor(Number(next()) || 1));
    else if (a === '--dataset') args.dataset = true;
    else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      process.exit(0);
    }
  }
  return args;
}

const USAGE = `zoo [run|dataset|list] [options]
  run                 run the attackers (default)
  dataset             run and dump every session event to results/<stamp>-events.jsonl
  list                list attackers
  --base URL          attack an already-running demo (otherwise one is started on --port)
  --port N            port for the demo the runner starts (default 8790)
  --only a,b          only these attackers      --skip a,b   all but these
  --mode monitor|enforce   demo mode (default monitor)
  --threshold 0.75    automation probability counted as "detected"
  --timeout 120       seconds before a stuck attacker is abandoned
  --repeat N          run every attacker N times and report detection rates
  --headed            allow attackers that need a visible window
  --dataset           also write the events dataset (same as the dataset command)
  --out DIR           results directory`;

function has(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function sessionsSince(base: string, since: number): Promise<SessionSummary[]> {
  const res = await fetch(`${base}/__zoo/sessions`);
  const all = (await res.json()) as SessionSummary[];
  return all.filter((s) => s.last >= since - 1000);
}

async function eventsFor(base: string, sessionId: string): Promise<SessionEvent[]> {
  try {
    const res = await fetch(`${base}/__zoo/events?session=${encodeURIComponent(sessionId)}`);
    const body = (await res.json()) as { events?: SessionEvent[] };
    return body.events ?? [];
  } catch {
    return [];
  }
}

async function matchSessions(base: string, result: AttackerResult, before: Set<string>): Promise<SessionSummary[]> {
  // Wait for straggling beacons.
  await new Promise((r) => setTimeout(r, 1500));
  const recent = await sessionsSince(base, result.startedAt);
  const fresh = recent.filter((s) => !before.has(s.id));
  const byId = result.sessionIds?.length ? fresh.filter((s) => result.sessionIds!.includes(s.id)) : [];
  let matched = byId;
  if (!matched.length && result.uaMarker) matched = fresh.filter((s) => (s.ua ?? '').includes(result.uaMarker!));
  if (!matched.length) matched = fresh;
  for (const s of matched) s.events = await eventsFor(base, s.id);
  return matched;
}

function skippedRow(attacker: Attacker, reason: string, threshold: number, iteration: number): RunRow {
  const now = Date.now();
  return evaluateRow(attacker, { startedAt: now, finishedAt: now, skipped: reason }, [], threshold, iteration);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'list') {
    for (const a of ALL_ATTACKERS) {
      const flags = [a.headed ? 'headed' : '', a.requires?.length ? `requires ${a.requires.join(',')}` : ''].filter(Boolean).join(', ');
      console.log(`${a.name.padEnd(24)} ${(Array.isArray(a.expected.actorClass) ? a.expected.actorClass.join('|') : a.expected.actorClass).padEnd(32)} ${flags ? `[${flags}] ` : ''}${a.description}`);
    }
    return;
  }
  let base = args.base;
  let stop: (() => void) | undefined;
  if (!base) {
    const demo = await startDemo(args.port, args.mode);
    base = demo.base;
    stop = demo.stop;
  }
  const tag = Math.random().toString(36).slice(2, 8);
  const rows: RunRow[] = [];
  const selected = ALL_ATTACKERS.filter((a) => (!args.only || args.only.includes(a.name)) && !args.skip?.includes(a.name));
  if (args.only) for (const n of args.only) if (!ALL_ATTACKERS.some((a) => a.name === n)) console.warn(`zoo: unknown attacker '${n}' in --only`);
  console.log(`zoo: ${selected.length} attackers x${args.repeat} against ${base} (mode=${args.mode}, threshold=${args.threshold})\n`);
  let ipCounter = 10;
  const runStartedAt = Date.now();
  try {
    for (let iteration = 1; iteration <= args.repeat; iteration++) {
      if (args.repeat > 1) console.log(`--- iteration ${iteration}/${args.repeat} ---`);
      for (const attacker of selected) {
        const missing = (attacker.requires ?? []).filter((r) => !has(r));
        if (missing.length) {
          rows.push(skippedRow(attacker, `missing ${missing.join(',')}`, args.threshold, iteration));
          console.log(`- ${attacker.name} skipped: missing ${missing.join(',')}`);
          continue;
        }
        if (attacker.headed && !args.headed) {
          rows.push(skippedRow(attacker, 'needs --headed', args.threshold, iteration));
          console.log(`- ${attacker.name} skipped: needs --headed`);
          continue;
        }
        if (attacker.check) {
          let reason: string | undefined;
          try {
            reason = await attacker.check();
          } catch (err) {
            reason = `check failed: ${String(err)}`;
          }
          if (reason) {
            rows.push(skippedRow(attacker, reason, args.threshold, iteration));
            console.log(`- ${attacker.name} skipped: ${reason}`);
            continue;
          }
        }
        const before = new Set((await sessionsSince(base, 0)).map((s) => s.id));
        process.stdout.write(`▶ ${attacker.name} ... `);
        const ip = `203.0.113.${(ipCounter++ % 240) + 10}`;
        const ctx: AttackerContext = { base, tag, ip, headed: args.headed, iteration, log: (...a) => console.log(`  [${attacker.name}]`, ...a) };
        let result: AttackerResult;
        try {
          let timer: NodeJS.Timeout | undefined;
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`timed out after ${args.timeoutMs / 1000}s`)), args.timeoutMs);
          });
          try {
            result = await Promise.race([attacker.run(ctx), timeout]);
          } finally {
            clearTimeout(timer);
          }
        } catch (err) {
          result = { startedAt: Date.now(), finishedAt: Date.now(), error: String(err) };
        }
        if (result.skipped) {
          rows.push(skippedRow(attacker, result.skipped, args.threshold, iteration));
          console.log(`skipped: ${result.skipped}`);
          continue;
        }
        const sessions = await matchSessions(base, result, before);
        const row = evaluateRow(attacker, result, sessions, args.threshold, iteration);
        rows.push(row);
        const v = row.verdict;
        console.log(v ? `${v.actorClass} ${v.score}${row.adjusted ? ` (without harness: ${row.adjusted.actorClass} ${row.adjusted.score})` : ''} ${row.detected ? 'PASS' : 'FAIL'}${row.classMatch ? '' : ' (class miss)'}${row.ttfvMs !== undefined ? ` ttfv=${row.ttfvMs}ms` : ''}` : `no verdict ${result.error ?? ''}`);
      }
    }
  } finally {
    stop?.();
  }
  console.log('\n' + renderTable(rows));
  if (args.repeat > 1) console.log('\n' + renderRepeatTable(rows));
  const scored = rows.filter((r) => !r.skipped);
  const pass = scored.filter((r) => r.detected).length;
  const cls = scored.filter((r) => r.classMatch).length;
  console.log(`\nDetection ${pass}/${scored.length}, class attribution ${cls}/${scored.length}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const meta = { base, mode: args.mode, threshold: args.threshold, tag, repeat: args.repeat, headed: args.headed, startedAt: runStartedAt, finishedAt: Date.now(), attackers: selected.map((a) => a.name) };
  const files = writeResults(args.out, `zoo-${stamp}`, rows, meta);
  console.log(`\nwrote ${files.md}`);
  if (args.dataset) {
    const ds = writeDataset(args.out, `zoo-${stamp}`, rows, meta);
    console.log(`wrote ${ds}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
  console.error(err);
  process.exit(1);
});
