import type { ClientAggregate, SessionRecord, SessionStore } from './types.js';

/** In-memory store with LRU-ish bounds. Replace with Redis/KV in production via the SessionStore interface. */
export function createMemoryStore(opts: { maxSessions?: number; maxClients?: number } = {}): SessionStore {
  const maxSessions = opts.maxSessions ?? 50_000;
  const maxClients = opts.maxClients ?? 50_000;
  const sessions = new Map<string, SessionRecord>();
  const clients = new Map<string, ClientAggregate>();
  return {
    get: (id) => sessions.get(id),
    save(record) {
      sessions.delete(record.id);
      sessions.set(record.id, record);
      if (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value as string);
    },
    client: (key) => clients.get(key),
    saveClient(agg) {
      clients.delete(agg.key);
      clients.set(agg.key, agg);
      if (clients.size > maxClients) clients.delete(clients.keys().next().value as string);
    },
    sweep(ttlMs, now) {
      let removed = 0;
      for (const [id, s] of sessions) {
        if (now - s.lastSeenAt > ttlMs) {
          sessions.delete(id);
          removed++;
        }
      }
      for (const [key, c] of clients) {
        if (now - c.lastSeenAt > ttlMs * 4) clients.delete(key);
      }
      return removed;
    },
    size: () => sessions.size,
  };
}

export function newSession(id: string, now: number, clientKey: string, ip?: string, ua?: string): SessionRecord {
  const s: SessionRecord = {
    id,
    createdAt: now,
    lastSeenAt: now,
    clientKey,
    signals: new Map(),
    requests: 0,
    documentsServed: 0,
    beacons: 0,
    canaryHits: [],
    tags: new Set(),
  };
  if (ip) s.ip = ip;
  if (ua) s.ua = ua;
  return s;
}

export function newClient(key: string, now: number): ClientAggregate {
  return {
    key,
    firstSeenAt: now,
    lastSeenAt: now,
    requests: 0,
    documents: 0,
    beacons: 0,
    cookieReturns: 0,
    cookieMisses: 0,
    paths: [],
    assets: 0,
    robotsTxt: 0,
    sitemap: 0,
    sessions: 0,
  };
}
