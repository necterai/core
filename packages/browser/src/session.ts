import { SESSION_COOKIE, randomId } from '@necterai/core';
import type { Session } from './types.js';

const STORAGE_KEY = '__necter';

interface Persisted {
  id: string;
  created: number;
  pageViews: number;
}

function readCookie(name: string): string | undefined {
  try {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&') + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]!) : undefined;
  } catch {
    return undefined;
  }
}

function writeCookie(name: string, value: string, maxAgeSeconds: number): void {
  try {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax${secure}`;
  } catch {
    /* cookies disabled */
  }
}

function readStorage(): Persisted | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    if (typeof parsed.id === 'string' && typeof parsed.created === 'number') {
      return { id: parsed.id, created: parsed.created, pageViews: parsed.pageViews ?? 0 };
    }
  } catch {
    /* storage blocked */
  }
  return undefined;
}

function writeStorage(p: Persisted): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* storage blocked */
  }
}

/**
 * Resolve the session: prefer an integrator-provided id, then the server cookie,
 * then localStorage, else mint one. "First visit" means no durable state existed
 * at all, which is normal for a human once and typical for an agent every time.
 */
export function resolveSession(providedId?: string): Session {
  const now = Date.now();
  const cookieId = readCookie(SESSION_COOKIE);
  const stored = readStorage();
  const id = providedId ?? cookieId ?? stored?.id ?? randomId();
  const firstVisit = !cookieId && !stored;
  const persisted: Persisted = {
    id,
    created: stored?.created ?? now,
    pageViews: (stored?.pageViews ?? 0) + 1,
  };
  writeStorage(persisted);
  if (!cookieId || cookieId !== id) writeCookie(SESSION_COOKIE, id, 60 * 60 * 24 * 30);
  return { id, firstVisit, startedAt: now, pageViews: persisted.pageViews };
}
