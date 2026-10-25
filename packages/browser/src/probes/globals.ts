import type { ProviderHint, SignalInput } from '@necterai/core';
import { DOCUMENT_ELEMENT_ATTRIBUTES, matchKnownGlobal, type GlobalMatch } from './known-globals.js';
import { NATIVE_FUNCTION_TO_STRING, attempt, listSummary, sourceOf } from './util.js';

/**
 * Residue-globals scanner: diff `Object.getOwnPropertyNames(window)` against a
 * baseline, match known driver names, and look for the exact property shape
 * that `Runtime.addBinding` produces (own, enumerable, anonymous native function).
 */

export interface GlobalsScanResult {
  /** Names present now that were not in the baseline (or all names on the first scan). */
  added: string[];
  /** Table matches (window + document properties). */
  matches: GlobalMatch[];
  /** Own enumerable window functions with name "" and a native toString (Runtime.addBinding shape). */
  bindingResidue: string[];
  /** `<html>` attributes such as webdriver/selenium/driver. */
  documentAttributes: string[];
}

export interface GlobalsScanDeps {
  win: Record<string, unknown>;
  doc?: Record<string, unknown> & { documentElement?: Element | null };
  /** Untouched Function.prototype.toString (so a page-patched toString cannot hide a binding). */
  nativeToString?: (this: unknown) => string;
}

/** Baseline of property names on the global object. */
export function snapshotGlobals(win: Record<string, unknown>): Set<string> {
  return new Set(attempt(() => Object.getOwnPropertyNames(win)) ?? []);
}

/** The exact shape Runtime.addBinding installs on the global object. */
export function isBindingResidue(win: Record<string, unknown>, name: string, nativeToString = NATIVE_FUNCTION_TO_STRING): boolean {
  try {
    const desc = Object.getOwnPropertyDescriptor(win, name);
    if (!desc || !desc.enumerable || !('value' in desc)) return false;
    const v = desc.value;
    if (typeof v !== 'function') return false;
    if ((v as { name: string }).name !== '') return false;
    // `window.noop = Function.prototype` (any realm's) is anonymous and native too, but its
    // [[Prototype]] is Object.prototype; binding functions inherit from Function.prototype.
    if (Object.getPrototypeOf(v) !== Function.prototype) return false;
    const src = sourceOf(v, nativeToString);
    return src !== undefined && /^function\s*\(\)\s*\{\s*\[native code\]\s*\}$/.test(src.trim());
  } catch {
    return false;
  }
}

/**
 * Scan the global object. `baseline` is the set captured at start; names in it
 * are still matched against the table on the first scan (`matchBaseline`), because
 * init scripts (chromedriver `cdc_*`, Playwright bindings) run before any page script.
 */
export function scanGlobals(deps: GlobalsScanDeps, baseline: Set<string>, opts: { matchBaseline?: boolean } = {}): GlobalsScanResult {
  const names = attempt(() => Object.getOwnPropertyNames(deps.win)) ?? [];
  const candidates = opts.matchBaseline ? names : names.filter((n) => !baseline.has(n));
  const matches: GlobalMatch[] = [];
  const bindingResidue: string[] = [];
  for (const name of candidates) {
    // Only read data properties: touching accessor globals can run deprecated getters that log warnings.
    const m = matchKnownGlobal(name, 'window', () => dataValue(deps.win, name));
    if (m) {
      matches.push(m);
      continue;
    }
    if (isBindingResidue(deps.win, name, deps.nativeToString)) bindingResidue.push(name);
  }
  const documentAttributes: string[] = [];
  if (deps.doc) {
    const docNames = attempt(() => Object.getOwnPropertyNames(deps.doc as object)) ?? [];
    for (const name of docNames) {
      const m = matchKnownGlobal(name, 'document', () => dataValue(deps.doc as Record<string, unknown>, name));
      if (m) matches.push(m);
    }
    const el = attempt(() => deps.doc?.documentElement);
    if (el) {
      const attrs = attempt(() => el.getAttributeNames()) ?? [];
      for (const a of attrs) if (DOCUMENT_ELEMENT_ATTRIBUTES.test(a)) documentAttributes.push(a);
    }
  }
  return { added: names.filter((n) => !baseline.has(n)), matches, bindingResidue, documentAttributes };
}

function dataValue(obj: Record<string, unknown>, name: string): unknown {
  const desc = Object.getOwnPropertyDescriptor(obj, name);
  return desc && 'value' in desc ? desc.value : undefined;
}

/**
 * Cumulative report state: one entry per signal id so a later scan re-emits the
 * id with *all* names seen so far (the runtime keeps only the latest signal per id).
 */
export interface GlobalsReportState {
  reported: Set<string>;
  perSignal: Map<string, { names: string[]; provider?: ProviderHint; reliability: number; kinds: Set<string> }>;
}

export function createGlobalsReportState(): GlobalsReportState {
  return { reported: new Set(), perSignal: new Map() };
}

/** Turn a scan result into signal inputs: only ids that gained a new name are returned, each with every name seen so far. */
export function globalsToSignals(result: GlobalsScanResult, state: GlobalsReportState): SignalInput[] {
  const changed = new Set<string>();
  const add = (id: string, name: string, kind: string, reliability: number, provider?: ProviderHint): void => {
    const entry = state.perSignal.get(id) ?? { names: [], reliability: 0, kinds: new Set<string>() };
    entry.names.push(name);
    entry.kinds.add(kind);
    if (reliability > entry.reliability) {
      entry.reliability = reliability;
      if (provider) entry.provider = provider;
    } else if (!entry.provider && provider) {
      entry.provider = provider;
    }
    state.perSignal.set(id, entry);
    changed.add(id);
  };
  for (const m of result.matches) {
    const key = `${m.on}:${m.name}`;
    if (state.reported.has(key)) continue;
    state.reported.add(key);
    add(m.rule.signal, m.on === 'document' ? `document.${m.name}` : m.name, 'global', m.rule.reliability ?? 1, m.rule.provider);
  }
  for (const a of result.documentAttributes) {
    const key = `attr:${a}`;
    if (state.reported.has(key)) continue;
    state.reported.add(key);
    add('probe.selenium-artifact', `<html ${a}>`, 'document-attribute', 1, { id: 'selenium', product: 'WebDriver', confidence: 0.7 });
  }
  for (const n of result.bindingResidue) {
    const key = `binding:${n}`;
    if (state.reported.has(key)) continue;
    state.reported.add(key);
    add('probe.cdp-binding-residue', n, 'binding', 1);
  }
  const out: SignalInput[] = [];
  for (const id of changed) {
    const entry = state.perSignal.get(id)!;
    const n = entry.names.length;
    const summary =
      id === 'probe.cdp-binding-residue'
        ? `${n} anonymous native function${n === 1 ? '' : 's'} installed as enumerable window global${n === 1 ? '' : 's'} (Runtime.addBinding shape): ${listSummary(entry.names)}`
        : `${n} automation residue artifact${n === 1 ? '' : 's'} in the page: ${listSummary(entry.names)}`;
    const input: SignalInput = { id, summary, value: [...entry.names], details: { kind: [...entry.kinds].join(',') } };
    if (entry.reliability < 1) input.reliability = entry.reliability;
    if (entry.provider) input.provider = entry.provider;
    out.push(input);
  }
  return out;
}
