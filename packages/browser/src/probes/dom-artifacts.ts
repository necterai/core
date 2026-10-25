import type { ActorClass, ProviderHint, SignalInput } from '@necterai/core';
import type { ResidueSignalId } from './known-globals.js';
import { attempt, listSummary } from './util.js';

/**
 * DOM artifacts left by agent frameworks (overlays, set-of-marks attributes,
 * highlight containers). Evidence base: docs/research/raw/automation-stacks.md
 * sections 2.4, 12.3, 13, 14, 17, 18 and 28; extension-agents.md sections 4 and 9.7;
 * computer-use-agents.md (Magentic-UI).
 */

export interface DomArtifactMatch {
  signal: ResidueSignalId;
  /** What matched, e.g. `#red-cursor`, `[unique_id]`, `.playwright-highlight-label`. */
  artifact: string;
  provider?: ProviderHint;
  reliability: number;
  classes?: Partial<Record<ActorClass, number>>;
}

const BROWSER_USE: ProviderHint = { id: 'browser-use', product: 'Browser Use', confidence: 0.9 };
const SKYVERN: ProviderHint = { id: 'skyvern', product: 'Skyvern', confidence: 0.9 };
const MAGENTIC: ProviderHint = { id: 'microsoft', product: 'Magentic-UI / AutoGen WebSurfer', confidence: 0.85 };
const PLAYWRIGHT: ProviderHint = { id: 'playwright', product: 'Playwright highlight / MCP', confidence: 0.85 };
const CURSOR: ProviderHint = { id: 'cursor', product: 'Cursor Browser Automation', confidence: 0.9 };
const CODEX: ProviderHint = { id: 'openai', product: 'ChatGPT extension / Codex browser', confidence: 0.9 };
const NANOBROWSER: ProviderHint = { id: 'nanobrowser', product: 'Nanobrowser', confidence: 0.85 };
const STAGEHAND: ProviderHint = { id: 'browserbase', product: 'Stagehand', confidence: 0.6 };

/** Attribute names that only agent frameworks stamp on page elements. */
export const WATCHED_ATTRIBUTES: Record<string, Omit<DomArtifactMatch, 'artifact'>> = {
  unique_id: { signal: 'probe.agent-framework-artifact', provider: SKYVERN, reliability: 1 },
  'data-skyvern-otp-box': { signal: 'probe.agent-framework-artifact', provider: SKYVERN, reliability: 1 },
  'data-skyvern-otp-filled': { signal: 'probe.agent-framework-artifact', provider: SKYVERN, reliability: 1 },
  'data-pw-overlay': { signal: 'probe.agent-framework-artifact', provider: SKYVERN, reliability: 0.9 },
  __elementId: { signal: 'probe.agent-framework-artifact', provider: MAGENTIC, reliability: 1 },
  'data-browser-use-interaction-highlight': { signal: 'probe.agent-framework-artifact', provider: BROWSER_USE, reliability: 1 },
  'data-browser-use-coordinate-highlight': { signal: 'probe.agent-framework-artifact', provider: BROWSER_USE, reliability: 1 },
  'data-browser-use-highlight': { signal: 'probe.agent-framework-artifact', provider: BROWSER_USE, reliability: 1 },
  'browser-user-highlight-id': { signal: 'probe.agent-framework-artifact', provider: { ...BROWSER_USE, product: 'Browser Use <= 0.4' }, reliability: 1 },
  'data-cursor-ref': { signal: 'probe.main-world-agent-global', provider: CURSOR, reliability: 1 },
  'data-cursor-overlay': { signal: 'probe.main-world-agent-global', provider: CURSOR, reliability: 1 },
  'data-codex-favicon-badge': { signal: 'probe.main-world-agent-global', provider: CODEX, reliability: 1 },
  'data-nanobrowser-border': { signal: 'probe.agent-framework-artifact', provider: NANOBROWSER, reliability: 1, classes: { 'extension-agent': 5 } },
};

/** Element ids that only agent frameworks create. */
const KNOWN_IDS: Record<string, Omit<DomArtifactMatch, 'artifact'>> = {
  'playwright-highlight-container': { signal: 'probe.agent-framework-artifact', provider: { ...BROWSER_USE, product: 'Browser Use <= 0.4 / forks' }, reliability: 1 },
  'browser-use-debug-highlights': { signal: 'probe.agent-framework-artifact', provider: BROWSER_USE, reliability: 1 },
  'browser-use-demo-panel': { signal: 'probe.agent-framework-artifact', provider: BROWSER_USE, reliability: 1 },
  'browser-use-demo-panel-style': { signal: 'probe.agent-framework-artifact', provider: BROWSER_USE, reliability: 1 },
  'browser-use-demo-toggle': { signal: 'probe.agent-framework-artifact', provider: BROWSER_USE, reliability: 1 },
  '__pw-cursor': { signal: 'probe.agent-framework-artifact', provider: SKYVERN, reliability: 1 },
  // Generic-looking ids: a page could own them, so they stay below deterministic unless corroborated.
  boundingBoxContainer: { signal: 'probe.agent-framework-artifact', provider: SKYVERN, reliability: 0.6 },
  'red-cursor': { signal: 'probe.agent-framework-artifact', provider: MAGENTIC, reliability: 0.7 },
  'codex-agent-overlay-root': { signal: 'probe.main-world-agent-global', provider: CODEX, reliability: 1 },
};

const CLASS_RULES: { test: RegExp; match: Omit<DomArtifactMatch, 'artifact'> }[] = [
  { test: /^playwright-highlight(-|$)/, match: { signal: 'probe.agent-framework-artifact', provider: { ...BROWSER_USE, product: 'Browser Use <= 0.4 / forks' }, reliability: 1 } },
  { test: /^browser-use-demo-/, match: { signal: 'probe.agent-framework-artifact', provider: BROWSER_USE, reliability: 1 } },
  { test: /^__pw-(click-ring|trail)/, match: { signal: 'probe.agent-framework-artifact', provider: SKYVERN, reliability: 1 } },
  { test: /^x-pw-user-overlay$/, match: { signal: 'probe.playwright-artifact', provider: PLAYWRIGHT, reliability: 1 } },
  { test: /^codex-agent-overlay/, match: { signal: 'probe.main-world-agent-global', provider: CODEX, reliability: 1 } },
];

/** Playwright's highlight custom elements (locator.highlight(), recorder, MCP decorations). */
const PLAYWRIGHT_TAGS = /^x-pw-(glass|action-cursor|title|user-overlays|action-point|screencast-highlight|screencast-point|tooltip|tooltip-line|highlight|dialog)$/;

/** Generic keyword rule: only for overlay-shaped elements (see isOverlayLike) to avoid doc-site anchors. */
const KEYWORDS: { re: RegExp; provider?: ProviderHint; signal: ResidueSignalId }[] = [
  { re: /browser-use/i, provider: { ...BROWSER_USE, confidence: 0.6 }, signal: 'probe.agent-framework-artifact' },
  { re: /stagehand/i, provider: STAGEHAND, signal: 'probe.agent-framework-artifact' },
  { re: /skyvern/i, provider: { ...SKYVERN, confidence: 0.7 }, signal: 'probe.agent-framework-artifact' },
  { re: /playwright/i, provider: { id: 'playwright', product: 'Playwright', confidence: 0.5 }, signal: 'probe.agent-framework-artifact' },
  { re: /puppeteer/i, provider: { id: 'puppeteer', product: 'Puppeteer', confidence: 0.5 }, signal: 'probe.agent-framework-artifact' },
  { re: /agent-overlay/i, signal: 'probe.agent-framework-artifact' },
];

/** Overlays are appended to body/html with absolute/fixed positioning or a huge z-index; doc anchors are not. */
export function isOverlayLike(el: Element): boolean {
  try {
    const style = (el as HTMLElement).style;
    const z = style ? Number.parseInt(style.zIndex, 10) : NaN;
    const pos = style ? style.position : '';
    const pe = style ? style.pointerEvents : '';
    const parentTag = el.parentElement?.tagName;
    const topLevel = parentTag === 'BODY' || parentTag === 'HTML';
    return (Number.isFinite(z) && z >= 1000) || ((pos === 'fixed' || pos === 'absolute') && topLevel) || (pe === 'none' && topLevel);
  } catch {
    return false;
  }
}

/** Classify a single element by tag, id and class list. */
export function classifyElement(el: Element): DomArtifactMatch | undefined {
  try {
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (PLAYWRIGHT_TAGS.test(tag)) return { signal: 'probe.playwright-artifact', artifact: `<${tag}>`, provider: PLAYWRIGHT, reliability: 1 };
    const id = el.id || '';
    if (id && Object.prototype.hasOwnProperty.call(KNOWN_IDS, id)) return { ...KNOWN_IDS[id]!, artifact: `#${id}` };
    const classes = typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean) : [];
    for (const c of classes) {
      for (const rule of CLASS_RULES) if (rule.test.test(c)) return { ...rule.match, artifact: `.${c}` };
    }
    for (const attr of Object.keys(WATCHED_ATTRIBUTES)) {
      if (el.hasAttribute(attr)) return classifyAttribute(attr, el);
    }
    const hay = `${id} ${classes.join(' ')}`;
    if (hay.trim() && isOverlayLike(el)) {
      for (const k of KEYWORDS) {
        if (k.re.test(hay)) {
          // Keyword-only matches stay non-deterministic (8 x 0.5) until a second artifact corroborates
          // them: a docs site (playwright.dev) can own a fixed header called "playwright-...".
          const m: DomArtifactMatch = { signal: k.signal, artifact: id ? `#${id}` : `.${classes.find((c) => k.re.test(c)) ?? classes[0]}`, reliability: 0.5 };
          if (k.provider) m.provider = k.provider;
          return m;
        }
      }
    }
  } catch {
    /* detached or exotic node */
  }
  return undefined;
}

/** Classify an attribute mutation. Skyvern's unique_id is validated by its short alphanumeric shape. */
export function classifyAttribute(name: string, el: Element): DomArtifactMatch | undefined {
  const rule = WATCHED_ATTRIBUTES[name];
  if (!rule) return undefined;
  const value = attempt(() => el.getAttribute(name)) ?? '';
  if (name === 'unique_id' && !/^[A-Za-z0-9_-]{1,16}$/.test(value)) return undefined;
  if (name === 'data-cursor-ref' && !/^e\d+$/.test(value)) return undefined;
  if (name === '__elementId' && !/^\d+$/.test(value)) return undefined;
  return { ...rule, artifact: `[${name}]` };
}

export const SWEEP_SELECTOR = [
  ...Object.keys(WATCHED_ATTRIBUTES).map((a) => `[${a}]`),
  ...Object.keys(KNOWN_IDS).map((id) => `#${cssEscape(id)}`),
  '[class*="playwright-highlight"]',
  '[class*="browser-use-demo-"]',
  'x-pw-glass',
  'x-pw-highlight',
  'x-pw-tooltip',
  'x-pw-action-point',
].join(',');

function cssEscape(id: string): string {
  return id.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
}

/**
 * Aggregates artifact matches into signals. Weak rules (reliability < 1) become
 * full-strength once a second distinct artifact corroborates them; attribute
 * stamping (unique_id, __elementId) needs >= 3 elements before it counts fully.
 */
export class DomArtifactAggregator {
  private readonly seen = new Map<ResidueSignalId, { artifacts: Set<string>; counts: Map<string, number>; best: DomArtifactMatch; specific: number }>();

  add(match: DomArtifactMatch): SignalInput | undefined {
    const entry = this.seen.get(match.signal) ?? { artifacts: new Set<string>(), counts: new Map<string, number>(), best: match, specific: 0 };
    // "Specific" = a named rule (id/class/tag/attribute table), not the generic keyword fallback.
    if (!entry.artifacts.has(match.artifact) && match.reliability > 0.5) entry.specific++;
    entry.artifacts.add(match.artifact);
    entry.counts.set(match.artifact, (entry.counts.get(match.artifact) ?? 0) + 1);
    if (match.reliability >= entry.best.reliability) entry.best = match;
    this.seen.set(match.signal, entry);

    const stamped = match.artifact.startsWith('[') ? entry.counts.get(match.artifact) ?? 0 : 0;
    let reliability = entry.best.reliability;
    if (match.artifact.startsWith('[') && entry.artifacts.size === 1) {
      // Attribute stamping: 1 element => half weight, 3+ => full.
      reliability = Math.min(reliability, stamped >= 3 ? 1 : stamped === 2 ? 0.75 : 0.5);
    }
    // Corroboration: two distinct artifacts, at least one from a specific rule.
    if (entry.artifacts.size >= 2 && entry.specific >= 1) reliability = Math.max(reliability, 1);

    const artifacts = [...entry.artifacts];
    const input: SignalInput = {
      id: match.signal,
      summary: `Agent framework DOM artifact${artifacts.length === 1 ? '' : 's'} present: ${listSummary(artifacts)}${stamped > 1 ? ` (${stamped} elements stamped)` : ''}`,
      value: artifacts,
      details: { kind: 'dom', counts: Object.fromEntries(entry.counts) },
    };
    if (reliability < 1) input.reliability = reliability;
    if (entry.best.provider) input.provider = entry.best.provider;
    if (entry.best.classes) input.classes = entry.best.classes;
    return input;
  }
}

/** Attributes the MutationObserver watches (id/class for the id/class rules, plus the stamped attributes). */
export const OBSERVED_ATTRIBUTES: string[] = ['id', 'class', ...Object.keys(WATCHED_ATTRIBUTES)];

/** Cheap pre-filter for id/class mutations, so class churn on busy pages costs one regex test. */
const ID_CLASS_PREFILTER = /playwright|browser-use|__pw-|x-pw-|codex-agent|skyvern|stagehand|puppeteer|agent-overlay|red-cursor|boundingBoxContainer/i;

/** Max added elements examined per mutation batch (large SPA renders). */
export const MAX_ADDED_PER_BATCH = 200;

/** Collect matches from a set of mutation records. */
export function matchesFromMutations(records: readonly MutationRecord[]): DomArtifactMatch[] {
  const out: DomArtifactMatch[] = [];
  let budget = MAX_ADDED_PER_BATCH;
  for (const r of records) {
    try {
      if (r.type === 'attributes' && r.attributeName && r.target.nodeType === 1) {
        const el = r.target as Element;
        if (r.attributeName === 'id' || r.attributeName === 'class') {
          const v = attempt(() => el.getAttribute(r.attributeName!)) ?? '';
          if (!ID_CLASS_PREFILTER.test(v)) continue;
          const m = classifyElement(el);
          if (m) out.push(m);
          continue;
        }
        const m = classifyAttribute(r.attributeName, el);
        if (m) out.push(m);
        continue;
      }
      if (r.type === 'childList') {
        const added = r.addedNodes;
        for (let i = 0; i < added.length && budget > 0; i++) {
          const n = added[i]!;
          if (n.nodeType !== 1) continue;
          budget--;
          const el = n as Element;
          const m = classifyElement(el);
          if (m) out.push(m);
          // Overlays often arrive as a container with marked children (highlight labels, corner brackets).
          if (!el.firstElementChild) continue;
          const inner = attempt(() => el.querySelectorAll(SWEEP_SELECTOR));
          if (inner) inner.forEach((c) => {
            const cm = classifyElement(c);
            if (cm) out.push(cm);
          });
        }
      }
    } catch {
      /* ignore this record */
    }
  }
  return out;
}

/** Sweep the existing document (the SDK may load after the agent stamped the DOM). */
export function sweepDocument(doc: Document): DomArtifactMatch[] {
  const out: DomArtifactMatch[] = [];
  const nodes = attempt(() => doc.querySelectorAll(SWEEP_SELECTOR));
  if (!nodes) return out;
  nodes.forEach((el) => {
    const m = classifyElement(el);
    if (m) out.push(m);
  });
  return out;
}
