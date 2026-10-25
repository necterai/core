import { LABEL_HEADERS, SESSION_HEADER } from '@necterai/core';
import type { InterventionHandler } from '../types.js';

declare global {
  interface Window {
    __necter?: { score: number; actorClass: string; provider?: string; sessionId: string; action: string };
  }
}

let patched = false;
let current: Record<string, string> = {};

/**
 * Labeling makes the verdict available to the application: a global, a cookie
 * and headers automatically attached to same-origin fetch/XHR calls.
 */
export const labelHandler: InterventionHandler = (_action, ctx) => {
  if (typeof window === 'undefined') return false;
  const v = ctx.verdict;
  window.__necter = { score: v.score, actorClass: v.actorClass, sessionId: ctx.session.id, action: ctx.decision.primary, ...(v.provider ? { provider: v.provider.id } : {}) };
  current = { [SESSION_HEADER]: ctx.session.id, [LABEL_HEADERS.score]: String(v.score), [LABEL_HEADERS.actorClass]: v.actorClass, [LABEL_HEADERS.action]: ctx.decision.primary };
  if (v.provider) current[LABEL_HEADERS.provider] = v.provider.id;
  try {
    document.cookie = `__necter_label=${encodeURIComponent(`${v.score}:${v.actorClass}:${ctx.decision.primary}`)}; Path=/; Max-Age=600; SameSite=Lax`;
  } catch {
    /* ignore */
  }
  if (!patched) {
    patched = true;
    const original = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      try {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
        if (url.origin === location.origin) {
          const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
          for (const [k, val] of Object.entries(current)) if (!headers.has(k)) headers.set(k, val);
          return original(input, { ...init, headers });
        }
      } catch {
        /* fall through */
      }
      return original(input, init);
    }) as typeof window.fetch;
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      try {
        for (const [k, val] of Object.entries(current)) this.setRequestHeader(k, val);
      } catch {
        /* header already sent or cross-origin */
      }
      return send.call(this, body);
    };
  }
  return true;
};
