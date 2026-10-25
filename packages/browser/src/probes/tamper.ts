import { isSdkWrapper } from '../harvest/instrument.js';
import { NATIVE_FUNCTION_TO_STRING, attempt, looksNative, sourceOf } from './util.js';

/**
 * Tamper / lie detection (docs/research/raw/cdp-leak-techniques.md section 10.2).
 * Stealth plugins replace native getters with JS functions or Proxies. Tells:
 *   - the getter/method source is not `function name() { [native code] }`;
 *   - Function.prototype.toString itself is not native (toString.toString());
 *   - the property moved from the prototype to the instance (own descriptor);
 *   - a Proxy around a native function reports `function () { [native code] }` with
 *     an empty name while `fn.name` still says e.g. "query";
 *   - a replacement function owns a `prototype` or extra own keys (native methods
 *     own exactly `length` and `name`, in that order);
 *   - Function.prototype.toString.call(fn) throwing for something `typeof === 'function'`;
 *   - a WebIDL getter invoked with the prototype as receiver must throw ("Illegal
 *     invocation"); JS replacements usually return a value (CreepJS `failed illegal error`).
 * Sources are read through the fresh iframe realm's `Function.prototype.toString`
 * when available, so a main-world toString patch cannot vouch for itself.
 */

export interface TamperTarget {
  label: string;
  /** Instance that should not own the property (navigator, screen). */
  instance?: object;
  /** Prototype that should own the accessor/method. */
  proto: object | undefined;
  property: string;
  kind: 'getter' | 'method';
}

export interface TamperFinding {
  label: string;
  /** Which tell fired. */
  tell:
    | 'non-native-source'
    | 'own-on-instance'
    | 'proxy-anonymous-native'
    | 'extra-own-keys'
    | 'has-prototype'
    | 'toString-throws'
    | 'missing-descriptor'
    | 'no-illegal-invocation';
  detail: string;
}

export interface TamperDeps {
  /** toString believed to be native (captured before our own patch). */
  nativeToString?: (this: unknown) => string;
}

export function checkFunctionShape(fn: unknown, label: string, nativeToString: (this: unknown) => string): TamperFinding[] {
  const out: TamperFinding[] = [];
  if (typeof fn !== 'function') return out;
  // Our own wrappers answer natively through the toString patch but are JS functions;
  // skip them (identity tracked privately by the instrumentation, so a page cannot spoof it).
  if (isSdkWrapper(fn)) return out;
  const src = sourceOf(fn, nativeToString);
  if (src === undefined) {
    out.push({ label, tell: 'toString-throws', detail: 'Function.prototype.toString.call threw for a callable' });
    return out;
  }
  if (!looksNative(src)) {
    out.push({ label, tell: 'non-native-source', detail: src.slice(0, 80) });
    return out;
  }
  const name = attempt(() => (fn as { name: string }).name) ?? '';
  if (/^function\s*\(\)\s*\{\s*\[native code\]\s*\}$/.test(src.trim()) && name !== '') {
    out.push({ label, tell: 'proxy-anonymous-native', detail: `toString anonymous but name is "${name}"` });
  }
  const keys = attempt(() => Reflect.ownKeys(fn as object)) ?? [];
  const strKeys = keys.map((k) => (typeof k === 'string' ? k : String(k)));
  if (strKeys.includes('prototype')) {
    out.push({ label, tell: 'has-prototype', detail: 'native accessor/method owns a prototype' });
  } else {
    // Compare as a set: V8 orders them length,name; other engines are not guaranteed to.
    const sorted = [...strKeys].sort();
    if (sorted.length !== 2 || sorted[0] !== 'length' || sorted[1] !== 'name') {
      out.push({ label, tell: 'extra-own-keys', detail: strKeys.join(',') });
    }
  }
  return out;
}

export function checkTarget(t: TamperTarget, deps: TamperDeps = {}): TamperFinding[] {
  const nativeToString = deps.nativeToString ?? NATIVE_FUNCTION_TO_STRING;
  const out: TamperFinding[] = [];
  try {
    if (t.instance && Object.prototype.hasOwnProperty.call(t.instance, t.property)) {
      out.push({ label: t.label, tell: 'own-on-instance', detail: `${t.property} is an own property of the instance` });
    }
    if (!t.proto) return out;
    const desc = Object.getOwnPropertyDescriptor(t.proto, t.property);
    if (!desc) {
      out.push({ label: t.label, tell: 'missing-descriptor', detail: `${t.property} missing from the prototype` });
      return out;
    }
    if (t.kind === 'getter') {
      if (typeof desc.get !== 'function') out.push({ label: t.label, tell: 'non-native-source', detail: 'accessor replaced by a data property' });
      else {
        const shape = checkFunctionShape(desc.get, t.label, nativeToString);
        out.push(...shape);
        if (!shape.length && !isSdkWrapper(desc.get) && t.instance) {
          // Brand check: a WebIDL attribute getter called on the prototype throws.
          let threw = false;
          try {
            Reflect.apply(desc.get, t.proto, []);
          } catch {
            threw = true;
          }
          if (!threw) out.push({ label: t.label, tell: 'no-illegal-invocation', detail: 'getter returned a value for the prototype receiver instead of throwing' });
        }
      }
    } else {
      if (typeof desc.value !== 'function') out.push({ label: t.label, tell: 'non-native-source', detail: 'method replaced by a non-function' });
      else out.push(...checkFunctionShape(desc.value, t.label, nativeToString));
    }
  } catch (err) {
    out.push({ label: t.label, tell: 'toString-throws', detail: String(err).slice(0, 80) });
  }
  return out;
}

/** Function.prototype.toString must itself be native (through itself and through a believed-native copy). */
export function checkToStringIntegrity(current: (this: unknown) => string, nativeToString: (this: unknown) => string): TamperFinding[] {
  if (isSdkWrapper(current)) return [];
  const out: TamperFinding[] = [];
  const self = attempt(() => current.call(current));
  if (self === undefined || !looksNative(self)) out.push({ label: 'Function.prototype.toString', tell: 'non-native-source', detail: `toString.toString() = ${String(self).slice(0, 60)}` });
  if (current !== nativeToString) {
    const viaNative = attempt(() => nativeToString.call(current));
    if (viaNative !== undefined && !looksNative(viaNative)) out.push({ label: 'Function.prototype.toString', tell: 'non-native-source', detail: 'replaced after load' });
  }
  return out;
}

export function defaultTamperTargets(g: typeof globalThis = globalThis, opts: { chromium?: boolean } = {}): TamperTarget[] {
  const w = g as unknown as Record<string, unknown>;
  const nav = w['navigator'] as object | undefined;
  const navProto = (w['Navigator'] as { prototype?: object } | undefined)?.prototype;
  const scr = w['screen'] as object | undefined;
  const scrProto = (w['Screen'] as { prototype?: object } | undefined)?.prototype;
  const out: TamperTarget[] = [];
  if (nav && navProto) {
    for (const p of ['webdriver', 'plugins', 'languages', 'platform', 'hardwareConcurrency', 'userAgentData', 'userAgent']) {
      // Chromium always defines these on Navigator.prototype; elsewhere a missing userAgentData/webdriver is not a tell.
      if ((p === 'userAgentData' || p === 'webdriver') && !opts.chromium && !(p in navProto)) continue;
      out.push({ label: `navigator.${p}`, instance: nav, proto: navProto, property: p, kind: 'getter' });
    }
  }
  if (scr && scrProto) {
    for (const p of ['width', 'height']) out.push({ label: `screen.${p}`, instance: scr, proto: scrProto, property: p, kind: 'getter' });
  }
  const webgl = (w['WebGLRenderingContext'] as { prototype?: object } | undefined)?.prototype;
  if (webgl) out.push({ label: 'WebGLRenderingContext.prototype.getParameter', proto: webgl, property: 'getParameter', kind: 'method' });
  return out;
}

// ───────────────────────── fresh realm comparison ─────────────────────────

export interface RealmValues {
  webdriver: unknown;
  platform: unknown;
  hardwareConcurrency: unknown;
  languages: string;
  userAgent: unknown;
  pluginsLength: unknown;
}

export function readRealmValues(nav: Navigator | undefined): RealmValues {
  return {
    webdriver: attempt(() => nav?.webdriver),
    platform: attempt(() => nav?.platform),
    hardwareConcurrency: attempt(() => nav?.hardwareConcurrency),
    languages: attempt(() => Array.from(nav?.languages ?? []).join(',')) ?? '',
    userAgent: attempt(() => nav?.userAgent),
    pluginsLength: attempt(() => nav?.plugins?.length),
  };
}

export function diffRealms(main: RealmValues, fresh: RealmValues): string[] {
  const keys: (keyof RealmValues)[] = ['webdriver', 'platform', 'hardwareConcurrency', 'languages', 'userAgent', 'pluginsLength'];
  return keys.filter((k) => main[k] !== undefined && fresh[k] !== undefined && main[k] !== fresh[k]);
}

export interface FreshRealm {
  values: RealmValues;
  toString: ((this: unknown) => string) | undefined;
  /** Stealth `iframe.contentWindow` evasions hand back the parent window. */
  windowIsParent: boolean;
}

/** Append a hidden same-origin iframe, read its realm, remove it. Returns undefined when CSP/sandbox forbids it. */
export function openFreshRealm(doc: Document): FreshRealm | undefined {
  let iframe: HTMLIFrameElement | undefined;
  try {
    iframe = doc.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.setAttribute('tabindex', '-1');
    iframe.style.cssText = 'position:absolute;left:-10000px;width:1px;height:1px;visibility:hidden;';
    // Body rather than <html>: other modules watch attribute-less hosts appended to <html>.
    (doc.body ?? doc.documentElement).appendChild(iframe);
    const win = iframe.contentWindow as (Window & typeof globalThis) | null;
    if (!win) return undefined;
    const parent = doc.defaultView as unknown;
    // Stealth `iframe.contentWindow` evasions hand back the parent window (or a proxy of it):
    // the child must not be its own top, and its navigator must not be the parent's.
    const windowIsParent =
      win === parent ||
      attempt(() => win.self === win.top) === true ||
      attempt(() => (win.navigator as unknown) === (doc.defaultView as Window | null)?.navigator) === true;
    const values = readRealmValues(win.navigator);
    const toString = attempt(() => win.Function.prototype.toString) as ((this: unknown) => string) | undefined;
    return { values, toString, windowIsParent };
  } catch {
    return undefined;
  } finally {
    attempt(() => iframe?.remove());
  }
}
