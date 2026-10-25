import { describe, expect, it } from 'vitest';
import { parseUA } from '../src/collectors/ua.js';
import { HOSTED_PROFILES, hostedFinding, matchHostedProfiles, type HostedFacts } from '../src/collectors/hosted-profiles.js';
import { createEnvironmentModule, hostedFactsFromState } from '../src/collectors/index.js';
import { createEnvironmentState, resetEnvironmentState } from '../src/collectors/state.js';
import { fakeContext, fakeEnv, fontMap, LINUX_EDGE_UA, LINUX_FIREFOX_UA, MAC_CHROME_UA, SWIFTSHADER_GPU, WIN_CHROME_UA } from './environment.test.js';

function facts(o: Omit<Partial<HostedFacts>, 'ua'> & { ua?: string } = {}): HostedFacts {
  const { ua, ...rest } = o;
  return {
    ua: parseUA(ua ?? WIN_CHROME_UA),
    screenWidth: 1920,
    screenHeight: 1080,
    innerWidth: 1920,
    innerHeight: 947,
    hardwareConcurrency: 8,
    platform: 'Win32',
    uaDataPlatform: 'Windows',
    timezone: 'America/New_York',
    workerPlatformMismatch: false,
    webgl: { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', unmasked: true },
    permissionsQueryFailRate: 0,
    permissionsDeniedRate: 0,
    fonts: undefined,
    ...rest,
  };
}

describe('hosted-agent profiles', () => {
  it('ships the five vendor profiles from the research plus Magentic-UI', () => {
    expect(HOSTED_PROFILES.map((p) => p.id)).toEqual(['chatgpt-agent', 'browser-use-cloud', 'skyvern', 'browserbase', 'anthropic-reference-container', 'magentic-ui']);
  });

  it('matches the ChatGPT agent from 1280x960 + 13 cores + Mac UA with Linux hints and attributes OpenAI', () => {
    const f = facts({ ua: MAC_CHROME_UA, platform: 'MacIntel', uaDataPlatform: 'Linux', screenWidth: 1280, screenHeight: 960, hardwareConcurrency: 13, permissionsQueryFailRate: 12 / 13 });
    const m = matchHostedProfiles(f);
    expect(m?.profile.id).toBe('chatgpt-agent');
    expect(m?.matched.map((x) => x.name)).toEqual(['screen1280x960', 'cores13', 'macUaLinuxHints', 'permissionsQueryFail']);
    expect(m?.reliability).toBe(1);
    const finding = hostedFinding(m!, f);
    expect(finding).toMatchObject({ id: 'env.hosted-agent-profile', value: 'chatgpt-agent', provider: { id: 'openai', confidence: 0.9 }, classes: { 'computer-use-agent': 3 } });
    expect(finding.summary).toContain('userAgentData.platform "Linux"');
  });

  it('needs at least two features: a 1280x960 screen alone is not a profile', () => {
    expect(matchHostedProfiles(facts({ screenWidth: 1280, screenHeight: 960 }))).toBeUndefined();
    expect(matchHostedProfiles(facts({ screenWidth: 1280, screenHeight: 960, hardwareConcurrency: 13 }))?.reliability).toBe(0.75);
  });

  it('matches Browser Use cloud from 1512x982 + 10 cores', () => {
    const m = matchHostedProfiles(facts({ ua: MAC_CHROME_UA, platform: 'MacIntel', uaDataPlatform: 'macOS', screenWidth: 1512, screenHeight: 982, hardwareConcurrency: 10 }));
    expect(m?.profile.provider.id).toBe('browser-use');
    expect(m?.profile.classes).toEqual({ 'browser-agent': 3 });
  });

  it('matches Skyvern from Edge-on-Linux + SwiftShader, but not a 32-core Linux workstation on software GL', () => {
    const skyvern = matchHostedProfiles(facts({ ua: LINUX_EDGE_UA, platform: 'Linux x86_64', uaDataPlatform: 'Linux', webgl: SWIFTSHADER_GPU, hardwareConcurrency: 32 }));
    expect(skyvern?.profile.id).toBe('skyvern');
    expect(skyvern?.reliability).toBe(0.75);
    const workstation = matchHostedProfiles(facts({ ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36', platform: 'Linux x86_64', uaDataPlatform: 'Linux', webgl: SWIFTSHADER_GPU, hardwareConcurrency: 32 }));
    expect(workstation).toBeUndefined();
  });

  it('matches Browserbase from Linux Chromium + UTC + worker platform mismatch, not from Linux + UTC alone', () => {
    const base = { ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36', platform: 'Linux x86_64', uaDataPlatform: 'Linux', timezone: 'UTC' };
    expect(matchHostedProfiles(facts(base))).toBeUndefined();
    const m = matchHostedProfiles(facts({ ...base, workerPlatformMismatch: true }));
    expect(m?.profile.id).toBe('browserbase');
    expect(m?.matched.map((x) => x.name)).toEqual(['linuxChromium', 'tzUTC', 'workerPlatformMismatch']);
  });

  it('matches the Anthropic reference container (Firefox ESR, Xvfb 1024x768, UTC, no GPU, container fonts)', () => {
    const m = matchHostedProfiles(
      facts({ ua: LINUX_FIREFOX_UA, platform: 'Linux x86_64', uaDataPlatform: undefined, screenWidth: 1024, screenHeight: 768, timezone: 'UTC', webgl: null, fonts: fontMap(['DejaVu Sans']) }),
    );
    expect(m?.profile.provider).toMatchObject({ id: 'anthropic' });
    expect(m?.matched.map((x) => x.name)).toEqual(['firefoxLinux', 'screen1024x768', 'tzUTC', 'softwareGl', 'linuxOnlyFonts']);
    // Firefox on Linux at 1024x768 with a normal timezone and GPU is just a small laptop.
    expect(matchHostedProfiles(facts({ ua: LINUX_FIREFOX_UA, platform: 'Linux x86_64', screenWidth: 1024, screenHeight: 768 }))).toBeUndefined();
  });

  it('matches Magentic-UI from the hardcoded Windows Chrome 122 UA on a Linux platform', () => {
    const m = matchHostedProfiles(
      facts({ ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0', platform: 'Linux x86_64', uaDataPlatform: 'Linux', innerWidth: 1440, innerHeight: 900 }),
    );
    expect(m?.profile.id).toBe('magentic-ui');
    expect(m?.matched.map((x) => x.name)).toEqual(['win10Chrome122', 'linuxPlatformUnderWindowsUa', 'viewport1440x900']);
  });

  it('does not match a stock desktop', () => {
    expect(matchHostedProfiles(facts())).toBeUndefined();
    expect(matchHostedProfiles(facts({ ua: MAC_CHROME_UA, platform: 'MacIntel', uaDataPlatform: 'macOS', screenWidth: 1512, screenHeight: 982 }))).toBeUndefined();
  });

  it('derives facts from the shared state', () => {
    const env = fakeEnv({ screen: { width: 1280, height: 960 }, hardwareConcurrency: 13 });
    const state = createEnvironmentState(env);
    state.update({ workerPlatformMismatch: true, permissionsQueryFailRate: 0.9 });
    const f = hostedFactsFromState(state);
    expect(f).toMatchObject({ screenWidth: 1280, screenHeight: 960, hardwareConcurrency: 13, workerPlatformMismatch: true, permissionsQueryFailRate: 0.9, uaDataPlatform: 'Windows' });
  });

  it('the module emits env.hosted-agent-profile synchronously and upgrades it when deferred facts arrive', async () => {
    resetEnvironmentState();
    const fc = fakeContext();
    const env = fakeEnv({
      userAgent: MAC_CHROME_UA,
      platform: 'MacIntel',
      userAgentData: { brands: [{ brand: 'Chromium', version: '141' }, { brand: 'Not)A;Brand', version: '8' }], mobile: false, platform: 'Linux' },
      screen: { width: 1280, height: 960, availWidth: 1280, availHeight: 960 },
      window: { innerWidth: 1280, innerHeight: 873, outerWidth: 1280, outerHeight: 960 },
      hardwareConcurrency: 13,
      permissions: () => Promise.reject(new TypeError('not supported')),
    });
    const mod = createEnvironmentModule({ env });
    mod.start(fc.ctx);
    const first = fc.byId('env.hosted-agent-profile');
    expect(first?.provider?.id).toBe('openai');
    expect(first?.details?.['features']).toEqual(['screen1280x960', 'cores13', 'macUaLinuxHints']);
    fc.schedule.flush();
    await new Promise((r) => setTimeout(r, 0));
    const later = fc.byId('env.hosted-agent-profile');
    expect(later?.details?.['features']).toEqual(['screen1280x960', 'cores13', 'macUaLinuxHints', 'permissionsQueryFail']);
    expect(fc.byId('env.permissions-query-failing')).toBeDefined();
    mod.stop?.();
  });
});
