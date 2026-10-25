import type { ActorClass, SignalInput } from '@necterai/core';
import type { RequestAnalyzer } from '../types.js';
import { getKnowledge, providerSlugFromHost, type AgentRecord, type Knowledge, type UaMatch } from '../knowledge.js';

export type DeclaredSignalId =
  | 'declared.ai-agent-ua'
  | 'declared.ai-crawler-ua'
  | 'declared.search-crawler-ua'
  | 'declared.utility-bot-ua'
  | 'declared.http-library-ua'
  | 'declared.headless-ua';

/** Kept for backwards compatibility: the pre-signatures rule table. New code uses the knowledge base. */
export interface UaRule {
  re: RegExp;
  signal: DeclaredSignalId;
  provider?: string;
  product?: string;
}
export const BASELINE_UA_RULES: UaRule[] = [
  { re: /ChatGPT-User/i, signal: 'declared.ai-agent-ua', provider: 'openai', product: 'ChatGPT-User' },
  { re: /GPTBot/i, signal: 'declared.ai-crawler-ua', provider: 'openai', product: 'GPTBot' },
  { re: /Claude-User/i, signal: 'declared.ai-agent-ua', provider: 'anthropic', product: 'Claude-User' },
  { re: /ClaudeBot/i, signal: 'declared.ai-crawler-ua', provider: 'anthropic', product: 'ClaudeBot' },
  { re: /Googlebot/i, signal: 'declared.search-crawler-ua', provider: 'google', product: 'Googlebot' },
  { re: /HeadlessChrome/i, signal: 'declared.headless-ua' },
  { re: /^python-requests\//i, signal: 'declared.http-library-ua' },
  { re: /^curl\//i, signal: 'declared.http-library-ua' },
];

/** Exact default UA of Crawl4AI's BrowserConfig: note the missing `(KHTML, like Gecko)` token. */
export const CRAWL4AI_DEFAULT_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/116.0.0.0 Safari/537.36';
/** Lighthouse / PageSpeed Insights emulation UAs (no LH identifier since v10). */
export const LIGHTHOUSE_UAS = [
  'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
];

export interface DeclaredIdentity {
  record: AgentRecord;
  matched: string;
  signalId: DeclaredSignalId;
  reliability: number;
  classes?: Partial<Record<ActorClass, number>>;
}

const KIND_RANK: Record<NonNullable<AgentRecord['kind']>, number> = { agent: 5, crawler: 5, utility: 4, headless: 3, 'http-library': 2, unverifiable: 1 };

function signalIdFor(record: AgentRecord): DeclaredSignalId {
  if (record.kind === 'http-library') return 'declared.http-library-ua';
  if (record.kind === 'headless') return 'declared.headless-ua';
  switch (record.class) {
    case 'ai-crawler':
      return 'declared.ai-crawler-ua';
    case 'search-crawler':
      return 'declared.search-crawler-ua';
    case 'utility-bot':
      return 'declared.utility-bot-ua';
    case 'scripted-automation':
      return 'declared.http-library-ua';
    case 'browser-agent':
    case 'computer-use-agent':
    case 'extension-agent':
    case 'fetch-agent':
    default:
      return 'declared.ai-agent-ua';
  }
}

/**
 * Resolve the declared identity of a User-Agent: the most specific knowledge
 * record (longest matched token, then record kind) and the signal it maps to.
 */
export function resolveDeclaredAgent(ua: string, kb: Knowledge = getKnowledge()): DeclaredIdentity | undefined {
  if (!ua) return undefined;
  let matches: UaMatch[];
  try {
    matches = kb.matchUserAgent(ua);
  } catch {
    return undefined;
  }
  // A pattern a real browser can also send (e.g. Perplexity's undeclared crawler uses a stock
  // Chrome/124 macOS UA) is not a declaration: it must never yield a deterministic declared.*
  // signal. Those profiles are caught behaviourally (client-pattern / tie analyzers).
  matches = matches.filter((m) => (m.record.uaMatchConfidence ?? 1) >= 0.5);
  if (!matches.length) return undefined;
  const best = matches.reduce((acc, m) => {
    if (!acc) return m;
    const la = acc.matched.length;
    const lb = m.matched.length;
    if (lb !== la) return lb > la ? m : acc;
    const ra = KIND_RANK[acc.record.kind ?? 'agent'];
    const rb = KIND_RANK[m.record.kind ?? 'agent'];
    return rb > ra ? m : acc;
  });
  const record = best.record;
  const identity: DeclaredIdentity = {
    record,
    matched: best.matched,
    signalId: signalIdFor(record),
    reliability: record.kind === 'unverifiable' ? 0.8 : 1,
  };
  if (record.classes) identity.classes = record.classes;
  else if (record.class === 'browser-agent' || record.class === 'computer-use-agent' || record.class === 'extension-agent') identity.classes = { [record.class]: 4 } as Partial<Record<ActorClass, number>>;
  return identity;
}

/** Forged / frozen browser UA tells that need no knowledge record. */
export function frozenUaTell(ua: string): { summary: string; reliability: number; product?: string; provider?: string } | undefined {
  if (!ua) return undefined;
  if (ua === CRAWL4AI_DEFAULT_UA) {
    return { summary: 'UA is Crawl4AI\'s frozen default (Chrome/116 on X11 Linux without the "(KHTML, like Gecko)" token)', reliability: 0.7, product: 'Crawl4AI', provider: 'crawl4ai' };
  }
  if (/AppleWebKit\/537\.36/.test(ua) && /Chrome\//.test(ua) && !/\(KHTML, like Gecko/.test(ua)) {
    return { summary: 'AppleWebKit/Chrome UA without the "(KHTML, like Gecko)" token (hand-assembled browser UA)', reliability: 0.5 };
  }
  if (/Windows NT 11\.0/.test(ua)) {
    return { summary: 'UA claims "Windows NT 11.0", a version string no real browser emits (Windows 11 reports NT 10.0)', reliability: 0.6 };
  }
  return undefined;
}

const AGENT_HEADER_PROVIDERS: { re: RegExp; provider: string; product: string }[] = [
  { re: /^ChatGPT\//i, provider: 'openai', product: 'ChatGPT Chrome extension' },
];

export interface UserAgentAnalyzerOptions {
  knowledge?: Knowledge;
}

export function userAgentAnalyzer(opts: UserAgentAnalyzerOptions | UaRule[] = {}): RequestAnalyzer {
  // Legacy signature `userAgentAnalyzer(rules)` is accepted but rules are ignored in favour of the knowledge base.
  const kb = Array.isArray(opts) ? getKnowledge() : (opts.knowledge ?? getKnowledge());
  return {
    name: 'user-agent',
    analyze(ctx, api) {
      const h = ctx.headers;
      const uaHeader = h.get('user-agent');
      const ua = (uaHeader ?? '').trim();
      const from = h.get('from');
      const details: Record<string, unknown> = {};
      if (from) details['from'] = from.slice(0, 120);
      if (/;\s*robots\.txt\s*;/.test(ua)) details['robotsFetchMarker'] = true;

      // Vendor agent headers: the ChatGPT Chrome extension's x-browser-agent (server-policy gated).
      const browserAgent = h.get('x-browser-agent');
      if (browserAgent) {
        const known = AGENT_HEADER_PROVIDERS.find((p) => p.re.test(browserAgent));
        api.emit({
          id: 'declared.agent-header',
          summary: `x-browser-agent: ${browserAgent.slice(0, 60)} (agent-controlled browser tab)`,
          value: browserAgent.slice(0, 120),
          details: { header: 'x-browser-agent', verification: 'unverified' },
          classes: { 'extension-agent': 4 },
          ...(known ? { provider: { id: known.provider, product: known.product, confidence: 0.7 } } : {}),
        });
      }

      if (!ua) {
        api.emit({
          id: 'declared.http-library-ua',
          summary: uaHeader === null ? 'No User-Agent header (curl_cffi default, node:https, reqwest)' : 'Empty User-Agent',
          value: '',
          details,
        });
        return;
      }

      const declared = resolveDeclaredAgent(ua, kb);
      if (declared) {
        const { record } = declared;
        const providerHint = record.provider && record.provider !== 'unknown'
          ? { id: record.provider, product: record.product, confidence: record.kind === 'unverifiable' ? 0.3 : 0.55 }
          : undefined;
        const sig: SignalInput = {
          id: declared.signalId,
          summary: `User-Agent declares ${record.product} (${record.class}${record.kind === 'unverifiable' ? ', unverifiable token' : ''})`,
          value: ua.slice(0, 300),
          details: {
            ...details,
            agentId: record.id,
            product: record.product,
            matched: declared.matched,
            verification: 'unverified',
            ...(record.kind ? { kind: record.kind } : {}),
            ...(record.ipRangeUrls?.length ? { ipRangeUrls: record.ipRangeUrls } : {}),
            ...(record.rdnsSuffixes?.length ? { rdnsSuffixes: record.rdnsSuffixes } : {}),
            ...(record.webBotAuth?.signs ? { webBotAuth: true } : {}),
          },
          reliability: declared.reliability,
          ...(declared.classes ? { classes: declared.classes } : {}),
          ...(providerHint ? { provider: providerHint } : {}),
        };
        api.emit(sig);
        return;
      }

      const frozen = frozenUaTell(ua);
      if (frozen) {
        api.emit({
          id: 'declared.http-library-ua',
          summary: frozen.summary,
          value: ua.slice(0, 300),
          details: { ...details, tell: 'frozen-ua', verification: 'unverified' },
          reliability: frozen.reliability,
          ...(frozen.provider ? { provider: { id: frozen.provider, product: frozen.product ?? frozen.provider, confidence: 0.55 } } : {}),
        });
        return;
      }

      if (LIGHTHOUSE_UAS.includes(ua)) {
        // Lighthouse dropped its identifier in v10; this is a label for the review UI, never a score.
        api.emit({
          id: 'declared.utility-bot-ua',
          summary: 'UA equals the Lighthouse/PageSpeed emulation UA (Chrome/136 moto g power or macOS); label only',
          value: ua,
          automation: 0,
          classes: { 'utility-bot': 1 },
          details: { ...details, tell: 'lighthouse-like' },
        });
        return;
      }

      // A From: header without a UA token is still a declaration (Perplexity sends crawler-support@perplexity.ai).
      if (from && /@([a-z0-9.-]+)/i.test(from)) {
        const host = /@([a-z0-9.-]+)/i.exec(from)![1]!;
        api.emit({
          id: 'declared.agent-header',
          summary: `From: ${from.slice(0, 60)} on a browser-looking UA (crawler contact header)`,
          value: from.slice(0, 120),
          details: { header: 'from', verification: 'unverified' },
          classes: { 'ai-crawler': 2, 'fetch-agent': 1 },
          reliability: 0.8,
          provider: { id: providerSlugFromHost(host), product: host, confidence: 0.5 },
        });
      }
    },
  };
}
