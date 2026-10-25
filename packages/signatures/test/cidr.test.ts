import { describe, expect, it } from 'vitest';
import { canonicalPrefix, createCidrMatcher, findIpRanges, ipRanges, parseCidr, parseIp } from '../src/index.js';

// Published prefixes (providers-tier1.md 2.1, 3.1, 4.1; providers-tier2.md 3.15).
const OPENAI_GPTBOT = ['132.196.86.0/24', '172.182.202.0/25', '20.125.66.80/28', '74.7.244.0/25'];
const ANTHROPIC = ['216.73.216.0/22', '34.162.230.222/32', '160.79.104.0/21'];
const GOOGLE_AGENT = ['2001:4860:c::/124', '2001:4860:c::10/124', '136.121.24.0/21', '136.122.0.0/16', '74.125.232.112/28'];
const CCBOT_V6 = ['2600:1f28:365:8000::/56'];

describe('parseIp / parseCidr', () => {
  it('parses IPv4, IPv6, compressed and mapped forms', () => {
    expect(parseIp('1.2.3.4')).toEqual({ version: 4, value: 0x01020304n });
    expect(parseIp('::1')).toEqual({ version: 6, value: 1n });
    expect(parseIp('2001:4860:c::')?.value).toBe(0x20014860000c0000_0000000000000000n);
    expect(parseIp('::ffff:136.122.0.1')).toEqual({ version: 4, value: (136n << 24n) | (122n << 16n) | 1n });
    expect(parseIp('64:ff9b::1.2.3.4')?.version).toBe(6);
    expect(parseIp('[2001:db8::1]')?.version).toBe(6);
    expect(parseIp('fe80::1%en0')?.version).toBe(6);
  });
  it('rejects junk', () => {
    for (const bad of ['', '1.2.3', '256.1.1.1', '01.2.3.4', '1.2.3.4.5', '2001:::1', '1::2::3', 'gggg::', 'example.com', '1:2:3:4:5:6:7:8:9']) {
      expect(parseIp(bad)).toBeUndefined();
    }
    expect(parseCidr('10.0.0.0/33')).toBeUndefined();
    expect(parseCidr('::/129')).toBeUndefined();
    expect(parseCidr('10.0.0.0/x')).toBeUndefined();
  });
  it('masks host bits and canonicalises bare IPs', () => {
    const r = parseCidr('20.125.66.85/28')!;
    expect(r.start).toBe(parseIp('20.125.66.80')!.value);
    expect(r.end).toBe(parseIp('20.125.66.95')!.value);
    expect(canonicalPrefix('3.224.62.45')).toBe('3.224.62.45/32');
    expect(canonicalPrefix('2600:1f28::1')).toBe('2600:1f28::1/128');
  });
});

describe('createCidrMatcher', () => {
  const m = createCidrMatcher([...OPENAI_GPTBOT, ...ANTHROPIC, ...GOOGLE_AGENT, ...CCBOT_V6, 'not-a-prefix']);

  it('matches IPv4 edges', () => {
    expect(m('132.196.86.0')).toBe(true);
    expect(m('132.196.86.255')).toBe(true);
    expect(m('132.196.85.255')).toBe(false);
    expect(m('132.196.87.0')).toBe(false);
    expect(m('172.182.202.127')).toBe(true);
    expect(m('172.182.202.128')).toBe(false);
    expect(m('20.125.66.79')).toBe(false);
    expect(m('20.125.66.80')).toBe(true);
    expect(m('20.125.66.95')).toBe(true);
    expect(m('20.125.66.96')).toBe(false);
    expect(m('216.73.216.0')).toBe(true);
    expect(m('216.73.219.255')).toBe(true);
    expect(m('216.73.220.0')).toBe(false);
    expect(m('34.162.230.222')).toBe(true);
    expect(m('34.162.230.223')).toBe(false);
    expect(m('160.79.111.255')).toBe(true);
    expect(m('160.79.112.0')).toBe(false);
    expect(m('136.122.255.255')).toBe(true);
    expect(m('136.123.0.0')).toBe(false);
  });

  it('matches IPv6 edges', () => {
    expect(m('2001:4860:c::')).toBe(true);
    expect(m('2001:4860:c::f')).toBe(true);
    expect(m('2001:4860:c::10')).toBe(true);
    expect(m('2001:4860:c::1f')).toBe(true);
    expect(m('2001:4860:c::20')).toBe(false);
    expect(m('2001:4860:b:ffff:ffff:ffff:ffff:ffff')).toBe(false);
    expect(m('2600:1f28:365:80ff:ffff:ffff:ffff:ffff')).toBe(true);
    expect(m('2600:1f28:365:8100::')).toBe(false);
    expect(m('2600:1f28:365:7fff:ffff:ffff:ffff:ffff')).toBe(false);
  });

  it('treats IPv4-mapped IPv6 as IPv4 and keeps families apart', () => {
    expect(m('::ffff:216.73.216.1')).toBe(true);
    expect(m('::d849:d801')).toBe(false); // IPv4-compatible (deprecated) form is IPv6 space, not 216.73.216.1
    const v6Only = createCidrMatcher(['::/0']);
    expect(v6Only('1.2.3.4')).toBe(false);
    expect(v6Only('2001:db8::1')).toBe(true);
    const v4Only = createCidrMatcher(['0.0.0.0/0']);
    expect(v4Only('2001:db8::1')).toBe(false);
    expect(v4Only('8.8.8.8')).toBe(true);
  });

  it('merges overlaps, reports the covering prefix and ignores junk', () => {
    const mm = createCidrMatcher(['10.0.0.0/8', '10.1.0.0/16', '11.0.0.0/8', '192.168.1.1']);
    expect(mm.size).toBe(3); // 10.1/16 folds into 10/8; adjacent 11/8 stays separate so find() stays exact
    expect(mm('192.168.1.1')).toBe(true);
    expect(mm.find('10.1.2.3')).toBe('10.0.0.0/8');
    expect(mm.find('11.255.0.1')).toBe('11.0.0.0/8');
    expect(mm('12.0.0.0')).toBe(false);
    expect(mm('garbage')).toBe(false);
    expect(createCidrMatcher([])('1.1.1.1')).toBe(false);
  });

  it('scales to the bundled feeds (binary search over thousands of ranges)', () => {
    const all = createCidrMatcher(ipRanges.flatMap((r) => r.prefixes));
    expect(all.size).toBeGreaterThan(1000);
    expect(all('74.7.244.10')).toBe(true);
  });
});

describe('bundled ipRanges', () => {
  it('attributes published addresses to the right feed', () => {
    expect(findIpRanges('74.7.244.10').map((r) => r.id)).toContain('openai-gptbot');
    expect(findIpRanges('216.73.216.5').map((r) => r.id)).toEqual(['anthropic-bots']);
    expect(findIpRanges('160.79.104.9').map((r) => r.id)).toContain('anthropic-api-outbound');
    expect(findIpRanges('2001:4860:c::5').map((r) => r.id)).toContain('google-user-triggered-agents');
    expect(findIpRanges('66.249.66.1').map((r) => r.id)).toContain('google-common-crawlers');
    expect(findIpRanges('18.97.14.84').map((r) => r.id)).toContain('commoncrawl-ccbot');
    expect(findIpRanges('192.0.2.1')).toEqual([]);
  });
});
