/**
 * Feed parsers shared by the offline normaliser, the sync script and runtime
 * consumers that want to refresh ranges themselves. Pure functions over text.
 */
import { canonicalPrefix, parseCidr } from './cidr.js';
import type { IpRangeSet, IpSource, IpSourceFormat } from './types.js';

export interface ParsedFeed {
  prefixes: string[];
  creationTime?: string;
}

const CIDR_TOKEN = /(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?|(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}(?:\/\d{1,3})?/g;
const IPV4_TOKEN = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.]|\/)/g;

function pushValid(out: string[], raw: unknown): void {
  if (typeof raw !== 'string') return;
  const c = canonicalPrefix(raw);
  if (c) out.push(c);
}

function dedupe(prefixes: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of prefixes) {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function collectStrings(node: unknown, out: string[]): void {
  if (typeof node === 'string') {
    for (const m of node.matchAll(CIDR_TOKEN)) if (parseCidr(m[0])) out.push(m[0]);
  } else if (Array.isArray(node)) {
    for (const v of node) collectStrings(v, out);
  } else if (node && typeof node === 'object') {
    for (const v of Object.values(node)) collectStrings(v, out);
  }
}

function parsePrefixesJson(j: Record<string, unknown>): ParsedFeed {
  const out: string[] = [];
  const list = Array.isArray(j.prefixes) ? j.prefixes : [];
  for (const p of list as Record<string, unknown>[]) {
    pushValid(out, p.ipv4Prefix ?? p.ipv6Prefix ?? p.ip_prefix ?? p.ipv6_prefix);
  }
  const feed: ParsedFeed = { prefixes: out };
  const ct = str(j.creationTime) ?? str(j.createDate);
  if (ct) feed.creationTime = ct;
  return feed;
}

/**
 * Parse a feed body. `filter` applies to multi-service feeds: aws `{service: 'EC2'}`,
 * azure `{name: 'AzureCloud'}` (exact service-tag name, or a prefix ending in `.`).
 */
export function parseIpFeed(format: IpSourceFormat, body: string, filter?: Record<string, string>): ParsedFeed {
  const text = body.replace(/^﻿/, '');
  switch (format) {
    case 'prefixes-json':
      return parsePrefixesJson(JSON.parse(text) as Record<string, unknown>);
    case 'aws-json': {
      const j = JSON.parse(text) as { prefixes?: Record<string, string>[]; ipv6_prefixes?: Record<string, string>[]; createDate?: string };
      const want = filter?.service;
      const out: string[] = [];
      for (const p of j.prefixes ?? []) if (!want || p.service === want) pushValid(out, p.ip_prefix);
      for (const p of j.ipv6_prefixes ?? []) if (!want || p.service === want) pushValid(out, p.ipv6_prefix);
      const feed: ParsedFeed = { prefixes: out };
      if (j.createDate) feed.creationTime = j.createDate;
      return feed;
    }
    case 'azure-json': {
      const j = JSON.parse(text) as { values?: { name?: string; properties?: { addressPrefixes?: string[] } }[] };
      const want = filter?.name;
      const out: string[] = [];
      for (const v of j.values ?? []) {
        const name = v.name ?? '';
        if (want && !(name === want || (want.endsWith('.') && name.startsWith(want)))) continue;
        for (const p of v.properties?.addressPrefixes ?? []) pushValid(out, p);
      }
      return { prefixes: out };
    }
    case 'oci-json': {
      const j = JSON.parse(text) as { last_updated_timestamp?: string; regions?: { cidrs?: { cidr?: string }[] }[] };
      const out: string[] = [];
      for (const r of j.regions ?? []) for (const c of r.cidrs ?? []) pushValid(out, c.cidr);
      const feed: ParsedFeed = { prefixes: out };
      if (j.last_updated_timestamp) feed.creationTime = j.last_updated_timestamp;
      return feed;
    }
    case 'fastly-json': {
      const j = JSON.parse(text) as { addresses?: string[]; ipv6_addresses?: string[] };
      const out: string[] = [];
      for (const p of [...(j.addresses ?? []), ...(j.ipv6_addresses ?? [])]) pushValid(out, p);
      return { prefixes: out };
    }
    case 'ipverse-json':
    case 'cidr-scan': {
      const out: string[] = [];
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      const found: string[] = [];
      collectStrings(parsed, found);
      for (const p of found) pushValid(out, p);
      return { prefixes: out };
    }
    case 'csv-geofeed':
    case 'txt-lines': {
      const out: string[] = [];
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        pushValid(out, t.split(/[,\s]/)[0]);
      }
      return { prefixes: out };
    }
    case 'html-embedded-json': {
      const out: string[] = [];
      for (const m of text.matchAll(/"(?:ipv4Prefix|ipv6Prefix|ip_prefix|ipv6_prefix)"\s*:\s*"([^"]+)"/g)) pushValid(out, m[1]);
      const feed: ParsedFeed = { prefixes: out };
      const ct = /"creationTime"\s*:\s*"([^"]+)"/.exec(text);
      if (ct?.[1]) feed.creationTime = ct[1];
      return feed;
    }
    case 'html-ip-scan': {
      // Only bare IPv4 addresses listed in page text (each becomes /32); strips tags first.
      const plain = text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
      const out: string[] = [];
      for (const m of plain.matchAll(IPV4_TOKEN)) pushValid(out, m[0]);
      return { prefixes: out };
    }
    default: {
      const never: never = format;
      throw new Error(`unknown feed format ${String(never)}`);
    }
  }
}

/** Build the normalised range-set record for a source. */
export function toIpRangeSet(source: IpSource, feed: ParsedFeed, fetchedAt: string, opts: { source?: string; transcribed?: boolean } = {}): IpRangeSet {
  const set: IpRangeSet = {
    id: source.id,
    provider: source.provider,
    product: source.product,
    kind: source.kind,
    source: opts.source ?? source.url,
    fetchedAt,
    prefixes: dedupe(feed.prefixes),
  };
  if (feed.creationTime) set.creationTime = feed.creationTime;
  if (source.partial) set.partial = true;
  if (opts.transcribed && source.transcribedFrom) set.transcribedFrom = source.transcribedFrom;
  if (source.agentIds?.length) set.agentIds = source.agentIds;
  return set;
}

export { dedupe as dedupePrefixes };
