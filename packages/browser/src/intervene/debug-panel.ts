import type { Verdict } from '@necterai/core';
import { el } from './dom.js';

export const DEBUG_PANEL_ID = '__necter-debug';

/**
 * Floating evidence panel for `config.debug`: score, class, provider and the
 * top evidence lines, refreshed on every verdict. CSSOM only (CSP-safe).
 */
export function createDebugPanel(): { update(v: Verdict): void; destroy(): void } {
  if (typeof document === 'undefined') return { update: () => undefined, destroy: () => undefined };
  let root = document.getElementById(DEBUG_PANEL_ID) as HTMLDivElement | null;
  if (!root) {
    root = el('div', {
      position: 'fixed',
      right: '12px',
      bottom: '12px',
      width: '340px',
      maxHeight: '45vh',
      overflow: 'auto',
      zIndex: '2147483646',
      background: 'rgba(15, 23, 42, 0.94)',
      color: '#e2e8f0',
      font: '12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
      borderRadius: '10px',
      padding: '10px 12px',
      boxShadow: '0 8px 30px rgba(0,0,0,0.35)',
      pointerEvents: 'auto',
    });
    root.id = DEBUG_PANEL_ID;
    root.setAttribute('aria-hidden', 'true');
    root.setAttribute('data-necter-ignore', '');
    (document.body ?? document.documentElement).appendChild(root);
  }
  const header = el('div', { fontWeight: '700', marginBottom: '6px', display: 'flex', justifyContent: 'space-between' });
  const title = el('span', {}, 'necter');
  const close = el('span', { cursor: 'pointer', opacity: '0.7' }, '×');
  close.addEventListener('click', () => root?.remove());
  header.append(title, close);
  const status = el('div', { marginBottom: '6px' });
  const list = el('div', {});
  root.replaceChildren(header, status, list);
  return {
    update(v) {
      if (!root || !root.isConnected) return;
      const color = v.automation >= 0.9 ? '#f87171' : v.automation >= 0.6 ? '#fbbf24' : '#4ade80';
      status.replaceChildren();
      const score = el('span', { color, fontWeight: '700' }, `${v.score}`);
      status.append(score, document.createTextNode(` ${v.actorClass}${v.provider ? ` · ${v.provider.id}${v.provider.verified ? ' ✓' : ''}` : ''} · ${v.stage}${v.deterministic ? ' · deterministic' : ''} · ${v.signalCount} signals`));
      list.replaceChildren();
      for (const e of v.evidence.slice(0, 10)) {
        const row = el('div', { display: 'flex', gap: '6px', marginTop: '3px' });
        const w = el('span', { color: e.contribution > 0 ? '#f87171' : '#4ade80', minWidth: '44px', textAlign: 'right' }, `${e.contribution > 0 ? '+' : ''}${e.contribution.toFixed(1)}`);
        const txt = el('span', { opacity: '0.9' }, `${e.signalId}: ${e.summary}`);
        row.append(w, txt);
        list.appendChild(row);
      }
    },
    destroy() {
      root?.remove();
    },
  };
}
