import type { IncomingMessage, ServerResponse } from 'node:http';
import type { NecterServer, Inspection } from '../types.js';
import { isEndpointPath, sendWebResponse, toWebRequest } from './node.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by necterExpress(): the verdict and decision for this request. */
      necter?: Inspection;
    }
  }
}

/**
 * Express/Connect middleware.
 *
 *   app.use(necterExpress(cm))
 *   app.get('/api/x', (req, res) => { req.necter.verdict ... })
 */
export function necterExpress(server: NecterServer) {
  return async (req: IncomingMessage & { necter?: Inspection }, res: ServerResponse, next: (err?: unknown) => void): Promise<void> => {
    try {
      const { request, extras } = toWebRequest(req, { body: isEndpointPath(server, (req as { originalUrl?: string }).originalUrl ?? req.url) });
      const endpoint = await server.handleEndpoint(request, extras);
      if (endpoint) return void (await sendWebResponse(res, endpoint));
      const inspection = await server.inspect(request, extras);
      req.necter = inspection;
      if (inspection.response) return void (await sendWebResponse(res, inspection.response));
      const tarpit = inspection.decision.mode === 'enforce' ? inspection.decision.actions.find((a) => a.kind === 'tarpit') : undefined;
      if (tarpit) await new Promise((r) => setTimeout(r, Number(tarpit.params?.['delayMs'] ?? 3000)));
      for (const [k, v] of Object.entries(inspection.responseHeaders)) {
        if (k.toLowerCase() === 'set-cookie') {
          const prev = res.getHeader('set-cookie');
          res.setHeader('set-cookie', [...(Array.isArray(prev) ? prev : prev ? [String(prev)] : []), v]);
        } else res.setHeader(k, v);
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
