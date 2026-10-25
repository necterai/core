/**
 * Hosted-agent environment profiles (spec §1, computer-use-agents.md §3.3, §10,
 * §11.5 and automation-stacks.md §18, §20). Each profile is a bundle of measured
 * features with a specificity weight; a session matches when at least two
 * features hold and their weights sum to >= 1.0. The match reliability grows with
 * the summed specificity so that two weak coincidences (a 1080p Linux desktop
 * with SwiftShader in a VDI) stay below a confident attribution.
 *
 * Measured values used verbatim:
 *  - ChatGPT agent / cloud browser (arXiv 2606.30119, Jan-Feb 2026): screen 1280x960, 13 logical cores,
 *    Mac UA with `Sec-CH-UA-Platform: "Linux"` and a worker/main navigator.platform mismatch, most
 *    permissions.query calls fail.
 *  - Browser Use cloud: 1512x982 screen, 10 cores, Mac Chrome UA, permissions mostly denied.
 *  - Skyvern cloud: Edge UA on X11 Linux, SwiftShader WebGL, 32 logical cores.
 *  - Browserbase basic: Linux Chromium, timezone UTC, navigator.platform "Mac" main / "Linux" worker.
 *  - Anthropic computer-use reference container: Firefox ESR on Ubuntu 22.04 under Xvfb 1024x768x24,
 *    container timezone/locale defaults, no GPU, DejaVu/Liberation fonts.
 *  - Magentic-UI: hardcoded Windows 10 Chrome/Edg 122 UA on a Linux Playwright, 1440x900 viewport.
 */
import type { ActorClass, ProviderHint } from '@necterai/core';
import type { EnvWebGL } from './env.js';
import type { Finding } from './finding.js';
import { gpuFamily } from './graphics.js';
import { summarizeFonts } from './fonts.js';
import { SPOOFED_TIMEZONES } from './privacy.js';
import type { ParsedUA } from './ua.js';

export interface HostedFacts {
  ua: ParsedUA;
  screenWidth: number;
  screenHeight: number;
  innerWidth: number;
  innerHeight: number;
  hardwareConcurrency: number | undefined;
  platform: string;
  uaDataPlatform: string | undefined;
  timezone: string | undefined;
  /** undefined = not measured yet. */
  workerPlatformMismatch: boolean | undefined;
  webgl: EnvWebGL | null | undefined;
  permissionsQueryFailRate: number | undefined;
  permissionsDeniedRate: number | undefined;
  fonts: Map<string, boolean> | undefined;
}

export interface HostedFeature {
  name: string;
  /** Specificity 0..1: how rare the feature is among real users. */
  weight: number;
  test(f: HostedFacts): boolean;
  describe(f: HostedFacts): string;
}

export interface HostedProfile {
  id: string;
  provider: ProviderHint;
  classes: Partial<Record<ActorClass, number>>;
  /** Hard gate the facts must pass before features count (e.g. a Chromium engine). */
  gate?(f: HostedFacts): boolean;
  features: HostedFeature[];
}

const screenIs = (w: number, h: number): HostedFeature => ({
  name: `screen${w}x${h}`,
  weight: w === 1024 || w === 1920 ? 0.6 : 0.8,
  test: (f) => f.screenWidth === w && f.screenHeight === h,
  describe: () => `screen ${w}x${h}`,
});
const coresAre = (n: number, weight: number): HostedFeature => ({
  name: `cores${n}`,
  weight,
  test: (f) => f.hardwareConcurrency === n,
  describe: () => `hardwareConcurrency ${n}`,
});
const tzUtc: HostedFeature = {
  name: 'tzUTC',
  weight: 0.4,
  test: (f) => !!f.timezone && SPOOFED_TIMEZONES.has(f.timezone),
  describe: (f) => `timezone ${f.timezone}`,
};
const workerMismatch: HostedFeature = {
  name: 'workerPlatformMismatch',
  weight: 0.9,
  test: (f) => f.workerPlatformMismatch === true,
  describe: () => 'navigator.platform differs between main thread and Worker',
};
const softwareGl: HostedFeature = {
  name: 'softwareGl',
  weight: 0.4,
  test: (f) => f.webgl === null || gpuFamily(f.webgl) === 'software',
  describe: (f) => (f.webgl ? `WebGL "${f.webgl.renderer}"` : 'no WebGL context'),
};

export const HOSTED_PROFILES: readonly HostedProfile[] = [
  {
    id: 'chatgpt-agent',
    provider: { id: 'openai', product: 'ChatGPT agent (cloud browser)', confidence: 0.9 },
    classes: { 'computer-use-agent': 3 },
    gate: (f) => f.ua.engine === 'blink',
    features: [
      screenIs(1280, 960),
      coresAre(13, 0.7),
      {
        name: 'macUaLinuxHints',
        weight: 0.9,
        test: (f) => f.ua.os === 'macos' && (f.uaDataPlatform === 'Linux' || f.workerPlatformMismatch === true),
        describe: (f) => `Macintosh UA with ${f.uaDataPlatform === 'Linux' ? 'userAgentData.platform "Linux"' : 'a Linux worker platform'}`,
      },
      {
        name: 'permissionsQueryFail',
        weight: 0.5,
        test: (f) => (f.permissionsQueryFailRate ?? 0) >= 0.5,
        describe: (f) => `${Math.round((f.permissionsQueryFailRate ?? 0) * 100)}% of permissions.query calls fail`,
      },
    ],
  },
  {
    id: 'browser-use-cloud',
    provider: { id: 'browser-use', product: 'Browser Use cloud', confidence: 0.85 },
    classes: { 'browser-agent': 3 },
    gate: (f) => f.ua.engine === 'blink',
    features: [
      screenIs(1512, 982),
      coresAre(10, 0.5),
      {
        name: 'permissionsDenied',
        weight: 0.4,
        test: (f) => (f.permissionsDeniedRate ?? 0) >= 0.5,
        describe: (f) => `${Math.round((f.permissionsDeniedRate ?? 0) * 100)}% of permissions denied`,
      },
    ],
  },
  {
    id: 'skyvern',
    provider: { id: 'skyvern', product: 'Skyvern cloud', confidence: 0.85 },
    classes: { 'browser-agent': 3 },
    gate: (f) => f.ua.engine === 'blink',
    features: [
      {
        name: 'edgeOnLinux',
        weight: 0.7,
        test: (f) => f.ua.browser === 'edge' && f.ua.os === 'linux',
        describe: () => 'Edge UA on X11 Linux',
      },
      softwareGl,
      coresAre(32, 0.4),
    ],
  },
  {
    id: 'browserbase',
    provider: { id: 'browserbase', product: 'Browserbase session', confidence: 0.8 },
    classes: { 'browser-agent': 3 },
    gate: (f) => f.ua.engine === 'blink',
    features: [
      {
        name: 'linuxChromium',
        weight: 0.3,
        test: (f) => f.ua.os === 'linux' || f.uaDataPlatform === 'Linux',
        describe: () => 'Linux Chromium',
      },
      tzUtc,
      workerMismatch,
    ],
  },
  {
    id: 'anthropic-reference-container',
    provider: { id: 'anthropic', product: 'computer-use reference container', confidence: 0.75 },
    classes: { 'computer-use-agent': 3 },
    features: [
      {
        name: 'firefoxLinux',
        weight: 0.3,
        test: (f) => f.ua.browser === 'firefox' && f.ua.os === 'linux',
        describe: () => 'Firefox on Linux',
      },
      screenIs(1024, 768),
      tzUtc,
      softwareGl,
      {
        name: 'linuxOnlyFonts',
        weight: 0.3,
        test: (f) => {
          if (!f.fonts) return false;
          const s = summarizeFonts(f.fonts);
          return s.windows.length === 0 && s.mac.length === 0 && s.total <= 2;
        },
        describe: () => 'only container fonts present',
      },
    ],
  },
  {
    id: 'magentic-ui',
    provider: { id: 'microsoft', product: 'Magentic-UI / AutoGen WebSurfer', confidence: 0.8 },
    classes: { 'computer-use-agent': 2, 'browser-agent': 2 },
    gate: (f) => f.ua.engine === 'blink',
    features: [
      {
        name: 'win10Chrome122',
        weight: 0.7,
        test: (f) => f.ua.os === 'windows' && f.ua.chromiumMajor === 122,
        describe: () => 'hardcoded Windows 10 Chrome/Edg 122 UA',
      },
      {
        name: 'linuxPlatformUnderWindowsUa',
        weight: 0.9,
        test: (f) => f.ua.os === 'windows' && /^Linux/.test(f.platform),
        describe: (f) => `Windows UA with navigator.platform "${f.platform}"`,
      },
      {
        name: 'viewport1440x900',
        weight: 0.3,
        test: (f) => f.innerWidth === 1440 && f.innerHeight === 900,
        describe: () => 'viewport 1440x900',
      },
    ],
  },
];

export interface HostedMatch {
  profile: HostedProfile;
  matched: HostedFeature[];
  score: number;
  reliability: number;
}

export const HOSTED_MIN_FEATURES = 2;
export const HOSTED_MIN_SCORE = 1.0;

export function matchHostedProfiles(facts: HostedFacts, profiles: readonly HostedProfile[] = HOSTED_PROFILES): HostedMatch | undefined {
  let best: HostedMatch | undefined;
  for (const profile of profiles) {
    if (profile.gate && !profile.gate(facts)) continue;
    const matched = profile.features.filter((feat) => {
      try {
        return feat.test(facts);
      } catch {
        return false;
      }
    });
    if (matched.length < HOSTED_MIN_FEATURES) continue;
    const score = matched.reduce((s, f) => s + f.weight, 0);
    if (score < HOSTED_MIN_SCORE) continue;
    const reliability = Math.min(1, Math.round((score / 2) * 100) / 100);
    if (!best || score > best.score) best = { profile, matched, score, reliability };
  }
  return best;
}

export function hostedFinding(match: HostedMatch, facts: HostedFacts): Finding {
  const evidence = match.matched.map((f) => f.describe(facts));
  return {
    id: 'env.hosted-agent-profile',
    summary: `matches the ${match.profile.provider.product ?? match.profile.id} profile: ${evidence.join(', ')}`,
    value: match.profile.id,
    details: { features: match.matched.map((f) => f.name), score: Math.round(match.score * 100) / 100 },
    reliability: match.reliability,
    provider: {
      id: match.profile.provider.id,
      ...(match.profile.provider.product ? { product: match.profile.provider.product } : {}),
      confidence: Math.round(match.profile.provider.confidence * match.reliability * 100) / 100,
    },
    classes: match.profile.classes,
  };
}
