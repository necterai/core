/**
 * Hidden-tab input and focus-emulation feature extraction (extension-agents.md
 * 2.6, 2.9 #6, 3.5; detection-spec.md section 3 "Hidden-tab input" and 6).
 *
 * - Agents screenshot (`Page.captureScreenshot {fromSurface:true}`) and dispatch
 *   `Input.dispatch*` on background tabs, so trusted pointer/keyboard events
 *   arrive while `document.visibilityState === 'hidden'`. People cannot do that:
 *   a hidden tab receives no OS input. Threshold: >= 2 events (one can be a
 *   race with the visibility transition).
 * - `Emulation.setFocusEmulationEnabled {enabled:true}` (Claude, Codex) makes
 *   `document.hasFocus()` return true while the window is not focused or the
 *   page is hidden.
 */

export const HIDDEN_INPUT_EVENT_TYPES: readonly string[] = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'keydown', 'keyup', 'wheel'];

export interface HiddenInputState {
  count: number;
  byType: Record<string, number>;
  firstTs?: number;
  lastTs?: number;
  /** timeStamp of the last transition to hidden (for the grace window). */
  hiddenSince?: number;
}

export interface HiddenInputOptions {
  /** Events arriving within this many ms after the tab became hidden are ignored (tab-switch race). Default 100. */
  graceMs?: number;
  /** Count needed before a signal is emitted. Default 2. */
  threshold?: number;
}

export function createHiddenInputState(): HiddenInputState {
  return { count: 0, byType: {} };
}

export interface ObservedInput {
  type: string;
  isTrusted: boolean;
  timeStamp: number;
}

/**
 * Feed one input event. Returns true when the event counted (trusted, hidden,
 * outside the grace window).
 */
export function recordHiddenInput(state: HiddenInputState, ev: ObservedInput, visibilityState: string, prerendering: boolean, opts: HiddenInputOptions = {}): boolean {
  if (!ev.isTrusted) return false;
  if (visibilityState !== 'hidden' || prerendering) return false;
  if (!HIDDEN_INPUT_EVENT_TYPES.includes(ev.type)) return false;
  const grace = opts.graceMs ?? 100;
  if (state.hiddenSince !== undefined && ev.timeStamp - state.hiddenSince < grace) return false;
  state.count += 1;
  state.byType[ev.type] = (state.byType[ev.type] ?? 0) + 1;
  if (state.firstTs === undefined) state.firstTs = ev.timeStamp;
  state.lastTs = ev.timeStamp;
  return true;
}

export function hiddenInputReached(state: HiddenInputState, opts: HiddenInputOptions = {}): boolean {
  return state.count >= (opts.threshold ?? 2);
}

export function describeHiddenInput(state: HiddenInputState): string {
  const kinds = Object.entries(state.byType)
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');
  const span = state.firstTs !== undefined && state.lastTs !== undefined ? Math.round(state.lastTs - state.firstTs) : 0;
  return `${state.count} trusted input events (${kinds}) arrived while document.visibilityState === "hidden" over ${span} ms.`;
}

export interface FocusEvidence {
  /** A trusted window `focus` event was observed in this document. */
  sawFocus: boolean;
  /** A `pageshow` event was observed (fires on every normal load). */
  sawPageshow: boolean;
  /** The SDK started after `load`, so pageshow may already have fired unobserved. */
  startedAfterLoad: boolean;
}

export type FocusEmulationVerdict =
  | { fire: false }
  | { fire: true; rule: 'hidden-but-focused' | 'never-focused'; reliability: number; summary: string };

/**
 * Decide whether focus emulation is plausible.
 * - hidden-but-focused: `hasFocus()` true while hidden (reliability 1; the signal is weak in the catalog).
 * - never-focused: `hasFocus()` true, SDK started before load, no focus/pageshow ever seen (reliability 0.5).
 */
export function evaluateFocusEmulation(hasFocus: boolean, visibilityState: string, ev: FocusEvidence, msSinceStart: number): FocusEmulationVerdict {
  if (!hasFocus) return { fire: false };
  if (visibilityState === 'hidden') {
    return {
      fire: true,
      rule: 'hidden-but-focused',
      reliability: 1,
      summary: `document.hasFocus() === true while document.visibilityState === "hidden" (${Math.round(msSinceStart)} ms after start).`,
    };
  }
  if (!ev.startedAfterLoad && !ev.sawFocus && !ev.sawPageshow && msSinceStart >= 1000) {
    return {
      fire: true,
      rule: 'never-focused',
      reliability: 0.5,
      summary: `document.hasFocus() === true ${Math.round(msSinceStart)} ms after start although no focus or pageshow event was ever observed.`,
    };
  }
  return { fire: false };
}
