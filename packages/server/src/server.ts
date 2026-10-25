import {
  LABEL_HEADERS,
  createEngine,
  createMemorySink,
  createRegistry,
  createSignal,
  decide,
  defaultPolicy,
  randomId,
  SIGNAL_CATALOG,
  type Action,
  type Decision,
  type Engine,
  type EventSink,
  type SessionEvent,
  type Signal,
  type SignalInput,
  type SignalRegistry,
  type Verdict,
} from '@necterai/core';
import type {
  AnalyzerApi,
  BeaconPayload,
  NecterServer,
  ClientAggregate,
  InspectExtras,
  Inspection,
  RequestAnalyzer,
  RequestContext,
  ResolvedServerOptions,
  ServerOptions,
  SessionRecord,
  SessionStore,
} from './types.js';
import { createMemoryStore, newClient, newSession } from './store.js';
import { buildContext, isAssetRequest, sessionCookie } from './request.js';
import { defaultAnalyzers } from './analyzers/index.js';
import { serverSignalDefinitions } from './analyzers/definitions.js';
import { captureTieHeaders, tieSignals } from './analyzers/tie.js';
import { handleEndpointRequest } from './endpoints/index.js';
import { blockResponse, challengeResponse, decoyResponse, redirectResponse } from './actions/index.js';

export function resolveServerOptions(input: ServerOptions): ResolvedServerOptions {
  const mode = input.mode ?? 'monitor';
  const resolved: ResolvedServerOptions = {
    mode,
    endpoint: (input.endpoint ?? '/__necter').replace(/\/$/, ''),
    trustProxy: input.trustProxy ?? false,
    verifyWebBotAuth: input.verifyWebBotAuth ?? true,
    rdns: input.rdns ?? false,
    rdnsTimeoutMs: input.rdnsTimeoutMs ?? 1500,
    webBotAuth: { ...(input.webBotAuth ?? {}) },
    noJsGraceMs: input.noJsGraceMs ?? 8000,
    sessionTtlMs: input.sessionTtlMs ?? 30 * 60 * 1000,
    debug: input.debug ?? false,
    cors: input.cors ?? false,
    policy: input.policy ?? defaultPolicy({ mode }),
    gateway: {
      title: 'Agent access',
      body: 'Automated agents and AI crawlers are not permitted to use this site without an agreement. If you operate an agent, identify it with Web Bot Auth and contact the site owner for access terms.',
      ...(input.gateway ?? {}),
    },
    allowlist: {
      userAgents: input.allowlist?.userAgents ?? [],
      ips: input.allowlist?.ips ?? [],
      sessionTags: input.allowlist?.sessionTags ?? [],
    },
  };
  if (input.scriptContent !== undefined) resolved.scriptContent = input.scriptContent;
  if (input.onNotify) resolved.onNotify = input.onNotify;
  if (input.decoy) resolved.decoy = input.decoy;
  return resolved;
}

export function createNecter(input: ServerOptions = {}): NecterServer {
  const options = resolveServerOptions(input);
  const now = input.now ?? (() => Date.now());
  const registry: SignalRegistry = input.registry ?? createRegistry(SIGNAL_CATALOG);
  // Server-introduced definitions not yet in the core catalog; never override an existing entry.
  for (const def of serverSignalDefinitions) if (!registry.get(def.id)) registry.register(def);
  const engine: Engine = createEngine({ registry, now });
  const sink: EventSink = input.sink ?? createMemorySink();
  const store: SessionStore = input.store ?? createMemoryStore();
  const fetchImpl: typeof fetch = input.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const analyzers: RequestAnalyzer[] = [...(input.analyzers ?? defaultAnalyzers()), ...(input.extraAnalyzers ?? [])];
  const log = (...args: unknown[]) => {
    if (options.debug) console.debug('[necter:server]', ...args);
  };
  let lastSweep = 0;
  const limiter = new Map<string, { tokens: number; at: number }>();

  function emitEvent(partial: Omit<SessionEvent, 'id' | 'ts' | 'source'>): void {
    const event = { id: randomId(), ts: now(), source: 'server', ...partial } as SessionEvent;
    void Promise.resolve(sink.write([event])).catch((err) => log('sink error', err));
  }

  async function loadSession(ctx: Pick<RequestContext, 'sessionId' | 'clientKey' | 'ip' | 'now'> & { ua?: string }): Promise<SessionRecord> {
    let s = await store.get(ctx.sessionId);
    if (!s) {
      s = newSession(ctx.sessionId, ctx.now, ctx.clientKey, ctx.ip, ctx.ua);
      const c = await loadClient(ctx.clientKey, ctx.now);
      c.sessions++;
      await store.saveClient(c);
      emitEvent({ type: 'session', sessionId: s.id, data: { action: 'start', ...(s.ua ? { ua: s.ua } : {}) } });
    }
    s.lastSeenAt = ctx.now;
    if (ctx.ip && !s.ip) s.ip = ctx.ip;
    return s;
  }

  async function loadClient(key: string, ts: number): Promise<ClientAggregate> {
    const c = (await store.client(key)) ?? newClient(key, ts);
    c.lastSeenAt = ts;
    return c;
  }

  function evaluate(session: SessionRecord, stage: Verdict['stage']): Verdict {
    const verdict = engine.evaluate(session.signals.values(), { sessionId: session.id, stage, ts: now() });
    session.verdict = verdict;
    emitEvent({ type: 'verdict', sessionId: session.id, data: { verdict } });
    return verdict;
  }

  function isAllowlisted(ctx: RequestContext, session: SessionRecord): boolean {
    const ua = ctx.headers.get('user-agent') ?? '';
    if (options.allowlist.userAgents.some((s) => s && ua.includes(s))) return true;
    if (ctx.ip && options.allowlist.ips.includes(ctx.ip)) return true;
    if (options.allowlist.sessionTags.some((t) => session.tags.has(t) || ctx.tags.includes(t))) return true;
    return false;
  }

  async function inspect(request: Request, extras?: InspectExtras): Promise<Inspection> {
    const ts = now();
    if (ts - lastSweep > 60_000) {
      lastSweep = ts;
      void Promise.resolve(store.sweep(options.sessionTtlMs, ts)).catch(() => undefined);
    }
    const ctx = buildContext(request, extras, { endpoint: options.endpoint, trustProxy: options.trustProxy, now: ts });
    const ua = ctx.headers.get('user-agent') ?? undefined;
    const session = await loadSession({ ...ctx, ...(ua ? { ua } : {}) });
    const client = await loadClient(ctx.clientKey, ts);
    for (const t of ctx.tags) session.tags.add(t);

    // Bookkeeping that analyzers rely on.
    session.requests++;
    client.requests++;
    // Cookie persistence is only meaningful on navigations (assets and API calls may be fetched
    // without cookies by prefetchers and cross-site contexts).
    if (ctx.isDocument) {
      if (ctx.sessionFromClient) client.cookieReturns++;
      else if (client.sessions > 1) client.cookieMisses++;
    }
    if (isAssetRequest(ctx.url)) client.assets++;
    if (ctx.url.pathname === '/robots.txt') client.robotsTxt++;
    if (/sitemap.*\.xml$/i.test(ctx.url.pathname)) client.sitemap++;
    if (client.paths.length < 200 && !client.paths.includes(ctx.url.pathname)) client.paths.push(ctx.url.pathname);
    // Headers the tie analyzer later compares with what the browser SDK reads from JavaScript.
    if (ctx.isDocument && !ctx.isEndpoint) {
      const tie = captureTieHeaders(ctx.headers);
      if (Object.keys(tie).length) session.lastDocumentHeaders = tie;
    }

    const signals: Signal[] = [];
    const api: AnalyzerApi = {
      emit(sig: SignalInput) {
        const s = createSignal(sig, registry, { source: 'server', now });
        session.signals.set(s.id, s);
        signals.push(s);
        return s;
      },
      client,
      session,
      fetch: fetchImpl,
      log,
      options,
    };
    if (!ctx.isEndpoint) {
      for (const analyzer of analyzers) {
        try {
          await analyzer.analyze(ctx, api);
        } catch (err) {
          log('analyzer failed', analyzer.name, err);
          emitEvent({ type: 'error', sessionId: session.id, data: { message: String(err), where: `analyzer:${analyzer.name}` } });
        }
      }
    }
    if (signals.length) emitEvent({ type: 'signal', sessionId: session.id, url: ctx.url.pathname, data: { signals } });
    emitEvent({
      type: 'request',
      sessionId: session.id,
      url: ctx.url.pathname,
      data: { method: ctx.method, path: ctx.url.pathname, ...(ctx.ip ? { ip: ctx.ip } : {}), ...(ua ? { ua } : {}) },
    });

    const stage: Verdict['stage'] = session.beacons > 0 ? (session.clientVerdict?.stage ?? 'load') : 'request';
    const verdict = evaluate(session, stage);
    let decision: Decision = decide(verdict, options.policy, { path: ctx.url.pathname, method: ctx.method, tags: [...session.tags, ...ctx.tags] });
    if (isAllowlisted(ctx, session)) decision = { actions: [{ kind: 'allow' }, { kind: 'label', params: { allowlisted: true } }], matchedRules: ['allowlist'], primary: 'allow', mode: decision.mode };
    emitEvent({ type: 'decision', sessionId: session.id, url: ctx.url.pathname, data: { decision, verdictTs: verdict.ts, path: ctx.url.pathname } });
    await store.save(session);
    await store.saveClient(client);

    const responseHeaders: Record<string, string> = {};
    if (!ctx.sessionFromClient) responseHeaders['set-cookie'] = sessionCookie(session.id, ctx.url.protocol === 'https:');
    if (decision.actions.some((a) => a.kind === 'label') || options.debug) {
      responseHeaders[LABEL_HEADERS.score] = String(verdict.score);
      responseHeaders[LABEL_HEADERS.actorClass] = verdict.actorClass;
      responseHeaders[LABEL_HEADERS.action] = decision.primary;
      if (verdict.provider) responseHeaders[LABEL_HEADERS.provider] = verdict.provider.id;
    }
    const inspection: Inspection = { ctx, session, verdict, decision, signals, responseHeaders, handled: false };

    if (!ctx.isEndpoint && decision.mode === 'enforce') {
      for (const action of decision.actions) {
        const res = await applyAction(action, inspection);
        if (res) {
          inspection.response = res;
          inspection.handled = true;
          break;
        }
      }
    }
    // Only pages we actually let through can run the SDK, so only those count as "documents served"
    // for the no-JS tie. Blocked / redirected / challenged responses must not poison the aggregate.
    if (!ctx.isEndpoint && ctx.isDocument && !inspection.handled) {
      session.documentsServed++;
      client.documents++;
      session.lastDocumentAt = ts;
      await store.save(session);
      await store.saveClient(client);
    }
    return inspection;
  }

  async function applyAction(action: Action, inspection: Inspection): Promise<Response | undefined> {
    const { ctx, verdict, decision, session } = inspection;
    const record = (ok: boolean, detail?: string) =>
      emitEvent({ type: 'intervention', sessionId: session.id, url: ctx.url.pathname, data: { kind: action.kind, ok, ...(action.params ? { params: action.params } : {}), ...(detail ? { detail } : {}) } });
    switch (action.kind) {
      case 'block': {
        record(true);
        return blockResponse(ctx, verdict, options, inspection.responseHeaders);
      }
      case 'redirect': {
        record(true);
        return redirectResponse(ctx, action, options, inspection.responseHeaders);
      }
      case 'challenge': {
        // Only documents can host the interstitial; API calls under challenge get a 403 JSON.
        if (session.challenge?.passedAt) return undefined;
        session.challenge = { issuedAt: now(), attempts: (session.challenge?.attempts ?? 0) + 1 };
        await store.save(session);
        record(true);
        return challengeResponse(ctx, verdict, options, inspection.responseHeaders);
      }
      case 'decoy': {
        if (!ctx.isDocument) return undefined;
        record(true);
        return decoyResponse(ctx, verdict, options, inspection.responseHeaders);
      }
      case 'notify': {
        try {
          await options.onNotify?.({ verdict, decision, path: ctx.url.pathname, ...(ctx.ip ? { ip: ctx.ip } : {}) });
          record(true);
        } catch (err) {
          record(false, String(err));
        }
        return undefined;
      }
      case 'limit': {
        const perMinute = Number(action.params?.['perMinute'] ?? 60);
        const key = session.id;
        const bucket = limiter.get(key) ?? { tokens: perMinute, at: now() };
        const elapsed = (now() - bucket.at) / 60_000;
        bucket.tokens = Math.min(perMinute, bucket.tokens + elapsed * perMinute);
        bucket.at = now();
        if (bucket.tokens < 1) {
          limiter.set(key, bucket);
          record(true, 'rate-limited');
          return new Response('Too Many Requests', { status: 429, headers: { 'retry-after': '60', ...inspection.responseHeaders } });
        }
        bucket.tokens -= 1;
        limiter.set(key, bucket);
        return undefined;
      }
      default:
        return undefined;
    }
  }

  async function respond(inspection: Inspection, next: () => Promise<Response>): Promise<Response> {
    if (inspection.response) return inspection.response;
    const { decision } = inspection;
    if (decision.mode === 'enforce') {
      const tarpit = decision.actions.find((a) => a.kind === 'tarpit');
      if (tarpit) {
        const delay = Number(tarpit.params?.['delayMs'] ?? 3000);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    const res = await next();
    return withHeaders(res, inspection.responseHeaders);
  }

  async function handleEndpoint(request: Request, extras?: InspectExtras): Promise<Response | undefined> {
    const ts = now();
    const ctx = buildContext(request, extras, { endpoint: options.endpoint, trustProxy: options.trustProxy, now: ts });
    if (!ctx.isEndpoint) return undefined;
    const cors = corsHeaders(ctx.headers, options.cors);
    if (cors && ctx.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (options.cors && !cors && ctx.method === 'POST') return new Response('origin not allowed', { status: 403 });
    const res = await handleEndpointRequest(ctx, {
      options,
      ingest,
      canaryHit,
      verdictFor,
      policy: options.policy,
      log,
    });
    return cors ? withHeaders(res, cors) : res;
  }

  async function handle(request: Request, next: () => Promise<Response>, extras?: InspectExtras): Promise<Response> {
    const endpointResponse = await handleEndpoint(request, extras);
    if (endpointResponse) return endpointResponse;
    const inspection = await inspect(request, extras);
    return respond(inspection, next);
  }

  async function ingest(payload: BeaconPayload, meta: { ip?: string; ua?: string }): Promise<{ verdict: Verdict; decision: Decision }> {
    const ts = now();
    const sessionId = /^[A-Za-z0-9_-]{8,64}$/.test(payload.sessionId) ? payload.sessionId : randomId();
    const session = await loadSession({ sessionId, clientKey: 'beacon', ip: meta.ip, now: ts, ...(meta.ua ? { ua: meta.ua } : {}) } as Parameters<typeof loadSession>[0]);
    session.beacons++;
    session.lastBeaconAt = ts;
    if (session.clientKey !== 'beacon') {
      const client = await loadClient(session.clientKey, ts);
      client.beacons++;
      await store.saveClient(client);
    }
    const events = Array.isArray(payload.events) ? payload.events.slice(0, 500) : [];
    const forwarded: SessionEvent[] = [];
    for (const raw of events) {
      if (!raw || typeof raw !== 'object' || typeof (raw as SessionEvent).type !== 'string') continue;
      const ev = { ...(raw as SessionEvent), sessionId: session.id, source: 'client' as const };
      forwarded.push(ev);
      if (ev.type === 'signal' && Array.isArray(ev.data?.signals)) {
        for (const s of ev.data.signals.slice(0, 200)) {
          if (!s || typeof s.id !== 'string' || typeof s.summary !== 'string') continue;
          const def = registry.get(s.id);
          // Client-reported signals are evidence, not gospel: unknown ids get a floor weight and
          // weights above the registry default are clamped to it.
          const clean = createSignal(
            {
              id: s.id,
              summary: String(s.summary).slice(0, 300),
              layer: def?.layer ?? s.layer,
              strength: def?.strength ?? 'weak',
              ...(s.value !== undefined ? { value: s.value } : {}),
              ...(s.details ? { details: s.details } : {}),
              ...(s.provider ? { provider: s.provider } : {}),
              ...(s.reliability !== undefined ? { reliability: s.reliability } : {}),
              ...(s.ts ? { ts: s.ts } : {}),
            },
            registry,
            { source: 'client', now },
          );
          if (def && s.automation !== undefined) clean.automation = Math.sign(def.automation) * Math.min(Math.abs(def.automation), Math.abs(s.automation));
          if (!def) clean.automation = Math.min(0.6, Math.abs(s.automation ?? 0.6)) * Math.sign(s.automation ?? 1);
          session.signals.set(clean.id, clean);
        }
      } else if (ev.type === 'session' && ev.data && typeof ev.data.hints === 'object' && ev.data.hints !== null) {
        // Tie check C11: JS-reported hints vs the headers of this session's last document request.
        const hints = ev.data.hints;
        session.lastClientHints = hints;
        if (session.lastDocumentHeaders) {
          for (const input of tieSignals(session.lastDocumentHeaders, hints, session.ua)) {
            session.signals.set(input.id, createSignal(input, registry, { source: 'server', now }));
          }
        }
      } else if (ev.type === 'verdict' && ev.data?.verdict) {
        session.clientVerdict = ev.data.verdict;
      } else if (ev.type === 'challenge' && ev.data) {
        const outcome = ev.data.outcome;
        session.challenge = session.challenge ?? { issuedAt: ts, attempts: 0 };
        if (outcome === 'passed') {
          session.challenge.passedAt = ts;
          session.signals.set('challenge.passed', createSignal({ id: 'challenge.passed', summary: 'Kinematic challenge passed', details: ev.data.detail ?? {} }, registry, { source: 'client', now }));
          session.signals.delete('challenge.failed');
        } else if (outcome === 'failed') {
          session.challenge.failedAt = ts;
          session.signals.set('challenge.failed', createSignal({ id: 'challenge.failed', summary: 'Kinematic challenge failed', details: ev.data.detail ?? {} }, registry, { source: 'client', now }));
        }
      } else if (ev.type === 'canary' && ev.data) {
        const detail = (ev.data.detail ?? {}) as Record<string, unknown>;
        // "issued" just records that canaries were planted; it is not a hit.
        if (detail.phase !== 'issued') {
          session.canaryHits.push(ev.data.token);
          // The client already sent the scored signal (with its own reliability); only fill in if it is missing.
          const fallback = ev.data.kind === 'field' ? 'canary.hidden-field-filled' : ev.data.kind === 'instruction' ? 'canary.instruction-followed' : ev.data.kind === 'text-selection' ? 'canary.hidden-text-selected' : 'canary.hidden-link-followed';
          const id = typeof detail.signal === 'string' && registry.get(detail.signal) ? detail.signal : fallback;
          if (!session.signals.has(id)) session.signals.set(id, createSignal({ id, summary: `Canary ${ev.data.kind} (${ev.data.token})`, details: detail }, registry, { source: 'client', now }));
        }
      }
    }
    if (forwarded.length) void Promise.resolve(sink.write(forwarded)).catch((err) => log('sink error', err));
    const stage = session.clientVerdict?.stage ?? 'load';
    const verdict = evaluate(session, stage);
    const decision = decide(verdict, options.policy, { tags: [...session.tags] });
    await store.save(session);
    return { verdict, decision };
  }

  async function canaryHit(sessionId: string, token: string, kind: 'link' | 'field' | 'instruction' | 'endpoint' | 'other', detail: Record<string, unknown> = {}): Promise<Verdict | undefined> {
    const session = await store.get(sessionId);
    if (!session) return undefined;
    session.canaryHits.push(token);
    const id = kind === 'field' ? 'canary.hidden-field-filled' : kind === 'instruction' ? 'canary.instruction-followed' : 'canary.hidden-link-followed';
    session.signals.set(id, createSignal({ id, summary: `Canary ${kind} hit (${token})`, details: { token, ...detail } }, registry, { source: 'server', now }));
    emitEvent({ type: 'canary', sessionId, data: { token, kind, detail } });
    const verdict = evaluate(session, 'final');
    await store.save(session);
    return verdict;
  }

  async function verdictFor(sessionId: string): Promise<Verdict | undefined> {
    const s = await store.get(sessionId);
    return s?.verdict;
  }

  return { options, engine, registry, sink, store, inspect, handleEndpoint, respond, handle, ingest, canaryHit, verdictFor, applyAction };
}

/**
 * CORS headers for a cross-origin SDK request, or undefined when CORS is off or the
 * origin is not allowed. Requests without an Origin (script tags, canary pixels, curl) pass.
 */
export function corsHeaders(headers: Headers, cors: boolean | string[]): Record<string, string> | undefined {
  if (!cors) return undefined;
  const origin = headers.get('origin');
  if (origin && Array.isArray(cors) && !cors.includes(origin)) return undefined;
  const h: Record<string, string> = {
    'access-control-allow-origin': origin ?? '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-necter-session',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
  // Chrome Private Network Access: lets a public site talk to a collector on localhost while testing.
  if (headers.get('access-control-request-private-network') === 'true') h['access-control-allow-private-network'] = 'true';
  return h;
}

export function withHeaders(res: Response, headers: Record<string, string>): Response {
  const keys = Object.keys(headers);
  if (!keys.length) return res;
  const out = new Response(res.body, res);
  for (const k of keys) {
    if (k.toLowerCase() === 'set-cookie') out.headers.append(k, headers[k]!);
    else out.headers.set(k, headers[k]!);
  }
  return out;
}
