/**
 * probes module: active automation-leak probes (detection-spec.md §2).
 *
 * Wiring and schedule (everything wrapped in try/catch; a failing probe emits nothing):
 * - residue globals + `<html>` WebDriver attributes + Runtime.addBinding-shaped functions:
 *   at start, 1 s, 5 s, and on an idle tick every ~2 s for 30 s (diffed against the
 *   start baseline; the start scan matches the baseline too because init scripts run first);
 * - impossible window geometry (`probe.viewport-override`): at start and 1 s;
 * - Runtime.enable console-serialisation leak (V8 only, native console only): at start
 *   and every 3 s for 30 s; when it fires, one `debugger;` timing check separates an open
 *   DevTools (`probe.devtools-open`, informational, leak suppressed) from a CDP client;
 * - debugger-infobar resize burst (`probe.debugger-attached`): `resize` listener for
 *   the page lifetime, judged ~100 ms after the burst settles;
 * - DOM artifacts of agent frameworks: initial sweep + MutationObserver on `<html>`;
 * - stack markers (`probe.automation-stack-frame`): sampled through the shared harvest
 *   instrumentation (no second set of wrappers);
 * - tamper + fresh-realm comparison: once at idle.
 *
 * `stop()` removes listeners, the observer and timers and releases the shared
 * instrumentation (prototypes are restored when the last holder releases).
 */

import type { ProviderHint, SignalInput } from '@necterai/core';
import type { Module, ModuleContext } from '../types.js';
import { claimAutomationReport, getOriginalToString, quiet, type ReadKind } from '../harvest/instrument.js';
import { DEVTOOLS_PAUSE_THRESHOLD_MS, consoleIsNative, isV8, judgeLeak, measureDebuggerPause, runLeakProbe, type ConsoleLike } from './cdp-leak.js';
import { definitions } from './definitions.js';
import { DomArtifactAggregator, OBSERVED_ATTRIBUTES, matchesFromMutations, sweepDocument, type DomArtifactMatch } from './dom-artifacts.js';
import { checkViewportOverride, readGeometry } from './geometry.js';
import { createGlobalsReportState, globalsToSignals, scanGlobals, snapshotGlobals } from './globals.js';
import { ResizeBurstDetector, type BurstDetection, type ResizeSample } from './infobar.js';
import { startStackMarkerProbe, type StackMarkerProbe } from './stack-markers.js';
import {
  checkTarget,
  checkToStringIntegrity,
  defaultTamperTargets,
  diffRealms,
  openFreshRealm,
  readRealmValues,
  type FreshRealm,
  type RealmValues,
  type TamperFinding,
  type TamperTarget,
} from './tamper.js';
import { NATIVE_FUNCTION_TO_STRING, isChromiumUA, listSummary } from './util.js';

export { definitions } from './definitions.js';
export * from './cdp-leak.js';
export * from './dom-artifacts.js';
export * from './geometry.js';
export * from './globals.js';
export * from './infobar.js';
export * from './known-globals.js';
export * from './stack-markers.js';
export * from './tamper.js';

/** Injection points for tests and exotic hosts; every field is optional. */
export interface ProbesModuleDeps {
  win?: Window & typeof globalThis;
  doc?: Document;
  console?: ConsoleLike;
  perfNow?: () => number;
  random?: () => number;
  /** V8 check (default: page-installed Error.prepareStackTrace is honoured). */
  isV8?: () => boolean;
  measureDebuggerPause?: () => number;
  /** Is `console.debug` the engine's own (default: native toString)? */
  consoleCheck?: (con: ConsoleLike) => boolean;
  /** Tamper targets (jsdom's navigator getters are JS, not native). */
  tamperTargets?: () => TamperTarget[];
  openFreshRealm?: (doc: Document) => FreshRealm | undefined;
  readMainRealm?: () => RealmValues;
}

/** `config.modules.probes` options. Every probe defaults to on. */
export interface ProbesModuleOptions {
  globals?: boolean;
  geometry?: boolean;
  leak?: boolean;
  infobar?: boolean;
  domArtifacts?: boolean;
  stackMarkers?: boolean;
  tamper?: boolean;
  /** How long the repeating probes (globals, leak) keep running (default 30000 ms). */
  probeWindowMs?: number;
}

const API_LABEL: Partial<Record<ReadKind, string>> = {
  rect: 'Element.getBoundingClientRect',
  rects: 'Element.getClientRects',
  visibility: 'Element.checkVisibility',
  style: 'getComputedStyle',
  innerText: 'HTMLElement.innerText',
  textContent: 'Node.textContent',
  qsa: 'querySelectorAll',
  treeWalker: 'Document.createTreeWalker',
  elementFromPoint: 'Document.elementFromPoint',
  attrNames: 'Element.getAttributeNames',
};

const DETERMINISTIC = 6;

export function createProbesModule(deps: ProbesModuleDeps = {}): Module {
  let disposers: (() => void)[] = [];

  return {
    name: 'probes',
    start(ctx: ModuleContext) {
      const win = deps.win ?? (typeof window !== 'undefined' ? (window as Window & typeof globalThis) : undefined);
      const doc = deps.doc ?? (typeof document !== 'undefined' ? document : undefined);
      if (!win || !doc) return;
      try {
        ctx.registry.registerAll(definitions);
      } catch {
        /* registry is optional in exotic hosts */
      }
      const opts = (ctx.options ?? {}) as ProbesModuleOptions;
      const enabled = (k: keyof ProbesModuleOptions): boolean => opts[k] !== false;
      const windowMs = typeof opts.probeWindowMs === 'number' && opts.probeWindowMs > 0 ? opts.probeWindowMs : 30_000;
      const perfNow =
        deps.perfNow ??
        (() => {
          try {
            return performance.now();
          } catch {
            return Date.now();
          }
        });
      const startedAt = perfNow();
      const trustedScriptOrigins = ctx.config?.trustedScriptOrigins;
      const ua = (() => {
        try {
          return String(win.navigator?.userAgent ?? '');
        } catch {
          return '';
        }
      })();

      const safe = (fn: () => void): void => {
        try {
          fn();
        } catch (err) {
          try {
            ctx.log('probe failed', err);
          } catch {
            /* ignore */
          }
        }
      };
      const later = (fn: () => void, ms: number): void => {
        disposers.push(ctx.schedule.timeout(() => safe(fn), ms));
      };
      const idle = (fn: () => void, timeoutMs: number): void => {
        disposers.push(ctx.schedule.idle(() => safe(fn), timeoutMs));
      };
      const on = (target: EventTarget, type: string, handler: (e: Event) => void): void => {
        const wrapped = (e: Event): void => safe(() => handler(e));
        const o: AddEventListenerOptions = { passive: true, capture: true };
        target.addEventListener(type, wrapped, o);
        disposers.push(() => target.removeEventListener(type, wrapped, o));
      };
      /**
       * Emit; a partial observation of a deterministic id (8 x 0.5) is converted to an
       * explicit weight below the deterministic threshold so nothing finalises on it.
       */
      const emit = (input: SignalInput): void =>
        safe(() => {
          const def = ctx.registry?.get(input.id);
          const rel = input.reliability;
          if (def && rel !== undefined && rel < 1 && input.automation === undefined && Math.abs(def.automation) >= DETERMINISTIC && Math.abs(def.automation * rel) < DETERMINISTIC) {
            const { reliability: _drop, ...rest } = input;
            input = { ...rest, automation: Math.round(def.automation * rel * 100) / 100, details: { ...(rest.details ?? {}), reliability: rel } };
          }
          ctx.emit(input);
        });
      const privacyMode = (): boolean => {
        try {
          const ev = ctx.verdict()?.evidence;
          return Array.isArray(ev) && ev.some((e) => e.signalId === 'consistency.privacy-browser-mode');
        } catch {
          return false;
        }
      };

      // ── residue globals ──────────────────────────────────────────────────
      if (enabled('globals')) {
        safe(() => {
          const baseline = snapshotGlobals(win as unknown as Record<string, unknown>);
          const state = createGlobalsReportState();
          let first = true;
          const scan = (): void => {
            const result = scanGlobals(
              { win: win as unknown as Record<string, unknown>, doc: doc as unknown as Record<string, unknown> & { documentElement?: Element | null }, nativeToString: NATIVE_FUNCTION_TO_STRING },
              baseline,
              { matchBaseline: first },
            );
            first = false;
            for (const n of result.added) baseline.add(n);
            for (const s of globalsToSignals(result, state)) emit(s);
          };
          quiet(scan);
          later(() => quiet(scan), 1000);
          later(() => quiet(scan), 5000);
          const idleLoop = (): void => {
            if (perfNow() - startedAt > windowMs) return;
            idle(() => {
              quiet(scan);
              later(idleLoop, 2000);
            }, 2000);
          };
          idleLoop();
        });
      }

      // ── impossible geometry ──────────────────────────────────────────────
      if (enabled('geometry')) {
        let lastGeometry = '';
        const geometry = (): void => {
          const input = checkViewportOverride(readGeometry(win));
          if (!input) return;
          const key = `${input.summary}|${input.reliability ?? 1}`;
          if (key === lastGeometry) return;
          lastGeometry = key;
          emit(input);
        };
        safe(geometry);
        later(geometry, 1000);
      }

      // ── Runtime.enable console leak ──────────────────────────────────────
      if (enabled('leak')) {
        safe(() => {
          const con = deps.console ?? (win.console as unknown as ConsoleLike | undefined);
          if (!con || typeof con.debug !== 'function') return;
          if (!(deps.isV8 ?? (() => isV8(win.Error)))()) return;
          let done = false;
          let stopLoop: (() => void) | undefined;
          const finish = (): void => {
            done = true;
            stopLoop?.();
            stopLoop = undefined;
          };
          const round = (): void => {
            if (done) return;
            if (perfNow() - startedAt > windowMs + 100) return finish();
            if (!(deps.consoleCheck ?? consoleIsNative)(con)) {
              ctx.log('console.debug is wrapped by the page; Runtime.enable leak probe skipped');
              return finish();
            }
            const counters = runLeakProbe({ console: con, errorCtor: win.Error });
            const verdict = judgeLeak(counters);
            if (!verdict.leaked) return;
            finish();
            // One debugger; timing check, only now: DevTools (Debugger domain) blocks, drivers do not.
            const pause = (deps.measureDebuggerPause ?? (() => measureDebuggerPause(perfNow)))();
            const rounded = Math.round(pause);
            if (pause >= DEVTOOLS_PAUSE_THRESHOLD_MS) {
              emit({
                id: 'probe.devtools-open',
                summary: `debugger; statement blocked ${rounded} ms after the console probe fired (${verdict.channels.join(', ')}): DevTools open, CDP leak not scored`,
                value: rounded,
                details: { channels: verdict.channels, pauseMs: rounded, counters },
              });
              return;
            }
            emit({
              id: 'probe.cdp-runtime-leak',
              summary: `console.debug argument serialised by a CDP client: ${verdict.channels.join(', ')} (baseline 1x name / 1x message / 0 prepareStackTrace); debugger; took ${rounded} ms`,
              value: verdict.channels,
              details: { counters, pauseMs: rounded, legacyOnly: verdict.reliability < 1 },
              ...(verdict.reliability < 1 ? { reliability: verdict.reliability } : {}),
            });
          };
          round();
          if (!done) {
            stopLoop = ctx.schedule.every(() => safe(round), 3000);
            disposers.push(() => stopLoop?.());
            later(finish, windowMs + 50);
          }
        });
      }

      // ── debugger infobar resize burst ────────────────────────────────────
      if (enabled('infobar')) {
        safe(() => {
          const detector = new ResizeBurstDetector();
          const sample = (): ResizeSample => ({ t: perfNow(), innerHeight: win.innerHeight, innerWidth: win.innerWidth, outerHeight: win.outerHeight });
          detector.prime(sample());
          let settleTimer: (() => void) | undefined;
          let appeared: { at: number; d: BurstDetection } | undefined;
          const describe = (d: BurstDetection): string =>
            `${d.steps} resize events in ${Math.round(d.durationMs)} ms: innerHeight ${d.fromHeight} -> ${d.toHeight} (${d.deltaTotal > 0 ? '+' : ''}${d.deltaTotal} px in 2-5 px steps) with innerWidth ${d.innerWidth} and outerHeight ${d.outerHeight} constant`;
          const settle = (): void => {
            const d = detector.settle();
            if (!d) return;
            const details = { steps: d.steps, deltaTotal: d.deltaTotal, durationMs: Math.round(d.durationMs), innerWidth: d.innerWidth, outerHeight: d.outerHeight, from: d.fromHeight, to: d.toHeight };
            if (d.kind === 'appeared') {
              appeared = { at: perfNow(), d };
              emit({
                id: 'probe.debugger-attached',
                summary: `${describe(d)}: Chrome's "started debugging this browser" infobar appeared (chrome.debugger attach)`,
                value: d.deltaTotal,
                details: { kind: 'appeared', ...details },
              });
              return;
            }
            if (appeared) {
              const afterS = Math.round((perfNow() - appeared.at) / 100) / 10;
              const a = appeared.d;
              emit({
                id: 'probe.debugger-attached',
                summary: `${describe(a)}: debugger infobar appeared, then closed again after ${afterS} s (${d.deltaTotal > 0 ? '+' : ''}${d.deltaTotal} px; ${afterS >= 5 ? 'debugger detached' : 'bar dismissed early'})`,
                value: a.deltaTotal,
                details: { kind: 'appeared', steps: a.steps, deltaTotal: a.deltaTotal, durationMs: Math.round(a.durationMs), innerWidth: a.innerWidth, outerHeight: a.outerHeight, closed: { kind: 'closed', afterS, ...details } },
              });
              appeared = undefined;
              return;
            }
            emit({
              id: 'probe.debugger-attached',
              summary: `${describe(d)}: an infobar that was already open when the SDK loaded animated closed (debugger detached?)`,
              value: d.deltaTotal,
              reliability: 0.5,
              details: { kind: 'closed', ...details },
            });
          };
          on(win, 'resize', () => {
            // Hidden tabs do not animate the bar; their single catch-up resize is not a burst.
            if (doc.visibilityState === 'hidden') return;
            detector.push(sample());
            settleTimer?.();
            settleTimer = ctx.schedule.timeout(() => safe(settle), 100);
          });
          disposers.push(() => settleTimer?.());
        });
      }

      // ── agent-framework DOM artifacts ────────────────────────────────────
      if (enabled('domArtifacts')) {
        safe(() => {
          const agg = new DomArtifactAggregator();
          const lastKey = new Map<string, string>();
          const handle = (matches: DomArtifactMatch[]): void => {
            for (const m of matches) {
              const input = agg.add(m);
              if (!input) continue;
              const key = `${(input.value as string[]).join('|')}|${input.reliability ?? 1}`;
              if (lastKey.get(input.id) === key) continue;
              lastKey.set(input.id, key);
              emit(input);
            }
          };
          handle(quiet(() => sweepDocument(doc)));
          const root = doc.documentElement;
          const MO = (win as unknown as { MutationObserver?: typeof MutationObserver }).MutationObserver;
          if (root && typeof MO === 'function') {
            const mo = new MO((records) => safe(() => handle(quiet(() => matchesFromMutations(records)))));
            mo.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: OBSERVED_ATTRIBUTES });
            disposers.push(() => mo.disconnect());
          }
        });
      }

      // ── stack markers (shared instrumentation) ───────────────────────────
      if (enabled('stackMarkers')) {
        safe(() => {
          const probe: StackMarkerProbe = startStackMarkerProbe({
            ...(trustedScriptOrigins ? { trustedScriptOrigins } : {}),
            ...(deps.random ? { random: deps.random } : {}),
            now: perfNow,
            onHit: (hit) => {
              if (!claimAutomationReport()) return;
              const api = API_LABEL[hit.target] ?? hit.target;
              const input: SignalInput = {
                id: 'probe.automation-stack-frame',
                summary: `${api} called from an automation evaluation frame (${hit.markers.join(', ')}): ${hit.frame}`,
                value: hit.markers,
                details: { api, frame: hit.frame },
              };
              if (hit.provider) input.provider = hit.provider;
              emit(input);
            },
          });
          disposers.push(() => probe.stop());
        });
      }

      // ── tamper / fresh realm (idle) ──────────────────────────────────────
      if (enabled('tamper')) {
        idle(() => {
          const realm = (deps.openFreshRealm ?? openFreshRealm)(doc);
          const nativeToString = realm?.toString ?? NATIVE_FUNCTION_TO_STRING;
          const targets = deps.tamperTargets?.() ?? defaultTamperTargets(win, { chromium: isChromiumUA(ua) });
          const findings: TamperFinding[] = [];
          for (const t of targets) findings.push(...checkTarget(t, { nativeToString }));
          findings.push(...checkToStringIntegrity(getOriginalToString(), nativeToString));
          const reliability = privacyMode() ? 0.3 : 1;
          if (findings.length) {
            const labels = [...new Set(findings.map((f) => f.label))];
            const first = findings[0]!;
            emit({
              id: 'probe.prototype-tampered',
              summary: `${labels.length} native API${labels.length === 1 ? '' : 's'} replaced: ${listSummary(labels)} (${first.tell}: ${first.detail})`,
              value: labels,
              details: { findings: findings.slice(0, 12), freshRealm: !!realm },
              ...(reliability < 1 ? { reliability } : {}),
              ...(stealthHint(findings) ? { provider: stealthHint(findings)! } : {}),
            });
          }
          if (!realm) return;
          const main = (deps.readMainRealm ?? (() => readRealmValues(win.navigator)))();
          const keys: string[] = diffRealms(main, realm.values);
          if (realm.windowIsParent) keys.push('contentWindow');
          if (!keys.length) return;
          const pairs = keys.map((k) => (k === 'contentWindow' ? 'iframe.contentWindow returns the parent window' : `${k} ${fmt(main[k as keyof RealmValues])} vs ${fmt(realm.values[k as keyof RealmValues])}`));
          emit({
            id: 'probe.fresh-realm-mismatch',
            summary: `main realm differs from a fresh iframe realm: ${listSummary(pairs, 3)}`,
            value: keys,
            details: {
              main: Object.fromEntries(keys.filter((k) => k !== 'contentWindow').map((k) => [k, main[k as keyof RealmValues]])),
              fresh: Object.fromEntries(keys.filter((k) => k !== 'contentWindow').map((k) => [k, realm.values[k as keyof RealmValues]])),
            },
            ...(reliability < 1 ? { reliability } : {}),
          });
        }, 3000);
      }

      ctx.log('probes active');
    },
    stop() {
      const list = disposers;
      disposers = [];
      for (const d of list.reverse()) {
        try {
          d();
        } catch {
          /* ignore */
        }
      }
    },
  };
}

function fmt(v: unknown): string {
  const s = typeof v === 'string' ? JSON.stringify(v) : String(v);
  return s.length > 40 ? s.slice(0, 37) + '...' : s;
}

/** puppeteer-extra-stealth replaces exactly these getters; attribute only when its signature set is hit. */
function stealthHint(findings: readonly TamperFinding[]): ProviderHint | undefined {
  const labels = new Set(findings.map((f) => f.label));
  const stealthy = ['navigator.webdriver', 'navigator.plugins', 'navigator.languages', 'navigator.hardwareConcurrency', 'WebGLRenderingContext.prototype.getParameter'].filter((l) => labels.has(l));
  return stealthy.length >= 2 ? { id: 'puppeteer', product: 'puppeteer-extra-plugin-stealth (or a similar evasion kit)', confidence: 0.4 } : undefined;
}
