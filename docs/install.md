# Install Necter

Necter has two halves. Use either one, or both for the best coverage:

| | What it catches | How you add it |
| --- | --- | --- |
| **Browser** (`@necterai/browser`) | Agents that drive a real browser: Playwright/Puppeteer/Selenium stacks, computer-use agents, agentic browser extensions | One `<script>` tag, or `npm install` and one `init()` call |
| **Server** (`@necterai/server`) | Everything that sends a request, including agents that never run JavaScript: `curl`, Python fetchers, ChatGPT-User, GPTBot, ClaudeBot and other AI crawlers | One middleware line in your server or edge function |

When both are installed the server also serves the browser script (`/__necter/script.js`), receives what it finds, and makes one decision per visitor from both sides.

Every install starts in **monitor** mode: Necter records and labels agents but never blocks. Switch to `mode: 'enforce'` once you've checked how it reads your own traffic.

**Jump to:**
[Plain HTML / CDN](#plain-html-any-site) ·
[WordPress](#wordpress) · [Shopify](#shopify) · [Webflow, Squarespace, Wix, Framer](#webflow-squarespace-wix-framer) · [Google Tag Manager](#google-tag-manager) ·
[React (Vite)](#react-vite-create-react-app) · [Next.js](#nextjs) · [Vue / Nuxt](#vue-and-nuxt) · [SvelteKit](#sveltekit) · [Angular](#angular) · [Astro](#astro) ·
[Express](#express) · [Hono](#hono-bun-deno) · [Node `http`](#node-http) · [Fastify](#fastify-and-other-servers) · [Cloudflare Workers](#cloudflare-workers) ·
[Seeing the results](#seeing-the-results) · [Options](#options)

---

## Browser only

### Plain HTML (any site)

Paste this into the `<head>` of every page, as high up as you can:

```html
<script async src="https://cdn.jsdelivr.net/npm/@necterai/browser@0/dist/necter.iife.js" data-necter></script>
```

That's the whole install. Add attributes to configure it:

```html
<script async
  src="https://cdn.jsdelivr.net/npm/@necterai/browser@0/dist/necter.iife.js"
  data-necter
  data-mode="enforce"
  data-site="my-shop"
  data-endpoint="https://collector.example.com/__necter"
  data-debug="1"></script>
```

- `data-mode`: `monitor` (default, records only) or `enforce` (blocks, challenges and slows agents on the page).
- `data-site`: a name that groups this site's sessions on the dashboard.
- `data-endpoint`: where to send what it finds. Defaults to `/__necter` on your own site, which is right when you also run the [server SDK](#server). Point it at a [collector](./collector.md) or the [Necter Console](#seeing-the-results) otherwise.
- `data-debug="1"`: shows a small verdict panel on the page while you test.

unpkg works the same way: `https://unpkg.com/@necterai/browser@0/dist/necter.iife.js`. For production, pin an exact version (`@necterai/browser@0.1.0`) so the file never changes under you.

Read the verdict from your own code. `window.necter.verdict` is always the latest; `on('verdict')` fires as it updates:

```html
<script>
  window.addEventListener('load', () => {
    const n = window.necter;
    if (!n) return;
    console.log(n.verdict.score, n.verdict.actorClass);
    n.on('verdict', (v) => console.log(v.score, v.actorClass, v.provider?.id));
  });
</script>
```

### WordPress

**With a plugin (no code):** install [WPCode](https://wordpress.org/plugins/insert-headers-and-footers/) (or any "header and footer scripts" plugin), open **Code Snippets → Header & Footer**, paste the [script tag](#plain-html-any-site) into **Header**, and save.

**In a theme:** add this to your (child) theme's `functions.php`:

```php
add_action('wp_head', function () {
  echo '<script async src="https://cdn.jsdelivr.net/npm/@necterai/browser@0/dist/necter.iife.js" data-necter></script>';
}, 1);
```

### Shopify

**Online Store → Themes → ⋯ → Edit code → `layout/theme.liquid`**. Paste the [script tag](#plain-html-any-site) right after the opening `<head>` tag and save.

### Webflow, Squarespace, Wix, Framer

Paste the [script tag](#plain-html-any-site) into the site-wide head code:

- **Webflow:** Site settings → Custom code → Head code. Publish.
- **Squarespace:** Settings → Advanced → Code Injection → Header.
- **Wix:** Settings → Custom code → Add custom code → place in Head, all pages.
- **Framer:** Site settings → General → Custom code → Start of `<head>` tag.

### Google Tag Manager

New tag → **Custom HTML** → paste the [script tag](#plain-html-any-site) → trigger **All Pages**. It works, but GTM loads later than a tag in your `<head>`, so it sees less of how a visitor arrived. Prefer the head tag when you can.

### React (Vite, Create React App)

```bash
npm install @necterai/browser
```

```ts
// src/main.tsx: before your app renders
import { init } from '@necterai/browser';

init({ mode: 'monitor', siteKey: 'my-app' });
```

Use the verdict in a component (`get()` returns the instance once `init()` has run):

```tsx
import { useEffect } from 'react';
import { get } from '@necterai/browser';

useEffect(() => get()?.on('verdict', (v) => {
  if (v.score >= 75) console.warn('Agent detected:', v.actorClass, v.provider?.id);
}), []);
```

Or pass `onVerdict` to `init()`.

`init()` is safe to call during server rendering (it does nothing there) and safe to call twice (it returns the first instance). With no server SDK, set `endpoint` to a [collector](./collector.md) or the console, or turn reporting off with `beacon: { enabled: false }`.

### Vue and Nuxt

**Vue (Vite):**

```ts
// src/main.ts
import { createApp } from 'vue';
import { init } from '@necterai/browser';
import App from './App.vue';

init({ siteKey: 'my-app' });
createApp(App).mount('#app');
```

**Nuxt:** create a client-only plugin.

```ts
// plugins/necter.client.ts
import { init } from '@necterai/browser';

export default defineNuxtPlugin(() => {
  init({ siteKey: 'my-app' });
});
```

### SvelteKit

```svelte
<!-- src/routes/+layout.svelte -->
<script>
  import { onMount } from 'svelte';
  import { init } from '@necterai/browser';
  onMount(() => { init({ siteKey: 'my-app' }); });
</script>

<slot />
```

Or put the [script tag](#plain-html-any-site) in `src/app.html` inside `<head>`.

### Angular

```ts
// src/main.ts
import { bootstrapApplication } from '@angular/platform-browser';
import { init } from '@necterai/browser';
import { AppComponent } from './app/app.component';
import { appConfig } from './app/app.config';

init({ siteKey: 'my-app' });
bootstrapApplication(AppComponent, appConfig);
```

### Astro

Put the [script tag](#plain-html-any-site) in your base layout's `<head>`, or import the SDK:

```astro
<!-- src/layouts/Layout.astro -->
<script>
  import { init } from '@necterai/browser';
  init({ siteKey: 'my-site' });
</script>
```

---

## Server

The server SDK inspects every request, answers its own endpoints under `/__necter/*` (including the browser script), and, in enforce mode, blocks, challenges or slows agents before your page renders.

```bash
npm install @necterai/server
```

Then add the browser half with one tag in your HTML. It loads from your own server, so there's nothing else to configure:

```html
<script async src="/__necter/script.js" data-necter></script>
```

### Next.js

`proxy.ts` (Next.js 16+; on Next.js 15 and earlier name the file `middleware.ts` and the function `middleware`):

```ts
// proxy.ts (next to your app/ directory)
import { NextResponse, type NextRequest } from 'next/server';
import { createNecter, necterNext } from '@necterai/server';

const necter = necterNext(createNecter({ mode: 'monitor', trustProxy: true }));

export async function proxy(request: NextRequest) {
  const result = await necter(request);
  if (result.response) return result.response;          // Necter's own endpoints, or a block in enforce mode
  const res = NextResponse.next();
  for (const [k, v] of Object.entries(result.headers)) res.headers.set(k, v);
  return res;
}

export const config = {
  // Skip static files; keep /__necter so the SDK endpoints work.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
```

Add the browser script in your root layout:

```tsx
// app/layout.tsx
import Script from 'next/script';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Script src="/__necter/script.js" data-necter strategy="afterInteractive" />
      </body>
    </html>
  );
}
```

(Browser only, no `proxy.ts`? Use the [CDN tag](#plain-html-any-site) in `<Script>` instead, or call `init()` from a `'use client'` component's `useEffect`.)

### Express

```ts
import express from 'express';
import { createNecter } from '@necterai/server';
import { necterExpress } from '@necterai/server/adapters/express';

const app = express();
app.set('trust proxy', true);
app.use(necterExpress(createNecter({ mode: 'monitor', trustProxy: true })));

app.get('/api/products', (req, res) => {
  const verdict = req.necter!.verdict;   // score, actorClass, provider, evidence
  if (verdict.score >= 75) return res.status(403).json({ error: 'automated access is not allowed' });
  res.json(products);
});
```

### Hono (Bun, Deno)

```ts
import { Hono } from 'hono';
import { createNecter, necterHono, type Inspection } from '@necterai/server';

const app = new Hono<{ Variables: { necter: Inspection } }>();
app.use('*', necterHono(createNecter({ mode: 'monitor' })));

app.get('/', (c) => {
  const { verdict } = c.get('necter');
  return c.text(`Agent score: ${verdict.score}`);
});

export default app;
```

On `@hono/node-server`, pass `nodeExtras` (also from `@necterai/server`) for the client IP and raw header order: `necterHono(createNecter(), nodeExtras)`.

### Node `http`

```ts
import http from 'node:http';
import { createNecter } from '@necterai/server';
import { necterNode } from '@necterai/server/adapters/node';

const necter = createNecter({ mode: 'monitor' });

http.createServer(necterNode(necter, (req, res, inspection) => {
  res.end(`Hello, ${inspection.verdict.actorClass}`);
})).listen(3000);
```

### Fastify and other servers

Any Node-based server can reuse the Node adapter from a request hook (Fastify shown). Anything that can build a standard `Request` can call `necter.handle(request, next)` instead, which answers SDK endpoints, applies actions and adds headers to your response.

```ts
import Fastify from 'fastify';
import { createNecter } from '@necterai/server';
import { necterNode } from '@necterai/server/adapters/node';

const necter = createNecter({ mode: 'monitor' });
const fastify = Fastify();
const guard = necterNode(necter, () => undefined);

fastify.addHook('onRequest', async (req, reply) => {
  await guard(req.raw, reply.raw);
  if (reply.raw.writableEnded) return reply.hijack();   // Necter answered (endpoint or block)
});
```

### Cloudflare Workers

```ts
import { createNecter, withNecter } from '@necterai/server';

const necter = createNecter({ mode: 'monitor' });

export default {
  fetch: withNecter(necter, async (request) => fetch(request)),   // or your own handler
};
```

This works as a Worker in front of any origin, so it protects a site on any host. Cloudflare's JA4 fingerprint and verified-bot fields are picked up automatically when your plan provides them.

---

## Seeing the results

- **In your code:** the verdict on every request (`req.necter.verdict` in Express, `c.get('necter').verdict` in Hono) and in the browser (`window.necter.verdict`, `on('verdict', …)`). When a visitor matches a policy rule (an AI crawler, a browser agent…), server responses also carry `x-necter-score`, `x-necter-class`, `x-necter-provider` and `x-necter-action` headers, in monitor mode too.
- **The open-source collector:** a self-hosted dashboard you can point any site at. See [docs/collector.md](./collector.md).
- **Necter Console (paid):** live view, session review and replay, team accounts and per-site keys. Create a site to get an ingest key, then:

  ```ts
  import { createNecter, connectConsole } from '@necterai/server';

  // reads NECTER_CONSOLE_URL and NECTER_CONSOLE_KEY from the environment
  const necter = createNecter({ sink: connectConsole() });
  ```

## Options

The most used options. Both SDKs ship full TypeScript types for the rest.

**Browser (`init({...})` or `data-*` attributes)**

| Option | Attribute | Default | |
| --- | --- | --- | --- |
| `mode` | `data-mode` | `'monitor'` | `'enforce'` applies interventions on the page |
| `siteKey` | `data-site` | none | Groups sessions per site |
| `endpoint` | `data-endpoint` | `'/__necter'` | Where beacons go |
| `debug` | `data-debug` | `false` | Console logging and an on-page verdict panel |
| `sensitiveSelectors` | `data-sensitive` | `[]` | CSS selectors to blur or scramble for agents (`degrade` action) |
| `trustedScriptOrigins` | `data-trusted` | `[]` | Your own script origins, so their DOM reads aren't counted as harvesting |
| `beacon.enabled` | | `true` | Turn reporting off for a browser-only install |
| `onVerdict`, `onDecision` | | | Callbacks |

**Server (`createNecter({...})`)**

| Option | Default | |
| --- | --- | --- |
| `mode` | `'monitor'` | `'enforce'` blocks, challenges, tarpits and rate-limits |
| `trustProxy` | `false` | Read the client IP from `X-Forwarded-For` (set it behind a load balancer or CDN) |
| `sink` | memory | Where session events go: `connectConsole()`, `createConsoleSink()` (logs), `createFanoutSink(a, b)` |
| `allowlist` | none | `{ userAgents, ips }` for your own monitoring and CI, never blocked |
| `policy` | default | Your own rules (see `defaultPolicy` in `@necterai/core`) |
| `cors` | `false` | Accept beacons from other origins (for a shared collector) |
| `scriptContent` | bundled | The browser script served at `/__necter/script.js`; `false` turns the route off |
| `verifyWebBotAuth` | `true` | Verify signed agents (Web Bot Auth) |

## Troubleshooting

- **My own browser shows up as an agent.** Open the session and look at the strongest evidence. AI assistant extensions that read or drive pages count as evidence; password managers don't.
- **Strict Content Security Policy.** Allow the script's origin in `script-src` (`https://cdn.jsdelivr.net` or your own domain) and, if beacons go elsewhere, add that origin to `connect-src`.
- **Nothing reaches the dashboard.** With a browser-only install, `endpoint` must point somewhere that accepts beacons: your server SDK, a collector, or the console.
