import type { RequestAnalyzer } from '../types.js';

/**
 * Cross-request behaviour of the same client (ip + UA): JavaScript execution
 * tie, cookie persistence and crawl shape. These are the signals that catch
 * fetch agents that copy a browser's headers perfectly.
 */
export function clientPatternAnalyzer(): RequestAnalyzer {
  return {
    name: 'client-pattern',
    analyze(ctx, api) {
      const c = api.client;
      const grace = api.options.noJsGraceMs;
      const age = ctx.now - c.firstSeenAt;
      const claimsBrowser = /Mozilla\/5\.0/.test(ctx.headers.get('user-agent') ?? '');

      // Served HTML before, never saw the SDK beacon, had time to run it.
      if (c.documents >= 1 && c.beacons === 0 && age > grace && (c.documents >= 2 || c.assets === 0)) {
        api.emit({
          id: 'tie.no-js-execution',
          summary: `${c.documents} HTML document(s) served, 0 SDK beacons after ${Math.round(age / 1000)}s`,
          value: { documents: c.documents, assets: c.assets, ageMs: age },
          reliability: claimsBrowser ? 1 : 0.8,
        });
      }
      if (c.documents >= 2 && c.assets === 0 && claimsBrowser) {
        api.emit({ id: 'request.html-without-assets', summary: `${c.documents} documents fetched with no subresources`, value: { documents: c.documents } });
      }
      // Several navigations that never return the cookie we set, and never a single return: a
      // cookie-less client. NATed offices share ip+UA, so returns from anyone in the group clear it.
      if (c.cookieMisses >= 3 && c.cookieReturns === 0) {
        api.emit({ id: 'request.no-cookie-persistence', summary: `${c.cookieMisses} navigations ignored the session cookie`, value: { misses: c.cookieMisses }, reliability: Math.min(1, 0.6 + 0.1 * c.cookieMisses) });
      }
      const crawlish = (c.robotsTxt > 0 || c.sitemap > 0) && c.documents >= 3 && c.assets === 0 && c.beacons === 0;
      const breadth = c.paths.length >= 8 && c.assets === 0 && c.beacons === 0;
      if (crawlish || breadth) {
        const ua = ctx.headers.get('user-agent') ?? '';
        // Perplexity's documented undeclared crawler: a frozen macOS Chrome/124 UA that never runs JS
        // (Cloudflare, 2025-08-04; docs/research/raw/server-fingerprints.md section 11).
        const perplexityStealth = /Macintosh; Intel Mac OS X 10_15_7\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/124\.0\.0\.0 Safari\/537\.36$/.test(ua);
        api.emit({
          id: 'request.crawl-pattern',
          summary: crawlish ? `robots/sitemap fetched then ${c.documents} documents without assets or JS` : `${c.paths.length} distinct paths, no assets, no JS`,
          value: { paths: c.paths.length, robots: c.robotsTxt, sitemap: c.sitemap, documents: c.documents },
          ...(perplexityStealth ? { provider: { id: 'perplexity', product: 'undeclared crawler (Chrome/124 profile)', confidence: 0.3 } } : {}),
        });
      }
    },
  };
}
