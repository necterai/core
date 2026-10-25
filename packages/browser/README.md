# @necterai/browser

Detect and stop AI agents in the browser: Playwright/Puppeteer/Selenium stacks, computer-use agents (ChatGPT agent, Anthropic computer use, Mariner, Manus) and agentic browser extensions (Claude for Chrome, Atlas, Comet). Part of [Necter](https://github.com/necterai/core), the open-source firewall for AI agents.

## Install

**Script tag (any site).** Paste into `<head>`:

```html
<script async src="https://cdn.jsdelivr.net/npm/@necterai/browser@0/dist/necter.iife.js" data-necter></script>
```

**npm.**

```bash
npm install @necterai/browser
```

```ts
import { init } from '@necterai/browser';

const necter = init({
  mode: 'monitor',            // 'enforce' to block, challenge or slow agents on the page
  siteKey: 'my-app',
  onVerdict: (v) => console.log(v.score, v.actorClass, v.provider?.id),
});
```

`init()` is safe during server rendering and idempotent. Guides for React, Next.js, Vue, Nuxt, SvelteKit, Angular, Astro, WordPress, Shopify, Webflow and more: **[docs/install.md](https://github.com/necterai/core/blob/main/docs/install.md)**.

## The verdict

```ts
necter.verdict.score        // 0–100: how sure Necter is that automation drives this session
necter.verdict.actorClass   // 'human' | 'browser-agent' | 'computer-use-agent' | 'extension-agent' | …
necter.verdict.provider     // { id: 'openai', verified: true, … } when known
necter.verdict.evidence     // every signal, ordered, with its contribution
necter.on('verdict', (v) => …)
necter.headers()            // attach to your own API calls so the server sees the same session
```

The verdict updates as evidence arrives (page load, first interaction, form fills). Pair it with [`@necterai/server`](https://www.npmjs.com/package/@necterai/server) to also catch agents that never run JavaScript and to decide on the server.

## License

MIT
