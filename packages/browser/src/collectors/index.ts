/**
 * environment module (detection-spec.md §1). Cheap collectors run synchronously
 * at start() (navigator, geometry, timezone, storage, window.chrome, hosted
 * profile from the sync facts); everything that touches canvas, WebGL, media,
 * permissions, speech or timers is deferred through ctx.schedule.idle.
 *
 * Calibration doctrine (false-positive-traps.md §0): no environment signal is
 * sufficient on its own, every weight stays below deterministic except the
 * HeadlessChrome UA token, and once an anti-fingerprinting mode is detected the
 * container / fingerprint tells are re-emitted at reliability x 0.3.
 */
import type { Module, ModuleContext } from '../types.js';
import { analyzeChromeObject } from './chrome-object.js';
import { definitions } from './definitions.js';
import { createRealEnv, type Env, type EnvVoice } from './env.js';
import { toSignalInput, type Finding } from './finding.js';
import { analyzeFonts, PROBE_FONTS } from './fonts.js';
import { analyzeGeometry, geometryInputFromEnv } from './geometry.js';
import { analyzeGraphics } from './graphics.js';
import { hostedFinding, matchHostedProfiles, type HostedFacts } from './hosted-profiles.js';
import { analyzeTimezone } from './intl.js';
import { analyzeMediaDevices, analyzeVoices } from './media.js';
import { analyzeNavigator, navigatorInputFromEnv } from './navigator.js';
import { analyzePermissions, PERMISSION_NAMES, type PermissionOutcome } from './permissions.js';
import { createEnvironmentState, setEnvironmentState, type EnvironmentState } from './state.js';
import { analyzeStorage } from './storage.js';
import { analyzeRafIntervals, createFocusTracker, RAF_FRAMES } from './timing.js';

export interface EnvironmentModuleOptions {
  /** Injectable environment adapter (tests stub WebGL, media devices, speech, workers). */
  env?: Env;
  /** How long to wait for `voiceschanged` before counting voices (default 1500 ms). */
  voicesTimeoutMs?: number;
  /** How long the focus watcher runs (default 60 s). */
  focusWatchMs?: number;
}

export function hostedFactsFromState(state: EnvironmentState): HostedFacts {
  const { env, features } = state;
  return {
    ua: state.ua,
    screenWidth: env.screen.width,
    screenHeight: env.screen.height,
    innerWidth: env.window.innerWidth,
    innerHeight: env.window.innerHeight,
    hardwareConcurrency: env.hardwareConcurrency,
    platform: env.platform,
    uaDataPlatform: env.userAgentData?.platform,
    timezone: env.timezone(),
    workerPlatformMismatch: features.workerPlatformMismatch,
    webgl: features.webgl,
    permissionsQueryFailRate: features.permissionsQueryFailRate,
    permissionsDeniedRate: features.permissionsDeniedRate,
    fonts: features.fonts,
  };
}

export function createEnvironmentModule(opts: EnvironmentModuleOptions = {}): Module {
  const disposers: Array<() => void> = [];
  let stopped = false;

  return {
    name: 'environment',
    start(ctx: ModuleContext) {
      ctx.registry.registerAll(definitions);
      const env = opts.env ?? createRealEnv();
      const state = setEnvironmentState(createEnvironmentState(env));
      const ua = state.ua;
      const emitted = new Map<string, Finding>();

      const emitFinding = (f: Finding): void => {
        if (stopped) return;
        emitted.set(f.id, f);
        try {
          ctx.emit(toSignalInput(f, state.privacy.active));
        } catch (err) {
          ctx.log('emit failed', f.id, err);
        }
      };
      const emitAll = (list: Finding[]): void => {
        for (const f of list) emitFinding(f);
      };
      const guarded = (label: string, fn: () => void): void => {
        try {
          fn();
        } catch (err) {
          ctx.log(label, 'failed', err);
        }
      };

      // ── synchronous, < 3 ms ────────────────────────────────────────────────
      guarded('navigator', () => emitAll(analyzeNavigator(navigatorInputFromEnv(env, ua, state.privacy.active))));
      let geometryDone = false;
      guarded('geometry', () => {
        const input = geometryInputFromEnv(env, ua, state.privacy.kinds);
        emitAll(analyzeGeometry(input));
        geometryDone = input.hasFocus;
      });
      guarded('timezone', () => emitAll(analyzeTimezone(env.timezone(), env.language || env.languages[0])));
      guarded('storage', () => emitAll(analyzeStorage(ctx.session.firstVisit, env.historyLength(), env.referrer())));
      guarded('chrome', () => emitAll(analyzeChromeObject(env.chromeObject, ua)));
      const runHosted = (): void =>
        guarded('hosted', () => {
          const facts = hostedFactsFromState(state);
          const match = matchHostedProfiles(facts);
          if (match) emitFinding(hostedFinding(match, facts));
        });
      runHosted();
      if (state.privacy.active && ctx.config.modules.consistency === false) emitPrivacyMode();

      // Re-apply gating when a privacy mode shows up later (canvas noise, isBrave()) and re-match
      // hosted profiles as deferred facts arrive.
      let lastPrivacy = state.privacy.active;
      disposers.push(
        state.onChange(() => {
          if (state.privacy.active !== lastPrivacy) {
            lastPrivacy = state.privacy.active;
            for (const f of [...emitted.values()]) if (f.privacyGated) emitFinding(f);
            if (state.privacy.active && ctx.config.modules.consistency === false) emitPrivacyMode();
          }
          runHosted();
        }),
      );

      // no-window-chrome needs a focused document; re-run geometry once focus arrives.
      if (!geometryDone) {
        const off = env.on('focus', () => {
          off();
          guarded('geometry:focus', () => {
            const input = geometryInputFromEnv(env, ua, state.privacy.kinds);
            for (const f of analyzeGeometry(input)) if (!emitted.has(f.id)) emitFinding(f);
          });
        });
        disposers.push(off);
      }

      // ── deferred ───────────────────────────────────────────────────────────
      ctx.schedule.idle(() => {
        if (stopped) return;
        guarded('webgl', () => {
          const webgl = env.getWebGL();
          state.update({ webgl });
          emitAll(analyzeGraphics({ ua, webgl, brave: env.braveObject || state.privacy.kinds.includes('brave') }));
        });
        guarded('fonts', () => {
          const fonts = env.measureFonts(PROBE_FONTS);
          if (fonts) state.update({ fonts });
          emitAll(analyzeFonts(fonts, ua));
        });
        guarded('canvas-noise', () => {
          const a = env.canvasHash();
          const b = env.canvasHash();
          if (a !== undefined && b !== undefined) state.refreshPrivacy(a !== b);
        });
        guarded('brave', () => {
          const p = env.isBrave();
          if (!p) return;
          void p.then(
            (yes) => {
              if (yes && !state.privacy.kinds.includes('brave')) {
                state.setPrivacy({ active: true, kinds: [...state.privacy.kinds, 'brave'], evidence: [...state.privacy.evidence, 'navigator.brave.isBrave() resolved true'] });
              }
            },
            () => undefined,
          );
        });
      }, 1500);

      ctx.schedule.idle(() => {
        if (stopped) return;
        guarded('media', () => {
          const p = env.enumerateDevices();
          if (!p) return;
          void p.then(
            (devices) => {
              if (stopped) return;
              state.update({ mediaDevices: devices.length });
              emitAll(analyzeMediaDevices(devices, ua));
            },
            () => undefined,
          );
        });
        guarded('voices', () => collectVoices());
        guarded('permissions', () => collectPermissions());
      }, 2500);

      ctx.schedule.idle(() => {
        if (stopped) return;
        guarded('raf', () => collectRaf());
        guarded('focus', () => watchFocus());
      }, 3000);

      // ── helpers ────────────────────────────────────────────────────────────
      function emitPrivacyMode(): void {
        emitFinding({
          id: 'consistency.privacy-browser-mode',
          summary: `anti-fingerprinting mode active: ${state.privacy.kinds.join(', ')} (${state.privacy.evidence.join('; ')})`,
          value: state.privacy.kinds,
          details: { evidence: state.privacy.evidence },
        });
      }

      function finishVoices(voices: EnvVoice[]): void {
        const r = analyzeVoices(voices, ua);
        state.update({ voices: { total: r.total, google: r.google } });
        emitAll(r.findings);
        // Chrome-branded UA whose build is Chromium / Chrome for Testing: brands lack "Google Chrome".
        const brands = env.userAgentData?.brands.map((b) => b.brand) ?? [];
        const brave = env.braveObject || brands.some((b) => /Brave/i.test(b));
        if (ua.browser === 'chrome' && ua.engine === 'blink' && ua.desktop && !brave && brands.length > 0 && brands.includes('Chromium') && !brands.includes('Google Chrome')) {
          emitFinding({
            id: 'env.chromium-build',
            summary: `userAgentData.brands are ${brands.join(', ')} without "Google Chrome"${r.total > 0 && r.google === 0 ? ' and no Google voices' : ''}`,
            value: brands,
            details: { voices: r.total, googleVoices: r.google },
            reliability: r.total > 0 && r.google === 0 ? 1 : 0.5,
          });
        }
      }

      function collectVoices(): void {
        const speech = env.speech();
        if (!speech) return;
        const first = speech.getVoices();
        if (first.length > 0) {
          finishVoices(first);
          return;
        }
        let done = false;
        const settle = (): void => {
          if (done || stopped) return;
          done = true;
          off();
          cancel();
          finishVoices(speech.getVoices());
        };
        const off = speech.onVoicesChanged(settle);
        const cancel = ctx.schedule.timeout(settle, opts.voicesTimeoutMs ?? 1500);
        disposers.push(off, cancel);
      }

      function collectPermissions(): void {
        const outcomes = new Map<string, PermissionOutcome>();
        let pending = 0;
        const finish = (): void => {
          if (stopped) return;
          const r = analyzePermissions({ ua, notificationPermission: env.notificationPermission(), outcomes });
          state.update({ permissionsQueryFailRate: r.failRate, permissionsDeniedRate: r.deniedRate });
          emitAll(r.findings);
        };
        for (const name of PERMISSION_NAMES) {
          const p = env.permissionsQuery(name);
          if (!p) continue;
          pending++;
          p.then(
            (s) => {
              outcomes.set(name, s === 'granted' || s === 'denied' || s === 'prompt' ? s : 'rejected');
            },
            () => {
              outcomes.set(name, 'rejected');
            },
          ).then(() => {
            if (--pending === 0) finish();
          });
        }
        if (pending === 0 && env.notificationPermission() !== undefined) finish();
      }

      function collectRaf(): void {
        if (env.visibilityState() !== 'visible') return;
        const stamps: number[] = [];
        const step = (t: number): void => {
          if (stopped) return;
          stamps.push(t);
          if (env.visibilityState() !== 'visible') return; // abandon: hidden tabs pause rAF
          if (stamps.length <= RAF_FRAMES) {
            disposers.push(ctx.schedule.raf(step));
            return;
          }
          const intervals: number[] = [];
          for (let i = 1; i < stamps.length; i++) intervals.push(stamps[i]! - stamps[i - 1]!);
          // Drop the first interval (warm-up).
          emitAll(analyzeRafIntervals(intervals.slice(1)).findings);
        };
        disposers.push(ctx.schedule.raf(step));
      }

      function watchFocus(): void {
        const tracker = createFocusTracker(3000);
        let interacted = false;
        const mark = (): void => {
          interacted = true;
        };
        for (const type of ['pointerdown', 'keydown', 'wheel']) disposers.push(env.on(type, mark));
        const started = ctx.now();
        const stop = ctx.schedule.every(() => {
          if (stopped) return stop();
          const f = tracker.sample(ctx.now(), {
            visible: env.visibilityState() === 'visible',
            hasFocus: env.hasFocus(),
            activeElementIsFrame: env.activeElementIsFrame(),
            interacted,
          });
          if (f) {
            emitFinding(f);
            stop();
          } else if (ctx.now() - started > (opts.focusWatchMs ?? 60_000)) {
            stop();
          }
        }, 1000);
        disposers.push(stop);
      }
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

export { createRealEnv } from './env.js';
export type { Env } from './env.js';
export { parseUA } from './ua.js';
export type { ParsedUA } from './ua.js';
export { detectPrivacyMode, PRIVACY_RELIABILITY } from './privacy.js';
export type { PrivacyResult } from './privacy.js';
export { ensureEnvironmentState, resetEnvironmentState } from './state.js';
export type { EnvironmentState } from './state.js';
export { HOSTED_PROFILES, matchHostedProfiles } from './hosted-profiles.js';
export { definitions as environmentDefinitions } from './definitions.js';
