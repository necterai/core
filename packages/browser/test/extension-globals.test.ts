import { afterEach, describe, expect, it } from 'vitest';
import { GLOBAL_SCAN_SCHEDULE_MS, describeGlobalHit, scanMainWorldGlobals } from '../src/extension/globals.js';

const w = window as unknown as Record<string, unknown>;
const d = document as unknown as Record<string, unknown>;

afterEach(() => {
  for (const k of Object.getOwnPropertyNames(w)) if (k.startsWith('__browserUse') || k.startsWith('__cursor')) delete w[k];
  delete d['__codexNativeWebMcpState'];
  document.body.innerHTML = '';
});

describe('main-world agent globals', () => {
  it('finds nothing on a clean window', () => {
    expect(scanMainWorldGlobals(window, document)).toEqual([]);
  });

  it('detects the Codex clipboard bridge object and its Runtime.addBinding function', () => {
    w['__browserUseClipboardBridge'] = { bindingName: '__browserUseClipboard_0123456789abcdef0123456789abcdef', respond() {}, cleanup() {} };
    w['__browserUseClipboard_0123456789abcdef0123456789abcdef'] = () => {};
    const hits = scanMainWorldGlobals(window, document);
    expect(hits.map((h) => h.key)).toEqual(['__browserUseClipboardBridge', '__browserUseClipboard_0123456789abcdef0123456789abcdef']);
    expect(hits.every((h) => h.driver === 'codex')).toBe(true);
    expect(describeGlobalHit(hits[0]!)).toBe('globalThis.__browserUseClipboardBridge present in the main world (clipboard bridge object, Codex browser driver (ChatGPT extension)).');
  });

  it('requires the clipboard bridge to be an object (a string of that name is not the driver)', () => {
    w['__browserUseClipboardBridge'] = 'nope';
    expect(scanMainWorldGlobals(window, document)).toEqual([]);
  });

  it('detects Cursor injection flags and data-cursor-ref attributes', () => {
    w['__cursorBrowserAutomationInjected'] = true;
    w['__cursorAreaScreenshotInjected'] = true;
    document.body.innerHTML = '<button data-cursor-ref="e7">x</button>';
    const hits = scanMainWorldGlobals(window, document);
    expect(hits.map((h) => h.key)).toEqual(['__cursorBrowserAutomationInjected', '__cursorAreaScreenshotInjected', '[data-cursor-ref="e7"]']);
    expect(hits.every((h) => h.driver === 'cursor')).toBe(true);
  });

  it('detects document.__codexNativeWebMcpState', () => {
    d['__codexNativeWebMcpState'] = { tools: [] };
    const hits = scanMainWorldGlobals(window, document);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ key: '__codexNativeWebMcpState', where: 'document', driver: 'codex' });
  });

  it('survives hostile getters', () => {
    Object.defineProperty(window, '__cursorAreaScreenshotCommand', {
      configurable: true,
      get() {
        throw new Error('trap');
      },
    });
    expect(() => scanMainWorldGlobals(window, document)).not.toThrow();
  });

  it('scans at start, 1 s, 5 s and idle ticks up to 30 s', () => {
    expect(GLOBAL_SCAN_SCHEDULE_MS[0]).toBe(0);
    expect(GLOBAL_SCAN_SCHEDULE_MS).toContain(1000);
    expect(GLOBAL_SCAN_SCHEDULE_MS).toContain(5000);
    expect(Math.max(...GLOBAL_SCAN_SCHEDULE_MS)).toBe(30000);
  });
});
