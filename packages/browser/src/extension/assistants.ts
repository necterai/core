/**
 * Human-assistant evidence and agentic-browser brand hooks
 * (false-positive-traps.md 11.2, 11.4, 11.5, 13; detection-spec.md 6).
 *
 * Extensions that assist a present person inject DOM too. Their markers are
 * positive human evidence, and they also tell the harvest/behaviour modules not
 * to treat the mutations as agent activity.
 */

export interface AssistantMarker {
  /** Product name. */
  product: string;
  /** Selector or description that matched. */
  match: string;
}

interface MarkerRule {
  product: string;
  selectors: string[];
}

/** Exact selectors from the research (GitHub code search across production codebases). */
export const ASSISTANT_MARKER_RULES: readonly MarkerRule[] = [
  { product: 'Grammarly', selectors: ['grammarly-desktop-integration', 'body[data-gr-ext-installed]', 'body[data-new-gr-c-s-check-loaded]'] },
  { product: '1Password', selectors: ['com-1password-button', '[data-com-onepassword-filled]'] },
  { product: 'LastPass', selectors: ['[data-lastpass-icon-root]', '[data-lastpass-root]'] },
  { product: 'Dashlane', selectors: ['[data-dashlane-rid]', '[data-dashlane-classification]', '[data-dashlanecreated]', '[data-dashlane-uid]'] },
  { product: 'Bitwarden', selectors: ['.com-bitwarden-browser-animated-fill'] },
];

/** Google Translate: `html.translated-ltr|rtl` plus text nodes re-wrapped in `<font>` elements. */
export function detectGoogleTranslate(doc: Document): AssistantMarker | undefined {
  try {
    const html = doc.documentElement;
    if (html.classList.contains('translated-ltr')) return { product: 'Google Translate', match: 'html.translated-ltr' };
    if (html.classList.contains('translated-rtl')) return { product: 'Google Translate', match: 'html.translated-rtl' };
    // Modern pages do not use <font>; three or more wrappers is the translator's signature.
    const fonts = doc.body ? doc.body.getElementsByTagName('font') : undefined;
    if (fonts && fonts.length >= 3) return { product: 'Google Translate', match: `${fonts.length} <font> wrappers` };
  } catch {
    /* ignore */
  }
  return undefined;
}

export function scanAssistantMarkers(doc: Document | undefined = typeof document !== 'undefined' ? document : undefined): AssistantMarker[] {
  const out: AssistantMarker[] = [];
  if (!doc) return out;
  for (const rule of ASSISTANT_MARKER_RULES) {
    for (const sel of rule.selectors) {
      try {
        if (doc.querySelector(sel)) {
          out.push({ product: rule.product, match: sel });
          break;
        }
      } catch {
        /* invalid selector in an exotic DOM; ignore */
      }
    }
  }
  const translate = detectGoogleTranslate(doc);
  if (translate) out.push(translate);
  return out;
}

export function describeAssistantMarkers(markers: AssistantMarker[]): string {
  return `Assistant extension markers present: ${markers.map((m) => `${m.product} (${m.match})`).join(', ')}.`;
}

export interface BrandHit {
  brand: string;
  version: string;
  product: string;
  provider: string;
}

interface UaBrand {
  brand: string;
  version: string;
}

/**
 * Agentic-browser brands. As of the research snapshot Atlas and Comet report
 * Chrome-identical brands, so this hook is expected to produce few hits; it is
 * kept so a vendor that starts declaring itself is attributed immediately.
 */
export function matchAgenticBrands(brands: readonly UaBrand[] | undefined): BrandHit[] {
  const hits: BrandHit[] = [];
  if (!brands) return hits;
  for (const b of brands) {
    const name = typeof b?.brand === 'string' ? b.brand : '';
    const version = typeof b?.version === 'string' ? b.version : '';
    if (/\batlas\b/i.test(name)) hits.push({ brand: name, version, product: 'ChatGPT Atlas', provider: 'openai' });
    else if (/\bcomet\b/i.test(name)) hits.push({ brand: name, version, product: 'Comet', provider: 'perplexity' });
    else if (/\bcopilot\b/i.test(name)) hits.push({ brand: name, version, product: 'Edge Copilot', provider: 'microsoft' });
  }
  return hits;
}

/** Edge-with-Copilot artifacts: an `Edg`/`Microsoft Edge` brand plus any page-visible Copilot marker. */
export function matchEdgeCopilotArtifacts(brands: readonly UaBrand[] | undefined, doc: Document | undefined): BrandHit | undefined {
  if (!brands || !doc) return undefined;
  const edge = brands.find((b) => /microsoft edge|\bedg\b/i.test(b?.brand ?? ''));
  if (!edge) return undefined;
  try {
    // No primary technical source exists for Copilot Actions; probe only obviously named hooks.
    if (doc.querySelector('[id^="copilot-"], [class*="edge-copilot"], [data-copilot-actions]')) {
      return { brand: edge.brand, version: edge.version, product: 'Edge Copilot', provider: 'microsoft' };
    }
  } catch {
    /* ignore */
  }
  return undefined;
}
