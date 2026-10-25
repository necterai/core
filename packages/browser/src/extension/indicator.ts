import {
  AGENT_EXTENSION_IDS,
  CLAUDE_PICKER_OVERLAY_IDS,
  CODEX_AGENT_OVERLAY_ROOT,
  CODEX_WEBMCP_PROBE_FRAME_NAME,
  COMET_OVERLAY_ID,
  COMET_STOP_BUTTON_BACKGROUND,
  COMET_STOP_BUTTON_ID,
  extensionIdFromUrl,
  findAgentExtension,
  type AgentExtensionEntry,
} from './known-extensions.js';

/**
 * DOM rules for agent "acting" indicators and agent DOM artifacts
 * (extension-agents.md 2.4, 2.5, 4.2, 9.6, 9.7, 11; computer-use-agents.md 5).
 *
 * Shapes are matched exactly as measured:
 * - Claude in Chrome indicator host: `<div>` with zero attributes, zero light
 *   children, a *closed* shadow root (so `shadowRoot === null`), computed
 *   `display: contents` (from `:host { all: initial !important; display: contents !important; }`
 *   inside the closed root), appended to `<body>` (or `<html>` when body is
 *   missing) and kept `lastElementChild` by re-appending itself. Measured live:
 *   `DOM_ADDED {tag:"DIV", attrs:[], parent:"BODY", display:"contents", childCount:0, isLastOfBody:true}`
 *   47 ms after tab activation; never removed afterwards.
 * - Codex WebMCP probe host: attribute-less `<div>` appended to
 *   `document.documentElement` whose closed shadow root holds
 *   `<iframe name="codex-webmcp-probe-97adecab-75be-4770-bbe4-654cac643843">`;
 *   page-visible as `window.frames.length` growing by one.
 * - Comet Assistant: `#pplx-agent-overlay-stop-button` ("Stop Comet Assistant")
 *   appended to body via `document.body.appendChild`.
 * - Cursor: `data-cursor-overlay` element and `data-cursor-ref="e<N>"` attributes.
 */

export type IndicatorDriver = 'claude' | 'codex' | 'comet' | 'cursor';

export interface IndicatorMatch {
  kind: 'indicator';
  rule: 'claude-indicator-host' | 'codex-webmcp-host' | 'codex-overlay-root' | 'comet-stop-button' | 'cursor-overlay';
  driver: IndicatorDriver;
  reliability: number;
  summary: string;
  details: Record<string, unknown>;
}

export interface ArtifactMatch {
  kind: 'artifact';
  rule: 'claude-picker-overlay' | 'agent-stylesheet' | 'claude-picker-message';
  driver: IndicatorDriver | 'extension';
  entry?: AgentExtensionEntry;
  reliability: number;
  summary: string;
  details: Record<string, unknown>;
}

export type DomMatch = IndicatorMatch | ArtifactMatch;

export interface DomDeps {
  /** Computed `display` of an element; stubbed in tests (jsdom has no layout). */
  getDisplay(el: Element): string;
  /** `window.frames.length`. */
  frameCount(): number;
  /** Name of frame i, or undefined when it cannot be read. */
  frameName(i: number): string | undefined;
}

export const PROBE_ATTR = 'data-necter-probe';

export function defaultDomDeps(win: Window = window): DomDeps {
  return {
    getDisplay(el) {
      try {
        return win.getComputedStyle(el).display;
      } catch {
        return '';
      }
    },
    frameCount() {
      try {
        return win.frames.length;
      } catch {
        return 0;
      }
    },
    frameName(i) {
      try {
        return win.frames[i]?.name;
      } catch {
        return undefined;
      }
    },
  };
}

/** `<div>` with no attributes, no light-DOM children and no open shadow root. */
export function isBareHostDiv(node: Node): node is HTMLElement {
  if (node.nodeType !== 1) return false;
  const el = node as Element;
  if (el.tagName !== 'DIV') return false;
  if (el.attributes.length !== 0) return false;
  if (el.childNodes.length !== 0) return false;
  if (el.shadowRoot !== null) return false;
  return true;
}

export interface FrameState {
  lastCount: number;
}

export function readFrameNames(deps: DomDeps): { readable: string[]; unreadable: number } {
  const readable: string[] = [];
  let unreadable = 0;
  const n = deps.frameCount();
  for (let i = 0; i < n; i++) {
    const name = deps.frameName(i);
    if (typeof name === 'string') readable.push(name);
    else unreadable += 1;
  }
  return { readable, unreadable };
}

/**
 * Classify one added node against the indicator rules. `parent` is the
 * mutation target (the node may already have been moved again by the time the
 * observer runs, so the caller passes the record's target).
 */
export function classifyAddedNode(node: Node, parent: Node | null, doc: Document, deps: DomDeps, frames: FrameState, nowMsSinceVisible?: number): IndicatorMatch | undefined {
  if (node.nodeType !== 1) return undefined;
  const el = node as Element;
  if (el.hasAttribute(PROBE_ATTR)) return undefined;
  const body = doc.body;
  const html = doc.documentElement;

  if (isBareHostDiv(el)) {
    const parentIsBody = parent === body && body !== null;
    const parentIsHtml = parent === html;
    if (parentIsBody || parentIsHtml) {
      const display = deps.getDisplay(el);
      const parentEl = parent as Element;
      const isLast = parentEl.lastElementChild === el;
      if (display === 'contents' && isLast) {
        return {
          kind: 'indicator',
          rule: 'claude-indicator-host',
          driver: 'claude',
          reliability: 1,
          summary: `Attribute-less <div> with closed shadow root and computed display:contents appended as last child of <${parentIsBody ? 'body' : 'html'}>${nowMsSinceVisible !== undefined ? ` ${Math.round(nowMsSinceVisible)} ms after the tab became visible` : ''} (Claude in Chrome agent indicator host).`,
          details: { parent: parentIsBody ? 'BODY' : 'HTML', display, isLastElementChild: true, ...(nowMsSinceVisible !== undefined ? { msSinceVisible: Math.round(nowMsSinceVisible) } : {}) },
        };
      }
      if (parentIsHtml) {
        const count = deps.frameCount();
        const increased = count > frames.lastCount;
        const names = increased ? readFrameNames(deps) : { readable: [], unreadable: 0 };
        const codexName = names.readable.includes(CODEX_WEBMCP_PROBE_FRAME_NAME);
        if (increased) frames.lastCount = count;
        if (display === 'none' || increased) {
          const reliability = codexName ? 1 : increased && display === 'none' ? 1 : increased ? 0.85 : 0.6;
          return {
            kind: 'indicator',
            rule: 'codex-webmcp-host',
            driver: 'codex',
            reliability,
            summary: `Attribute-less <div> (display:${display || 'unknown'}) appended to <html>${increased ? ` and window.frames.length grew to ${count}${codexName ? ` with frame name ${CODEX_WEBMCP_PROBE_FRAME_NAME}` : names.unreadable ? ` with ${names.unreadable} unreadable frame name(s)` : ''}` : ''} (Codex WebMCP probe host).`,
            details: { parent: 'HTML', display, frameCount: count, frameIncreased: increased, unreadableFrames: names.unreadable, codexFrameName: codexName },
          };
        }
      }
    }
    return undefined;
  }

  // Comet Assistant overlay / stop button.
  const id = el.id;
  if (id === COMET_STOP_BUTTON_ID || id === COMET_OVERLAY_ID || (el.childElementCount > 0 && safeQuery(el, `#${COMET_STOP_BUTTON_ID}`))) {
    return {
      kind: 'indicator',
      rule: 'comet-stop-button',
      driver: 'comet',
      reliability: 1,
      summary: `#${id === COMET_OVERLAY_ID ? COMET_OVERLAY_ID : COMET_STOP_BUTTON_ID} appended to the document (Comet Assistant agent overlay).`,
      details: { id: id || COMET_STOP_BUTTON_ID, parent: parent && parent.nodeType === 1 ? (parent as Element).tagName : null },
    };
  }

  // Cursor Browser Automation overlay / refs (main-world injection through Runtime.evaluate).
  if (el.hasAttribute('data-cursor-overlay') || el.hasAttribute('data-cursor-ref') || (el.childElementCount > 0 && safeQuery(el, '[data-cursor-overlay],[data-cursor-ref]'))) {
    const refEl = el.hasAttribute('data-cursor-ref') ? el : safeQuery(el, '[data-cursor-ref]');
    const ref = refEl?.getAttribute('data-cursor-ref') ?? undefined;
    return {
      kind: 'indicator',
      rule: 'cursor-overlay',
      driver: 'cursor',
      reliability: 1,
      summary: `${el.hasAttribute('data-cursor-overlay') || safeQuery(el, '[data-cursor-overlay]') ? 'data-cursor-overlay element' : `data-cursor-ref="${ref ?? ''}" attribute`} inserted (Cursor Browser Automation).`,
      details: { overlay: el.hasAttribute('data-cursor-overlay') || !!safeQuery(el, '[data-cursor-overlay]'), ...(ref ? { ref } : {}) },
    };
  }

  // Codex agent overlay root (constant from browser-service.mjs; exact tag uncertain).
  if (id === CODEX_AGENT_OVERLAY_ROOT || el.classList.contains(CODEX_AGENT_OVERLAY_ROOT)) {
    return {
      kind: 'indicator',
      rule: 'codex-overlay-root',
      driver: 'codex',
      reliability: 0.8,
      summary: `Element with id/class "${CODEX_AGENT_OVERLAY_ROOT}" inserted (Codex agent overlay).`,
      details: { id, tag: el.tagName },
    };
  }
  return undefined;
}

/** Claude picker overlays and agent stylesheets (agent-dom-artifact). */
export function classifyArtifactNode(node: Node): ArtifactMatch | undefined {
  if (node.nodeType !== 1) return undefined;
  const el = node as Element;
  if (el.hasAttribute(PROBE_ATTR)) return undefined;
  const pickerSelector = CLAUDE_PICKER_OVERLAY_IDS.map((i) => `#${i}`).join(',');
  const picker = CLAUDE_PICKER_OVERLAY_IDS.includes(el.id) ? el : el.childElementCount > 0 ? safeQuery(el, pickerSelector) : null;
  if (picker) {
    return {
      kind: 'artifact',
      rule: 'claude-picker-overlay',
      driver: 'claude',
      reliability: 1,
      summary: `#${picker.id} overlay inserted in the light DOM (Claude in Chrome side-panel picker; user-driven flow).`,
      details: { id: picker.id, userDriven: true },
    };
  }
  const sheet = matchAgentStylesheetElement(el);
  if (sheet) return sheet;
  return undefined;
}

function matchAgentStylesheetElement(el: Element): ArtifactMatch | undefined {
  const tag = el.tagName;
  if (tag !== 'LINK' && tag !== 'STYLE') return undefined;
  const href = tag === 'LINK' ? el.getAttribute('href') : null;
  return matchAgentStylesheetHref(href);
}

export function matchAgentStylesheetHref(href: string | null | undefined): ArtifactMatch | undefined {
  const id = extensionIdFromUrl(href);
  if (!id || !AGENT_EXTENSION_IDS.has(id)) return undefined;
  const entry = findAgentExtension(id);
  const match: ArtifactMatch = {
    kind: 'artifact',
    rule: 'agent-stylesheet',
    driver: 'extension',
    reliability: 1,
    summary: `Stylesheet loaded from ${href} (content stylesheet of ${entry?.product ?? id}).`,
    details: { href, extensionId: id },
  };
  if (entry) match.entry = entry;
  return match;
}

/** Scan `document.styleSheets` for hrefs from known agent extension ids. */
export function scanAgentStylesheets(doc: Document): ArtifactMatch[] {
  const out: ArtifactMatch[] = [];
  try {
    const sheets = doc.styleSheets;
    for (let i = 0; i < sheets.length; i++) {
      let href: string | null = null;
      try {
        href = sheets[i]?.href ?? null;
      } catch {
        href = null;
      }
      const m = matchAgentStylesheetHref(href);
      if (m) out.push(m);
    }
  } catch {
    /* ignore */
  }
  return out;
}

export function classifyMessageEvent(data: unknown, knownTypes: ReadonlySet<string>): ArtifactMatch | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const type = (data as { type?: unknown }).type;
  if (typeof type !== 'string' || !knownTypes.has(type)) return undefined;
  return {
    kind: 'artifact',
    rule: 'claude-picker-message',
    driver: 'claude',
    reliability: 1,
    summary: `window "message" event with data.type "${type}" received (Claude in Chrome element picker postMessage to "*").`,
    details: { type, userDriven: true },
  };
}

/**
 * Passive Comet presence test (Castle): a `#pplx-agent-overlay-stop-button`
 * element inherits Comet's injected stylesheet whether or not the agent is
 * acting; its computed background becomes `rgb(255, 254, 251)`. CSP-safe:
 * styles are set through CSSOM, no inline text.
 */
export function probeCometStylesheet(doc: Document, getBackground: (el: Element) => string): { present: boolean; background: string } {
  let el: HTMLElement | undefined;
  try {
    const parent = doc.body ?? doc.documentElement;
    el = doc.createElement('div');
    el.id = COMET_STOP_BUTTON_ID;
    el.setAttribute(PROBE_ATTR, 'comet');
    el.setAttribute('aria-hidden', 'true');
    el.style.backgroundColor = 'blue';
    el.style.position = 'fixed';
    el.style.left = '-9999px';
    el.style.width = '1px';
    el.style.height = '1px';
    el.style.pointerEvents = 'none';
    parent.appendChild(el);
    const background = getBackground(el);
    return { present: background === COMET_STOP_BUTTON_BACKGROUND, background };
  } catch {
    return { present: false, background: '' };
  } finally {
    try {
      el?.remove();
    } catch {
      /* ignore */
    }
  }
}

/** Initial scan for hosts that were inserted before the observer attached. */
export function scanExistingIndicators(doc: Document, deps: DomDeps, frames: FrameState): IndicatorMatch[] {
  const out: IndicatorMatch[] = [];
  try {
    const candidates: Array<[Element | null, Node | null]> = [
      [doc.body?.lastElementChild ?? null, doc.body],
      [doc.documentElement?.lastElementChild ?? null, doc.documentElement],
    ];
    for (const [el, parent] of candidates) {
      if (!el) continue;
      const m = classifyAddedNode(el, parent, doc, deps, frames);
      if (m) out.push(m);
    }
    const comet = safeQuery(doc, `#${COMET_STOP_BUTTON_ID}:not([${PROBE_ATTR}]),#${COMET_OVERLAY_ID}:not([${PROBE_ATTR}])`);
    if (comet) {
      const m = classifyAddedNode(comet, comet.parentNode, doc, deps, frames);
      if (m) out.push(m);
    }
    const cursor = safeQuery(doc, '[data-cursor-overlay],[data-cursor-ref]');
    if (cursor) {
      const m = classifyAddedNode(cursor, cursor.parentNode, doc, deps, frames);
      if (m) out.push(m);
    }
  } catch {
    /* ignore */
  }
  return out;
}

export function scanExistingArtifacts(doc: Document): ArtifactMatch[] {
  const out: ArtifactMatch[] = [];
  try {
    const picker = safeQuery(doc, CLAUDE_PICKER_OVERLAY_IDS.map((i) => `#${i}`).join(','));
    if (picker) {
      const m = classifyArtifactNode(picker);
      if (m) out.push(m);
    }
    out.push(...scanAgentStylesheets(doc));
  } catch {
    /* ignore */
  }
  return out;
}

function safeQuery(root: ParentNode, selector: string): Element | null {
  try {
    return root.querySelector(selector);
  } catch {
    return null;
  }
}
