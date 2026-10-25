import type { ProviderHint } from '@necterai/core';

/**
 * Residue globals left in the main world by automation drivers and agent
 * frameworks. Sources: docs/research/raw/cdp-leak-techniques.md section 4 and
 * 10.1, docs/research/raw/automation-stacks.md sections 2.4, 4.4, 8.1, 13, 14,
 * 18 and 28, docs/research/raw/extension-agents.md sections 4 and 9.7.
 *
 * Order matters: the first matching rule wins, so product-specific names that
 * imitate another driver (Skyvern's `__pw-cursor` family) come before the
 * generic prefix rules.
 */
export type ResidueSignalId =
  | 'probe.playwright-artifact'
  | 'probe.puppeteer-artifact'
  | 'probe.selenium-artifact'
  | 'probe.agent-framework-artifact'
  | 'probe.main-world-agent-global'
  | 'probe.legacy-automation-artifact';

export interface KnownGlobalRule {
  /** Exact name or pattern tested against the property name. */
  test: string | RegExp;
  /** Optional check on the property value (e.g. a binding wrapper's source text). */
  value?: (value: unknown) => boolean;
  signal: ResidueSignalId;
  provider?: ProviderHint;
  /** 0..1 reliability of the observation (names a page could plausibly own get less). */
  reliability?: number;
  /** Which object the rule applies to (default window). */
  on?: 'window' | 'document';
}

const PLAYWRIGHT: ProviderHint = { id: 'playwright', product: 'Playwright', confidence: 0.9 };
const PUPPETEER: ProviderHint = { id: 'puppeteer', product: 'Puppeteer', confidence: 0.9 };
const SELENIUM: ProviderHint = { id: 'selenium', product: 'ChromeDriver', confidence: 0.9 };
const SKYVERN: ProviderHint = { id: 'skyvern', product: 'Skyvern', confidence: 0.9 };
const MAGENTIC: ProviderHint = { id: 'microsoft', product: 'Magentic-UI', confidence: 0.85 };
const AUTOGEN: ProviderHint = { id: 'microsoft', product: 'AutoGen MultimodalWebSurfer', confidence: 0.85 };
const STAGEHAND: ProviderHint = { id: 'browserbase', product: 'Stagehand', confidence: 0.7 };
const CODEX: ProviderHint = { id: 'openai', product: 'ChatGPT extension / Codex browser', confidence: 0.9 };
const CURSOR: ProviderHint = { id: 'cursor', product: 'Cursor Browser Automation', confidence: 0.9 };
const BROWSER_USE: ProviderHint = { id: 'browser-use', product: 'Browser Use', confidence: 0.8 };

export const KNOWN_GLOBALS: KnownGlobalRule[] = [
  // ── Skyvern's cursor overlay deliberately mimics Playwright naming (cursorOverlay.js).
  { test: '__PW_CURSOR_VIS__', signal: 'probe.agent-framework-artifact', provider: SKYVERN },
  { test: '__pw_trails', signal: 'probe.agent-framework-artifact', provider: SKYVERN },
  { test: '__pwCursorInit', signal: 'probe.agent-framework-artifact', provider: SKYVERN },
  { test: '__pwCursorMove', signal: 'probe.agent-framework-artifact', provider: SKYVERN },
  // Skyvern domUtils.js main-world globals (string evaluate = indirect eval => window globals).
  { test: 'GlobalSkyvernFrameIndex', signal: 'probe.agent-framework-artifact', provider: SKYVERN },
  { test: 'GlobalEnableAllTextualElements', signal: 'probe.agent-framework-artifact', provider: SKYVERN },
  { test: 'globalObserverForDOMIncrement', signal: 'probe.agent-framework-artifact', provider: SKYVERN },
  { test: 'getDOMElementBySkyvenElement', signal: 'probe.agent-framework-artifact', provider: SKYVERN },
  { test: 'stampOtpInputBoxes', signal: 'probe.agent-framework-artifact', provider: SKYVERN },
  // Generic callback name that reCAPTCHA/hCaptcha integrations also use: never deterministic alone.
  { test: 'captchaSolvedCallback', signal: 'probe.agent-framework-artifact', provider: SKYVERN, reliability: 0.4 },
  { test: 'buildTreeFromBody', signal: 'probe.agent-framework-artifact', provider: SKYVERN, reliability: 0.8 },
  { test: 'buildElementsAndDrawBoundingBoxes', signal: 'probe.agent-framework-artifact', provider: SKYVERN, reliability: 0.8 },
  // Magentic-UI / AutoGen page_script.js (`var WebSurfer = ...` in the main world).
  { test: 'WebSurfer', signal: 'probe.agent-framework-artifact', provider: MAGENTIC, reliability: 0.85 },
  { test: 'MultimodalWebSurfer', signal: 'probe.agent-framework-artifact', provider: AUTOGEN, reliability: 0.85 },
  // Historic Stagehand v1/v2 (Playwright era) injections.
  { test: '__stagehandInjected', signal: 'probe.agent-framework-artifact', provider: STAGEHAND },
  { test: /^__stagehand/, signal: 'probe.agent-framework-artifact', provider: STAGEHAND },
  // Legacy Browser Use (<= 0.4 buildDomTree.js) and its DVD screensaver.
  { test: '__dvdAnimationRunning', signal: 'probe.agent-framework-artifact', provider: BROWSER_USE, reliability: 0.7 },
  // ── Agent drivers acting through a user's browser (main-world globals).
  { test: '__browserUseClipboardBridge', signal: 'probe.main-world-agent-global', provider: CODEX },
  { test: /^__browserUseClipboard_/, signal: 'probe.main-world-agent-global', provider: CODEX },
  { test: '__codexNativeWebMcpState', signal: 'probe.main-world-agent-global', provider: CODEX, on: 'document' },
  { test: '__cursorBrowserAutomationInjected', signal: 'probe.main-world-agent-global', provider: CURSOR },
  { test: '__cursorAreaScreenshotInjected', signal: 'probe.main-world-agent-global', provider: CURSOR },
  { test: '__cursorAreaScreenshotCommand', signal: 'probe.main-world-agent-global', provider: CURSOR },
  // ── Playwright.
  { test: '__playwright__binding__', signal: 'probe.playwright-artifact', provider: PLAYWRIGHT },
  { test: '__playwright__binding__controller__', signal: 'probe.playwright-artifact', provider: PLAYWRIGHT },
  { test: '__pwInitScripts', signal: 'probe.playwright-artifact', provider: { ...PLAYWRIGHT, product: 'Playwright 1.46-1.52' } },
  { test: '__pwSnapshotGlobals', signal: 'probe.playwright-artifact', provider: PLAYWRIGHT },
  { test: '__pw_devtools__', signal: 'probe.playwright-artifact', provider: PLAYWRIGHT },
  { test: /^__pw_recorder/, signal: 'probe.playwright-artifact', provider: { ...PLAYWRIGHT, product: 'Playwright codegen/inspector' } },
  { test: /^__playwright_/, signal: 'probe.playwright-artifact', provider: PLAYWRIGHT },
  {
    test: /./,
    value: (v) => typeof v === 'function' && /exposeBindingHandle supports a single argument/.test(safeSource(v)),
    signal: 'probe.playwright-artifact',
    provider: { ...PLAYWRIGHT, product: 'Playwright <= 1.59 / Patchright exposeFunction' },
  },
  // ── Puppeteer.
  { test: /^puppeteer_/, signal: 'probe.puppeteer-artifact', provider: PUPPETEER },
  { test: '__puppeteer_evaluation_script__', signal: 'probe.puppeteer-artifact', provider: PUPPETEER },
  {
    test: /./,
    value: (v) => typeof v === 'function' && /This is the Puppeteer binding/.test(safeSource(v)),
    signal: 'probe.puppeteer-artifact',
    provider: { ...PUPPETEER, product: 'Puppeteer exposeFunction' },
  },
  // ── Selenium / ChromeDriver and friends.
  { test: /^\$?cdc_[a-zA-Z0-9]{22}_(Array|Object|Promise|Proxy|ShadowRoot|Symbol|JSON|Window)$/, signal: 'probe.selenium-artifact', provider: SELENIUM },
  // undetected-chromedriver renames the prefix but keeps the `<3 letters>_<22>_<Type>` shape (BotD pattern).
  { test: /^[a-z]{3}_[a-zA-Z0-9]{22}_(Array|Object|Promise|Proxy|ShadowRoot|Symbol|JSON|Window)$/, signal: 'probe.selenium-artifact', provider: { ...SELENIUM, product: 'undetected-chromedriver' } },
  // Generic chromedriver key shape only (`cdc_<20-22 alnum>`): a bare `cdc_` prefix is ordinary page
  // naming on sites such as cdc.gov and must not prove automation.
  { test: /^\$?cdc_[a-zA-Z0-9]{20,22}(_|$)/, signal: 'probe.selenium-artifact', provider: SELENIUM },
  { test: /^\$cdc_[a-zA-Z0-9]{20,22}(_|$)/, signal: 'probe.selenium-artifact', provider: SELENIUM, on: 'document' },
  { test: '$chrome_asyncScriptInfo', signal: 'probe.selenium-artifact', provider: SELENIUM, on: 'document' },
  { test: '__$webdriverAsyncExecutor', signal: 'probe.selenium-artifact', provider: SELENIUM, on: 'document' },
  { test: '__webdriver_evaluate', signal: 'probe.selenium-artifact', provider: SELENIUM, on: 'document' },
  { test: '__selenium_evaluate', signal: 'probe.selenium-artifact', provider: SELENIUM, on: 'document' },
  { test: '__selenium_unwrapped', signal: 'probe.selenium-artifact', provider: SELENIUM, on: 'document' },
  { test: /^__(webdriver|driver|selenium|fxdriver)_/, signal: 'probe.selenium-artifact', provider: SELENIUM, on: 'document' },
  { test: '$wdc_', signal: 'probe.selenium-artifact', provider: SELENIUM },
  { test: 'webdriver', signal: 'probe.selenium-artifact', provider: { ...SELENIUM, confidence: 0.6 } },
  { test: /^__(webdriver|driver|selenium|fxdriver)_/, signal: 'probe.selenium-artifact', provider: SELENIUM },
  { test: '__webdriverFunc', signal: 'probe.selenium-artifact', provider: SELENIUM },
  { test: '_Selenium_IDE_Recorder', signal: 'probe.selenium-artifact', provider: { ...SELENIUM, product: 'Selenium IDE' } },
  { test: '_selenium', signal: 'probe.selenium-artifact', provider: SELENIUM },
  { test: 'calledSelenium', signal: 'probe.selenium-artifact', provider: SELENIUM },
  { test: '_WEBDRIVER_ELEM_CACHE', signal: 'probe.selenium-artifact', provider: SELENIUM },
  { test: 'ChromeDriverw', signal: 'probe.selenium-artifact', provider: SELENIUM },
  { test: /^__lastWatir(Alert|Confirm|Prompt)$/, signal: 'probe.selenium-artifact', provider: { ...SELENIUM, product: 'Watir' } },
  { test: 'domAutomation', signal: 'probe.selenium-artifact', provider: { ...SELENIUM, confidence: 0.5 } },
  { test: 'domAutomationController', signal: 'probe.selenium-artifact', provider: { ...SELENIUM, confidence: 0.5 } },
  { test: 'wdioElectron', signal: 'probe.selenium-artifact', provider: { id: 'selenium', product: 'WebdriverIO', confidence: 0.7 } },
  // chromedriver call_function.js leaks the sloppy-mode implicit global `ret_nodes` on each executeScript.
  // A sloppy page could leak the same implicit global; kept just below deterministic (8 x 0.7).
  { test: 'ret_nodes', signal: 'probe.selenium-artifact', provider: SELENIUM, reliability: 0.7 },
  // ── Legacy headless / embedded automation.
  { test: /^(_phantom|callPhantom|__phantomas)$/, signal: 'probe.legacy-automation-artifact' },
  { test: /^(__nightmare|nightmare)$/, signal: 'probe.legacy-automation-artifact' },
  { test: /^(awesomium|CefSharp|RunPerfTest|fmget_targets|geb)$/, signal: 'probe.legacy-automation-artifact' },
];

/** `<html>` attributes stamped by WebDriver clients (BotD `documentAttributes`). */
export const DOCUMENT_ELEMENT_ATTRIBUTES = /^(webdriver|selenium|driver)$/i;

/** Source of a (short) function; exposeFunction wrappers are a few hundred chars, page bundles are not worth scanning. */
function safeSource(fn: unknown): string {
  try {
    const src = Function.prototype.toString.call(fn);
    return src.length <= 4000 ? src : '';
  } catch {
    return '';
  }
}

export interface GlobalMatch {
  name: string;
  on: 'window' | 'document';
  rule: KnownGlobalRule;
}

/** Match a property name (and optionally its value) against the table. */
export function matchKnownGlobal(name: string, on: 'window' | 'document', value?: () => unknown): GlobalMatch | undefined {
  for (const rule of KNOWN_GLOBALS) {
    if ((rule.on ?? 'window') !== on) continue;
    const nameOk = typeof rule.test === 'string' ? rule.test === name : rule.test.test(name);
    if (!nameOk) continue;
    if (rule.value) {
      let v: unknown;
      try {
        v = value ? value() : undefined;
      } catch {
        continue;
      }
      if (!rule.value(v)) continue;
    }
    return { name, on, rule };
  }
  return undefined;
}
