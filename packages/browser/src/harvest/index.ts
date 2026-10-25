/**
 * harvest module: DOM-harvest instrumentation with burst detection and
 * stack-origin attribution (detection-spec.md §4).
 *
 * Signals: `harvest.dom-read-burst`, `harvest.foreign-evaluate`,
 * `harvest.accessibility-tree-walk`, and the deterministic
 * `probe.automation-stack-frame` whenever a sampled stack carries an automation
 * marker (shared instrumentation with the probes module, spec §2).
 *
 * What this cannot see (documented limit): content scripts in isolated worlds
 * (Claude in Chrome `read_page`, Playwright's utility world, Browser Use's
 * `Accessibility.getFullAXTree`/`DOMSnapshot`) never call page prototypes
 * (extension-agents.md §2.3, automation-stacks.md §12.2). Those leave at most a
 * forced-layout long task, which is attached as an informational detail.
 */

import type { Module, ModuleContext } from '../types.js';
import {
  claimAutomationReport,
  getLastProgrammaticScroll,
  installInstrumentation,
  onRead,
  onStack,
  setHotAttributeCounting,
  type ReadEvent,
} from './instrument.js';
import { burstReliability, createBurstDetector, READ_API_NAMES, type BurstDetector, type BurstReport, type DetectorThresholds, type TreeWalkReport } from './detector.js';
import { providerForMarkers, type StackVerdict } from './stack.js';

export {
  claimAutomationReport,
  getLastProgrammaticScroll,
  installInstrumentation,
  isInstrumented,
  isSdkWrapper,
  WRAPPED_MARKER,
  onRead,
  onStack,
  quiet,
  registerSensitiveNode,
  type ProgrammaticScroll,
  type ReadEvent,
  type ReadKind,
  type SensitiveReadInfo,
} from './instrument.js';
export { AUTOMATION_MARKER_RE, classifyStack, parseStack, type StackClass, type StackVerdict } from './stack.js';
export { createBurstDetector, DEFAULT_THRESHOLDS, type BurstReport, type TreeWalkReport } from './detector.js';

interface LongTask {
  start: number;
  duration: number;
}

/** Minimum ms between re-emissions of the same non-deterministic harvest id. */
const REEMIT_MS = 2000;

export function createHarvestModule(): Module {
  const cleanups: (() => void)[] = [];
  let detector: BurstDetector | undefined;

  return {
    name: 'harvest',
    start(ctx: ModuleContext) {
      if (typeof window === 'undefined' || typeof document === 'undefined') return;
      const opts = ctx.options;
      const thresholds: Partial<DetectorThresholds> = {};
      for (const k of ['windowMs', 'layout', 'style', 'text', 'maxSamples', 'highCount', 'treeWalkReads', 'treeWalkWindowMs'] as const) {
        const v = opts[k];
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) thresholds[k] = v;
      }

      const release = installInstrumentation({ trustedScriptOrigins: ctx.config.trustedScriptOrigins });
      cleanups.push(release);

      const perfNow = (): number => {
        try {
          return performance.now();
        } catch {
          return Date.now();
        }
      };

      // ── activity tracking (for the tree-walk "no scroll" rule and long-task attribution) ──
      let lastInputTs = -Infinity;
      const longTasks: LongTask[] = [];
      const onInput = (): void => {
        lastInputTs = perfNow();
      };
      for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const) {
        window.addEventListener(type, onInput, { capture: true, passive: true });
        cleanups.push(() => window.removeEventListener(type, onInput, { capture: true }));
      }
      const onScroll = (ev: Event): void => {
        // A scroll event right after a programmatic scroll call is not the user scrolling.
        const ps = getLastProgrammaticScroll();
        const t = typeof ev.timeStamp === 'number' && ev.timeStamp > 0 ? ev.timeStamp : perfNow();
        if (ps && Math.abs(t - ps.ts) < 150) return;
        detector?.noteScroll();
      };
      window.addEventListener('scroll', onScroll, { capture: true, passive: true });
      cleanups.push(() => window.removeEventListener('scroll', onScroll, { capture: true }));

      try {
        const PO = (window as unknown as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;
        if (PO && Array.isArray((PO as unknown as { supportedEntryTypes?: string[] }).supportedEntryTypes) && (PO as unknown as { supportedEntryTypes: string[] }).supportedEntryTypes.includes('longtask')) {
          const po = new PO((list) => {
            for (const e of list.getEntries()) {
              if (e.duration >= 100) {
                longTasks.push({ start: e.startTime, duration: e.duration });
                if (longTasks.length > 8) longTasks.shift();
              }
            }
          });
          po.observe({ type: 'longtask', buffered: true } as PerformanceObserverInit);
          cleanups.push(() => po.disconnect());
        }
      } catch {
        /* long tasks are optional */
      }

      /** Long tasks in the last 2 s that contained no user input (forced layout from a tree walk). */
      const recentQuietLongTasks = (): LongTask[] | undefined => {
        const t = perfNow();
        const out = longTasks.filter((lt) => t - lt.start < 2000 && !(lastInputTs >= lt.start && lastInputTs <= lt.start + lt.duration));
        return out.length ? out.map((lt) => ({ start: Math.round(lt.start), duration: Math.round(lt.duration) })) : undefined;
      };

      // ── emission helpers ──
      const lastEmit = new Map<string, number>();
      const canEmit = (id: string): boolean => {
        const t = ctx.now();
        const prev = lastEmit.get(id);
        if (prev !== undefined && t - prev < REEMIT_MS) return false;
        lastEmit.set(id, t);
        return true;
      };
      let automationEmitted = false;
      const emitAutomation = (verdict: StackVerdict, what: string, extra: Record<string, unknown>): void => {
        if (automationEmitted) return;
        automationEmitted = true;
        // The probes module samples the same hooks; whoever sees the marker first reports it.
        if (!claimAutomationReport()) return;
        const provider = providerForMarkers(verdict.markers);
        ctx.emit({
          id: 'probe.automation-stack-frame',
          summary: `${what} invoked from an automation evaluate frame (${verdict.markers.join(', ')})`,
          value: verdict.markers,
          details: { ...extra, frame: verdict.sample, origins: verdict.origins },
          ...(provider ? { provider } : {}),
        });
        ctx.finalize('automation-stack-frame');
      };

      const onBurst = (report: BurstReport): void => {
        const v = report.verdict;
        const api = READ_API_NAMES[report.kind];
        const base = `${report.count} ${api} calls in ${report.windowMs} ms`;
        const lt = recentQuietLongTasks();
        const details: Record<string, unknown> = {
          kind: report.kind,
          count: report.count,
          totalReads: report.totalReads,
          distinctTargets: report.distinctTargets,
          windowMs: report.windowMs,
          burstIndex: report.burstIndex,
          samples: report.samples.length,
          stackClass: v.cls,
          ...(v.origins.length ? { origins: v.origins } : {}),
          ...(v.sample ? { frame: v.sample } : {}),
          ...(lt ? { longTasks: lt } : {}),
        };
        switch (v.cls) {
          case 'trusted':
            ctx.log('burst from trusted origin ignored', base);
            return;
          case 'automation':
            emitAutomation(v, base, details);
            return;
          case 'anonymous':
            if (!canEmit('harvest.foreign-evaluate')) return;
            ctx.emit({
              id: 'harvest.foreign-evaluate',
              summary: `${base} from anonymous evaluated code with no script URL${v.sample ? ` (${v.sample})` : ''}`,
              value: report.count,
              details,
            });
            return;
          case 'extension':
            if (!canEmit('harvest.dom-read-burst')) return;
            ctx.emit({
              id: 'harvest.dom-read-burst',
              summary: `${base} from extension code (${v.origins.join(', ')})`,
              value: report.count,
              reliability: burstReliability(report, detector!.thresholds),
              classes: { 'extension-agent': 2, 'browser-agent': 1 },
              details,
            });
            return;
          case 'page-script':
            if (!canEmit('harvest.dom-read-burst')) return;
            ctx.emit({
              id: 'harvest.dom-read-burst',
              summary: `${base} from untrusted third-party script (${v.origins.join(', ')}); add it to trustedScriptOrigins if it is yours`,
              value: report.count,
              reliability: burstReliability(report, detector!.thresholds),
              details,
            });
            return;
          case 'none':
          default: {
            if (!canEmit('harvest.dom-read-burst')) return;
            const rel = burstReliability(report, detector!.thresholds);
            ctx.emit({
              id: 'harvest.dom-read-burst',
              summary: `${base} with no attributable stack (burst ${report.burstIndex}${lt ? `, ${lt.length} long task(s) without input` : ''})`,
              value: report.count,
              reliability: rel,
              details,
            });
          }
        }
      };

      const onTreeWalk = (report: TreeWalkReport): void => {
        if (report.stack.cls === 'automation') {
          emitAutomation(report.stack, `${report.trigger} over the document followed by ${report.reads} reads`, { trigger: report.trigger, reads: report.reads });
          return;
        }
        if (!canEmit('harvest.accessibility-tree-walk')) return;
        const lt = recentQuietLongTasks();
        ctx.emit({
          id: 'harvest.accessibility-tree-walk',
          summary: `${report.trigger === 'treeWalker' ? 'createTreeWalker(document, SHOW_ELEMENT)' : "querySelectorAll('*')"} followed by ${report.reads} attribute/text/layout reads in ${Math.round(report.elapsedMs)} ms without scrolling (${report.stack.cls} origin)`,
          value: report.reads,
          details: {
            trigger: report.trigger,
            reads: report.reads,
            elapsedMs: Math.round(report.elapsedMs),
            stackClass: report.stack.cls,
            ...(report.stack.sample ? { frame: report.stack.sample } : {}),
            ...(report.stack.origins.length ? { origins: report.stack.origins } : {}),
            ...(lt ? { longTasks: lt } : {}),
          },
          ...(report.stack.cls === 'extension' ? { classes: { 'extension-agent': 2, 'browser-agent': 1 } } : {}),
        });
      };

      let pendingFlush: (() => void) | undefined;
      detector = createBurstDetector({
        now: perfNow,
        onBurst,
        onTreeWalk,
        onBurstOpened: (ms) => {
          pendingFlush?.();
          pendingFlush = ctx.schedule.timeout(() => {
            pendingFlush = undefined;
            detector?.flush(true);
          }, ms);
        },
        onWalkArmed: (armed) => setHotAttributeCounting(armed),
        thresholds,
      });

      const det = detector;
      cleanups.push(onRead((ev: ReadEvent) => det.record(ev)));
      cleanups.push(
        onStack((ev, verdict, reason) => {
          det.onStack(ev, verdict, reason);
          // Any sampled stack with an automation marker is deterministic on its own
          // (sensitive-node reads from the canary module, programmatic scrolls, bursts).
          if (verdict.cls === 'automation' && reason !== 'sample') {
            emitAutomation(verdict, `${ev.kind} ${reason === 'scroll' ? 'call' : 'read of hidden canary text'}`, { api: ev.kind, reason });
          }
        }),
      );
      cleanups.push(() => pendingFlush?.());
      cleanups.push(() => setHotAttributeCounting(false));
      ctx.log('harvest instrumentation active');
    },
    stop() {
      for (const c of cleanups.splice(0)) {
        try {
          c();
        } catch {
          /* ignore */
        }
      }
      detector = undefined;
    },
  };
}
