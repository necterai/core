import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_EXTENSION_IDS,
  KNOWN_AGENT_EXTENSIONS,
  extensionIdFromUrl,
  findAgentExtension,
  resourceProbeTargets,
} from '../src/extension/known-extensions.js';
import { metaCspBlocksExtensionConnect, probeResources, probeWithFetch, summariseHits } from '../src/extension/war-probe.js';

const CLAUDE_ID = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';
const CLAUDE_URLS = [
  `chrome-extension://${CLAUDE_ID}/assets/accessibility-tree.js-B-oUarrX.js`,
  `chrome-extension://${CLAUDE_ID}/assets/agent-visual-indicator.js-uaVFxZ2f.js`,
];

function fakeResponse(status: number, type = 'basic'): Response {
  return { ok: status >= 200 && status < 300, status, type } as unknown as Response;
}

describe('known-extensions table', () => {
  it('has well-formed entries with 32-char ids, providers and versioned paths', () => {
    expect(KNOWN_AGENT_EXTENSIONS.length).toBeGreaterThan(5);
    const ids = new Set<string>();
    for (const e of KNOWN_AGENT_EXTENSIONS) {
      expect(e.id).toMatch(/^[a-p]{32}$/);
      expect(ids.has(e.id)).toBe(false);
      ids.add(e.id);
      expect(e.provider.length).toBeGreaterThan(0);
      expect(e.product.length).toBeGreaterThan(0);
      expect(e.confidence).toBeGreaterThan(0);
      expect(e.confidence).toBeLessThanOrEqual(1);
      for (const v of e.versions) {
        expect(v.version).toMatch(/^\d+(\.\d+)+$/);
        expect(v.paths.length).toBeGreaterThan(0);
        for (const p of v.paths) expect(p.startsWith('/')).toBe(false);
      }
    }
  });

  it('contains the Claude in Chrome 1.0.102 web-accessible resources verbatim', () => {
    const claude = findAgentExtension(CLAUDE_ID);
    expect(claude?.provider).toBe('anthropic');
    expect(claude?.product).toBe('Claude in Chrome');
    expect(claude?.versions[0]?.version).toBe('1.0.102');
    expect(claude?.versions[0]?.paths).toEqual(['assets/accessibility-tree.js-B-oUarrX.js', 'assets/agent-visual-indicator.js-uaVFxZ2f.js']);
    expect(resourceProbeTargets().map((t) => t.url)).toEqual(CLAUDE_URLS);
  });

  it('maps the other known agent ids to providers and schemes', () => {
    expect(findAgentExtension('hehggadaopoacecdllhhajmbjkdcmajg')?.provider).toBe('openai');
    expect(findAgentExtension('npclhjbddhklpbnacpjloidibaggcgon')?.scheme).toBe('comet-extension');
    expect(findAgentExtension('mmlmfjhmonkocbjadbfplnigmagldckm')?.provider).toBe('microsoft');
    expect(AGENT_EXTENSION_IDS.has('bjfgambnhccakkhmkepdoekmckoijdlc')).toBe(true);
    expect(extensionIdFromUrl(CLAUDE_URLS[0])).toBe(CLAUDE_ID);
    expect(extensionIdFromUrl('comet-extension://npclhjbddhklpbnacpjloidibaggcgon/background.js')).toBe('npclhjbddhklpbnacpjloidibaggcgon');
    expect(extensionIdFromUrl('https://example.com/x.css')).toBeUndefined();
  });
});

describe('probeWithFetch', () => {
  it('treats ok && status 200 as present and TypeError as absent', async () => {
    const f = vi.fn(async (url: string, _init: RequestInit) => {
      if (url === CLAUDE_URLS[0]) return fakeResponse(200);
      throw new TypeError('Failed to fetch');
    });
    expect(await probeWithFetch(CLAUDE_URLS[0]!, f)).toEqual({ outcome: 'present', status: 200, responseType: 'basic' });
    expect(await probeWithFetch(`chrome-extension://${CLAUDE_ID}/manifest.json`, f)).toEqual({ outcome: 'absent' });
    expect(f.mock.calls[0]?.[1]).toMatchObject({ mode: 'no-cors', cache: 'no-store' });
  });

  it('does not count opaque or non-200 responses as present and marks other errors unknown', async () => {
    expect((await probeWithFetch('x', async () => fakeResponse(0, 'opaque'))).outcome).toBe('absent');
    expect((await probeWithFetch('x', async () => fakeResponse(404))).outcome).toBe('absent');
    expect((await probeWithFetch('x', async () => { throw new Error('boom'); })).outcome).toBe('unknown');
  });
});

describe('probeResources', () => {
  const wait = async () => {};

  it('reports a Claude hit over fetch with both paths and attribution', async () => {
    const results = await probeResources(resourceProbeTargets(), {
      fetch: async (url) => (CLAUDE_URLS.includes(url) ? fakeResponse(200) : Promise.reject(new TypeError('Failed to fetch'))),
      watchViolations: () => () => {},
      cspBlocksExtensionConnect: () => false,
      wait,
    });
    expect(results.every((r) => r.outcome === 'present' && r.channel === 'fetch')).toBe(true);
    const hits = summariseHits(results);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.entry.id).toBe(CLAUDE_ID);
    expect(hits[0]?.version).toBe('1.0.102');
    expect(hits[0]?.paths).toHaveLength(2);
  });

  it('reports nothing when the extension is not installed', async () => {
    const results = await probeResources(resourceProbeTargets(), {
      fetch: async () => Promise.reject(new TypeError('Failed to fetch')),
      watchViolations: () => () => {},
      cspBlocksExtensionConnect: () => false,
      wait,
    });
    expect(results.every((r) => r.outcome === 'absent')).toBe(true);
    expect(summariseHits(results)).toEqual([]);
  });

  it('falls back to <link rel=prefetch> when a connect-src violation is observed', async () => {
    const linkProbe = vi.fn(async (url: string) => url === CLAUDE_URLS[1]);
    const results = await probeResources(resourceProbeTargets(), {
      fetch: async () => Promise.reject(new TypeError('Failed to fetch')),
      watchViolations: (onViolation) => {
        onViolation();
        return () => {};
      },
      cspBlocksExtensionConnect: () => false,
      linkProbe,
      wait,
    });
    expect(linkProbe).toHaveBeenCalledTimes(2);
    const hits = summariseHits(results);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.channel).toBe('link');
    expect(hits[0]?.paths).toEqual(['assets/agent-visual-indicator.js-uaVFxZ2f.js']);
  });

  it('skips fetch entirely when the meta CSP is known to block extension connects', async () => {
    const fetchSpy = vi.fn(async () => fakeResponse(200));
    const linkProbe = vi.fn(async () => false);
    const results = await probeResources(resourceProbeTargets(), { fetch: fetchSpy, cspBlocksExtensionConnect: () => true, watchViolations: () => () => {}, linkProbe, wait });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(linkProbe).toHaveBeenCalledTimes(2);
    expect(results.every((r) => r.outcome === 'absent' && r.channel === 'link')).toBe(true);
  });

  it('never throws when the fetch implementation misbehaves', async () => {
    const results = await probeResources(resourceProbeTargets(), {
      fetch: () => { throw new Error('sync explosion'); },
      watchViolations: () => () => {},
      cspBlocksExtensionConnect: () => false,
      wait,
    });
    expect(Array.isArray(results)).toBe(true);
  });
});

describe('metaCspBlocksExtensionConnect', () => {
  it('detects a connect-src that excludes extension schemes and respects allow-lists', () => {
    document.head.innerHTML = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; connect-src \'self\' https://api.example.com">';
    expect(metaCspBlocksExtensionConnect(document)).toBe(true);
    document.head.innerHTML = '<meta http-equiv="Content-Security-Policy" content="connect-src \'self\' chrome-extension:">';
    expect(metaCspBlocksExtensionConnect(document)).toBe(false);
    document.head.innerHTML = '<meta http-equiv="Content-Security-Policy" content="script-src \'self\'">';
    expect(metaCspBlocksExtensionConnect(document)).toBe(false);
    document.head.innerHTML = '';
    expect(metaCspBlocksExtensionConnect(document)).toBe(false);
  });
});
