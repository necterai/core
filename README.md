<div align="center">

# Necter

**The open-source firewall for AI agents.**

Identify, attribute and stop AI agents on your website: browser agents, computer-use agents, agentic browser extensions, fetch bots and AI crawlers.

[![npm](https://img.shields.io/npm/v/@necterai/browser?label=%40necterai%2Fbrowser)](https://www.npmjs.com/package/@necterai/browser)
[![npm](https://img.shields.io/npm/v/@necterai/server?label=%40necterai%2Fserver)](https://www.npmjs.com/package/@necterai/server)
[![CI](https://github.com/necterai/core/actions/workflows/ci.yml/badge.svg)](https://github.com/necterai/core/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[Install](./docs/install.md) · [How it works](./docs/design/architecture.md) · [Website](https://necter.ai)

</div>

---

## Install in 30 seconds

**Any website.** Paste one line into your `<head>`:

```html
<script async src="https://cdn.jsdelivr.net/npm/@necterai/browser@0/dist/necter.iife.js" data-necter></script>
```

**Any JavaScript app** (React, Vue, Svelte, Angular, Astro…):

```bash
npm install @necterai/browser
```

```ts
import { init } from '@necterai/browser';

init({ onVerdict: (v) => console.log(v.score, v.actorClass, v.provider?.id) });
```

**Your server or edge**, to catch agents that never run JavaScript (Express shown; Next.js, Hono, Node, Fastify and Cloudflare Workers are just as short):

```bash
npm install @necterai/server
```

```ts
import { createNecter } from '@necterai/server';
import { necterExpress } from '@necterai/server/adapters/express';

app.use(necterExpress(createNecter({ mode: 'monitor' })));
```

👉 **[Step-by-step guides](./docs/install.md)** for plain HTML, WordPress, Shopify, Webflow, Squarespace, Wix, Framer, Google Tag Manager, React, Next.js, Vue, Nuxt, SvelteKit, Angular, Astro, Express, Hono, Node, Fastify and Cloudflare Workers.

Everything starts in **monitor** mode: Necter watches and labels but never blocks. Set `mode: 'enforce'` when you're ready.

## What it catches

| Kind of agent | Examples | Caught by |
| --- | --- | --- |
| Browser automation | Playwright, Puppeteer, Selenium, Browser Use, Stagehand, Skyvern, Playwright MCP | browser |
| Computer-use agents | Anthropic computer use, OpenAI ChatGPT agent, Google Mariner, Manus, Nova Act | browser |
| Extension and agentic browsers | Claude for Chrome, ChatGPT Atlas agent mode, Perplexity Comet, Gemini in Chrome | browser |
| Fetch and tool-call agents | ChatGPT-User, Claude-User, Perplexity-User, Python `requests`, undici, `curl` | server |
| AI crawlers | GPTBot, ClaudeBot, Google-Extended, CCBot, Bytespider, PerplexityBot | server |

Every verdict comes with:

- a **score** from 0 to 100 (how sure Necter is that automation drives the session),
- a **class** (`browser-agent`, `computer-use-agent`, `extension-agent`, `fetch-agent`, `ai-crawler`, `search-crawler`, `human`…),
- the **provider** when known (OpenAI, Anthropic, Google…), with a `verified` flag when a signature or published IP range proves it,
- the **evidence**: every signal, in order, with how hard it pulled towards agent or human.

## What it can do about them

Block · challenge (a slider humans pass and scripts fail) · degrade (blur or scramble sensitive content) · label · tarpit · rate-limit · redirect to an agent access page (`402`) · serve a decoy · notify you. You choose per class, per provider and per path, or keep the defaults.

## Packages

| Package | |
| --- | --- |
| [`@necterai/browser`](./packages/browser) | Client SDK. Environment, automation-leak and extension probes, behaviour (mouse, keys, scrolling), DOM-harvest detection, honeypots, interventions. ESM, CJS and a drop-in `<script>`. |
| [`@necterai/server`](./packages/server) | Server and edge SDK. Request forensics, IP ranges, rDNS, Web Bot Auth, policy and actions, adapters for Express, Hono, Next.js, Node and Cloudflare Workers. Serves the browser script for you. |
| [`@necterai/core`](./packages/core) | The shared engine: agent taxonomy, signal catalog, explainable scoring, policy engine, session event schema. Zero dependencies. |
| [`@necterai/signatures`](./packages/signatures) | Knowledge base of AI agents and crawlers: user agents, IP ranges, rDNS, Web Bot Auth directories, automation artifacts. |

Also in this repo: [`apps/collector`](./docs/collector.md) (a self-hosted dashboard and script host you can point any site at, with a no-code proxy mode), `apps/demo` (a demo shop) and `apps/zoo` (real agents run against the demo to measure detection).

## Dashboard: Necter Console

The SDKs are free and open source, and work on their own. **Necter Console** is the hosted dashboard: watch agents on all your sites live, review and replay every session, manage sites and keys, and invite your team. Connect it with one line:

```ts
import { createNecter, connectConsole } from '@necterai/server';

const necter = createNecter({ sink: connectConsole() }); // NECTER_CONSOLE_URL + NECTER_CONSOLE_KEY
```

Prefer to self-host? The open-source [collector](./docs/collector.md) gives you a live dashboard too.

## Develop

```bash
git clone https://github.com/necterai/core.git && cd core
corepack enable && pnpm install && pnpm build
pnpm test          # unit tests for every package
pnpm demo          # demo shop on http://127.0.0.1:8787 (NECTER_MODE=monitor|enforce)
pnpm collector     # dashboard on http://127.0.0.1:8788/__necter/ui/
pnpm zoo           # run every simulated agent against the demo and print the detection table
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request. Design notes are in [`docs/design`](./docs/design) and the research behind every signal is in [`docs/research`](./docs/research).

## Security

Found a way past Necter, or a vulnerability in it? Please report it privately; see [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE) © Necter
