import type { NecterServer, InspectExtras } from '../types.js';

/**
 * Hono middleware (Node, Bun, Deno, Cloudflare Workers, Vercel).
 *
 *   const cm = createNecter({ mode: 'enforce' })
 *   app.use('*', necterHono(cm))
 */
export function necterHono(server: NecterServer, extras?: (c: HonoLikeContext) => InspectExtras) {
  return async (c: HonoLikeContext, next: () => Promise<void>): Promise<Response | void> => {
    const req = c.req.raw;
    const ex = extras ? extras(c) : { ...cfExtras(req), ...nodeExtras(c) };
    const endpoint = await server.handleEndpoint(req, ex);
    if (endpoint) return endpoint;
    const inspection = await server.inspect(req, ex);
    c.set('necter', inspection);
    if (inspection.response) return inspection.response;
    const res = await server.respond(inspection, async () => {
      await next();
      return c.res;
    });
    c.res = res;
  };
}

export interface HonoLikeContext {
  req: { raw: Request };
  res: Response;
  env?: unknown;
  set(key: string, value: unknown): void;
}

/** On @hono/node-server the IncomingMessage is exposed as c.env.incoming: recover raw header order and the socket address. */
export function nodeExtras(c: HonoLikeContext): InspectExtras {
  const incoming = (c.env as { incoming?: { rawHeaders?: string[]; socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  if (!incoming) return {};
  const ex: InspectExtras = {};
  if (Array.isArray(incoming.rawHeaders)) {
    const order: string[] = [];
    for (let i = 0; i < incoming.rawHeaders.length; i += 2) order.push(incoming.rawHeaders[i]!);
    ex.headerOrder = order;
  }
  const ip = incoming.socket?.remoteAddress;
  if (ip) ex.ip = ip.replace(/^::ffff:/, '');
  return ex;
}

/** Cloudflare request properties when present (cf.botManagement.ja4, cf-connecting-ip). */
export function cfExtras(req: Request): InspectExtras {
  const cf = (req as Request & { cf?: { asn?: number; httpProtocol?: string; botManagement?: { ja4?: string; ja3Hash?: string } } }).cf;
  const ex: InspectExtras = {};
  const ip = req.headers.get('cf-connecting-ip');
  if (ip) ex.ip = ip;
  if (typeof cf?.asn === 'number') ex.asn = cf.asn;
  if (cf?.botManagement?.ja4 || cf?.botManagement?.ja3Hash) {
    ex.tls = { ...(cf.botManagement.ja4 ? { ja4: cf.botManagement.ja4 } : {}), ...(cf.botManagement.ja3Hash ? { ja3: cf.botManagement.ja3Hash } : {}) };
  }
  return ex;
}
