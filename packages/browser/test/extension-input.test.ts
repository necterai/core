import { describe, expect, it } from 'vitest';
import {
  createHiddenInputState,
  describeHiddenInput,
  evaluateFocusEmulation,
  hiddenInputReached,
  recordHiddenInput,
} from '../src/extension/input.js';

describe('hidden-tab input counting', () => {
  it('counts trusted pointer/keyboard events while hidden and fires at two', () => {
    const s = createHiddenInputState();
    expect(recordHiddenInput(s, { type: 'pointerdown', isTrusted: true, timeStamp: 1000 }, 'hidden', false)).toBe(true);
    expect(hiddenInputReached(s)).toBe(false);
    expect(recordHiddenInput(s, { type: 'keydown', isTrusted: true, timeStamp: 1012 }, 'hidden', false)).toBe(true);
    expect(hiddenInputReached(s)).toBe(true);
    expect(s.count).toBe(2);
    expect(s.byType).toEqual({ pointerdown: 1, keydown: 1 });
    expect(describeHiddenInput(s)).toBe('2 trusted input events (1 pointerdown, 1 keydown) arrived while document.visibilityState === "hidden" over 12 ms.');
  });

  it('ignores untrusted events, visible-tab events, prerendering and non-input types', () => {
    const s = createHiddenInputState();
    expect(recordHiddenInput(s, { type: 'pointerdown', isTrusted: false, timeStamp: 1 }, 'hidden', false)).toBe(false);
    expect(recordHiddenInput(s, { type: 'pointerdown', isTrusted: true, timeStamp: 2 }, 'visible', false)).toBe(false);
    expect(recordHiddenInput(s, { type: 'pointerdown', isTrusted: true, timeStamp: 3 }, 'hidden', true)).toBe(false);
    expect(recordHiddenInput(s, { type: 'pointermove', isTrusted: true, timeStamp: 4 }, 'hidden', false)).toBe(false);
    expect(recordHiddenInput(s, { type: 'scroll', isTrusted: true, timeStamp: 5 }, 'hidden', false)).toBe(false);
    expect(s.count).toBe(0);
  });

  it('applies a grace window after the tab became hidden (tab-switch race)', () => {
    const s = createHiddenInputState();
    s.hiddenSince = 5000;
    expect(recordHiddenInput(s, { type: 'keyup', isTrusted: true, timeStamp: 5040 }, 'hidden', false)).toBe(false);
    expect(recordHiddenInput(s, { type: 'keyup', isTrusted: true, timeStamp: 5140 }, 'hidden', false)).toBe(true);
    expect(recordHiddenInput(s, { type: 'keyup', isTrusted: true, timeStamp: 5020 }, 'hidden', false, { graceMs: 10 })).toBe(true);
  });

  it('honours a custom threshold', () => {
    const s = createHiddenInputState();
    for (let i = 0; i < 3; i++) recordHiddenInput(s, { type: 'click', isTrusted: true, timeStamp: i }, 'hidden', false);
    expect(hiddenInputReached(s, { threshold: 4 })).toBe(false);
    expect(hiddenInputReached(s, { threshold: 3 })).toBe(true);
  });
});

describe('focus-emulation decision', () => {
  const fresh = { sawFocus: false, sawPageshow: false, startedAfterLoad: false };

  it('fires with full reliability when hasFocus() is true while hidden', () => {
    const v = evaluateFocusEmulation(true, 'hidden', { ...fresh, sawFocus: true, sawPageshow: true }, 2500);
    expect(v.fire).toBe(true);
    if (v.fire) {
      expect(v.rule).toBe('hidden-but-focused');
      expect(v.reliability).toBe(1);
      expect(v.summary).toContain('2500 ms');
    }
  });

  it('fires weakly when focused but no focus/pageshow was ever observed after 1 s', () => {
    expect(evaluateFocusEmulation(true, 'visible', fresh, 500).fire).toBe(false);
    const v = evaluateFocusEmulation(true, 'visible', fresh, 1200);
    expect(v.fire).toBe(true);
    if (v.fire) {
      expect(v.rule).toBe('never-focused');
      expect(v.reliability).toBe(0.5);
    }
  });

  it('stays silent when a pageshow or focus was seen, when the SDK started after load, or when not focused', () => {
    expect(evaluateFocusEmulation(true, 'visible', { ...fresh, sawPageshow: true }, 5000).fire).toBe(false);
    expect(evaluateFocusEmulation(true, 'visible', { ...fresh, sawFocus: true }, 5000).fire).toBe(false);
    expect(evaluateFocusEmulation(true, 'visible', { ...fresh, startedAfterLoad: true }, 5000).fire).toBe(false);
    expect(evaluateFocusEmulation(false, 'hidden', fresh, 5000).fire).toBe(false);
  });
});
