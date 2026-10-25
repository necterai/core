import type { InterventionHandler } from '../types.js';

let installed = false;
/** Tarpit: delay same-origin fetch/XHR responses so each agent step costs seconds. */
export const tarpitHandler: InterventionHandler = (action, ctx) => {
  if (typeof window === 'undefined' || installed) return installed;
  installed = true;
  const delay = Number(action.params?.['delayMs'] ?? 4000);
  const endpoint = ctx.config.endpoint;
  const original = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes(endpoint)) return original(input, init);
    return new Promise<Response>((resolve, reject) => setTimeout(() => original(input, init).then(resolve, reject), delay));
  }) as typeof window.fetch;
  return true;
};
