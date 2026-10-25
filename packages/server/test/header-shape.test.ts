import { describe, expect, it } from 'vitest';
import { analyzeHeaderShape, createNecter, headerShapeAnalyzer, isDocumentRequest, isSecureContextRequest } from '../src/index.js';

/**
 * Header sets copied from docs/research/raw/server-fingerprints.md §3.4 (captured raw, wire order and
 * casing preserved) plus real browser navigations. Each entry is [name, value] in wire order.
 */
type Wire = [string, string][];

const CHROME_155 = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
const CHROME_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';
const FIREFOX_147 = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:147.0) Gecko/20100101 Firefox/147.0';
const SAFARI_26 = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';

const SETS: Record<string, Wire> = {
  'python-requests': [['Host', 'shop.example.com'], ['User-Agent', 'python-requests/2.34.2'], ['Accept-Encoding', 'gzip, deflate'], ['Accept', '*/*'], ['Connection', 'keep-alive']],
  httpx: [['Host', 'shop.example.com'], ['Accept', '*/*'], ['Accept-Encoding', 'gzip, deflate'], ['Connection', 'keep-alive'], ['User-Agent', 'python-httpx/0.28.1']],
  'node-fetch (undici)': [['host', 'shop.example.com'], ['connection', 'keep-alive'], ['accept', '*/*'], ['accept-language', '*'], ['sec-fetch-mode', 'cors'], ['user-agent', 'node'], ['accept-encoding', 'br, gzip, deflate']],
  curl: [['Host', 'shop.example.com'], ['User-Agent', 'curl/8.7.1'], ['Accept', '*/*']],
  go: [['Host', 'shop.example.com'], ['User-Agent', 'Go-http-client/1.1'], ['Accept-Encoding', 'gzip']],
  'java h2c upgrade': [['Connection', 'Upgrade, HTTP2-Settings'], ['Host', 'shop.example.com'], ['HTTP2-Settings', 'AAEAAEAAAAIAAAAAAAMAAAAAAAQBAAAAAAUAAEAAAAYABgAA'], ['Upgrade', 'h2c'], ['User-Agent', 'Java-http-client/21.0.12.1']],
  'curl_cffi default (no UA)': [['Host', 'shop.example.com'], ['Accept-Encoding', 'gzip, deflate, br']],
};

const CURL_CFFI_CHROME_HTTP: Wire = [
  ['Host', 'shop.example.com'],
  ['Upgrade', 'h2c'],
  ['HTTP2-Settings', 'AAEAAQAAAAIAAAAAAAQAYAAAAAYABAAA'],
  ['sec-ch-ua', '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"'],
  ['sec-ch-ua-mobile', '?0'],
  ['sec-ch-ua-platform', '"macOS"'],
  ['Upgrade-Insecure-Requests', '1'],
  ['User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'],
  ['Accept', CHROME_ACCEPT],
  ['Sec-Fetch-Site', 'none'],
  ['Sec-Fetch-Mode', 'navigate'],
  ['Sec-Fetch-User', '?1'],
  ['Sec-Fetch-Dest', 'document'],
  ['Accept-Encoding', 'gzip, deflate, br, zstd'],
  ['Accept-Language', 'en-US,en;q=0.9'],
  ['Connection', 'Upgrade, HTTP2-Settings'],
];

const CHROME_NAV_H2: Wire = [
  [':method', 'GET'],
  [':authority', 'shop.example.com'],
  [':scheme', 'https'],
  [':path', '/'],
  ['sec-ch-ua', '"Google Chrome";v="155", "Chromium";v="155", "Not)A;Brand";v="24"'],
  ['sec-ch-ua-mobile', '?0'],
  ['sec-ch-ua-platform', '"macOS"'],
  ['upgrade-insecure-requests', '1'],
  ['user-agent', CHROME_155],
  ['accept', CHROME_ACCEPT],
  ['sec-fetch-site', 'none'],
  ['sec-fetch-mode', 'navigate'],
  ['sec-fetch-user', '?1'],
  ['sec-fetch-dest', 'document'],
  ['accept-encoding', 'gzip, deflate, br, zstd'],
  ['accept-language', 'en-US,en;q=0.9'],
  ['priority', 'u=0, i'],
];

const CHROME_NAV_H1: Wire = [
  ['Host', 'shop.example.com'],
  ['Connection', 'keep-alive'],
  ['sec-ch-ua', '"Google Chrome";v="155", "Chromium";v="155", "Not)A;Brand";v="24"'],
  ['sec-ch-ua-mobile', '?0'],
  ['sec-ch-ua-platform', '"macOS"'],
  ['Upgrade-Insecure-Requests', '1'],
  ['User-Agent', CHROME_155],
  ['Accept', CHROME_ACCEPT],
  ['Sec-Fetch-Site', 'none'],
  ['Sec-Fetch-Mode', 'navigate'],
  ['Sec-Fetch-User', '?1'],
  ['Sec-Fetch-Dest', 'document'],
  ['Accept-Encoding', 'gzip, deflate, br, zstd'],
  ['Accept-Language', 'en-US,en;q=0.9'],
];

/** Chrome on a plain-http, non-localhost origin: no Sec-Fetch-*, no br/zstd. */
const CHROME_NAV_PLAIN_HTTP: Wire = [
  ['Host', 'intranet.example.com'],
  ['Connection', 'keep-alive'],
  ['Upgrade-Insecure-Requests', '1'],
  ['User-Agent', CHROME_155],
  ['Accept', CHROME_ACCEPT],
  ['Accept-Encoding', 'gzip, deflate'],
  ['Accept-Language', 'en-US,en;q=0.9'],
];

const ANDROID_CHROME_H2: Wire = [
  [':method', 'GET'],
  [':authority', 'shop.example.com'],
  [':scheme', 'https'],
  [':path', '/'],
  ['sec-ch-ua', '"Chromium";v="155", "Google Chrome";v="155", "Not_A Brand";v="99"'],
  ['sec-ch-ua-mobile', '?1'],
  ['sec-ch-ua-platform', '"Android"'],
  ['upgrade-insecure-requests', '1'],
  ['user-agent', 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36'],
  ['accept', CHROME_ACCEPT],
  ['sec-fetch-site', 'cross-site'],
  ['sec-fetch-mode', 'navigate'],
  ['sec-fetch-user', '?1'],
  ['sec-fetch-dest', 'document'],
  ['referer', 'https://www.google.com/'],
  ['accept-encoding', 'gzip, deflate, br, zstd'],
  ['accept-language', 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7'],
  ['cookie', 'a=b'],
  ['priority', 'u=0, i'],
];

const FIREFOX_NAV_H1: Wire = [
  ['Host', 'shop.example.com'],
  ['User-Agent', FIREFOX_147],
  ['Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'],
  ['Accept-Language', 'en-US,en;q=0.5'],
  ['Accept-Encoding', 'gzip, deflate, br, zstd'],
  ['Connection', 'keep-alive'],
  ['Upgrade-Insecure-Requests', '1'],
  ['Sec-Fetch-Dest', 'document'],
  ['Sec-Fetch-Mode', 'navigate'],
  ['Sec-Fetch-Site', 'none'],
  ['Sec-Fetch-User', '?1'],
  ['Priority', 'u=0, i'],
];

const FIREFOX_NAV_H2: Wire = [
  [':method', 'GET'],
  [':path', '/'],
  [':authority', 'shop.example.com'],
  [':scheme', 'https'],
  ['user-agent', FIREFOX_147],
  ['accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'],
  ['accept-language', 'en-US,en;q=0.5'],
  ['accept-encoding', 'gzip, deflate, br, zstd'],
  ['upgrade-insecure-requests', '1'],
  ['sec-fetch-dest', 'document'],
  ['sec-fetch-mode', 'navigate'],
  ['sec-fetch-site', 'none'],
  ['sec-fetch-user', '?1'],
  ['priority', 'u=0, i'],
  ['te', 'trailers'],
];

const SAFARI_NAV_H2: Wire = [
  [':method', 'GET'],
  [':scheme', 'https'],
  [':authority', 'shop.example.com'],
  [':path', '/'],
  ['sec-fetch-dest', 'document'],
  ['user-agent', SAFARI_26],
  ['accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'],
  ['sec-fetch-site', 'none'],
  ['sec-fetch-mode', 'navigate'],
  ['accept-language', 'en-GB,en;q=0.9'],
  ['priority', 'u=0, i'],
  ['accept-encoding', 'gzip, deflate, br'],
];

function run(wire: Wire, url = 'https://shop.example.com/', alpn?: string) {
  const headers = new Headers();
  for (const [k, v] of wire) if (!k.startsWith(':')) headers.append(k, v);
  const u = new URL(url);
  return analyzeHeaderShape({
    headers,
    headerOrder: wire.map(([k]) => k),
    isDocument: isDocumentRequest(headers, u),
    secureContext: isSecureContextRequest(u, headers),
    ...(alpn ? { alpn } : {}),
  });
}
const ids = (wire: Wire, url?: string, alpn?: string) => run(wire, url, alpn).map((s) => s.id).sort();

describe('header-shape: HTTP libraries (server-fingerprints.md §3.4)', () => {
  it('python-requests: exact header order, Accept-Encoding literal and no browser headers', () => {
    const sigs = run(SETS['python-requests']!);
    expect(sigs.map((s) => s.id)).toEqual(expect.arrayContaining(['request.header-order-anomaly', 'request.library-accept-encoding', 'request.no-browser-headers']));
    expect(sigs.find((s) => s.id === 'request.header-order-anomaly')!.details?.['library']).toBe('python-requests / urllib3');
  });

  it('httpx: User-Agent last order', () => {
    const order = run(SETS['httpx']!).find((s) => s.id === 'request.header-order-anomaly');
    expect(order?.details?.['library']).toBe('httpx');
  });

  it('Node fetch (undici): accept-language "*", sec-fetch-mode cors without site/dest, undici order', () => {
    const sigs = run(SETS['node-fetch (undici)']!);
    const nb = sigs.find((s) => s.id === 'request.no-browser-headers')!;
    expect(nb.summary).toMatch(/Accept-Language "\*"/);
    expect((nb.details?.['checks'] as string[]).join(' ')).toMatch(/sec-fetch-mode: cors/);
    expect(sigs.find((s) => s.id === 'request.header-order-anomaly')?.details?.['library']).toMatch(/^Node(\.js)? fetch \(undici\)/);
    expect(sigs.map((s) => s.id)).toContain('request.library-accept-encoding');
  });

  it('curl and Go net/http', () => {
    expect(run(SETS['curl']!).find((s) => s.id === 'request.header-order-anomaly')?.details?.['library']).toBe('curl');
    expect(ids(SETS['curl']!)).toContain('request.no-browser-headers');
    const go = run(SETS['go']!);
    expect(go.find((s) => s.id === 'request.library-accept-encoding')?.details?.['library']).toBe('Go net/http / OkHttp');
    expect(go.find((s) => s.id === 'request.header-order-anomaly')?.details?.['library']).toMatch(/^Go net\/http/);
  });

  it('Java HttpClient h2c upgrade on plaintext (settings decoded and matched)', () => {
    const h2c = run(SETS['java h2c upgrade']!, 'http://shop.example.com/').find((s) => s.id === 'request.h2c-upgrade');
    expect(h2c).toBeDefined();
    expect(h2c!.details?.['library']).toMatch(/^Java HttpClient/);
    expect(h2c!.details?.['settings']).toBe('1:16384;2:0;3:0;4:16777216;5:16384;6:393216');
  });

  it('curl_cffi default: no User-Agent, no Accept, "gzip, deflate, br"', () => {
    const nb = run(SETS['curl_cffi default (no UA)']!).find((s) => s.id === 'request.no-browser-headers');
    expect(nb?.details?.['checks']).toEqual(expect.arrayContaining([expect.stringMatching(/curl_cffi/)]));
  });

  it('curl_cffi impersonate=chrome over http: h2c upgrade gives it away, everything else looks like Chrome', () => {
    const sigs = run(CURL_CFFI_CHROME_HTTP, 'http://shop.example.com/');
    const h2c = sigs.find((s) => s.id === 'request.h2c-upgrade');
    expect(h2c?.details?.['impersonation']).toMatch(/^curl_cffi impersonate=chrome/);
    expect(sigs.map((s) => s.id)).not.toContain('request.client-hints-mismatch');
  });

  it('a library header order under a spoofed Chrome UA is caught (order + missing client hints)', () => {
    const spoofed: Wire = [['Host', 'shop.example.com'], ['User-Agent', CHROME_155], ['Accept-Encoding', 'gzip, deflate'], ['Accept', '*/*'], ['Connection', 'keep-alive']];
    const sigs = run(spoofed);
    expect(sigs.find((s) => s.id === 'request.header-order-anomaly')?.reliability).toBe(1);
    expect(sigs.map((s) => s.id)).toEqual(expect.arrayContaining(['request.client-hints-mismatch', 'request.no-browser-headers', 'request.library-accept-encoding']));
  });

  it('flags all-lowercase HTTP/1.1 names under a browser UA (C10)', () => {
    const lower: Wire = CHROME_NAV_H1.map(([k, v]) => [k.toLowerCase(), v]);
    const sigs = run(lower, 'https://shop.example.com/', 'http/1.1');
    expect(sigs.find((s) => s.id === 'request.header-order-anomaly')?.details?.['checks']).toEqual(expect.arrayContaining([expect.stringMatching(/All-lowercase/)]));
  });
});

describe('header-shape: real browsers produce no findings', () => {
  it.each([
    ['Chrome 155 navigation over h2', CHROME_NAV_H2, 'https://shop.example.com/', 'h2'],
    ['Chrome 155 navigation over HTTP/1.1', CHROME_NAV_H1, 'https://shop.example.com/', 'http/1.1'],
    ['Chrome 155 on a plain-http intranet origin', CHROME_NAV_PLAIN_HTTP, 'http://intranet.example.com/', 'http/1.1'],
    ['Chrome Android with referer and cookie', ANDROID_CHROME_H2, 'https://shop.example.com/', 'h2'],
    ['Firefox 147 over HTTP/1.1', FIREFOX_NAV_H1, 'https://shop.example.com/', 'http/1.1'],
    ['Firefox 147 over h2', FIREFOX_NAV_H2, 'https://shop.example.com/', 'h2'],
    ['Safari 26 over h2', SAFARI_NAV_H2, 'https://shop.example.com/', 'h2'],
  ] as const)('%s', (_name, wire, url, alpn) => {
    expect(run(wire as Wire, url, alpn)).toEqual([]);
  });

  it('end-to-end: the analyzer inside createNecter stays silent for a Chrome navigation', async () => {
    const cm = createNecter({ analyzers: [headerShapeAnalyzer()] });
    const headers = new Headers();
    for (const [k, v] of CHROME_NAV_H2) if (!k.startsWith(':')) headers.append(k, v);
    const ins = await cm.inspect(new Request('https://shop.example.com/', { headers }), { headerOrder: CHROME_NAV_H2.map(([k]) => k), tls: { alpn: 'h2' } });
    expect(ins.signals).toEqual([]);
    expect(ins.verdict.actorClass).toBe('human');
  });
});
