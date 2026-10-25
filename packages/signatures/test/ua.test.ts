import { describe, expect, it } from 'vitest';
import { agents, matchUserAgent } from '../src/index.js';

// Real UA strings copied from docs/research/raw (providers-tier1.md, providers-tier2.md,
// server-fingerprints.md sections 3.4 / 3.6 / 6, automation-stacks.md section 21).
const UA = {
  gptbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.4; +https://openai.com/gptbot',
  chatgptUser: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
  oaiSearchBot: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36; compatible; OAI-SearchBot/1.4; +https://openai.com/searchbot',
  oaiSearchBotRobots: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36; compatible; OAI-SearchBot/1.4; robots.txt; +https://openai.com/searchbot',
  claudeUser: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)',
  claudeUserCode: 'Claude-User (claude-code/2.1.86; +https://support.anthropic.com/)',
  googleAgentDesktop: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko; compatible; Google-Agent; +https://developers.google.com/crawling/docs/crawlers-fetchers/google-agent) Chrome/W.X.Y.Z Safari/537.36',
  googleAgentMobile: 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/W.X.Y.Z Mobile Safari/537.36 (compatible; Google-Agent; +https://developers.google.com/crawling/docs/crawlers-fetchers/google-agent)',
  googlebotSmartphone: 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/W.X.Y.Z Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  googlebotDesktop: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/W.X.Y.Z Safari/537.36',
  perplexityBot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
  perplexityUser: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)',
  amazonbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Amazonbot/0.1) Chrome/W.X.Y.Z Safari/537.36',
  applebotDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)',
  applebotMobile: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1 (Applebot/0.1; +http://www.apple.com/go/applebot)',
  bytespider: 'Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)',
  metaExternalAgent: 'meta-externalagent/1.1 (+/documentation/sharing/webmasters/web-crawlers)',
  metaExternalAgentShort: 'meta-externalagent/1.1',
  ccbot: 'CCBot/2.0 (https://commoncrawl.org/faq/)',
  requests: 'python-requests/2.34.2',
  httpx: 'python-httpx/0.28.1',
  undici: 'undici',
  nodeFetch: 'node',
  go: 'Go-http-client/1.1',
  go2: 'Go-http-client/2.0',
  curl: 'curl/8.7.1',
  scrapy: 'Scrapy/2.19.0 (+https://scrapy.org)',
  mcpFetch: 'ModelContextProtocol/1.0 (Autonomous; +https://github.com/modelcontextprotocol/servers)',
  mcpFetchManual: 'ModelContextProtocol/1.0 (User-Specified; +https://github.com/modelcontextprotocol/servers)',
  crawl4ai: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/116.0.0.0 Safari/537.36',
  chrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  firefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:147.0) Gecko/20100101 Firefox/147.0',
  safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0.1 Safari/605.1.15',
  prerender: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/W.X.Y.Z Safari/537.36 Prerender (+https://github.com/prerender/prerender)',
  headless: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/155.0.0.0 Safari/537.36',
  feedly: 'Feedly/1.0 (+http://www.feedly.com/fetcher.html; like FeedFetcher-Google)',
  telegram: 'TelegramBot (like TwitterBot)',
  googleOtherImage: 'GoogleOther-Image/1.0',
  manus: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36; Manus-User/1.0',
};

const ids = (ua: string) => matchUserAgent(ua).map((m) => m.record.id);
const first = (ua: string) => matchUserAgent(ua)[0]?.record.id;

describe('matchUserAgent: declared identities from the research', () => {
  it.each([
    ['gptbot', UA.gptbot],
    ['chatgpt-user', UA.chatgptUser],
    ['oai-searchbot', UA.oaiSearchBot],
    ['oai-searchbot', UA.oaiSearchBotRobots],
    ['claude-user', UA.claudeUser],
    ['claude-user', UA.claudeUserCode],
    ['google-agent', UA.googleAgentDesktop],
    ['google-agent', UA.googleAgentMobile],
    ['googlebot', UA.googlebotSmartphone],
    ['googlebot', UA.googlebotDesktop],
    ['perplexitybot', UA.perplexityBot],
    ['perplexity-user', UA.perplexityUser],
    ['amazonbot', UA.amazonbot],
    ['applebot', UA.applebotDesktop],
    ['applebot', UA.applebotMobile],
    ['bytespider', UA.bytespider],
    ['meta-externalagent', UA.metaExternalAgent],
    ['meta-externalagent', UA.metaExternalAgentShort],
    ['ccbot', UA.ccbot],
    ['lib-python-requests', UA.requests],
    ['lib-python-httpx', UA.httpx],
    ['lib-node-fetch-undici', UA.undici],
    ['lib-node-fetch-undici', UA.nodeFetch],
    ['lib-go', UA.go],
    ['lib-go', UA.go2],
    ['lib-curl', UA.curl],
    ['lib-scrapy', UA.scrapy],
    ['mcp-server-fetch', UA.mcpFetch],
    ['mcp-server-fetch', UA.mcpFetchManual],
    ['crawl4ai', UA.crawl4ai],
    ['manus-user', UA.manus],
    ['headless-chrome', UA.headless],
  ])('%s <- %s', (id, ua) => {
    expect(first(ua)).toBe(id);
  });

  it('returns record, matched substring, index, pattern and confidence', () => {
    const [m] = matchUserAgent(UA.gptbot);
    expect(m).toBeDefined();
    expect(m!.matched).toBe('GPTBot/1');
    expect(UA.gptbot.slice(m!.index, m!.index + m!.matched.length)).toBe(m!.matched);
    expect(m!.record.provider).toBe('openai');
    expect(m!.record.kind).toBe('crawler');
    expect(m!.confidence).toBe(1);
    expect(typeof m!.pattern).toBe('string');
  });

  it('classifies libraries and declared agents with the contract kind / class', () => {
    expect(matchUserAgent(UA.requests)[0]!.record.kind).toBe('http-library');
    expect(matchUserAgent(UA.claudeUser)[0]!.record.class).toBe('fetch-agent');
    expect(matchUserAgent(UA.googleAgentDesktop)[0]!.record.webBotAuth.signs).toBe(true);
    expect(matchUserAgent(UA.headless)[0]!.record.kind).toBe('headless');
  });

  it('does not match ordinary browsers', () => {
    expect(ids(UA.chrome)).toEqual([]);
    expect(ids(UA.firefox)).toEqual([]);
    expect(ids(UA.safari)).toEqual([]);
    expect(ids('')).toEqual([]);
  });
});

describe('matchUserAgent: specificity ordering (longest matched token first)', () => {
  it('Applebot-Extended outranks Applebot', () => {
    // Applebot-Extended is a robots.txt token only ("does not crawl"); the UA below is synthetic and
    // exists to exercise ordering when both tokens match.
    const ua = 'Mozilla/5.0 (compatible; Applebot-Extended/0.1; +http://www.apple.com/go/applebot)';
    const r = ids(ua);
    expect(r[0]).toBe('applebot-extended');
    expect(r).toContain('applebot');
    expect(r.indexOf('applebot-extended')).toBeLessThan(r.indexOf('applebot'));
    expect(ids(UA.applebotDesktop)).not.toContain('applebot-extended');
  });

  it('OAI-SearchBot and GPTBot never cross-match', () => {
    expect(ids(UA.oaiSearchBot)).not.toContain('gptbot');
    expect(ids(UA.gptbot)).not.toContain('oai-searchbot');
    const both = ids(`${UA.gptbot} OAI-SearchBot/1.4`);
    expect(both.slice(0, 2)).toEqual(['oai-searchbot', 'gptbot']);
  });

  it('Googlebot and Google-Agent never cross-match, and neither hits the bare "Google" record', () => {
    expect(ids(UA.googlebotSmartphone)).not.toContain('google-agent');
    expect(ids(UA.googleAgentDesktop)).not.toContain('googlebot');
    expect(ids(UA.googleAgentMobile)).not.toContain('googlebot');
    for (const ua of [UA.googlebotDesktop, UA.googleAgentDesktop]) expect(ids(ua)).not.toContain('google-bare-ua');
    expect(first('Google')).toBe('google-bare-ua');
  });

  it('results are sorted by matched length, then kind', () => {
    for (const ua of Object.values(UA)) {
      const r = matchUserAgent(ua);
      for (let i = 1; i < r.length; i++) expect(r[i - 1]!.matched.length).toBeGreaterThanOrEqual(r[i]!.matched.length);
    }
  });

  it('longer wanted-bot tokens beat embedded generic tokens', () => {
    expect(ids(UA.prerender).slice(0, 2)).toEqual(['prerender-io', 'headless-chrome']);
    expect(first(UA.feedly)).toBe('feed-readers');
    expect(ids(UA.feedly)).toContain('google-user-triggered-fetchers');
    expect(first(UA.telegram)).toBe('unfurl-telegram');
    expect(first(UA.claudeUserCode)).toBe('claude-user');
    expect(first(UA.googleOtherImage)).toBe('googleother');
  });
});

describe('uaExamples in the data match their own record', () => {
  const withPatterns = agents.filter((a) => a.uaPatterns.length);
  it.each(withPatterns.flatMap((a) => a.uaExamples.map((ex) => [a.id, ex] as const)))('%s: %s', (id, ex) => {
    expect(ids(ex)).toContain(id);
  });
});
