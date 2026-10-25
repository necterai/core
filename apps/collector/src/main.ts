import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createNecter } from '@necterai/server';
import { sendWebResponse, toWebRequest } from '@necterai/server/adapters/node';
import { createSessionIndex, summarize, type SessionIndex } from './store.js';
import { proxyRequest } from './proxy.js';
import { dashboardAsset, dashboardPage } from './dashboard.js';
import { testPage } from './test-page.js';

const here = dirname(fileURLToPath(import.meta.url));

export interface CollectorConfig {
  port: number;
  host: string;
  mode: 'monitor' | 'enforce';
  upstream?: URL;
  site: string;
  dataDir?: string;
  debug: boolean;
  origins?: string[];
  token?: string;
  trustProxy: boolean;
}

export function parseConfig(argv: string[], env: NodeJS.ProcessEnv): CollectorConfig {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const [k, inline] = a.slice(2).split('=', 2) as [string, string | undefined];
    const next = argv[i + 1];
    if (inline !== undefined) flags.set(k, inline);
    else if (next !== undefined && !next.startsWith('--')) flags.set(k, argv[++i]!);
    else flags.set(k, 'true');
  }
  const get = (flag: string, envKey: string) => flags.get(flag) ?? env[envKey];
  if (flags.has('help')) {
    console.log(USAGE);
    process.exit(0);
  }
  const upstreamRaw = get('upstream', 'UPSTREAM');
  let upstream: URL | undefined;
  if (upstreamRaw) {
    try {
      upstream = new URL(/^https?:\/\//.test(upstreamRaw) ? upstreamRaw : `https://${upstreamRaw}`);
    } catch {
      throw new Error(`--upstream is not a URL: ${upstreamRaw}`);
    }
  }
  const mode = get('mode', 'NECTER_MODE') === 'enforce' ? 'enforce' : 'monitor';
  const dataDir = get('data', 'DATA_DIR');
  const origins = get('origins', 'ALLOWED_ORIGINS');
  const token = get('token', 'DASHBOARD_TOKEN');
  const cfg: CollectorConfig = {
    port: Number(get('port', 'PORT') ?? 8788),
    host: get('host', 'HOST') ?? '127.0.0.1',
    mode,
    site: get('site', 'SITE') ?? (upstream ? upstream.host : 'default'),
    debug: ['1', 'true'].includes(get('debug', 'NECTER_DEBUG') ?? ''),
    trustProxy: !['0', 'false'].includes(get('trust-proxy', 'TRUST_PROXY') ?? 'true'),
  };
  if (upstream) cfg.upstream = upstream;
  if (dataDir !== 'none') cfg.dataDir = dataDir ?? join(here, '../data');
  if (origins) cfg.origins = origins.split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
  if (token) cfg.token = token;
  return cfg;
}

const USAGE = `necter collector

  pnpm collector [options]

  Hosted mode (default): serves the script tag for any site and a live dashboard.
  Proxy mode (--upstream): sits in front of an existing site and adds detection to every page.

  --upstream URL     proxy this site (e.g. https://example.com)
  --site NAME        site name shown in the dashboard (proxy mode: the upstream host)
  --mode monitor|enforce   monitor only records; enforce also blocks/challenges (default monitor)
  --port 8788        --host 127.0.0.1 (use 0.0.0.0 in a container)
  --origins a,b      only accept beacons from these page origins (default: any)
  --token SECRET     require ?token=SECRET to open the dashboard
  --data DIR         where events are kept (default apps/collector/data; "none" keeps memory only)
  --debug            show the on-page debug panel and server debug logs

  Every flag has an env equivalent: UPSTREAM SITE NECTER_MODE PORT HOST ALLOWED_ORIGINS DASHBOARD_TOKEN DATA_DIR NECTER_DEBUG`;

export function loadScript(): string {
  const p = join(here, '../../../packages/browser/dist/necter.iife.js');
  if (!existsSync(p)) throw new Error('The browser SDK is not built. Run `corepack pnpm build` first.');
  return readFileSync(p, 'utf8');
}

export function createCollector(cfg: CollectorConfig, scriptContent: string, index: SessionIndex = createSessionIndex(cfg.dataDir ? { dataDir: cfg.dataDir } : {})) {
  const cm = createNecter({
    mode: cfg.mode,
    cors: cfg.origins?.length ? cfg.origins : true,
    trustProxy: cfg.trustProxy,
    debug: cfg.debug,
    scriptContent,
    sink: index.sink,
    gateway: {
      title: 'Agent access',
      body: 'This site does not allow AI agents or automated access without an agreement. Identify your agent with Web Bot Auth and contact the site owner.',
    },
  });

  function authorized(req: IncomingMessage, url: URL): 'ok' | 'denied' | 'set' {
    if (!cfg.token) return 'ok';
    if (url.searchParams.get('token') === cfg.token) return 'set';
    const cookie = req.headers.cookie ?? '';
    return cookie.split(/;\s*/).includes(`necter_dash=${encodeURIComponent(cfg.token)}`) ? 'ok' : 'denied';
  }

  function send(res: ServerResponse, status: number, body: string, type: string, extra: Record<string, string> = {}): void {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra });
    res.end(body);
  }
  const json = (res: ServerResponse, body: unknown, status = 200) => send(res, status, JSON.stringify(body), 'application/json');

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const rest = url.pathname.slice('/__necter/api'.length);
    if (rest === '/overview') {
      return json(res, { mode: cfg.mode, upstream: cfg.upstream?.origin ?? null, site: cfg.site, sites: index.sites(), sessions: index.size(), restricted: Boolean(cfg.origins?.length) });
    }
    if (rest === '/sessions') {
      const site = url.searchParams.get('site') ?? undefined;
      return json(res, index.list({ ...(site ? { site } : {}), agentsOnly: url.searchParams.get('agents') === '1', limit: Number(url.searchParams.get('limit') ?? 300) }));
    }
    const m = /^\/sessions\/([A-Za-z0-9_-]{4,64})$/.exec(rest);
    if (m) {
      const row = index.get(m[1]!);
      if (!row) return json(res, { error: 'unknown session' }, 404);
      return json(res, {
        summary: summarize(row),
        verdict: row.verdict ?? null,
        clientVerdict: row.clientVerdict ?? null,
        pages: row.pages,
        interventions: row.interventions,
        events: row.events.slice(-400).map((e) => ({ type: e.type, source: e.source, ts: e.ts, url: e.url, data: compact(e) })),
      });
    }
    if (rest === '/reset' && req.method === 'POST') {
      index.clear();
      return json(res, { ok: true });
    }
    return json(res, { error: 'not found' }, 404);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://collector.local');
    const path = url.pathname;

    if (path === '/__necter/ui' || path.startsWith('/__necter/ui/') || path.startsWith('/__necter/api/')) {
      const auth = authorized(req, url);
      if (auth === 'denied') return send(res, 401, 'Add ?token=… to the URL to open the dashboard.', 'text/plain; charset=utf-8');
      if (auth === 'set') {
        url.searchParams.delete('token');
        return send(res, 302, '', 'text/plain', { location: url.pathname + url.search, 'set-cookie': `necter_dash=${encodeURIComponent(cfg.token!)}; Path=/__necter; HttpOnly; SameSite=Lax; Max-Age=2592000` });
      }
      if (path.startsWith('/__necter/api/')) return api(req, res, url);
      if (path === '/__necter/ui') return send(res, 301, '', 'text/plain', { location: '/__necter/ui/' });
      const asset = path !== '/__necter/ui/' ? dashboardAsset(path.slice('/__necter/ui/'.length)) : undefined;
      if (asset) return send(res, 200, asset.body, asset.type);
      if (path !== '/__necter/ui/') return send(res, 404, 'not found', 'text/plain');
      return send(res, 200, dashboardPage({ mode: cfg.mode, upstream: cfg.upstream?.origin, site: cfg.site }), 'text/html; charset=utf-8');
    }

    const proto = cfg.trustProxy ? String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim() || undefined : undefined;
    const { request, extras } = toWebRequest(req, proto ? { protocol: proto } : {});

    if (path.startsWith('/__necter') || path === '/.well-known/agent-access') {
      if (path === '/__necter/beacon' && req.method === 'POST') await noteSite(request, extras.ip);
      const r = (await cm.handleEndpoint(request, extras)) ?? new Response('not found', { status: 404 });
      if (path === '/__necter/script.js' && r.ok) return sendScript(req, res, r);
      return sendWebResponse(res, r);
    }

    if (!cfg.upstream) {
      if (path === '/') return send(res, 302, '', 'text/plain', { location: '/__necter/ui/' });
      if (path === '/test' || path.startsWith('/test/')) {
        // The test shop sits behind the server SDK too, so agents that never run JavaScript show up.
        const inspection = await cm.inspect(request, extras);
        index.setSite(inspection.session.id, 'test-page', undefined, inspection.ctx.ip);
        const html = testPage({ page: path.slice('/test'.length) || '/', mode: cfg.mode, debug: url.searchParams.has('debug') || cfg.debug });
        const response = await cm.respond(inspection, async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }));
        return sendWebResponse(res, response);
      }
      if (path === '/favicon.ico') return send(res, 204, '', 'image/x-icon');
      return send(res, 404, 'not found', 'text/plain');
    }

    // Proxy mode: the full server SDK in front of the upstream.
    const inspection = await cm.inspect(request, extras);
    index.setSite(inspection.session.id, cfg.site, undefined, inspection.ctx.ip);
    const response = await proxyRequest(cm, request, inspection, { upstream: cfg.upstream, site: cfg.site, mode: cfg.mode, debug: cfg.debug, scriptPath: '/__necter/script.js' });
    return sendWebResponse(res, response);
  }

  /** Remember which site and page origin a session belongs to (read from a copy of the beacon). */
  async function noteSite(request: Request, ip?: string): Promise<void> {
    try {
      const text = await request.clone().text();
      const body = JSON.parse(text) as { sessionId?: string; siteKey?: string };
      if (typeof body.sessionId !== 'string') return;
      const origin = request.headers.get('origin') ?? originOf(request.headers.get('referer'));
      const site = (typeof body.siteKey === 'string' && body.siteKey.slice(0, 64)) || (origin ? new URL(origin).host : cfg.site);
      index.setSite(body.sessionId, site, origin ?? undefined, ip);
    } catch {
      /* the endpoint will reject it */
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[collector]', err);
      if (!res.headersSent) send(res, 500, 'internal error', 'text/plain');
      else res.end();
    });
  });
  return { server, cm, index };
}

let gzCache: { src: string; gz: Buffer } | undefined;

/** The SDK is ~210 KB raw and ~70 KB gzipped; compress it when the browser accepts gzip. */
async function sendScript(req: IncomingMessage, res: ServerResponse, r: Response): Promise<void> {
  const body = await r.text();
  const headers: Record<string, string> = { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*', vary: 'Accept-Encoding' };
  if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
    if (!gzCache || gzCache.src !== body) gzCache = { src: body, gz: gzipSync(body, { level: 9 }) };
    res.writeHead(200, { ...headers, 'content-encoding': 'gzip', 'content-length': String(gzCache.gz.length) });
    res.end(gzCache.gz);
    return;
  }
  res.writeHead(200, headers);
  res.end(body);
}

function originOf(url: string | null): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** Keep the dashboard payload small: drop bulky fields the timeline never shows. */
function compact(e: import('@necterai/core').SessionEvent): unknown {
  if (e.type === 'verdict') {
    const v = e.data.verdict;
    return { score: v.score, actorClass: v.actorClass, stage: v.stage, provider: v.provider?.id, signalCount: v.signalCount };
  }
  if (e.type === 'signal') return { signals: e.data.signals.map((s) => ({ id: s.id, summary: s.summary, layer: s.layer })) };
  if (e.type === 'session') return { action: e.data.action, firstVisit: e.data.firstVisit, ua: e.data.ua };
  return e.data;
}

async function main(): Promise<void> {
  const cfg = parseConfig(process.argv.slice(2), process.env);
  const { server, index } = createCollector(cfg, loadScript());
  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(err.code === 'EADDRINUSE' ? `Port ${cfg.port} is already in use. Stop the other process or pass --port <number>.` : String(err));
    process.exit(1);
  });
  server.listen(cfg.port, cfg.host, () => {
    const local = `http://${cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host}:${cfg.port}`;
    const lines = [
      '',
      `  necter collector · ${cfg.mode} mode${cfg.mode === 'monitor' ? ' (records only, never blocks)' : ' (blocks and challenges agents)'}`,
      '',
      `  Dashboard   ${local}/__necter/ui/${cfg.token ? '?token=' + cfg.token : ''}`,
    ];
    if (cfg.upstream) {
      lines.push(`  Protecting  ${cfg.upstream.origin}  →  open ${local}/`);
    } else {
      lines.push(`  Test page   ${local}/test`);
      lines.push(`  Install     <script async src="${local}/__necter/script.js?site=my-site"></script>`);
    }
    lines.push('', `  Need a public https URL for real agents? Run \`ngrok http ${cfg.port}\` and use that address instead of ${local}.`);
    if (index.size()) lines.push(`  Loaded ${index.size()} sessions from ${cfg.dataDir}.`);
    console.log(lines.join('\n') + '\n');
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  });
}
