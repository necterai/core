import { beforeAll, describe, expect, it } from 'vitest';
import type { Signal } from '@necterai/core';
import {
  DIRECTORY_MEDIA_TYPE,
  RFC9421_TEST_ED25519_X,
  createNecter,
  createWebBotAuthVerifier,
  directoryBody,
  generateEd25519KeyPair,
  importEd25519PrivateJwk,
  jwkThumbprint,
  parseWebBotAuthHeaders,
  signRequest,
  webBotAuthAnalyzer,
  type Ed25519KeyPair,
  type ServerOptions,
  type SignRequestOptions,
} from '../src/index.js';

const T0 = 1_790_000_000_000;
const AGENT = 'https://chatgpt.com';
const DIR_URL = 'https://chatgpt.com/.well-known/http-message-signatures-directory';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const RFC9421_TEST_D = 'n4Ni-HpISpVObnQMW0wOhCKROaIKqKtW_2ZYb2p9KcU';

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

/** A fetch stub that serves canned responses per URL and records every call. No network. */
function stubFetch(routes: Record<string, () => Response>): typeof fetch & { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const route = routes[url];
    return route ? route() : new Response('not found', { status: 404 });
  }) as typeof fetch & { calls: FetchCall[] };
  fn.calls = calls;
  return fn;
}

const directoryResponse = (keys: object[], extra: Record<string, unknown> = {}) => () =>
  new Response(directoryBody(keys as never, extra), { status: 200, headers: { 'content-type': DIRECTORY_MEDIA_TYPE } });

let keyA: Ed25519KeyPair;
let keyB: Ed25519KeyPair;
beforeAll(async () => {
  keyA = await generateEd25519KeyPair();
  keyB = await generateEd25519KeyPair();
});

let clock = T0;
function server(fetchImpl: typeof fetch, extra: Partial<ServerOptions> = {}) {
  return createNecter({ now: () => clock, fetch: fetchImpl, webBotAuth: { resolveHost: false }, analyzers: [webBotAuthAnalyzer()], ...extra });
}

let nonceSeq = 0;
async function signedRequest(key: Ed25519KeyPair, opts: Partial<SignRequestOptions> & { url?: string; sendUrl?: string; keyid?: string } = {}): Promise<Request> {
  const url = opts.url ?? 'https://shop.example.com/products';
  const { url: _u, sendUrl, ...signOpts } = opts;
  const h = await signRequest({ method: 'GET', url }, { privateKey: key.privateKey, keyid: key.thumbprint, agent: AGENT, nonce: `nonce-${++nonceSeq}`, now: () => clock, ...signOpts });
  const headers: Record<string, string> = { 'user-agent': UA, 'signature-input': h['signature-input'], signature: h.signature };
  if (h['signature-agent']) headers['signature-agent'] = h['signature-agent'];
  return new Request(sendUrl ?? url, { headers });
}

const byId = (signals: Signal[], id: string) => signals.find((s) => s.id === id);

describe('Web Bot Auth verification (RFC 9421 + directory)', () => {
  it('verifies a valid Ed25519 signature against the stubbed directory and attributes the operator', async () => {
    clock = T0;
    const fetchImpl = stubFetch({ [DIR_URL]: directoryResponse([{ ...keyA.jwk, kid: keyA.thumbprint, use: 'sig' }], { purpose: 'ai', signature_agent: AGENT }) });
    const cm = server(fetchImpl);
    const ins = await cm.inspect(await signedRequest(keyA), { ip: '203.0.113.20' });
    const verified = byId(ins.signals, 'network.web-bot-auth-verified');
    expect(verified).toBeDefined();
    expect(verified!.details).toMatchObject({ verification: 'passed', method: 'web-bot-auth', identity: AGENT, keyid: keyA.thumbprint, purpose: 'ai' });
    expect(verified!.provider).toMatchObject({ id: 'openai', confidence: 0.99 });
    expect(byId(ins.signals, 'declared.signature-agent')?.provider?.id).toBe('openai');
    expect(byId(ins.signals, 'network.web-bot-auth-invalid')).toBeUndefined();
    expect(ins.verdict.provider?.id).toBe('openai');
    expect(ins.verdict.provider?.verified).toBe(true);
    // Directory fetch contract: Accept media type, no redirects, one fetch.
    expect(fetchImpl.calls).toHaveLength(1);
    expect(fetchImpl.calls[0]!.url).toBe(DIR_URL);
    expect(fetchImpl.calls[0]!.init?.redirect).toBe('manual');
    expect((fetchImpl.calls[0]!.init?.headers as Record<string, string>).accept).toBe(DIRECTORY_MEDIA_TYPE);
  });

  it('accepts the draft Dictionary form and the RFC 7638 thumbprint when the directory has no kid (Meta style)', async () => {
    clock = T0;
    const agent = 'https://www.meta.com';
    const fetchImpl = stubFetch({ ['https://www.meta.com/.well-known/http-message-signatures-directory']: directoryResponse([{ kty: 'OKP', crv: 'Ed25519', x: keyA.jwk.x }]) });
    const cm = server(fetchImpl);
    const ins = await cm.inspect(await signedRequest(keyA, { agent, agentForm: 'dictionary', label: 'm1' }), { ip: '203.0.113.21' });
    const verified = byId(ins.signals, 'network.web-bot-auth-verified');
    expect(verified?.details?.['verification']).toBe('passed');
    expect(verified?.provider?.id).toBe('meta');
    expect(byId(ins.signals, 'declared.signature-agent')?.details?.['agentForm']).toBe('dictionary');
  });

  it('caches the directory for 15 minutes', async () => {
    clock = T0;
    const fetchImpl = stubFetch({ [DIR_URL]: directoryResponse([{ ...keyA.jwk, kid: keyA.thumbprint }]) });
    const cm = server(fetchImpl);
    await cm.inspect(await signedRequest(keyA), {});
    clock += 60_000;
    const second = await cm.inspect(await signedRequest(keyA), {});
    expect(byId(second.signals, 'network.web-bot-auth-verified')).toBeDefined();
    expect(fetchImpl.calls).toHaveLength(1);
    clock += 15 * 60_000;
    await cm.inspect(await signedRequest(keyA), {});
    expect(fetchImpl.calls).toHaveLength(2);
  });

  it('refetches once on an unknown kid (key rotation)', async () => {
    clock = T0;
    let keys: object[] = [{ ...keyA.jwk, kid: keyA.thumbprint }];
    const fetchImpl = stubFetch({ [DIR_URL]: () => directoryResponse(keys)() });
    const cm = server(fetchImpl);
    await cm.inspect(await signedRequest(keyA), {});
    keys = [{ ...keyA.jwk, kid: keyA.thumbprint }, { ...keyB.jwk, kid: keyB.thumbprint }];
    clock += 30_000;
    const ins = await cm.inspect(await signedRequest(keyB), {});
    expect(byId(ins.signals, 'network.web-bot-auth-verified')).toBeDefined();
    expect(fetchImpl.calls).toHaveLength(2);
  });

  it('rejects an expired signature', async () => {
    clock = T0;
    const fetchImpl = stubFetch({ [DIR_URL]: directoryResponse([{ ...keyA.jwk, kid: keyA.thumbprint }]) });
    const cm = server(fetchImpl);
    const created = Math.floor(T0 / 1000) - 7200;
    const ins = await cm.inspect(await signedRequest(keyA, { created, expires: created + 3600 }), {});
    const invalid = byId(ins.signals, 'network.web-bot-auth-invalid');
    expect(invalid?.details).toMatchObject({ verification: 'failed', status: 'invalid', reason: 'expired' });
    expect(invalid?.reliability).toBe(1);
    expect(byId(ins.signals, 'network.web-bot-auth-verified')).toBeUndefined();
  });

  it('rejects a validity window longer than 24 h and a created time in the future (beyond 60 s skew)', async () => {
    clock = T0;
    const fetchImpl = stubFetch({ [DIR_URL]: directoryResponse([{ ...keyA.jwk, kid: keyA.thumbprint }]) });
    const cm = server(fetchImpl);
    const now = Math.floor(T0 / 1000);
    const long = await cm.inspect(await signedRequest(keyA, { created: now, expires: now + 25 * 3600 }), {});
    expect(byId(long.signals, 'network.web-bot-auth-invalid')?.details?.['reason']).toBe('lifetime-too-long');
    const future = await cm.inspect(await signedRequest(keyA, { created: now + 300, expires: now + 600 }), {});
    expect(byId(future.signals, 'network.web-bot-auth-invalid')?.details?.['reason']).toBe('created-in-future');
    const skewed = await cm.inspect(await signedRequest(keyA, { created: now + 30, expires: now + 330 }), {});
    expect(byId(skewed.signals, 'network.web-bot-auth-verified')).toBeDefined();
  });

  it('rejects a signature made with the wrong key', async () => {
    clock = T0;
    const fetchImpl = stubFetch({ [DIR_URL]: directoryResponse([{ ...keyA.jwk, kid: keyA.thumbprint }]) });
    const cm = server(fetchImpl);
    // Signed by B but claims A's keyid.
    const ins = await cm.inspect(await signedRequest(keyB, { keyid: keyA.thumbprint }), {});
    expect(byId(ins.signals, 'network.web-bot-auth-invalid')?.details).toMatchObject({ status: 'invalid', reason: 'signature-mismatch' });
  });

  it('reports an unknown keyid as unknown-key with reduced reliability', async () => {
    clock = T0;
    const fetchImpl = stubFetch({ [DIR_URL]: directoryResponse([{ ...keyA.jwk, kid: keyA.thumbprint }]) });
    const cm = server(fetchImpl);
    const ins = await cm.inspect(await signedRequest(keyB), {});
    const invalid = byId(ins.signals, 'network.web-bot-auth-invalid');
    expect(invalid?.details).toMatchObject({ status: 'unknown-key', reason: 'unknown-keyid' });
    expect(invalid?.reliability).toBeLessThan(1);
  });

  it('rejects a tampered path (signature base no longer matches)', async () => {
    clock = T0;
    const fetchImpl = stubFetch({ [DIR_URL]: directoryResponse([{ ...keyA.jwk, kid: keyA.thumbprint }]) });
    const cm = server(fetchImpl);
    const ins = await cm.inspect(await signedRequest(keyA, { url: 'https://shop.example.com/products', sendUrl: 'https://shop.example.com/admin' }), {});
    expect(byId(ins.signals, 'network.web-bot-auth-invalid')?.details?.['reason']).toBe('signature-mismatch');
  });

  it('rejects a replayed nonce within the validity window', async () => {
    clock = T0;
    const fetchImpl = stubFetch({ [DIR_URL]: directoryResponse([{ ...keyA.jwk, kid: keyA.thumbprint }]) });
    const cm = server(fetchImpl);
    const original = await signedRequest(keyA, { nonce: 'fixed-nonce-1' });
    const replay = original.clone();
    const first = await cm.inspect(original, {});
    expect(byId(first.signals, 'network.web-bot-auth-verified')).toBeDefined();
    const second = await cm.inspect(replay, {});
    expect(byId(second.signals, 'network.web-bot-auth-invalid')?.details?.['reason']).toBe('replayed-nonce');
    expect(byId(second.signals, 'network.web-bot-auth-verified')).toBeUndefined();
  });

  it('treats a directory 404 as a discovery failure (directory-unavailable)', async () => {
    clock = T0;
    const fetchImpl = stubFetch({});
    const cm = server(fetchImpl);
    const ins = await cm.inspect(await signedRequest(keyA), {});
    const invalid = byId(ins.signals, 'network.web-bot-auth-invalid');
    expect(invalid?.details).toMatchObject({ status: 'directory-unavailable', reason: 'directory-status-404' });
    expect(invalid?.reliability).toBeLessThanOrEqual(0.5);
  });

  it('refuses to follow a directory redirect', async () => {
    clock = T0;
    const fetchImpl = stubFetch({ [DIR_URL]: () => new Response(null, { status: 302, headers: { location: 'https://evil.example.net/keys' } }) });
    const cm = server(fetchImpl);
    const ins = await cm.inspect(await signedRequest(keyA), {});
    expect(byId(ins.signals, 'network.web-bot-auth-invalid')?.details?.['reason']).toBe('redirect-refused');
    expect(fetchImpl.calls).toHaveLength(1);
    expect(fetchImpl.calls[0]!.init?.redirect).toBe('manual');
  });

  it('refuses private-IP and non-https directories without fetching (SSRF guard)', async () => {
    clock = T0;
    const fetchImpl = stubFetch({});
    const cm = server(fetchImpl);
    const literal = await cm.inspect(await signedRequest(keyA, { agent: 'https://10.0.0.5' }), {});
    expect(byId(literal.signals, 'network.web-bot-auth-invalid')?.details?.['reason']).toBe('directory-host-is-ip');
    const v6 = await cm.inspect(await signedRequest(keyA, { agent: 'https://[::1]' }), {});
    expect(byId(v6.signals, 'network.web-bot-auth-invalid')?.details?.['reason']).toBe('directory-host-is-ip');
    const http = await cm.inspect(await signedRequest(keyA, { agent: 'http://agent.example-bot.com' }), {});
    expect(byId(http.signals, 'network.web-bot-auth-invalid')?.details?.['reason']).toBe('directory-not-https');
    const local = await cm.inspect(await signedRequest(keyA, { agent: 'https://metadata.internal' }), {});
    expect(byId(local.signals, 'network.web-bot-auth-invalid')?.details?.['reason']).toBe('directory-host-local');
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('refuses a directory host that resolves to a private address (DNS SSRF guard)', async () => {
    clock = T0;
    const fetchImpl = stubFetch({ ['https://rebind.example-bot.com/.well-known/http-message-signatures-directory']: directoryResponse([{ ...keyA.jwk, kid: keyA.thumbprint }]) });
    const cm = server(fetchImpl, { webBotAuth: { resolveHost: async () => ['169.254.169.254'] } });
    const ins = await cm.inspect(await signedRequest(keyA, { agent: 'https://rebind.example-bot.com' }), {});
    expect(byId(ins.signals, 'network.web-bot-auth-invalid')?.details).toMatchObject({ status: 'directory-unavailable', reason: 'directory-host-private' });
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('refuses an oversized directory (> 64 KiB)', async () => {
    clock = T0;
    const big = 'x'.repeat(70 * 1024);
    const fetchImpl = stubFetch({ [DIR_URL]: directoryResponse([{ ...keyA.jwk, kid: keyA.thumbprint }], { padding: big }) });
    const cm = server(fetchImpl);
    const ins = await cm.inspect(await signedRequest(keyA), {});
    expect(byId(ins.signals, 'network.web-bot-auth-invalid')?.details?.['reason']).toBe('directory-too-large');
  });

  it('flags the RFC 9421 test key and never verifies it', async () => {
    clock = T0;
    const testPriv = await importEd25519PrivateJwk({ x: RFC9421_TEST_ED25519_X, d: RFC9421_TEST_D });
    const testJwk = { kty: 'OKP', crv: 'Ed25519', x: RFC9421_TEST_ED25519_X };
    const thumb = (await jwkThumbprint(testJwk))!;
    const fetchImpl = stubFetch({ [DIR_URL]: directoryResponse([{ ...testJwk, kid: thumb }]) });
    const cm = server(fetchImpl);
    const keyPair = { privateKey: testPriv, thumbprint: thumb } as unknown as Ed25519KeyPair;
    const ins = await cm.inspect(await signedRequest(keyPair), {});
    const invalid = byId(ins.signals, 'network.web-bot-auth-invalid');
    expect(invalid?.details).toMatchObject({ testKey: true, reason: 'test-key' });
    expect(invalid?.reliability).toBe(1);
    expect(byId(ins.signals, 'network.web-bot-auth-verified')).toBeUndefined();
    // The draft's published test-key thumbprint as keyid is rejected before any fetch.
    const before = fetchImpl.calls.length;
    const byKid = await cm.inspect(await signedRequest(keyPair, { keyid: 'poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U' }), {});
    expect(byId(byKid.signals, 'network.web-bot-auth-invalid')?.details?.['testKey']).toBe(true);
    expect(fetchImpl.calls.length).toBe(before);
  });

  it('requires signature-agent and @authority/@target-uri coverage and the web-bot-auth tag', async () => {
    clock = T0;
    const fetchImpl = stubFetch({ [DIR_URL]: directoryResponse([{ ...keyA.jwk, kid: keyA.thumbprint }]) });
    const cm = server(fetchImpl);
    const noAgentCovered = await cm.inspect(await signedRequest(keyA, { components: ['@authority', '@method', '@path'] }), {});
    expect(byId(noAgentCovered.signals, 'network.web-bot-auth-invalid')?.details?.['reason']).toBe('signature-agent-not-covered');
    const noAuthority = await cm.inspect(await signedRequest(keyA, { components: ['@method', '@path', 'signature-agent'] }), {});
    expect(byId(noAuthority.signals, 'network.web-bot-auth-invalid')?.details?.['reason']).toBe('authority-not-covered');
    const targetUri = await cm.inspect(await signedRequest(keyA, { components: ['@target-uri', 'signature-agent'] }), {});
    expect(byId(targetUri.signals, 'network.web-bot-auth-verified')).toBeDefined();
    // A different RFC 9421 tag (Visa TAP) is recorded as a claim but not judged.
    const tap = await cm.inspect(await signedRequest(keyA, { tag: 'agent-browser-auth' }), {});
    expect(byId(tap.signals, 'declared.signature-agent')?.details?.['otherTags']).toEqual(['agent-browser-auth']);
    expect(byId(tap.signals, 'network.web-bot-auth-invalid')).toBeUndefined();
    expect(byId(tap.signals, 'network.web-bot-auth-verified')).toBeUndefined();
  });

  it('only records the claim when verification is disabled', async () => {
    clock = T0;
    const fetchImpl = stubFetch({ [DIR_URL]: directoryResponse([{ ...keyA.jwk, kid: keyA.thumbprint }]) });
    const cm = server(fetchImpl, { verifyWebBotAuth: false });
    const ins = await cm.inspect(await signedRequest(keyA), {});
    expect(ins.signals.map((s) => s.id)).toEqual(['declared.signature-agent']);
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('parses the bare quoted string, the unquoted URL and the dictionary Signature-Agent forms', () => {
    const bare = parseWebBotAuthHeaders(new Headers({ 'signature-agent': '"https://chatgpt.com"' }));
    expect(bare.agents).toEqual([{ label: '*', url: 'https://chatgpt.com', type: 'directory' }]);
    const unquoted = parseWebBotAuthHeaders(new Headers({ 'signature-agent': 'https://chatgpt.com' }));
    expect(unquoted.agents[0]?.url).toBe('https://chatgpt.com');
    const dict = parseWebBotAuthHeaders(new Headers({ 'signature-agent': 'g="https://agent.bot.goog", j="https://x.example-bot.com/jwks.json";type=jwks_uri' }));
    expect(dict.agents).toEqual([
      { label: 'g', url: 'https://agent.bot.goog', type: 'directory' },
      { label: 'j', url: 'https://x.example-bot.com/jwks.json', type: 'jwks_uri' },
    ]);
  });

  it('caps directory fetches per minute (attacker-rotated Signature-Agent hosts)', async () => {
    clock = T0;
    const fetchImpl = stubFetch({});
    const verifier = createWebBotAuthVerifier({ fetch: fetchImpl, now: () => clock, maxFetchesPerMinute: 2 });
    const results = [];
    for (let i = 0; i < 4; i++) {
      const req = await signedRequest(keyA, { agent: `https://h${i}.example-bot.com` });
      results.push(await verifier.verify({ method: 'GET', url: req.url, headers: req.headers }));
    }
    expect(fetchImpl.calls).toHaveLength(2);
    expect(results[3]!.reason).toBe('directory-rate-limited');
  });
});
