import { resolveConfig } from './config.js';
import { createRuntime } from './runtime.js';
import { resolveSession } from './session.js';
import { defaultModules } from './modules.js';
import type { Necter, NecterConfig, Module } from './types.js';
import { BROWSER_SDK_VERSION } from './version.js';

export * from './types.js';
export { resolveConfig } from './config.js';
export { createRuntime } from './runtime.js';
export { defaultModules } from './modules.js';
export { BROWSER_SDK_VERSION };
export { scoreDrag, scoreKeys } from './intervene/challenge.js';

declare global {
  interface Window {
    Necter?: typeof api;
    necter?: Necter;
  }
}

let instance: Necter | undefined;

/**
 * Boot the SDK. Safe to call in SSR (returns a no-op proxy) and idempotent
 * (returns the existing instance).
 */
export function init(config: NecterConfig = {}, modules?: Module[]): Necter {
  if (instance) return instance;
  if (typeof window === 'undefined' || typeof document === 'undefined') return noop();
  const resolved = resolveConfig(config);
  const session = resolveSession(config.sessionId);
  instance = createRuntime({ config: resolved, session, modules: modules ?? defaultModules() });
  window.necter = instance;
  return instance;
}

export function get(): Necter | undefined {
  return instance;
}

export function destroy(): void {
  instance?.destroy();
  instance = undefined;
  if (typeof window !== 'undefined') delete window.necter;
}

function noop(): Necter {
  const resolved = resolveConfig({});
  const verdict = {
    sessionId: 'ssr',
    ts: 0,
    stage: 'load' as const,
    automation: 0,
    score: 0,
    logit: 0,
    actorClass: 'unknown' as const,
    classConfidence: 0,
    classScores: {},
    deterministic: false,
    evidence: [],
    signalCount: 0,
    layers: [],
  };
  return {
    version: BROWSER_SDK_VERSION,
    sessionId: 'ssr',
    config: resolved,
    verdict,
    signals: [],
    on: () => () => undefined,
    evaluate: () => verdict,
    intervene: async () => false,
    challenge: async () => false,
    headers: () => ({}),
    flush: async () => undefined,
    destroy: () => undefined,
  };
}

const api = { init, get, destroy, version: BROWSER_SDK_VERSION };
export default api;

/**
 * Config for the <script> build, read from the tag's data attributes and from its
 * src query string (data attributes win). When the script is served from another
 * origin (a hosted collector) and no endpoint is given, beacons go back to that origin.
 *
 *   <script src="/__necter/script.js" data-necter data-mode="enforce"></script>
 *   <script async src="https://collector.example.com/__necter/script.js?site=shop"></script>
 *
 * Returns undefined when the tag does not ask for auto-init.
 */
export function configFromScript(script: { src?: string; dataset: DOMStringMap }, pageOrigin: string): NecterConfig | undefined {
  const d = script.dataset;
  let src: URL | undefined;
  try {
    if (script.src) src = new URL(script.src, pageOrigin);
  } catch {
    src = undefined;
  }
  const q = src?.searchParams;
  const pick = (key: string, param = key): string | undefined => d[key] ?? q?.get(param) ?? undefined;
  const site = d['siteKey'] ?? d['site'] ?? q?.get('site') ?? undefined;
  if (d['necter'] === undefined && !site && !q?.has('necter')) return undefined;
  const cfg: NecterConfig = {};
  const mode = pick('mode');
  if (mode === 'enforce' || mode === 'monitor') cfg.mode = mode;
  if (site) cfg.siteKey = site;
  const debug = pick('debug');
  if (debug !== undefined) cfg.debug = debug !== 'false' && debug !== '0';
  const trusted = (pick('trusted') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const sensitive = pick('sensitive');
  if (sensitive) cfg.sensitiveSelectors = sensitive.split(',').map((s) => s.trim()).filter(Boolean);
  const endpoint = pick('endpoint');
  const crossOrigin = src && /^https?:$/.test(src.protocol) && src.origin !== pageOrigin;
  // Served by a necter collector or server (…/__necter/script.js) rather than a public CDN.
  const fromCollector = crossOrigin && /\/__necter\/script\.js$/.test(src!.pathname);
  if (endpoint) cfg.endpoint = endpoint;
  else if (fromCollector) cfg.endpoint = `${src!.origin}/__necter`;
  if (fromCollector) {
    // Our own script's origin is not the page's, so tell the stack attribution it is ours.
    trusted.push(src!.origin);
    cfg.text = { gatewayUrl: `${src!.origin}/.well-known/agent-access` };
  } else if (crossOrigin) {
    // Public CDN (jsDelivr, unpkg): trust only this package's folder, never the whole CDN.
    trusted.push(src!.href.slice(0, src!.href.lastIndexOf('/') + 1).split('?')[0]!);
  }
  if (trusted.length) cfg.trustedScriptOrigins = trusted;
  return cfg;
}

if (typeof document !== 'undefined') {
  const script = document.currentScript as HTMLScriptElement | null;
  if (script) {
    const cfg = configFromScript(script, typeof location !== 'undefined' ? location.origin : '');
    if (cfg) init(cfg);
  }
}
