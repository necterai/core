import type { NecterServer } from '../types.js';
import { cfExtras } from './hono.js';

/**
 * Cloudflare Worker wrapper.
 *
 *   export default { fetch: withNecter(cm, async (request, env, ctx) => originFetch(request)) }
 */
export function withNecter<Env = unknown>(server: NecterServer, handler: (request: Request, env: Env, ctx: unknown) => Promise<Response>) {
  return async (request: Request, env: Env, ctx: unknown): Promise<Response> => {
    const extras = cfExtras(request);
    return server.handle(request, () => handler(request, env, ctx), extras);
  };
}
