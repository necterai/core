import type { EventSink, SessionEvent } from '@necterai/core';

export interface ConnectConsoleOptions {
  /** The console's ingest URL, e.g. `https://console.example.com/api/ingest`. Default: env `NECTER_CONSOLE_URL`. */
  url?: string;
  /** The site's ingest key (`cmk_…`). Default: env `NECTER_CONSOLE_KEY`. */
  key?: string;
  /** Wait this long to batch events before sending (default 1000 ms). */
  batchMs?: number;
  /** Most events per request (default 1000). */
  maxBatch?: number;
  /** Most events held in memory while the console is unreachable; the oldest are dropped first (default 50 000). */
  maxQueue?: number;
}

function env(name: string): string | undefined {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return p?.env?.[name] || undefined;
}

/**
 * Send session events to a Necter console, so every visitor shows up on its dashboard.
 *
 *   const necter = createNecter({ sink: connectConsole() })   // reads NECTER_CONSOLE_URL and NECTER_CONSOLE_KEY
 *
 * Events are batched (at most one request a second), retried with backoff while the console is unreachable and
 * capped in memory. Re-sending is safe: the console ignores event ids it already has. It never blocks a request.
 * Combine it with other sinks through `createFanoutSink` from `@necterai/core`.
 */
export function connectConsole(opts: ConnectConsoleOptions = {}): EventSink {
  const url = opts.url ?? env('NECTER_CONSOLE_URL');
  const key = opts.key ?? env('NECTER_CONSOLE_KEY');
  const { batchMs = 1000, maxBatch = 1000, maxQueue = 50_000 } = opts;
  if (!url || !key) {
    console.warn('[necter] connectConsole: no console URL or key (set NECTER_CONSOLE_URL and NECTER_CONSOLE_KEY); events are not sent');
    return { write() {} };
  }
  let queue: SessionEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let backoff = batchMs;
  let sending: Promise<void> | null = null;

  const schedule = (ms: number) => {
    if (!timer) timer = setTimeout(() => { timer = null; void flush(); }, ms);
  };

  async function send(): Promise<void> {
    while (queue.length) {
      const events = queue.slice(0, maxBatch);
      try {
        const res = await fetch(url!, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ events }),
        });
        if (res.status === 401) {
          console.error('[necter] the console rejected the ingest key; check NECTER_CONSOLE_KEY');
          queue = [];
          return;
        }
        if (res.status >= 500 || res.status === 429) throw new Error(`console answered ${res.status}`);
        queue.splice(0, events.length);
        backoff = batchMs;
      } catch {
        backoff = Math.min(backoff * 2, 60_000);
        schedule(backoff);
        return;
      }
    }
  }

  function flush(): Promise<void> {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!sending) sending = send().finally(() => { sending = null; });
    return sending;
  }

  return {
    write(events) {
      queue.push(...events);
      if (queue.length > maxQueue) queue.splice(0, queue.length - maxQueue);
      schedule(batchMs);
    },
    flush,
  };
}
