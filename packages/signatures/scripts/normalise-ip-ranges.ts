/**
 * Offline normaliser: converts every seed in data/ip-ranges/raw (plus prefixes
 * transcribed from the research) into data/ip-ranges/<id>.json
 * {id, provider, product, kind, source, fetchedAt, prefixes[]} and regenerates
 * src/generated/ip-ranges.ts.
 *
 *   corepack pnpm --filter @necterai/signatures run normalise
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseIpFeed, toIpRangeSet, type ParsedFeed } from '../src/ip-parse.js';
import { IP_DIR, RAW_DIR, loadSources, rawFiles, writeGeneratedIndex, writeRangeSet } from './lib.js';

const snapshot = JSON.parse(readFileSync(join(RAW_DIR, 'SNAPSHOT.json'), 'utf8')) as { fetchedAt: string; skipped: Record<string, string> };
const sources = loadSources();
const used = new Set<string>(['SNAPSHOT.json']);
let written = 0;

for (const src of sources) {
  const feeds: ParsedFeed[] = [];
  if (src.seedFile) {
    const path = join(RAW_DIR, src.seedFile);
    if (!existsSync(path)) {
      console.warn(`! ${src.id}: seed ${src.seedFile} missing`);
    } else {
      used.add(src.seedFile);
      feeds.push(parseIpFeed(src.seedFormat ?? src.format, readFileSync(path, 'utf8'), src.filter));
    }
  }
  if (src.inlinePrefixes?.length) feeds.push({ prefixes: src.inlinePrefixes });
  if (!feeds.length) {
    const kept = existsSync(join(IP_DIR, `${src.id}.json`));
    console.log(`- ${src.id}: no seed${kept ? ' (keeping synced file)' : src.bundled ? ' (populated by sync)' : ' (sync-time download only)'}`);
    continue;
  }
  const merged: ParsedFeed = { prefixes: feeds.flatMap((f) => f.prefixes) };
  const ct = feeds.find((f) => f.creationTime)?.creationTime;
  if (ct) merged.creationTime = ct;
  const set = toIpRangeSet(src, merged, snapshot.fetchedAt, { transcribed: !!src.inlinePrefixes?.length });
  if (!set.prefixes.length) {
    console.warn(`! ${src.id}: parsed 0 prefixes, not written`);
    continue;
  }
  writeRangeSet(IP_DIR, set);
  written++;
  console.log(`✓ ${src.id}: ${set.prefixes.length} prefixes${set.partial ? ' (partial)' : ''}`);
}

for (const f of rawFiles()) {
  if (used.has(f)) continue;
  const why = snapshot.skipped[f];
  if (why) console.log(`- raw/${f}: skipped — ${why}`);
  else {
    console.error(`✗ raw/${f}: not referenced by any source in sources.json and not listed in SNAPSHOT.json skipped`);
    process.exitCode = 1;
  }
}

const bundled = writeGeneratedIndex(sources);
console.log(`\n${written} files written; ${bundled.length} bundled range sets in src/generated/ip-ranges.ts`);
