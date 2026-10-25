import type { ProviderHint, SignalInput } from '@necterai/core';
import type { Module, ModuleContext } from '../types.js';
import {
  CLAUDE_MESSAGE_TYPES,
  KNOWN_AGENT_DRIVERS,
  KNOWN_AGENT_EXTENSIONS,
  KNOWN_EXTENSIONS_TABLE_VERSION,
  resourceProbeTargets,
  type AgentExtensionEntry,
} from './known-extensions.js';
import { probeResources, summariseHits, type WarProbeDeps } from './war-probe.js';
import {
  classifyAddedNode,
  classifyArtifactNode,
  classifyMessageEvent,
  defaultDomDeps,
  probeCometStylesheet,
  scanExistingArtifacts,
  scanExistingIndicators,
  type ArtifactMatch,
  type DomDeps,
  type DomMatch,
  type FrameState,
  type IndicatorMatch,
} from './indicator.js';
import { GLOBAL_SCAN_SCHEDULE_MS, describeGlobalHit, scanMainWorldGlobals, type GlobalHit } from './globals.js';
import {
  HIDDEN_INPUT_EVENT_TYPES,
  createHiddenInputState,
  describeHiddenInput,
  evaluateFocusEmulation,
  hiddenInputReached,
  recordHiddenInput,
  type FocusEvidence,
  type HiddenInputState,
} from './input.js';
import { describeAssistantMarkers, matchAgenticBrands, matchEdgeCopilotArtifacts, scanAssistantMarkers } from './assistants.js';

export * from './known-extensions.js';
export * from './war-probe.js';
export * from './indicator.js';
export * from './globals.js';
export * from './input.js';
export * from './assistants.js';

interface UaBrand {
  brand: string;
  version: string;
}

/** Injection points for tests and exotic hosts; every field is optional. */
export interface ExtensionModuleDeps {
  win?: Window;
  doc?: Document;
  dom?: DomDeps;
  war?: WarProbeDeps;
  hasFocus?: () => boolean;
  visibilityState?: () => string;
  prerendering?: () => boolean;
  brands?: () => UaBrand[] | undefined;
  perfNow?: () => number;
  table?: readonly AgentExtensionEntry[];
  /** Trust check for input events (jsdom cannot dispatch trusted events). */
  isTrusted?: (e: Event) => boolean;
}

export interface ExtensionModuleOptions {
  /** Run the web-accessible-resource probes (default true). */
  warProbe?: boolean;
  /** Run the passive Comet stylesheet probe (default true). */
  cometProbe?: boolean;
  /** Trusted events while hidden before `extension.hidden-tab-input` fires (default 2). */
  hiddenInputThreshold?: number;
  /** Grace window after a tab becomes hidden (default 100 ms). */
  hiddenInputGraceMs?: number;
}

function providerFor(driver: keyof typeof KNOWN_AGENT_DRIVERS): ProviderHint {
  const d = KNOWN_AGENT_DRIVERS[driver];
  return { id: d.provider, product: d.product, confidence: d.confidence };
}

/**
 * Extension / agentic-browser module. Everything is passive or idle-scheduled,
 * wrapped in try/catch, and CSP-safe (no inline script/style text).
 */
export function createExtensionModule(deps: ExtensionModuleDeps = {}): Module {
  let disposers: Array<() => void> = [];
  let observer: MutationObserver | undefined;

  return {
    name: 'extension',
    start(ctx: ModuleContext) {
      const win = deps.win ?? (typeof window !== 'undefined' ? window : undefined);
      const doc = deps.doc ?? (typeof document !== 'undefined' ? document : undefined);
      if (!win || !doc) return;
      const opts = ctx.options as ExtensionModuleOptions;
      const dom = deps.dom ?? defaultDomDeps(win);
      const perfNow = deps.perfNow ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
      const visibilityState = deps.visibilityState ?? (() => doc.visibilityState);
      const prerendering = deps.prerendering ?? (() => (doc as Document & { prerendering?: boolean }).prerendering === true);
      const hasFocus = deps.hasFocus ?? (() => {
        try {
          return doc.hasFocus();
        } catch {
          return false;
        }
      });
      const brands = deps.brands ?? (() => (win.navigator as Navigator & { userAgentData?: { brands?: UaBrand[] } }).userAgentData?.brands);
      const isTrusted = deps.isTrusted ?? ((e: Event) => e.isTrusted);
      const startedAt = perfNow();
      const emitted = new Set<string>();
      const safe = (fn: () => void) => {
        try {
          fn();
        } catch (err) {
          ctx.log('extension probe failed', err);
        }
      };
      const emit = (input: SignalInput) => safe(() => void ctx.emit(input));
      const on = (target: EventTarget, type: string, handler: (e: Event) => void, options?: AddEventListenerOptions) => {
        const wrapped = (e: Event) => safe(() => handler(e));
        target.addEventListener(type, wrapped, options ?? { passive: true });
        disposers.push(() => target.removeEventListener(type, wrapped, options ?? { passive: true }));
      };

      // ── visibility / focus bookkeeping ───────────────────────────────────
      let lastVisibleAt: number | undefined = visibilityState() === 'visible' ? startedAt : undefined;
      const hidden: HiddenInputState = createHiddenInputState();
      if (visibilityState() === 'hidden') hidden.hiddenSince = startedAt;
      const focusEvidence: FocusEvidence = { sawFocus: false, sawPageshow: false, startedAfterLoad: doc.readyState === 'complete' };
      const hiddenOpts = { threshold: opts.hiddenInputThreshold ?? 2, graceMs: opts.hiddenInputGraceMs ?? 100 };
      let nextHiddenEmitAt = hiddenOpts.threshold;

      const checkFocusEmulation = (reason: string) => {
        const v = evaluateFocusEmulation(hasFocus(), visibilityState(), focusEvidence, perfNow() - startedAt);
        if (!v.fire) return;
        const key = `focus:${v.rule}`;
        if (emitted.has(key)) return;
        emitted.add(key);
        emit({ id: 'extension.focus-emulation', summary: v.summary, reliability: v.reliability, details: { rule: v.rule, reason } });
      };

      on(doc, 'visibilitychange', () => {
        const state = visibilityState();
        if (state === 'visible') lastVisibleAt = perfNow();
        else if (state === 'hidden') {
          hidden.hiddenSince = perfNow();
          disposers.push(ctx.schedule.timeout(() => safe(() => {
            if (visibilityState() === 'hidden') checkFocusEmulation('visibilitychange');
          }), 500));
        }
      });
      on(win, 'focus', (e) => {
        if (isTrusted(e)) focusEvidence.sawFocus = true;
      });
      on(win, 'pageshow', () => {
        focusEvidence.sawPageshow = true;
      });

      // ── hidden-tab input ─────────────────────────────────────────────────
      for (const type of HIDDEN_INPUT_EVENT_TYPES) {
        on(doc, type, (e) => {
          const counted = recordHiddenInput(hidden, { type: e.type, isTrusted: isTrusted(e), timeStamp: e.timeStamp }, visibilityState(), prerendering(), hiddenOpts);
          if (!counted) return;
          if (hiddenInputReached(hidden, hiddenOpts) && hidden.count >= nextHiddenEmitAt) {
            nextHiddenEmitAt = Math.max(nextHiddenEmitAt * 2, hidden.count + 1);
            emit({ id: 'extension.hidden-tab-input', summary: describeHiddenInput(hidden), details: { count: hidden.count, byType: { ...hidden.byType } } });
            checkFocusEmulation('hidden-input');
          }
        }, { passive: true, capture: true });
      }
      disposers.push(ctx.schedule.timeout(() => checkFocusEmulation('t+1s'), 1000));
      disposers.push(ctx.schedule.timeout(() => checkFocusEmulation('t+5s'), 5000));

      // ── DOM indicator / artifact observer ────────────────────────────────
      const frames: FrameState = { lastCount: dom.frameCount() };
      const indicatorRules = new Set<string>();
      const artifactRules = new Set<string>();
      const handleIndicator = (m: IndicatorMatch) => {
        if (indicatorRules.has(m.rule)) return;
        indicatorRules.add(m.rule);
        emit({
          id: 'extension.active-agent-indicator',
          summary: m.summary,
          reliability: m.reliability,
          provider: providerFor(m.driver),
          details: { rule: m.rule, rules: [...indicatorRules], ...m.details },
        });
      };
      const handleArtifact = (m: ArtifactMatch) => {
        if (artifactRules.has(m.rule)) return;
        artifactRules.add(m.rule);
        const provider: ProviderHint | undefined = m.entry
          ? { id: m.entry.provider, product: m.entry.product, confidence: m.entry.confidence }
          : m.driver !== 'extension'
            ? providerFor(m.driver)
            : undefined;
        emit({
          id: 'extension.agent-dom-artifact',
          summary: m.summary,
          reliability: m.reliability,
          ...(provider ? { provider } : {}),
          details: { rule: m.rule, rules: [...artifactRules], ...m.details },
        });
        if (m.details['userDriven'] === true && !emitted.has('assistant-present')) {
          emitted.add('assistant-present');
          emit({ id: 'extension.assistant-present', summary: `${m.rule === 'claude-picker-message' ? 'Element-picker message' : 'Picker overlay'} shows a person is using Claude in Chrome's side-panel tools on this page.`, ...(provider ? { provider } : {}), details: { rule: m.rule } });
        }
      };
      const handleMatch = (m: DomMatch) => (m.kind === 'indicator' ? handleIndicator(m) : handleArtifact(m));

      let assistantRescan: (() => void) | undefined;
      const scheduleAssistantRescan = () => {
        if (assistantRescan) return;
        assistantRescan = ctx.schedule.idle(() => {
          assistantRescan = undefined;
          scanAssistants('mutation');
        }, 2000);
        disposers.push(assistantRescan);
      };

      const onMutations = (records: MutationRecord[]) => {
        const msSinceVisible = lastVisibleAt !== undefined ? perfNow() - lastVisibleAt : undefined;
        for (const rec of records) {
          if (rec.type !== 'childList') continue;
          for (const node of rec.addedNodes) {
            if (node.nodeType !== 1) continue;
            const ind = classifyAddedNode(node, rec.target, doc, dom, frames, msSinceVisible);
            if (ind) handleMatch(ind);
            const art = classifyArtifactNode(node);
            if (art) handleMatch(art);
            const tag = (node as Element).tagName;
            if (tag.includes('-') || tag === 'FONT' || tag === 'LINK' || tag === 'STYLE') scheduleAssistantRescan();
          }
        }
      };
      safe(() => {
        if (typeof MutationObserver === 'function') {
          observer = new MutationObserver((records) => safe(() => onMutations(records)));
          observer.observe(doc.documentElement, { childList: true, subtree: true });
        }
      });
      on(win, 'message', (e) => {
        const m = classifyMessageEvent((e as MessageEvent).data, CLAUDE_MESSAGE_TYPES);
        if (m) handleMatch(m);
      });

      // ── main-world globals (deterministic) ───────────────────────────────
      let globalsDone = false;
      const scanGlobals = (tick: number) => {
        if (globalsDone) return;
        const hits: GlobalHit[] = scanMainWorldGlobals(win, doc);
        if (!hits.length) return;
        globalsDone = true;
        const first = hits[0]!;
        emit({
          id: 'probe.main-world-agent-global',
          summary: describeGlobalHit(first),
          provider: providerFor(first.driver),
          details: { tickMs: tick, hits: hits.map((h) => ({ key: h.key, where: h.where, driver: h.driver, kind: h.kind })) },
        });
      };
      for (const t of GLOBAL_SCAN_SCHEDULE_MS) {
        if (t === 0) safe(() => scanGlobals(0));
        else disposers.push(ctx.schedule.timeout(() => disposers.push(ctx.schedule.idle(() => safe(() => scanGlobals(t)), 1000)), t));
      }

      // ── idle work: existing DOM, assistants, brands, WAR, Comet probe ─────
      const scanAssistants = (reason: string) => {
        const markers = scanAssistantMarkers(doc);
        if (!markers.length) return;
        const key = markers.map((m) => m.product).sort().join('|');
        if (emitted.has(`assist:${key}`)) return;
        emitted.add(`assist:${key}`);
        emit({ id: 'beh.human-input-evidence', summary: describeAssistantMarkers(markers), reliability: 0.6, details: { source: 'extension', reason, markers } });
      };

      const scanBrands = () => {
        const list = brands();
        const hits = matchAgenticBrands(list);
        const edge = matchEdgeCopilotArtifacts(list, doc);
        if (edge) hits.push(edge);
        const hit = hits[0];
        if (!hit || emitted.has('brand')) return;
        emitted.add('brand');
        emit({
          id: 'extension.agentic-browser-brand',
          summary: `navigator.userAgentData brand "${hit.brand}" ${hit.version} identifies ${hit.product}.`,
          provider: { id: hit.provider, product: hit.product, confidence: 0.8 },
          details: { brands: list ?? [], hits },
        });
      };

      const runWarProbe = async () => {
        if (opts.warProbe === false) return;
        const targets = resourceProbeTargets(deps.table ?? KNOWN_AGENT_EXTENSIONS);
        if (!targets.length) return;
        const results = await probeResources(targets, deps.war ?? {});
        const hits = summariseHits(results);
        ctx.log('war probe', results.map((r) => `${r.target.url}=${r.outcome}/${r.channel}`));
        if (!hits.length) return;
        const first = hits[0]!;
        const path = first.paths[0] ?? '';
        emit({
          id: 'extension.agent-extension-resource',
          summary: `${first.entry.scheme}://${first.entry.id}/${path} ${first.channel === 'fetch' ? 'fetched with status 200' : 'loaded via <link rel=prefetch>'} (${first.entry.product} ${first.version} web_accessible_resource).`,
          reliability: first.channel === 'fetch' ? 1 : 0.8,
          provider: { id: first.entry.provider, product: first.entry.product, confidence: first.entry.confidence },
          details: {
            tableVersion: KNOWN_EXTENSIONS_TABLE_VERSION,
            hits: hits.map((h) => ({ id: h.entry.id, product: h.entry.product, version: h.version, paths: h.paths, channel: h.channel })),
            probed: results.length,
          },
        });
      };

      const runCometProbe = () => {
        if (opts.cometProbe === false) return;
        const r = probeCometStylesheet(doc, (el) => {
          try {
            return win.getComputedStyle(el).backgroundColor;
          } catch {
            return '';
          }
        });
        if (!r.present || emitted.has('comet-css')) return;
        emitted.add('comet-css');
        emit({
          id: 'extension.agentic-browser-brand',
          summary: `#pplx-agent-overlay-stop-button probe element computed background-color ${r.background} (Comet's injected stylesheet overrides the page).`,
          provider: providerFor('comet'),
          details: { background: r.background, probe: 'comet-stylesheet' },
        });
      };

      disposers.push(ctx.schedule.idle(() => safe(() => {
        for (const m of scanExistingIndicators(doc, dom, frames)) handleMatch(m);
        for (const m of scanExistingArtifacts(doc)) handleMatch(m);
        scanAssistants('idle');
        scanBrands();
        runCometProbe();
        void runWarProbe().catch((err) => ctx.log('war probe failed', err));
      }), 3000));
      disposers.push(ctx.schedule.timeout(() => safe(() => scanAssistants('t+3s')), 3000));
      disposers.push(ctx.schedule.timeout(() => safe(() => scanAssistants('t+10s')), 10000));
    },
    stop() {
      try {
        observer?.disconnect();
      } catch {
        /* ignore */
      }
      observer = undefined;
      for (const d of disposers) {
        try {
          d();
        } catch {
          /* ignore */
        }
      }
      disposers = [];
    },
  };
}
