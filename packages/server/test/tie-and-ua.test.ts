import { describe, expect, it } from 'vitest';
import type { Signal } from '@necterai/core';
import { CRAWL4AI_DEFAULT_UA, compareHints, createNecter, resolveDeclaredAgent, userAgentAnalyzer } from '../src/index.js';

const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
const CHROME_HEADERS = {
  'user-agent': CHROME_UA,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'accept-language': 'en-US,en;q=0.9',
  'accept-encoding': 'gzip, deflate, br, zstd',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-ch-ua': '"Google Chrome";v="155", "Chromium";v="155", "Not_A Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
};
const MATCHING_HINTS = {
  ua: CHROME_UA,
  languages: ['en-US', 'en'],
  brands: [
    { brand: 'Google Chrome', version: '155' },
    { brand: 'Chromium', version: '155' },
    { brand: 'Not_A Brand', version: '24' },
  ],
  mobile: false,
  uaPlatform: 'macOS',
  platform: 'MacIntel',
};

function sessionEvent(sid: string, hints: object) {
  return { v: 1, sessionId: sid, sentAt: Date.now(), events: [{ id: 'e1', sessionId: sid, ts: Date.now(), source: 'client', type: 'session', data: { action: 'start', ua: CHROME_UA, hints } }] } as never;
}

describe('tie: JS-reported hints vs request headers (C11)', () => {
  it('stores the last document headers and emits tie.hint-js-mismatch on a contradiction', async () => {
    const cm = createNecter();
    const first = await cm.inspect(new Request('https://shop.example.com/', { headers: CHROME_HEADERS }), { ip: '203.0.113.30' });
    expect(first.session.lastDocumentHeaders?.['sec-ch-ua']).toContain('Google Chrome');
    // curl_cffi-style header spoof: the page's JS runs in a different browser (Headless Chromium, Linux, de-DE).
    const spoofedHints = {
      ...MATCHING_HINTS,
      languages: ['de-DE'],
      brands: [{ brand: 'Chromium', version: '150' }, { brand: 'Not)A;Brand', version: '8' }],
      uaPlatform: 'Linux',
    };
    const { verdict } = await cm.ingest(sessionEvent(first.session.id, spoofedHints), { ua: CHROME_UA });
    const session = await cm.store.get(first.session.id);
    const tie = session!.signals.get('tie.hint-js-mismatch') as Signal;
    expect(tie).toBeDefined();
    expect(tie.source).toBe('server');
    expect(tie.layer).toBe('tie');
    expect(tie.details?.['fields']).toEqual(expect.arrayContaining(['brands', 'language', 'platform']));
    expect(session!.lastClientHints?.uaPlatform).toBe('Linux');
    expect(verdict.evidence.some((e) => e.signalId === 'tie.hint-js-mismatch')).toBe(true);
  });

  it('consistent hints produce no tie signal', async () => {
    const cm = createNecter();
    const first = await cm.inspect(new Request('https://shop.example.com/', { headers: CHROME_HEADERS }), { ip: '203.0.113.31' });
    await cm.ingest(sessionEvent(first.session.id, MATCHING_HINTS), { ua: CHROME_UA });
    const session = await cm.store.get(first.session.id);
    expect(session!.signals.has('tie.hint-js-mismatch')).toBe(false);
    expect(session!.verdict?.actorClass).toBe('human');
  });

  it('a regional language variant is a weak mismatch, a different language a strong one', () => {
    const headers = { 'accept-language': 'en-US,en;q=0.9' };
    expect(compareHints(headers, { languages: ['en-GB'] })[0]?.reliability).toBe(0.5);
    expect(compareHints(headers, { languages: ['fr-FR'] })[0]?.reliability).toBe(1);
    expect(compareHints(headers, { languages: ['en-us'] })).toEqual([]);
  });

  it('ignores malformed client hints', async () => {
    const cm = createNecter();
    const first = await cm.inspect(new Request('https://shop.example.com/', { headers: CHROME_HEADERS }), {});
    await cm.ingest(sessionEvent(first.session.id, { brands: 'nope', languages: [42], uaPlatform: 7 }), {});
    const session = await cm.store.get(first.session.id);
    expect(session!.signals.has('tie.hint-js-mismatch')).toBe(false);
  });
});

async function uaSignals(ua: string) {
  const cm = createNecter({ analyzers: [userAgentAnalyzer()] });
  const ins = await cm.inspect(new Request('https://shop.example.com/', { headers: { 'user-agent': ua } }), {});
  return ins.signals;
}

describe('user-agent: classes and provider hints from the knowledge base', () => {
  it('GPTBot → ai-crawler, provider openai (unverified hint 0.55)', async () => {
    const [s] = await uaSignals('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.4; +https://openai.com/gptbot');
    expect(s?.id).toBe('declared.ai-crawler-ua');
    expect(s?.provider).toMatchObject({ id: 'openai', product: 'GPTBot', confidence: 0.55 });
    expect(s?.details).toMatchObject({ verification: 'unverified' });
    expect(String(s?.details?.['agentId'])).toMatch(/gptbot$/);
  });

  it('ChatGPT-User → fetch-agent class, provider openai', async () => {
    const ua = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot';
    const declared = resolveDeclaredAgent(ua);
    expect(declared?.record.class).toBe('fetch-agent');
    const [s] = await uaSignals(ua);
    expect(s?.id).toBe('declared.ai-agent-ua');
    expect(s?.provider).toMatchObject({ id: 'openai', product: 'ChatGPT-User' });
  });

  it('Google-Agent → declared.ai-agent-ua with a computer-use-agent class boost', async () => {
    const [s] = await uaSignals('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko; compatible; Google-Agent; +https://developers.google.com/crawling/docs/crawlers-fetchers/google-agent) Chrome/141.0.7390.122 Safari/537.36');
    expect(s?.id).toBe('declared.ai-agent-ua');
    expect(s?.classes?.['computer-use-agent']).toBeGreaterThan(0);
    expect(s?.provider).toMatchObject({ id: 'google', product: 'Google-Agent' });
  });

  it('Claude-User → provider anthropic', async () => {
    const [s] = await uaSignals('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)');
    expect(s?.id).toBe('declared.ai-agent-ua');
    expect(s?.provider).toMatchObject({ id: 'anthropic', product: 'Claude-User', confidence: 0.55 });
  });

  it('Crawl4AI frozen default UA (no KHTML token) is declared automation attributed to Crawl4AI', async () => {
    // The knowledge base carries a dedicated Crawl4AI record; without it the frozen-UA tell
    // (declared.http-library-ua at 0.7) is the fallback. Either way: automation, provider crawl4ai.
    const [s] = await uaSignals(CRAWL4AI_DEFAULT_UA);
    expect(s?.id).toMatch(/^declared\.(ai-agent-ua|http-library-ua)$/);
    expect(s?.provider?.id).toBe('crawl4ai');
  });

  it('a plain Chrome UA declares nothing', async () => {
    expect(await uaSignals(CHROME_UA)).toEqual([]);
  });
});

describe('browser-shaped UA patterns', () => {
  it('does not declare a real Chrome 124 macOS visitor an AI crawler', async () => {
    const { userAgentAnalyzer } = await import('../src/analyzers/user-agent.js');
    const emitted: string[] = [];
    const api = { emit: (s: { id: string }) => (emitted.push(s.id), s), client: {}, session: {}, fetch, log: () => undefined, options: {} } as never;
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    const headers = new Headers({ 'user-agent': ua, accept: 'text/html' });
    await userAgentAnalyzer().analyze({ headers, url: new URL('https://x.test/'), isDocument: true } as never, api);
    expect(emitted.filter((id) => id.startsWith('declared.'))).toEqual([]);
  });
});

