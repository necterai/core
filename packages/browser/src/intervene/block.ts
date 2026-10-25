import type { InterventionHandler } from '../types.js';
import { el, overlayRoot } from './dom.js';

export const BLOCK_OVERLAY_ID = '__necter-block';

export const blockHandler: InterventionHandler = (_action, ctx) => {
  if (typeof document === 'undefined') return false;
  const root = overlayRoot(BLOCK_OVERLAY_ID);
  root.replaceChildren();
  const box = el('div', { maxWidth: '520px' });
  box.appendChild(el('h1', { fontSize: '22px', margin: '0 0 12px' }, ctx.config.text.blockTitle));
  box.appendChild(el('p', { fontSize: '15px', lineHeight: '1.5', margin: '0 0 16px', opacity: '0.9' }, ctx.config.text.blockBody));
  const link = el('a', { color: '#93c5fd' }, 'Agent access terms');
  link.href = ctx.config.text.gatewayUrl;
  link.rel = 'nofollow';
  box.appendChild(link);
  root.appendChild(box);
  // Freeze the page for automation: stop scrolling and intercept API calls.
  try {
    document.documentElement.style.overflow = 'hidden';
  } catch {
    /* ignore */
  }
  installFetchBlock(ctx.config.endpoint);
  return true;
};

let fetchBlocked = false;
function installFetchBlock(endpoint: string): void {
  if (fetchBlocked || typeof window === 'undefined') return;
  fetchBlocked = true;
  const original = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes(endpoint)) return original(input, init);
    return Promise.resolve(new Response(JSON.stringify({ error: 'blocked', reason: 'automation' }), { status: 403, headers: { 'content-type': 'application/json' } }));
  }) as typeof window.fetch;
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    const u = String(url);
    if (!u.includes(endpoint)) {
      this.addEventListener('readystatechange', () => {
        if (this.readyState === 1) this.abort();
      });
    }
    return (open as unknown as (...a: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof XMLHttpRequest.prototype.open;
}
