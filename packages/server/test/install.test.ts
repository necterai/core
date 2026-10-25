import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '@necterai/core';
import { connectConsole, createNecter } from '../src/index.js';

const get = (path: string) => new Request('https://example.test' + path, { headers: { 'user-agent': 'Mozilla/5.0' } });

describe('/__necter/script.js', () => {
  it('serves the bundled browser SDK with no setup', async () => {
    const res = await createNecter().handleEndpoint(get('/__necter/script.js'));
    expect(res?.status).toBe(200);
    expect(res?.headers.get('content-type')).toContain('javascript');
    const body = await res!.text();
    expect(body.length).toBeGreaterThan(10_000);
    expect(body).not.toContain('sourceMappingURL');
  });

  it('serves a custom build, or nothing when turned off', async () => {
    expect(await (await createNecter({ scriptContent: '/*mine*/' }).handleEndpoint(get('/__necter/script.js')))!.text()).toBe('/*mine*/');
    expect((await createNecter({ scriptContent: false }).handleEndpoint(get('/__necter/script.js')))?.status).toBe(404);
  });
});

describe('connectConsole', () => {
  afterEach(() => vi.unstubAllGlobals());
  const ev = (id: string) => ({ id, sessionId: 's', ts: 1, type: 'verdict' }) as unknown as SessionEvent;

  it('batches events to the ingest URL with the key', async () => {
    const calls: { url: string; auth: string | null; body: { events: { id: string }[] } }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, auth: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) });
      return new Response('{}', { status: 200 });
    });
    const sink = connectConsole({ url: 'https://console.test/api/ingest', key: 'cmk_test', batchMs: 5 });
    sink.write([ev('a'), ev('b')]);
    sink.write([ev('c')]);
    await sink.flush!();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://console.test/api/ingest');
    expect(calls[0]!.auth).toBe('Bearer cmk_test');
    expect(calls[0]!.body.events.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps events and retries when the console is down', async () => {
    let up = false;
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      if (!up) return new Response('', { status: 503 });
      seen.push(...JSON.parse(String(init.body)).events.map((e: { id: string }) => e.id));
      return new Response('{}');
    });
    const sink = connectConsole({ url: 'https://console.test/api/ingest', key: 'k', batchMs: 5 });
    sink.write([ev('a')]);
    await sink.flush!();
    expect(seen).toEqual([]);
    up = true;
    await sink.flush!();
    expect(seen).toEqual(['a']);
  });

  it('reads NECTER_CONSOLE_URL and NECTER_CONSOLE_KEY, and is a no-op without them', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const none = connectConsole();
    none.write([ev('a')]);
    await none.flush?.();
    expect(fetchSpy).not.toHaveBeenCalled();
    process.env.NECTER_CONSOLE_URL = 'https://console.test/api/ingest';
    process.env.NECTER_CONSOLE_KEY = 'cmk_env';
    try {
      const sink = connectConsole({ batchMs: 5 });
      sink.write([ev('a')]);
      await sink.flush!();
      expect(fetchSpy).toHaveBeenCalledOnce();
    } finally {
      delete process.env.NECTER_CONSOLE_URL;
      delete process.env.NECTER_CONSOLE_KEY;
    }
  });
});
