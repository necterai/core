import type { NecterServer, InspectExtras } from '../types.js';

/**
 * Next.js middleware (edge or node runtime). Returns a Response for SDK
 * endpoints and terminal actions, otherwise `undefined` so your middleware can
 * continue (call NextResponse.next() and copy `inspection.responseHeaders`).
 *
 *   export async function middleware(req) {
 *     const r = await necterNext(cm)(req)
 *     if (r.response) return r.response
 *     const res = NextResponse.next()
 *     for (const [k, v] of Object.entries(r.headers)) res.headers.set(k, v)
 *     return res
 *   }
 */
export function necterNext(server: NecterServer, extras?: (req: Request) => InspectExtras) {
  return async (req: Request): Promise<{ response?: Response; headers: Record<string, string>; inspection?: import('../types.js').Inspection }> => {
    const ex = extras ? extras(req) : ipExtras(req);
    const endpoint = await server.handleEndpoint(req, ex);
    if (endpoint) return { response: endpoint, headers: {} };
    const inspection = await server.inspect(req, ex);
    if (inspection.response) return { response: inspection.response, headers: inspection.responseHeaders, inspection };
    return { headers: inspection.responseHeaders, inspection };
  };
}

export function ipExtras(req: Request): InspectExtras {
  const ex: InspectExtras = {};
  const ip = req.headers.get('x-real-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (ip) ex.ip = ip;
  return ex;
}
