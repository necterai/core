/**
 * Refresh IP ranges from the provider URLs in data/ip-ranges/sources.json.
 * Never needed at runtime; uses global fetch (Node >= 20). Failures are skipped with a
 * warning and the previous file is kept.
 *
 *   corepack pnpm --filter @necterai/signatures run sync            # bundled sources -> data/ip-ranges/<id>.json
 *   corepack pnpm --filter @necterai/signatures run sync -- --all   # also AWS/Azure/OCI/iCloud... -> data/ip-ranges/sync-cache/
 *   options: --only id1,id2   --out <dir> (for unbundled sources)   --dry-run   --timeout <ms>
 */
import { join } from 'node:path';
import { parseIpFeed, toIpRangeSet, type ParsedFeed } from '../src/ip-parse.js';
import type { IpSource } from '../src/types.js';
import { IP_DIR, SYNC_CACHE_DIR, loadSources, writeGeneratedIndex, writeRangeSet } from './lib.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};
const includeAll = flag('--all');
const dryRun = flag('--dry-run');
const only = opt('--only')?.split(',').map((s) => s.trim()).filter(Boolean);
const outDir = opt('--out') ?? SYNC_CACHE_DIR;
const timeoutMs = Number(opt('--timeout') ?? 30_000);

async function get(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'user-agent': 'necter-signatures-sync/0.1 (+https://github.com/)', accept: 'application/json, text/plain, text/csv, text/html;q=0.8, */*;q=0.5' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** Azure publishes ServiceTags_Public_<Monday YYYYMMDD>.json weekly; try the last few Mondays. */
function azureCandidates(template: string, now = new Date()): string[] {
  const out: string[] = [];
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // back to Monday
  for (let i = 0; i < 4; i++) {
    const ymd = d.toISOString().slice(0, 10).replace(/-/g, '');
    out.push(template.replace('YYYYMMDD', ymd));
    d.setUTCDate(d.getUTCDate() - 7);
  }
  return out;
}

async function fetchSource(src: IpSource): Promise<{ feed: ParsedFeed; url: string }> {
  if (src.format === 'azure-json') {
    let lastErr: unknown;
    for (const url of azureCandidates(src.url)) {
      try {
        return { feed: parseIpFeed('azure-json', await get(url), src.filter), url };
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
  const urls = [src.url, ...(src.urls ?? [])];
  const feeds: ParsedFeed[] = [];
  for (const url of urls) feeds.push(parseIpFeed(src.format, await get(url), src.filter));
  const feed: ParsedFeed = { prefixes: feeds.flatMap((f) => f.prefixes) };
  const ct = feeds.find((f) => f.creationTime)?.creationTime;
  if (ct) feed.creationTime = ct;
  return { feed, url: urls.join(' + ') };
}

const sources = loadSources().filter((s) => (only ? only.includes(s.id) : s.sync !== false && (s.bundled || includeAll)));
let ok = 0;
let failed = 0;
const fetchedAt = new Date().toISOString();

for (const src of sources) {
  if (src.sync === false && !only) continue;
  try {
    const { feed, url } = await fetchSource(src);
    if (!feed.prefixes.length) throw new Error('parsed 0 prefixes');
    // A successful fetch replaces seed/transcribed data entirely, so the set is no longer partial.
    const set = toIpRangeSet({ ...src, partial: false }, feed, fetchedAt, { source: url });
    delete set.partial;
    const dir = src.bundled ? IP_DIR : outDir;
    if (!dryRun) writeRangeSet(dir, set);
    ok++;
    console.log(`✓ ${src.id}: ${set.prefixes.length} prefixes${dryRun ? ' (dry run)' : ` -> ${join(dir, `${src.id}.json`)}`}`);
  } catch (e) {
    failed++;
    console.warn(`! ${src.id}: skipped (${e instanceof Error ? e.message : String(e)}) — keeping previous data`);
  }
}

if (!dryRun) writeGeneratedIndex(loadSources());
console.log(`\nsync done: ${ok} updated, ${failed} skipped`);
