import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createNecter, necterHono, type Inspection } from '@necterai/server';
import { createMemorySink, createFanoutSink, type SessionEvent } from '@necterai/core';
import { pages } from './pages.js';

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, '../../../packages/browser/dist/necter.iife.js');
const scriptContent = existsSync(scriptPath) ? readFileSync(scriptPath, 'utf8') : undefined;
if (!scriptContent) console.warn('[demo] browser SDK not built; run `pnpm build` first');

const MODE = (process.env['NECTER_MODE'] as 'monitor' | 'enforce' | undefined) ?? 'enforce';
const PORT = Number(process.env['PORT'] ?? 8787);

// Memory sink for the live evidence API + optional JSONL log for the zoo.
const memory = createMemorySink(50_000);
const logSink = {
  write(events: SessionEvent[]) {
    if (process.env['NECTER_LOG'] === '1') for (const e of events) console.log(JSON.stringify(e));
  },
};
const cm = createNecter({
  mode: MODE,
  sink: createFanoutSink(memory, logSink),
  trustProxy: true,
  debug: process.env['NECTER_DEBUG'] === '1',
  ...(scriptContent ? { scriptContent } : {}),
  gateway: { title: 'Agent access for the demo shop', body: 'This demo shop does not allow AI agents or crawlers. Identify your agent with Web Bot Auth and contact the owner for access.', contact: 'mailto:owner@example.test' },
  allowlist: { userAgents: ['necter-zoo-allowlisted'] },
});

type Env = { Variables: { necter: Inspection } };
const app = new Hono<Env>();

// Zoo / review API (never behind the firewall so tests can read results).
app.get('/__zoo/events', (c) => {
  const sid = c.req.query('session');
  const since = Number(c.req.query('since') ?? 0);
  const events = memory.events.filter((e) => (!sid || e.sessionId === sid) && e.ts >= since);
  return c.json({ count: events.length, events: events.slice(-2000) });
});
app.get('/__zoo/sessions', (c) => {
  const byId = new Map<string, { id: string; verdict?: unknown; last: number; requests: number; ua?: string }>();
  for (const e of memory.events) {
    const s = byId.get(e.sessionId) ?? { id: e.sessionId, last: 0, requests: 0 };
    s.last = Math.max(s.last, e.ts);
    if (e.type === 'verdict') s.verdict = e.data.verdict;
    if (e.type === 'request') {
      s.requests++;
      if (e.data.ua) s.ua = e.data.ua;
    }
    byId.set(e.sessionId, s);
  }
  return c.json([...byId.values()].sort((a, b) => b.last - a.last).slice(0, 200));
});
app.get('/__zoo/verdict/:id', async (c) => {
  const v = await cm.verdictFor(c.req.param('id'));
  return v ? c.json(v) : c.json({ error: 'unknown' }, 404);
});
app.post('/__zoo/reset', (c) => {
  memory.clear();
  return c.json({ ok: true });
});

app.use('*', necterHono(cm));

app.get('/', (c) => c.html(pages.home(MODE)));
app.get('/products', (c) => c.html(pages.products(MODE)));
app.get('/products/:id', (c) => c.html(pages.product(MODE, Number(c.req.param('id')))));
app.get('/article', (c) => c.html(pages.article(MODE)));
app.get('/contact', (c) => c.html(pages.contact(MODE)));
app.post('/contact', async (c) => {
  const form = await c.req.parseBody();
  const ins = c.get('necter');
  // Honeypot field filled => deterministic canary.
  if (typeof form['website_url_confirm'] === 'string' && form['website_url_confirm']) {
    await cm.canaryHit(ins.session.id, 'contact-honeypot', 'field', { path: '/contact' });
  }
  return c.html(pages.thanks(MODE));
});
app.get('/api/products', (c) => c.json({ items: pages.catalog.map((p) => ({ id: p.id, name: p.name, price: p.price })) }));
app.get('/api/products/:id', (c) => {
  const p = pages.catalog.find((x) => x.id === Number(c.req.param('id')));
  return p ? c.json(p) : c.json({ error: 'not found' }, 404);
});
app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /__necter/\nDisallow: /__zoo/\n\nUser-agent: GPTBot\nDisallow: /\nUser-agent: ClaudeBot\nDisallow: /\nUser-agent: Google-Extended\nDisallow: /\nUser-agent: CCBot\nDisallow: /\nUser-agent: Bytespider\nDisallow: /\n'));
app.get('/sitemap.xml', (c) => c.text('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>/</loc></url><url><loc>/products</loc></url><url><loc>/article</loc></url></urlset>', 200, { 'content-type': 'application/xml' }));
app.get('/static/:file', (c) => {
  const file = c.req.param('file');
  const p = join(here, '../public', file);
  if (!existsSync(p)) return c.notFound();
  const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'application/javascript' : 'application/octet-stream';
  return c.body(readFileSync(p), 200, { 'content-type': type });
});

serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, () => {
  console.log(`[demo] necter demo shop on http://127.0.0.1:${PORT} (mode=${MODE})`);
});
