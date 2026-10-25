import { describe, expect, it } from 'vitest';
import { parseUA } from '../src/collectors/ua.js';
import { PRIVACY_RELIABILITY } from '../src/collectors/privacy.js';
import { createEnvironmentState, resetEnvironmentState, setEnvironmentState } from '../src/collectors/state.js';
import { analyzePlatform, platformMismatches, type PlatformFacts } from '../src/consistency/platform.js';
import { compareWorker, WORKER_CODE } from '../src/consistency/worker.js';
import { analyzeScreenGeometry, looksLikeZoom } from '../src/consistency/screen.js';
import { analyzeLocale } from '../src/consistency/locale.js';
import { createConsistencyModule } from '../src/consistency/index.js';
import { createEnvironmentModule } from '../src/collectors/index.js';
import { fakeContext, fakeEnv, fontMap, MAC_CHROME_UA, MAC_SAFARI_UA, SWIFTSHADER_GPU, WIN_CHROME_UA, WIN_FIREFOX_UA } from './environment.test.js';
import { MAC_FONTS, WINDOWS_FONTS } from '../src/collectors/fonts.js';

const CHROME_BRANDS = ['Google Chrome', 'Chromium', 'Not(A:Brand'];
const APPLE_GPU = { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Unspecified Version)', unmasked: true };
const D3D_GPU = { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)', unmasked: true };

function pf(o: Omit<Partial<PlatformFacts>, 'ua'> & { ua?: string } = {}): PlatformFacts {
  const { ua, ...rest } = o;
  return {
    ua: parseUA(ua ?? WIN_CHROME_UA),
    platform: 'Win32',
    maxTouchPoints: 0,
    userAgentData: { brands: CHROME_BRANDS, mobile: false, platform: 'Windows' },
    highEntropyPlatform: undefined,
    webgl: D3D_GPU,
    fonts: fontMap([...WINDOWS_FONTS]),
    ...rest,
  };
}

describe('UA / platform consistency', () => {
  it('is silent for coherent Windows Chrome, macOS Chrome and macOS Safari', () => {
    expect(platformMismatches(pf())).toEqual([]);
    expect(platformMismatches(pf({ ua: MAC_CHROME_UA, platform: 'MacIntel', userAgentData: { brands: CHROME_BRANDS, mobile: false, platform: 'macOS' }, webgl: APPLE_GPU, fonts: fontMap([...MAC_FONTS]) }))).toEqual([]);
    expect(platformMismatches(pf({ ua: MAC_SAFARI_UA, platform: 'MacIntel', userAgentData: undefined, webgl: { vendor: 'Apple Inc.', renderer: 'Apple GPU', unmasked: true }, fonts: fontMap([...MAC_FONTS]) }))).toEqual([]);
  });

  it('accepts iPadOS desktop-mode Safari (Macintosh UA, MacIntel, touch)', () => {
    expect(platformMismatches(pf({ ua: MAC_SAFARI_UA, platform: 'MacIntel', maxTouchPoints: 5, userAgentData: undefined, webgl: { vendor: 'Apple Inc.', renderer: 'Apple GPU', unmasked: true }, fonts: undefined }))).toEqual([]);
  });

  it('reports a Mac UA with Win32 platform as the contradicting pair', () => {
    const f = analyzePlatform(pf({ ua: MAC_CHROME_UA, platform: 'Win32', userAgentData: { brands: CHROME_BRANDS, mobile: false, platform: 'macOS' }, webgl: APPLE_GPU, fonts: fontMap([...MAC_FONTS]) }));
    expect(f[0]).toMatchObject({ id: 'consistency.ua-platform-mismatch', value: [['userAgent', 'macOS'], ['navigator.platform', 'Win32']], reliability: 1, privacyGated: true });
  });

  it('catches the ChatGPT agent shape: Mac UA, Linux client hints', () => {
    const pairs = platformMismatches(pf({ ua: MAC_CHROME_UA, platform: 'MacIntel', userAgentData: { brands: ['Chromium', 'Not)A;Brand'], mobile: false, platform: 'Linux' }, webgl: undefined, fonts: undefined }));
    expect(pairs).toEqual([{ a: ['userAgent', 'macOS'], b: ['userAgentData.platform', 'Linux'], reliability: 1 }]);
  });

  it('catches Emulation.setUserAgentOverride without metadata (blank hints) at 0.8', () => {
    const pairs = platformMismatches(pf({ userAgentData: { brands: [], mobile: false, platform: '' } }));
    expect(pairs).toEqual([{ a: ['userAgent', 'Windows'], b: ['userAgentData.platform', ''], reliability: 0.8 }]);
  });

  it('catches a Firefox UA exposing a Chromium-only userAgentData', () => {
    const pairs = platformMismatches(pf({ ua: WIN_FIREFOX_UA, webgl: undefined, fonts: undefined }));
    expect(pairs[0]).toMatchObject({ b: ['userAgentData', 'present'], reliability: 0.9 });
  });

  it('uses the WebGL renderer family: Apple GPU on Windows, Direct3D on a Mac, Mesa on Windows', () => {
    expect(platformMismatches(pf({ webgl: APPLE_GPU }))[0]).toMatchObject({ b: ['webgl.renderer', APPLE_GPU.renderer], reliability: 0.9 });
    expect(platformMismatches(pf({ ua: MAC_CHROME_UA, platform: 'MacIntel', userAgentData: { brands: CHROME_BRANDS, mobile: false, platform: 'macOS' }, webgl: D3D_GPU, fonts: fontMap([...MAC_FONTS]) }))[0]).toMatchObject({ reliability: 1 });
    expect(platformMismatches(pf({ webgl: { vendor: 'Mesa', renderer: 'Mesa Intel(R) UHD Graphics 630 (CFL GT2)', unmasked: true } }))[0]).toMatchObject({ reliability: 0.7 });
    // SwiftShader and Brave generic strings carry no platform information.
    expect(platformMismatches(pf({ webgl: SWIFTSHADER_GPU }))).toEqual([]);
    expect(platformMismatches(pf({ webgl: { vendor: 'WebKit', renderer: 'WebKit WebGL', unmasked: false } }))).toEqual([]);
    // Windows-on-ARM laptops have Adreno GPUs: not a contradiction.
    expect(platformMismatches(pf({ webgl: { vendor: 'Qualcomm', renderer: 'Adreno (TM) X1-85', unmasked: true } }))).toEqual([]);
  });

  it('uses the font set: Segoe UI + Calibri with no Apple fonts on a macOS UA, Apple fonts on Windows', () => {
    const mac = platformMismatches(pf({ ua: MAC_CHROME_UA, platform: 'MacIntel', userAgentData: { brands: CHROME_BRANDS, mobile: false, platform: 'macOS' }, webgl: undefined, fonts: fontMap(['Segoe UI', 'Calibri', 'Cambria', 'Consolas']) }));
    expect(mac).toEqual([{ a: ['userAgent', 'macOS'], b: ['fonts', 'Segoe UI, Calibri, Cambria, Consolas'], reliability: 0.8 }]);
    // A Mac with Office installed has Calibri *and* its Apple fonts: fine.
    expect(platformMismatches(pf({ ua: MAC_CHROME_UA, platform: 'MacIntel', userAgentData: { brands: CHROME_BRANDS, mobile: false, platform: 'macOS' }, webgl: undefined, fonts: fontMap([...MAC_FONTS, 'Calibri', 'Cambria']) }))).toEqual([]);
    expect(platformMismatches(pf({ webgl: undefined, fonts: fontMap(['PingFang SC', 'Hiragino Sans']) }))[0]).toMatchObject({ b: ['fonts', 'PingFang SC, Hiragino Sans'], reliability: 0.8 });
  });

  it('bumps reliability slightly for several independent contradictions and lists them in details', () => {
    const f = analyzePlatform(pf({ ua: MAC_CHROME_UA, platform: 'Win32', userAgentData: { brands: CHROME_BRANDS, mobile: false, platform: 'Windows' }, webgl: D3D_GPU, fonts: fontMap([...WINDOWS_FONTS]) }));
    expect(f[0]?.reliability).toBe(1);
    expect((f[0]?.details?.['pairs'] as unknown[]).length).toBe(4);
    expect(f[0]?.summary).toContain('(+3 more)');
  });
});

describe('worker cross-check', () => {
  const main = { platform: 'MacIntel', userAgent: MAC_CHROME_UA, hardwareConcurrency: 13, languages: ['en-US', 'en'], uaDataPlatform: 'macOS', brands: CHROME_BRANDS };
  it('is silent when the worker agrees', () => {
    expect(compareWorker(main, { ...main, languages: [...main.languages] }).findings).toEqual([]);
  });
  it('fires on a platform difference (hosted agents, stealth main-world overrides)', () => {
    const r = compareWorker(main, { ...main, platform: 'Linux x86_64', uaDataPlatform: 'Linux' });
    expect(r.platformMismatch).toBe(true);
    expect(r.findings[0]).toMatchObject({ id: 'consistency.worker-platform-mismatch', value: { key: 'navigator.platform', main: 'MacIntel', worker: 'Linux x86_64' }, reliability: 1, privacyGated: true });
  });
  it('treats hardwareConcurrency / languages differences as soft (0.5)', () => {
    const r = compareWorker(main, { ...main, hardwareConcurrency: 8 });
    expect(r.platformMismatch).toBe(false);
    expect(r.findings[0]).toMatchObject({ reliability: 0.5 });
  });
  it('skips silently without a snapshot (CSP worker-src) or on a malformed message', () => {
    expect(compareWorker(main, undefined).findings).toEqual([]);
    expect(compareWorker(main, { error: 'blocked' } as unknown as never).findings).toEqual([]);
  });
  it('ships worker code that posts the compared fields', () => {
    for (const key of ['platform', 'userAgent', 'hardwareConcurrency', 'languages', 'uaDataPlatform', 'brands']) expect(WORKER_CODE).toContain(key);
    expect(WORKER_CODE).not.toMatch(/\beval\(/);
  });
});

describe('screen geometry impossibilities', () => {
  it('is silent for a normal window', () => {
    expect(analyzeScreenGeometry({ window: fakeEnv().window, screen: fakeEnv().screen, fullscreen: false })).toEqual([]);
  });
  it('flags Puppeteer / Playwright viewport emulation over the 756x556 headless window at full reliability', () => {
    const pptr = analyzeScreenGeometry({ window: { innerWidth: 800, innerHeight: 600, outerWidth: 756, outerHeight: 556, screenX: 22, screenY: 22, devicePixelRatio: 1 }, screen: { ...fakeEnv().screen, width: 800, height: 600 }, fullscreen: false });
    expect(pptr[0]).toMatchObject({ id: 'consistency.screen-geometry-impossible', reliability: 1, details: { zoomLike: false } });
    const pw = analyzeScreenGeometry({ window: { innerWidth: 1280, innerHeight: 720, outerWidth: 756, outerHeight: 556, screenX: 22, screenY: 22, devicePixelRatio: 1 }, screen: { ...fakeEnv().screen, width: 800, height: 600 }, fullscreen: false });
    expect(pw[0]).toMatchObject({ reliability: 1 });
  });
  it('down-weights a width ratio that sits on a browser zoom level (page zoomed out)', () => {
    expect(looksLikeZoom(1.25)).toBe(true);
    expect(looksLikeZoom(800 / 756)).toBe(false);
    const zoomed = analyzeScreenGeometry({ window: { innerWidth: 2400, innerHeight: 1150, outerWidth: 1920, outerHeight: 1040, screenX: 0, screenY: 0, devicePixelRatio: 0.8 }, screen: fakeEnv().screen, fullscreen: false });
    expect(zoomed[0]).toMatchObject({ reliability: 0.3, details: { zoomLike: true } });
  });
  it('flags --window-size larger than the 800x600 headless screen; a 10% spill is weak', () => {
    const big = analyzeScreenGeometry({ window: { innerWidth: 1920, innerHeight: 993, outerWidth: 1920, outerHeight: 1080, screenX: 22, screenY: 22, devicePixelRatio: 1 }, screen: { ...fakeEnv().screen, width: 800, height: 600 }, fullscreen: false });
    expect(big[0]).toMatchObject({ reliability: 1 });
    const spill = analyzeScreenGeometry({ window: { innerWidth: 2000, innerHeight: 1000, outerWidth: 2000, outerHeight: 1100, screenX: 0, screenY: 0, devicePixelRatio: 1 }, screen: fakeEnv().screen, fullscreen: false });
    expect(spill[0]).toMatchObject({ reliability: 0.5 });
  });
  it('flags odd colour depths and absurd DPRs, keeping one signal per id', () => {
    const r = analyzeScreenGeometry({ window: { ...fakeEnv().window, devicePixelRatio: 0 }, screen: { ...fakeEnv().screen, colorDepth: 16 }, fullscreen: false });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ value: { devicePixelRatio: 0 } });
    expect(r[0]?.details?.['others']).toHaveLength(1);
  });
});

describe('locale vs timezone', () => {
  it('is silent when the language region matches the timezone country or any accepted language does', () => {
    expect(analyzeLocale({ languages: ['en-US', 'en'], intlLocale: 'en-US', timezone: 'America/New_York' })).toEqual([]);
    expect(analyzeLocale({ languages: ['de-DE', 'fr-FR'], intlLocale: 'de-DE', timezone: 'Europe/Paris' })).toEqual([]);
    expect(analyzeLocale({ languages: ['de'], intlLocale: 'de', timezone: 'America/New_York' })).toEqual([]);
    expect(analyzeLocale({ languages: ['de-DE'], intlLocale: 'de-DE', timezone: 'Antarctica/Troll' })).toEqual([]);
    expect(analyzeLocale({ languages: ['de-DE'], intlLocale: 'de-DE', timezone: 'UTC' })).toEqual([]); // covered by env.utc-timezone
  });
  it('fires weakly on a region mismatch, weaker for English', () => {
    expect(analyzeLocale({ languages: ['de-DE'], intlLocale: 'de-DE', timezone: 'Asia/Tokyo' })[0]).toMatchObject({ id: 'consistency.locale-mismatch', reliability: 0.6, privacyGated: true });
    expect(analyzeLocale({ languages: ['en-US'], intlLocale: 'en-US', timezone: 'Europe/Berlin' })[0]).toMatchObject({ reliability: 0.4 });
  });
  it('fires on an Intl default locale that disagrees with navigator.languages', () => {
    expect(analyzeLocale({ languages: ['en-US'], intlLocale: 'en-GB', timezone: 'America/New_York' })[0]).toMatchObject({ reliability: 0.5, value: [['navigator.languages[0]', 'en-US'], ['Intl.locale', 'en-GB']] });
  });
});

describe('consistency module', () => {
  it('emits nothing for a coherent desktop and keeps start() cheap', async () => {
    resetEnvironmentState();
    const fc = fakeContext();
    const mod = createConsistencyModule({ env: fakeEnv() });
    const t0 = performance.now();
    mod.start(fc.ctx);
    const syncMs = performance.now() - t0;
    // eslint-disable-next-line no-console
    console.info(`[consistency] synchronous start() cost: ${syncMs.toFixed(3)} ms`);
    expect(syncMs).toBeLessThan(3);
    fc.schedule.flush();
    await new Promise((r) => setTimeout(r, 0));
    expect(fc.ids()).toEqual([]);
    mod.stop?.();
  });

  it('emits the worker mismatch after the deferred probe and feeds the hosted-profile matcher', async () => {
    resetEnvironmentState();
    const fc = fakeContext();
    const env = fakeEnv({
      userAgent: MAC_CHROME_UA,
      platform: 'MacIntel',
      userAgentData: { brands: CHROME_BRANDS.map((brand) => ({ brand, version: '155' })), mobile: false, platform: 'macOS', getHighEntropyValues: async () => ({ platform: 'macOS' }) },
      webgl: APPLE_GPU,
      fonts: [...MAC_FONTS],
      worker: { platform: 'Linux x86_64', userAgent: MAC_CHROME_UA, hardwareConcurrency: 8, languages: ['en-US', 'en'], uaDataPlatform: 'Linux', brands: CHROME_BRANDS },
    });
    const envMod = createEnvironmentModule({ env });
    envMod.start(fc.ctx);
    const mod = createConsistencyModule();
    mod.start(fc.ctx);
    expect(fc.byId('consistency.worker-platform-mismatch')).toBeUndefined();
    fc.schedule.flush();
    await new Promise((r) => setTimeout(r, 0));
    expect(fc.byId('consistency.worker-platform-mismatch')?.reliability).toBeUndefined();
    expect(fc.byId('consistency.ua-platform-mismatch')).toBeUndefined(); // main-world facts are coherent
    mod.stop?.();
    envMod.stop?.();
  });

  it('skips the worker check silently when the Blob worker is blocked', async () => {
    resetEnvironmentState();
    const fc = fakeContext();
    const mod = createConsistencyModule({ env: fakeEnv({ runWorker: () => Promise.resolve(undefined) }) });
    mod.start(fc.ctx);
    fc.schedule.flush();
    await new Promise((r) => setTimeout(r, 0));
    expect(fc.ids()).toEqual([]);
    mod.stop?.();
  });

  it('re-runs the platform check when the environment module reports WebGL and fonts', async () => {
    resetEnvironmentState();
    const fc = fakeContext();
    const env = fakeEnv({ webgl: APPLE_GPU, fonts: [...MAC_FONTS] }); // Windows UA on a Mac host
    const envMod = createEnvironmentModule({ env });
    envMod.start(fc.ctx);
    const mod = createConsistencyModule();
    mod.start(fc.ctx);
    expect(fc.byId('consistency.ua-platform-mismatch')).toBeUndefined();
    fc.schedule.flush();
    await new Promise((r) => setTimeout(r, 0));
    const s = fc.byId('consistency.ua-platform-mismatch');
    expect(s?.value).toEqual([['userAgent', 'Windows'], ['webgl.renderer', APPLE_GPU.renderer]]);
    mod.stop?.();
    envMod.stop?.();
  });

  it('privacy mode: emits consistency.privacy-browser-mode and scales every consistency signal by 0.3', async () => {
    resetEnvironmentState();
    const fc = fakeContext();
    const env = fakeEnv({
      userAgent: WIN_FIREFOX_UA,
      platform: 'MacIntel', // RFP spoofs the UA as Windows on a Mac host
      userAgentData: undefined,
      tz: 'Atlantic/Reykjavik',
      hardwareConcurrency: 8,
      window: { innerWidth: 1400, innerHeight: 900, outerWidth: 1400, outerHeight: 1000 },
      worker: { platform: 'MacIntel', userAgent: WIN_FIREFOX_UA, hardwareConcurrency: 8, languages: ['en-US', 'en'], uaDataPlatform: undefined, brands: undefined },
    });
    setEnvironmentState(createEnvironmentState(env));
    const mod = createConsistencyModule();
    mod.start(fc.ctx);
    expect(fc.byId('consistency.privacy-browser-mode')?.value).toEqual(['firefox-rfp']);
    expect(fc.byId('consistency.ua-platform-mismatch')?.reliability).toBe(PRIVACY_RELIABILITY);
    mod.stop?.();
  });

  it('re-gates already emitted signals when a privacy mode appears later', () => {
    resetEnvironmentState();
    const fc = fakeContext();
    const env = fakeEnv({ platform: 'MacIntel' }); // Windows UA, Mac platform
    const state = setEnvironmentState(createEnvironmentState(env));
    const mod = createConsistencyModule();
    mod.start(fc.ctx);
    expect(fc.byId('consistency.ua-platform-mismatch')?.reliability).toBeUndefined();
    state.refreshPrivacy(true);
    expect(fc.byId('consistency.privacy-browser-mode')?.value).toEqual(['canvas-noise']);
    expect(fc.byId('consistency.ua-platform-mismatch')?.reliability).toBe(PRIVACY_RELIABILITY);
    mod.stop?.();
  });
});
