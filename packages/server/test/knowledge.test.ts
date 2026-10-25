import { describe, expect, it } from 'vitest';
import {
  getKnowledge,
  normaliseAgent,
  normaliseHostingAsn,
  normaliseHttpLibraryProfile,
  normaliseIpRangeSet,
  normaliseSharedEgress,
  normaliseWebBotAuthDirectory,
} from '../src/knowledge.js';

/**
 * The seam to @necterai/signatures: records in the package's shape (h1HeaderOrder, tls.ja4CipherHash,
 * knownPrefixes, role, status: 'directory' ...) must normalise into the analyzer contract.
 */
describe('knowledge normalisers (signatures package shapes)', () => {
  it('HTTP library profile: header order, casing, JA4 cipher hash, h2, ALPN, h2c settings', () => {
    const p = normaliseHttpLibraryProfile({
      id: 'java-httpclient',
      name: 'Java HttpClient',
      language: 'java',
      version: '21',
      uaPattern: '^Java-http-client\\/',
      uaExample: 'Java-http-client/21.0.12.1',
      h1HeaderOrder: ['Connection', 'Host', 'HTTP2-Settings', 'Upgrade', 'User-Agent'],
      accept: null,
      acceptEncoding: null,
      connection: 'Upgrade, HTTP2-Settings',
      otherHeaders: { 'HTTP2-Settings': 'AAEAAEAAAAIAAAAAAAMAAAAAAAQBAAAAAAUAAEAAAAYABgAA', Upgrade: 'h2c' },
      tls: { ja4: ['t13d3113h2_1d947a95fc68_7e1102d2036b'], ja4CipherHash: ['1d947a95fc68'], grease: false, alpn: ['h2', 'http/1.1'] },
      h2: { akamai: '1:16384;2:0;3:0;4:16777216;5:16384;6:393216|33488897|0|a,m,p,s', pseudoHeaderOrder: 'a,m,p,s' },
      httpVersionDefault: 'h2',
      headerCasing: 'mixed',
      sources: [],
    })!;
    expect(p.headerOrder).toEqual(['connection', 'host', 'http2-settings', 'upgrade', 'user-agent']);
    expect(p.ja4Cipher).toEqual(['1d947a95fc68']);
    expect(p.akamai).toEqual(['1:16384;2:0;3:0;4:16777216;5:16384;6:393216|33488897|0|a,m,p,s']);
    expect(p.pseudoOrder).toBe('a,m,p,s');
    expect(p.alpnFirst).toBe('h2');
    expect(p.http2Settings).toEqual(['AAEAAEAAAAIAAAAAAAMAAAAAAAQBAAAAAAUAAEAAAAYABgAA']);
    expect(p.lowercaseH1).toBeUndefined();
    const bun = normaliseHttpLibraryProfile({ id: 'bun', name: 'Bun', h1HeaderOrder: ['Connection'], headerCasing: 'lower', tls: { ja4: ['t13d1713h1_5b57614c22b0_7f527383e249'], ja4CipherHash: ['5b57614c22b0'], alpn: null } })!;
    expect(bun.cipherSharedWithBrowser).toBe('firefox');
    expect(bun.lowercaseH1).toBe(true);
    expect(bun.alpnFirst).toBe('none');
  });

  it('ranges, ASNs, shared egress and directories', () => {
    expect(normaliseIpRangeSet({ id: 'icloud', provider: 'apple', product: 'iCloud Private Relay', kind: 'relay', source: 'x', fetchedAt: '', prefixes: ['172.224.226.0/27'] })?.kind).toBe('shared-egress');
    expect(normaliseIpRangeSet({ provider: 'openai', prefixes: [] })).toBeUndefined();
    expect(normaliseHostingAsn({ asn: 16509, name: 'AWS', provider: 'aws', role: 'datacenter', prefixListUrl: '' })).toEqual({ asn: 16509, name: 'AWS', kind: 'cloud', provider: 'aws' });
    expect(normaliseHostingAsn({ asn: 13335, name: 'Cloudflare', provider: 'cloudflare', role: 'cdn' })?.kind).toBe('cdn');
    const zs = normaliseSharedEgress({ id: 'zscaler', name: 'Zscaler ZIA', provider: 'zscaler', treatment: 'suppress-datacenter', knownPrefixes: ['159.254.250.0/23'] })!;
    expect(zs).toMatchObject({ kind: 'enterprise-proxy', prefixes: ['159.254.250.0/23'] });
    expect(normaliseSharedEgress({ id: 'cloudflare-warp', name: 'WARP', asns: [13335] })).toMatchObject({ kind: 'vpn', asns: [13335] });
    const dir = normaliseWebBotAuthDirectory({ origin: 'https://chatgpt.com', provider: 'openai', product: 'ChatGPT agent', status: 'directory', asOf: '2026-10-24', sources: [] })!;
    expect(dir.status).toBe('live');
    expect(dir.classes?.['computer-use-agent']).toBeGreaterThan(0);
  });

  it('agent records keep local class overrides and derive the kind from the declared signal', () => {
    const a = normaliseAgent({ id: 'google-agent', provider: 'google', product: 'Google-Agent', class: 'fetch-agent', uaPatterns: ['Google-Agent'], webBotAuth: { signs: 'partial' }, signal: 'declared.ai-agent-ua' })!;
    expect(a.classes?.['computer-use-agent']).toBe(3);
    expect(a.webBotAuth?.signs).toBe(true);
    expect(normaliseAgent({ id: 'lib-x', provider: 'unknown', product: 'x', class: 'fetch-agent', uaPatterns: ['^x/'], signal: 'declared.http-library-ua' })?.kind).toBe('http-library');
    expect(normaliseAgent({ id: 'bad' })).toBeUndefined();
  });

  it('the merged knowledge base exposes every contract field', () => {
    const kb = getKnowledge();
    expect(kb.agents.length).toBeGreaterThan(50);
    expect(kb.ipRanges.length).toBeGreaterThan(5);
    expect(kb.httpLibraryProfiles.some((p) => p.ja4Cipher?.includes('ab0a1bf427ad'))).toBe(true);
    expect(kb.sharedEgress.map((s) => s.id)).toEqual(expect.arrayContaining(['icloud-private-relay', 'cloudflare-warp', 'zscaler']));
    expect(kb.matchUserAgent('python-requests/2.32.3')[0]?.record.kind).toBe('http-library');
  });
});
