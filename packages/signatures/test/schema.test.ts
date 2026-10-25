// @vitest-environment jsdom
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACTOR_CLASSES, SIGNAL_IDS } from '@necterai/core';
import {
  agentDomArtifacts,
  agentExtensions,
  agentHostShapes,
  agents,
  automationDefaults,
  automationGlobals,
  browserHeaderProfiles,
  hostedAgentProfiles,
  hostingAsns,
  httpLibraryProfiles,
  ipRanges,
  ipSources,
  isValidCidr,
  sharedEgress,
  webBotAuthAbsent,
  webBotAuthDirectories,
} from '../src/index.js';

// jsdom rewrites import.meta.url to an http: URL, so resolve from the test file's directory instead.
const DATA = join(import.meta.dirname, '..', 'data');
const CLASSES = new Set<string>(ACTOR_CLASSES);
const compiles = (src: string, flags = 'i') => {
  try {
    new RegExp(src, flags);
    return true;
  } catch {
    return false;
  }
};
const uniq = (xs: readonly (string | number)[]) => {
  const seen = new Set<string | number>();
  const dupes = xs.filter((x) => (seen.has(x) ? true : (seen.add(x), false)));
  return dupes;
};
const validClasses = (c: Record<string, number> | undefined) => !c || Object.entries(c).every(([k, v]) => CLASSES.has(k) && typeof v === 'number');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? (f === 'raw' ? [] : walk(p)) : f.endsWith('.json') ? [p] : [];
  });
}

describe('every JSON file under data/ parses', () => {
  it.each(walk(DATA).map((p) => [relative(DATA, p)]))('%s', (rel) => {
    expect(() => JSON.parse(readFileSync(join(DATA, rel), 'utf8'))).not.toThrow();
  });
});

describe('agents', () => {
  const KINDS = new Set(['agent', 'crawler', 'http-library', 'headless', 'utility', 'unverifiable']);
  const DECLARED = new Set(['declared.ai-agent-ua', 'declared.ai-crawler-ua', 'declared.search-crawler-ua', 'declared.utility-bot-ua', 'declared.http-library-ua', 'declared.headless-ua']);
  it('ids are unique across all agent files', () => {
    expect(uniq(agents.map((a) => a.id))).toEqual([]);
  });
  it.each(agents.map((a) => [a.id, a] as const))('%s is valid', (_id, a) => {
    expect(a.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(typeof a.provider).toBe('string');
    expect(a.product.length).toBeGreaterThan(0);
    expect(CLASSES.has(a.class), `class ${a.class}`).toBe(true);
    expect(KINDS.has(a.kind), `kind ${a.kind}`).toBe(true);
    expect(DECLARED.has(a.signal), `signal ${a.signal}`).toBe(true);
    expect(SIGNAL_IDS.has(a.signal)).toBe(true);
    expect(validClasses(a.classes)).toBe(true);
    for (const p of a.uaPatterns) expect(compiles(p), p).toBe(true);
    // A pattern must not match the empty string (it would match every request).
    for (const p of a.uaPatterns) expect(new RegExp(p, 'i').test(''), p).toBe(false);
    expect(Array.isArray(a.uaExamples)).toBe(true);
    expect(typeof a.webBotAuth.signs).toBe('boolean');
    if (a.executesJs !== undefined) expect(typeof a.executesJs).toBe('boolean');
    expect(typeof a.selfIdentifies).toBe('boolean');
    for (const v of a.verification) expect(['ip-range', 'rdns', 'web-bot-auth', 'none']).toContain(v);
    expect(['yes', 'no', 'partial', 'unknown']).toContain(a.respectsRobots);
    expect(['confirmed', 'observed', 'reported', 'uncertain']).toContain(a.evidence);
    if (a.uaMatchConfidence !== undefined) expect(a.uaMatchConfidence).toBeGreaterThan(0), expect(a.uaMatchConfidence).toBeLessThanOrEqual(1);
    for (const u of a.ipRangeUrls) expect(u).toMatch(/^https:\/\//);
    expect(a.sources.length).toBeGreaterThan(0);
    expect(typeof a.notes).toBe('string');
  });
  it('http-library and headless records have the matching signal', () => {
    for (const a of agents) {
      if (a.kind === 'http-library') expect(a.signal).toBe('declared.http-library-ua');
      if (a.kind === 'headless') expect(a.signal).toBe('declared.headless-ua');
    }
  });
});

describe('ip ranges', () => {
  const FORMATS = new Set(['prefixes-json', 'aws-json', 'azure-json', 'oci-json', 'fastly-json', 'ipverse-json', 'csv-geofeed', 'txt-lines', 'html-embedded-json', 'html-ip-scan', 'cidr-scan']);
  const KINDS = new Set(['agent', 'hosting', 'cdn', 'shared-egress']);
  const agentIds = new Set(agents.map((a) => a.id));
  it('sources.json is consistent', () => {
    expect(uniq(ipSources.map((s) => s.id))).toEqual([]);
    for (const s of ipSources) {
      expect(FORMATS.has(s.format), s.id).toBe(true);
      if (s.seedFormat) expect(FORMATS.has(s.seedFormat), s.id).toBe(true);
      expect(KINDS.has(s.kind), s.id).toBe(true);
      expect(s.url).toMatch(/^https:\/\//);
      if (s.seedFile) expect(existsSync(join(DATA, 'ip-ranges', 'raw', s.seedFile)), s.seedFile).toBe(true);
      for (const p of s.inlinePrefixes ?? []) expect(isValidCidr(p), p).toBe(true);
      for (const id of s.agentIds ?? []) expect(agentIds.has(id), `${s.id} -> ${id}`).toBe(true);
    }
  });
  it('every bundled range file on disk is exported, valid and non-empty', () => {
    const files = readdirSync(join(DATA, 'ip-ranges')).filter((f) => f.endsWith('.json') && f !== 'sources.json');
    expect(ipRanges.map((r) => `${r.id}.json`).sort()).toEqual(files.sort());
    for (const r of ipRanges) {
      const src = ipSources.find((s) => s.id === r.id);
      expect(src, r.id).toBeDefined();
      expect(src!.bundled).toBe(true);
      expect(KINDS.has(r.kind)).toBe(true);
      expect(r.provider).toBe(src!.provider);
      expect(r.source).toMatch(/^https:\/\//);
      expect(r.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
      expect(r.prefixes.length).toBeGreaterThan(0);
      expect(uniq(r.prefixes)).toEqual([]);
      for (const p of r.prefixes) expect(isValidCidr(p), `${r.id}: ${p}`).toBe(true);
    }
  });
  it('unbundled sync-time sources (AWS, Azure, iCloud Private Relay) are documented but not bundled', () => {
    for (const id of ['aws', 'azure', 'icloud-private-relay']) {
      const s = ipSources.find((x) => x.id === id);
      expect(s?.bundled).toBe(false);
      expect(s?.notes).toBeTruthy();
      expect(ipRanges.find((r) => r.id === id)).toBeUndefined();
    }
  });
  it('published counts match the research snapshot', () => {
    const count = (id: string) => ipRanges.find((r) => r.id === id)?.prefixes.length;
    expect(count('openai-gptbot')).toBe(18);
    expect(count('openai-searchbot')).toBe(39);
    expect(count('openai-chatgpt-user')).toBe(234);
    expect(count('openai-adsbot')).toBe(2);
    expect(count('anthropic-bots')).toBe(14);
    expect(count('google-common-crawlers')).toBe(317);
    expect(count('google-special-crawlers')).toBe(272);
    expect(count('google-user-triggered-fetchers')).toBe(1068);
    expect(count('google-user-triggered-fetchers-google')).toBe(504);
    expect(count('google-user-triggered-agents')).toBe(20);
    expect(count('perplexitybot')).toBe(8);
    expect(count('perplexity-user')).toBe(4);
    expect(count('bingbot')).toBe(28);
    expect(count('applebot')).toBe(24);
    expect(count('gcp-cloud')).toBe(1135);
    expect(count('duckduckbot')).toBe(346);
  });
});

describe('http library / browser profiles', () => {
  const JA4 = /^[tqd]\d{2}[di]\d{3,4}(h1|h2|00|[0-9a-f]{2})?_[0-9a-f]{12}_[0-9a-f]{12}$/;
  it('library profiles', () => {
    expect(uniq(httpLibraryProfiles.map((p) => p.id))).toEqual([]);
    for (const p of httpLibraryProfiles) {
      if (p.uaPattern) {
        expect(compiles(p.uaPattern), p.id).toBe(true);
        if (p.uaExample) expect(new RegExp(p.uaPattern, 'i').test(p.uaExample), p.id).toBe(true);
      }
      for (const j of p.ja4 ?? []) {
        expect(j, p.id).toMatch(JA4);
        expect(p.ja4Cipher, p.id).toContain(j.split('_')[1]);
      }
      if (p.headerOrder) expect(p.headerOrder.every((h) => h === h.toLowerCase())).toBe(true);
      if (p.headerOrder && p.h1HeaderOrderRaw) expect(p.h1HeaderOrderRaw.map((h) => h.toLowerCase())).toEqual(p.headerOrder);
      for (const a of p.akamai ?? []) expect(a.split('|')).toHaveLength(4);
    }
  });
  it('browser profiles', () => {
    expect(browserHeaderProfiles.map((b) => b.family).sort()).toEqual(['chromium', 'firefox', 'safari']);
    for (const b of browserHeaderProfiles) {
      expect(b.navigationOrder.every((h) => h === h.toLowerCase())).toBe(true);
      expect(b.akamai.length).toBeGreaterThan(0);
      expect(b.ja4Cipher.length).toBeGreaterThan(0);
    }
  });
});

describe('web bot auth, network lists, hosted profiles', () => {
  it('directories', () => {
    expect(uniq(webBotAuthDirectories.map((d) => d.origin))).toEqual([]);
    for (const d of webBotAuthDirectories) {
      expect(d.origin).toMatch(/^https:\/\/[a-z0-9*.-]+$/);
      expect(['live', 'broken', 'survey']).toContain(d.status);
      expect(validClasses(d.classes)).toBe(true);
      if (d.keys !== undefined && d.kids) expect(d.kids.length).toBe(d.keys);
    }
    for (const a of webBotAuthAbsent) expect(a.origin).toMatch(/^https:\/\//);
  });
  it('hosting ASNs and shared egress', () => {
    expect(uniq(hostingAsns.map((a) => a.asn))).toEqual([]);
    for (const a of hostingAsns) {
      expect(Number.isInteger(a.asn)).toBe(true);
      expect(['cloud', 'hosting', 'cdn', 'shared-egress']).toContain(a.kind);
    }
    expect(uniq(sharedEgress.map((s) => s.id))).toEqual([]);
    for (const s of sharedEgress) {
      expect(['relay', 'vpn', 'enterprise-proxy', 'cgnat', 'cdn-proxy']).toContain(s.kind);
      for (const p of [...s.prefixes, ...(s.ingressPrefixes ?? [])]) expect(isValidCidr(p), p).toBe(true);
    }
  });
  it('hosted agent profiles', () => {
    expect(uniq(hostedAgentProfiles.map((h) => h.id))).toEqual([]);
    for (const h of hostedAgentProfiles) {
      expect(CLASSES.has(h.class), h.id).toBe(true);
      expect(SIGNAL_IDS.has(h.signal), h.id).toBe(true);
      expect(typeof h.features).toBe('object');
      const { uaPattern, uaExample } = h.features;
      if (typeof uaPattern === 'string') {
        expect(compiles(uaPattern), h.id).toBe(true);
        if (typeof uaExample === 'string') expect(new RegExp(uaPattern).test(uaExample), h.id).toBe(true);
      }
    }
  });
});

describe('in-page artifacts', () => {
  it('automation globals', () => {
    expect(uniq(automationGlobals.map((g) => `${g.scope}|${g.stack}|${g.pattern}`))).toEqual([]);
    for (const g of automationGlobals) {
      expect(compiles(g.pattern, ''), g.pattern).toBe(true);
      expect(new RegExp(g.pattern).test(''), g.pattern).toBe(false);
      expect(['window', 'document', 'function-source', 'prototype']).toContain(g.scope);
      expect(['main', 'isolated', 'conditional']).toContain(g.visibility);
      expect(SIGNAL_IDS.has(g.signal), g.signal).toBe(true);
    }
  });
  it('DOM artifact selectors are valid CSS', () => {
    expect(uniq(agentDomArtifacts.map((d) => `${d.stack}|${d.selector}`))).toEqual([]);
    for (const d of agentDomArtifacts) {
      expect(() => document.querySelector(d.selector), d.selector).not.toThrow();
      expect(['light-dom', 'closed-shadow', 'attribute']).toContain(d.where);
      expect(['current', 'legacy', 'uncertain']).toContain(d.status);
      expect(SIGNAL_IDS.has(d.signal), d.signal).toBe(true);
    }
    for (const h of agentHostShapes) expect(SIGNAL_IDS.has(h.signal)).toBe(true);
  });
  it('extensions', () => {
    const ids = agentExtensions.map((e) => e.id).filter((x): x is string => x !== null);
    expect(uniq(ids)).toEqual([]);
    for (const e of agentExtensions) {
      if (e.id !== null) expect(e.id).toMatch(/^[a-p]{32}$/);
      for (const r of e.relatedIds ?? []) expect(r.id).toMatch(/^[a-p]{32}$/);
      for (const w of e.webAccessibleResources) expect(w.paths.length).toBeGreaterThan(0);
      for (const h of e.requestHeaders ?? []) expect(compiles(h.valuePattern), h.valuePattern).toBe(true);
    }
  });
  it('automation defaults', () => {
    expect(uniq(automationDefaults.map((d) => d.stack))).toEqual([]);
    for (const d of automationDefaults) {
      expect(CLASSES.has(d.class), d.stack).toBe(true);
      for (const s of d.catalogSignals) expect(SIGNAL_IDS.has(s), `${d.stack}: ${s}`).toBe(true);
    }
  });
});
