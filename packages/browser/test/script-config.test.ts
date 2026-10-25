import { describe, expect, it } from 'vitest';
import { configFromScript } from '../src/index.js';

const page = 'https://shop.example';

describe('configFromScript', () => {
  it('ignores tags that do not ask for auto-init', () => {
    expect(configFromScript({ src: `${page}/vendor.js`, dataset: {} }, page)).toBeUndefined();
  });

  it('keeps same-origin installs on the relative endpoint', () => {
    const cfg = configFromScript({ src: `${page}/__necter/script.js`, dataset: { necter: '', mode: 'enforce' } }, page)!;
    expect(cfg.mode).toBe('enforce');
    expect(cfg.endpoint).toBeUndefined();
    expect(cfg.trustedScriptOrigins).toBeUndefined();
  });

  it('points a hosted install back at the collector, configured from the query string', () => {
    const cfg = configFromScript({ src: 'https://collector.example/__necter/script.js?site=shop&mode=monitor&debug=1', dataset: {} }, page)!;
    expect(cfg.siteKey).toBe('shop');
    expect(cfg.mode).toBe('monitor');
    expect(cfg.debug).toBe(true);
    expect(cfg.endpoint).toBe('https://collector.example/__necter');
    expect(cfg.trustedScriptOrigins).toContain('https://collector.example');
    expect(cfg.text?.gatewayUrl).toBe('https://collector.example/.well-known/agent-access');
  });

  it('loaded from a public CDN, beacons stay on the page origin and only the package folder is trusted', () => {
    const cfg = configFromScript({ src: 'https://cdn.jsdelivr.net/npm/@necterai/browser@0.1.0/dist/necter.iife.js', dataset: { necter: '' } }, page)!;
    expect(cfg.endpoint).toBeUndefined();
    expect(cfg.trustedScriptOrigins).toEqual(['https://cdn.jsdelivr.net/npm/@necterai/browser@0.1.0/dist/']);
    expect(cfg.text).toBeUndefined();
  });

  it('a CDN install can send beacons to a collector with data-endpoint', () => {
    const cfg = configFromScript({ src: 'https://unpkg.com/@necterai/browser/dist/necter.iife.js', dataset: { site: 'shop', endpoint: 'https://collector.example/__necter' } }, page)!;
    expect(cfg.endpoint).toBe('https://collector.example/__necter');
    expect(cfg.siteKey).toBe('shop');
  });

  it('lets data attributes override the query string and an explicit endpoint win', () => {
    const cfg = configFromScript({ src: 'https://collector.example/__necter/script.js?site=a&mode=monitor', dataset: { site: 'b', mode: 'enforce', endpoint: '/custom' } }, page)!;
    expect(cfg.siteKey).toBe('b');
    expect(cfg.mode).toBe('enforce');
    expect(cfg.endpoint).toBe('/custom');
  });
});
