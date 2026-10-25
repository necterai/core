import { beforeEach, describe, expect, it } from 'vitest';
import { describeAssistantMarkers, matchAgenticBrands, matchEdgeCopilotArtifacts, scanAssistantMarkers } from '../src/extension/assistants.js';

describe('human-assistant DOM markers', () => {
  beforeEach(() => {
    document.documentElement.className = '';
    document.body.innerHTML = '';
    document.body.removeAttribute('data-gr-ext-installed');
  });

  it('finds nothing on a clean page', () => {
    expect(scanAssistantMarkers(document)).toEqual([]);
  });

  it('detects Grammarly, 1Password, LastPass, Dashlane and Bitwarden markers', () => {
    document.body.innerHTML = [
      '<grammarly-desktop-integration data-grammarly-shadow-root="true"></grammarly-desktop-integration>',
      '<input data-com-onepassword-filled="light"><com-1password-button></com-1password-button>',
      '<div data-lastpass-icon-root=""></div>',
      '<input data-dashlane-rid="abc">',
      '<input class="com-bitwarden-browser-animated-fill">',
    ].join('');
    const markers = scanAssistantMarkers(document);
    expect(markers.map((m) => m.product)).toEqual(['Grammarly', '1Password', 'LastPass', 'Dashlane', 'Bitwarden']);
    expect(describeAssistantMarkers(markers)).toContain('Grammarly (grammarly-desktop-integration)');
  });

  it('detects Google Translate via html.translated-ltr or many <font> wrappers', () => {
    document.documentElement.classList.add('translated-ltr');
    expect(scanAssistantMarkers(document)).toEqual([{ product: 'Google Translate', match: 'html.translated-ltr' }]);
    document.documentElement.classList.remove('translated-ltr');
    document.body.innerHTML = '<p><font>a</font> <font>b</font></p>';
    expect(scanAssistantMarkers(document)).toEqual([]);
    document.body.innerHTML = '<p><font>a</font> <font>b</font> <font>c</font></p>';
    expect(scanAssistantMarkers(document)[0]?.match).toBe('3 <font> wrappers');
  });
});

describe('agentic-browser brands', () => {
  it('matches Atlas / Comet / Copilot brands and ignores stock Chrome', () => {
    expect(matchAgenticBrands([{ brand: 'Chromium', version: '142' }, { brand: 'Google Chrome', version: '142' }, { brand: 'Not_A Brand', version: '99' }])).toEqual([]);
    expect(matchAgenticBrands([{ brand: 'ChatGPT Atlas', version: '1' }])[0]).toMatchObject({ product: 'ChatGPT Atlas', provider: 'openai' });
    expect(matchAgenticBrands([{ brand: 'Comet', version: '1' }])[0]).toMatchObject({ product: 'Comet', provider: 'perplexity' });
    expect(matchAgenticBrands(undefined)).toEqual([]);
  });

  it('needs an Edge brand plus a Copilot DOM artifact', () => {
    document.body.innerHTML = '';
    const edge = [{ brand: 'Microsoft Edge', version: '142' }, { brand: 'Chromium', version: '142' }];
    expect(matchEdgeCopilotArtifacts(edge, document)).toBeUndefined();
    document.body.innerHTML = '<div id="copilot-actions-root"></div>';
    expect(matchEdgeCopilotArtifacts(edge, document)?.provider).toBe('microsoft');
    expect(matchEdgeCopilotArtifacts([{ brand: 'Google Chrome', version: '142' }], document)).toBeUndefined();
  });
});
