import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createNecter } from '../src/index.js';
import { necterNode } from '../src/adapters/node.js';
import { necterExpress } from '../src/adapters/express.js';

// The app reads the body the way body-parser and Fastify do: 'data' listeners attached after Necter ran.
function readWithListeners(req: IncomingMessage): Promise<number> {
  return new Promise((resolve, reject) => {
    let n = 0;
    req.on('data', (c: Buffer) => { n += c.length; });
    req.on('end', () => resolve(n));
    req.on('error', reject);
  });
}

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

const big = 'x'.repeat(300_000);

describe('Node adapters leave app request bodies alone', () => {
  it('necterNode: a large POST body still reaches the app', async () => {
    const necter = createNecter();
    const base = await listen(necterNode(necter, async (req, res) => { res.end(String(await readWithListeners(req))); }));
    const res = await fetch(`${base}/api/upload`, { method: 'POST', body: big, signal: AbortSignal.timeout(5000) });
    expect(await res.text()).toBe(String(big.length));
  });

  it('necterExpress: a large POST body still reaches the next middleware', async () => {
    const mw = necterExpress(createNecter());
    const base = await listen((req, res) => {
      void mw(req, res, async (err?: unknown) => {
        if (err) { res.statusCode = 500; return res.end(String(err)); }
        res.end(String(await readWithListeners(req)));
      });
    });
    const res = await fetch(`${base}/api/upload`, { method: 'POST', body: big, signal: AbortSignal.timeout(5000) });
    expect(await res.text()).toBe(String(big.length));
  });

  it('SDK endpoints still read their own bodies (beacons)', async () => {
    const necter = createNecter();
    const base = await listen(necterNode(necter, (_req, res) => { res.statusCode = 404; res.end(); }));
    const res = await fetch(`${base}/__necter/beacon`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'adapter-test', events: [] }),
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBeLessThan(500);
    expect(res.status).not.toBe(404);
  });
});
