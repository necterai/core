/**
 * Small helpers shared by the probes. Everything here is defensive: a probe
 * that throws must never reach the host page, so every helper swallows.
 */
import { WRAPPED_MARKER, hasWrappedMarker, setWrappedMarker } from '../harvest/instrument.js';

/** Marker set on every function wrapper installed by the SDK (shared with the harvest module). */
export { WRAPPED_MARKER };

export function attempt<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

export function isWrapped(fn: unknown): boolean {
  return hasWrappedMarker(fn);
}

export function markWrapped(fn: (...args: never[]) => unknown): void {
  setWrappedMarker(fn);
}

/** The unpatched Function.prototype.toString captured as early as possible. */
export const NATIVE_FUNCTION_TO_STRING: (this: unknown) => string = Function.prototype.toString;

/** Matches `function name() { [native code] }` and the `get name()` accessor form. */
export const NATIVE_CODE_RE = /^function\s*(?:get |set )?[\w$]*\(\)\s*\{\s*\[native code\]\s*\}$/;

export function looksNative(source: string): boolean {
  return NATIVE_CODE_RE.test(source.trim());
}

/** Return the string form of a function through a specific toString, or undefined if that throws. */
export function sourceOf(fn: unknown, toStringImpl: (this: unknown) => string = NATIVE_FUNCTION_TO_STRING): string | undefined {
  try {
    return toStringImpl.call(fn);
  } catch {
    return undefined;
  }
}

/** Build a one-line, bounded summary list ("a, b, c (+2 more)"). */
export function listSummary(items: readonly string[], max = 4): string {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} (+${items.length - max} more)`;
}

export function isChromiumUA(ua: string): boolean {
  return /Chrome\/|Chromium\/|CriOS\//.test(ua) && !/Edge\/\d/.test(ua);
}
