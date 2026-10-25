/**
 * navigator.* tells (spec §1): webdriver flag, its prototype descriptor, headless
 * brands / UA token, and the low-hardware container hint.
 */
import type { Env } from './env.js';
import type { Finding } from './finding.js';
import type { ParsedUA } from './ua.js';

export interface NavigatorInput {
  ua: ParsedUA;
  webdriver: boolean | undefined;
  descriptor: ReturnType<Env['webdriverDescriptor']>;
  brands: readonly string[];
  hardwareConcurrency: number | undefined;
  deviceMemory: number | undefined;
  privacyActive: boolean;
}

export function navigatorInputFromEnv(env: Env, ua: ParsedUA, privacyActive: boolean): NavigatorInput {
  return {
    ua,
    webdriver: env.webdriver,
    descriptor: env.webdriverDescriptor(),
    brands: env.userAgentData?.brands.map((b) => b.brand) ?? [],
    hardwareConcurrency: env.hardwareConcurrency,
    deviceMemory: env.deviceMemory,
    privacyActive,
  };
}

export function analyzeNavigator(i: NavigatorInput): Finding[] {
  const out: Finding[] = [];

  // Chromium sets AutomationControlled for --enable-automation, --headless, --remote-debugging-pipe
  // and --remote-debugging-port=0; Firefox for Marionette / Remote Agent; WebKit for safaridriver.
  // A person's browser never reports true (cdp-leak-techniques.md §1: FP ~ 0).
  if (i.webdriver === true) {
    out.push({ id: 'env.webdriver', summary: 'navigator.webdriver === true', value: true });
  }

  // Stealth scripts delete or redefine the getter; the native accessor lives on Navigator.prototype.
  if (i.ua.engine === 'blink' && (i.descriptor === 'missing' || i.descriptor === 'own' || i.descriptor === 'tampered')) {
    const how =
      i.descriptor === 'missing'
        ? 'navigator.webdriver descriptor missing from Navigator.prototype'
        : i.descriptor === 'own'
          ? 'navigator.webdriver redefined as an own property on navigator'
          : 'navigator.webdriver getter is not native code';
    out.push({
      id: 'probe.prototype-tampered',
      summary: `${how} (typeof webdriver: ${typeof i.webdriver})`,
      value: i.descriptor,
      details: { property: 'navigator.webdriver', state: i.descriptor },
      // Own-property redefinition is unambiguous; a missing descriptor can also be an exotic build.
      reliability: i.descriptor === 'missing' ? 0.7 : 1,
    });
  }

  if (i.brands.some((b) => /HeadlessChrome/i.test(b))) {
    out.push({
      id: 'env.headless-brand',
      summary: `userAgentData.brands include HeadlessChrome (${i.brands.join(', ')})`,
      value: i.brands,
    });
  }

  if (i.ua.headless) {
    const m = /HeadlessChrome\/[\d.]+/.exec(i.ua.raw);
    out.push({
      id: 'declared.headless-ua',
      summary: `User-Agent contains ${m ? m[0] : 'a headless marker'}`,
      value: m ? m[0] : i.ua.raw,
    });
  }

  // deviceMemory is Chromium-only and WebKit caps hardwareConcurrency at 4/8 (NavigatorBase.cpp), so
  // this can only ever fire on a Blink desktop UA. Brave farbles and Firefox tiers the value: privacy-gated off.
  if (
    i.ua.desktop &&
    i.ua.engine === 'blink' &&
    !i.privacyActive &&
    typeof i.hardwareConcurrency === 'number' &&
    typeof i.deviceMemory === 'number' &&
    i.hardwareConcurrency <= 2 &&
    i.deviceMemory <= 2
  ) {
    out.push({
      id: 'env.low-hardware',
      summary: `hardwareConcurrency ${i.hardwareConcurrency}, deviceMemory ${i.deviceMemory} GB on a desktop UA`,
      value: { hardwareConcurrency: i.hardwareConcurrency, deviceMemory: i.deviceMemory },
    });
  }

  return out;
}
