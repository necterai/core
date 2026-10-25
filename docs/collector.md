# The Necter collector

The **collector** is a small open-source service you can run yourself. It serves the detection script, receives what the script finds, and shows every visitor on a live dashboard. You run one collector and point any number of sites at it.

## 1. Start the collector

```bash
git clone https://github.com/necterai/core.git necter && cd necter
corepack pnpm install
corepack pnpm build
corepack pnpm collector
```

It prints:

```
  necter collector · monitor mode (records only, never blocks)

  Dashboard   http://127.0.0.1:8788/__necter/ui/
  Test page   http://127.0.0.1:8788/test
  Install     <script async src="http://127.0.0.1:8788/__necter/script.js?site=my-site"></script>
```

Open the dashboard. Then open the test page in another tab: you appear as a session within a few seconds. Point an agent at the test page (Claude in Chrome, ChatGPT agent, a Playwright script, `curl`) and watch it show up and get classified.

## 2. Add it to a site

Pick one of three ways.

### A. One script tag (any site)

Paste this into the `<head>` of every page, as high as possible:

```html
<script async src="https://YOUR-COLLECTOR/__necter/script.js?site=my-site"></script>
```

- `site=` is any name; it groups sessions on the dashboard.
- Add `&mode=enforce` to block and challenge agents on the page (default: `monitor`, which only records).
- Add `&debug=1` to show a small verdict panel on the page while you test.
- The dashboard's **Install** screen builds the tag for you, with the right address, and turns green when the first visit arrives.

Works with plain HTML, WordPress (header code plugin or theme `header.php`), Shopify (`theme.liquid`), Webflow and Squarespace (custom code in head), Next.js (`<Script strategy="beforeInteractive">`), or Google Tag Manager (Custom HTML tag, fired on all pages, though it loads later and so sees less).

What the script tag cannot see: agents that never run JavaScript (`curl`, Python fetchers, ChatGPT-User, most crawlers). For those, use proxy mode or the server SDK.

### B. Proxy mode (no code changes, catches everything)

```bash
corepack pnpm collector --upstream https://your-site.com
```

Then browse `http://127.0.0.1:8788/`. The collector fetches your site, adds the script to every HTML page, and also runs the server-side checks on every request, so fetch agents and crawlers show up too. It rewrites links, redirects and cookies so you stay on the proxy while you click around. It is meant for testing and demos; for production put the server SDK in your app instead.

### C. Bookmarklet (test on any page you visit)

On the dashboard's **Install** screen, drag **Necter test** to your bookmarks bar. On any website, click it to load detection into that page for you. Sites with a strict Content Security Policy will refuse it, and it starts late, so it sees less than a real install.

### D. Server SDK (production, in your own app)

For Node, Express, Hono, Next.js or Cloudflare Workers, use `@necterai/server` in your app (see [the install guide](./install.md)). It sees every request, serves the script itself and can block before your page renders.

## 3. Give agents a public address

Cloud agents (ChatGPT agent, Claude computer use in the cloud, Gemini, crawlers) cannot reach `127.0.0.1`. Two options:

**Tunnel (quickest).** With [ngrok](https://ngrok.com) installed:

```bash
ngrok http 8788
```

Open the dashboard from the `https://….ngrok-free.app` address it prints. The Install screen then shows the snippet with that address, and you can give the same address's `/test` page (or your proxied site) to any agent. Set a dashboard password when the collector is public:

```bash
corepack pnpm collector --token choose-a-secret
# open https://….ngrok-free.app/__necter/ui/?token=choose-a-secret once; a cookie remembers it
```

**Host it.** The repo has a Dockerfile:

```bash
docker build -t necter .
docker run -p 8788:8788 -e DASHBOARD_TOKEN=choose-a-secret -v necter-data:/app/apps/collector/data necter
```

Put it behind any HTTPS host (Fly.io, Render, Railway, a VM with Caddy). The collector trusts `X-Forwarded-For` and `X-Forwarded-Proto` from the proxy in front of it; pass `TRUST_PROXY=0` if it is exposed directly.

## Options

| Flag | Env | Default | What it does |
| --- | --- | --- | --- |
| `--upstream URL` | `UPSTREAM` | none | Proxy mode: protect this site |
| `--site NAME` | `SITE` | upstream host | Site name for proxied sessions |
| `--mode monitor\|enforce` | `NECTER_MODE` | `monitor` | `enforce` blocks, challenges and slows agents |
| `--port N` | `PORT` | `8788` | Listen port |
| `--host H` | `HOST` | `127.0.0.1` | Use `0.0.0.0` in a container |
| `--origins a,b` | `ALLOWED_ORIGINS` | any | Only accept data from these page origins, e.g. `https://shop.com,https://www.shop.com` |
| `--token SECRET` | `DASHBOARD_TOKEN` | none | Password for the dashboard |
| `--data DIR` | `DATA_DIR` | `apps/collector/data` | Where sessions are kept across restarts; `none` keeps them in memory |
| `--debug` | `NECTER_DEBUG=1` | off | Debug panel on pages and server logs |

## Reading the dashboard

- **Agent score** (0 to 100): how sure the engine is that automation is driving the session. 75 or more counts as an agent. The tick on each bar marks 75.
- **Verdict**: the kind of agent (browser agent, computer-use agent, extension agent, fetch agent, AI crawler) and, when known, who built it (OpenAI, Anthropic, Google…). "Verified" means a signature or a published IP range proved it.
- **Proof, not a guess**: a signal fired that only automation produces (for example a Playwright artifact or a filled honeypot field).
- Click a session to see **why**: every signal with how hard it pulled towards agent or human, the pages visited, and the event timeline.

## Testing tips

- Keep the collector in **monitor** mode on any site with real visitors until you have seen how it reads your own traffic.
- A test from your own browser should read as **Human**. If it does not, open the session and look at the strongest evidence: browser extensions that automate pages (password managers usually do not; AI assistants do) count as evidence.
- Real agents to try: Claude in Chrome, ChatGPT agent mode, Perplexity Comet, Gemini in Chrome, Browser Use, Playwright MCP, and plain fetches (`curl`, ChatGPT or Claude asked to "read this URL").
- `corepack pnpm zoo` runs the built-in agent simulators against a fresh demo and prints the detection table.
