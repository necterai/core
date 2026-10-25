import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { NecterServer, InspectExtras } from '../types.js';

/**
 * Build a WHATWG Request from a Node IncomingMessage, preserving raw header order for forensics.
 * `body: false` leaves the request body unread, so the app's own body parser still gets it.
 */
export function toWebRequest(req: IncomingMessage, opts: { protocol?: string; host?: string; body?: boolean } = {}): { request: Request; extras: InspectExtras } {
  const protocol = opts.protocol ?? ((req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http');
  const host = opts.host ?? req.headers.host ?? 'localhost';
  const url = `${protocol}://${host}${req.url ?? '/'}`;
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
  const method = (req.method ?? 'GET').toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD' && opts.body !== false;
  const init: RequestInit & { duplex?: 'half' } = { method, headers };
  if (hasBody) {
    init.body = Readable.toWeb(req) as unknown as ReadableStream;
    init.duplex = 'half';
  }
  const headerOrder: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) headerOrder.push(req.rawHeaders[i]!);
  const extras: InspectExtras = { headerOrder };
  const ip = req.socket.remoteAddress;
  if (ip) extras.ip = ip.replace(/^::ffff:/, '');
  return { request: new Request(url, init), extras };
}

/**
 * Only the SDK's own endpoints (beacons, canaries) read a request body. Everything else is inspected from its
 * headers, so its body stays untouched for the app (reading it here would stall Express/Fastify body parsers).
 */
export function isEndpointPath(server: NecterServer, url: string | undefined): boolean {
  const path = (url ?? '/').split('?')[0]!;
  const prefix = server.options.endpoint;
  return path === prefix || path.startsWith(prefix + '/');
}

export async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  const setCookies = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') return;
    res.setHeader(key, value);
  });
  if (setCookies.length) res.setHeader('set-cookie', setCookies);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}

/**
 * Node http handler wrapper: SDK endpoints are answered directly, everything
 * else is inspected and then delegated to `next` (your app) unless a terminal
 * action produced a response.
 *
 *   http.createServer(necterNode(cm, (req, res, inspection) => app(req, res)))
 */
export function necterNode(server: NecterServer, next: (req: IncomingMessage, res: ServerResponse, inspection: import('../types.js').Inspection) => void | Promise<void>) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const { request, extras } = toWebRequest(req, { body: isEndpointPath(server, req.url) });
    const endpoint = await server.handleEndpoint(request, extras);
    if (endpoint) return sendWebResponse(res, endpoint);
    const inspection = await server.inspect(request, extras);
    if (inspection.response) return sendWebResponse(res, inspection.response);
    const tarpit = inspection.decision.mode === 'enforce' ? inspection.decision.actions.find((a) => a.kind === 'tarpit') : undefined;
    if (tarpit) await new Promise((r) => setTimeout(r, Number(tarpit.params?.['delayMs'] ?? 3000)));
    for (const [k, v] of Object.entries(inspection.responseHeaders)) {
      if (k.toLowerCase() === 'set-cookie') {
        const prev = res.getHeader('set-cookie');
        res.setHeader('set-cookie', [...(Array.isArray(prev) ? prev : prev ? [String(prev)] : []), v]);
      } else res.setHeader(k, v);
    }
    (req as IncomingMessage & { necter?: import('../types.js').Inspection }).necter = inspection;
    await next(req, res, inspection);
  };
}
