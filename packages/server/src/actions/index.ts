import type { Action, Verdict } from '@necterai/core';
import type { RequestContext, ResolvedServerOptions } from '../types.js';
import { withHeaders } from '../server.js';

function wantsHtml(ctx: RequestContext): boolean {
  const accept = ctx.headers.get('accept') ?? '';
  return ctx.isDocument || accept.includes('text/html');
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function page(title: string, body: string, extraHead = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)}</title>${extraHead}<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f172a;color:#f8fafc;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}main{max-width:560px}h1{font-size:24px;margin:0 0 12px}p{line-height:1.55;opacity:.92}a{color:#93c5fd}code{background:#1e293b;padding:2px 6px;border-radius:4px}</style></head><body><main>${body}</main></body></html>`;
}

export function blockResponse(ctx: RequestContext, verdict: Verdict, options: ResolvedServerOptions, headers: Record<string, string>): Response {
  const reason = verdict.actorClass;
  if (wantsHtml(ctx)) {
    const html = page(
      'Automated access not permitted',
      `<h1>Automated access is not permitted</h1><p>This site does not allow AI agents or automated clients. Classified as <code>${escapeHtml(reason)}</code>${verdict.provider ? ` (${escapeHtml(verdict.provider.id)})` : ''}.</p><p>If you are a person seeing this by mistake, reload the page. Agent operators: see <a href="/.well-known/agent-access">agent access terms</a>.</p>`,
    );
    return withHeaders(new Response(html, { status: 403, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }), headers);
  }
  return withHeaders(
    new Response(JSON.stringify({ error: 'forbidden', reason, provider: verdict.provider?.id ?? null, agentAccess: '/.well-known/agent-access' }), {
      status: 403,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    }),
    headers,
  );
}

export function redirectResponse(ctx: RequestContext, action: Action, options: ResolvedServerOptions, headers: Record<string, string>): Response {
  const to = String(action.params?.['to'] ?? '/.well-known/agent-access');
  const status = Number(action.params?.['status'] ?? 402);
  if (ctx.url.pathname === to) return gatewayResponse(ctx, options, headers);
  if (status === 402) {
    // HTTP 402 with a Link to the terms: machine-readable for agents, readable for people.
    const body = wantsHtml(ctx)
      ? page(options.gateway.title, `<h1>${escapeHtml(options.gateway.title)}</h1><p>${escapeHtml(options.gateway.body)}</p><p><a href="${escapeHtml(to)}">Access terms</a></p>`)
      : JSON.stringify({ error: 'payment_required', message: options.gateway.body, terms: to });
    return withHeaders(
      new Response(body, { status: 402, headers: { 'content-type': wantsHtml(ctx) ? 'text/html; charset=utf-8' : 'application/json', link: `<${to}>; rel="terms-of-service"`, 'cache-control': 'no-store' } }),
      headers,
    );
  }
  return withHeaders(new Response(null, { status: status >= 300 && status < 400 ? status : 302, headers: { location: to, 'cache-control': 'no-store' } }), headers);
}

export function gatewayResponse(ctx: RequestContext, options: ResolvedServerOptions, headers: Record<string, string>): Response {
  const g = options.gateway;
  if (wantsHtml(ctx)) {
    return withHeaders(
      new Response(page(g.title, `<h1>${escapeHtml(g.title)}</h1><p>${escapeHtml(g.body)}</p>${g.contact ? `<p>Contact: <a href="${escapeHtml(g.contact)}">${escapeHtml(g.contact)}</a></p>` : ''}<p>Agents should identify themselves with <code>Signature-Agent</code> (Web Bot Auth) so access decisions can be made per operator.</p>`), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' },
      }),
      headers,
    );
  }
  return withHeaders(
    new Response(JSON.stringify({ title: g.title, policy: g.body, contact: g.contact ?? null, identify: 'web-bot-auth', directory: 'https://datatracker.ietf.org/doc/draft-meunier-web-bot-auth-architecture/' }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
    }),
    headers,
  );
}

export function challengeResponse(ctx: RequestContext, verdict: Verdict, options: ResolvedServerOptions, headers: Record<string, string>): Response {
  if (!wantsHtml(ctx)) {
    return withHeaders(new Response(JSON.stringify({ error: 'challenge_required', reason: verdict.actorClass }), { status: 403, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }), headers);
  }
  // Interstitial: loads the SDK in enforce mode, forces the challenge, reloads on success.
  const script = `${options.endpoint}/script.js`;
  const html = page(
    'Quick check',
    `<h1>Quick check</h1><p>Please complete the check to continue to <code>${escapeHtml(ctx.url.pathname)}</code>.</p><noscript><p>JavaScript is required.</p></noscript>`,
    `<script src="${script}" data-necter data-mode="enforce" data-endpoint="${options.endpoint}"></script><script>document.addEventListener('DOMContentLoaded',function(){var c=window.necter;if(!c){return;}c.challenge().then(function(ok){if(ok){c.flush().then(function(){location.reload();});}});});</script>`,
  );
  return withHeaders(new Response(html, { status: 403, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }), headers);
}

export async function decoyResponse(ctx: RequestContext, verdict: Verdict, options: ResolvedServerOptions, headers: Record<string, string>): Promise<Response> {
  const html = options.decoy ? await options.decoy(ctx, verdict) : defaultDecoy(ctx);
  return withHeaders(new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, noai, noimageai' } }), headers);
}

/** Plausible-looking filler that is useless as data. Deterministic per path so repeated fetches agree. */
export function defaultDecoy(ctx: RequestContext): string {
  const seed = [...ctx.url.pathname].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const words = ['catalogue', 'seasonal', 'overview', 'reference', 'summary', 'index', 'archive', 'bulletin', 'notice', 'guide', 'glossary', 'appendix'];
  const paras = Array.from({ length: 5 }, (_, i) =>
    `<p>${Array.from({ length: 40 }, (_, j) => words[(seed + i * 7 + j * 13) % words.length]).join(' ')}.</p>`,
  ).join('');
  const links = Array.from({ length: 12 }, (_, i) => `<li><a href="${ctx.url.pathname.replace(/\/$/, '')}/${words[(seed + i) % words.length]}-${(seed + i * 97) % 1000}">${words[(seed + i * 3) % words.length]} ${(seed + i) % 100}</a></li>`).join('');
  return page('Overview', `<h1>Overview</h1>${paras}<ul>${links}</ul>`);
}
