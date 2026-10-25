import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { providerName, type EventSink, type SessionEvent, type Verdict } from '@necterai/core';

/** One visitor session as the dashboard sees it. */
export interface SessionRow {
  id: string;
  site: string;
  origin?: string;
  firstTs: number;
  lastTs: number;
  pages: string[];
  ua?: string;
  ip?: string;
  verdict?: Verdict;
  clientVerdict?: Verdict;
  interventions: { kind: string; ok: boolean; ts: number; source: string }[];
  events: SessionEvent[];
  eventCount: number;
}

export interface SessionSummary {
  id: string;
  site: string;
  origin?: string;
  firstTs: number;
  lastTs: number;
  pageCount: number;
  lastPage?: string;
  ua?: string;
  ip?: string;
  score: number;
  automation: number;
  actorClass: string;
  provider?: string;
  providerVerified?: boolean;
  deterministic: boolean;
  stage?: string;
  evidence: { id: string; summary: string; contribution: number; layer: string }[];
  interventions: string[];
  eventCount: number;
}

const MAX_EVENTS_PER_SESSION = 1500;
/** Actions that do nothing to the visitor (they only record, label or alert the site owner). */
const PASSIVE_ACTIONS = new Set(['allow', 'observe', 'label', 'notify']);
const MAX_PAGES = 100;

/**
 * Session index for the dashboard, fed by the server SDK's event sink. Events are
 * optionally appended to `<dataDir>/events.jsonl` so a restart keeps history.
 */
export function createSessionIndex(opts: { dataDir?: string; maxSessions?: number } = {}) {
  const maxSessions = opts.maxSessions ?? 5000;
  const rows = new Map<string, SessionRow>();
  const sites = new Map<string, { site: string; origin?: string }>();
  const file = opts.dataDir ? join(opts.dataDir, 'events.jsonl') : undefined;

  function row(id: string, ts: number): SessionRow {
    let r = rows.get(id);
    if (!r) {
      const s = sites.get(id);
      r = { id, site: s?.site ?? 'unknown', firstTs: ts, lastTs: ts, pages: [], interventions: [], events: [], eventCount: 0 };
      if (s?.origin) r.origin = s.origin;
      rows.set(id, r);
      if (rows.size > maxSessions) rows.delete(rows.keys().next().value as string);
    }
    return r;
  }

  function apply(e: SessionEvent): void {
    if (!e || typeof e.sessionId !== 'string') return;
    const r = row(e.sessionId, e.ts);
    r.lastTs = Math.max(r.lastTs, e.ts);
    r.firstTs = Math.min(r.firstTs, e.ts);
    r.eventCount++;
    r.events.push(e);
    if (r.events.length > MAX_EVENTS_PER_SESSION) r.events.splice(0, r.events.length - MAX_EVENTS_PER_SESSION);
    const page = pageOf(e);
    if (page && r.pages[r.pages.length - 1] !== page && r.pages.length < MAX_PAGES) r.pages.push(page);
    switch (e.type) {
      case 'verdict':
        if (e.source === 'server') r.verdict = e.data.verdict;
        else r.clientVerdict = e.data.verdict;
        break;
      case 'request':
        if (e.data.ua) r.ua = e.data.ua;
        if (e.data.ip) r.ip = e.data.ip;
        break;
      case 'session':
        if (e.data.ua && !r.ua) r.ua = e.data.ua;
        break;
      case 'intervention':
        r.interventions.push({ kind: e.data.kind, ok: e.data.ok, ts: e.ts, source: e.source });
        break;
      default:
        break;
    }
  }

  function setSite(sessionId: string, site: string, origin?: string, ip?: string): void {
    const prev = sites.get(sessionId);
    if (prev && prev.site === site && prev.origin === origin) return;
    sites.set(sessionId, { site, ...(origin ? { origin } : {}) });
    const r = rows.get(sessionId);
    if (r) {
      r.site = site;
      if (origin) r.origin = origin;
      if (ip && !r.ip) r.ip = ip;
    }
    if (file) appendFileSync(file, JSON.stringify({ _site: { sessionId, site, origin } }) + '\n');
  }

  const sink: EventSink = {
    write(events: SessionEvent[]) {
      for (const e of events) apply(e);
      if (file && events.length) appendFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    },
  };

  // Replay history.
  if (opts.dataDir) {
    mkdirSync(opts.dataDir, { recursive: true });
    if (file && existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const obj = JSON.parse(line) as SessionEvent | { _site: { sessionId: string; site: string; origin?: string } };
          if ('_site' in obj) sites.set(obj._site.sessionId, { site: obj._site.site, ...(obj._site.origin ? { origin: obj._site.origin } : {}) });
          else apply(obj);
        } catch {
          /* torn line */
        }
      }
      for (const [id, s] of sites) {
        const r = rows.get(id);
        if (r) {
          r.site = s.site;
          if (s.origin) r.origin = s.origin;
        }
      }
    }
  }

  return {
    sink,
    setSite,
    get: (id: string) => rows.get(id),
    list(filter: { site?: string; limit?: number; agentsOnly?: boolean; threshold?: number } = {}): SessionSummary[] {
      const out: SessionSummary[] = [];
      const threshold = filter.threshold ?? 75;
      for (const r of rows.values()) {
        if (filter.site && r.site !== filter.site) continue;
        const s = summarize(r);
        if (filter.agentsOnly && s.score < threshold) continue;
        out.push(s);
      }
      out.sort((a, b) => b.lastTs - a.lastTs);
      return out.slice(0, filter.limit ?? 300);
    },
    sites(): { site: string; sessions: number; agents: number; lastTs: number }[] {
      const by = new Map<string, { site: string; sessions: number; agents: number; lastTs: number }>();
      for (const r of rows.values()) {
        const s = by.get(r.site) ?? { site: r.site, sessions: 0, agents: 0, lastTs: 0 };
        s.sessions++;
        if (verdictOf(r) && verdictOf(r)!.score >= 75) s.agents++;
        s.lastTs = Math.max(s.lastTs, r.lastTs);
        by.set(r.site, s);
      }
      return [...by.values()].sort((a, b) => b.lastTs - a.lastTs);
    },
    clear(): void {
      rows.clear();
      sites.clear();
      if (file) writeFileSync(file, '');
    },
    size: () => rows.size,
  };
}

export type SessionIndex = ReturnType<typeof createSessionIndex>;

/** The fused server verdict when there is one, else what the page computed itself. */
export function verdictOf(r: SessionRow): Verdict | undefined {
  return r.verdict ?? r.clientVerdict;
}

export function summarize(r: SessionRow): SessionSummary {
  const v = verdictOf(r);
  const s: SessionSummary = {
    id: r.id,
    site: r.site,
    firstTs: r.firstTs,
    lastTs: r.lastTs,
    pageCount: r.pages.length,
    score: v?.score ?? 0,
    automation: v?.automation ?? 0,
    actorClass: v?.actorClass ?? 'unknown',
    deterministic: v?.deterministic ?? false,
    evidence: (v?.evidence ?? []).slice(0, 6).map((e) => ({ id: e.signalId, summary: e.summary, contribution: e.contribution, layer: e.layer })),
    interventions: [...new Set(r.interventions.filter((i) => i.ok && !PASSIVE_ACTIONS.has(i.kind)).map((i) => i.kind))],
    eventCount: r.eventCount,
  };
  if (r.origin) s.origin = r.origin;
  if (r.pages.length) s.lastPage = r.pages[r.pages.length - 1]!;
  if (r.ua) s.ua = r.ua;
  if (r.ip) s.ip = r.ip;
  if (v?.provider) {
    s.provider = v.provider.product ? `${providerName(v.provider.id)} · ${v.provider.product}` : providerName(v.provider.id);
    s.providerVerified = v.provider.verified;
  }
  if (v?.stage) s.stage = v.stage;
  return s;
}

function pageOf(e: SessionEvent): string | undefined {
  if (e.type === 'request') return e.data.path;
  if (e.source === 'client' && e.type === 'session' && e.url) {
    try {
      const u = new URL(e.url);
      return u.pathname + u.search;
    } catch {
      return e.url;
    }
  }
  return undefined;
}
