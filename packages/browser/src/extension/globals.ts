import { KNOWN_AGENT_DRIVERS } from './known-extensions.js';

/**
 * Main-world residue left by agent drivers (extension-agents.md 4.2, 9.7, 11).
 *
 * - OpenAI Codex browser driver: `Runtime.addBinding {name:"__browserUseClipboard_<32hex>"}` +
 *   `Page.addScriptToEvaluateOnNewDocument` (no worldName -> main world) installs
 *   `globalThis.__browserUseClipboardBridge` ({bindingName, respond(), cleanup()});
 *   its WebMCP discovery caches state on `document.__codexNativeWebMcpState`.
 * - Cursor Browser Automation: `Runtime.evaluate` injections set
 *   `window.__cursorBrowserAutomationInjected = true`, `window.__cursorAreaScreenshotInjected`,
 *   `window.__cursorAreaScreenshotCommand` and tag elements with `data-cursor-ref="e<N>"`.
 *
 * Claude in Chrome's `__claudeElementMap` etc. live in the isolated world and are
 * deliberately NOT probed (measured `typeof window.__claudeElementMap === 'undefined'`).
 */

export interface GlobalHit {
  key: string;
  where: 'window' | 'document' | 'dom';
  driver: keyof typeof KNOWN_AGENT_DRIVERS;
  kind: string;
}

type AnyRecord = Record<string, unknown>;

const WINDOW_EXACT: Array<{ key: string; driver: GlobalHit['driver']; kind: string; type?: string }> = [
  { key: '__browserUseClipboardBridge', driver: 'codex', kind: 'clipboard bridge object', type: 'object' },
  { key: '__cursorBrowserAutomationInjected', driver: 'cursor', kind: 'injection flag' },
  { key: '__cursorAreaScreenshotInjected', driver: 'cursor', kind: 'injection flag' },
  { key: '__cursorAreaScreenshotCommand', driver: 'cursor', kind: 'injection flag' },
];

const WINDOW_PREFIX: Array<{ prefix: string; driver: GlobalHit['driver']; kind: string }> = [
  { prefix: '__browserUseClipboard_', driver: 'codex', kind: 'Runtime.addBinding function' },
];

const DOCUMENT_EXACT: Array<{ key: string; driver: GlobalHit['driver']; kind: string }> = [
  { key: '__codexNativeWebMcpState', driver: 'codex', kind: 'WebMCP discovery state' },
];

export function scanMainWorldGlobals(win: unknown = typeof window !== 'undefined' ? window : undefined, doc: unknown = typeof document !== 'undefined' ? document : undefined): GlobalHit[] {
  const hits: GlobalHit[] = [];
  try {
    const w = win as AnyRecord | undefined;
    if (w) {
      for (const probe of WINDOW_EXACT) {
        try {
          const v = w[probe.key];
          if (v === undefined || v === null) continue;
          if (probe.type && typeof v !== probe.type) continue;
          hits.push({ key: probe.key, where: 'window', driver: probe.driver, kind: probe.kind });
        } catch {
          /* getter threw; skip */
        }
      }
      let names: string[] = [];
      try {
        names = Object.getOwnPropertyNames(w);
      } catch {
        names = [];
      }
      for (const name of names) {
        for (const probe of WINDOW_PREFIX) {
          if (name.startsWith(probe.prefix) && !hits.some((h) => h.key === name)) {
            hits.push({ key: name, where: 'window', driver: probe.driver, kind: probe.kind });
          }
        }
      }
    }
    const d = doc as AnyRecord | undefined;
    if (d) {
      for (const probe of DOCUMENT_EXACT) {
        try {
          if (d[probe.key] !== undefined) hits.push({ key: probe.key, where: 'document', driver: probe.driver, kind: probe.kind });
        } catch {
          /* ignore */
        }
      }
      try {
        const qs = (d as unknown as Document).querySelector;
        if (typeof qs === 'function') {
          const el = (d as unknown as Document).querySelector('[data-cursor-ref]');
          if (el) hits.push({ key: `[data-cursor-ref="${el.getAttribute('data-cursor-ref') ?? ''}"]`, where: 'dom', driver: 'cursor', kind: 'element ref attribute' });
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* never throw */
  }
  return hits;
}

/** Scan schedule in ms from module start: synchronous, 1 s, 5 s, then idle ticks every 5 s until 30 s. */
export const GLOBAL_SCAN_SCHEDULE_MS: readonly number[] = [0, 1000, 5000, 10000, 15000, 20000, 25000, 30000];

export function describeGlobalHit(hit: GlobalHit): string {
  const driver = KNOWN_AGENT_DRIVERS[hit.driver];
  const where = hit.where === 'window' ? 'globalThis.' : hit.where === 'document' ? 'document.' : '';
  return `${where}${hit.key} present in the main world (${hit.kind}, ${driver.product}).`;
}
