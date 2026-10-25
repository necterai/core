import type { ProviderId } from '@necterai/core';

/**
 * Local knowledge table of agent extensions and agentic-browser components.
 *
 * The structure mirrors `agentExtensions` in `@necterai/signatures` so the
 * integrator can diff/merge the two, but the entries are embedded here so the
 * browser bundle has no runtime import of the signatures package.
 *
 * Every string below was copied from a manifest, bundle or vendor listing cited
 * in docs/research/raw/extension-agents.md (sections 2, 4, 6, 9) and
 * computer-use-agents.md (section 5). Nothing is guessed: entries without
 * known web-accessible resources carry an empty `versions` list and are used
 * only for stylesheet/id attribution.
 */

export type ExtensionScheme = 'chrome-extension' | 'comet-extension';

export interface AgentExtensionVersion {
  /** Extension version the paths were captured from. */
  version: string;
  /** `web_accessible_resources` paths (relative to the extension root) with `matches: ["<all_urls>"]`. */
  paths: string[];
  /** ISO date the hashes were captured (hashed filenames rotate per release). */
  observedAt: string;
  /** Where the paths came from (manifest field / listing). */
  source: string;
}

export interface AgentExtensionEntry {
  /** Extension id (32 lowercase letters a-p). */
  id: string;
  /** Provider slug from the core taxonomy (open string). */
  provider: ProviderId;
  /** Product name used in provider hints and summaries. */
  product: string;
  /** Store/manifest name. */
  name: string;
  /** URL scheme the extension is served from. Comet's component extension uses `comet-extension://`. */
  scheme: ExtensionScheme;
  /** How the extension acts on pages. */
  mechanism: 'chrome.debugger' | 'content-script' | 'mixed' | 'unknown';
  /** Known per-version web-accessible resource tables, newest first. */
  versions: AgentExtensionVersion[];
  /** True when the extension injects a content stylesheet (visible as `chrome-extension://` href in document.styleSheets). */
  injectsStylesheet?: boolean;
  /** Attribution confidence for a resource/indicator hit on this entry. */
  confidence: number;
  /** Store status; unlisted ids come from native-host allow-lists and are less certain. */
  status: 'listed' | 'unlisted' | 'component' | 'unpacked';
  notes?: string;
}

export const KNOWN_EXTENSIONS_TABLE_VERSION = '2026-10-24';

export const KNOWN_AGENT_EXTENSIONS: readonly AgentExtensionEntry[] = [
  {
    id: 'fcoeoabgfenejglbffodgkkbkcdhcgfn',
    provider: 'anthropic',
    product: 'Claude in Chrome',
    name: 'Claude',
    scheme: 'chrome-extension',
    mechanism: 'chrome.debugger',
    confidence: 0.9,
    status: 'listed',
    versions: [
      {
        version: '1.0.102',
        paths: ['assets/accessibility-tree.js-B-oUarrX.js', 'assets/agent-visual-indicator.js-uaVFxZ2f.js'],
        observedAt: '2026-10-24',
        source: 'manifest.json web_accessible_resources (matches <all_urls>, use_dynamic_url false)',
      },
    ],
    notes: 'Same extension serves the side panel, Claude Code --chrome and Claude Desktop/Cowork. Hashed filenames rotate per release; add a new version entry per release.',
  },
  {
    id: 'dihbgbndebgnbjfmelmegjepbnkhlgni',
    provider: 'anthropic',
    product: 'Claude in Chrome (unlisted build)',
    name: 'Claude (unlisted)',
    scheme: 'chrome-extension',
    mechanism: 'chrome.debugger',
    confidence: 0.6,
    status: 'unlisted',
    versions: [],
    notes: 'Appears in com.anthropic.claude_browser_extension native-host allowed_origins; Web Store listing empty.',
  },
  {
    id: 'dngcpimnedloihjnnfngkgjoidhnaolf',
    provider: 'anthropic',
    product: 'Claude in Chrome (unlisted build)',
    name: 'Claude (unlisted)',
    scheme: 'chrome-extension',
    mechanism: 'chrome.debugger',
    confidence: 0.6,
    status: 'unlisted',
    versions: [],
    notes: 'Appears in com.anthropic.claude_browser_extension native-host allowed_origins.',
  },
  {
    id: 'hehggadaopoacecdllhhajmbjkdcmajg',
    provider: 'openai',
    product: 'ChatGPT extension (Codex browser driver)',
    name: 'ChatGPT',
    scheme: 'chrome-extension',
    mechanism: 'chrome.debugger',
    confidence: 0.9,
    status: 'listed',
    versions: [],
    notes: 'Chrome Web Store id (also Brave/Opera/Vivaldi); native host com.openai.codexextension. Manifest/WAR not captured (1.26.1020.11845 as of 2026-10-22).',
  },
  {
    id: 'odlomjlbamekndcpllcnffbgeohgkmjh',
    provider: 'openai',
    product: 'ChatGPT extension (Codex browser driver)',
    name: 'ChatGPT',
    scheme: 'chrome-extension',
    mechanism: 'chrome.debugger',
    confidence: 0.9,
    status: 'listed',
    versions: [],
    notes: 'Edge Add-ons id from scripts/extension-ids.json of the Codex browser plugin.',
  },
  {
    id: 'npclhjbddhklpbnacpjloidibaggcgon',
    provider: 'perplexity',
    product: 'Comet Assistant',
    name: 'Comet Assistant (component extension)',
    scheme: 'comet-extension',
    mechanism: 'chrome.debugger',
    confidence: 0.9,
    status: 'component',
    versions: [],
    notes: 'Confirmed by com.perplexity.comet.json allowed_origins and Castle/Hacktron write-ups; served as comet-extension://. WAR unknown.',
  },
  {
    id: 'mmlmfjhmonkocbjadbfplnigmagldckm',
    provider: 'microsoft',
    product: 'Playwright Extension',
    name: 'Playwright Extension',
    scheme: 'chrome-extension',
    mechanism: 'chrome.debugger',
    confidence: 0.9,
    status: 'listed',
    versions: [],
    notes: 'v0.4.0 (2026-09-01): no content_scripts, no web_accessible_resources; only the debugger infobar and robotic input are observable.',
  },
  {
    id: 'bjfgambnhccakkhmkepdoekmckoijdlc',
    provider: 'browsermcp',
    product: 'Browser MCP',
    name: 'Browser MCP - Automate your browser using VS Code, Cursor, Claude, and more',
    scheme: 'chrome-extension',
    mechanism: 'chrome.debugger',
    confidence: 0.85,
    status: 'listed',
    versions: [],
    notes: 'v1.3.4 (2025-05-07); manifest not public.',
  },
  {
    id: 'imbddededgmcgfhfpcjmijokokekbkal',
    provider: 'nanobrowser',
    product: 'Nanobrowser',
    name: 'Nanobrowser',
    scheme: 'chrome-extension',
    mechanism: 'chrome.debugger',
    confidence: 0.85,
    status: 'listed',
    versions: [],
    notes: 'v0.3.0 (2026-10-16); Puppeteer over chrome.debugger; no WAR in wxt.config.ts.',
  },
  {
    id: 'ajdioenfpgabnjlclgckbbnjjhdnjkhn',
    provider: 'nanobrowser',
    product: 'Nanobrowser',
    name: 'Nanobrowser (Edge build)',
    scheme: 'chrome-extension',
    mechanism: 'chrome.debugger',
    confidence: 0.7,
    status: 'listed',
    versions: [],
    notes: 'Edge id reported by secondary sources only.',
  },
  {
    id: 'eanggfilgoajaocelnaflolkadkeghjp',
    provider: 'harpa',
    product: 'HARPA AI',
    name: 'HARPA AI: Web Automation with ChatGPT, Claude, Gemini, Grok',
    scheme: 'chrome-extension',
    mechanism: 'content-script',
    confidence: 0.8,
    status: 'listed',
    versions: [],
    injectsStylesheet: true,
    notes: 'v16.1.0 (2026-10-24); DOM-based automation (isTrusted:false likely) and injected UI. Stylesheet injection uncertain.',
  },
];

/** Agent ids that may appear as `chrome-extension://<id>/...` stylesheet hrefs. */
export const AGENT_EXTENSION_IDS: ReadonlySet<string> = new Set(KNOWN_AGENT_EXTENSIONS.map((e) => e.id));

const BY_ID: ReadonlyMap<string, AgentExtensionEntry> = new Map(KNOWN_AGENT_EXTENSIONS.map((e) => [e.id, e]));

export function findAgentExtension(id: string): AgentExtensionEntry | undefined {
  return BY_ID.get(id);
}

export interface ResourceProbeTarget {
  entry: AgentExtensionEntry;
  version: string;
  path: string;
  url: string;
}

/** Every probeable web-accessible resource URL across all versions of all entries. */
export function resourceProbeTargets(table: readonly AgentExtensionEntry[] = KNOWN_AGENT_EXTENSIONS): ResourceProbeTarget[] {
  const out: ResourceProbeTarget[] = [];
  for (const entry of table) {
    for (const v of entry.versions) {
      for (const path of v.paths) {
        out.push({ entry, version: v.version, path, url: `${entry.scheme}://${entry.id}/${path}` });
      }
    }
  }
  return out;
}

/** Extract the extension id from a `chrome-extension://` / `comet-extension://` URL, or undefined. */
export function extensionIdFromUrl(href: string | null | undefined): string | undefined {
  if (!href) return undefined;
  const m = /^(?:chrome|comet|moz|safari-web)-extension:\/\/([a-p]{32}|[a-z0-9-]{8,64})\//i.exec(href);
  return m?.[1]?.toLowerCase();
}

/**
 * Non-extension agent drivers that leave main-world residue (Cursor is an
 * embedded-browser MCP server, not a store extension). Kept here so all
 * provider/product strings live in one table.
 */
export const KNOWN_AGENT_DRIVERS = {
  codex: { provider: 'openai' as ProviderId, product: 'Codex browser driver (ChatGPT extension)', confidence: 0.9 },
  cursor: { provider: 'cursor' as ProviderId, product: 'Cursor Browser Automation', confidence: 0.9 },
  comet: { provider: 'perplexity' as ProviderId, product: 'Comet Assistant', confidence: 0.9 },
  claude: { provider: 'anthropic' as ProviderId, product: 'Claude in Chrome', confidence: 0.9 },
} as const;

/** Fixed iframe name used by the Codex driver's WebMCP discovery probe (browser-service.mjs). */
export const CODEX_WEBMCP_PROBE_FRAME_NAME = 'codex-webmcp-probe-97adecab-75be-4770-bbe4-654cac643843';
/** Element id/class constant used by the Codex agent overlay. */
export const CODEX_AGENT_OVERLAY_ROOT = 'codex-agent-overlay-root';
/** Comet Assistant overlay ids (Castle write-up, comet-agent/overlay.js). */
export const COMET_OVERLAY_ID = 'pplx-agent-overlay';
export const COMET_STOP_BUTTON_ID = 'pplx-agent-overlay-stop-button';
/** Background colour Comet's injected stylesheet applies to #pplx-agent-overlay-stop-button. */
export const COMET_STOP_BUTTON_BACKGROUND = 'rgb(255, 254, 251)';
/** Claude in Chrome side-panel overlays injected with chrome.scripting.executeScript (user-driven flows). */
export const CLAUDE_PICKER_OVERLAY_IDS: readonly string[] = ['claude-screenshot-overlay', 'claude-prompt-overlay', 'claude-element-overlay'];
/** postMessage types emitted by Claude's element picker (target "*"). */
export const CLAUDE_MESSAGE_TYPES: ReadonlySet<string> = new Set(['CLAUDE_ELEMENT_SELECTION', 'CLAUDE_ELEMENT_SELECTION_CLEANUP']);
