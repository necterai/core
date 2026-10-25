import type { Decision, Policy, Verdict } from '@necterai/core';
import type { BeaconPayload, RequestContext, ResolvedServerOptions } from '../types.js';
import { gatewayResponse } from '../actions/index.js';

export interface EndpointDeps {
  options: ResolvedServerOptions;
  policy: Policy;
  ingest(payload: BeaconPayload, meta: { ip?: string; ua?: string }): Promise<{ verdict: Verdict; decision: Decision }>;
  canaryHit(sessionId: string, token: string, kind: 'link' | 'field' | 'instruction' | 'endpoint' | 'other', detail?: Record<string, unknown>): Promise<Verdict | undefined>;
  verdictFor(sessionId: string): Promise<Verdict | undefined>;
  log(...args: unknown[]): void;
}

let bundled: Promise<string | undefined> | undefined;
/** The @necterai/browser <script> build, loaded on first request (a dependency, but kept out of the startup path). */
function bundledScript(): Promise<string | undefined> {
  bundled ??= import('@necterai/browser/script-source').then((m) => (typeof m.default === 'string' ? m.default : undefined), () => undefined);
  return bundled;
}

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };
// 1x1 transparent GIF for canary pixels.
const GIF = Uint8Array.from([71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 0, 0, 0, 255, 255, 255, 33, 249, 4, 1, 0, 0, 0, 0, 44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 68, 1, 0, 59]);

export async function handleEndpointRequest(ctx: RequestContext, deps: EndpointDeps): Promise<Response> {
  const { options } = deps;
  const path = ctx.url.pathname;
  const rel = path.startsWith(options.endpoint) ? path.slice(options.endpoint.length) : path;

  if (path === '/.well-known/agent-access') return gatewayResponse(ctx, options, {});

  if (rel === '/beacon') {
    if (ctx.method === 'OPTIONS') return new Response(null, { status: 204 });
    if (ctx.method !== 'POST') return new Response('method not allowed', { status: 405 });
    let payload: BeaconPayload;
    try {
      const text = await ctx.request.text();
      if (text.length > 512 * 1024) return new Response('payload too large', { status: 413 });
      payload = JSON.parse(text) as BeaconPayload;
    } catch {
      return new Response('bad request', { status: 400 });
    }
    if (!payload || typeof payload.sessionId !== 'string') return new Response('bad request', { status: 400 });
    const ua = ctx.headers.get('user-agent') ?? undefined;
    const result = await deps.ingest(payload, { ...(ctx.ip ? { ip: ctx.ip } : {}), ...(ua ? { ua } : {}) });
    const body = JSON.stringify({ score: result.verdict.score, actorClass: result.verdict.actorClass, provider: result.verdict.provider?.id ?? null, action: result.decision.primary, stage: result.verdict.stage });
    return new Response(body, { status: 200, headers: JSON_HEADERS });
  }

  if (rel.startsWith('/canary/')) {
    const token = rel.slice('/canary/'.length).split('/')[0] ?? '';
    const m = /^([A-Za-z0-9_-]{8,64})\.([A-Za-z0-9_-]{4,64})$/.exec(token);
    if (m) {
      await deps.canaryHit(m[1]!, m[2]!, 'link', { path, ua: ctx.headers.get('user-agent') ?? '' });
    }
    return new Response(GIF, { status: 200, headers: { 'content-type': 'image/gif', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' } });
  }

  if (rel === '/verdict') {
    const v = await deps.verdictFor(ctx.sessionId);
    if (!v) return new Response(JSON.stringify({ error: 'unknown session' }), { status: 404, headers: JSON_HEADERS });
    return new Response(JSON.stringify(v), { status: 200, headers: JSON_HEADERS });
  }

  if (rel === '/policy') {
    return new Response(JSON.stringify({ mode: options.mode, rules: deps.policy.rules.map((r) => ({ id: r.id, when: r.when, actions: r.actions })) }), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' } });
  }

  if (rel === '/script.js') {
    const script = options.scriptContent === false ? undefined : options.scriptContent ?? (await bundledScript());
    if (!script) return new Response('// necter: script not available (scriptContent is false, or @necterai/browser is not installed)', { status: 404, headers: { 'content-type': 'application/javascript' } });
    return new Response(script, { status: 200, headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'public, max-age=300' } });
  }

  if (rel === '/health' || rel === '' || rel === '/') {
    return new Response(JSON.stringify({ ok: true, mode: options.mode }), { status: 200, headers: JSON_HEADERS });
  }
  return new Response('not found', { status: 404 });
}
