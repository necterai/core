import { beforeEach, describe, expect, it } from 'vitest';
import { CLAUDE_MESSAGE_TYPES, CODEX_WEBMCP_PROBE_FRAME_NAME, COMET_STOP_BUTTON_BACKGROUND } from '../src/extension/known-extensions.js';
import {
  PROBE_ATTR,
  classifyAddedNode,
  classifyArtifactNode,
  classifyMessageEvent,
  isBareHostDiv,
  matchAgentStylesheetHref,
  probeCometStylesheet,
  scanExistingArtifacts,
  scanExistingIndicators,
  type DomDeps,
  type FrameState,
} from '../src/extension/indicator.js';

/** jsdom has no layout: stub computed display per element. */
function makeDeps(display: WeakMap<Element, string>, frames: { count: number; names: (string | undefined)[] } = { count: 0, names: [] }): DomDeps {
  return {
    getDisplay: (el) => display.get(el) ?? 'block',
    frameCount: () => frames.count,
    frameName: (i) => frames.names[i],
  };
}

describe('Claude in Chrome indicator host rule', () => {
  beforeEach(() => {
    document.body.innerHTML = '<main id="app"><p>content</p></main>';
  });

  it('matches an attribute-less, child-less, closed-shadow div with display:contents as last child of body', () => {
    const display = new WeakMap<Element, string>();
    const host = document.createElement('div');
    host.attachShadow({ mode: 'closed' }); // closed -> host.shadowRoot === null
    document.body.appendChild(host);
    display.set(host, 'contents');
    const m = classifyAddedNode(host, document.body, document, makeDeps(display), { lastCount: 0 }, 47);
    expect(m?.rule).toBe('claude-indicator-host');
    expect(m?.driver).toBe('claude');
    expect(m?.reliability).toBe(1);
    expect(m?.summary).toContain('display:contents');
    expect(m?.summary).toContain('47 ms');
    expect(m?.details['parent']).toBe('BODY');
  });

  it('also accepts <html> as the parent when body is missing', () => {
    const display = new WeakMap<Element, string>();
    const host = document.createElement('div');
    document.documentElement.appendChild(host);
    display.set(host, 'contents');
    const m = classifyAddedNode(host, document.documentElement, document, makeDeps(display), { lastCount: 0 });
    expect(m?.rule).toBe('claude-indicator-host');
    expect(m?.details['parent']).toBe('HTML');
    host.remove();
  });

  it('rejects hosts with attributes, children, an open shadow root, display:block or a non-last position', () => {
    const display = new WeakMap<Element, string>();
    const deps = makeDeps(display);
    const frames: FrameState = { lastCount: 0 };

    const withAttr = document.createElement('div');
    withAttr.id = 'x';
    document.body.appendChild(withAttr);
    display.set(withAttr, 'contents');
    expect(classifyAddedNode(withAttr, document.body, document, deps, frames)).toBeUndefined();
    withAttr.remove();

    const withChild = document.createElement('div');
    withChild.appendChild(document.createTextNode('hi'));
    document.body.appendChild(withChild);
    display.set(withChild, 'contents');
    expect(classifyAddedNode(withChild, document.body, document, deps, frames)).toBeUndefined();
    withChild.remove();

    const openShadow = document.createElement('div');
    openShadow.attachShadow({ mode: 'open' });
    document.body.appendChild(openShadow);
    display.set(openShadow, 'contents');
    expect(classifyAddedNode(openShadow, document.body, document, deps, frames)).toBeUndefined();
    openShadow.remove();

    const block = document.createElement('div');
    document.body.appendChild(block);
    display.set(block, 'block');
    expect(classifyAddedNode(block, document.body, document, deps, frames)).toBeUndefined();
    block.remove();

    const notLast = document.createElement('div');
    document.body.appendChild(notLast);
    document.body.appendChild(document.createElement('footer'));
    display.set(notLast, 'contents');
    expect(classifyAddedNode(notLast, document.body, document, deps, frames)).toBeUndefined();
  });

  it('matches on a later re-append once the host is last again (the script re-appends itself)', () => {
    const display = new WeakMap<Element, string>();
    const deps = makeDeps(display);
    const host = document.createElement('div');
    document.body.appendChild(host);
    document.body.appendChild(document.createElement('footer'));
    display.set(host, 'contents');
    expect(classifyAddedNode(host, document.body, document, deps, { lastCount: 0 })).toBeUndefined();
    document.body.appendChild(host); // A(): e.nextElementSibling && e.parentNode.appendChild(e)
    expect(classifyAddedNode(host, document.body, document, deps, { lastCount: 0 })?.rule).toBe('claude-indicator-host');
  });

  it('ignores nested divs deep in the page (parent must be body/html)', () => {
    const display = new WeakMap<Element, string>();
    const inner = document.createElement('div');
    document.getElementById('app')!.appendChild(inner);
    display.set(inner, 'contents');
    expect(classifyAddedNode(inner, document.getElementById('app'), document, makeDeps(display), { lastCount: 0 })).toBeUndefined();
  });

  it('isBareHostDiv rejects non-div and text nodes', () => {
    expect(isBareHostDiv(document.createElement('span'))).toBe(false);
    expect(isBareHostDiv(document.createTextNode('x'))).toBe(false);
    expect(isBareHostDiv(document.createElement('div'))).toBe(true);
  });
});

describe('Codex WebMCP probe host rule', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('matches an attribute-less display:none div appended to <html> with a frame increment and an unreadable name', () => {
    const display = new WeakMap<Element, string>();
    const frames = { count: 0, names: [] as (string | undefined)[] };
    const deps = makeDeps(display, frames);
    const state: FrameState = { lastCount: 0 };
    const host = document.createElement('div');
    document.documentElement.appendChild(host);
    display.set(host, 'none');
    frames.count = 1;
    frames.names = [undefined];
    const m = classifyAddedNode(host, document.documentElement, document, deps, state);
    expect(m?.rule).toBe('codex-webmcp-host');
    expect(m?.driver).toBe('codex');
    expect(m?.reliability).toBe(1);
    expect(m?.details['frameIncreased']).toBe(true);
    expect(m?.details['unreadableFrames']).toBe(1);
    expect(state.lastCount).toBe(1);
    host.remove();
  });

  it('reads the fixed Codex frame name when it is readable', () => {
    const display = new WeakMap<Element, string>();
    const frames = { count: 1, names: [CODEX_WEBMCP_PROBE_FRAME_NAME] };
    const host = document.createElement('div');
    document.documentElement.appendChild(host);
    display.set(host, 'block');
    const m = classifyAddedNode(host, document.documentElement, document, makeDeps(display, frames), { lastCount: 0 });
    expect(m?.rule).toBe('codex-webmcp-host');
    expect(m?.details['codexFrameName']).toBe(true);
    expect(m?.summary).toContain(CODEX_WEBMCP_PROBE_FRAME_NAME);
    host.remove();
  });

  it('is weaker (0.6) with display:none but no new frame, and silent with neither', () => {
    const display = new WeakMap<Element, string>();
    const host = document.createElement('div');
    document.documentElement.appendChild(host);
    display.set(host, 'none');
    const m = classifyAddedNode(host, document.documentElement, document, makeDeps(display), { lastCount: 0 });
    expect(m?.rule).toBe('codex-webmcp-host');
    expect(m?.reliability).toBe(0.6);
    display.set(host, 'block');
    expect(classifyAddedNode(host, document.documentElement, document, makeDeps(display), { lastCount: 0 })).toBeUndefined();
    host.remove();
  });

  it('does not fire for a bare div appended to <body> with display:none', () => {
    const display = new WeakMap<Element, string>();
    const host = document.createElement('div');
    document.body.appendChild(host);
    display.set(host, 'none');
    expect(classifyAddedNode(host, document.body, document, makeDeps(display), { lastCount: 0 })).toBeUndefined();
  });
});

describe('Comet, Cursor and Codex overlay rules', () => {
  const deps = makeDeps(new WeakMap());
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('matches #pplx-agent-overlay-stop-button appended to body', () => {
    const btn = document.createElement('button');
    btn.id = 'pplx-agent-overlay-stop-button';
    btn.textContent = 'Stop Comet Assistant';
    document.body.appendChild(btn);
    const m = classifyAddedNode(btn, document.body, document, deps, { lastCount: 0 });
    expect(m?.rule).toBe('comet-stop-button');
    expect(m?.driver).toBe('comet');
  });

  it('matches the stop button nested in an inserted overlay wrapper', () => {
    const wrap = document.createElement('div');
    wrap.innerHTML = '<div id="pplx-agent-overlay"><button id="pplx-agent-overlay-stop-button"></button></div>';
    document.body.appendChild(wrap);
    expect(classifyAddedNode(wrap, document.body, document, deps, { lastCount: 0 })?.rule).toBe('comet-stop-button');
  });

  it('matches Cursor data-cursor-overlay and data-cursor-ref', () => {
    const overlay = document.createElement('div');
    overlay.setAttribute('data-cursor-overlay', '');
    document.body.appendChild(overlay);
    expect(classifyAddedNode(overlay, document.body, document, deps, { lastCount: 0 })?.rule).toBe('cursor-overlay');
    const tagged = document.createElement('section');
    tagged.innerHTML = '<button data-cursor-ref="e12">go</button>';
    document.body.appendChild(tagged);
    const m = classifyAddedNode(tagged, document.body, document, deps, { lastCount: 0 });
    expect(m?.rule).toBe('cursor-overlay');
    expect(m?.details['ref']).toBe('e12');
  });

  it('matches the codex-agent-overlay-root constant with reduced reliability', () => {
    const root = document.createElement('div');
    root.className = 'codex-agent-overlay-root';
    document.body.appendChild(root);
    const m = classifyAddedNode(root, document.body, document, deps, { lastCount: 0 });
    expect(m?.rule).toBe('codex-overlay-root');
    expect(m?.reliability).toBe(0.8);
  });

  it('skips our own probe elements', () => {
    const probe = document.createElement('div');
    probe.id = 'pplx-agent-overlay-stop-button';
    probe.setAttribute(PROBE_ATTR, 'comet');
    document.body.appendChild(probe);
    expect(classifyAddedNode(probe, document.body, document, deps, { lastCount: 0 })).toBeUndefined();
  });

  it('ignores ordinary page content', () => {
    const div = document.createElement('div');
    div.innerHTML = '<p class="price">$9</p><button id="buy">Buy</button>';
    document.body.appendChild(div);
    expect(classifyAddedNode(div, document.body, document, deps, { lastCount: 0 })).toBeUndefined();
    expect(classifyArtifactNode(div)).toBeUndefined();
  });
});

describe('agent DOM artifacts', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
  });

  it('matches each Claude picker overlay id, directly or nested', () => {
    for (const id of ['claude-screenshot-overlay', 'claude-prompt-overlay', 'claude-element-overlay']) {
      const el = document.createElement('div');
      el.id = id;
      const m = classifyArtifactNode(el);
      expect(m?.rule).toBe('claude-picker-overlay');
      expect(m?.details['id']).toBe(id);
      expect(m?.details['userDriven']).toBe(true);
    }
    const wrap = document.createElement('div');
    wrap.innerHTML = '<div id="claude-prompt-container"><div id="claude-prompt-overlay"></div></div>';
    expect(classifyArtifactNode(wrap)?.details['id']).toBe('claude-prompt-overlay');
  });

  it('matches message events with the Claude element-selection types only', () => {
    expect(classifyMessageEvent({ type: 'CLAUDE_ELEMENT_SELECTION', element: {} }, CLAUDE_MESSAGE_TYPES)?.rule).toBe('claude-picker-message');
    expect(classifyMessageEvent({ type: 'CLAUDE_ELEMENT_SELECTION_CLEANUP' }, CLAUDE_MESSAGE_TYPES)?.details['type']).toBe('CLAUDE_ELEMENT_SELECTION_CLEANUP');
    expect(classifyMessageEvent({ type: 'webpackHotUpdate' }, CLAUDE_MESSAGE_TYPES)).toBeUndefined();
    expect(classifyMessageEvent('CLAUDE_ELEMENT_SELECTION', CLAUDE_MESSAGE_TYPES)).toBeUndefined();
    expect(classifyMessageEvent(null, CLAUDE_MESSAGE_TYPES)).toBeUndefined();
  });

  it('matches stylesheets from known agent extension ids and ignores other extensions', () => {
    const harpa = matchAgentStylesheetHref('chrome-extension://eanggfilgoajaocelnaflolkadkeghjp/content.styles.css');
    expect(harpa?.rule).toBe('agent-stylesheet');
    expect(harpa?.entry?.provider).toBe('harpa');
    expect(matchAgentStylesheetHref('chrome-extension://kbfnbcaeplbcioakkpcpgfkobkghlhen/grammarly.css')).toBeUndefined();
    expect(matchAgentStylesheetHref('https://cdn.example.com/app.css')).toBeUndefined();
    expect(matchAgentStylesheetHref(null)).toBeUndefined();

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'chrome-extension://eanggfilgoajaocelnaflolkadkeghjp/content.styles.css';
    expect(classifyArtifactNode(link)?.details['extensionId']).toBe('eanggfilgoajaocelnaflolkadkeghjp');
  });

  it('scanExisting* finds hosts and overlays present before the observer attached', () => {
    const display = new WeakMap<Element, string>();
    const host = document.createElement('div');
    document.body.appendChild(host);
    display.set(host, 'contents');
    const picker = document.createElement('div');
    picker.id = 'claude-element-overlay';
    document.documentElement.insertBefore(picker, document.body);
    const found = scanExistingIndicators(document, makeDeps(display), { lastCount: 0 });
    expect(found.map((f) => f.rule)).toContain('claude-indicator-host');
    expect(scanExistingArtifacts(document).map((a) => a.rule)).toContain('claude-picker-overlay');
    picker.remove();
  });
});

describe('passive Comet stylesheet probe', () => {
  it('reports present only for the measured background and always cleans up', () => {
    const hit = probeCometStylesheet(document, () => COMET_STOP_BUTTON_BACKGROUND);
    expect(hit.present).toBe(true);
    expect(hit.background).toBe('rgb(255, 254, 251)');
    expect(document.getElementById('pplx-agent-overlay-stop-button')).toBeNull();
    const miss = probeCometStylesheet(document, () => 'rgb(0, 0, 255)');
    expect(miss.present).toBe(false);
    expect(document.querySelector(`[${PROBE_ATTR}]`)).toBeNull();
  });
});
