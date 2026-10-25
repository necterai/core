/**
 * Knowledge adapter: the server analyzers read agent records, HTTP-library
 * profiles, IP ranges, hosting ASNs and Web Bot Auth directories through this
 * module. The canonical source is `@necterai/signatures`; while that package is
 * being populated (or when a symbol is missing) we fall back to the compact
 * dataset below, which copies the measured values from
 * docs/research/raw/server-fingerprints.md, providers-tier1.md and
 * providers-tier2.md verbatim.
 *
 * TODO(integrator): once `@necterai/signatures` exports the full contract
 * (agents, matchUserAgent, ipRanges, createCidrMatcher, hostingAsns,
 * httpLibraryProfiles, browserHeaderProfiles, webBotAuthDirectories,
 * hostedAgentProfiles, sharedEgress) the fallbacks here become dead code and can
 * be deleted; keep the `Knowledge` type and `getKnowledge()` as the seam.
 */
import type { ActorClass, ProviderId } from '@necterai/core';
import * as signaturesModule from '@necterai/signatures';

// ───────────────────────── contract types ─────────────────────────

export interface AgentRecord {
  id: string;
  provider: ProviderId;
  product: string;
  class: ActorClass;
  /** Regex sources matched against the User-Agent (case-insensitive). */
  uaPatterns: string[];
  ipRangeUrls?: string[];
  rdnsSuffixes?: string[];
  robotsTokens?: string[];
  webBotAuth?: { signs: boolean; directoryUrl?: string };
  executesJs?: boolean;
  selfIdentifies?: boolean;
  verification?: string[];
  respectsRobots?: string | boolean;
  notes?: string;
  sources?: string[];
  /** Local extension: what kind of record this is (drives the declared.* signal id). */
  kind?: 'agent' | 'crawler' | 'http-library' | 'headless' | 'utility' | 'unverifiable';
  /** 0..1 how specific the UA pattern is; < 0.5 means a real browser can send the same string. */
  uaMatchConfidence?: number;
  /** Local extension: class-profile override for the emitted signal. */
  classes?: Partial<Record<ActorClass, number>>;
}

export interface UaMatch {
  record: AgentRecord;
  matched: string;
}

export interface HttpLibraryProfile {
  id: string;
  name: string;
  /** Regex source matched against the UA (anchored where the library sets a fixed UA). */
  uaPattern?: string;
  /** Exact HTTP/1.1 header-name order on the wire (lower-cased here; casing is in `lowercaseH1`). */
  headerOrder?: string[];
  /** The library emits lower-case header names on HTTP/1.1. */
  lowercaseH1?: boolean;
  accept?: string;
  acceptEncoding?: string[];
  acceptLanguage?: string;
  /** Full JA4 values measured for this client (fresh and resumed variants). */
  ja4?: string[];
  /** JA4 `b` (cipher-hash) sections that identify the TLS library. */
  ja4Cipher?: string[];
  /** The cipher hash is shared with a real browser family (do not use `b` alone). */
  cipherSharedWithBrowser?: 'firefox' | 'chromium' | 'safari';
  /** Akamai HTTP/2 fingerprints. */
  akamai?: string[];
  /** HTTP/2 pseudo-header order (m,a,s,p...). */
  pseudoOrder?: string;
  /** First ALPN value offered: h1 = http/1.1 first, h2, none = no ALPN. */
  alpnFirst?: 'h1' | 'h2' | 'none';
  /** Base64 HTTP2-Settings payload sent with Upgrade: h2c on plaintext. */
  http2Settings?: string[];
  notes?: string;
}

export interface BrowserHeaderProfile {
  family: 'chromium' | 'firefox' | 'safari';
  accept: string;
  acceptEncoding: string;
  /** HTTP/1.1 navigation header order (lower-cased names). */
  navigationOrder: string[];
  pseudoOrder: string;
  akamai: string[];
  ja4Cipher: string[];
  titleCaseH1: boolean;
}

export interface IpRangeSet {
  provider: ProviderId;
  product?: string;
  source: string;
  fetchedAt: string;
  prefixes: string[];
  /** Local extension: what the range means. */
  kind?: 'agent' | 'hosting' | 'cdn' | 'shared-egress';
  /** Local extension: only a sample of the published list is bundled. */
  partial?: boolean;
}

export interface HostingAsn {
  asn: number;
  name: string;
  kind: 'cloud' | 'hosting' | 'cdn' | 'shared-egress';
  provider?: ProviderId;
}

export interface WebBotAuthDirectory {
  /** Origin (https://host) or a glob with `*` labels for per-tenant hosts. */
  origin: string;
  provider: ProviderId;
  product?: string;
  purpose?: string;
  status: 'live' | 'broken' | 'survey';
  classes?: Partial<Record<ActorClass, number>>;
}

export interface SharedEgressList {
  id: string;
  name: string;
  kind: 'relay' | 'vpn' | 'enterprise-proxy' | 'cgnat' | 'cdn-proxy';
  prefixes: string[];
  asns?: number[];
  partial?: boolean;
}

export interface HostedAgentProfile {
  id: string;
  provider: ProviderId;
  product: string;
  features: Record<string, unknown>;
}

export interface Knowledge {
  agents: AgentRecord[];
  matchUserAgent(ua: string): UaMatch[];
  ipRanges: IpRangeSet[];
  hostingAsns: HostingAsn[];
  httpLibraryProfiles: HttpLibraryProfile[];
  browserHeaderProfiles: BrowserHeaderProfile[];
  webBotAuthDirectories: WebBotAuthDirectory[];
  hostedAgentProfiles: HostedAgentProfile[];
  sharedEgress: SharedEgressList[];
}


// ───────────────────────── local fallback: agents ─────────────────────────

const a = (
  id: string,
  provider: ProviderId,
  product: string,
  cls: ActorClass,
  uaPatterns: string[],
  extra: Partial<AgentRecord> = {},
): AgentRecord => ({ id, provider, product, class: cls, uaPatterns, ...extra });

const OPENAI_DOCS = 'https://developers.openai.com/api/docs/bots';
const GOOGLE_IPR = 'https://developers.google.com/static/crawling/ipranges/';

export const LOCAL_AGENTS: AgentRecord[] = [
  // OpenAI (UA shape: `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.4; +https://openai.com/gptbot`)
  a('openai-gptbot', 'openai', 'GPTBot', 'ai-crawler', ['GPTBot\\/'], { ipRangeUrls: ['https://openai.com/gptbot.json'], robotsTokens: ['GPTBot'], executesJs: false, respectsRobots: true, sources: [OPENAI_DOCS] }),
  a('openai-chatgpt-user', 'openai', 'ChatGPT-User', 'fetch-agent', ['ChatGPT-User\\/'], { ipRangeUrls: ['https://openai.com/chatgpt-user.json'], robotsTokens: ['ChatGPT-User'], executesJs: false, respectsRobots: 'may not apply', sources: [OPENAI_DOCS] }),
  a('openai-searchbot', 'openai', 'OAI-SearchBot', 'ai-crawler', ['OAI-SearchBot\\/'], { ipRangeUrls: ['https://openai.com/searchbot.json'], robotsTokens: ['OAI-SearchBot'], executesJs: false, respectsRobots: true, sources: [OPENAI_DOCS] }),
  a('openai-adsbot', 'openai', 'OAI-AdsBot', 'utility-bot', ['OAI-AdsBot\\/'], { ipRangeUrls: ['https://openai.com/adsbot.json'], sources: [OPENAI_DOCS] }),
  a('openai-chatgpt-app', 'openai', 'ChatGPT app (ACP)', 'fetch-agent', ['^ChatGPT\\/\\d'], { notes: 'Agentic Commerce Protocol checkout client UA (ChatGPT/2.0 (...)).' }),
  // Anthropic (tokens inside the parentheses: `(KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)`)
  a('anthropic-claudebot', 'anthropic', 'ClaudeBot', 'ai-crawler', ['ClaudeBot'], { ipRangeUrls: ['https://claude.com/crawling/bots.json'], robotsTokens: ['ClaudeBot'], executesJs: false, respectsRobots: true }),
  a('anthropic-claude-user', 'anthropic', 'Claude-User', 'fetch-agent', ['Claude-User'], { ipRangeUrls: ['https://claude.com/crawling/bots.json'], robotsTokens: ['Claude-User'], executesJs: false, respectsRobots: true }),
  a('anthropic-claude-searchbot', 'anthropic', 'Claude-SearchBot', 'ai-crawler', ['Claude-SearchBot'], { ipRangeUrls: ['https://claude.com/crawling/bots.json'], robotsTokens: ['Claude-SearchBot'], executesJs: false, respectsRobots: true }),
  a('anthropic-legacy', 'anthropic', 'Claude-Web', 'ai-crawler', ['Claude-Web', 'anthropic-ai'], { kind: 'unverifiable', notes: 'Undocumented / deprecated tokens seen only in third-party lists.' }),
  // Google
  a('google-googlebot', 'google', 'Googlebot', 'search-crawler', ['Googlebot\\/', 'Googlebot-Image\\/', 'Googlebot-Video\\/', 'Googlebot-News'], { ipRangeUrls: [GOOGLE_IPR + 'common-crawlers.json'], rdnsSuffixes: ['googlebot.com'], robotsTokens: ['Googlebot'], executesJs: true, respectsRobots: true }),
  a('google-storebot', 'google', 'Storebot-Google', 'search-crawler', ['Storebot-Google\\/'], { ipRangeUrls: [GOOGLE_IPR + 'common-crawlers.json'], rdnsSuffixes: ['googlebot.com'] }),
  a('google-inspectiontool', 'google', 'Google-InspectionTool', 'search-crawler', ['Google-InspectionTool\\/'], { ipRangeUrls: [GOOGLE_IPR + 'common-crawlers.json'], rdnsSuffixes: ['googlebot.com'] }),
  a('google-googleother', 'google', 'GoogleOther', 'ai-crawler', ['GoogleOther'], { ipRangeUrls: [GOOGLE_IPR + 'common-crawlers.json'], rdnsSuffixes: ['googlebot.com'], respectsRobots: true }),
  a('google-cloudvertexbot', 'google', 'Google-CloudVertexBot', 'ai-crawler', ['Google-CloudVertexBot'], { ipRangeUrls: [GOOGLE_IPR + 'common-crawlers.json'], rdnsSuffixes: ['googlebot.com'] }),
  a('google-agent', 'google', 'Google-Agent', 'fetch-agent', ['Google-Agent'], {
    ipRangeUrls: [GOOGLE_IPR + 'user-triggered-agents.json'],
    rdnsSuffixes: ['google.com', 'googleusercontent.com'],
    webBotAuth: { signs: true, directoryUrl: 'https://agent.bot.goog/.well-known/http-message-signatures-directory' },
    executesJs: true,
    respectsRobots: 'generally ignores',
    classes: { 'computer-use-agent': 3 },
    notes: 'Hosted agents (Project Mariner, Gemini agent mode); Chromium-based; Web Bot Auth experimental (identity https://agent.bot.goog).',
  }),
  a('google-special', 'google', 'AdsBot-Google', 'utility-bot', ['AdsBot-Google', 'Mediapartners-Google', 'APIs-Google', 'Google-Safety'], { ipRangeUrls: [GOOGLE_IPR + 'special-crawlers.json'], rdnsSuffixes: ['google.com'] }),
  a('google-fetchers', 'google', 'Google user-triggered fetcher', 'utility-bot', ['FeedFetcher-Google', 'GoogleProducer', 'Google-Site-Verification', 'Google-CWS', 'GoogleMessages', 'Google-Pinpoint'], { ipRangeUrls: [GOOGLE_IPR + 'user-triggered-fetchers.json', GOOGLE_IPR + 'user-triggered-fetchers-google.json'], rdnsSuffixes: ['google.com', 'googleusercontent.com'], respectsRobots: 'generally ignores' }),
  a('google-read-aloud', 'google', 'Google-Read-Aloud', 'fetch-agent', ['Google-Read-Aloud'], { ipRangeUrls: [GOOGLE_IPR + 'user-triggered-fetchers.json', GOOGLE_IPR + 'user-triggered-fetchers-google.json'], rdnsSuffixes: ['google.com', 'googleusercontent.com'] }),
  a('google-gemininotebook', 'google', 'Google-GeminiNotebook', 'fetch-agent', ['Google-GeminiNotebook', 'Google-NotebookLM'], { ipRangeUrls: [GOOGLE_IPR + 'user-triggered-fetchers.json', GOOGLE_IPR + 'user-triggered-fetchers-google.json'], rdnsSuffixes: ['google.com', 'googleusercontent.com'] }),
  a('google-gemini-deep-research', 'google', 'Gemini-Deep-Research', 'fetch-agent', ['Gemini-Deep-Research'], { kind: 'unverifiable', notes: 'Third-party lists only; not in Google docs. Verify by IP against Google feeds.' }),
  a('google-agent-unofficial', 'google', 'GoogleAgent', 'fetch-agent', ['GoogleAgent-Mariner', 'GoogleAgent-URLContext', 'Google-Gemini-CLI'], { kind: 'unverifiable' }),
  a('google-favicon-legacy', 'google', 'Google Favicon', 'utility-bot', ['Google Favicon']),
  // Perplexity
  a('perplexity-bot', 'perplexity', 'PerplexityBot', 'ai-crawler', ['PerplexityBot\\/'], { ipRangeUrls: ['https://www.perplexity.com/perplexitybot.json'], robotsTokens: ['PerplexityBot'], executesJs: false, respectsRobots: true }),
  a('perplexity-user', 'perplexity', 'Perplexity-User', 'fetch-agent', ['Perplexity-User\\/'], { ipRangeUrls: ['https://www.perplexity.com/perplexity-user.json'], robotsTokens: ['Perplexity-User'], executesJs: false, respectsRobots: 'generally ignores' }),
  // Microsoft
  a('microsoft-bingbot', 'microsoft', 'Bingbot', 'search-crawler', ['bingbot\\/', 'adidxbot\\/', 'BingPreview\\/'], { ipRangeUrls: ['https://www.bing.com/toolbox/bingbot.json'], rdnsSuffixes: ['search.msn.com'], robotsTokens: ['bingbot'], respectsRobots: true }),
  a('microsoft-preview', 'microsoft', 'MicrosoftPreview', 'utility-bot', ['MicrosoftPreview\\/']),
  // Amazon (`(KHTML, like Gecko; compatible; Amazonbot/0.1) Chrome/W.X.Y.Z Safari/537.36`)
  a('amazon-amazonbot', 'amazon', 'Amazonbot', 'ai-crawler', ['Amazonbot\\/'], { ipRangeUrls: ['https://developer.amazon.com/amazonbot/ip-addresses/'], robotsTokens: ['Amazonbot'], respectsRobots: true }),
  a('amazon-searchbot', 'amazon', 'Amzn-SearchBot', 'search-crawler', ['Amzn-SearchBot\\/'], { ipRangeUrls: ['https://developer.amazon.com/amazonbot/searchbot-ip-addresses/'] }),
  a('amazon-user', 'amazon', 'Amzn-User', 'fetch-agent', ['Amzn-User\\/'], { ipRangeUrls: ['https://developer.amazon.com/amazonbot/live-ip-addresses/'], respectsRobots: 'may not follow all directives' }),
  a('amazon-novaact', 'amazon', 'Nova Act', 'browser-agent', ['NovaAct'], { executesJs: true, notes: 'Playwright-driven; look for NovaAct in the UA (exact default string unpublished).' }),
  a('amazon-misc', 'amazon', 'Amazon agent', 'fetch-agent', ['bedrockbot', 'amazon-kendra', 'amazon-QBusiness', 'AmazonBuyForMe'], { kind: 'unverifiable' }),
  // Apple
  a('apple-applebot', 'apple', 'Applebot', 'search-crawler', ['Applebot\\/'], { ipRangeUrls: ['https://search.developer.apple.com/applebot.json'], rdnsSuffixes: ['applebot.apple.com'], robotsTokens: ['Applebot'], executesJs: true, respectsRobots: true }),
  a('apple-itms', 'apple', 'iTMS', 'utility-bot', ['^iTMS']),
  // Meta
  a('meta-externalagent', 'meta', 'meta-externalagent', 'ai-crawler', ['meta-externalagent\\/'], { robotsTokens: ['meta-externalagent'], respectsRobots: true, webBotAuth: { signs: false, directoryUrl: 'https://www.meta.com/.well-known/http-message-signatures-directory' } }),
  a('meta-externalfetcher', 'meta', 'meta-externalfetcher', 'fetch-agent', ['meta-externalfetcher\\/'], { respectsRobots: 'may bypass (user-requested)' }),
  a('meta-webindexer', 'meta', 'meta-webindexer', 'ai-crawler', ['meta-webindexer\\/']),
  a('meta-externalads', 'meta', 'meta-externalads', 'utility-bot', ['meta-externalads\\/']),
  a('meta-facebookexternalhit', 'meta', 'facebookexternalhit', 'utility-bot', ['facebookexternalhit\\/', 'Facebot']),
  a('meta-facebookbot', 'meta', 'FacebookBot', 'ai-crawler', ['FacebookBot'], { kind: 'unverifiable', notes: 'No longer on Meta crawler page.' }),
  // ByteDance
  a('bytedance-bytespider', 'bytedance', 'Bytespider', 'ai-crawler', ['Bytespider'], { respectsRobots: false, notes: 'No IP list, no rDNS: a spoofed Bytespider is indistinguishable from a real one.' }),
  a('bytedance-tiktokspider', 'bytedance', 'TikTokSpider', 'utility-bot', ['TikTokSpider']),
  a('bytedance-doubao', 'bytedance', 'DoubaoBot', 'ai-crawler', ['DoubaoBot'], { kind: 'unverifiable' }),
  // Mistral
  a('mistral-user', 'mistral', 'MistralAI-User', 'fetch-agent', ['MistralAI-User\\/'], { ipRangeUrls: ['https://mistral.ai/mistralai-user-ips.json'], rdnsSuffixes: ['crawlers.mistral.ai'] }),
  a('mistral-index', 'mistral', 'MistralAI-Index', 'ai-crawler', ['MistralAI-Index\\/'], { ipRangeUrls: ['https://mistral.ai/mistralai-index-ips.json'], rdnsSuffixes: ['crawlers.mistral.ai'] }),
  a('mistral-training', 'mistral', 'MistralAI-Training', 'ai-crawler', ['MistralAI-Training\\/'], { rdnsSuffixes: ['crawlers.mistral.ai'] }),
  // DeepSeek / Cohere / xAI (all unverifiable)
  a('deepseek-bot', 'deepseek', 'DeepSeekBot', 'ai-crawler', ['DeepSeekBot', 'DeepSeek-User'], { kind: 'unverifiable' }),
  a('cohere-crawler', 'cohere', 'cohere-ai', 'ai-crawler', ['cohere-ai', 'cohere-training-data-crawler', 'Coherebot'], { kind: 'unverifiable', notes: 'Cohere states it runs no crawler; treat as third-party or spoofed.' }),
  a('xai-grok', 'xai', 'GrokBot', 'ai-crawler', ['GrokBot', 'xAI-Grok', 'Grok-DeepSearch', 'xAI-Bot', 'xAI-SearchBot', 'GrokAgent'], { kind: 'unverifiable' }),
  // DuckDuckGo (`DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)`)
  a('duckduckgo-bot', 'duckduckgo', 'DuckDuckBot', 'search-crawler', ['DuckDuckBot'], { ipRangeUrls: ['https://duckduckgo.com/duckduckbot.json'], respectsRobots: true }),
  a('duckduckgo-assistbot', 'duckduckgo', 'DuckAssistBot', 'fetch-agent', ['DuckAssistBot'], { ipRangeUrls: ['https://duckduckgo.com/duckassistbot.json'], webBotAuth: { signs: true, directoryUrl: 'https://assistbot.duckduckgo.com/.well-known/http-message-signatures-directory' }, respectsRobots: true }),
  // You.com
  a('you-youbot', 'you', 'YouBot', 'search-crawler', ['YouBot\\/'], { rdnsSuffixes: ['search.you.com'], webBotAuth: { signs: true, directoryUrl: 'https://you.com/.well-known/http-message-signatures-directory' }, ipRangeUrls: ['https://you.com/docs/youbot'], respectsRobots: true }),
  // Common Crawl (`CCBot/2.0 (https://commoncrawl.org/faq/)`)
  a('commoncrawl-ccbot', 'commoncrawl', 'CCBot', 'ai-crawler', ['CCBot\\/'], { ipRangeUrls: ['https://index.commoncrawl.org/ccbot.json'], rdnsSuffixes: ['crawl.commoncrawl.org'], respectsRobots: true, executesJs: false }),
  // Others
  a('diffbot', 'diffbot', 'Diffbot', 'ai-crawler', ['Diffbot'], { notes: 'Also the fetch back-end for Microsoft Copilot live reads (AS6939, plain Chrome UA).' }),
  a('huawei-petalbot', 'huawei', 'PetalBot', 'search-crawler', ['PetalBot']),
  a('huawei-pangubot', 'huawei', 'PanguBot', 'ai-crawler', ['PanguBot'], { kind: 'unverifiable' }),
  a('alibaba-qwen', 'alibaba', 'QwenBot', 'ai-crawler', ['Qwenbot', 'TongyiBot', 'Qwen-User', 'Quark-Agent', 'Quark-Spider', 'AliyunSecBot'], { kind: 'unverifiable' }),
  a('moonshot-kimibot', 'moonshot', 'KimiBot', 'ai-crawler', ['KimiBot\\/', 'MoonshotBot'], { ipRangeUrls: ['https://www.kimi.com/policies/kimibot.json'] }),
  a('moonshot-kimi-user', 'moonshot', 'Kimi-User', 'fetch-agent', ['Kimi-User\\/', 'Kimi-Agent'], { ipRangeUrls: ['https://www.kimi.com/policies/kimi-user.json'] }),
  a('moonshot-kimi-searchbot', 'moonshot', 'Kimi-SearchBot', 'ai-crawler', ['Kimi-SearchBot\\/'], { ipRangeUrls: ['https://www.kimi.com/policies/kimi-searchbot.json'] }),
  a('zhipu-chatglm', 'zhipu', 'ChatGLM-Spider', 'ai-crawler', ['ChatGLM-Spider'], { kind: 'unverifiable' }),
  a('tencent-hunyuan', 'tencent', 'Hunyuan', 'ai-crawler', ['Hunyuan'], { kind: 'unverifiable' }),
  a('baidu-ernie', 'baidu', 'ERNIEBot', 'ai-crawler', ['ERNIEBot', 'YiyanBot'], { kind: 'unverifiable' }),
  a('baidu-spider', 'baidu', 'Baiduspider', 'search-crawler', ['Baiduspider'], { rdnsSuffixes: ['baidu.com', 'baidu.jp'] }),
  a('yandex-bot', 'yandex', 'YandexBot', 'search-crawler', ['YandexBot\\/', 'YandexImages', 'YandexMobileBot'], { rdnsSuffixes: ['yandex.ru', 'yandex.net', 'yandex.com'] }),
  a('01ai-yibot', '01ai', 'YiBot', 'ai-crawler', ['YiBot'], { kind: 'unverifiable' }),
  a('manus-user', 'manus', 'Manus-User', 'fetch-agent', ['Manus-User\\/'], { classes: { 'computer-use-agent': 2, 'fetch-agent': 1 }, webBotAuth: { signs: true, directoryUrl: 'https://api.manus.im/.well-known/http-message-signatures-directory' }, notes: 'Cloud agent appends `; Manus-User/1.0` to a Linux Chrome UA.' }),
  a('genspark', 'genspark', 'Genspark', 'browser-agent', ['Genspark\\/'], { executesJs: true, notes: 'Token appended to a Chrome-style UA; Playwright-driven; injects #genspark-float-bar.' }),
  a('ai2-bot', 'ai2', 'AI2Bot', 'ai-crawler', ['AI2Bot', 'Ai2Bot-Dolma'], { respectsRobots: true }),
  a('hive-imagesift', 'hive', 'ImagesiftBot', 'ai-crawler', ['ImagesiftBot'], { respectsRobots: true }),
  a('webz-omgili', 'webz', 'omgili', 'ai-crawler', ['omgili', 'Webzio']),
  a('timpi-bot', 'timpi', 'Timpibot', 'ai-crawler', ['Timpibot']),
  a('kangaroo-bot', 'kangaroo', 'Kangaroo Bot', 'ai-crawler', ['Kangaroo Bot']),
  a('mozilla-tabstack', 'mozilla', 'Mozilla-Tabstack', 'fetch-agent', ['Mozilla-Tabstack\\/'], { respectsRobots: true }),
  a('firecrawl', 'firecrawl', 'Firecrawl', 'fetch-agent', ['FirecrawlAgent', 'Firecrawl']),
  a('jina-reader', 'jina', 'Jina Reader', 'fetch-agent', ['r\\.jina\\.ai', 'ReaderBot', 'Jina']),
  a('crawl4ai', 'crawl4ai', 'Crawl4AI', 'fetch-agent', ['Crawl4AI']),
  a('mcp-fetch', 'modelcontextprotocol', 'mcp-server-fetch', 'fetch-agent', ['ModelContextProtocol\\/'], { notes: 'UA `ModelContextProtocol/1.0 (Autonomous; +https://github.com/modelcontextprotocol/servers)`; rest of the header set is httpx.' }),
  a('agent-tokens', 'unknown', 'agent token', 'fetch-agent', ['TavilyBot', 'LinkupBot', 'ExaUser', 'Shap-User', 'Diffbot-User', 'Devin', 'Claude-Code', 'cursor-server', 'Codex', 'Operator', 'Lightpanda'], { kind: 'unverifiable' }),
  // Utility: unfurlers and previewers
  a('unfurl-slack', 'slack', 'Slackbot', 'utility-bot', ['Slackbot', 'Slack-ImgProxy']),
  a('unfurl-twitter', 'twitter', 'Twitterbot', 'utility-bot', ['Twitterbot']),
  a('unfurl-linkedin', 'linkedin', 'LinkedInBot', 'utility-bot', ['LinkedInBot']),
  a('unfurl-discord', 'discord', 'Discordbot', 'utility-bot', ['Discordbot']),
  a('unfurl-telegram', 'telegram', 'TelegramBot', 'utility-bot', ['TelegramBot']),
  a('unfurl-misc', 'unknown', 'link previewer', 'utility-bot', ['WhatsApp\\/', 'Pinterestbot', 'redditbot', 'Embedly', 'Iframely', 'SkypeUriPreview', 'Snap URL Preview', 'Bluesky', 'Mastodon\\/', 'YahooMailProxy', 'GoogleImageProxy']),
  // Utility: monitors / performance / SEO / prerender / security scanners / feed readers
  a('monitor-checkly', 'checkly', 'Checkly', 'utility-bot', ['Checkly']),
  a('monitor-datadog', 'datadog', 'Datadog Synthetics', 'utility-bot', ['DatadogSynthetics', 'Datadog\\/Synthetics']),
  a('monitor-misc', 'unknown', 'uptime monitor', 'utility-bot', ['Pingdom', 'UptimeRobot', 'StatusCake', 'Site24x7', 'Better Uptime', 'BetterUptimeBot', 'Uptime-Kuma', 'HetrixTools', 'FreshpingBot', 'cron-job\\.org', 'EasyCron', 'GTmetrix', 'Chrome-Lighthouse', 'PageSpeed']),
  a('seo-screamingfrog', 'unknown', 'Screaming Frog SEO Spider', 'utility-bot', ['Screaming Frog SEO Spider']),
  a('prerender', 'unknown', 'Prerender', 'utility-bot', ['Prerender \\(\\+https:\\/\\/github\\.com\\/prerender']),
  a('security-scanners', 'unknown', 'security scanner', 'scripted-automation', ['Nessus', 'Qualys', 'CensysInspect', 'zgrab', 'Expanse']),
  a('feed-readers', 'unknown', 'feed reader', 'utility-bot', ['Feedly', 'inoreader', 'NewsBlur']),
  a('chrome-prefetch-proxy', 'google', 'Chrome Privacy Preserving Prefetch Proxy', 'utility-bot', ['Chrome Privacy Preserving Prefetch Proxy'], { notes: 'Prefetch consumed by a real person; never attribute as a bot session.' }),
  // Headless markers
  a('headless-chrome', 'unknown', 'HeadlessChrome', 'browser-agent', ['HeadlessChrome', 'HeadlessFirefox', 'PhantomJS', 'Electron\\/.*Headless'], { kind: 'headless' }),
  // HTTP libraries (defaults confirmed from library sources; see server-fingerprints.md section 3.4)
  a('lib-python-requests', 'unknown', 'python-requests', 'fetch-agent', ['^python-requests\\/'], { kind: 'http-library' }),
  a('lib-python-httpx', 'unknown', 'python-httpx', 'fetch-agent', ['^python-httpx\\/'], { kind: 'http-library' }),
  a('lib-python-urllib', 'unknown', 'Python-urllib', 'fetch-agent', ['^Python-urllib\\/', '^python-urllib3\\/'], { kind: 'http-library' }),
  a('lib-aiohttp', 'unknown', 'aiohttp', 'fetch-agent', ['aiohttp\\/', '^Python\\/\\d'], { kind: 'http-library' }),
  a('lib-scrapy', 'unknown', 'Scrapy', 'fetch-agent', ['^Scrapy\\/'], { kind: 'http-library' }),
  a('lib-node', 'unknown', 'node (undici fetch)', 'fetch-agent', ['^node$', '^undici$', '^node-fetch$', '^node-fetch\\/'], { kind: 'http-library' }),
  a('lib-axios', 'unknown', 'axios', 'fetch-agent', ['^axios\\/'], { kind: 'http-library' }),
  a('lib-got', 'unknown', 'got', 'fetch-agent', ['^got \\(https:\\/\\/github\\.com\\/sindresorhus\\/got\\)'], { kind: 'http-library' }),
  a('lib-bun', 'unknown', 'Bun', 'fetch-agent', ['^Bun\\/'], { kind: 'http-library' }),
  a('lib-deno', 'unknown', 'Deno', 'fetch-agent', ['^Deno\\/'], { kind: 'http-library' }),
  a('lib-go', 'unknown', 'Go-http-client', 'fetch-agent', ['^Go-http-client\\/'], { kind: 'http-library' }),
  a('lib-java', 'unknown', 'Java HttpClient', 'fetch-agent', ['^Java-http-client\\/', '^Java\\/', '^Apache-HttpClient\\/'], { kind: 'http-library' }),
  a('lib-okhttp', 'unknown', 'okhttp', 'fetch-agent', ['^okhttp\\/'], { kind: 'http-library' }),
  a('lib-curl', 'unknown', 'curl', 'fetch-agent', ['^curl\\/'], { kind: 'http-library' }),
  a('lib-wget', 'unknown', 'Wget', 'fetch-agent', ['^Wget\\/'], { kind: 'http-library' }),
  a('lib-misc', 'unknown', 'HTTP client', 'fetch-agent', ['^HTTPie\\/', '^libwww-perl', '^PostmanRuntime\\/', '^reqwest\\/', '^http\\.rb\\/', '^Ruby$', '^Guzzle', '^PHP\\/', '^Dart\\/', '^Faraday', '^Typhoeus', '^RestSharp', '^Apache-HttpAsyncClient', '^Jakarta Commons-HttpClient', '^WinHttp', '^Microsoft URL Control'], { kind: 'http-library' }),
];

const regexCache = new Map<string, RegExp>();
function re(source: string): RegExp {
  let r = regexCache.get(source);
  if (!r) {
    try {
      r = new RegExp(source, 'i');
    } catch {
      r = new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
    regexCache.set(source, r);
  }
  return r;
}

export function localMatchUserAgent(ua: string, agents: AgentRecord[] = LOCAL_AGENTS): UaMatch[] {
  const out: UaMatch[] = [];
  if (!ua) return out;
  for (const record of agents) {
    for (const p of record.uaPatterns) {
      const m = re(p).exec(ua);
      if (m) {
        out.push({ record, matched: m[0] });
        break;
      }
    }
  }
  return out;
}

// ───────────────────────── local fallback: HTTP library profiles (measured 2026-10-24) ─────────────────────────

export const LOCAL_HTTP_LIBRARY_PROFILES: HttpLibraryProfile[] = [
  {
    id: 'python-requests', name: 'python-requests / urllib3', uaPattern: '^python-requests\\/',
    headerOrder: ['host', 'user-agent', 'accept-encoding', 'accept', 'connection'], accept: '*/*',
    acceptEncoding: ['gzip, deflate', 'gzip, deflate, br', 'gzip, deflate, br, zstd'],
    ja4: ['t13d1713h1_ab0a1bf427ad_8537cf56674e', 't13d1712h1_ab0a1bf427ad_882d495ac381'], ja4Cipher: ['ab0a1bf427ad'], alpnFirst: 'h1',
    notes: 'No session_ticket (urllib3 disables tickets); post_handshake_auth present.',
  },
  {
    id: 'python-httpx', name: 'httpx', uaPattern: '^python-httpx\\/',
    headerOrder: ['host', 'accept', 'accept-encoding', 'connection', 'user-agent'], accept: '*/*',
    acceptEncoding: ['gzip, deflate', 'gzip, deflate, br', 'gzip, deflate, br, zstd'],
    ja4: ['t13d1712h1_ab0a1bf427ad_8e6e362c5eac'], ja4Cipher: ['ab0a1bf427ad'], akamai: ['1:4096;2:0;4:65535;5:16384;3:100;6:65536|16777216|0|m,a,s,p'], pseudoOrder: 'm,a,s,p', alpnFirst: 'h1',
    notes: 'With http2=True ALPN is [http/1.1, h2]: JA4 ends h1 while the connection is h2.',
  },
  {
    id: 'aiohttp', name: 'aiohttp', uaPattern: 'aiohttp\\/',
    headerOrder: ['host', 'accept', 'accept-encoding', 'user-agent'], accept: '*/*',
    acceptEncoding: ['gzip, deflate', 'gzip, deflate, br', 'gzip, deflate, br, zstd'],
    ja4: ['t13d1712h1_ab0a1bf427ad_8e6e362c5eac'], ja4Cipher: ['ab0a1bf427ad'], alpnFirst: 'h1',
  },
  {
    id: 'python-urllib', name: 'Python urllib', uaPattern: '^Python-urllib\\/',
    headerOrder: ['accept-encoding', 'host', 'user-agent', 'connection'], acceptEncoding: ['identity'],
    ja4: ['t13d1713h1_ab0a1bf427ad_89ab6efea773', 't13d1714h1_ab0a1bf427ad_5ae85263eb3b'], ja4Cipher: ['ab0a1bf427ad'], alpnFirst: 'h1',
  },
  {
    id: 'python-urllib3', name: 'urllib3 (direct)', uaPattern: '^python-urllib3\\/',
    headerOrder: ['host', 'accept-encoding', 'user-agent'], acceptEncoding: ['identity'], ja4Cipher: ['ab0a1bf427ad'], alpnFirst: 'h1',
  },
  {
    id: 'scrapy', name: 'Scrapy', uaPattern: '^Scrapy\\/',
    headerOrder: ['accept', 'accept-language', 'user-agent', 'accept-encoding', 'host'],
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', acceptLanguage: 'en', acceptEncoding: ['gzip, deflate, br, zstd'],
    ja4: ['t13d3010_1d37bd780c83_3550537cd59b'], ja4Cipher: ['1d37bd780c83'], alpnFirst: 'none',
    notes: '30 ciphers, no ALPN, SNI last.',
  },
  {
    id: 'node-fetch-undici', name: 'Node fetch (undici)', uaPattern: '^(node|undici)$',
    headerOrder: ['host', 'connection', 'accept', 'accept-language', 'sec-fetch-mode', 'user-agent', 'accept-encoding'], lowercaseH1: true,
    accept: '*/*', acceptLanguage: '*', acceptEncoding: ['gzip, deflate', 'br, gzip, deflate', 'br, gzip, deflate, zstd'],
    ja4: ['t13d5212h1_b262b3658495_8e6e362c5eac', 't13d5213h1_b262b3658495_66863fb0a24c'], ja4Cipher: ['b262b3658495'], akamai: ['2:0;4:262144|458753|0|a,m,p,s'], pseudoOrder: 'a,m,p,s', alpnFirst: 'h1',
    notes: '52 cipher suites (Node bundled OpenSSL); sec-fetch-mode: cors without site/dest; accept-language: *.',
  },
  {
    id: 'node-https', name: 'node:https', headerOrder: ['host', 'connection'], ja4: ['t13d5211_b262b3658495_8e6e362c5eac'], ja4Cipher: ['b262b3658495'], alpnFirst: 'none',
  },
  {
    id: 'node-fetch', name: 'node-fetch 3', uaPattern: '^node-fetch',
    headerOrder: ['accept', 'accept-encoding', 'user-agent', 'host', 'connection'], lowercaseH1: true, accept: '*/*', acceptEncoding: ['gzip, deflate, br'],
    ja4: ['t13d5212_b262b3658495_66863fb0a24c'], ja4Cipher: ['b262b3658495'], alpnFirst: 'none',
  },
  {
    id: 'axios', name: 'axios', uaPattern: '^axios\\/',
    headerOrder: ['accept', 'user-agent', 'accept-encoding', 'host', 'connection'], accept: 'application/json, text/plain, */*', acceptEncoding: ['gzip, compress, deflate, br', 'gzip, compress, deflate'],
    ja4: ['t13d5212_b262b3658495_66863fb0a24c'], ja4Cipher: ['b262b3658495'], alpnFirst: 'none',
  },
  {
    id: 'got', name: 'got', uaPattern: '^got \\(',
    headerOrder: ['user-agent', 'accept-encoding', 'host', 'connection'], lowercaseH1: true, acceptEncoding: ['gzip, deflate, br, zstd'],
    ja4: ['t13d5212_b262b3658495_66863fb0a24c', 't13d5212h2_b262b3658495_8e6e362c5eac'], ja4Cipher: ['b262b3658495'], akamai: ['2:0;4:33554432|4128769|0|m,p,a,s'], pseudoOrder: 'm,p,a,s',
  },
  {
    id: 'bun', name: 'Bun fetch', uaPattern: '^Bun\\/',
    headerOrder: ['connection', 'user-agent', 'accept', 'host', 'accept-encoding'], accept: '*/*', acceptEncoding: ['gzip, deflate, br, zstd'],
    ja4: ['t13d1713h1_5b57614c22b0_7f527383e249'], ja4Cipher: ['5b57614c22b0'], cipherSharedWithBrowser: 'firefox', alpnFirst: 'h1',
    notes: 'BoringSSL hello shares the Firefox cipher list hash; no GREASE; HTTP/1.1 only.',
  },
  {
    id: 'deno', name: 'Deno fetch', uaPattern: '^Deno\\/',
    headerOrder: ['accept', 'accept-language', 'user-agent', 'accept-encoding', 'host'], lowercaseH1: true, accept: '*/*', acceptLanguage: '*', acceptEncoding: ['gzip,br'],
    ja4: ['t13d1011h2_61a7ad8aa9b6_f9531d972513'], ja4Cipher: ['61a7ad8aa9b6'], akamai: ['2:0;4:2097152;5:16384;6:262144|5177345|0|m,s,a,p'], pseudoOrder: 'm,s,a,p', alpnFirst: 'h2',
  },
  {
    id: 'go-net-http', name: 'Go net/http', uaPattern: '^Go-http-client\\/',
    headerOrder: ['host', 'user-agent', 'accept-encoding'], acceptEncoding: ['gzip'],
    ja4: ['t13d1312h2_f57a46bbacb6_ab7e3b40a677', 't13d1311_f57a46bbacb6_ab7e3b40a677'], ja4Cipher: ['f57a46bbacb6'], akamai: ['2:0;4:4194304;5:16384;6:10485760|1073741824|0|a,m,p,s'], pseudoOrder: 'a,m,p,s', alpnFirst: 'h2',
  },
  {
    id: 'rust-reqwest', name: 'Rust reqwest (rustls)',
    headerOrder: ['accept', 'accept-encoding', 'host'], lowercaseH1: true, accept: '*/*', acceptEncoding: ['zstd,gzip,deflate,br'],
    ja4: ['t13d1011h2_61a7ad8aa9b6_3fcd1a44f3e3'], ja4Cipher: ['61a7ad8aa9b6'], akamai: ['2:0;4:2097152;5:16384;6:16384|5177345|0|m,s,a,p'], pseudoOrder: 'm,s,a,p', alpnFirst: 'h2',
    notes: 'No User-Agent by default.',
  },
  {
    id: 'curl', name: 'curl', uaPattern: '^curl\\/',
    headerOrder: ['host', 'user-agent', 'accept'], accept: '*/*', acceptEncoding: ['deflate, gzip, br, zstd'],
    ja4: ['t13d3112h2_e8f1e7e78f70_b26ce05bbdd6', 't13d3112h1_e8f1e7e78f70_b26ce05bbdd6', 't13d497h2_0d8feac7bc37_7395dae3b2f3', 't13d497h1_0d8feac7bc37_7395dae3b2f3'],
    ja4Cipher: ['e8f1e7e78f70', '0d8feac7bc37'], akamai: ['3:100;4:33554432;2:0|33488897|0|m,p,s,a', '3:100;4:10485760;2:0|1048510465|0|m,s,a,p'], alpnFirst: 'h2',
  },
  {
    id: 'wget', name: 'GNU Wget', uaPattern: '^Wget\\/',
    headerOrder: ['host', 'user-agent', 'accept', 'accept-encoding', 'connection'], accept: '*/*', acceptEncoding: ['identity'],
    ja4: ['t13d2913_723694b0fccc_899037bd0b8c'], ja4Cipher: ['723694b0fccc'], alpnFirst: 'none',
  },
  {
    id: 'java-httpclient', name: 'Java HttpClient', uaPattern: '^Java-http-client\\/',
    headerOrder: ['connection', 'host', 'http2-settings', 'upgrade', 'user-agent'],
    ja4: ['t13d3113h2_1d947a95fc68_7e1102d2036b', 't13d3113_1d947a95fc68_d6a918353cf0'], ja4Cipher: ['1d947a95fc68'], akamai: ['1:16384;2:0;3:0;4:16777216;5:16384;6:393216|33488897|0|a,m,p,s'], pseudoOrder: 'a,m,p,s', alpnFirst: 'h2',
    http2Settings: ['AAEAAEAAAAIAAAAAAAMAAAAAAAQBAAAAAAUAAEAAAAYABgAA'],
    notes: 'Sends Upgrade: h2c + HTTP2-Settings on plaintext; MAX_CONCURRENT_STREAMS = 0 is unique.',
  },
  {
    id: 'java-httpurlconnection', name: 'Java HttpURLConnection', uaPattern: '^Java\\/',
    headerOrder: ['user-agent', 'host', 'accept', 'connection'], accept: '*/*', ja4: ['t13d3113_1d947a95fc68_d6a918353cf0'], ja4Cipher: ['1d947a95fc68'], alpnFirst: 'none',
  },
  {
    id: 'okhttp', name: 'OkHttp', uaPattern: '^okhttp\\/',
    headerOrder: ['host', 'connection', 'accept-encoding', 'user-agent'], acceptEncoding: ['gzip'],
    ja4: ['t13d1114h2_5e2a75874763_89e9e4bb3419'], ja4Cipher: ['5e2a75874763'], akamai: ['4:16777216|16711681|0|m,p,a,s'], pseudoOrder: 'm,p,a,s', alpnFirst: 'h2',
  },
  {
    id: 'curl-cffi-default', name: 'curl_cffi (no impersonation)',
    headerOrder: ['host', 'accept-encoding'], acceptEncoding: ['gzip, deflate, br'],
    ja4: ['t13d2712h2_b4f9224df7c1_cbb9361b6bf9'], ja4Cipher: ['b4f9224df7c1'], akamai: ['1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p'], pseudoOrder: 'm,a,s,p', alpnFirst: 'h2',
    notes: "Chrome's HTTP/2 SETTINGS with no User-Agent and no Accept.",
  },
  {
    id: 'curl-cffi-chrome', name: 'curl_cffi impersonate=chrome', ja4: ['t13d1516h2_8daaf6152771_806a8c22fdea'], ja4Cipher: ['8daaf6152771'], cipherSharedWithBrowser: 'chromium',
    http2Settings: ['AAEAAQAAAAIAAAAAAAQAYAAAAAYABAAA'], akamai: ['1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p'], pseudoOrder: 'm,a,s,p',
    notes: 'Looks like Chrome at TLS+h2; leaks Upgrade: h2c on plaintext and fixed en-US/macOS headers.',
  },
  {
    id: 'curl-cffi-safari', name: 'curl_cffi impersonate=safari', ja4: ['t13d2013h2_a09f3c656075_7f0f34a4126d'], ja4Cipher: ['a09f3c656075'], cipherSharedWithBrowser: 'safari',
    http2Settings: ['AAIAAAAAAAMAAABkAAQAIAAAAAkAAAAB'], akamai: ['2:0;3:100;4:2097152;9:1|10420225|0|m,s,a,p'], pseudoOrder: 'm,s,a,p',
  },
  {
    id: 'curl-cffi-firefox', name: 'curl_cffi impersonate=firefox', ja4: ['t13d1717h2_5b57614c22b0_3cbfd9057e0d'], ja4Cipher: ['5b57614c22b0'], cipherSharedWithBrowser: 'firefox',
    http2Settings: ['AAEAAQAAAAIAAAAAAAQAAgAAAAUAAEAA'], akamai: ['1:65536;2:0;4:131072;5:16384|12517377|0|m,p,a,s'], pseudoOrder: 'm,p,a,s',
    notes: 'Sends no PRIORITY frames (real Firefox historically sends five).',
  },
];

export const LOCAL_BROWSER_HEADER_PROFILES: BrowserHeaderProfile[] = [
  {
    family: 'chromium',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    acceptEncoding: 'gzip, deflate, br, zstd',
    navigationOrder: ['host', 'connection', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'upgrade-insecure-requests', 'user-agent', 'accept', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-user', 'sec-fetch-dest', 'accept-encoding', 'accept-language'],
    pseudoOrder: 'm,a,s,p',
    akamai: ['1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p'],
    ja4Cipher: ['8daaf6152771'],
    titleCaseH1: false,
  },
  {
    family: 'firefox',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/png,image/svg+xml,*/*;q=0.8',
    acceptEncoding: 'gzip, deflate, br, zstd',
    navigationOrder: ['host', 'user-agent', 'accept', 'accept-language', 'accept-encoding', 'connection', 'upgrade-insecure-requests', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-user', 'priority', 'te'],
    pseudoOrder: 'm,p,a,s',
    akamai: ['1:65536;2:0;4:131072;5:16384|12517377|0|m,p,a,s', '1:65536;4:131072;5:16384|12517377|3:0:0:201,5:0:0:101,7:0:0:1,9:0:7:1,11:0:3:1|m,p,a,s'],
    ja4Cipher: ['5b57614c22b0'],
    titleCaseH1: true,
  },
  {
    family: 'safari',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    acceptEncoding: 'gzip, deflate, br',
    navigationOrder: ['host', 'sec-fetch-dest', 'user-agent', 'accept', 'sec-fetch-site', 'sec-fetch-mode', 'accept-language', 'accept-encoding', 'connection'],
    pseudoOrder: 'm,s,a,p',
    akamai: ['2:0;3:100;4:2097152;9:1|10420225|0|m,s,a,p'],
    ja4Cipher: ['a09f3c656075'],
    titleCaseH1: false,
  },
];

// ───────────────────────── local fallback: IP ranges (verbatim samples / full lists where published) ─────────────────────────

export const LOCAL_IP_RANGES: IpRangeSet[] = [
  {
    provider: 'openai', product: 'GPTBot', source: 'https://openai.com/gptbot.json', fetchedAt: '2026-10-24', kind: 'agent',
    prefixes: ['132.196.86.0/24', '172.182.202.0/25', '172.182.207.0/25', '20.125.66.80/28', '20.171.206.0/24', '20.171.207.0/24', '4.227.36.0/25', '52.230.152.0/24', '74.7.175.128/25', '74.7.227.0/25', '74.7.227.128/25', '74.7.228.0/25', '74.7.230.0/25', '74.7.241.0/25', '74.7.241.128/25', '74.7.242.0/25', '74.7.243.128/25', '74.7.244.0/25'],
  },
  { provider: 'openai', product: 'OAI-SearchBot', source: 'https://openai.com/searchbot.json', fetchedAt: '2026-10-24', kind: 'agent', partial: true, prefixes: ['104.210.140.128/28', '13.66.216.176/28', '135.234.64.0/24'] },
  { provider: 'openai', product: 'ChatGPT-User', source: 'https://openai.com/chatgpt-user.json', fetchedAt: '2026-10-24', kind: 'agent', partial: true, prefixes: ['9.129.0.0/16'] },
  { provider: 'openai', product: 'OAI-AdsBot', source: 'https://openai.com/adsbot.json', fetchedAt: '2026-10-24', kind: 'agent', prefixes: ['130.131.229.128/25', '20.168.90.128/25'] },
  {
    provider: 'anthropic', source: 'https://claude.com/crawling/bots.json', fetchedAt: '2026-10-24', kind: 'agent',
    prefixes: ['216.73.216.0/22', '34.162.230.222/32', '34.162.244.71/32', '34.162.191.81/32', '34.162.86.102/32', '136.79.143.251/32', '136.83.20.215/32', '34.162.111.78/32', '34.162.90.102/32', '34.162.27.34/32', '34.152.124.140/32', '34.153.21.190/32', '34.186.252.4/32', '34.162.153.71/32'],
  },
  { provider: 'anthropic', product: 'Claude-User', source: 'https://platform.claude.com/docs/en/api/ip-addresses', fetchedAt: '2026-10-24', kind: 'agent', prefixes: ['160.79.104.0/21'] },
  {
    provider: 'google', product: 'Google-Agent', source: GOOGLE_IPR + 'user-triggered-agents.json', fetchedAt: '2026-10-24', kind: 'agent',
    prefixes: ['2001:4860:c::/124', '2001:4860:c::10/124', '2001:4860:c::20/124', '2001:4860:c::30/124', '2001:4860:c::40/124', '2001:4860:c::50/124', '2001:4860:c::60/124', '2001:4860:c::70/124', '136.121.16.0/24', '136.121.24.0/21', '136.121.40.0/21', '136.122.0.0/16', '74.125.232.0/28', '74.125.232.16/28', '74.125.232.32/28', '74.125.232.48/28', '74.125.232.64/28', '74.125.232.80/28', '74.125.232.96/28', '74.125.232.112/28'],
  },
  { provider: 'perplexity', product: 'PerplexityBot', source: 'https://www.perplexity.com/perplexitybot.json', fetchedAt: '2026-10-24', kind: 'agent', prefixes: ['107.20.236.150/32', '3.224.62.45/32', '18.210.92.235/32', '3.222.232.239/32', '3.211.124.183/32', '3.231.139.107/32', '18.97.1.228/30', '18.97.9.96/29'] },
  { provider: 'perplexity', product: 'Perplexity-User', source: 'https://www.perplexity.com/perplexity-user.json', fetchedAt: '2026-10-24', kind: 'agent', prefixes: ['44.208.221.197/32', '34.193.163.52/32', '18.97.21.0/30', '18.97.43.80/29'] },
  { provider: 'microsoft', product: 'Bingbot', source: 'https://www.bing.com/toolbox/bingbot.json', fetchedAt: '2026-10-24', kind: 'agent', partial: true, prefixes: ['157.55.39.0/24', '207.46.13.0/24', '40.77.167.0/24', '13.66.139.0/24', '13.66.144.0/24', '52.167.144.0/24', '13.67.10.16/28', '13.69.66.240/28', '13.71.172.224/28', '139.217.52.0/28'] },
  { provider: 'apple', product: 'Applebot', source: 'https://search.developer.apple.com/applebot.json', fetchedAt: '2026-10-24', kind: 'agent', partial: true, prefixes: ['17.241.208.160/27', '17.241.193.160/27', '17.241.200.160/27', '17.166.192.48/28', '17.166.240.48/28', '17.166.248.48/28', '17.166.20.0/24', '17.166.21.0/24', '17.166.22.0/24', '17.166.23.0/24'] },
  { provider: 'commoncrawl', product: 'CCBot', source: 'https://index.commoncrawl.org/ccbot.json', fetchedAt: '2026-10-24', kind: 'agent', prefixes: ['3.41.188.32/29', '18.97.9.168/29', '18.97.14.80/29', '18.97.14.88/30', '2600:1f28:365:8000::/56'] },
  { provider: 'mistral', product: 'MistralAI-User', source: 'https://mistral.ai/mistralai-user-ips.json', fetchedAt: '2026-10-24', kind: 'agent', prefixes: ['135.225.57.92/32', '20.240.192.194/32'] },
  { provider: 'mistral', product: 'MistralAI-Index', source: 'https://mistral.ai/mistralai-index-ips.json', fetchedAt: '2026-10-24', kind: 'agent', prefixes: ['20.240.160.161/32', '20.240.160.1/32', '20.240.194.83/32', '51.12.243.114/32'] },
  { provider: 'moonshot', source: 'https://www.kimi.com/policies/kimibot.json', fetchedAt: '2026-10-24', kind: 'agent', prefixes: ['47.79.253.42/32', '47.79.253.91/32', '47.79.225.241/32', '47.79.230.254/32'] },
  { provider: 'you', product: 'YouBot', source: 'https://you.com/docs/youbot', fetchedAt: '2026-10-24', kind: 'agent', prefixes: ['68.67.112.0/24'] },
  { provider: 'duckduckgo', source: 'https://duckduckgo.com/duckassistbot.json', fetchedAt: '2026-10-24', kind: 'agent', partial: true, prefixes: ['104.43.54.127/32', '104.43.55.116/32', '128.203.236.110/32', '20.191.45.212/32'] },
  // CDN / proxy ingress ranges: traffic *from* them is Workers / Browser Rendering / WARP egress, never a residential user directly.
  { provider: 'cloudflare', source: 'https://www.cloudflare.com/ips-v4 + ips-v6', fetchedAt: '2026-10-24', kind: 'cdn', partial: true, prefixes: ['173.245.48.0/20', '103.21.244.0/22', '131.0.72.0/22', '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'] },
  // TODO(integrator): hosting ranges (GCP cloud.json 1,135 prefixes, AWS EC2, Azure, OCI, DigitalOcean, Linode, Vultr geofeeds,
  // ipverse AS24940/AS16276/AS45102/AS132203 prefix sets) come from @necterai/signatures `ipRanges` with kind 'hosting'.
];

export const LOCAL_HOSTING_ASNS: HostingAsn[] = [
  { asn: 16509, name: 'Amazon AWS', kind: 'cloud', provider: 'aws' },
  { asn: 14618, name: 'Amazon AWS (us-east-1)', kind: 'cloud', provider: 'aws' },
  { asn: 396982, name: 'Google Cloud', kind: 'cloud', provider: 'gcp' },
  { asn: 15169, name: 'Google LLC', kind: 'cloud', provider: 'google' },
  { asn: 8075, name: 'Microsoft Azure', kind: 'cloud', provider: 'azure' },
  { asn: 31898, name: 'Oracle Cloud', kind: 'cloud', provider: 'oci' },
  { asn: 14061, name: 'DigitalOcean', kind: 'hosting', provider: 'digitalocean' },
  { asn: 63949, name: 'Linode / Akamai Connected Cloud', kind: 'hosting', provider: 'linode' },
  { asn: 20473, name: 'Vultr', kind: 'hosting', provider: 'vultr' },
  { asn: 24940, name: 'Hetzner Online', kind: 'hosting', provider: 'hetzner' },
  { asn: 213230, name: 'Hetzner Cloud', kind: 'hosting', provider: 'hetzner' },
  { asn: 16276, name: 'OVH', kind: 'hosting', provider: 'ovh' },
  { asn: 45102, name: 'Alibaba Cloud (US)', kind: 'cloud', provider: 'alibaba-cloud' },
  { asn: 37963, name: 'Alibaba Cloud (Hangzhou)', kind: 'cloud', provider: 'alibaba-cloud' },
  { asn: 132203, name: 'Tencent Cloud', kind: 'cloud', provider: 'tencent-cloud' },
  { asn: 6939, name: 'Hurricane Electric (Diffbot infrastructure)', kind: 'hosting', provider: 'diffbot' },
  { asn: 13335, name: 'Cloudflare (proxy, Workers, WARP egress)', kind: 'shared-egress', provider: 'cloudflare' },
  { asn: 54113, name: 'Fastly', kind: 'cdn', provider: 'fastly' },
  { asn: 36183, name: 'Akamai (iCloud Private Relay egress)', kind: 'shared-egress', provider: 'akamai' },
];

/** Provider ids whose IP ranges mean "a server in a datacenter", not a declared agent. */
export const HOSTING_PROVIDER_IDS: ReadonlySet<string> = new Set([
  'aws', 'amazon-aws', 'ec2', 'gcp', 'google-cloud', 'azure', 'microsoft-azure', 'oci', 'oracle-cloud', 'digitalocean', 'linode', 'akamai-cloud', 'vultr', 'hetzner', 'ovh', 'alibaba-cloud', 'tencent-cloud', 'hosting',
]);

export const CDN_PROVIDER_IDS: ReadonlySet<string> = new Set(['cloudflare', 'fastly', 'akamai']);

export const LOCAL_SHARED_EGRESS: SharedEgressList[] = [
  {
    id: 'icloud-private-relay', name: 'iCloud Private Relay', kind: 'relay', asns: [36183], partial: true,
    prefixes: ['172.224.226.0/27', '172.224.226.32/31', '172.225.28.0/24', '2a02:26f7:b784:4dc7::/64'],
  },
  {
    id: 'cloudflare-warp', name: 'Cloudflare WARP / Zero Trust Gateway', kind: 'vpn', asns: [13335], partial: true,
    prefixes: ['162.159.192.0/24', '162.159.193.0/24', '162.159.197.0/24', '162.159.239.0/24', '2606:4700:100::/48', '2606:4700:102::/48', '2606:4700:105::/48'],
  },
  { id: 'zscaler', name: 'Zscaler ZIA', kind: 'enterprise-proxy', partial: true, prefixes: ['159.254.250.0/23'] },
];

// ───────────────────────── local fallback: Web Bot Auth directories (observed live 2026-10-24) ─────────────────────────

export const LOCAL_WEB_BOT_AUTH_DIRECTORIES: WebBotAuthDirectory[] = [
  { origin: 'https://chatgpt.com', provider: 'openai', product: 'ChatGPT agent (cloud browser)', purpose: 'ai', status: 'live', classes: { 'computer-use-agent': 3, 'fetch-agent': 1 } },
  { origin: 'https://www.chatgpt.com', provider: 'openai', product: 'ChatGPT agent (cloud browser)', purpose: 'ai', status: 'live', classes: { 'computer-use-agent': 3, 'fetch-agent': 1 } },
  { origin: 'https://agent.bot.goog', provider: 'google', product: 'Google-Agent', status: 'live', classes: { 'computer-use-agent': 3, 'fetch-agent': 1 } },
  { origin: 'https://www.meta.com', provider: 'meta', product: 'Meta-ExternalTest', status: 'live', classes: { 'fetch-agent': 2, 'computer-use-agent': 1 } },
  { origin: 'https://assistbot.duckduckgo.com', provider: 'duckduckgo', product: 'DuckAssistBot', status: 'live', classes: { 'fetch-agent': 3 } },
  { origin: 'https://www.browserbase.com', provider: 'browserbase', product: 'Browserbase', purpose: 'rag', status: 'live', classes: { 'browser-agent': 3 } },
  { origin: 'https://cursorusercontent.com', provider: 'xai', product: 'Grok Bot (Cursor-hosted)', status: 'live', classes: { 'computer-use-agent': 3 } },
  { origin: 'https://www.hyperbrowser.ai', provider: 'hyperbrowser', product: 'Hyperbrowser', status: 'live', classes: { 'browser-agent': 3 } },
  { origin: 'https://www.kernel.sh', provider: 'kernel', product: 'Kernel', status: 'live', classes: { 'browser-agent': 3 } },
  { origin: 'https://search.bot.kernel.sh', provider: 'kernel', product: 'Kernel SearchBot', status: 'live', classes: { 'ai-crawler': 2, 'fetch-agent': 1 } },
  { origin: 'https://www.browserless.io', provider: 'browserless', product: 'Browserless', status: 'broken', classes: { 'browser-agent': 3 } },
  { origin: 'https://api.anchorbrowser.io', provider: 'anchor', product: 'Anchor Browser', status: 'survey', classes: { 'browser-agent': 3 } },
  { origin: 'https://api.apify.com', provider: 'apify', product: 'Apify', status: 'survey', classes: { 'ai-crawler': 2, 'browser-agent': 1 } },
  { origin: 'https://api.manus.im', provider: 'manus', product: 'Manus', status: 'survey', classes: { 'computer-use-agent': 3 } },
  { origin: 'https://crawler.exa.ai', provider: 'exa', product: 'Exa crawler', status: 'survey', classes: { 'ai-crawler': 3 } },
  { origin: 'https://you.com', provider: 'you', product: 'YouBot', status: 'survey', classes: { 'search-crawler': 3 } },
  { origin: 'https://www.klaviyo.com', provider: 'klaviyo', status: 'survey' },
  { origin: 'https://cloudsurf.shopify.io', provider: 'shopify', status: 'survey' },
  { origin: 'https://agentic-crawler-directory.guidedcrawler.workers.dev', provider: 'paypal', status: 'survey' },
  { origin: 'https://creators.spotify.com', provider: 'spotify', status: 'survey' },
  { origin: 'https://api.wappalyzer.com', provider: 'wappalyzer', status: 'survey' },
  { origin: 'https://payroll-bot.adp.com', provider: 'adp', status: 'survey' },
  { origin: 'https://external-bot.payhawk.com', provider: 'payhawk', status: 'survey' },
  { origin: 'https://bot.trychannel3.com', provider: 'channel3', status: 'survey' },
  { origin: 'https://rye.xyz', provider: 'rye', product: 'ryebot', status: 'survey' },
  { origin: 'https://signatures.cardsavr.io', provider: 'strivve', status: 'survey' },
  { origin: 'https://api.firmly.online', provider: 'firmly', status: 'survey' },
  { origin: 'https://app.bugduck.tech', provider: 'qa-tech', status: 'survey' },
  { origin: 'https://agent.webmesh.ai', provider: 'webmesh', status: 'survey' },
  { origin: 'https://dnsdoc.webmesh.ai', provider: 'webmesh', status: 'survey' },
  { origin: 'https://seo.webmesh.ai', provider: 'webmesh', status: 'survey' },
  { origin: 'https://api.agi.tech', provider: 'agi-inc', status: 'survey' },
  { origin: 'https://search.ai.cloudflare.com', provider: 'cloudflare', product: 'Cloudflare AI Search', status: 'live', classes: { 'ai-crawler': 3 } },
  { origin: 'https://*.keydirectory.signer.*.on.aws', provider: 'amazon', product: 'Bedrock AgentCore Browser', status: 'live', classes: { 'browser-agent': 3 } },
  { origin: 'https://*.wba-bots.ai-audit.cfdata.org', provider: 'cloudflare', product: 'Cloudflare-issued agent identity', status: 'live' },
  { origin: 'https://*.workers.dev', provider: 'cloudflare', product: 'Cloudflare Browser Rendering', status: 'live', classes: { 'browser-agent': 3 } },
];

// ───────────────────────── merge with @necterai/signatures ─────────────────────────
//
// The signatures package uses its own record shapes (h1HeaderOrder, tls.ja4CipherHash,
// knownPrefixes, role: 'datacenter', status: 'directory', ...). Everything that comes from it
// goes through a tolerant normaliser into the contract above, so analyzers never see a shape
// they do not understand; records already in the local shape pass through unchanged.

const ext = signaturesModule as unknown as Record<string, unknown>;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const strs = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : typeof v === 'string' && v ? [v] : undefined);
const nonEmpty = <T>(v: T[] | undefined): T[] | undefined => (v && v.length ? v : undefined);

function extArray(key: string): unknown[] | undefined {
  try {
    const v = ext[key];
    return Array.isArray(v) && v.length ? v : undefined;
  } catch {
    return undefined;
  }
}

function normaliseList<T>(key: string, fn: (raw: Obj) => T | undefined): T[] | undefined {
  const raw = extArray(key);
  if (!raw) return undefined;
  const out: T[] = [];
  for (const r of raw) {
    if (!isObj(r)) continue;
    try {
      const n = fn(r);
      if (n) out.push(n);
    } catch {
      /* skip malformed record */
    }
  }
  return out.length ? out : undefined;
}

function kindFromSignal(signal: unknown): AgentRecord['kind'] | undefined {
  if (signal === 'declared.http-library-ua') return 'http-library';
  if (signal === 'declared.headless-ua') return 'headless';
  return undefined;
}

export function normaliseAgent(r: Obj): AgentRecord | undefined {
  const id = str(r['id']);
  const provider = str(r['provider']);
  const product = str(r['product']);
  const cls = str(r['class']) as ActorClass | undefined;
  if (!id || !provider || !product || !cls) return undefined;
  const rec: AgentRecord = { id, provider, product, class: cls, uaPatterns: strs(r['uaPatterns']) ?? [] };
  const ipRangeUrls = nonEmpty(strs(r['ipRangeUrls']));
  if (ipRangeUrls) rec.ipRangeUrls = ipRangeUrls;
  const rdns = nonEmpty(strs(r['rdnsSuffixes'])?.map((x) => x.trim().toLowerCase().replace(/^\./, '').replace(/\.$/, '')).filter(Boolean));
  if (rdns) rec.rdnsSuffixes = rdns;
  const robots = nonEmpty(strs(r['robotsTokens']));
  if (robots) rec.robotsTokens = robots;
  const wba = r['webBotAuth'];
  if (isObj(wba)) {
    const signs = wba['signs'] === true || wba['signs'] === 'partial' || wba['signs'] === 'optional';
    rec.webBotAuth = { signs, ...(str(wba['directoryUrl']) ? { directoryUrl: str(wba['directoryUrl'])! } : {}) };
  }
  if (typeof r['executesJs'] === 'boolean') rec.executesJs = r['executesJs'];
  if (typeof r['selfIdentifies'] === 'boolean') rec.selfIdentifies = r['selfIdentifies'];
  const verification = nonEmpty(strs(r['verification']));
  if (verification) rec.verification = verification;
  if (typeof r['respectsRobots'] === 'string' || typeof r['respectsRobots'] === 'boolean') rec.respectsRobots = r['respectsRobots'];
  if (str(r['notes'])) rec.notes = str(r['notes'])!;
  const sources = nonEmpty(strs(r['sources']));
  if (sources) rec.sources = sources;
  const kind = (str(r['kind']) as AgentRecord['kind']) ?? kindFromSignal(r['signal']) ?? (typeof r['uaMatchConfidence'] === 'number' && r['uaMatchConfidence'] < 0.5 ? 'unverifiable' : undefined);
  if (kind) rec.kind = kind;
  if (typeof r['uaMatchConfidence'] === 'number') rec.uaMatchConfidence = r['uaMatchConfidence'];
  if (isObj(r['classes'])) rec.classes = r['classes'] as AgentRecord['classes'];
  // Local knowledge the package may not carry yet (class overrides such as Google-Agent's computer-use boost).
  const local = LOCAL_AGENTS.find((l) => l.id === id);
  if (local?.classes && !rec.classes) rec.classes = local.classes;
  if (local?.kind && !rec.kind) rec.kind = local.kind;
  return rec;
}

function alpnFirst(v: unknown): HttpLibraryProfile['alpnFirst'] | undefined {
  if (v === 'h1' || v === 'h2' || v === 'none') return v;
  if (v === null) return 'none';
  const list = strs(v);
  if (!list) return undefined;
  if (!list.length) return 'none';
  return list[0] === 'h2' ? 'h2' : list[0] === 'http/1.1' ? 'h1' : undefined;
}

export function normaliseHttpLibraryProfile(r: Obj, browsers: BrowserHeaderProfile[] = LOCAL_BROWSER_HEADER_PROFILES): HttpLibraryProfile | undefined {
  const id = str(r['id']);
  if (!id) return undefined;
  const tls = isObj(r['tls']) ? r['tls'] : {};
  const h2 = isObj(r['h2']) ? r['h2'] : {};
  const p: HttpLibraryProfile = { id, name: str(r['name']) ?? id };
  const ua = str(r['uaPattern']);
  if (ua) p.uaPattern = ua;
  const order = nonEmpty(strs(r['headerOrder']) ?? strs(r['h1HeaderOrder']));
  if (order) p.headerOrder = order.map((n) => n.toLowerCase());
  if (r['lowercaseH1'] === true || r['headerCasing'] === 'lower') p.lowercaseH1 = true;
  if (str(r['accept'])) p.accept = str(r['accept'])!;
  const enc = nonEmpty(strs(r['acceptEncoding']));
  if (enc) p.acceptEncoding = enc;
  if (str(r['acceptLanguage'])) p.acceptLanguage = str(r['acceptLanguage'])!;
  const ja4 = nonEmpty(strs(r['ja4']) ?? strs(tls['ja4']));
  if (ja4) p.ja4 = ja4;
  const cipher = nonEmpty(strs(r['ja4Cipher']) ?? strs(tls['ja4CipherHash']) ?? ja4?.map((j) => j.split('_')[1] ?? '').filter(Boolean));
  if (cipher) p.ja4Cipher = [...new Set(cipher.map((c) => c.toLowerCase()))];
  const shared = str(r['cipherSharedWithBrowser']) as HttpLibraryProfile['cipherSharedWithBrowser'] | undefined;
  const derived = p.ja4Cipher ? browsers.find((b) => b.ja4Cipher.some((c) => p.ja4Cipher!.includes(c)))?.family : undefined;
  if (shared ?? derived) p.cipherSharedWithBrowser = (shared ?? derived)!;
  const akamai = nonEmpty(strs(r['akamai']) ?? strs(h2['akamai']));
  if (akamai) p.akamai = akamai;
  const pseudo = str(r['pseudoOrder']) ?? str(h2['pseudoHeaderOrder']);
  if (pseudo) p.pseudoOrder = pseudo;
  const af = alpnFirst(r['alpnFirst'] ?? tls['alpn']);
  if (af) p.alpnFirst = af;
  const other = isObj(r['otherHeaders']) ? r['otherHeaders'] : {};
  const settings = nonEmpty(strs(r['http2Settings']) ?? strs(Object.entries(other).find(([k]) => k.toLowerCase() === 'http2-settings')?.[1]));
  if (settings) p.http2Settings = settings;
  if (str(r['notes'])) p.notes = str(r['notes'])!;
  return p;
}

export function normaliseBrowserHeaderProfile(r: Obj): BrowserHeaderProfile | undefined {
  const family = str(r['family']) as BrowserHeaderProfile['family'] | undefined;
  if (family !== 'chromium' && family !== 'firefox' && family !== 'safari') return undefined;
  const local = LOCAL_BROWSER_HEADER_PROFILES.find((b) => b.family === family)!;
  return {
    family,
    accept: str(r['accept']) ?? str(r['acceptDocument']) ?? local.accept,
    acceptEncoding: str(r['acceptEncoding']) ?? local.acceptEncoding,
    navigationOrder: (nonEmpty(strs(r['navigationOrder']) ?? strs(r['h1HeaderOrder'])) ?? local.navigationOrder).map((n) => n.toLowerCase()),
    pseudoOrder: str(r['pseudoOrder']) ?? str(r['pseudoHeaderOrder']) ?? local.pseudoOrder,
    akamai: nonEmpty(strs(r['akamai']) ?? strs(r['akamaiH2'])) ?? local.akamai,
    ja4Cipher: nonEmpty(strs(r['ja4Cipher']) ?? strs(r['ja4CipherHash'])) ?? local.ja4Cipher,
    titleCaseH1: typeof r['titleCaseH1'] === 'boolean' ? r['titleCaseH1'] : r['headerCasing'] === 'title' ? true : r['headerCasing'] === 'lower' ? false : local.titleCaseH1,
  };
}

export function normaliseIpRangeSet(r: Obj): IpRangeSet | undefined {
  const provider = str(r['provider']);
  const prefixes = strs(r['prefixes']);
  if (!provider || !prefixes?.length) return undefined;
  const rawKind = str(r['kind']);
  const kind: IpRangeSet['kind'] = rawKind === 'relay' || rawKind === 'shared-egress' ? 'shared-egress' : rawKind === 'hosting' || rawKind === 'cdn' || rawKind === 'agent' ? rawKind : 'agent';
  const set: IpRangeSet = { provider, source: str(r['source']) ?? str(r['id']) ?? provider, fetchedAt: str(r['fetchedAt']) ?? '', prefixes, kind };
  const product = str(r['product']);
  if (product) set.product = product;
  if (r['partial'] === true) set.partial = true;
  return set;
}

export function normaliseHostingAsn(r: Obj): HostingAsn | undefined {
  const asn = typeof r['asn'] === 'number' ? r['asn'] : Number(r['asn']);
  if (!Number.isFinite(asn) || asn <= 0) return undefined;
  const rawKind = str(r['kind']) ?? str(r['role']);
  const kind: HostingAsn['kind'] = rawKind === 'cdn' ? 'cdn' : rawKind === 'shared-egress' || rawKind === 'relay' ? 'shared-egress' : rawKind === 'hosting' ? 'hosting' : 'cloud';
  const out: HostingAsn = { asn, name: str(r['name']) ?? `AS${asn}`, kind };
  const provider = str(r['provider']);
  if (provider) out.provider = provider;
  return out;
}

export function normaliseWebBotAuthDirectory(r: Obj): WebBotAuthDirectory | undefined {
  const origin = str(r['origin']);
  const provider = str(r['provider']);
  if (!origin || !provider) return undefined;
  const rawStatus = str(r['status']);
  const status: WebBotAuthDirectory['status'] = rawStatus === 'live' || rawStatus === 'directory' ? 'live' : rawStatus === 'survey' ? 'survey' : 'broken';
  const norm = origin.includes('://') ? origin.replace(/\/+$/, '') : `https://${origin.replace(/\/+$/, '')}`;
  const local = LOCAL_WEB_BOT_AUTH_DIRECTORIES.find((d) => d.origin === norm);
  const out: WebBotAuthDirectory = { origin: norm, provider, status };
  const product = str(r['product']) ?? local?.product;
  if (product) out.product = product;
  const purpose = str(r['purpose']) ?? local?.purpose;
  if (purpose) out.purpose = purpose;
  const classes = (isObj(r['classes']) ? (r['classes'] as WebBotAuthDirectory['classes']) : undefined) ?? local?.classes;
  if (classes) out.classes = classes;
  return out;
}

export function normaliseSharedEgress(r: Obj): SharedEgressList | undefined {
  const id = str(r['id']);
  if (!id) return undefined;
  const prefixes = strs(r['prefixes']) ?? strs(r['knownPrefixes']) ?? [];
  const asns = Array.isArray(r['asns']) ? (r['asns'] as unknown[]).filter((n): n is number => typeof n === 'number') : undefined;
  const rawKind = str(r['kind']);
  const lower = `${id} ${str(r['name']) ?? ''}`.toLowerCase();
  const kind: SharedEgressList['kind'] =
    rawKind === 'relay' || rawKind === 'vpn' || rawKind === 'enterprise-proxy' || rawKind === 'cgnat' || rawKind === 'cdn-proxy'
      ? rawKind
      : /zscaler|netskope|proxy|gateway/.test(lower) && !/warp/.test(lower)
        ? 'enterprise-proxy'
        : /warp|vpn|mullvad|tor/.test(lower)
          ? 'vpn'
          : 'relay';
  const out: SharedEgressList = { id, name: str(r['name']) ?? id, kind, prefixes };
  if (asns?.length) out.asns = asns;
  if (r['partial'] === true) out.partial = true;
  return out;
}

/** ext entries first; local entries whose key is not covered by ext are appended. */
function union<T>(extList: T[] | undefined, local: T[], key: (t: T) => string): T[] {
  if (!extList) return local;
  const seen = new Set(extList.map(key));
  return [...extList, ...local.filter((l) => !seen.has(key(l)))];
}

let cached: Knowledge | undefined;

/** The merged knowledge base: signatures package first, local fallback for anything missing. */
export function getKnowledge(): Knowledge {
  if (cached) return cached;
  const agents = normaliseList('agents', normaliseAgent) ?? LOCAL_AGENTS;
  const extMatchRaw = ext['matchUserAgent'];
  const extMatch = typeof extMatchRaw === 'function' ? (extMatchRaw as (ua: string) => unknown) : undefined;
  const browserHeaderProfiles = normaliseList('browserHeaderProfiles', normaliseBrowserHeaderProfile) ?? LOCAL_BROWSER_HEADER_PROFILES;
  const extSharedEgress = normaliseList('sharedEgress', normaliseSharedEgress);
  cached = {
    agents,
    matchUserAgent: (ua: string) => {
      if (extMatch) {
        try {
          const r = extMatch(ua);
          if (Array.isArray(r)) {
            const out: UaMatch[] = [];
            for (const m of r) {
              if (!isObj(m) || !isObj(m['record']) || typeof m['matched'] !== 'string') continue;
              const record = agents.find((a) => a.id === (m['record'] as Obj)['id']) ?? normaliseAgent(m['record'] as Obj);
              if (record) out.push({ record, matched: m['matched'] });
            }
            return out;
          }
        } catch {
          /* fall through to local */
        }
      }
      return localMatchUserAgent(ua, agents);
    },
    ipRanges: normaliseList('ipRanges', normaliseIpRangeSet) ?? LOCAL_IP_RANGES,
    hostingAsns: union(normaliseList('hostingAsns', normaliseHostingAsn), LOCAL_HOSTING_ASNS, (h) => String(h.asn)),
    httpLibraryProfiles: normaliseList('httpLibraryProfiles', (r) => normaliseHttpLibraryProfile(r, browserHeaderProfiles)) ?? LOCAL_HTTP_LIBRARY_PROFILES,
    browserHeaderProfiles,
    webBotAuthDirectories: union(normaliseList('webBotAuthDirectories', normaliseWebBotAuthDirectory), LOCAL_WEB_BOT_AUTH_DIRECTORIES, (d) => d.origin),
    hostedAgentProfiles: (extArray('hostedAgentProfiles') as HostedAgentProfile[] | undefined) ?? [],
    sharedEgress: union(
      extSharedEgress?.map((e) => (e.prefixes.length ? e : { ...e, prefixes: LOCAL_SHARED_EGRESS.find((l) => l.id === e.id)?.prefixes ?? [] })),
      LOCAL_SHARED_EGRESS,
      (e) => e.id,
    ),
  };
  return cached;
}

/** Drop the memoised knowledge base (tests, hot reload after a signatures sync). */
export function resetKnowledgeCache(): void {
  cached = undefined;
}

/** Build a Knowledge object with overrides (tests, custom deployments). */
export function createKnowledge(overrides: Partial<Knowledge>): Knowledge {
  const base = getKnowledge();
  const agents = overrides.agents ?? base.agents;
  return {
    ...base,
    ...overrides,
    agents,
    matchUserAgent: overrides.matchUserAgent ?? (overrides.agents ? (ua) => localMatchUserAgent(ua, agents) : base.matchUserAgent),
  };
}

/** Slug used for a provider when nothing better is known: the registrable-ish host. */
export function providerSlugFromHost(host: string): string {
  const h = host.toLowerCase().replace(/^www\./, '');
  const parts = h.split('.');
  if (parts.length <= 2) return parts[0] ?? h;
  // Second-level ccTLDs (co.uk, com.au...) keep three labels.
  const sld = parts[parts.length - 2]!;
  if (sld.length <= 3 && parts.length >= 3 && parts[parts.length - 1]!.length === 2) return parts[parts.length - 3]!;
  return sld;
}
