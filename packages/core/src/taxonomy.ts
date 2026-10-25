/**
 * Actor taxonomy for necter.
 *
 * An "actor" is whatever is driving the session. We separate *who is at the
 * keyboard* (human vs. automation) from *what kind of automation* and *which
 * provider built it*, because interventions differ per class: a verified
 * search crawler is welcome, a fetch-agent should hit the agent gateway, a
 * computer-use agent gets a behavioural challenge, a CDP-driven stack gets
 * blocked outright.
 */
export const ACTOR_CLASSES = [
  /** A person operating the browser directly. */
  'human',
  /** A person is present, but an AI assistant (agentic browser, extension) is also reading/acting. */
  'human-assisted',
  /** CDP / WebDriver driven stack: Playwright, Puppeteer, Selenium, Browser Use, Stagehand, Playwright MCP, Skyvern... */
  'browser-agent',
  /** Screenshot-in, OS-level-input-out agents: Anthropic computer use, OpenAI CUA / ChatGPT agent, Mariner, Manus, Nova Act. */
  'computer-use-agent',
  /** Extension or agentic-browser automation of a user's browser: Claude for Chrome, Atlas agent mode, Comet, Gemini in Chrome. */
  'extension-agent',
  /** Tool-call / MCP fetchers that retrieve pages for an LLM on demand: ChatGPT-User, Claude-User, Perplexity-User, Firecrawl, Jina, python/undici fetchers. */
  'fetch-agent',
  /** Bulk crawlers feeding training or AI search indexes: GPTBot, ClaudeBot, Google-Extended, Meta-ExternalAgent, Bytespider, CCBot. */
  'ai-crawler',
  /** Classic search engine crawlers (wanted): Googlebot, Bingbot, Applebot. */
  'search-crawler',
  /** Wanted utility bots: link unfurlers, uptime monitors, Lighthouse. */
  'utility-bot',
  /** Generic non-LLM scripting / scraping automation. */
  'scripted-automation',
  'unknown',
] as const;

export type ActorClass = (typeof ACTOR_CLASSES)[number];

/** Classes that mean a person is operating the session. */
export const HUMAN_CLASSES: ReadonlySet<ActorClass> = new Set<ActorClass>(['human', 'human-assisted']);

/** Classes that are automation of some kind (everything that is not a person). */
export const AUTOMATION_CLASSES: readonly ActorClass[] = ACTOR_CLASSES.filter(
  (c) => !HUMAN_CLASSES.has(c) && c !== 'unknown',
);

/** Classes that execute JavaScript in a real browser engine. */
export const BROWSER_CLASSES: ReadonlySet<ActorClass> = new Set<ActorClass>([
  'human',
  'human-assisted',
  'browser-agent',
  'computer-use-agent',
  'extension-agent',
  'scripted-automation',
]);

/** Classes that never execute our client SDK (server-side detection only). */
export const NON_BROWSER_CLASSES: ReadonlySet<ActorClass> = new Set<ActorClass>([
  'fetch-agent',
  'ai-crawler',
  'search-crawler',
  'utility-bot',
]);

export interface ProviderInfo {
  name: string;
  /** Organisation type, useful for policy defaults. */
  kind: 'ai-lab' | 'search' | 'social' | 'cloud' | 'open-source' | 'hosted-browser' | 'scraping-service' | 'commerce' | 'other';
  homepage?: string;
}

/**
 * Known providers. The id is a stable slug used in signatures, verdicts and
 * policies. Unknown providers are allowed (ProviderId is open) so the
 * signatures package can add entries without a core release.
 */
export const KNOWN_PROVIDERS = {
  openai: { name: 'OpenAI', kind: 'ai-lab', homepage: 'https://openai.com' },
  anthropic: { name: 'Anthropic', kind: 'ai-lab', homepage: 'https://anthropic.com' },
  google: { name: 'Google', kind: 'ai-lab', homepage: 'https://google.com' },
  meta: { name: 'Meta', kind: 'ai-lab', homepage: 'https://meta.com' },
  microsoft: { name: 'Microsoft', kind: 'ai-lab', homepage: 'https://microsoft.com' },
  perplexity: { name: 'Perplexity', kind: 'ai-lab', homepage: 'https://perplexity.ai' },
  amazon: { name: 'Amazon', kind: 'ai-lab', homepage: 'https://amazon.com' },
  apple: { name: 'Apple', kind: 'ai-lab', homepage: 'https://apple.com' },
  xai: { name: 'xAI', kind: 'ai-lab', homepage: 'https://x.ai' },
  bytedance: { name: 'ByteDance', kind: 'ai-lab', homepage: 'https://bytedance.com' },
  mistral: { name: 'Mistral AI', kind: 'ai-lab', homepage: 'https://mistral.ai' },
  deepseek: { name: 'DeepSeek', kind: 'ai-lab', homepage: 'https://deepseek.com' },
  cohere: { name: 'Cohere', kind: 'ai-lab', homepage: 'https://cohere.com' },
  alibaba: { name: 'Alibaba', kind: 'ai-lab', homepage: 'https://alibaba.com' },
  huawei: { name: 'Huawei', kind: 'ai-lab', homepage: 'https://huawei.com' },
  duckduckgo: { name: 'DuckDuckGo', kind: 'search', homepage: 'https://duckduckgo.com' },
  brave: { name: 'Brave', kind: 'search', homepage: 'https://brave.com' },
  you: { name: 'You.com', kind: 'search', homepage: 'https://you.com' },
  commoncrawl: { name: 'Common Crawl', kind: 'other', homepage: 'https://commoncrawl.org' },
  diffbot: { name: 'Diffbot', kind: 'scraping-service', homepage: 'https://diffbot.com' },
  'browser-use': { name: 'Browser Use', kind: 'open-source', homepage: 'https://browser-use.com' },
  browserbase: { name: 'Browserbase (Stagehand)', kind: 'hosted-browser', homepage: 'https://browserbase.com' },
  steel: { name: 'Steel', kind: 'hosted-browser', homepage: 'https://steel.dev' },
  hyperbrowser: { name: 'Hyperbrowser', kind: 'hosted-browser', homepage: 'https://hyperbrowser.ai' },
  skyvern: { name: 'Skyvern', kind: 'open-source', homepage: 'https://skyvern.com' },
  playwright: { name: 'Playwright', kind: 'open-source', homepage: 'https://playwright.dev' },
  puppeteer: { name: 'Puppeteer', kind: 'open-source', homepage: 'https://pptr.dev' },
  selenium: { name: 'Selenium', kind: 'open-source', homepage: 'https://selenium.dev' },
  firecrawl: { name: 'Firecrawl', kind: 'scraping-service', homepage: 'https://firecrawl.dev' },
  jina: { name: 'Jina AI', kind: 'scraping-service', homepage: 'https://jina.ai' },
  crawl4ai: { name: 'Crawl4AI', kind: 'open-source' },
  apify: { name: 'Apify', kind: 'scraping-service', homepage: 'https://apify.com' },
  manus: { name: 'Manus', kind: 'ai-lab', homepage: 'https://manus.im' },
  genspark: { name: 'Genspark', kind: 'ai-lab' },
  opera: { name: 'Opera', kind: 'other' },
  'browser-company': { name: 'The Browser Company', kind: 'other' },
  slack: { name: 'Slack', kind: 'social' },
  twitter: { name: 'X / Twitter', kind: 'social' },
  linkedin: { name: 'LinkedIn', kind: 'social' },
  discord: { name: 'Discord', kind: 'social' },
  telegram: { name: 'Telegram', kind: 'social' },
  unknown: { name: 'Unknown', kind: 'other' },
} as const satisfies Record<string, ProviderInfo>;

export type KnownProviderId = keyof typeof KNOWN_PROVIDERS;
/** Open string union: known ids get autocompletion, anything else is still valid. */
export type ProviderId = KnownProviderId | (string & {});

export function providerName(id: ProviderId): string {
  const info = (KNOWN_PROVIDERS as Record<string, ProviderInfo>)[id];
  return info ? info.name : id;
}

export function isHumanClass(c: ActorClass): boolean {
  return HUMAN_CLASSES.has(c);
}
