import type { ProviderHint } from '@necterai/core';
import { classifyRawStack, installInstrumentation, onRead, onStack, type ReadEvent, type ReadKind } from '../harvest/instrument.js';
import { providerForMarkers, type StackVerdict } from '../harvest/stack.js';

/**
 * Stack-marker probe (`probe.automation-stack-frame`, detection-spec.md §2).
 *
 * Frames from automation evaluation scripts carry fixed markers
 * (docs/research/raw/cdp-leak-techniques.md §3): Puppeteer `pptr:<fn>;<site>` sourceURL
 * (legacy `__puppeteer_evaluation_script__`, pyppeteer `__pyppeteer_evaluation_script__`),
 * Playwright `UtilityScript.evaluate`, puppeteer-extra-stealth `newHandler.<computed> [as apply]`.
 * URL-less `<anonymous>` frames are NOT classified here: they are only meaningful
 * together with a read burst, which the harvest module owns (`harvest.foreign-evaluate`).
 *
 * The probe does not wrap prototypes itself. It joins the shared, ref-counted
 * instrumentation in `harvest/instrument.ts` (getBoundingClientRect, innerText and
 * textContent getters, querySelectorAll, ...), so a slot is wrapped once even when
 * both modules run, and the `__necter_wrapped` marker stops a second SDK copy from
 * stacking another wrapper. Sampling: within each 1 s window only the first 200
 * calls are eligible; of those, calls whose count crosses a threshold
 * (1, 2, 3, 5, 10, 20, 50, 100, 150, 200) and a random 1-in-50 are stack-sampled.
 * The probe stops after the first marker (the signal is deterministic).
 */

export interface StackMarkerHit {
  /** The instrumented API that was called (read kind, e.g. "rect", "innerText"). */
  target: ReadKind;
  /** Representative frame line containing the marker. */
  frame: string;
  markers: string[];
  provider?: ProviderHint;
}

export interface StackMarkerOptions {
  onHit(hit: StackMarkerHit): void;
  trustedScriptOrigins?: readonly string[];
  /** Injected for tests (default Math.random). */
  random?: () => number;
  /** Injected for tests (default performance.now). */
  now?: () => number;
  /** Calls eligible per second (default 200). */
  perSecond?: number;
  /** Random sampling rate among eligible calls (default 1/50). */
  rate?: number;
}

export interface StackMarkerProbe {
  /** Number of stack samples requested so far. */
  readonly samples: number;
  stop(): void;
}

/** Read kinds whose callers are sampled (the attribute hot path and scroll calls are excluded). */
export const SAMPLED_KINDS: ReadonlySet<ReadKind> = new Set<ReadKind>([
  'rect',
  'rects',
  'visibility',
  'style',
  'innerText',
  'textContent',
  'qsa',
  'treeWalker',
  'elementFromPoint',
  'attrNames',
]);

const THRESHOLDS: ReadonlySet<number> = new Set([1, 2, 3, 5, 10, 20, 50, 100, 150, 200]);

/** Classify a raw stack string with the shared harvest classifier (markers only count on URL-less frames). */
export function classifyStack(stack: string | undefined): { frame: string; markers: string[]; provider?: ProviderHint } | undefined {
  return markerHit(classifyRawStack(stack, 0));
}

function markerHit(v: StackVerdict): { frame: string; markers: string[]; provider?: ProviderHint } | undefined {
  if (v.cls !== 'automation' || v.markers.length === 0) return undefined;
  const out: { frame: string; markers: string[]; provider?: ProviderHint } = { frame: v.sample ?? v.markers[0]!, markers: [...v.markers] };
  const provider = providerForMarkers(v.markers);
  if (provider) out.provider = provider;
  return out;
}

export function startStackMarkerProbe(opts: StackMarkerOptions): StackMarkerProbe {
  const random = opts.random ?? Math.random;
  const now =
    opts.now ??
    (() => {
      try {
        return performance.now();
      } catch {
        return Date.now();
      }
    });
  const perSecond = opts.perSecond ?? 200;
  const rate = opts.rate ?? 1 / 50;
  const cleanups: (() => void)[] = [];
  const requested = new WeakSet<ReadEvent>();
  let windowStart = -Infinity;
  let count = 0;
  let samples = 0;
  let done = false;

  cleanups.push(installInstrumentation(opts.trustedScriptOrigins ? { trustedScriptOrigins: opts.trustedScriptOrigins } : {}));
  cleanups.push(
    onRead((ev) => {
      if (done || !SAMPLED_KINDS.has(ev.kind)) return false;
      const t = now();
      if (t - windowStart >= 1000) {
        windowStart = t;
        count = 0;
      }
      count++;
      if (count > perSecond) return false;
      if (!THRESHOLDS.has(count) && !(random() < rate)) return false;
      samples++;
      requested.add(ev);
      return true;
    }),
  );
  cleanups.push(
    onStack((ev, verdict, reason) => {
      if (done || reason !== 'sample' || !requested.has(ev)) return;
      requested.delete(ev);
      const hit = markerHit(verdict);
      if (!hit) return;
      done = true;
      try {
        opts.onHit({ target: ev.kind, ...hit });
      } catch {
        /* never reach the page */
      }
    }),
  );

  return {
    get samples() {
      return samples;
    },
    stop() {
      done = true;
      for (const c of cleanups.splice(0).reverse()) {
        try {
          c();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
