import { describe, expect, it } from 'vitest';
import { parseIpFeed, toIpRangeSet, type IpSource } from '../src/index.js';

describe('parseIpFeed', () => {
  it('prefixes-json (Google style, Amazon ip_prefix / bare IPs)', () => {
    const f = parseIpFeed('prefixes-json', JSON.stringify({ creationTime: '2026-10-20T00:00:00Z', prefixes: [{ ipv4Prefix: '216.73.216.0/22' }, { ipv6Prefix: '2001:4860:c::/124' }, { ip_prefix: '3.224.62.45' }, { ipv4Prefix: 'bogus' }] }));
    expect(f).toEqual({ creationTime: '2026-10-20T00:00:00Z', prefixes: ['216.73.216.0/22', '2001:4860:c::/124', '3.224.62.45/32'] });
  });
  it('aws-json with service filter', () => {
    const body = JSON.stringify({ createDate: '2026-10-24-19-37-05', prefixes: [{ ip_prefix: '3.0.0.0/15', service: 'EC2' }, { ip_prefix: '13.32.0.0/15', service: 'CLOUDFRONT' }], ipv6_prefixes: [{ ipv6_prefix: '2600:1f00::/24', service: 'EC2' }] });
    expect(parseIpFeed('aws-json', body, { service: 'EC2' }).prefixes).toEqual(['3.0.0.0/15', '2600:1f00::/24']);
  });
  it('azure-json with tag filter', () => {
    const body = JSON.stringify({ values: [{ name: 'AzureCloud', properties: { addressPrefixes: ['4.0.0.0/8'] } }, { name: 'AzureCloud.eastus', properties: { addressPrefixes: ['20.0.0.0/8'] } }] });
    expect(parseIpFeed('azure-json', body, { name: 'AzureCloud' }).prefixes).toEqual(['4.0.0.0/8']);
    expect(parseIpFeed('azure-json', body, { name: 'AzureCloud.' }).prefixes).toEqual(['20.0.0.0/8']);
  });
  it('geofeed CSV and text lines', () => {
    expect(parseIpFeed('csv-geofeed', '# comment\n5.101.96.0/21,NL,NL-NH,Amsterdam,1098 XH\n\n2a02:26f7:b784:4dc7::/64,TW,,\n').prefixes).toEqual(['5.101.96.0/21', '2a02:26f7:b784:4dc7::/64']);
    expect(parseIpFeed('txt-lines', '2400:cb00::/32\r\n1.2.3.4\n').prefixes).toEqual(['2400:cb00::/32', '1.2.3.4/32']);
  });
  it('fastly, oci, html-embedded-json, html-ip-scan, cidr-scan', () => {
    expect(parseIpFeed('fastly-json', '{"addresses":["23.235.32.0/20"],"ipv6_addresses":["2a04:4e40::/32"]}').prefixes).toHaveLength(2);
    expect(parseIpFeed('oci-json', '{"regions":[{"cidrs":[{"cidr":"129.146.0.0/21"}]}]}').prefixes).toEqual(['129.146.0.0/21']);
    expect(parseIpFeed('html-embedded-json', '<script>var x = {"creationTime": "2026-09-08", "prefixes":[{"ipv4Prefix": "3.1.2.3"}]}</script>')).toEqual({ creationTime: '2026-09-08', prefixes: ['3.1.2.3/32'] });
    expect(parseIpFeed('html-ip-scan', '<ul><li>20.191.45.212</li><li>v1.2.3</li><script>"9.9.9.9"</script></ul>').prefixes).toEqual(['20.191.45.212/32']);
    expect(parseIpFeed('cidr-scan', '{"prefixes_ipv4":["3.1.36.99/32"],"x":{"range":"159.254.250.0/23"}}').prefixes).toEqual(['3.1.36.99/32', '159.254.250.0/23']);
  });
  it('toIpRangeSet dedupes and carries metadata', () => {
    const src: IpSource = { id: 'x', provider: 'openai', product: 'X', url: 'https://example.test/x.json', format: 'prefixes-json', kind: 'agent', bundled: true, partial: true, agentIds: ['gptbot'] };
    const set = toIpRangeSet(src, { prefixes: ['1.2.3.0/24', '1.2.3.0/24'], creationTime: 't' }, '2026-10-24');
    expect(set).toEqual({ id: 'x', provider: 'openai', product: 'X', kind: 'agent', source: 'https://example.test/x.json', fetchedAt: '2026-10-24', creationTime: 't', partial: true, agentIds: ['gptbot'], prefixes: ['1.2.3.0/24'] });
  });
});
