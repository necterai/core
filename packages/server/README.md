# @necterai/server

Identify AI agents, AI crawlers and fetch bots on every request, then block, challenge, slow or label them. Works on Node, Bun, Deno, Vercel and Cloudflare Workers, with adapters for Express, Hono, Next.js and Node `http`. Part of [Necter](https://github.com/necterai/core), the open-source firewall for AI agents.

```bash
npm install @necterai/server
```

## Express

```ts
import { createNecter } from '@necterai/server';
import { necterExpress } from '@necterai/server/adapters/express';

app.use(necterExpress(createNecter({ mode: 'monitor', trustProxy: true })));
```

## Next.js (`proxy.ts`)

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { createNecter, necterNext } from '@necterai/server';

const necter = necterNext(createNecter({ mode: 'monitor', trustProxy: true }));

export async function proxy(request: NextRequest) {
  const result = await necter(request);
  if (result.response) return result.response;
  const res = NextResponse.next();
  for (const [k, v] of Object.entries(result.headers)) res.headers.set(k, v);
  return res;
}
```

## Hono · Cloudflare Workers

```ts
app.use('*', necterHono(createNecter()));                                  // Hono: new Hono<{ Variables: { necter: Inspection } }>()
export default { fetch: withNecter(createNecter(), (req) => fetch(req)) }; // Workers
```

More (Node `http`, Fastify, Bun, Deno, options): **[docs/install.md](https://github.com/necterai/core/blob/main/docs/install.md)**.

## Add the browser half

The server serves the browser SDK for you. Add one tag to your HTML:

```html
<script async src="/__necter/script.js" data-necter></script>
```

Beacons come back to `/__necter/beacon` and both halves fuse into one verdict per visitor.

## What it checks

User agent and client hints, header order and shape, TLS/HTTP2 fingerprints when your platform exposes them (JA4), published AI-provider IP ranges, rDNS, signed agents ([Web Bot Auth](https://datatracker.ietf.org/doc/draft-meunier-web-bot-auth-architecture/)), and whether the visitor ever ran JavaScript.

## Send events to Necter Console

```ts
import { createNecter, connectConsole } from '@necterai/server';

const necter = createNecter({ sink: connectConsole() }); // NECTER_CONSOLE_URL + NECTER_CONSOLE_KEY
```

## License

MIT
