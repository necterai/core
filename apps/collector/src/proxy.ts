import type { NecterServer, Inspection } from '@necterai/server';

/** The tag the proxy (or a site owner) puts in a page. */
export function scriptTag(opts: { src: string; site: string; mode: 'monitor' | 'enforce'; debug?: boolean; async?: boolean }): string {
  const attrs = [`src="${escapeAttr(opts.src)}"`, 'data-necter', `data-site="${escapeAttr(opts.site)}"`, `data-mode="${opts.mode}"`];
  if (opts.debug) attrs.push('data-debug');
  if (opts.async) attrs.unshift('async');
  return `<script ${attrs.join(' ')}></script>`;
}

/**
 * Put the tag as early in the document as possible: right after <head>, else after
 * <html>, else at the very start. Early matters: the SDK must hook the page before
 * an agent's injected scripts run.
 */
export function injectScript(html: string, tag: string): string {
  if (html.includes('data-necter')) return html;
  // Keep <meta charset> first so the browser does not re-parse the page.
  const charset = /<meta\s+charset=["']?[\w-]+["']?\s*\/?>/i.exec(html.slice(0, 2048));
  if (charset) return html.slice(0, charset.index + charset[0].length) + tag + html.slice(charset.index + charset[0].length);
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  const root = /<html(\s[^>]*)?>/i.exec(html);
  if (root) return html.slice(0, root.index + root[0].length) + tag + html.slice(root.index + root[0].length);
  const doctype = /<!doctype[^>]*>/i.exec(html);
  if (doctype) return html.slice(0, doctype.index + doctype[0].length) + tag + html.slice(doctype.index + doctype[0].length);
  return tag + html;
}

/** Turn absolute links to the upstream into relative ones so navigation stays on the proxy. */
export function rewriteUpstreamLinks(html: string, upstream: URL): string {
  const host = upstream.host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return html.replace(new RegExp(`(["'(=])(?:https?:)?//${host}(?=[/"'?#)])`, 'gi'), '$1');
}

/** Cookies set by the upstream must work on the proxy's host (and over plain http when testing locally). */
export function rewriteSetCookie(cookie: string, secureContext: boolean): string {
  let c = cookie.replace(/;\s*domain=[^;]*/gi, '');
  if (!secureContext) c = c.replace(/;\s*secure(?=;|$)/gi, '').replace(/;\s*samesite=none/gi, '; SameSite=Lax');
  return c;
}

const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer'];

export interface ProxyOptions {
  upstream: URL;
  site: string;
  mode: 'monitor' | 'enforce';
  debug?: boolean;
  scriptPath: string;
  fetch?: typeof fetch;
}

/**
 * Reverse-proxy one request to the upstream with the full server SDK in front of it:
 * request forensics on every request, terminal actions in enforce mode, and the
 * browser SDK injected into every HTML page.
 */
export async function proxyRequest(cm: NecterServer, request: Request, inspection: Inspection, opts: ProxyOptions): Promise<Response> {
  return cm.respond(inspection, () => forward(request, opts));
}

export async function forward(request: Request, opts: ProxyOptions): Promise<Response> {
  const doFetch = opts.fetch ?? fetch;
  const url = new URL(request.url);
  const target = new URL(url.pathname + url.search, opts.upstream);
  const headers = new Headers(request.headers);
  for (const h of [...HOP_BY_HOP, 'host', 'content-length', 'accept-encoding']) headers.delete(h);
  headers.set('x-forwarded-host', url.host);
  headers.set('x-forwarded-proto', url.protocol.replace(':', ''));
  // Some upstreams reject requests whose Origin/Referer point at another host.
  const origin = headers.get('origin');
  if (origin === url.origin) headers.set('origin', opts.upstream.origin);
  const referer = headers.get('referer');
  if (referer?.startsWith(url.origin)) headers.set('referer', opts.upstream.origin + referer.slice(url.origin.length));
  const method = request.method.toUpperCase();
  const body = method === 'GET' || method === 'HEAD' ? undefined : await request.arrayBuffer();
  let up: Response;
  try {
    up = await doFetch(target, { method, headers, ...(body ? { body } : {}), redirect: 'manual' });
  } catch (err) {
    return new Response(`necter proxy: could not reach ${opts.upstream.origin} (${String(err)})`, { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  const out = new Headers();
  up.headers.forEach((v, k) => {
    const key = k.toLowerCase();
    // fetch already decoded the body; CSP would usually block nothing (the script is same-origin)
    // but nonce/strict-dynamic policies would, and this is a testing proxy.
    if (key === 'set-cookie' || HOP_BY_HOP.includes(key) || key === 'content-encoding' || key === 'content-length' || key === 'content-security-policy' || key === 'strict-transport-security') return;
    out.set(k, v);
  });
  const secure = url.protocol === 'https:';
  for (const c of up.headers.getSetCookie?.() ?? []) out.append('set-cookie', rewriteSetCookie(c, secure));
  const location = out.get('location');
  if (location) {
    try {
      const loc = new URL(location, opts.upstream);
      if (loc.origin === opts.upstream.origin) out.set('location', loc.pathname + loc.search + loc.hash);
    } catch {
      /* leave it */
    }
  }
  if (up.status === 204 || up.status === 304 || method === 'HEAD') return new Response(null, { status: up.status, headers: out });
  const type = up.headers.get('content-type') ?? '';
  if (!type.includes('text/html')) return new Response(up.body, { status: up.status, headers: out });
  let html = await up.text();
  html = rewriteUpstreamLinks(html, opts.upstream);
  html = injectScript(html, scriptTag({ src: opts.scriptPath, site: opts.site, mode: opts.mode, ...(opts.debug ? { debug: true } : {}) }));
  out.set('cache-control', 'no-store');
  return new Response(html, { status: up.status, headers: out });
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
