import type { ActorClass, ProviderId } from '@necterai/core';
import { getKnowledge, providerSlugFromHost, type Knowledge, type WebBotAuthDirectory } from '../knowledge.js';

export interface DirectoryAttribution {
  provider: ProviderId;
  product?: string;
  purpose?: string;
  classes?: Partial<Record<ActorClass, number>>;
  status?: WebBotAuthDirectory['status'];
  /** True when the origin matched a known directory record (not a slug fallback). */
  known: boolean;
}

function hostOf(originOrUrl: string): string {
  try {
    return new URL(originOrUrl.includes('://') ? originOrUrl : `https://${originOrUrl}`).hostname.toLowerCase();
  } catch {
    return originOrUrl.toLowerCase().replace(/^https?:\/\//, '').split('/')[0] ?? originOrUrl;
  }
}

function globMatches(pattern: string, host: string): boolean {
  const re = new RegExp('^' + pattern.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[a-z0-9-]+') + '$', 'i');
  return re.test(host);
}

/**
 * Map a Web Bot Auth identity (the Signature-Agent URL / directory origin) to an
 * operator. Exact origins first, then per-tenant glob hosts (Amazon AgentCore,
 * Cloudflare), then a slug derived from the registrable host.
 */
export function attributeDirectory(identity: string, kb: Knowledge = getKnowledge()): DirectoryAttribution {
  const host = hostOf(identity);
  const dirs = kb.webBotAuthDirectories;
  const exact = dirs.find((d) => !d.origin.includes('*') && hostOf(d.origin) === host);
  const match = exact ?? dirs.find((d) => d.origin.includes('*') && globMatches(hostOf(d.origin), host));
  if (match) {
    const out: DirectoryAttribution = { provider: match.provider, status: match.status, known: true };
    if (match.product) out.product = match.product;
    if (match.purpose) out.purpose = match.purpose;
    if (match.classes) out.classes = match.classes;
    return out;
  }
  // Heuristic fallbacks for hosts the table does not list yet.
  if (/\.on\.aws$/.test(host) && /keydirectory\.signer\./.test(host)) return { provider: 'amazon', product: 'Bedrock AgentCore Browser', classes: { 'browser-agent': 3 }, known: true };
  if (/\.cfdata\.org$/.test(host) || /\.workers\.dev$/.test(host) || /cloudflare\.com$/.test(host)) return { provider: 'cloudflare', known: true };
  if (/(^|\.)openai\.com$|(^|\.)chatgpt\.com$/.test(host)) return { provider: 'openai', classes: { 'computer-use-agent': 3, 'fetch-agent': 1 }, known: true };
  if (/(^|\.)bot\.goog$|(^|\.)google\.com$/.test(host)) return { provider: 'google', classes: { 'computer-use-agent': 3, 'fetch-agent': 1 }, known: true };
  if (/(^|\.)meta\.com$|(^|\.)facebook\.com$/.test(host)) return { provider: 'meta', known: true };
  if (/(^|\.)anthropic\.com$|(^|\.)claude\.(ai|com)$/.test(host)) return { provider: 'anthropic', known: true };
  if (/(^|\.)perplexity\.(ai|com)$/.test(host)) return { provider: 'perplexity', known: true };
  if (/(^|\.)duckduckgo\.com$/.test(host)) return { provider: 'duckduckgo', known: true };
  if (/(^|\.)browserbase\.com$/.test(host)) return { provider: 'browserbase', classes: { 'browser-agent': 3 }, known: true };
  if (/(^|\.)hyperbrowser\.ai$/.test(host)) return { provider: 'hyperbrowser', classes: { 'browser-agent': 3 }, known: true };
  if (/(^|\.)kernel\.sh$|(^|\.)onkernel\.com$/.test(host)) return { provider: 'kernel', classes: { 'browser-agent': 3 }, known: true };
  if (/(^|\.)anchorbrowser\.io$/.test(host)) return { provider: 'anchor', classes: { 'browser-agent': 3 }, known: true };
  if (/(^|\.)manus\.im$/.test(host)) return { provider: 'manus', classes: { 'computer-use-agent': 3 }, known: true };
  if (/(^|\.)apify\.com$/.test(host)) return { provider: 'apify', known: true };
  if (/(^|\.)exa\.ai$/.test(host)) return { provider: 'exa', known: true };
  if (/(^|\.)you\.com$/.test(host)) return { provider: 'you', known: true };
  if (/(^|\.)cursorusercontent\.com$/.test(host)) return { provider: 'xai', product: 'Grok Bot (Cursor-hosted)', classes: { 'computer-use-agent': 3 }, known: true };
  return { provider: providerSlugFromHost(host), known: false };
}

/** Back-compat helper used by the analyzer's declared signal: provider id for a directory URL/host. */
export function providerFromDirectory(directory: string, kb?: Knowledge): string {
  return attributeDirectory(directory, kb).provider;
}
