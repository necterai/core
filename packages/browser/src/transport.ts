import type { SessionEvent } from '@necterai/core';
import type { BeaconConfig } from './types.js';

export interface Transport {
  push(event: SessionEvent): void;
  flush(opts?: { unload?: boolean }): Promise<void>;
  dispose(): void;
}

/**
 * Batches session events to `${endpoint}/beacon`. Uses fetch with keepalive and
 * falls back to navigator.sendBeacon on page hide. Failures are retried with a
 * bounded queue; nothing here can throw into the host page.
 */
export function createTransport(opts: {
  endpoint: string;
  sessionId: string;
  siteKey?: string;
  config: BeaconConfig;
  log: (...a: unknown[]) => void;
}): Transport {
  const url = `${opts.endpoint.replace(/\/$/, '')}/beacon`;
  // A hosted collector lives on another origin. Plain-text bodies are a CORS "simple request":
  // no preflight, and sendBeacon accepts them (it rejects cross-origin application/json).
  const crossOrigin = isCrossOrigin(url);
  const contentType = crossOrigin ? 'text/plain;charset=UTF-8' : 'application/json';
  let queue: SessionEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let inflight: Promise<void> | undefined;
  const MAX_QUEUE = 500;

  function schedule(): void {
    if (timer || disposed || !opts.config.enabled) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, opts.config.intervalMs);
  }

  function payload(events: SessionEvent[]): string {
    return JSON.stringify({ v: 1, sessionId: opts.sessionId, siteKey: opts.siteKey, sentAt: Date.now(), events });
  }

  async function send(events: SessionEvent[], unload: boolean): Promise<boolean> {
    const body = payload(events);
    if (unload && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      try {
        if (navigator.sendBeacon(url, new Blob([body], { type: contentType }))) return true;
      } catch {
        /* fall through */
      }
    }
    if (typeof fetch !== 'function') return false;
    try {
      const res = await fetch(url, {
        method: 'POST',
        body,
        headers: { 'content-type': contentType },
        keepalive: true,
        credentials: crossOrigin ? 'omit' : 'same-origin',
        cache: 'no-store',
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function flush(flushOpts: { unload?: boolean } = {}): Promise<void> {
    if (!opts.config.enabled || queue.length === 0) return;
    if (inflight && !flushOpts.unload) return inflight;
    const batch = queue.splice(0, flushOpts.unload ? queue.length : opts.config.maxBatch);
    inflight = (async () => {
      const ok = await send(batch, Boolean(flushOpts.unload));
      if (!ok && !flushOpts.unload) {
        // Put back at the front, bounded.
        queue = batch.concat(queue).slice(0, MAX_QUEUE);
        opts.log('beacon failed; requeued', batch.length);
      }
    })();
    try {
      await inflight;
    } finally {
      inflight = undefined;
      if (queue.length) schedule();
    }
  }

  const onHide = () => {
    if (document.visibilityState === 'hidden') void flush({ unload: true });
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', () => void flush({ unload: true }));
  }

  return {
    push(event) {
      if (disposed || !opts.config.enabled) return;
      queue.push(event);
      if (queue.length > MAX_QUEUE) queue.shift();
      if (queue.length >= opts.config.maxBatch) void flush();
      else schedule();
    },
    flush,
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onHide);
    },
  };
}

function isCrossOrigin(url: string): boolean {
  try {
    if (typeof location === 'undefined') return false;
    return new URL(url, location.href).origin !== location.origin;
  } catch {
    return false;
  }
}
