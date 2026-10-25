/**
 * Runtime.enable console-serialisation leak (docs/research/raw/cdp-leak-techniques.md section 2).
 *
 * Measured on Chrome 155/156 with `Runtime.enable` active:
 *   - a page-installed Error.prepareStackTrace is invoked once while the inspector
 *     builds the preview of a logged Error (0 without a client);
 *   - an inherited `name` getter on an Error subclass is read 3x (1x baseline),
 *     an inherited `message` getter 2x (1x baseline);
 *   - the classic own `stack` getter, the enumerable-getter object and the
 *     Proxy-prototype `console.groupEnd` channel are dead (0/0/0) on >= 138, kept
 *     as low-weight legacy channels for older Chromium forks.
 * Every counter only counts reads that happen inside our own console call, so a
 * page that logs errors itself or reads `.name` later cannot trip the probe.
 */

import { NATIVE_FUNCTION_TO_STRING, looksNative, sourceOf } from './util.js';

export interface ConsoleLike {
  debug(...args: unknown[]): void;
  groupEnd?(...args: unknown[]): void;
}

export interface LeakProbeDeps {
  console: ConsoleLike;
  /** Error constructor of the realm being probed (so prepareStackTrace is installed on the right Error). */
  errorCtor?: ErrorConstructor;
}

export interface LeakProbeResult {
  prepareStackTrace: number;
  nameReads: number;
  messageReads: number;
  legacyStackReads: number;
  legacyGetterReads: number;
  legacyProxyOwnKeys: number;
}

export interface LeakVerdict {
  leaked: boolean;
  /** 'modern' channels still fire on Chrome >= 138; 'legacy' only on older engines. */
  channels: string[];
  reliability: number;
}

export function runLeakProbe(deps: LeakProbeDeps): LeakProbeResult {
  const Err = deps.errorCtor ?? Error;
  const con = deps.console;
  const result: LeakProbeResult = { prepareStackTrace: 0, nameReads: 0, messageReads: 0, legacyStackReads: 0, legacyGetterReads: 0, legacyProxyOwnKeys: 0 };
  let inWindow = false;
  const log = (v: unknown) => {
    inWindow = true;
    try {
      con.debug(v);
    } finally {
      inWindow = false;
    }
  };

  // (a) Error.prepareStackTrace: V8 formats `stack` lazily when the inspector reads it.
  try {
    const target = new Err('necter-probe');
    const prevDesc = Object.getOwnPropertyDescriptor(Err, 'prepareStackTrace');
    const prev = (Err as unknown as { prepareStackTrace?: unknown }).prepareStackTrace;
    const hook = (err: unknown, frames: unknown) => {
      if (err === target) {
        if (inWindow) result.prepareStackTrace++;
        return 'necter-probe';
      }
      // Any other error: behave like the page's own hook (or V8's default) so nothing observable changes.
      if (typeof prev === 'function') return (prev as (e: unknown, f: unknown) => unknown)(err, frames);
      return undefined;
    };
    (Err as unknown as { prepareStackTrace?: unknown }).prepareStackTrace = hook;
    try {
      log(target);
    } finally {
      if (prevDesc) Object.defineProperty(Err, 'prepareStackTrace', prevDesc);
      else delete (Err as unknown as { prepareStackTrace?: unknown }).prepareStackTrace;
    }
  } catch {
    /* frozen Error or hostile page: skip channel */
  }

  // (b) inherited `name` / `message` getters on an Error subclass.
  try {
    class NameProbe extends Err {}
    Object.defineProperty(NameProbe.prototype, 'name', {
      get() {
        if (inWindow) result.nameReads++;
        return 'Error';
      },
      configurable: true,
    });
    log(new NameProbe('necter-probe'));
  } catch {
    /* skip */
  }
  try {
    class MessageProbe extends Err {}
    Object.defineProperty(MessageProbe.prototype, 'message', {
      get() {
        if (inWindow) result.messageReads++;
        return 'necter-probe';
      },
      configurable: true,
    });
    log(new MessageProbe());
  } catch {
    /* skip */
  }

  // (c) legacy channels (Chrome <= 137): own `stack` getter, plain enumerable getter, Proxy prototype + groupEnd.
  try {
    const e = new Err('necter-probe');
    Object.defineProperty(e, 'stack', {
      get() {
        if (inWindow) result.legacyStackReads++;
        return '';
      },
      configurable: true,
    });
    log(e);
  } catch {
    /* skip */
  }
  try {
    const o: Record<string, unknown> = {};
    Object.defineProperty(o, 'id', {
      get() {
        if (inWindow) result.legacyGetterReads++;
        return 'necter-probe';
      },
      enumerable: true,
      configurable: true,
    });
    log(o);
  } catch {
    /* skip */
  }
  try {
    if (typeof Proxy === 'function' && typeof con.groupEnd === 'function') {
      const proto = new Proxy(
        {},
        {
          ownKeys(t) {
            if (inWindow) result.legacyProxyOwnKeys++;
            return Reflect.ownKeys(t);
          },
        },
      );
      const obj = Object.create(proto) as Record<string, unknown>;
      obj.b = 2;
      inWindow = true;
      try {
        con.groupEnd(obj);
      } finally {
        inWindow = false;
      }
    }
  } catch {
    /* skip */
  }
  return result;
}

/**
 * True on V8 (the only engine whose inspector semantics the probe encodes): V8 calls
 * a page-installed `Error.prepareStackTrace` with an array of CallSites when `.stack`
 * is first read. SpiderMonkey and JSC ignore the hook.
 */
export function isV8(Err: ErrorConstructor = Error): boolean {
  let called = false;
  try {
    const holder = Err as unknown as { prepareStackTrace?: unknown };
    const prevDesc = Object.getOwnPropertyDescriptor(Err, 'prepareStackTrace');
    holder.prepareStackTrace = (_e: unknown, frames: unknown) => {
      called = Array.isArray(frames);
      return '';
    };
    try {
      void new Err('necter-v8').stack;
    } finally {
      if (prevDesc) Object.defineProperty(Err, 'prepareStackTrace', prevDesc);
      else delete holder.prepareStackTrace;
    }
  } catch {
    return false;
  }
  return called;
}

/**
 * The probe is only meaningful through the engine's own console: a logging or
 * error-reporting library that wraps `console.debug` (Sentry breadcrumbs, React
 * DevTools, LogRocket) stringifies the Error and reads `name`/`message`/`stack`
 * itself, which would look exactly like an inspector preview.
 */
export function consoleIsNative(con: ConsoleLike, toStringImpl: (this: unknown) => string = NATIVE_FUNCTION_TO_STRING): boolean {
  const src = sourceOf(con.debug, toStringImpl);
  return src !== undefined && looksNative(src);
}

/** Interpret counters: modern channels are decisive; legacy-only hits are discounted. */
export function judgeLeak(r: LeakProbeResult): LeakVerdict {
  const channels: string[] = [];
  if (r.prepareStackTrace > 0) channels.push(`prepareStackTrace x${r.prepareStackTrace}`);
  if (r.nameReads > 1) channels.push(`name getter x${r.nameReads}`);
  if (r.messageReads > 1) channels.push(`message getter x${r.messageReads}`);
  const modern = channels.length > 0;
  if (r.legacyStackReads > 0) channels.push(`stack getter x${r.legacyStackReads}`);
  if (r.legacyGetterReads > 0) channels.push(`enumerable getter x${r.legacyGetterReads}`);
  if (r.legacyProxyOwnKeys > 0) channels.push(`proxy ownKeys x${r.legacyProxyOwnKeys}`);
  if (!channels.length) return { leaked: false, channels, reliability: 0 };
  return { leaked: true, channels, reliability: modern ? 1 : 0.5 };
}

/**
 * DevTools disambiguation: with the Debugger domain enabled (DevTools UI open),
 * a `debugger;` statement blocks until resume (measured 507 ms vs 0 ms without).
 * Automation stacks do not enable Debugger in normal operation. Only called after
 * the leak fired, so an ordinary page never pays a pause.
 */
export function measureDebuggerPause(now: () => number = () => performance.now()): number {
  try {
    const t0 = now();
    // eslint-disable-next-line no-debugger
    debugger;
    return now() - t0;
  } catch {
    return 0;
  }
}

export const DEVTOOLS_PAUSE_THRESHOLD_MS = 100;
