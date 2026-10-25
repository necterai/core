/**
 * Stack-frame parsing and origin classification for the harvest module.
 *
 * Pure functions: no DOM access beyond what the caller passes in `env`, so the
 * logic is unit-testable with synthetic stacks. Evidence base:
 * docs/research/raw/automation-stacks.md §2.5 (Playwright `UtilityScript.evaluate`
 * frames), §4.3 (Puppeteer `pptr:` sourceURL, obsolete
 * `__puppeteer_evaluation_script__`), §6 (rebrowser renames UtilityScript and
 * strips sourceURLs so frames show `<anonymous>`), §27.1 (`sourceUrlLeak`,
 * `mainWorldExecution`), and docs/research/raw/extension-agents.md §2.3
 * (isolated-world reads never reach page prototypes, so they produce no stack).
 */

import type { ProviderHint } from '@necterai/core';

/**
 * Classification of one sampled call stack.
 *
 * - `trusted`: a frame belongs to the site's own code (same-origin, or a
 *   configured trusted origin). Ignored by the burst rules.
 * - `automation`: a frame carries an automation-stack marker (deterministic).
 * - `anonymous`: frames exist but none has a script URL (`<anonymous>`, `VM123`,
 *   bare `//# sourceURL` names, `eval`, `debugger eval code`).
 * - `extension`: only extension-scheme frames (`chrome-extension://`, `moz-extension://`).
 * - `page-script`: an http(s) frame from an origin that is neither the page's
 *   nor configured as trusted (third-party analytics, A/B tools...).
 * - `none`: no usable stack at all (stack unavailable or empty).
 */
export type StackClass = 'trusted' | 'automation' | 'anonymous' | 'extension' | 'page-script' | 'none';

export interface StackFrame {
  raw: string;
  /** Script URL when the frame has one (http(s), chrome-extension, blob...). */
  url?: string;
  /** Function name when present. */
  fn?: string;
  /** True for frames without any script location (`<anonymous>`, VM, bare name, eval). */
  anonymous: boolean;
}

export interface StackVerdict {
  cls: StackClass;
  /** Automation markers found (deduplicated, in order). */
  markers: string[];
  /** Distinct untrusted http(s)/extension origins seen. */
  origins: string[];
  /** Number of frames considered (after own frames were dropped). */
  frames: number;
  /** One representative frame line, sanitised to ~160 chars, for evidence. */
  sample?: string;
}

export interface StackEnv {
  /** `location.origin` of the page. */
  pageOrigin: string;
  /** Full document URL (inline scripts report it as their location). */
  pageUrl?: string;
  /** `config.trustedScriptOrigins`: origins, URL prefixes, or same-origin path prefixes (`/static/`). */
  trustedScriptOrigins: readonly string[];
  /**
   * URL of the script that contains this SDK, when known. Leading frames from
   * it are our own wrappers and are dropped before classification.
   */
  selfUrl?: string;
}

/**
 * Deterministic automation markers (automation-stacks.md §2.5, §4.3, §27.1).
 * `UtilityScript` = Playwright main-world evaluate; `pptr:` = Puppeteer sourceURL;
 * `__puppeteer_evaluation_script__` = legacy Puppeteer (what puppeteer-extra's
 * `sourceurl` evasion strips); `__playwright` = Playwright init-script/binding
 * helpers; `InjectedScript` = Playwright's injected script class.
 */
export const AUTOMATION_MARKER_RE =
  /UtilityScript|__puppeteer_evaluation_script__|__pyppeteer_evaluation_script__|pptr:|__playwright|InjectedScript|newHandler\.<computed> \[as apply\]/;

/**
 * Marker substrings, in reporting order. `__pyppeteer_evaluation_script__` is
 * pyppeteer's sourceURL; `newHandler.<computed> [as apply]` is the frame that
 * puppeteer-extra-plugin-stealth's Proxy overrides leave in any hooked native's
 * stack (cdp-leak-techniques.md §3.2, Brotector `stack.signature`).
 */
export const MARKER_LIST = [
  'UtilityScript',
  '__puppeteer_evaluation_script__',
  '__pyppeteer_evaluation_script__',
  'pptr:',
  '__playwright',
  'InjectedScript',
  'newHandler.<computed> [as apply]',
] as const;

/** Patterns that mean "evaluated code without a script URL" (automation-stacks.md §27.1 `sourceUrlLeak`, spec §2). */
const ANONYMOUS_RE = /<anonymous>|\bVM\d+\b|debugger eval code|^\s*at eval\b|\beval at\b|\[eval\]|^\s*at\s*$|^\s*>\s*eval\b/;

const URL_RE = /([a-z][a-z0-9+.-]*:\/\/[^\s()]+)/i;

const EXTENSION_SCHEME_RE = /^(chrome-extension|moz-extension|safari-web-extension|ms-browser-extension|extension):\/\//i;

/** Strip `:line:col` suffixes from a location. */
function stripPosition(loc: string): string {
  return loc.replace(/(?::\d+){1,2}$/, '');
}

/** Parse a raw `Error.stack` string into frames (V8 and SpiderMonkey/JSC formats). */
export function parseStack(stack: string | undefined | null): StackFrame[] {
  if (!stack) return [];
  const lines = stack.split('\n');
  const frames: StackFrame[] = [];
  for (const line0 of lines) {
    const line = line0.trim();
    if (!line) continue;
    // V8 header ("Error", "Error: msg", "TypeError: ...").
    if (/^[A-Za-z]*Error(?::|$)/.test(line) && !/\bat\b|@/.test(line)) continue;
    const frame: StackFrame = { raw: line, anonymous: false };
    const urlMatch = URL_RE.exec(line);
    if (urlMatch) {
      frame.url = stripPosition(urlMatch[1]!);
    }
    // Function name: V8 "at name (" or SpiderMonkey "name@".
    const v8 = /^at\s+([^\s(]+)\s*\(/.exec(line);
    const sm = /^([^@\s]+)@/.exec(line);
    if (v8 && v8[1] && v8[1] !== 'eval') frame.fn = v8[1];
    else if (sm && sm[1]) frame.fn = sm[1];
    if (!frame.url) {
      frame.anonymous = true;
    } else if (ANONYMOUS_RE.test(line) && /\beval at\b/.test(line)) {
      // `at eval (eval at <anonymous> (https://site/app.js:1:1), <anonymous>:1:1)`:
      // code eval'd by a page script inherits that script's location.
      frame.anonymous = false;
    }
    frames.push(frame);
  }
  return frames;
}

function originOf(url: string): string | undefined {
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)/i.exec(url);
  return m ? m[1]!.toLowerCase() : undefined;
}

function pathOf(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+(\/[^?#]*)?/i.exec(url);
  return m?.[1] ?? '/';
}

/**
 * Is a frame URL trusted for `env`? Trusted means: same origin as the page (the
 * page's own scripts, its inline scripts reported at the document URL, its
 * dynamically imported chunks), or matching a configured trusted entry. Entries
 * may be an origin (`https://cdn.example.com`), a URL prefix
 * (`https://cdn.example.com/assets/`), or a same-origin path prefix (`/static/`).
 */
export function isTrustedUrl(url: string, env: StackEnv): boolean {
  const origin = originOf(url);
  if (!origin) return false;
  const pageOrigin = env.pageOrigin.toLowerCase();
  if (origin === pageOrigin) return true;
  for (const entry of env.trustedScriptOrigins) {
    if (!entry) continue;
    if (entry.startsWith('/')) {
      if (origin === pageOrigin && pathOf(url).startsWith(entry)) return true;
      continue;
    }
    const e = entry.toLowerCase();
    if (origin === e.replace(/\/$/, '')) return true;
    if (url.toLowerCase().startsWith(e)) return true;
  }
  return false;
}

function sanitise(line: string): string {
  return line.length > 160 ? line.slice(0, 157) + '...' : line;
}

/**
 * Classify parsed frames. `ownFrames` leading frames (our wrappers) are dropped,
 * then any further leading frames located in `env.selfUrl`.
 */
export function classifyFrames(all: StackFrame[], env: StackEnv, ownFrames = 0): StackVerdict {
  let frames = all.slice(Math.max(0, ownFrames));
  if (env.selfUrl && !ANONYMOUS_RE.test(env.selfUrl)) {
    const self = stripPosition(env.selfUrl);
    while (frames.length && frames[0]!.url && stripPosition(frames[0]!.url!) === self) frames = frames.slice(1);
  }
  const markers: string[] = [];
  const origins: string[] = [];
  let trusted = false;
  let anonymous = 0;
  let extension = 0;
  let pageScript = 0;
  let sample: string | undefined;
  for (const f of frames) {
    // Markers only count on frames without an http(s) script URL: evaluation
    // frames are `<anonymous>`/`pptr:`/sourceURL-named, never a page URL. This keeps
    // a site function that happens to be called `UtilityScript` from proving automation.
    if (!f.url || !/^https?:\/\//i.test(f.url)) {
      for (const m of MARKER_LIST) {
        if (f.raw.includes(m) && !markers.includes(m)) markers.push(m);
      }
    }
    if (f.url) {
      if (EXTENSION_SCHEME_RE.test(f.url)) {
        extension++;
        const o = originOf(f.url);
        if (o && !origins.includes(o)) origins.push(o);
      } else if (/^https?:\/\//i.test(f.url)) {
        if (isTrustedUrl(f.url, env)) trusted = true;
        else {
          pageScript++;
          const o = originOf(f.url);
          if (o && !origins.includes(o)) origins.push(o);
        }
      } else if (/^(blob|data):/i.test(f.url)) {
        anonymous++;
      } else {
        // file:, node:, webpack-internal:, pptr: and other schemes.
        if (/^pptr:/i.test(f.url)) {
          if (!markers.includes('pptr:')) markers.push('pptr:');
        } else {
          pageScript++;
          const o = originOf(f.url) ?? f.url.split('/')[0];
          if (o && !origins.includes(o)) origins.push(o);
        }
      }
    } else {
      anonymous++;
    }
    if (!sample && (markers.length || f.anonymous || !trusted)) sample = sanitise(f.raw);
  }
  let cls: StackClass;
  if (markers.length) cls = 'automation';
  else if (trusted) cls = 'trusted';
  else if (frames.length === 0) cls = 'none';
  else if (pageScript > 0) cls = 'page-script';
  else if (extension > 0 && anonymous === 0) cls = 'extension';
  else if (extension > 0) cls = 'extension';
  else cls = 'anonymous';
  const verdict: StackVerdict = { cls, markers, origins, frames: frames.length };
  if (sample) verdict.sample = sample;
  return verdict;
}

/** Convenience: parse + classify a raw stack string. */
export function classifyStack(stack: string | undefined | null, env: StackEnv, ownFrames = 0): StackVerdict {
  return classifyFrames(parseStack(stack), env, ownFrames);
}

/** Map automation markers to a provider hint (automation-stacks.md §2.5, §4.3). */
export function providerForMarkers(markers: readonly string[]): ProviderHint | undefined {
  if (markers.some((m) => m === 'pptr:' || m === '__puppeteer_evaluation_script__')) {
    return { id: 'puppeteer', product: 'Puppeteer page.evaluate', confidence: 0.9 };
  }
  if (markers.includes('__pyppeteer_evaluation_script__')) {
    return { id: 'puppeteer', product: 'pyppeteer page.evaluate', confidence: 0.9 };
  }
  if (markers.some((m) => m === 'UtilityScript' || m === '__playwright')) {
    return { id: 'playwright', product: 'Playwright page.evaluate', confidence: 0.9 };
  }
  if (markers.includes('InjectedScript')) {
    return { id: 'playwright', product: 'Playwright injected script', confidence: 0.6 };
  }
  if (markers.includes('newHandler.<computed> [as apply]')) {
    return { id: 'puppeteer', product: 'puppeteer-extra-plugin-stealth', confidence: 0.7 };
  }
  return undefined;
}

/** Merge several sampled stacks into one burst-level verdict (spec §4 ordering). */
export function aggregateVerdicts(samples: readonly StackVerdict[]): StackVerdict {
  const markers: string[] = [];
  const origins: string[] = [];
  let trusted = false;
  let anonymous = 0;
  let pageScript = 0;
  let extension = 0;
  let none = 0;
  let sample: string | undefined;
  let frames = 0;
  for (const s of samples) {
    for (const m of s.markers) if (!markers.includes(m)) markers.push(m);
    for (const o of s.origins) if (!origins.includes(o)) origins.push(o);
    frames += s.frames;
    if (s.cls === 'trusted') trusted = true;
    else if (s.cls === 'anonymous') anonymous++;
    else if (s.cls === 'page-script') pageScript++;
    else if (s.cls === 'extension') extension++;
    else if (s.cls === 'none') none++;
    if (!sample && s.sample && s.cls !== 'trusted') sample = s.sample;
  }
  let cls: StackClass;
  if (markers.length) cls = 'automation';
  else if (trusted) cls = 'trusted';
  else if (samples.length === 0 || (none === samples.length)) cls = 'none';
  else if (pageScript > 0) cls = 'page-script';
  else if (extension > 0) cls = 'extension';
  else if (anonymous > 0) cls = 'anonymous';
  else cls = 'none';
  const v: StackVerdict = { cls, markers, origins, frames };
  if (sample) v.sample = sample;
  return v;
}
