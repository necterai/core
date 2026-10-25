import { DEFAULT_ENDPOINT_PREFIX, SESSION_COOKIE, SESSION_HEADER, fnv1a53, randomId } from '@necterai/core';
import type { InspectExtras, RequestContext } from './types.js';

const ASSET_RE = /\.(?:css|js|mjs|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|json|xml|txt|pdf|wasm)$/i;

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

export function clientIp(headers: Headers, extras: InspectExtras | undefined, trustProxy: boolean): string | undefined {
  if (!trustProxy) return extras?.ip;
  const cf = headers.get('cf-connecting-ip');
  if (cf) return cf.trim();
  const real = headers.get('x-real-ip');
  if (real) return real.trim();
  const xff = headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  return extras?.ip;
}

export function isDocumentRequest(headers: Headers, url: URL): boolean {
  const dest = headers.get('sec-fetch-dest');
  if (dest) return dest === 'document' || dest === 'iframe';
  const accept = headers.get('accept') ?? '';
  if (accept.includes('text/html') || accept.includes('application/xhtml+xml')) return true;
  // No Accept at all: HTTP libraries fetching pages. Treat non-asset paths as documents.
  if (!accept || accept === '*/*') return !ASSET_RE.test(url.pathname);
  return false;
}

export function isAssetRequest(url: URL): boolean {
  return ASSET_RE.test(url.pathname);
}

export function buildContext(request: Request, extras: InspectExtras | undefined, opts: { endpoint: string; trustProxy: boolean; now: number }): RequestContext {
  const url = new URL(request.url);
  const headers = request.headers;
  const ip = clientIp(headers, extras, opts.trustProxy);
  const ua = headers.get('user-agent') ?? '';
  const cookies = parseCookies(headers.get('cookie'));
  const fromHeader = headers.get(SESSION_HEADER);
  const fromCookie = cookies[SESSION_COOKIE];
  const sessionFromClient = Boolean(fromHeader || fromCookie);
  const sessionId = sanitizeId(fromHeader ?? fromCookie) ?? randomId();
  const endpoint = opts.endpoint || DEFAULT_ENDPOINT_PREFIX;
  const ctx: RequestContext = {
    request,
    url,
    method: request.method.toUpperCase(),
    headers,
    sessionId,
    sessionFromClient,
    clientKey: fnv1a53(`${ip ?? 'noip'}|${ua}`),
    isDocument: isDocumentRequest(headers, url),
    isEndpoint: url.pathname === endpoint || url.pathname.startsWith(endpoint + '/') || url.pathname === '/.well-known/agent-access',
    now: opts.now,
    tags: extras?.tags ? [...extras.tags] : [],
  };
  if (extras?.headerOrder) ctx.headerOrder = extras.headerOrder;
  if (ip) ctx.ip = ip;
  if (extras?.tls) ctx.tls = extras.tls;
  if (typeof extras?.asn === 'number' && Number.isFinite(extras.asn)) ctx.asn = extras.asn;
  return ctx;
}

function sanitizeId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const clean = id.trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(clean) ? clean : undefined;
}

export function sessionCookie(id: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(id)}; Path=/; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax; HttpOnly=false${secure ? '; Secure' : ''}`.replace('; HttpOnly=false', '');
}
