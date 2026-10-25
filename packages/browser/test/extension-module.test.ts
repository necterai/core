import { afterEach, describe, expect, it, vi } from 'vitest';
import { SIGNAL_CATALOG, createRegistry, createSignal, type Signal, type SignalInput } from '@necterai/core';
import { createExtensionModule, type ExtensionModuleDeps } from '../src/extension/index.js';
import { createScheduler } from '../src/scheduler.js';
import type { Module, ModuleContext } from '../src/types.js';

const CLAUDE_URLS = [
  'chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/assets/accessibility-tree.js-B-oUarrX.js',
  'chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/assets/agent-visual-indicator.js-uaVFxZ2f.js',
];

interface Harness {
  ctx: ModuleContext;
  signals: Signal[];
  mod: Module;
  byId(id: string): Signal | undefined;
  stop(): void;
}

function harness(deps: ExtensionModuleDeps = {}, options: Record<string, unknown> = {}): Harness {
  const registry = createRegistry(SIGNAL_CATALOG);
  const schedule = createScheduler();
  const signals: Signal[] = [];
  const ctx = {
    config: { modules: { extension: options } } as unknown as ModuleContext['config'],
    session: { id: 's1', firstVisit: true, startedAt: Date.now(), pageViews: 1 },
    registry,
    schedule,
    options,
    now: () => Date.now(),
    emit(input: SignalInput) {
      const s = createSignal(input, registry, { source: 'client' });
      signals.push(s);
      return s;
    },
    retract() {},
    event() {},
    requestEvaluate() {},
    finalize() {},
    log() {},
    verdict: () => ({}) as ReturnType<ModuleContext['verdict']>,
  } as ModuleContext;
  const mod = createExtensionModule({
    war: { fetch: async () => Promise.reject(new TypeError('Failed to fetch')), watchViolations: () => () => {}, cspBlocksExtensionConnect: () => false, wait: async () => {} },
    visibilityState: () => 'visible',
    hasFocus: () => false,
    brands: () => [{ brand: 'Google Chrome', version: '155' }, { brand: 'Chromium', version: '155' }, { brand: 'Not(A:Brand', version: '24' }],
    ...deps,
  });
  mod.start(ctx);
  return {
    ctx,
    signals,
    mod,
    byId: (id) => [...signals].reverse().find((s) => s.id === id),
    stop() {
      mod.stop?.();
      schedule.dispose();
    },
  };
}

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const trusted = () => true;

afterEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  document.documentElement.className = '';
});

describe('extension module wiring', () => {
  it('has the module name "extension" and emits nothing on a clean page', async () => {
    const h = harness();
    expect(h.mod.name).toBe('extension');
    document.body.appendChild(document.createElement('footer'));
    await tick(150);
    expect(h.signals).toEqual([]);
    h.stop();
  });

  it('emits extension.active-agent-indicator with anthropic attribution when the Claude host appears', async () => {
    const display = new WeakMap<Element, string>();
    const h = harness({ dom: { getDisplay: (el) => display.get(el) ?? 'block', frameCount: () => 0, frameName: () => undefined } });
    const host = document.createElement('div');
    host.attachShadow({ mode: 'closed' });
    display.set(host, 'contents');
    document.body.appendChild(host);
    await tick(20);
    const sig = h.byId('extension.active-agent-indicator');
    expect(sig).toBeDefined();
    expect(sig?.layer).toBe('extension');
    expect(sig?.strength).toBe('deterministic');
    expect(sig?.provider).toEqual({ id: 'anthropic', product: 'Claude in Chrome', confidence: 0.9 });
    expect(sig?.details?.['rule']).toBe('claude-indicator-host');
    // Re-append does not spam a second signal.
    document.body.appendChild(document.createElement('footer'));
    document.body.appendChild(host);
    await tick(20);
    expect(h.signals.filter((s) => s.id === 'extension.active-agent-indicator')).toHaveLength(1);
    h.stop();
  });

  it('emits the Codex host indicator when a bare div lands on <html> and a frame appears', async () => {
    const display = new WeakMap<Element, string>();
    let frames = 0;
    const h = harness({ dom: { getDisplay: (el) => display.get(el) ?? 'block', frameCount: () => frames, frameName: () => undefined } });
    const host = document.createElement('div');
    display.set(host, 'none');
    frames = 1;
    document.documentElement.appendChild(host);
    await tick(20);
    const sig = h.byId('extension.active-agent-indicator');
    expect(sig?.provider?.id).toBe('openai');
    expect(sig?.details?.['rule']).toBe('codex-webmcp-host');
    host.remove();
    h.stop();
  });

  it('emits agent-dom-artifact plus assistant-present for Claude picker overlays and messages', async () => {
    const h = harness();
    const overlay = document.createElement('div');
    overlay.id = 'claude-element-overlay';
    document.body.appendChild(overlay);
    await tick(20);
    const art = h.byId('extension.agent-dom-artifact');
    expect(art?.provider?.id).toBe('anthropic');
    expect(art?.details?.['rule']).toBe('claude-picker-overlay');
    expect(h.byId('extension.assistant-present')).toBeDefined();
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'CLAUDE_ELEMENT_SELECTION', selector: 'button' } }));
    await tick(5);
    const msg = h.signals.find((s) => s.id === 'extension.agent-dom-artifact' && s.details?.['rule'] === 'claude-picker-message');
    expect(msg?.summary).toContain('CLAUDE_ELEMENT_SELECTION');
    h.stop();
  });

  it('emits extension.hidden-tab-input after two trusted events while hidden and not before', async () => {
    let vis = 'hidden';
    const h = harness({ visibilityState: () => vis, isTrusted: trusted, perfNow: () => 10_000 });
    // Events inside the 100 ms grace window after start-hidden are ignored; use later timestamps.
    const fire = (type: string) => document.body.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    await tick(120);
    fire('pointerdown');
    expect(h.byId('extension.hidden-tab-input')).toBeUndefined();
    fire('pointerup');
    const sig = h.byId('extension.hidden-tab-input');
    expect(sig).toBeDefined();
    expect(sig?.strength).toBe('strong');
    expect(sig?.details?.['count']).toBe(2);
    fire('click');
    expect(h.signals.filter((s) => s.id === 'extension.hidden-tab-input')).toHaveLength(1); // next re-emit at 4
    fire('keydown');
    expect(h.signals.filter((s) => s.id === 'extension.hidden-tab-input')).toHaveLength(2);
    vis = 'visible';
    fire('pointerdown');
    expect(h.byId('extension.hidden-tab-input')?.details?.['count']).toBe(4);
    h.stop();
  });

  it('ignores untrusted input while hidden', async () => {
    const h = harness({ visibilityState: () => 'hidden', isTrusted: () => false });
    await tick(120);
    for (let i = 0; i < 5; i++) document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(h.byId('extension.hidden-tab-input')).toBeUndefined();
    h.stop();
  });

  it('emits extension.focus-emulation when hasFocus() is true while hidden', async () => {
    const h = harness({ visibilityState: () => 'hidden', hasFocus: () => true });
    await tick(1100);
    const sig = h.byId('extension.focus-emulation');
    expect(sig).toBeDefined();
    expect(sig?.details?.['rule']).toBe('hidden-but-focused');
    expect(sig?.reliability).toBe(1);
    h.stop();
  });

  it('stays quiet on focus when the page is visible and a pageshow was seen', async () => {
    const h = harness({ visibilityState: () => 'visible', hasFocus: () => true });
    window.dispatchEvent(new Event('pageshow'));
    await tick(1100);
    expect(h.byId('extension.focus-emulation')).toBeUndefined();
    h.stop();
  });

  it('emits extension.agent-extension-resource from the WAR probe with provider and table details', async () => {
    const fetchMock = vi.fn(async (url: string) => (CLAUDE_URLS.includes(url) ? ({ ok: true, status: 200, type: 'basic' } as unknown as Response) : Promise.reject(new TypeError('Failed to fetch'))));
    const h = harness({ war: { fetch: fetchMock, watchViolations: () => () => {}, cspBlocksExtensionConnect: () => false, wait: async () => {} } });
    await tick(120);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const sig = h.byId('extension.agent-extension-resource');
    expect(sig?.strength).toBe('deterministic');
    expect(sig?.provider).toEqual({ id: 'anthropic', product: 'Claude in Chrome', confidence: 0.9 });
    expect(sig?.summary).toBe('chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/assets/accessibility-tree.js-B-oUarrX.js fetched with status 200 (Claude in Chrome 1.0.102 web_accessible_resource).');
    expect(sig?.reliability).toBe(1);
    expect((sig?.details?.['hits'] as unknown[]).length).toBe(1);
    h.stop();
  });

  it('can be disabled per option and never emits the resource signal without a hit', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, type: 'basic' } as unknown as Response));
    const h = harness({ war: { fetch: fetchMock, watchViolations: () => () => {}, cspBlocksExtensionConnect: () => false, wait: async () => {} } }, { warProbe: false, cometProbe: false });
    await tick(120);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.byId('extension.agent-extension-resource')).toBeUndefined();
    h.stop();
  });

  it('emits probe.main-world-agent-global for Codex/Cursor residue found at start', async () => {
    (window as unknown as Record<string, unknown>)['__cursorBrowserAutomationInjected'] = true;
    const h = harness();
    const sig = h.byId('probe.main-world-agent-global');
    expect(sig?.strength).toBe('deterministic');
    expect(sig?.provider).toMatchObject({ id: 'cursor', confidence: 0.9 });
    expect(sig?.summary).toContain('__cursorBrowserAutomationInjected');
    delete (window as unknown as Record<string, unknown>)['__cursorBrowserAutomationInjected'];
    h.stop();
  });

  it('finds a late-injected global on a later scan tick', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      expect(h.byId('probe.main-world-agent-global')).toBeUndefined();
      (window as unknown as Record<string, unknown>)['__browserUseClipboardBridge'] = { bindingName: 'x' };
      await vi.advanceTimersByTimeAsync(1100);
      const sig = h.byId('probe.main-world-agent-global');
      expect(sig?.provider?.id).toBe('openai');
      expect(sig?.details?.['tickMs']).toBe(1000);
      delete (window as unknown as Record<string, unknown>)['__browserUseClipboardBridge'];
      h.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits beh.human-input-evidence at reliability 0.6 for assistant markers and the brand hook for agentic brands', async () => {
    document.body.innerHTML = '<grammarly-desktop-integration></grammarly-desktop-integration>';
    document.documentElement.classList.add('translated-ltr');
    const h = harness({ brands: () => [{ brand: 'Comet', version: '1' }, { brand: 'Chromium', version: '142' }] });
    await tick(120);
    const human = h.byId('beh.human-input-evidence');
    expect(human?.reliability).toBe(0.6);
    expect(human?.summary).toContain('Grammarly');
    expect(human?.summary).toContain('Google Translate');
    const brand = h.byId('extension.agentic-browser-brand');
    expect(brand?.provider).toMatchObject({ id: 'perplexity', product: 'Comet' });
    h.stop();
  });

  it('stop() disconnects the observer and listeners', async () => {
    const display = new WeakMap<Element, string>();
    const h = harness({ dom: { getDisplay: (el) => display.get(el) ?? 'block', frameCount: () => 0, frameName: () => undefined } });
    h.stop();
    const host = document.createElement('div');
    display.set(host, 'contents');
    document.body.appendChild(host);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'CLAUDE_ELEMENT_SELECTION' } }));
    await tick(30);
    expect(h.signals).toEqual([]);
  });
});
