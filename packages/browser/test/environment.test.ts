import { describe, expect, it } from 'vitest';
import { createRegistry, createSignal, SIGNAL_CATALOG, type Signal, type SignalInput } from '@necterai/core';
import { resolveConfig } from '../src/config.js';
import type { ModuleContext, Scheduler } from '../src/types.js';
import type { Env, EnvMediaDevice, EnvVoice, EnvWebGL, WorkerSnapshot } from '../src/collectors/env.js';
import { parseUA } from '../src/collectors/ua.js';
import { detectPrivacyMode, PRIVACY_RELIABILITY, privacyInputFromEnv } from '../src/collectors/privacy.js';
import { analyzeNavigator, navigatorInputFromEnv } from '../src/collectors/navigator.js';
import { analyzeGeometry, geometryInputFromEnv } from '../src/collectors/geometry.js';
import { analyzeGraphics, gpuFamily } from '../src/collectors/graphics.js';
import { analyzeFonts, LINUX_FONTS, MAC_FONTS, PROBE_FONTS, WINDOWS_FONTS } from '../src/collectors/fonts.js';
import { analyzeTimezone, localeRegion } from '../src/collectors/intl.js';
import { analyzeStorage } from '../src/collectors/storage.js';
import { analyzeChromeObject } from '../src/collectors/chrome-object.js';
import { analyzeMediaDevices, analyzeVoices } from '../src/collectors/media.js';
import { analyzePermissions, PERMISSION_NAMES, type PermissionOutcome } from '../src/collectors/permissions.js';
import { analyzeRafIntervals, createFocusTracker } from '../src/collectors/timing.js';
import { toSignalInput } from '../src/collectors/finding.js';
import { createEnvironmentModule } from '../src/collectors/index.js';
import { resetEnvironmentState } from '../src/collectors/state.js';

// ───────────────────────── fixtures ─────────────────────────

export const WIN_CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
export const MAC_CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
export const MAC_SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
export const LINUX_FIREFOX_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';
export const WIN_FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0';
export const LINUX_EDGE_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0';
export const HEADLESS_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/155.0.0.0 Safari/537.36';
export const ANDROID_WEBVIEW_UA = 'Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/125.0.0.0 Mobile Safari/537.36';

const D3D_GPU: EnvWebGL = { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', unmasked: true };
export const SWIFTSHADER_GPU: EnvWebGL = {
  vendor: 'Google Inc. (Google)',
  renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
  unmasked: true,
};
const APPLE_GPU: EnvWebGL = { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Unspecified Version)', unmasked: true };

export function fontMap(present: readonly string[]): Map<string, boolean> {
  return new Map(PROBE_FONTS.map((f) => [f, present.includes(f)]));
}

export interface FakeEnvOverrides extends Partial<Omit<Env, 'screen' | 'window'>> {
  screen?: Partial<Env['screen']>;
  window?: Partial<Env['window']>;
  tz?: string;
  webgl?: EnvWebGL | null | undefined;
  fonts?: readonly string[];
  devices?: EnvMediaDevice[];
  voices?: EnvVoice[] | undefined;
  permissions?: (name: string) => Promise<string> | undefined;
  worker?: WorkerSnapshot | undefined;
  canvas?: () => string | undefined;
  focused?: boolean;
}

/** A realistic headed Windows 11 Chrome 155 on a 1080p display unless overridden. */
export function fakeEnv(o: FakeEnvOverrides = {}): Env {
  const screen = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, availTop: 0, availLeft: 0, colorDepth: 24, pixelDepth: 24, ...o.screen };
  const window = { innerWidth: 1920, innerHeight: 947, outerWidth: 1920, outerHeight: 1040, screenX: 0, screenY: 0, devicePixelRatio: 1, ...o.window };
  const userAgent = o.userAgent ?? WIN_CHROME_UA;
  const fonts = o.fonts ?? [...WINDOWS_FONTS];
  const voices = o.voices === undefined && !('voices' in o) ? [{ name: 'Google US English', lang: 'en-US', localService: false }, { name: 'Microsoft David', lang: 'en-US', localService: true }] : o.voices;
  const platform = o.platform ?? 'Win32';
  const hwc = 'hardwareConcurrency' in o ? o.hardwareConcurrency : 8;
  const langs = o.languages ?? ['en-US', 'en'];
  const uad = 'userAgentData' in o ? o.userAgentData : {
    brands: [{ brand: 'Google Chrome', version: '155' }, { brand: 'Chromium', version: '155' }, { brand: 'Not(A:Brand', version: '24' }],
    mobile: false,
    platform: 'Windows',
    getHighEntropyValues: async () => ({ platform: 'Windows', architecture: 'x86', bitness: '64', model: '' }),
  };
  const base: Env = {
    userAgent,
    platform,
    language: o.language ?? langs[0] ?? 'en-US',
    languages: langs,
    hardwareConcurrency: hwc,
    deviceMemory: 'deviceMemory' in o ? o.deviceMemory : 8,
    maxTouchPoints: o.maxTouchPoints ?? 0,
    webdriver: 'webdriver' in o ? o.webdriver : false,
    userAgentData: uad,
    braveObject: o.braveObject ?? false,
    screen,
    window,
    chromeObject: 'chromeObject' in o ? o.chromeObject : { keys: ['loadTimes', 'csi', 'app'], runtime: false, app: true },
    secureContext: true,
    webdriverDescriptor: o.webdriverDescriptor ?? (() => 'native'),
    isBrave: o.isBrave ?? (() => undefined),
    fullscreen: o.fullscreen ?? (() => false),
    hasFocus: o.hasFocus ?? (() => o.focused ?? true),
    visibilityState: o.visibilityState ?? (() => 'visible'),
    activeElementIsFrame: o.activeElementIsFrame ?? (() => false),
    timezone: o.timezone ?? (() => o.tz ?? 'America/New_York'),
    intlLocale: o.intlLocale ?? (() => 'en-US'),
    historyLength: o.historyLength ?? (() => 3),
    referrer: o.referrer ?? (() => 'https://www.google.com/'),
    notificationPermission: o.notificationPermission ?? (() => 'default'),
    permissionsQuery: o.permissionsQuery ?? ((name) => (o.permissions ? o.permissions(name) : Promise.resolve('prompt'))),
    getWebGL: o.getWebGL ?? (() => ('webgl' in o ? o.webgl : D3D_GPU)),
    measureFonts: o.measureFonts ?? ((list) => new Map(list.map((f) => [f, fonts.includes(f)]))),
    enumerateDevices: o.enumerateDevices ?? (() => Promise.resolve(o.devices ?? [{ kind: 'audioinput', deviceId: '', label: '' }, { kind: 'audiooutput', deviceId: '', label: '' }])),
    speech:
      o.speech ??
      (() =>
        voices === undefined
          ? undefined
          : {
              getVoices: () => voices,
              onVoicesChanged: () => () => undefined,
            }),
    canvasHash: o.canvasHash ?? (o.canvas ?? (() => 'data:image/png;base64,stable')),
    runWorker:
      o.runWorker ??
      (() =>
        Promise.resolve(
          'worker' in o
            ? o.worker
            : {
                platform,
                userAgent,
                hardwareConcurrency: hwc,
                languages: [...langs],
                uaDataPlatform: uad?.platform,
                brands: uad?.brands.map((b) => b.brand),
              },
        )),
    on: o.on ?? (() => () => undefined),
    now: o.now ?? (() => performance.now()),
  };
  return base;
}

interface FakeScheduler extends Scheduler {
  /** Run every pending idle/timeout task (and tasks they schedule). */
  flush(): void;
  /** Deliver `n` animation frames spaced `intervalMs` apart. */
  frames(n: number, intervalMs: number | ((i: number) => number)): void;
  /** Fire every interval callback once. */
  tick(): void;
}

function fakeScheduler(): FakeScheduler {
  const queue: Array<() => void> = [];
  const intervals = new Set<() => void>();
  let rafs: Array<(t: number) => void> = [];
  let t = 1000;
  const track = (fn: () => void) => {
    queue.push(fn);
    return () => {
      const i = queue.indexOf(fn);
      if (i >= 0) queue.splice(i, 1);
    };
  };
  return {
    idle: (fn) => track(fn),
    timeout: (fn) => track(fn),
    every(fn) {
      intervals.add(fn);
      return () => intervals.delete(fn);
    },
    raf(fn) {
      rafs.push(fn);
      return () => {
        rafs = rafs.filter((f) => f !== fn);
      };
    },
    dispose() {
      queue.length = 0;
      intervals.clear();
      rafs = [];
    },
    flush() {
      let guard = 0;
      while (queue.length && guard++ < 1000) queue.shift()!();
    },
    frames(n, interval) {
      for (let i = 0; i < n; i++) {
        t += typeof interval === 'function' ? interval(i) : interval;
        const batch = rafs;
        rafs = [];
        for (const fn of batch) fn(t);
      }
    },
    tick() {
      for (const fn of [...intervals]) fn();
    },
  };
}

export interface FakeContext {
  ctx: ModuleContext;
  signals: Signal[];
  inputs: SignalInput[];
  schedule: FakeScheduler;
  byId(id: string): Signal | undefined;
  ids(): string[];
}

export function fakeContext(opts: { firstVisit?: boolean; modules?: Record<string, false | Record<string, unknown>>; now?: () => number } = {}): FakeContext {
  const registry = createRegistry(SIGNAL_CATALOG);
  const signals: Signal[] = [];
  const inputs: SignalInput[] = [];
  const schedule = fakeScheduler();
  const config = resolveConfig({});
  Object.assign(config.modules, opts.modules ?? {});
  let clock = 0;
  const now = opts.now ?? (() => (clock += 1));
  const ctx: ModuleContext = {
    config,
    session: { id: 'test', firstVisit: opts.firstVisit ?? false, startedAt: Date.now(), pageViews: 1 },
    registry,
    schedule,
    options: {},
    now,
    emit(input) {
      inputs.push(input);
      const s = createSignal(input, registry, { source: 'client', now });
      signals.push(s);
      return s;
    },
    retract() {},
    event() {},
    requestEvaluate() {},
    finalize() {},
    log() {},
    verdict: () => ({ sessionId: 'test', ts: 0, stage: 'load', automation: 0, score: 0, logit: 0, actorClass: 'unknown', classConfidence: 0, classScores: {}, deterministic: false, evidence: [], signalCount: 0, layers: [] }),
  };
  const latest = () => {
    const m = new Map<string, Signal>();
    for (const s of signals) m.set(s.id, s);
    return m;
  };
  return {
    ctx,
    signals,
    inputs,
    schedule,
    byId: (id) => latest().get(id),
    ids: () => [...latest().keys()],
  };
}

const ua = (s: string) => parseUA(s);

// ───────────────────────── UA parsing ─────────────────────────

describe('parseUA', () => {
  it('classifies desktop, mobile, webview and headless UAs', () => {
    expect(ua(WIN_CHROME_UA)).toMatchObject({ os: 'windows', engine: 'blink', browser: 'chrome', desktop: true, headless: false, chromiumMajor: 155 });
    expect(ua(MAC_SAFARI_UA)).toMatchObject({ os: 'macos', engine: 'webkit', browser: 'safari', desktop: true });
    expect(ua(LINUX_FIREFOX_UA)).toMatchObject({ os: 'linux', engine: 'gecko', browser: 'firefox', desktop: true, firefoxMajor: 128 });
    expect(ua(LINUX_EDGE_UA)).toMatchObject({ os: 'linux', engine: 'blink', browser: 'edge' });
    expect(ua(HEADLESS_UA)).toMatchObject({ headless: true, os: 'macos', browser: 'chrome' });
    expect(ua(ANDROID_WEBVIEW_UA)).toMatchObject({ os: 'android', mobile: true, webview: true, desktop: false });
    expect(ua('Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 300.0')).toMatchObject({ os: 'ios', webview: true, engine: 'webkit' });
  });
});

// ───────────────────────── privacy-browser mode ─────────────────────────

describe('privacy-browser detection', () => {
  it('is inactive for a stock Windows Chrome', () => {
    expect(detectPrivacyMode(privacyInputFromEnv(fakeEnv()))).toEqual({ active: false, kinds: [], evidence: [] });
  });
  it('detects Brave from navigator.brave', () => {
    const r = detectPrivacyMode(privacyInputFromEnv(fakeEnv({ braveObject: true })));
    expect(r.active).toBe(true);
    expect(r.kinds).toContain('brave');
  });
  it('detects the Firefox RFP bundle (Reykjavik + rounded window + hardwareConcurrency collapse)', () => {
    const env = fakeEnv({ userAgent: WIN_FIREFOX_UA, tz: 'Atlantic/Reykjavik', hardwareConcurrency: 4, window: { innerWidth: 1400, innerHeight: 900, outerWidth: 1400, outerHeight: 987 } });
    const r = detectPrivacyMode(privacyInputFromEnv(env));
    expect(r.kinds).toEqual(['firefox-rfp']);
    expect(r.evidence).toEqual(expect.arrayContaining(['tz Atlantic/Reykjavik', 'inner 1400x900 rounded to 200x100', 'hardwareConcurrency 4']));
  });
  it('does not call a Firefox user in a UTC timezone alone with an odd window size RFP', () => {
    const env = fakeEnv({ userAgent: WIN_FIREFOX_UA, tz: 'Europe/London', hardwareConcurrency: 4, window: { innerWidth: 1437, innerHeight: 913 } });
    expect(detectPrivacyMode(privacyInputFromEnv(env)).active).toBe(false);
  });
  it('tags Tor-style letterboxing when the rounded inner window sits inside a larger outer window', () => {
    const env = fakeEnv({ userAgent: WIN_FIREFOX_UA, tz: 'UTC', window: { innerWidth: 1000, innerHeight: 600, outerWidth: 1100, outerHeight: 800 } });
    expect(detectPrivacyMode(privacyInputFromEnv(env)).kinds).toEqual(['firefox-rfp', 'tor-letterboxing']);
  });
  it('detects Safari advanced protection from screen == viewport and screenX/Y 0', () => {
    const env = fakeEnv({ userAgent: MAC_SAFARI_UA, platform: 'MacIntel', screen: { width: 1440, height: 900 }, window: { innerWidth: 1440, innerHeight: 900, outerWidth: 1440, outerHeight: 900, screenX: 0, screenY: 0 } });
    expect(detectPrivacyMode(privacyInputFromEnv(env)).kinds).toEqual(['safari-advanced-protection']);
  });
  it('flags canvas noise between two reads', () => {
    expect(detectPrivacyMode(privacyInputFromEnv(fakeEnv(), true)).kinds).toEqual(['canvas-noise']);
  });
  it('applies the 0.3 multiplier only to gated findings', () => {
    expect(toSignalInput({ id: 'env.software-gpu', summary: 's', privacyGated: true }, true).reliability).toBe(PRIVACY_RELIABILITY);
    expect(toSignalInput({ id: 'env.software-gpu', summary: 's', privacyGated: true, reliability: 0.5 }, true).reliability).toBe(0.15);
    expect(toSignalInput({ id: 'env.webdriver', summary: 's' }, true).reliability).toBeUndefined();
  });
});

// ───────────────────────── navigator ─────────────────────────

describe('navigator collector', () => {
  const run = (env: Env, privacy = false) => analyzeNavigator(navigatorInputFromEnv(env, parseUA(env.userAgent), privacy));

  it('emits nothing for a stock browser', () => {
    expect(run(fakeEnv())).toEqual([]);
  });
  it('emits env.webdriver with value true', () => {
    const f = run(fakeEnv({ webdriver: true }));
    expect(f).toEqual([{ id: 'env.webdriver', summary: 'navigator.webdriver === true', value: true }]);
  });
  it('reports a deleted / redefined webdriver descriptor on Chromium as prototype tampering', () => {
    expect(run(fakeEnv({ webdriver: undefined, webdriverDescriptor: () => 'missing' }))[0]).toMatchObject({ id: 'probe.prototype-tampered', value: 'missing', reliability: 0.7 });
    expect(run(fakeEnv({ webdriver: false, webdriverDescriptor: () => 'own' }))[0]).toMatchObject({ id: 'probe.prototype-tampered', value: 'own' });
    // Firefox has its own prototype layout: never judged.
    expect(run(fakeEnv({ userAgent: WIN_FIREFOX_UA, webdriverDescriptor: () => 'missing' }))).toEqual([]);
  });
  it('emits headless brand and headless UA tells', () => {
    const env = fakeEnv({
      userAgent: HEADLESS_UA,
      userAgentData: { brands: [{ brand: 'Not:A-Brand', version: '8' }, { brand: 'Chromium', version: '156' }, { brand: 'HeadlessChrome', version: '156' }], mobile: false, platform: 'macOS' },
    });
    const ids = run(env).map((f) => f.id);
    expect(ids).toContain('env.headless-brand');
    expect(ids).toContain('declared.headless-ua');
    expect(run(env).find((f) => f.id === 'declared.headless-ua')?.value).toBe('HeadlessChrome/155.0.0.0');
  });
  it('fires env.low-hardware only on a Blink desktop with both values <= 2', () => {
    expect(run(fakeEnv({ hardwareConcurrency: 2, deviceMemory: 2 }))[0]?.id).toBe('env.low-hardware');
    expect(run(fakeEnv({ hardwareConcurrency: 2, deviceMemory: 4 }))).toEqual([]);
    // WebKit caps hardwareConcurrency and has no deviceMemory: must never fire.
    expect(run(fakeEnv({ userAgent: MAC_SAFARI_UA, platform: 'MacIntel', hardwareConcurrency: 2, deviceMemory: 2, userAgentData: undefined }))).toEqual([]);
    // Privacy mode (Brave farbling / Firefox tiers) suppresses it.
    expect(run(fakeEnv({ hardwareConcurrency: 2, deviceMemory: 2 }), true)).toEqual([]);
    // Android phones genuinely have few cores.
    expect(run(fakeEnv({ userAgent: ANDROID_WEBVIEW_UA, hardwareConcurrency: 2, deviceMemory: 2 }))).toEqual([]);
  });
});

// ───────────────────────── geometry ─────────────────────────

describe('geometry collector', () => {
  const run = (env: Env, kinds: string[] = []) => analyzeGeometry(geometryInputFromEnv(env, parseUA(env.userAgent), kinds));

  it('emits nothing for a headed 1080p Chrome window', () => {
    expect(run(fakeEnv())).toEqual([]);
  });
  it('matches the Playwright default viewport exactly', () => {
    const f = run(fakeEnv({ window: { innerWidth: 1280, innerHeight: 720, outerWidth: 1280, outerHeight: 807 } }));
    expect(f.find((x) => x.id === 'env.default-automation-viewport')).toMatchObject({ value: '1280x720' });
    expect(f.find((x) => x.id === 'env.default-automation-viewport')?.reliability).toBeUndefined();
  });
  it('matches the headless 800x600 screen at full reliability but a real 1280x720 display at 0.5', () => {
    expect(run(fakeEnv({ screen: { width: 800, height: 600 }, window: { innerWidth: 756, innerHeight: 469, outerWidth: 756, outerHeight: 556 } }))[0]).toMatchObject({ id: 'env.default-automation-viewport', value: '800x600', details: { match: 'screen' } });
    const laptop = run(fakeEnv({ screen: { width: 1280, height: 720, availHeight: 680 }, window: { innerWidth: 1280, innerHeight: 609, outerWidth: 1280, outerHeight: 680 } }));
    expect(laptop[0]).toMatchObject({ id: 'env.default-automation-viewport', reliability: 0.5 });
  });
  it('counts 1366x768 only when outerHeight === innerHeight', () => {
    expect(run(fakeEnv({ screen: { width: 1366, height: 768, availHeight: 728 }, window: { innerWidth: 1366, innerHeight: 657, outerWidth: 1366, outerHeight: 728 } }))).toEqual([]);
    const auto = run(fakeEnv({ screen: { width: 1366, height: 768, availWidth: 1366, availHeight: 768 }, window: { innerWidth: 1366, innerHeight: 768, outerWidth: 1366, outerHeight: 768 } }));
    expect(auto.map((f) => f.id)).toEqual(['env.default-automation-viewport', 'env.no-window-chrome', 'env.screen-equals-viewport']);
  });
  it('emits env.no-window-chrome for outer == inner on a focused desktop Chrome, not when fullscreen or unfocused', () => {
    const env = fakeEnv({ window: { innerWidth: 1600, innerHeight: 900, outerWidth: 1600, outerHeight: 900 } });
    expect(run(env).map((f) => f.id)).toEqual(['env.no-window-chrome']);
    expect(run(fakeEnv({ window: { innerWidth: 1600, innerHeight: 900, outerWidth: 1600, outerHeight: 900 }, fullscreen: () => true }))).toEqual([]);
    expect(run(fakeEnv({ window: { innerWidth: 1600, innerHeight: 900, outerWidth: 1600, outerHeight: 900 }, focused: false }))).toEqual([]);
  });
  it('never fires window-chrome tells on Safari (outer == inner by design) or WebViews', () => {
    const safari = fakeEnv({ userAgent: MAC_SAFARI_UA, platform: 'MacIntel', screen: { width: 1440, height: 900 }, window: { innerWidth: 1440, innerHeight: 900, outerWidth: 1440, outerHeight: 900 } });
    expect(run(safari, ['safari-advanced-protection'])).toEqual([]);
    const webview = fakeEnv({ userAgent: ANDROID_WEBVIEW_UA, screen: { width: 412, height: 915 }, window: { innerWidth: 412, innerHeight: 915, outerWidth: 412, outerHeight: 915 } });
    expect(run(webview)).toEqual([]);
  });
});

// ───────────────────────── graphics ─────────────────────────

describe('graphics collector', () => {
  const run = (webgl: EnvWebGL | null | undefined, uaStr = WIN_CHROME_UA, brave = false) => analyzeGraphics({ ua: parseUA(uaStr), webgl, brave });

  it('fires env.software-gpu for SwiftShader, llvmpipe and Mesa OffScreen', () => {
    expect(run(SWIFTSHADER_GPU)[0]).toMatchObject({ id: 'env.software-gpu', privacyGated: true });
    expect(run({ vendor: 'Mesa', renderer: 'llvmpipe (LLVM 15.0.7, 256 bits)', unmasked: true })[0]?.id).toBe('env.software-gpu');
    expect(run({ vendor: 'Brian Paul', renderer: 'Mesa OffScreen', unmasked: true })[0]?.id).toBe('env.software-gpu');
    expect(run({ vendor: 'Google Inc. (Microsoft)', renderer: 'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0)', unmasked: true })[0]).toMatchObject({ reliability: 0.7 });
  });
  it('does not fire for a hardware GPU', () => {
    expect(run(D3D_GPU)).toEqual([]);
    expect(run(APPLE_GPU, MAC_CHROME_UA)).toEqual([]);
  });
  it('treats missing WebGL on a desktop Chrome as GPU disabled (0.7), nothing on Firefox', () => {
    expect(run(null)[0]).toMatchObject({ id: 'env.software-gpu', value: null, reliability: 0.7 });
    expect(run(null, WIN_FIREFOX_UA)).toEqual([]);
    expect(run(undefined)).toEqual([]);
  });
  it('Brave generic strings never fire', () => {
    expect(run({ vendor: 'Google Inc.', renderer: 'ANGLE (Generic Renderer)', unmasked: true }, WIN_CHROME_UA, true)).toEqual([]);
    expect(run(SWIFTSHADER_GPU, WIN_CHROME_UA, true)).toEqual([]);
  });
  it('maps renderer strings to GPU families', () => {
    expect(gpuFamily(D3D_GPU)).toBe('direct3d');
    expect(gpuFamily(APPLE_GPU)).toBe('apple');
    expect(gpuFamily(SWIFTSHADER_GPU)).toBe('software');
    expect(gpuFamily({ vendor: 'Intel', renderer: 'Mesa Intel(R) UHD Graphics 630 (CFL GT2)', unmasked: true })).toBe('mesa-linux');
    expect(gpuFamily({ vendor: 'Qualcomm', renderer: 'Adreno (TM) 740', unmasked: true })).toBe('mobile');
    expect(gpuFamily({ vendor: 'WebKit', renderer: 'WebKit WebGL', unmasked: false })).toBe('generic');
  });
});

// ───────────────────────── fonts / intl / storage / chrome ─────────────────────────

describe('fonts collector', () => {
  it('fires container-fonts when only Linux fonts exist under a Windows UA', () => {
    const f = analyzeFonts(fontMap(['DejaVu Sans', 'Liberation Sans']), parseUA(WIN_CHROME_UA));
    expect(f[0]).toMatchObject({ id: 'env.container-fonts', value: ['DejaVu Sans', 'Liberation Sans'], privacyGated: true });
  });
  it('fires at reduced reliability for a trimmed stock font set and not for a full one', () => {
    expect(analyzeFonts(fontMap(['Segoe UI', 'Calibri']), parseUA(WIN_CHROME_UA))[0]).toMatchObject({ reliability: 0.5 });
    expect(analyzeFonts(fontMap([...WINDOWS_FONTS]), parseUA(WIN_CHROME_UA))).toEqual([]);
    expect(analyzeFonts(fontMap([...MAC_FONTS]), parseUA(MAC_CHROME_UA))).toEqual([]);
    expect(analyzeFonts(fontMap([...MAC_FONTS, 'Calibri']), parseUA(MAC_CHROME_UA))).toEqual([]);
  });
  it('treats a bare Linux container differently from a Linux desktop', () => {
    expect(analyzeFonts(fontMap(['DejaVu Sans']), parseUA(LINUX_FIREFOX_UA))[0]).toMatchObject({ id: 'env.container-fonts', reliability: 0.5 });
    expect(analyzeFonts(fontMap([...LINUX_FONTS]), parseUA(LINUX_FIREFOX_UA))).toEqual([]);
  });
  it('skips mobile UAs and unmeasurable canvases', () => {
    expect(analyzeFonts(fontMap([]), parseUA(ANDROID_WEBVIEW_UA))).toEqual([]);
    expect(analyzeFonts(undefined, parseUA(WIN_CHROME_UA))).toEqual([]);
  });
});

describe('timezone collector', () => {
  it('fires for UTC / Reykjavik with a non-UTC-region locale and discounts bare language tags', () => {
    expect(analyzeTimezone('UTC', 'en-US')[0]).toMatchObject({ id: 'env.utc-timezone', value: { timezone: 'UTC', language: 'en-US' }, privacyGated: true });
    expect(analyzeTimezone('Atlantic/Reykjavik', 'de-DE')[0]?.id).toBe('env.utc-timezone');
    expect(analyzeTimezone('Etc/UTC', 'en')[0]).toMatchObject({ reliability: 0.6 });
  });
  it('does not fire for English UTC-region locales or normal zones', () => {
    expect(analyzeTimezone('UTC', 'en-GB')).toEqual([]);
    expect(analyzeTimezone('UTC', 'en-IE')).toEqual([]);
    expect(analyzeTimezone('Europe/London', 'en-GB')).toEqual([]);
    expect(analyzeTimezone(undefined, 'en-US')).toEqual([]);
  });
  it('extracts locale regions', () => {
    expect(localeRegion('en-US')).toBe('US');
    expect(localeRegion('zh-Hant-TW')).toBe('TW');
    expect(localeRegion('es-419')).toBe('419');
    expect(localeRegion('de')).toBeUndefined();
  });
});

describe('storage and chrome object collectors', () => {
  it('emits first-visit-amnesia only for a fresh profile with no history or referrer', () => {
    expect(analyzeStorage(true, 1, '')[0]).toMatchObject({ id: 'env.first-visit-amnesia' });
    expect(analyzeStorage(true, 1, 'https://x.example/')).toEqual([]);
    expect(analyzeStorage(true, 4, '')).toEqual([]);
    expect(analyzeStorage(false, 1, '')).toEqual([]);
  });
  it('flags a missing window.chrome on a desktop Chrome UA only', () => {
    expect(analyzeChromeObject(undefined, parseUA(WIN_CHROME_UA))[0]?.id).toBe('env.missing-chrome-runtime');
    // Research correction: chrome.runtime absent with chrome.app present is normal headed Chrome.
    expect(analyzeChromeObject({ keys: ['loadTimes', 'csi', 'app'], runtime: false, app: true }, parseUA(WIN_CHROME_UA))).toEqual([]);
    expect(analyzeChromeObject(undefined, parseUA(WIN_FIREFOX_UA))).toEqual([]);
    expect(analyzeChromeObject(undefined, parseUA(ANDROID_WEBVIEW_UA))).toEqual([]);
    expect(analyzeChromeObject(undefined, parseUA('Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/155.0.0.0 Mobile/15E148 Safari/604.1'))).toEqual([]);
  });
});

// ───────────────────────── media / voices / permissions ─────────────────────────

describe('media and voices collectors', () => {
  it('fires env.no-media-devices on an empty list, 0.6 on WebKit', () => {
    expect(analyzeMediaDevices([], parseUA(WIN_CHROME_UA))[0]).toMatchObject({ id: 'env.no-media-devices', privacyGated: true });
    expect(analyzeMediaDevices([], parseUA(MAC_SAFARI_UA))[0]).toMatchObject({ reliability: 0.6 });
    expect(analyzeMediaDevices([{ kind: 'audiooutput', deviceId: '', label: '' }], parseUA(WIN_CHROME_UA))).toEqual([]);
    expect(analyzeMediaDevices(undefined, parseUA(WIN_CHROME_UA))).toEqual([]);
  });
  it('fires env.no-voices on an empty voice list, 0.5 on Firefox', () => {
    expect(analyzeVoices([], parseUA(WIN_CHROME_UA)).findings[0]).toMatchObject({ id: 'env.no-voices' });
    expect(analyzeVoices([], parseUA(WIN_FIREFOX_UA)).findings[0]).toMatchObject({ reliability: 0.5 });
  });
  it('records missing Google voices on a Chrome UA as informational detail', () => {
    const r = analyzeVoices([{ name: 'Samantha', lang: 'en-US', localService: true }], parseUA(MAC_CHROME_UA));
    expect(r.findings[0]).toMatchObject({ id: 'env.no-google-voices', value: { total: 1, google: 0 } });
    expect(analyzeVoices([{ name: 'Google US English', lang: 'en-US', localService: false }], parseUA(MAC_CHROME_UA)).findings).toEqual([]);
  });
});

describe('permissions collector', () => {
  const outcomes = (fill: PermissionOutcome, overrides: Record<string, PermissionOutcome> = {}) =>
    new Map(PERMISSION_NAMES.map((n) => [n, overrides[n] ?? fill] as [string, PermissionOutcome]));

  it('flags the headless-shell denied/prompt pair on Chromium only', () => {
    const r = analyzePermissions({ ua: parseUA(WIN_CHROME_UA), notificationPermission: 'denied', outcomes: outcomes('prompt') });
    expect(r.findings[0]).toMatchObject({ id: 'env.permissions-inconsistent' });
    expect(analyzePermissions({ ua: parseUA(WIN_CHROME_UA), notificationPermission: 'denied', outcomes: outcomes('denied') }).findings).toEqual([]);
    expect(analyzePermissions({ ua: parseUA(WIN_CHROME_UA), notificationPermission: 'default', outcomes: outcomes('prompt') }).findings).toEqual([]);
    expect(analyzePermissions({ ua: parseUA(WIN_FIREFOX_UA), notificationPermission: 'denied', outcomes: outcomes('prompt') }).findings).toEqual([]);
  });
  it('reports the ChatGPT-agent style query failure rate', () => {
    const r = analyzePermissions({ ua: parseUA(MAC_CHROME_UA), notificationPermission: 'default', outcomes: outcomes('rejected', { notifications: 'denied' }) });
    expect(r.findings[0]).toMatchObject({ id: 'env.permissions-query-failing', value: { rejected: 12, total: 13 } });
    expect(r.failRate).toBeCloseTo(12 / 13);
    expect(analyzePermissions({ ua: parseUA(MAC_CHROME_UA), notificationPermission: 'default', outcomes: outcomes('prompt', { midi: 'rejected' }) }).findings).toEqual([]);
  });
});

// ───────────────────────── timing ─────────────────────────

describe('timing collectors', () => {
  it('accepts 60/120/144 Hz cadences and rejects an off-grid one', () => {
    const steady = (ms: number) => Array.from({ length: 29 }, () => ms);
    expect(analyzeRafIntervals(steady(16.67)).findings).toEqual([]);
    expect(analyzeRafIntervals(steady(8.33)).findings).toEqual([]);
    expect(analyzeRafIntervals(steady(6.94)).matchedHz).toBe(144);
    expect(analyzeRafIntervals(steady(33.3)).matchedHz).toBe(30);
    const off = analyzeRafIntervals(steady(25));
    expect(off.findings[0]).toMatchObject({ id: 'env.raf-no-vsync', value: 25 });
  });
  it('abandons samples with a hidden-tab gap or too few frames', () => {
    expect(analyzeRafIntervals([16.7, 16.7, 400, 16.7, 16.7, 16.7, 16.7, 16.7, 16.7, 16.7, 16.7]).findings).toEqual([]);
    expect(analyzeRafIntervals([25, 25, 25]).findings).toEqual([]);
  });
  it('emits document-unfocused after 3 s of visible, interacted, unfocused time and resets on focus', () => {
    const t = createFocusTracker(3000);
    const s = { visible: true, hasFocus: false, activeElementIsFrame: false, interacted: true };
    expect(t.sample(0, s)).toBeUndefined();
    expect(t.sample(2000, s)).toBeUndefined();
    expect(t.sample(3100, s)).toMatchObject({ id: 'env.document-unfocused' });
    expect(t.sample(4000, { ...s, hasFocus: true })).toBeUndefined();
    expect(t.sample(8000, s)).toBeUndefined(); // restarted the clock
    // A payment iframe holding focus never counts.
    const t2 = createFocusTracker(3000);
    t2.sample(0, { ...s, activeElementIsFrame: true });
    expect(t2.sample(5000, { ...s, activeElementIsFrame: true })).toBeUndefined();
    // No interaction: never counts.
    const t3 = createFocusTracker(3000);
    t3.sample(0, { ...s, interacted: false });
    expect(t3.sample(5000, { ...s, interacted: false })).toBeUndefined();
  });
});

// ───────────────────────── module integration (jsdom) ─────────────────────────

describe('environment module', () => {
  it('emits nothing suspicious for a stock headed Chrome and stays under the synchronous budget', () => {
    resetEnvironmentState();
    const fc = fakeContext();
    const mod = createEnvironmentModule({ env: fakeEnv() });
    // warm up module code paths once so the measurement reflects steady-state cost
    mod.start(fc.ctx);
    mod.stop?.();
    resetEnvironmentState();
    const fc2 = fakeContext();
    const mod2 = createEnvironmentModule({ env: fakeEnv() });
    const t0 = performance.now();
    mod2.start(fc2.ctx);
    const syncMs = performance.now() - t0;
    // eslint-disable-next-line no-console
    console.info(`[environment] synchronous start() cost: ${syncMs.toFixed(3)} ms`);
    expect(syncMs).toBeLessThan(3);
    expect(fc2.ids()).toEqual([]);
    fc2.schedule.flush();
    expect(fc2.ids()).toEqual([]);
    mod2.stop?.();
  });

  it('emits the headless bundle for a Puppeteer-style headless shell and finalises on the UA token', async () => {
    resetEnvironmentState();
    const fc = fakeContext({ firstVisit: true });
    const env = fakeEnv({
      userAgent: HEADLESS_UA,
      platform: 'MacIntel',
      webdriver: true,
      userAgentData: { brands: [{ brand: 'Not:A-Brand', version: '8' }, { brand: 'Chromium', version: '156' }, { brand: 'HeadlessChrome', version: '156' }], mobile: false, platform: 'macOS' },
      screen: { width: 800, height: 600, availWidth: 800, availHeight: 600 },
      window: { innerWidth: 800, innerHeight: 600, outerWidth: 800, outerHeight: 600 },
      chromeObject: undefined,
      notificationPermission: () => 'denied',
      webgl: SWIFTSHADER_GPU,
      fonts: ['DejaVu Sans'],
      devices: [],
      voices: [],
      historyLength: () => 1,
      referrer: () => '',
      tz: 'UTC',
    });
    const mod = createEnvironmentModule({ env });
    mod.start(fc.ctx);
    const sync = fc.ids();
    expect(sync).toEqual(
      expect.arrayContaining(['env.webdriver', 'env.headless-brand', 'declared.headless-ua', 'env.default-automation-viewport', 'env.no-window-chrome', 'env.screen-equals-viewport', 'env.utc-timezone', 'env.first-visit-amnesia', 'env.missing-chrome-runtime']),
    );
    fc.schedule.flush();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    const all = fc.ids();
    expect(all).toEqual(expect.arrayContaining(['env.software-gpu', 'env.container-fonts', 'env.no-media-devices', 'env.no-voices', 'env.permissions-inconsistent']));
    expect(fc.byId('env.software-gpu')?.reliability).toBeUndefined(); // no privacy mode: full weight
    // Every environment signal stays non-deterministic (only the declared UA token is).
    const registry = createRegistry(SIGNAL_CATALOG);
    for (const s of fc.signals) {
      if (s.id === 'declared.headless-ua') continue;
      expect(Math.abs(registry.get(s.id)?.automation ?? 0)).toBeLessThan(6);
    }
    mod.stop?.();
  });

  it('Firefox RFP sets privacy mode and lowers container tells to 0.3', async () => {
    resetEnvironmentState();
    const fc = fakeContext({ modules: { consistency: false } });
    const env = fakeEnv({
      userAgent: WIN_FIREFOX_UA,
      tz: 'Atlantic/Reykjavik',
      hardwareConcurrency: 4,
      deviceMemory: undefined,
      userAgentData: undefined,
      window: { innerWidth: 1400, innerHeight: 900, outerWidth: 1400, outerHeight: 1000 },
      webgl: SWIFTSHADER_GPU,
      fonts: ['DejaVu Sans'],
      voices: [],
    });
    const mod = createEnvironmentModule({ env });
    mod.start(fc.ctx);
    expect(fc.byId('consistency.privacy-browser-mode')?.value).toEqual(['firefox-rfp']);
    expect(fc.byId('env.utc-timezone')?.reliability).toBe(PRIVACY_RELIABILITY);
    expect(fc.byId('env.low-hardware')).toBeUndefined();
    fc.schedule.flush();
    await new Promise((r) => setTimeout(r, 0));
    expect(fc.byId('env.software-gpu')?.reliability).toBe(PRIVACY_RELIABILITY);
    expect(fc.byId('env.container-fonts')?.reliability).toBe(PRIVACY_RELIABILITY);
    expect(fc.byId('env.no-voices')?.reliability).toBe(0.15); // 0.5 Firefox x 0.3
    mod.stop?.();
  });

  it('re-emits gated signals at 0.3 when canvas noise reveals a privacy mode after the fact', async () => {
    resetEnvironmentState();
    const fc = fakeContext();
    let reads = 0;
    const env = fakeEnv({ tz: 'UTC', canvas: () => `hash-${reads++}`, webgl: SWIFTSHADER_GPU });
    const mod = createEnvironmentModule({ env });
    mod.start(fc.ctx);
    expect(fc.byId('env.utc-timezone')?.reliability).toBeUndefined();
    fc.schedule.flush();
    await new Promise((r) => setTimeout(r, 0));
    expect(fc.byId('env.utc-timezone')?.reliability).toBe(PRIVACY_RELIABILITY);
    expect(fc.byId('env.software-gpu')?.reliability).toBe(PRIVACY_RELIABILITY);
    mod.stop?.();
  });

  it('Brave: generic GPU and farbled values produce no software-gpu or low-hardware signal', async () => {
    resetEnvironmentState();
    const fc = fakeContext();
    const env = fakeEnv({ braveObject: true, isBrave: () => Promise.resolve(true), webgl: { vendor: 'Google Inc.', renderer: 'ANGLE (Generic)', unmasked: true }, hardwareConcurrency: 2, deviceMemory: 2 });
    const mod = createEnvironmentModule({ env });
    mod.start(fc.ctx);
    fc.schedule.flush();
    await new Promise((r) => setTimeout(r, 0));
    expect(fc.byId('env.software-gpu')).toBeUndefined();
    expect(fc.byId('env.low-hardware')).toBeUndefined();
    mod.stop?.();
  });

  it('Safari with outer == inner never fires env.no-window-chrome', () => {
    resetEnvironmentState();
    const fc = fakeContext();
    const env = fakeEnv({
      userAgent: MAC_SAFARI_UA,
      platform: 'MacIntel',
      userAgentData: undefined,
      screen: { width: 1440, height: 900, availWidth: 1440, availHeight: 900 },
      window: { innerWidth: 1440, innerHeight: 900, outerWidth: 1440, outerHeight: 900, screenX: 0, screenY: 0 },
      chromeObject: undefined,
    });
    const mod = createEnvironmentModule({ env });
    mod.start(fc.ctx);
    expect(fc.byId('env.no-window-chrome')).toBeUndefined();
    expect(fc.byId('env.screen-equals-viewport')).toBeUndefined();
    expect(fc.byId('env.missing-chrome-runtime')).toBeUndefined();
    mod.stop?.();
  });

  it('runs the rAF probe and the focus watcher through the scheduler', async () => {
    resetEnvironmentState();
    let clock = 0;
    const fc = fakeContext({ now: () => clock });
    const listeners = new Map<string, (e: Event) => void>();
    const env = fakeEnv({
      focused: false,
      on: (type, fn) => {
        listeners.set(type, fn);
        return () => listeners.delete(type);
      },
    });
    const mod = createEnvironmentModule({ env });
    mod.start(fc.ctx);
    fc.schedule.flush();
    await new Promise((r) => setTimeout(r, 0));
    fc.schedule.frames(40, 25); // 40 Hz: no display refreshes at that rate
    expect(fc.byId('env.raf-no-vsync')).toMatchObject({ value: 25 });
    listeners.get('pointerdown')?.(new Event('pointerdown'));
    for (clock = 1000; clock <= 6000; clock += 1000) fc.schedule.tick();
    expect(fc.byId('env.document-unfocused')).toBeDefined();
    mod.stop?.();
  });

  it('emits env.chromium-build for Chrome for Testing brands without Google voices', async () => {
    resetEnvironmentState();
    const fc = fakeContext();
    const env = fakeEnv({
      userAgentData: { brands: [{ brand: 'Not:A-Brand', version: '8' }, { brand: 'Chromium', version: '156' }], mobile: false, platform: 'Windows' },
      voices: [{ name: 'Microsoft David', lang: 'en-US', localService: true }],
    });
    const mod = createEnvironmentModule({ env });
    mod.start(fc.ctx);
    fc.schedule.flush();
    await new Promise((r) => setTimeout(r, 0));
    expect(fc.byId('env.chromium-build')?.reliability).toBeUndefined();
    expect(fc.byId('env.no-google-voices')).toBeDefined();
    mod.stop?.();
  });
});
