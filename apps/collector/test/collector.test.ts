import { describe, expect, it } from 'vitest';
import { createCollector, parseConfig } from '../src/main.js';
import { createSessionIndex } from '../src/store.js';
import { forward, injectScript, rewriteSetCookie, rewriteUpstreamLinks, scriptTag } from '../src/proxy.js';
import type { AddressInfo } from 'node:net';

const tag = scriptTag({ src: '/__necter/script.js', site: 'shop', mode: 'monitor' });

describe('proxy html helpers', () => {
  it('puts the tag after <meta charset>, else right after <head>', () => {
    expect(injectScript('<html><head><meta charset="utf-8"><title>x</title></head></html>', tag)).toBe(`<html><head><meta charset="utf-8">${tag}<title>x</title></head></html>`);
    expect(injectScript('<html><head lang="en"><title>x</title></head></html>', tag)).toBe(`<html><head lang="en">${tag}<title>x</title></head></html>`);
    expect(injectScript('<p>fragment</p>', tag)).toBe(`${tag}<p>fragment</p>`);
  });

  it('does not inject twice', () => {
    const once = injectScript('<head></head>', tag);
    expect(injectScript(once, tag)).toBe(once);
  });

  it('makes absolute upstream links relative so navigation stays on the proxy', () => {
    const up = new URL('https://shop.example');
    expect(rewriteUpstreamLinks('<a href="https://shop.example/cart">c</a><a href="//shop.example">h</a><a href="https://other.example/x">o</a>', up)).toBe('<a href="/cart">c</a><a href="">h</a><a href="https://other.example/x">o</a>');
  });

  it('drops the cookie Domain, and Secure when testing over http', () => {
    expect(rewriteSetCookie('sid=1; Domain=.shop.example; Path=/; Secure; SameSite=None', false)).toBe('sid=1; Path=/; SameSite=Lax');
    expect(rewriteSetCookie('sid=1; Domain=.shop.example; Secure', true)).toBe('sid=1; Secure');
  });

  it('forwards to the upstream, injects the SDK into HTML and rewrites redirects', async () => {
    const seen: Request[] = [];
    const fakeFetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const req = new Request(input, init);
      seen.push(req);
      if (req.url.endsWith('/old')) return new Response(null, { status: 302, headers: { location: 'https://shop.example/new' } });
      return new Response('<html><head><title>Shop</title></head><body><a href="https://shop.example/a">a</a></body></html>', { headers: { 'content-type': 'text/html', 'content-security-policy': "script-src 'nonce-x'" } });
    }) as typeof fetch;
    const opts = { upstream: new URL('https://shop.example'), site: 'shop', mode: 'monitor' as const, scriptPath: '/__necter/script.js', fetch: fakeFetch };
    const page = await forward(new Request('http://127.0.0.1:8788/products?x=1', { headers: { host: '127.0.0.1:8788', 'accept-encoding': 'gzip' } }), opts);
    const html = await page.text();
    expect(seen[0]!.url).toBe('https://shop.example/products?x=1');
    expect(seen[0]!.headers.get('x-forwarded-host')).toBe('127.0.0.1:8788');
    expect(html).toContain('data-site="shop"');
    expect(html).toContain('<a href="/a">');
    expect(page.headers.get('content-security-policy')).toBeNull();
    const redirect = await forward(new Request('http://127.0.0.1:8788/old'), opts);
    expect(redirect.headers.get('location')).toBe('/new');
  });
});

describe('session index', () => {
  it('builds rows from sink events and tags them with their site', () => {
    const index = createSessionIndex();
    index.setSite('sess-0001', 'shop', 'https://shop.example');
    index.sink.write([
      { id: 'e1', ts: 1000, sessionId: 'sess-0001', source: 'client', type: 'session', url: 'https://shop.example/pricing', data: { action: 'start', firstVisit: true, ua: 'UA' } },
      { id: 'e2', ts: 1100, sessionId: 'sess-0001', source: 'server', type: 'intervention', data: { kind: 'notify', ok: true } },
      { id: 'e3', ts: 1200, sessionId: 'sess-0001', source: 'server', type: 'intervention', data: { kind: 'block', ok: true } },
    ] as never);
    const [row] = index.list();
    expect(row).toMatchObject({ id: 'sess-0001', site: 'shop', origin: 'https://shop.example', lastPage: '/pricing', interventions: ['block'], actorClass: 'unknown' });
    expect(index.sites()).toEqual([{ site: 'shop', sessions: 1, agents: 0, lastTs: 1200 }]);
  });
});

describe('collector server', () => {
  async function start() {
    const cfg = parseConfig(['--data', 'none', '--port', '0'], {});
    const { server } = createCollector(cfg, 'window.__sdk = 1;');
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { base, close: () => server.close() };
  }

  it('serves the script, accepts a cross-origin beacon and lists the session under its site', async () => {
    const { base, close } = await start();
    try {
      const script = await fetch(`${base}/__necter/script.js?site=shop`);
      expect(script.status).toBe(200);
      expect(await script.text()).toContain('__sdk');
      const beacon = await fetch(`${base}/__necter/beacon`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=UTF-8', origin: 'https://shop.example' },
        body: JSON.stringify({ v: 1, sessionId: 'sess-abc-0001', siteKey: 'shop', sentAt: Date.now(), events: [{ id: 'x', ts: Date.now(), sessionId: 'sess-abc-0001', source: 'client', type: 'signal', data: { signals: [{ id: 'env.webdriver', summary: 'navigator.webdriver === true' }] } }] }),
      });
      expect(beacon.status).toBe(200);
      expect(beacon.headers.get('access-control-allow-origin')).toBe('https://shop.example');
      const sessions = (await (await fetch(`${base}/__necter/api/sessions`)).json()) as { id: string; site: string; origin: string; score: number }[];
      expect(sessions[0]).toMatchObject({ id: 'sess-abc-0001', site: 'shop', origin: 'https://shop.example' });
      expect(sessions[0]!.score).toBeGreaterThan(50);
      const detail = await fetch(`${base}/__necter/api/sessions/sess-abc-0001`);
      expect(detail.status).toBe(200);
    } finally {
      close();
    }
  });

  it('catches a fetch agent on the built-in test shop', async () => {
    const { base, close } = await start();
    try {
      const res = await fetch(`${base}/test/article`, { headers: { 'user-agent': 'python-requests/2.32.3', accept: '*/*' } });
      expect(res.status).toBe(200);
      const sessions = (await (await fetch(`${base}/__necter/api/sessions?site=test-page`)).json()) as { actorClass: string; score: number }[];
      expect(sessions[0]!.actorClass).toBe('fetch-agent');
    } finally {
      close();
    }
  });

  it('serves the dashboard and guards it with a token when one is set', async () => {
    const cfg = parseConfig(['--data', 'none', '--token', 's3cret'], {});
    const { server } = createCollector(cfg, '');
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect((await fetch(`${base}/__necter/ui/`)).status).toBe(401);
      const ok = await fetch(`${base}/__necter/ui/?token=s3cret`, { redirect: 'manual' });
      expect(ok.status).toBe(302);
      const cookie = ok.headers.get('set-cookie')!.split(';')[0]!;
      const page = await fetch(`${base}/__necter/ui/`, { headers: { cookie } });
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('"mode":"monitor"');
    } finally {
      server.close();
    }
  });
});
