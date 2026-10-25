import { resourceProbeTargets, type AgentExtensionEntry, type ResourceProbeTarget } from './known-extensions.js';

/**
 * Web-accessible-resource presence probe.
 *
 * Measured behaviour (extension-agents.md 2.9 / 10): for a resource listed in
 * `web_accessible_resources` with `matches: ["<all_urls>"]`,
 * `fetch(url, {mode:'no-cors', cache:'no-store'})` resolves with
 * `ok === true`, `status === 200`, `type === 'basic'`. For a non-exposed path
 * (or an extension that is not installed) the promise rejects with a
 * `TypeError: Failed to fetch`. The fetch is not recorded in resource timing.
 *
 * A page CSP with `connect-src` that excludes `chrome-extension:` also rejects
 * with a TypeError, so a `securitypolicyviolation` listener decides whether the
 * `<link rel="prefetch">` fallback (onload = present, onerror = absent) runs.
 */

export type ProbeOutcome = 'present' | 'absent' | 'blocked' | 'unknown';

export interface ProbeResult {
  target: ResourceProbeTarget;
  outcome: ProbeOutcome;
  /** Which channel produced the outcome. */
  channel: 'fetch' | 'link' | 'none';
  status?: number;
  responseType?: string;
}

export interface WarProbeDeps {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Fallback probe; resolves true when the resource loaded. */
  linkProbe?: (url: string, timeoutMs: number) => Promise<boolean>;
  /** Returns true when the page CSP is known to block extension-scheme connects. */
  cspBlocksExtensionConnect?: () => boolean;
  /** Watch for securitypolicyviolation events during the fetch phase; returns a disposer. */
  watchViolations?: (onViolation: () => void) => () => void;
  /** setTimeout-like hook so tests control time. */
  wait?: (ms: number) => Promise<void>;
  linkTimeoutMs?: number;
}

export async function probeWithFetch(url: string, fetchImpl: NonNullable<WarProbeDeps['fetch']>): Promise<Pick<ProbeResult, 'outcome' | 'status' | 'responseType'>> {
  try {
    const res = await fetchImpl(url, { mode: 'no-cors', cache: 'no-store', credentials: 'omit' });
    const out: Pick<ProbeResult, 'outcome' | 'status' | 'responseType'> = { outcome: res.ok && res.status === 200 ? 'present' : 'absent', status: res.status };
    if (res.type) out.responseType = res.type;
    return out;
  } catch (err) {
    // TypeError is the measured "not accessible / not installed" baseline.
    return { outcome: err instanceof TypeError ? 'absent' : 'unknown' };
  }
}

/** Default `<link rel="prefetch">` fallback, CSP-safe (no inline code or style). */
export function defaultLinkProbe(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const doc = typeof document !== 'undefined' ? document : undefined;
      const head = doc?.head ?? doc?.documentElement;
      if (!doc || !head) return resolve(false);
      const link = doc.createElement('link');
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          link.remove();
        } catch {
          /* ignore */
        }
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      link.rel = 'prefetch';
      link.setAttribute('as', 'script');
      link.addEventListener('load', () => finish(true), { once: true, passive: true });
      link.addEventListener('error', () => finish(false), { once: true, passive: true });
      link.href = url;
      head.appendChild(link);
    } catch {
      resolve(false);
    }
  });
}

/** Parse a `<meta http-equiv="Content-Security-Policy">` for a connect-src that excludes extension schemes. */
export function metaCspBlocksExtensionConnect(doc: Document | undefined = typeof document !== 'undefined' ? document : undefined): boolean {
  try {
    if (!doc) return false;
    const metas = doc.querySelectorAll('meta[http-equiv]');
    for (const meta of metas) {
      if ((meta.getAttribute('http-equiv') ?? '').toLowerCase() !== 'content-security-policy') continue;
      const content = meta.getAttribute('content') ?? '';
      for (const directive of content.split(';')) {
        const parts = directive.trim().split(/\s+/);
        const name = (parts[0] ?? '').toLowerCase();
        if (name !== 'connect-src' && name !== 'default-src') continue;
        const sources = parts.slice(1).map((s) => s.toLowerCase());
        const allowsExt = sources.some((s) => s === '*' || s.startsWith('chrome-extension:') || s.startsWith('comet-extension:'));
        if (!allowsExt) return true;
        if (name === 'connect-src') return false;
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

export function defaultWatchViolations(onViolation: () => void): () => void {
  if (typeof document === 'undefined') return () => {};
  const handler = (e: Event) => {
    try {
      const ev = e as SecurityPolicyViolationEvent;
      const directive = (ev.effectiveDirective || ev.violatedDirective || '').toLowerCase();
      const blocked = (ev.blockedURI || '').toLowerCase();
      if ((directive.startsWith('connect-src') || directive.startsWith('default-src')) && /extension/.test(blocked)) onViolation();
    } catch {
      /* ignore */
    }
  };
  document.addEventListener('securitypolicyviolation', handler, { passive: true });
  return () => document.removeEventListener('securitypolicyviolation', handler);
}

/**
 * Probe every target. Fetch first; when CSP is known or observed to block
 * extension-scheme connects, re-run the non-present targets through the link
 * fallback. Never throws.
 */
export async function probeResources(targets: ResourceProbeTarget[], deps: WarProbeDeps = {}): Promise<ProbeResult[]> {
  const fetchImpl = deps.fetch ?? (typeof fetch === 'function' ? (u: string, i: RequestInit) => fetch(u, i) : undefined);
  const linkProbe = deps.linkProbe ?? defaultLinkProbe;
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const linkTimeoutMs = deps.linkTimeoutMs ?? 3000;
  const results: ProbeResult[] = [];
  let violation = false;
  const unwatch = (deps.watchViolations ?? defaultWatchViolations)(() => {
    violation = true;
  });
  try {
    const cspBlocked = (deps.cspBlocksExtensionConnect ?? metaCspBlocksExtensionConnect)();
    if (fetchImpl && !cspBlocked) {
      const settled = await Promise.all(
        targets.map(async (target) => {
          const r = await probeWithFetch(target.url, fetchImpl);
          const result: ProbeResult = { target, outcome: r.outcome, channel: 'fetch' };
          if (r.status !== undefined) result.status = r.status;
          if (r.responseType !== undefined) result.responseType = r.responseType;
          return result;
        }),
      );
      results.push(...settled);
      // Violation events are dispatched asynchronously; give them a tick.
      await wait(30);
    } else {
      results.push(...targets.map((target): ProbeResult => ({ target, outcome: 'blocked', channel: 'none' })));
    }
    const needFallback = cspBlocked || violation || !fetchImpl;
    if (needFallback) {
      for (const r of results) {
        if (r.outcome === 'present') continue;
        try {
          const ok = await linkProbe(r.target.url, linkTimeoutMs);
          r.outcome = ok ? 'present' : 'absent';
          r.channel = 'link';
        } catch {
          r.outcome = 'unknown';
        }
      }
    }
  } catch {
    /* never throw into the host page */
  } finally {
    try {
      unwatch();
    } catch {
      /* ignore */
    }
  }
  return results;
}

export interface ExtensionHit {
  entry: AgentExtensionEntry;
  version: string;
  paths: string[];
  channel: 'fetch' | 'link';
}

/** Group present results per extension. */
export function summariseHits(results: ProbeResult[]): ExtensionHit[] {
  const map = new Map<string, ExtensionHit>();
  for (const r of results) {
    if (r.outcome !== 'present' || r.channel === 'none') continue;
    const key = `${r.target.entry.id}@${r.target.version}`;
    const hit = map.get(key) ?? { entry: r.target.entry, version: r.target.version, paths: [], channel: r.channel };
    hit.paths.push(r.target.path);
    if (r.channel === 'fetch') hit.channel = 'fetch';
    map.set(key, hit);
  }
  return [...map.values()];
}

export { resourceProbeTargets };
