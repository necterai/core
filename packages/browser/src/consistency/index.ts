/**
 * consistency module (detection-spec.md §7): cross-signal lie detection. It reads
 * the shared environment state (privacy mode, WebGL, fonts) and adds the Worker
 * cross-check, the UA / platform / client-hints comparison, screen geometry
 * impossibilities and the locale vs timezone check. While an anti-fingerprinting
 * mode is active every consistency.* signal carries reliability x 0.3.
 */
import type { Module, ModuleContext } from '../types.js';
import type { Env } from '../collectors/env.js';
import { toSignalInput, type Finding } from '../collectors/finding.js';
import { ensureEnvironmentState, type EnvironmentState } from '../collectors/state.js';
import { analyzeLocale } from './locale.js';
import { analyzePlatform, type PlatformFacts } from './platform.js';
import { analyzeScreenGeometry } from './screen.js';
import { compareWorker, WORKER_CODE } from './worker.js';

export interface ConsistencyModuleOptions {
  /** Injectable environment adapter; defaults to the shared environment state's adapter. */
  env?: Env;
  /** Worker round-trip timeout (default 2000 ms). */
  workerTimeoutMs?: number;
}

export function platformFactsFromState(state: EnvironmentState, highEntropyPlatform: string | undefined): PlatformFacts {
  const env = state.env;
  const uad = env.userAgentData;
  return {
    ua: state.ua,
    platform: env.platform,
    maxTouchPoints: env.maxTouchPoints,
    userAgentData: uad ? { brands: uad.brands.map((b) => b.brand), mobile: uad.mobile, platform: uad.platform } : undefined,
    highEntropyPlatform,
    webgl: state.features.webgl,
    fonts: state.features.fonts,
  };
}

export function createConsistencyModule(opts: ConsistencyModuleOptions = {}): Module {
  const disposers: Array<() => void> = [];
  let stopped = false;

  return {
    name: 'consistency',
    start(ctx: ModuleContext) {
      const state = ensureEnvironmentState(opts.env);
      const env = state.env;
      const emitted = new Map<string, Finding>();
      let highEntropyPlatform: string | undefined;

      const emitFinding = (f: Finding): void => {
        if (stopped) return;
        emitted.set(f.id, f);
        try {
          ctx.emit(toSignalInput(f, state.privacy.active));
        } catch (err) {
          ctx.log('emit failed', f.id, err);
        }
      };
      const guarded = (label: string, fn: () => void): void => {
        try {
          fn();
        } catch (err) {
          ctx.log(label, 'failed', err);
        }
      };

      const emitPrivacyMode = (): void => {
        if (!state.privacy.active) return;
        emitFinding({
          id: 'consistency.privacy-browser-mode',
          summary: `anti-fingerprinting mode active: ${state.privacy.kinds.join(', ')} (${state.privacy.evidence.join('; ')})`,
          value: state.privacy.kinds,
          details: { evidence: state.privacy.evidence },
        });
      };
      const runPlatform = (): void =>
        guarded('platform', () => {
          for (const f of analyzePlatform(platformFactsFromState(state, highEntropyPlatform))) emitFinding(f);
        });

      // ── synchronous ────────────────────────────────────────────────────────
      emitPrivacyMode();
      runPlatform();
      guarded('screen', () => {
        for (const f of analyzeScreenGeometry({ window: env.window, screen: env.screen, fullscreen: env.fullscreen() })) emitFinding(f);
      });
      guarded('locale', () => {
        for (const f of analyzeLocale({ languages: env.languages, intlLocale: env.intlLocale(), timezone: env.timezone() })) emitFinding(f);
      });

      // Privacy flips re-gate everything already emitted; new WebGL / font facts re-run the platform check.
      let lastPrivacy = state.privacy.active;
      let lastFacts = '';
      disposers.push(
        state.onChange(() => {
          if (stopped) return;
          if (state.privacy.active !== lastPrivacy) {
            lastPrivacy = state.privacy.active;
            emitPrivacyMode();
            for (const f of [...emitted.values()]) if (f.privacyGated) emitFinding(f);
          }
          const key = `${state.features.webgl ? state.features.webgl.renderer : String(state.features.webgl)}|${state.features.fonts ? state.features.fonts.size : ''}`;
          if (key !== lastFacts) {
            lastFacts = key;
            runPlatform();
          }
        }),
      );

      // ── deferred ───────────────────────────────────────────────────────────
      ctx.schedule.idle(() => {
        if (stopped) return;
        guarded('worker', () => {
          void env.runWorker(WORKER_CODE, opts.workerTimeoutMs ?? 2000).then((snapshot) => {
            if (stopped || !snapshot) return; // CSP worker-src or no Worker support: skip silently
            const r = compareWorker(
              {
                platform: env.platform,
                userAgent: env.userAgent,
                hardwareConcurrency: env.hardwareConcurrency,
                languages: env.languages,
                uaDataPlatform: env.userAgentData?.platform,
                brands: env.userAgentData?.brands.map((b) => b.brand),
              },
              snapshot,
            );
            state.update({ worker: snapshot, workerPlatformMismatch: r.platformMismatch });
            for (const f of r.findings) emitFinding(f);
          });
        });
        guarded('high-entropy', () => {
          const get = env.userAgentData?.getHighEntropyValues;
          if (!get) return;
          void get(['platform', 'architecture', 'bitness', 'model', 'platformVersion']).then(
            (values) => {
              if (stopped) return;
              const p = values['platform'];
              if (typeof p === 'string' && p) {
                highEntropyPlatform = p;
                runPlatform();
              }
            },
            () => undefined,
          );
        });
      }, 2000);
    },
    stop() {
      stopped = true;
      for (const d of disposers.splice(0)) {
        try {
          d();
        } catch {
          /* ignore */
        }
      }
    },
  };
}

export { analyzePlatform, platformMismatches } from './platform.js';
export { compareWorker, WORKER_CODE } from './worker.js';
export { analyzeScreenGeometry, looksLikeZoom } from './screen.js';
export { analyzeLocale, TZ_COUNTRY } from './locale.js';
