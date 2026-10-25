import { describe, expect, it } from 'vitest';
import { createMemorySink } from '@necterai/core';
import { createNecter } from '../src/index.js';

const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
const browserHeaders = {
  'user-agent': CHROME_UA,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'accept-encoding': 'gzip, deflate, br, zstd',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-ch-ua': '"Google Chrome";v="155", "Chromium";v="155", "Not_A Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
};

function req(path: string, headers: Record<string, string>, init: RequestInit = {}): Request {
  return new Request('https://example.test' + path, { headers, ...init });
}

describe('server inspect', () => {
  it('lets a normal browser navigation through and sets a session cookie', async () => {
    const cm = createNecter({ mode: 'enforce' });
    const ins = await cm.inspect(req('/products', browserHeaders), { ip: '203.0.113.5' });
    expect(ins.verdict.actorClass).toBe('human');
    expect(ins.decision.primary).toBe('allow');
    expect(ins.response).toBeUndefined();
    expect(ins.responseHeaders['set-cookie']).toContain('__necter_sid=');
  });

  it('classifies python-requests as a fetch agent / library client and blocks or redirects in enforce mode', async () => {
    const cm = createNecter({ mode: 'enforce' });
    const ins = await cm.inspect(req('/article', { 'user-agent': 'python-requests/2.32.3', accept: '*/*', 'accept-encoding': 'gzip, deflate' }), { ip: '198.51.100.9' });
    expect(ins.verdict.automation).toBeGreaterThan(0.85);
    expect(['fetch-agent', 'scripted-automation']).toContain(ins.verdict.actorClass);
    expect(ins.signals.map((s) => s.id)).toEqual(expect.arrayContaining(['declared.http-library-ua', 'request.no-browser-headers', 'request.library-accept-encoding']));
    expect(ins.response?.status).toBeGreaterThanOrEqual(400);
  });

  it('attributes ChatGPT-User to OpenAI as a fetch agent and redirects to the gateway', async () => {
    const cm = createNecter({ mode: 'enforce' });
    const ua = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot';
    const ins = await cm.inspect(req('/article', { 'user-agent': ua, accept: 'text/html' }), { ip: '198.51.100.10' });
    expect(ins.verdict.provider?.id).toBe('openai');
    expect(ins.verdict.actorClass).toBe('fetch-agent');
    expect(ins.decision.primary).toBe('redirect');
    expect(ins.response?.status).toBe(402);
    expect(ins.response?.headers.get('link')).toContain('agent-access');
  });

  it('monitor mode labels but never enforces', async () => {
    const cm = createNecter({ mode: 'monitor' });
    const ins = await cm.inspect(req('/article', { 'user-agent': 'GPTBot/1.2 (+https://openai.com/gptbot)' }), {});
    expect(ins.response).toBeUndefined();
    expect(ins.decision.mode).toBe('monitor');
    expect(ins.responseHeaders['x-necter-class']).toBe('ai-crawler');
  });

  it('flags a browser UA that lacks browser headers', async () => {
    const cm = createNecter();
    const ins = await cm.inspect(req('/', { 'user-agent': CHROME_UA, accept: '*/*' }), {});
    const ids = ins.signals.map((s) => s.id);
    expect(ids).toContain('request.no-browser-headers');
    expect(ids).toContain('request.client-hints-mismatch');
  });

  it('infers no-JS execution for a cookie-less client that fetches HTML repeatedly', async () => {
    let t = 1_000_000;
    const cm = createNecter({ now: () => t, noJsGraceMs: 1000 });
    const h = { ...browserHeaders };
    const ip = '192.0.2.44';
    await cm.inspect(req('/a', h), { ip });
    t += 1500;
    await cm.inspect(req('/b', h), { ip });
    t += 1500;
    const third = await cm.inspect(req('/c', h), { ip });
    expect(third.signals.map((s) => s.id)).toContain('tie.no-js-execution');
    t += 1500;
    const fourth = await cm.inspect(req('/d', h), { ip });
    const ids = fourth.signals.map((s) => s.id);
    expect(ids).toContain('tie.no-js-execution');
    expect(ids).toContain('request.no-cookie-persistence');
    expect(fourth.verdict.automation).toBeGreaterThan(0.5);
  });

  it('does not treat the canary "issued" event as a hit, and keeps the client signal reliability', async () => {
    const cm = createNecter({ mode: 'monitor' });
    const first = await cm.inspect(req('/products', browserHeaders), { ip: '203.0.113.8' });
    const sid = first.session.id;
    const post = (events: unknown[]) =>
      cm.handleEndpoint(
        req('/__necter/beacon', { 'content-type': 'application/json', cookie: `__necter_sid=${sid}`, 'user-agent': CHROME_UA }, {
          method: 'POST',
          body: JSON.stringify({ v: 1, sessionId: sid, sentAt: Date.now(), events }),
        }),
      );
    const issued = await post([{ id: 'c1', sessionId: sid, ts: Date.now(), source: 'client', type: 'canary', data: { token: 'tok-a', kind: 'other', detail: { phase: 'issued' } } }]);
    const issuedBody = await issued!.json();
    expect(issuedBody.actorClass).not.toBe('browser-agent');
    let s = await cm.inspect(req('/a', { ...browserHeaders, cookie: `__necter_sid=${sid}` }), { ip: '203.0.113.8' });
    expect(s.verdict.evidence.some((e) => e.signalId.startsWith('canary.'))).toBe(false);

    // A low-reliability instruction read: the client signal must not be upgraded to full weight.
    await post([
      { id: 'c2', sessionId: sid, ts: Date.now(), source: 'client', type: 'canary', data: { token: 'tok-a', kind: 'instruction', detail: { signal: 'canary.instruction-followed' } } },
      { id: 'c3', sessionId: sid, ts: Date.now(), source: 'client', type: 'signal', data: { signals: [{ id: 'canary.instruction-followed', layer: 'canary', strength: 'strong', source: 'client', ts: Date.now(), summary: 'read by extension', reliability: 0.3 }] } },
    ]);
    s = await cm.inspect(req('/b', { ...browserHeaders, cookie: `__necter_sid=${sid}` }), { ip: '203.0.113.8' });
    const sig = s.session.signals.get('canary.instruction-followed');
    expect(sig?.reliability).toBe(0.3);
  });

  it('handles its own endpoints: health, gateway, beacon ingest and canary', async () => {
    const sink = createMemorySink();
    const cm = createNecter({ mode: 'enforce', sink });
    const health = await cm.handleEndpoint(req('/__necter/health', {}));
    expect(health?.status).toBe(200);
    const gateway = await cm.handleEndpoint(req('/.well-known/agent-access', { accept: 'application/json' }));
    expect(gateway?.status).toBe(200);
    expect(await gateway!.json()).toMatchObject({ identify: 'web-bot-auth' });

    // A browser session first.
    const first = await cm.inspect(req('/products', browserHeaders), { ip: '203.0.113.7' });
    const sid = first.session.id;
    const beacon = await cm.handleEndpoint(
      req('/__necter/beacon', { 'content-type': 'application/json', cookie: `__necter_sid=${sid}`, 'user-agent': CHROME_UA }, {
        method: 'POST',
        body: JSON.stringify({
          v: 1,
          sessionId: sid,
          sentAt: Date.now(),
          events: [
            { id: 'e1', sessionId: sid, ts: Date.now(), source: 'client', type: 'signal', data: { signals: [{ id: 'probe.playwright-artifact', layer: 'probe', strength: 'deterministic', source: 'client', ts: Date.now(), summary: '__pwInitScripts present' }] } },
          ],
        }),
      }),
    );
    expect(beacon?.status).toBe(200);
    const body = await beacon!.json();
    expect(body.actorClass).toBe('browser-agent');
    expect(body.action).toBe('block');
    const next = await cm.inspect(req('/api/items', { ...browserHeaders, cookie: `__necter_sid=${sid}`, accept: 'application/json' }), { ip: '203.0.113.7' });
    expect(next.response?.status).toBe(403);

    const canary = await cm.handleEndpoint(req(`/__necter/canary/${sid}.tok12345`, { 'user-agent': 'curl/8.0' }));
    expect(canary?.headers.get('content-type')).toBe('image/gif');
    const v = await cm.verdictFor(sid);
    expect(v?.evidence.some((e) => e.signalId === 'canary.hidden-link-followed')).toBe(true);
    expect(sink.events.some((e) => e.type === 'canary')).toBe(true);
  });

  it('clamps client-reported weights to registry defaults and floors unknown ids', async () => {
    const cm = createNecter();
    const r = await cm.ingest(
      {
        v: 1,
        sessionId: 'abcdefgh12345678',
        sentAt: 0,
        events: [
          { id: 'x', sessionId: 'abcdefgh12345678', ts: 1, source: 'client', type: 'signal', data: { signals: [
            { id: 'env.utc-timezone', layer: 'environment', strength: 'weak', source: 'client', ts: 1, summary: 'utc', automation: 50 },
            { id: 'made.up-signal', layer: 'environment', strength: 'deterministic', source: 'client', ts: 1, summary: 'bogus', automation: 99 },
          ] } },
        ],
      } as never,
      {},
    );
    expect(r.verdict.automation).toBeLessThan(0.3);
  });

  it('respects the allowlist for site-owner automation', async () => {
    const cm = createNecter({ mode: 'enforce', allowlist: { userAgents: ['my-ci-runner'] } });
    const ins = await cm.inspect(req('/', { 'user-agent': 'HeadlessChrome/155 my-ci-runner' }), {});
    expect(ins.decision.primary).toBe('allow');
    expect(ins.response).toBeUndefined();
  });
});

describe('cross-origin collector (cors option)', () => {
  const beacon = (origin?: string) =>
    new Request('https://collector.test/__necter/beacon', {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=UTF-8', ...(origin ? { origin } : {}) },
      body: JSON.stringify({ v: 1, sessionId: 'sess-cors-0001', siteKey: 'shop', sentAt: Date.now(), events: [] }),
    });

  it('answers preflights and beacons from any origin when cors is true', async () => {
    const cm = createNecter({ cors: true });
    const pre = await cm.handleEndpoint(new Request('https://collector.test/__necter/beacon', { method: 'OPTIONS', headers: { origin: 'https://shop.example', 'access-control-request-private-network': 'true' } }));
    expect(pre?.status).toBe(204);
    expect(pre?.headers.get('access-control-allow-origin')).toBe('https://shop.example');
    expect(pre?.headers.get('access-control-allow-private-network')).toBe('true');
    const res = await cm.handleEndpoint(beacon('https://shop.example'));
    expect(res?.status).toBe(200);
    expect(res?.headers.get('access-control-allow-origin')).toBe('https://shop.example');
  });

  it('rejects beacons from origins outside the allow list', async () => {
    const cm = createNecter({ cors: ['https://shop.example'] });
    expect((await cm.handleEndpoint(beacon('https://shop.example')))?.status).toBe(200);
    expect((await cm.handleEndpoint(beacon('https://evil.example')))?.status).toBe(403);
  });

  it('adds no CORS headers when the option is off', async () => {
    const cm = createNecter({});
    const res = await cm.handleEndpoint(beacon('https://shop.example'));
    expect(res?.headers.get('access-control-allow-origin')).toBeNull();
  });
});
