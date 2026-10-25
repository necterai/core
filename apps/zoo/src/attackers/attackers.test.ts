import { describe, expect, it } from 'vitest';
import { ACTOR_CLASSES } from '@necterai/core';
import { ALL_ATTACKERS } from './index.js';
import { refFor, PLAYWRIGHT_MCP_SKIP, playwrightMcp } from './playwright-mcp.js';
import { bitwardenFillScript, BITWARDEN_ACTION_DELAY_MS, BITWARDEN_EVENT_SEQUENCE } from './password-manager-sim.js';
import { XDOTOOL_CLICK_HOLD_MS, XDOTOOL_TYPE_DELAY_MS, XDOTOOL_WHEEL_NOTCH_PX } from './xdotool-sim.js';
import { MCP_FETCH_UA } from './fetchers.js';

describe('attacker registry', () => {
  it('has unique names and valid expected classes', () => {
    const names = ALL_ATTACKERS.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
    for (const a of ALL_ATTACKERS) {
      const classes = Array.isArray(a.expected.actorClass) ? a.expected.actorClass : [a.expected.actorClass];
      for (const c of classes) expect(ACTOR_CLASSES).toContain(c);
      expect(a.description.length).toBeGreaterThan(20);
    }
  });
  it('registers the new attackers with the classes the brief expects', () => {
    const by = new Map(ALL_ATTACKERS.map((a) => [a.name, a]));
    expect(by.get('playwright-python')?.expected).toEqual({ actorClass: 'browser-agent', automated: true });
    expect(by.get('playwright-mcp')?.expected).toEqual({ actorClass: 'browser-agent', automated: true });
    expect(by.get('extension-agent-sim')?.expected).toEqual({ actorClass: 'extension-agent', automated: true });
    expect(by.get('xdotool-sim')?.expected).toEqual({ actorClass: 'computer-use-agent', automated: true });
    expect(by.get('at-nvda-sim')?.expected).toEqual({ actorClass: 'human', automated: false });
    expect(by.get('password-manager-sim')?.expected).toEqual({ actorClass: 'human', automated: false });
    expect(by.get('fetch-curl-cffi')?.expected.automated).toBe(true);
    expect(by.get('fetch-mcp-reference')?.expected).toEqual({ actorClass: 'fetch-agent', automated: true });
  });
  it('declares the human false-positive probes as not automated and everything else as automated', () => {
    for (const a of ALL_ATTACKERS) {
      const classes = Array.isArray(a.expected.actorClass) ? a.expected.actorClass : [a.expected.actorClass];
      expect(a.expected.automated).toBe(!classes.includes('human'));
    }
  });
});

describe('playwright-mcp', () => {
  it('extracts refs from a browser_snapshot the way the LLM would pick a target', () => {
    const snap = ['- navigation [ref=e2]:', '  - link "Products" [ref=e3]', '- link "Oak Shelf $120" [ref=e7]', '- button "Add to cart" [ref=e9]', '- textbox "Name" [ref=e12]'].join('\n');
    expect(refFor(snap, /link .*\$/)).toBe('e7');
    expect(refFor(snap, /button "Add to cart"/i)).toBe('e9');
    expect(refFor(snap, /textbox "Name"/i)).toBe('e12');
    expect(refFor(snap, /textbox "Email"/i)).toBeUndefined();
  });
  it('skips with the documented reason when the package is not installed in the workspace', async () => {
    const reason = await playwrightMcp.check!();
    // Either the package is present (then no reason) or the reason is exactly the brief's string.
    if (reason !== undefined) expect(reason).toBe(PLAYWRIGHT_MCP_SKIP);
  });
});

describe('measured constants from the research', () => {
  it('xdotool: 12 ms click hold, 12 ms typing delay, 120 px wheel notches', () => {
    expect(XDOTOOL_CLICK_HOLD_MS).toBe(12);
    expect(XDOTOOL_TYPE_DELAY_MS).toBe(12);
    expect(XDOTOOL_WHEEL_NOTCH_PX).toBe(120);
  });
  it('Bitwarden: 20 ms action delay and the exact per-field event train', () => {
    expect(BITWARDEN_ACTION_DELAY_MS).toBe(20);
    expect(BITWARDEN_EVENT_SEQUENCE).toEqual(['click', 'focus', 'keydown', 'keyup', 'value', 'keydown', 'keyup', 'input', 'change']);
    const src = bitwardenFillScript();
    const order = ['el.click()', 'el.focus()', "dispatchKey(el, 'keydown'); dispatchKey(el, 'keyup')", 'el.value = value', "dispatchKey(el, 'keydown'); dispatchKey(el, 'keyup')", "new Event('input', { bubbles: true })", "new Event('change', { bubbles: true })"];
    let pos = -1;
    for (const needle of order) {
      const next = src.indexOf(needle, pos + 1);
      expect(next, `expected ${needle} after position ${pos}`).toBeGreaterThan(pos);
      pos = next;
    }
    expect(src).toContain('new KeyboardEvent(type, { bubbles: true })');
    expect(src).toContain('setTimeout(() => el.classList.remove(cls), 200)');
    // The script must be a valid function expression.
    expect(typeof new Function('return ' + src)()).toBe('function');
  });
  it('MCP reference fetch UA is verbatim', () => {
    expect(MCP_FETCH_UA).toBe('ModelContextProtocol/1.0 (Autonomous; +https://github.com/modelcontextprotocol/servers)');
  });
});
