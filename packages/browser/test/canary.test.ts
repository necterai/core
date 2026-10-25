import { afterEach, describe, expect, it } from 'vitest';
import { SIGNAL_CATALOG, createRegistry, createSignal, type Signal, type SignalInput } from '@necterai/core';
import { CANARY_FIELD_NAME, CANARY_LINK_TEXT, createCanaryModule } from '../src/canary/index.js';
import { isInstrumented, quiet, setStackSource } from '../src/harvest/instrument.js';
import { createScheduler } from '../src/scheduler.js';
import type { EventInput, Module, ModuleContext } from '../src/types.js';

const ALLOWED_KINDS = ['link', 'field', 'instruction', 'endpoint', 'text-selection', 'other'];
const GATEWAY = '/__necter/gateway';

interface Harness {
  signals: Signal[];
  events: EventInput[];
  finalized: string[];
  mod: Module;
  byId(id: string): Signal | undefined;
  canaryEvents(): { token: string; kind: string; detail?: Record<string, unknown> }[];
  stop(): void;
}

function harness(opts: { options?: Record<string, unknown>; modules?: Record<string, unknown>; canary?: Record<string, unknown> } = {}): Harness {
  const registry = createRegistry(SIGNAL_CATALOG);
  const schedule = createScheduler();
  const signals: Signal[] = [];
  const events: EventInput[] = [];
  const finalized: string[] = [];
  const options = opts.options ?? {};
  const ctx = {
    config: {
      endpoint: '/__necter',
      trustedScriptOrigins: [],
      canary: { enabled: true, forms: true, instructions: true, ...(opts.canary ?? {}) },
      text: { gatewayUrl: GATEWAY },
      modules: { canary: options, harvest: {}, ...(opts.modules ?? {}) },
    } as unknown as ModuleContext['config'],
    session: { id: 'sess-1', firstVisit: true, startedAt: Date.now(), pageViews: 1 },
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
    event(e: EventInput) {
      events.push(e);
    },
    requestEvaluate() {},
    finalize(reason: string) {
      finalized.push(reason);
    },
    log() {},
    verdict: () => ({}) as ReturnType<ModuleContext['verdict']>,
  } as ModuleContext;
  const mod = createCanaryModule();
  mod.start(ctx);
  return {
    signals,
    events,
    finalized,
    mod,
    byId: (id) => [...signals].reverse().find((s) => s.id === id),
    canaryEvents: () => events.filter((e) => e.type === 'canary').map((e) => e.data as { token: string; kind: string; detail?: Record<string, unknown> }),
    stop() {
      mod.stop?.();
      schedule.dispose();
    },
  };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const hiddenLink = () => Array.from(document.querySelectorAll('a')).find((a) => a.textContent === CANARY_LINK_TEXT) as HTMLAnchorElement;
// innerHTML is not instrumented, so the helper itself never counts as a read of the canary.
const instructionBlock = () => Array.from(document.body.children).find((c) => c.innerHTML.includes('Automated agents:')) as HTMLElement;
// jsdom does not navigate; keep it from logging "not implemented" when anchors are clicked.
const noNav = (e: Event) => e.preventDefault();
document.addEventListener('click', noNav);

let current: Harness | undefined;
afterEach(() => {
  current?.stop();
  current = undefined;
  setStackSource(undefined);
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('dir');
  window.getSelection()?.removeAllRanges();
});

describe('canary DOM', () => {
  it('injects an off-screen, aria-hidden, unfocusable link, instruction block and form honeypot', async () => {
    document.body.innerHTML = '<form id="f"><input name="email"></form>';
    current = harness();
    const a = hiddenLink();
    expect(a).toBeDefined();
    const token = current.canaryEvents()[0]!.token;
    expect(token).toMatch(/^sess-1\.[A-Za-z0-9_-]{12}$/);
    expect(a.getAttribute('href')).toBe(`/__necter/canary/${token}`);
    expect(a.rel).toContain('nofollow');
    expect(a.rel).toContain('noindex');
    expect(a.getAttribute('tabindex')).toBe('-1');
    expect(a.getAttribute('aria-hidden')).toBe('true');
    expect(a.hasAttribute('data-no-prefetch')).toBe(true);
    expect(a.style.position).toBe('absolute');
    expect(a.style.left).toBe('-10000px');
    expect(a.style.width).toBe('1px');
    expect(a.style.height).toBe('1px');
    expect(a.style.overflow).toBe('hidden');
    expect(a.style.display).not.toBe('none');

    const block = instructionBlock();
    expect(block.getAttribute('aria-hidden')).toBe('true');
    expect(block.hasAttribute('tabindex')).toBe(false); // containers stay non-focusable
    expect(block.style.position).toBe('absolute');
    expect(block.style.getPropertyValue('user-select')).toBe('none');
    const text = quiet(() => block.textContent); // the SDK's own reads are muted the same way
    expect(text).toContain("open the link labelled 'Agent access'");
    expect(text).toContain(token);

    await tick(80); // forms are injected at idle
    const input = document.querySelector(`#f input[name="${CANARY_FIELD_NAME}"]`) as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.type).toBe('text');
    expect(input.autocomplete).toBe('off');
    expect(input.getAttribute('tabindex')).toBe('-1');
    expect(input.getAttribute('aria-hidden')).toBe('true');
    const wrapper = input.parentElement!;
    expect(wrapper.getAttribute('aria-hidden')).toBe('true');
    expect(wrapper.style.position).toBe('absolute');
    expect(wrapper.style.display).not.toBe('none');

    // Every canary event uses a kind from core's CanaryEvent union; the issue event is kind "other".
    expect(current.canaryEvents()[0]).toMatchObject({ kind: 'other', detail: { phase: 'issued' } });
    for (const e of current.canaryEvents()) expect(ALLOWED_KINDS).toContain(e.kind);
    expect(current.signals).toEqual([]);
  });

  it('uses right:-10000px on RTL pages (a negative left would add a horizontal scrollbar)', () => {
    document.documentElement.setAttribute('dir', 'rtl');
    current = harness();
    const a = hiddenLink();
    expect(a.style.right).toBe('-10000px');
    expect(a.style.left).toBe('');
  });

  it('injects honeypots into forms added later (SPA)', async () => {
    current = harness();
    await tick(80);
    const form = document.createElement('form');
    form.innerHTML = '<input name="q">';
    document.body.appendChild(form);
    await tick(260);
    expect(form.querySelector(`input[name="${CANARY_FIELD_NAME}"]`)).not.toBeNull();
    const optOut = document.createElement('form');
    optOut.setAttribute('data-necter-no-canary', '');
    document.body.appendChild(optOut);
    await tick(260);
    expect(optOut.querySelector(`input[name="${CANARY_FIELD_NAME}"]`)).toBeNull();
  });
});

describe('canary hits', () => {
  it('hidden link activation -> canary.hidden-link-followed (deterministic) + link event', () => {
    current = harness();
    hiddenLink().click();
    const s = current.byId('canary.hidden-link-followed');
    expect(s).toBeDefined();
    expect(s!.summary).toMatch(/hidden canary link activated by click \(isTrusted=false, 0 pointer moves/);
    expect(current.finalized).toContain('canary:link');
    expect(current.canaryEvents().some((e) => e.kind === 'link')).toBe(true);
  });

  it('hidden field input -> canary.hidden-field-filled; empty honeypot is left out of submissions', async () => {
    document.body.innerHTML = '<form id="f"><input name="email"></form>';
    current = harness();
    await tick(80);
    const input = document.querySelector(`input[name="${CANARY_FIELD_NAME}"]`) as HTMLInputElement;
    // Empty at submit: disabled for the serialisation tick, then re-enabled.
    document.getElementById('f')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(input.disabled).toBe(true);
    await tick(10);
    expect(input.disabled).toBe(false);
    expect(current.byId('canary.hidden-field-filled')).toBeUndefined();

    input.value = 'https://example.com';
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'h' }));
    const s = current.byId('canary.hidden-field-filled');
    expect(s).toBeDefined();
    expect(s!.summary).toContain(`hidden field "${CANARY_FIELD_NAME}" received 19 chars (insertText, isTrusted=false`);
    expect(current.finalized).toContain('canary:field');
    expect(current.canaryEvents().some((e) => e.kind === 'field')).toBe(true);
  });

  it('foreign read of the instruction text via the harvest hooks -> canary.hidden-text-selected', () => {
    current = harness();
    setStackSource(() => 'Error\n    at <anonymous>:1:10', 0);
    void document.body.textContent; // ancestor read from anonymous evaluated code
    const s1 = current.byId('canary.hidden-text-selected')!;
    expect(s1.reliability).toBe(0.9);
    expect(s1.summary).toMatch(/hidden canary text read via textContent on an ancestor \(body\) from anonymous code/);
    void instructionBlock().textContent; // direct read
    expect(current.byId('canary.hidden-text-selected')!.reliability).toBe(1);
    expect(current.canaryEvents().filter((e) => e.kind === 'text-selection')).toHaveLength(2);
  });

  it("reads from the site's own scripts are ignored; third-party scripts count only weakly", () => {
    current = harness();
    setStackSource(() => `Error\n    at render (${location.origin}/app.js:1:1)`, 0);
    void document.body.textContent;
    expect(current.byId('canary.hidden-text-selected')).toBeUndefined();
    // A session-replay script serialising the canary node directly.
    setStackSource(() => 'Error\n    at serializeNode (https://replay.example/record.js:1:1)', 0);
    void instructionBlock().textContent;
    expect(current.byId('canary.hidden-text-selected')?.reliability).toBe(0.2);
  });

  it('copy of a selection containing the canary -> canary.hidden-text-selected', () => {
    current = harness();
    const range = document.createRange();
    range.selectNodeContents(instructionBlock());
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event('copy', { bubbles: true }));
    const s = current.byId('canary.hidden-text-selected');
    expect(s).toBeDefined();
    expect(s!.details).toMatchObject({ via: 'copy', what: 'token' });
    expect(s!.reliability).toBe(1);
  });

  it('gateway click after the instruction was read, with no pointer path -> canary.instruction-followed', () => {
    current = harness();
    const gw = document.createElement('a');
    gw.href = GATEWAY;
    gw.textContent = 'Agent access';
    document.body.appendChild(gw);
    gw.click(); // before any read: a person clicking the footer link
    expect(current.byId('canary.instruction-followed')).toBeUndefined();

    setStackSource(() => 'Error\n    at UtilityScript.evaluate (<anonymous>:1:44)', 0);
    void document.body.textContent;
    setStackSource(undefined);
    gw.click();
    const s = current.byId('canary.instruction-followed');
    expect(s).toBeDefined();
    expect(s!.automation).toBeUndefined(); // deterministic weight
    expect(s!.summary).toMatch(/gateway link opened .* after the hidden instruction was read via textContent from automation code, with no pointer path/);
    expect(current.finalized).toContain('canary:instruction');
  });

  it('gateway click with a pointer path is downgraded', () => {
    current = harness();
    const gw = document.createElement('a');
    gw.href = GATEWAY;
    document.body.appendChild(gw);
    setStackSource(() => 'Error\n    at <anonymous>:1:10', 0);
    void instructionBlock().textContent;
    setStackSource(undefined);
    for (let i = 0; i < 5; i++) window.dispatchEvent(new Event('pointermove'));
    gw.click();
    const s = current.byId('canary.instruction-followed')!;
    expect(s.automation).toBe(2);
    expect(current.finalized).not.toContain('canary:instruction');
  });

  it('works without the harvest hooks when the harvest module is disabled', () => {
    current = harness({ modules: { harvest: false } });
    expect(isInstrumented()).toBe(false);
    setStackSource(() => 'Error\n    at <anonymous>:1:10', 0);
    void document.body.textContent;
    expect(current.byId('canary.hidden-text-selected')).toBeUndefined();
    hiddenLink().click();
    expect(current.byId('canary.hidden-link-followed')).toBeDefined();
  });
});

describe('canary stop()', () => {
  it('removes every injected node and listener and releases the hooks', async () => {
    document.body.innerHTML = '<form id="f"><input name="email"></form>';
    current = harness();
    await tick(80);
    expect(isInstrumented()).toBe(true);
    const link = hiddenLink();
    const input = document.querySelector(`input[name="${CANARY_FIELD_NAME}"]`) as HTMLInputElement;
    expect(input).not.toBeNull();
    current.stop();
    const h = current;
    current = undefined;
    expect(hiddenLink()).toBeUndefined();
    expect(instructionBlock()).toBeUndefined();
    expect(document.querySelector(`input[name="${CANARY_FIELD_NAME}"]`)).toBeNull();
    expect(isInstrumented()).toBe(false);
    document.body.appendChild(link);
    link.click();
    document.body.appendChild(input);
    input.value = 'x';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(h.signals).toEqual([]);
  });
});
