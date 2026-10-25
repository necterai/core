import type { InterventionHandler } from '../types.js';

let installed = false;
/** Client-side rate limit: token bucket over same-origin fetch/XHR; excess calls fail fast with 429. */
export const limitHandler: InterventionHandler = (action, ctx) => {
  if (typeof window === 'undefined' || installed) return installed;
  installed = true;
  const perMinute = Number(action.params?.['perMinute'] ?? 30);
  const endpoint = ctx.config.endpoint;
  let tokens = perMinute;
  setInterval(() => {
    tokens = Math.min(perMinute, tokens + perMinute / 60);
  }, 1000);
  const original = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes(endpoint)) return original(input, init);
    if (tokens < 1) return Promise.resolve(new Response('rate limited', { status: 429 }));
    tokens -= 1;
    return original(input, init);
  }) as typeof window.fetch;
  return true;
};
