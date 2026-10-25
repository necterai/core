import { describe, expect, it } from 'vitest';
import type { Signal } from '@necterai/core';
import {
  analyzeTls,
  createNecter,
  createCidrMatcher,
  createKnowledge,
  getKnowledge,
  networkAnalyzer,
  type DnsLike,
  type InspectExtras,
  type NetworkAnalyzerOptions,
  type ServerOptions,
} from '../src/index.js';

const UA = {
  gptbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.4; +https://openai.com/gptbot',
  chatgptUser: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
  claudeBot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
  claudeUser: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)',
  googleAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko; compatible; Google-Agent; +https://developers.google.com/crawling/docs/crawlers-fetchers/google-agent) Chrome/141.0.7390.122 Safari/537.36',
  googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  chrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  firefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:147.0) Gecko/20100101 Firefox/147.0',
  requests: 'python-requests/2.34.2',
};

const JA4 = {
  chrome: 't13d1516h2_8daaf6152771_02713d6af862',
  curlCffiChrome: 't13d1516h2_8daaf6152771_806a8c22fdea',
  firefox: 't13d1717h2_5b57614c22b0_3cbfd9057e0d',
  pythonRequests: 't13d1713h1_ab0a1bf427ad_8537cf56674e',
  nodeFetch: 't13d5212h1_b262b3658495_8e6e362c5eac',
  go: 't13d1312h2_f57a46bbacb6_ab7e3b40a677',
  httpxH2: 't13d1712h1_ab0a1bf427ad_8e6e362c5eac',
};
const AKAMAI = {
  chrome: '1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p',
  go: '2:0;4:4194304;5:16384;6:10485760|1073741824|0|a,m,p,s',
};

async function inspect(ua: string, extras: InspectExtras, opts: { analyzer?: NetworkAnalyzerOptions; server?: Partial<ServerOptions> } = {}) {
  const cm = createNecter({ analyzers: [networkAnalyzer(opts.analyzer ?? {})], ...(opts.server ?? {}) });
  const ins = await cm.inspect(new Request('https://shop.example.com/article', { headers: { 'user-agent': ua, accept: 'text/html' } }), extras);
  return { ins, ids: ins.signals.map((s) => s.id), get: (id: string): Signal | undefined => ins.signals.find((s) => s.id === id) };
}

describe('network: provider-published ranges for the declared product', () => {
  it('GPTBot from a published OpenAI prefix is verified', async () => {
    const r = await inspect(UA.gptbot, { ip: '20.171.206.17' });
    const v = r.get('network.ip-range-verified');
    expect(v?.details).toMatchObject({ verification: 'passed', method: 'ip-range', prefix: '20.171.206.0/24', source: 'https://openai.com/gptbot.json' });
    expect(v?.provider).toMatchObject({ id: 'openai', product: 'GPTBot', confidence: 0.99 });
    expect(r.ins.verdict.provider?.verified).toBe(true);
    expect(r.ids).not.toContain('network.declared-but-unverified');
  });

  it('GPTBot outside the complete published list is declared-but-unverified', async () => {
    const r = await inspect(UA.gptbot, { ip: '93.184.215.14' });
    const u = r.get('network.declared-but-unverified');
    expect(u?.details).toMatchObject({ verification: 'failed', method: 'ip-range', product: 'GPTBot', claimedProvider: 'openai' });
    expect(r.ids).not.toContain('network.ip-range-verified');
  });

  it('ChatGPT-User outside the complete published list (234 prefixes) → declared-but-unverified', async () => {
    const r = await inspect(UA.chatgptUser, { ip: '93.184.215.14' });
    expect(r.ids).toContain('network.declared-but-unverified');
    expect(r.ids).not.toContain('network.ip-range-verified');
  });

  it('Anthropic: ClaudeBot from the shared bots.json and Claude-User from its own range', async () => {
    const bot = await inspect(UA.claudeBot, { ip: '216.73.216.40' });
    expect(bot.get('network.ip-range-verified')?.provider).toMatchObject({ id: 'anthropic', product: 'ClaudeBot' });
    const user = await inspect(UA.claudeUser, { ip: '160.79.104.9' });
    expect(user.get('network.ip-range-verified')?.details?.['prefix']).toBe('160.79.104.0/21');
    const gcpSlash32 = await inspect(UA.claudeUser, { ip: '34.162.230.222' });
    expect(gcpSlash32.get('network.ip-range-verified')?.details?.['prefix']).toBe('34.162.230.222/32');
    const outside = await inspect(UA.claudeUser, { ip: '93.184.215.14' });
    expect(outside.ids).toContain('network.declared-but-unverified');
  });

  it('Google-Agent from the user-triggered-agents IPv4 and IPv6 prefixes', async () => {
    const v4 = await inspect(UA.googleAgent, { ip: '136.122.4.5' });
    expect(v4.get('network.ip-range-verified')?.provider).toMatchObject({ id: 'google', product: 'Google-Agent' });
    const v6 = await inspect(UA.googleAgent, { ip: '2001:4860:c::25' });
    expect(v6.get('network.ip-range-verified')?.details?.['prefix']).toBe('2001:4860:c::20/124');
    const spoof = await inspect(UA.googleAgent, { ip: '93.184.215.14' });
    expect(spoof.ids).toContain('network.declared-but-unverified');
  });

  it('never attributes private, loopback or documentation addresses', async () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '192.168.1.20', '198.51.100.7', '::1']) {
      const r = await inspect(UA.gptbot, { ip, asn: 16509 });
      expect(r.ids).toEqual([]);
    }
  });

  it('an undeclared client inside an AI operator range gets a provider hint (known-agent-asn)', async () => {
    const r = await inspect(UA.chrome, { ip: '216.73.216.99' });
    const k = r.get('network.known-agent-asn');
    expect(k?.provider).toMatchObject({ id: 'anthropic', confidence: 0.6 });
  });
});

describe('network: hosting and shared egress', () => {
  const kbWithHosting = createKnowledge({
    ipRanges: [
      ...getKnowledge().ipRanges,
      { provider: 'gcp', source: 'https://www.gstatic.com/ipranges/cloud.json', fetchedAt: '2026-10-24', kind: 'hosting', prefixes: ['34.152.0.0/16', '34.162.0.0/16', '35.192.0.0/12'] },
    ],
  });

  it('a cloud range → datacenter-ip', async () => {
    const r = await inspect(UA.chrome, { ip: '35.200.1.2' }, { analyzer: { knowledge: kbWithHosting } });
    expect(r.get('network.datacenter-ip')?.details).toMatchObject({ hostingProvider: 'gcp' });
  });

  it('a hosting ASN from the edge → datacenter-ip', async () => {
    const r = await inspect(UA.chrome, { ip: '3.90.10.20', asn: 16509 });
    expect(r.get('network.datacenter-ip')?.details).toMatchObject({ asn: 16509, hostingProvider: 'aws' });
  });

  it('a verified operator range wins over the cloud it sits in (Claude-User on GCP /32)', async () => {
    const r = await inspect(UA.claudeUser, { ip: '34.162.230.222' }, { analyzer: { knowledge: kbWithHosting } });
    expect(r.ids).toContain('network.ip-range-verified');
    expect(r.ids).not.toContain('network.datacenter-ip');
  });

  it('iCloud Private Relay: datacenter suppressed with detail shared-egress (zero weight) and the session is tagged', async () => {
    const r = await inspect(UA.chrome, { ip: '172.224.226.10', asn: 36183 });
    const d = r.get('network.datacenter-ip');
    expect(d?.details).toMatchObject({ suppressed: 'shared-egress', sharedEgress: 'icloud-private-relay' });
    expect(d?.automation).toBe(0);
    expect(d?.reliability).toBe(0);
    expect(r.ins.session.tags.has('shared-egress')).toBe(true);
    expect(r.ins.verdict.actorClass).toBe('human');
  });

  it('Cloudflare WARP (AS13335) and Zscaler egress are shared egress too', async () => {
    const warp = await inspect(UA.chrome, { ip: '104.28.50.1', asn: 13335 });
    expect(warp.get('network.datacenter-ip')?.details?.['suppressed']).toBe('shared-egress');
    const zs = await inspect(UA.chrome, { ip: '159.254.250.10' });
    expect(zs.get('network.datacenter-ip')?.details).toMatchObject({ suppressed: 'shared-egress', sharedEgress: 'zscaler', sharedKind: 'enterprise-proxy' });
  });

  it('Zscaler (TLS-intercepting proxy) damps a TLS/UA mismatch', async () => {
    const direct = await inspect(UA.chrome, { ip: '93.184.215.14', tls: { ja4: JA4.pythonRequests } });
    const viaZscaler = await inspect(UA.chrome, { ip: '159.254.250.10', tls: { ja4: JA4.pythonRequests } });
    expect(direct.get('network.tls-ua-mismatch')?.reliability).toBe(1);
    const damped = viaZscaler.get('network.tls-ua-mismatch');
    expect(damped?.reliability).toBeLessThanOrEqual(0.2);
    expect(damped?.details?.['sharedEgress']).toBe('zscaler');
  });
});

describe('network: forward-confirmed reverse DNS', () => {
  const fakeDns = (ptr: Record<string, string[]>, forward: Record<string, string[]>): DnsLike & { lookups: number } => {
    const d = {
      lookups: 0,
      async reverse(ip: string) {
        d.lookups++;
        const r = ptr[ip];
        if (!r) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
        return r;
      },
      async resolve4(name: string) {
        return forward[name] ?? [];
      },
      async resolve6(name: string) {
        return forward[name] ?? [];
      },
    };
    return d;
  };

  it('Googlebot with a googlebot.com PTR that forward-confirms → rdns-verified (and cached)', async () => {
    // An address outside the bundled published-range snapshot (a newly added crawler IP).
    const dns = fakeDns({ '45.33.7.7': ['crawl-45-33-7-7.googlebot.com'] }, { 'crawl-45-33-7-7.googlebot.com': ['45.33.7.7'] });
    const cm = createNecter({ rdns: true, analyzers: [networkAnalyzer({ dns })] });
    const mk = () => new Request('https://shop.example.com/', { headers: { 'user-agent': UA.googlebot } });
    const ins = await cm.inspect(mk(), { ip: '45.33.7.7' });
    const v = ins.signals.find((s) => s.id === 'network.rdns-verified');
    expect(v?.details).toMatchObject({ verification: 'passed', method: 'rdns', ptr: 'crawl-45-33-7-7.googlebot.com', suffix: 'googlebot.com' });
    expect(v?.provider).toMatchObject({ id: 'google', confidence: 0.99 });
    await cm.inspect(mk(), { ip: '45.33.7.7' });
    expect(dns.lookups).toBe(1);
  });

  it('a PTR outside the suffix list (or a forward mismatch) → declared-but-unverified', async () => {
    const dns = fakeDns({ '45.33.1.2': ['crawl.googlebot.com.attacker.example'], '45.33.1.3': ['fake.googlebot.com'] }, { 'fake.googlebot.com': ['45.33.9.9'] });
    const outside = await inspect(UA.googlebot, { ip: '45.33.1.2' }, { analyzer: { dns }, server: { rdns: true } });
    // Google publishes a complete list, so the method is ip-range and the FCrDNS failure is attached.
    expect(outside.get('network.declared-but-unverified')?.details).toMatchObject({ rdns: { reason: 'ptr-outside-suffixes' } });
    const mismatch = await inspect(UA.googlebot, { ip: '45.33.1.3' }, { analyzer: { dns }, server: { rdns: true } });
    expect(mismatch.get('network.declared-but-unverified')?.details).toMatchObject({ rdns: { reason: 'forward-mismatch' } });
  });

  it('does nothing when rdns is disabled (the default)', async () => {
    const dns = fakeDns({}, {});
    const r = await inspect(UA.googlebot, { ip: '45.33.7.8' }, { analyzer: { dns } });
    expect(r.ids.filter((id) => id === 'network.rdns-verified')).toEqual([]);
    expect(dns.lookups).toBe(0);
    // Inside the published list the range alone verifies, still without DNS.
    const inRange = await inspect(UA.googlebot, { ip: '66.249.66.1' }, { analyzer: { dns } });
    expect(inRange.ids).toContain('network.ip-range-verified');
    expect(dns.lookups).toBe(0);
  });
});

describe('network: TLS / HTTP2 fingerprints', () => {
  it('library cipher hash under a browser UA → tls-ua-mismatch', async () => {
    const r = await inspect(UA.chrome, { tls: { ja4: JA4.pythonRequests } });
    const m = r.get('network.tls-ua-mismatch');
    expect(m?.details).toMatchObject({ check: 'C1', match: 'ja4' });
    const node = analyzeTls({ ja4: 't13d5213h1_b262b3658495_ffffffffffff' }, UA.firefox);
    expect(node[0]?.id).toBe('network.tls-ua-mismatch');
    expect(node[0]?.details?.['match']).toBe('cipher-hash');
  });

  it('library UA + library JA4 → tls-fingerprint-library', async () => {
    const r = await inspect(UA.requests, { tls: { ja4: JA4.pythonRequests } });
    expect(r.get('network.tls-fingerprint-library')?.reliability).toBe(1);
    expect(r.ids).not.toContain('network.tls-ua-mismatch');
    const go = analyzeTls({ ja4: JA4.go, h2: AKAMAI.go }, 'Go-http-client/2.0');
    expect(go.map((s) => s.id)).toEqual(['network.tls-fingerprint-library']);
  });

  it('real browsers (and byte-perfect impersonation) are not flagged', () => {
    expect(analyzeTls({ ja4: JA4.chrome, grease: true, h2: AKAMAI.chrome, alpn: 'h2' }, UA.chrome)).toEqual([]);
    expect(analyzeTls({ ja4: JA4.curlCffiChrome, grease: true, h2: AKAMAI.chrome, alpn: 'h2' }, UA.chrome)).toEqual([]);
    expect(analyzeTls({ ja4: JA4.firefox, grease: false, alpn: 'h2' }, UA.firefox)).toEqual([]);
  });

  it('browser-family contradictions: Firefox cipher list under Chrome, no GREASE, h1-first ALPN on h2, library h2 settings', () => {
    expect(analyzeTls({ ja4: JA4.firefox }, UA.chrome)[0]?.details?.['tlsFamily']).toBe('firefox');
    expect(analyzeTls({ ja4: JA4.chrome, grease: false }, UA.chrome)[0]?.details?.['check']).toBe('C4');
    const httpx = analyzeTls({ ja4: JA4.httpxH2, alpn: 'h2' }, UA.chrome);
    expect((httpx[0]?.details?.['checks'] as string[]).join(' ')).toMatch(/http\/1\.1 before h2/);
    const h2 = analyzeTls({ h2: AKAMAI.go }, UA.chrome);
    expect(h2[0]?.details).toMatchObject({ check: 'C2' });
    expect(String(h2[0]?.details?.['library'])).toMatch(/^Go net\/http/);
  });
});

describe('cidr matcher', () => {
  it('matches IPv4, IPv6 and v4-mapped addresses with merged prefixes', () => {
    const m = createCidrMatcher(['20.171.206.0/24', '20.171.207.0/24', '2001:4860:c::/124', '9.129.0.0/16']);
    expect(m.find('20.171.207.255')).toBe('20.171.207.0/24');
    expect(m('::ffff:20.171.206.1')).toBe(true);
    expect(m('2001:4860:c::f')).toBe(true);
    expect(m('2001:4860:c::10')).toBe(false);
    expect(m('20.171.208.0')).toBe(false);
    expect(m('not-an-ip')).toBe(false);
  });
});
