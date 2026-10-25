/**
 * Burst and tree-walk detection over instrumented DOM reads (detection-spec.md §4).
 *
 * Pure logic with an injected clock so the thresholds can be unit-tested with
 * synthetic read streams and synthetic stack verdicts:
 *
 * - per 250 ms window, count layout reads (`getBoundingClientRect`, `getClientRects`,
 *   `checkVisibility`, `elementFromPoint`), `getComputedStyle` calls, and
 *   `innerText`/`textContent` reads across *distinct* nodes;
 * - a window with >= 300 layout, >= 300 style or >= 150 distinct text reads opens a
 *   burst: the next calls (max 5) are stack-sampled and the burst is classified
 *   when the window ends (`flush()`), following the spec's precedence
 *   (automation marker > trusted frame > anonymous-only > third-party > none);
 * - `createTreeWalker(body|html|document, SHOW_ELEMENT)` or `querySelectorAll('*')`
 *   from non-trusted code followed within 1 s by >= 100 attribute/role/text/layout
 *   reads and no user scroll is an accessibility-tree walk.
 *
 * Thresholds come from the spec; the counts are high enough that analytics and A/B
 * tools (false-positive-traps.md §11, §12) rarely reach them, and trusted-origin
 * frames exclude them when they do.
 */

import type { ReadEvent } from './instrument.js';
import { aggregateVerdicts, type StackVerdict } from './stack.js';

export interface DetectorThresholds {
  /** Window length in ms (spec: 250). */
  windowMs: number;
  /** Layout reads per window (spec: 300 getBoundingClientRect). */
  layout: number;
  /** getComputedStyle calls per window (spec: 300). */
  style: number;
  /** innerText/textContent reads across distinct nodes per window (spec: 150). */
  text: number;
  /** Stack samples per burst (spec: max 5). */
  maxSamples: number;
  /** Calls in one window that make a no-stack burst fully reliable (spec: 1000). */
  highCount: number;
  /** Attribute/role/text/layout reads after a tree-walk trigger (spec: 100). */
  treeWalkReads: number;
  /** Time after the trigger during which reads count (spec: 1 s). */
  treeWalkWindowMs: number;
}

export const DEFAULT_THRESHOLDS: DetectorThresholds = {
  windowMs: 250,
  layout: 300,
  style: 300,
  text: 150,
  maxSamples: 5,
  highCount: 1000,
  treeWalkReads: 100,
  treeWalkWindowMs: 1000,
};

export type BurstKind = 'layout' | 'style' | 'text';

export interface BurstReport {
  /** Which counter crossed its threshold first. */
  kind: BurstKind;
  /** Calls of that kind in the window. */
  count: number;
  /** All instrumented reads in the window. */
  totalReads: number;
  /** Distinct nodes read for text bursts. */
  distinctTargets: number;
  /** Window length in ms. */
  windowMs: number;
  /** Number of non-trusted bursts seen so far in this page (including this one). */
  burstIndex: number;
  samples: StackVerdict[];
  verdict: StackVerdict;
}

export interface TreeWalkReport {
  trigger: 'treeWalker' | 'querySelectorAll';
  reads: number;
  elapsedMs: number;
  stack: StackVerdict;
}

export interface DetectorHooks {
  now: () => number;
  onBurst: (report: BurstReport) => void;
  onTreeWalk: (report: TreeWalkReport) => void;
  /** Called when a burst opens so the host can schedule `flush()` after the window. */
  onBurstOpened?: (closesInMs: number) => void;
  /** Called when the tree-walk follow-up rule arms/disarms (host toggles hot getAttribute counting). */
  onWalkArmed?: (armed: boolean) => void;
  thresholds?: Partial<DetectorThresholds>;
}

export interface BurstDetector {
  /** Feed an instrumented call. Returns true when a stack sample is wanted for it. */
  record(ev: ReadEvent): boolean;
  /** Deliver the classified stack for a call that `record` asked to sample. */
  onStack(ev: ReadEvent, verdict: StackVerdict, reason: 'sample' | 'sensitive' | 'scroll'): void;
  /** A user-driven scroll happened (resets the tree-walk rule). */
  noteScroll(): void;
  /** Close the current window if it has expired (or `force`), classifying any open burst. */
  flush(force?: boolean): void;
  /** Counters of the current window (for tests / debug). */
  snapshot(): { layout: number; style: number; text: number; total: number; burstOpen: boolean };
  readonly thresholds: DetectorThresholds;
}

const SHOW_ELEMENT = 0x1;

function isTreeRoot(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  const n = node as Node & { body?: unknown };
  if (n.nodeType === 9) return true; // Document
  if (typeof document === 'undefined') return false;
  return n === document.body || n === document.documentElement;
}

function isTreeWalkTrigger(ev: ReadEvent): 'treeWalker' | 'querySelectorAll' | undefined {
  if (ev.kind === 'treeWalker') {
    const root = ev.args[0];
    const what = ev.args[1];
    const showsElements = what === undefined || what === null || (Number(what) & SHOW_ELEMENT) !== 0 || Number(what) === 0xffffffff || Number(what) === -1;
    return isTreeRoot(root) && showsElements ? 'treeWalker' : undefined;
  }
  if (ev.kind === 'qsa') {
    const sel = ev.args[0];
    if (typeof sel !== 'string') return undefined;
    const s = sel.trim();
    // `*` alone, or a selector list that includes a bare universal selector.
    if (s === '*' || /(^|,)\s*\*\s*($|,)/.test(s)) {
      return isTreeRoot(ev.target) || (ev.target && (ev.target as Node).nodeType === 1) ? 'querySelectorAll' : undefined;
    }
  }
  return undefined;
}

export function createBurstDetector(hooks: DetectorHooks): BurstDetector {
  const thresholds: DetectorThresholds = { ...DEFAULT_THRESHOLDS, ...(hooks.thresholds ?? {}) };
  const now = hooks.now;

  let windowStart = now();
  let layout = 0;
  let style = 0;
  let text = 0;
  let total = 0;
  const textTargets = new Set<unknown>();

  let burst: { kind: BurstKind; samples: StackVerdict[]; pendingSamples: number } | undefined;
  let burstIndex = 0;

  let walk: { trigger: 'treeWalker' | 'querySelectorAll'; at: number; reads: number; stack: StackVerdict } | undefined;
  let pendingWalkTrigger: 'treeWalker' | 'querySelectorAll' | undefined;
  let lastUserScroll = -Infinity;

  function resetWindow(t: number): void {
    windowStart = t;
    layout = style = text = total = 0;
    textTargets.clear();
    burst = undefined;
  }

  function closeBurst(): void {
    if (!burst) return;
    const b = burst;
    burst = undefined;
    const verdict = aggregateVerdicts(b.samples);
    if (verdict.cls !== 'trusted') burstIndex++;
    const count = b.kind === 'layout' ? layout : b.kind === 'style' ? style : text;
    try {
      hooks.onBurst({
        kind: b.kind,
        count,
        totalReads: total,
        distinctTargets: textTargets.size,
        windowMs: thresholds.windowMs,
        burstIndex,
        samples: b.samples,
        verdict,
      });
    } catch {
      /* ignore */
    }
  }

  function roll(t: number): void {
    if (t - windowStart >= thresholds.windowMs) {
      closeBurst();
      resetWindow(t);
    }
  }

  function openBurst(kind: BurstKind): void {
    burst = { kind, samples: [], pendingSamples: thresholds.maxSamples };
    try {
      hooks.onBurstOpened?.(thresholds.windowMs + 20);
    } catch {
      /* ignore */
    }
  }

  function expireWalk(t: number): void {
    if (walk && t - walk.at > thresholds.treeWalkWindowMs) {
      walk = undefined;
      hooks.onWalkArmed?.(false);
    }
  }

  return {
    thresholds,
    record(ev) {
      const t = now();
      roll(t);
      expireWalk(t);
      let want = false;

      // Tree-walk trigger: sample the stack right away (cheap: rare calls).
      const trigger = isTreeWalkTrigger(ev);
      if (trigger) {
        pendingWalkTrigger = trigger;
        want = true;
      }

      // Counters.
      const k = ev.kind;
      let counted = false;
      if (k === 'rect' || k === 'rects' || k === 'visibility' || k === 'elementFromPoint') {
        layout++;
        counted = true;
        if (!burst && layout >= thresholds.layout) openBurst('layout');
      } else if (k === 'style') {
        style++;
        counted = true;
        if (!burst && style >= thresholds.style) openBurst('style');
      } else if (k === 'innerText' || k === 'textContent') {
        counted = true;
        if (!textTargets.has(ev.target)) {
          textTargets.add(ev.target);
          text++;
          if (!burst && text >= thresholds.text) openBurst('text');
        }
      } else if (k === 'attr' || k === 'attrNames') {
        counted = true;
      }
      if (counted) total++;

      // Tree-walk follow-up reads.
      if (walk && counted && (k === 'attr' || k === 'attrNames' || k === 'innerText' || k === 'textContent' || k === 'rect' || k === 'rects' || k === 'style' || k === 'visibility')) {
        walk.reads++;
        if (walk.reads >= thresholds.treeWalkReads && lastUserScroll < walk.at) {
          const w = walk;
          walk = undefined;
          hooks.onWalkArmed?.(false);
          try {
            hooks.onTreeWalk({ trigger: w.trigger, reads: w.reads, elapsedMs: t - w.at, stack: w.stack });
          } catch {
            /* ignore */
          }
        }
      }

      // Burst sampling: the calls after the threshold crossing are sampled.
      if (burst && burst.pendingSamples > 0 && counted && k !== 'attr' && k !== 'attrNames') {
        burst.pendingSamples--;
        want = true;
      }
      return want;
    },
    onStack(ev, verdict, reason) {
      const t = now();
      if (ev.kind === 'treeWalker' || ev.kind === 'qsa') {
        // Tree-walk triggers are never burst samples; they arm the follow-up rule.
        if (!pendingWalkTrigger) return;
        const trigger = pendingWalkTrigger;
        pendingWalkTrigger = undefined;
        if (verdict.cls !== 'trusted') {
          walk = { trigger, at: t, reads: 0, stack: verdict };
          hooks.onWalkArmed?.(true);
        } else if (walk) {
          walk = undefined;
          hooks.onWalkArmed?.(false);
        }
        return;
      }
      if (reason !== 'sample') return;
      if (burst && burst.samples.length < thresholds.maxSamples) burst.samples.push(verdict);
    },
    noteScroll() {
      lastUserScroll = now();
      if (walk) {
        walk = undefined;
        hooks.onWalkArmed?.(false);
      }
    },
    flush(force = false) {
      const t = now();
      if (force || t - windowStart >= thresholds.windowMs) {
        closeBurst();
        resetWindow(t);
      }
      expireWalk(t);
    },
    snapshot() {
      return { layout, style, text, total, burstOpen: !!burst };
    },
  };
}

/** Reliability for a `harvest.dom-read-burst` observation (spec §4). */
export function burstReliability(report: BurstReport, thresholds: DetectorThresholds = DEFAULT_THRESHOLDS): number {
  switch (report.verdict.cls) {
    case 'none':
      return report.count >= thresholds.highCount || report.burstIndex >= 2 ? 1 : 0.6;
    case 'page-script':
      // Third-party script with a URL we do not trust: most often analytics/heatmaps.
      return 0.3;
    case 'extension':
      return 0.5;
    default:
      return 1;
  }
}

export const READ_API_NAMES: Record<BurstKind, string> = {
  layout: 'getBoundingClientRect/getClientRects',
  style: 'getComputedStyle',
  text: 'innerText/textContent',
};
