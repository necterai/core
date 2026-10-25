# necter: Architecture

Status: design baseline (2026-10-24). Companion documents: `docs/research/*` (evidence base),
`docs/design/detection-spec.md` (signal-by-signal specification), `docs/design/evaluation.md`
(agent zoo results).

## 1. What we are building

A firewall for AI agents that a site owner can drop into any web app:

* a **browser SDK** (`@necterai/browser`, one `<script>` tag or an npm import) that identifies
  who is driving the page, attributes the automation to a provider, and executes interventions;
* a **server/edge SDK** (`@necterai/server`) that does the same for the HTTP request, verifies
  self-declared agents, fuses its view with the browser SDK's beacons, and applies a policy;
* a **signatures knowledge base** (`@necterai/signatures`) of agents, crawlers, automation stacks
  and their artifacts, refreshable without a code release;
* a shared **core** (`@necterai/core`): actor taxonomy, signal model, scoring engine, policy
  engine and the event schema that the future review/replay service will consume.

The product promise for this phase: *identify better than anything on the market, then act*.
Review and replay come next, but every decision we take already emits the evidence they need.

## 2. Threat model: four ways an agent reaches a site

| Class | How it reaches the page | What the page can observe |
| --- | --- | --- |
| `fetch-agent`, `ai-crawler`, `search-crawler`, `utility-bot` | Plain HTTP client (python/undici/Go/curl, or a vendor fetcher such as ChatGPT-User, Claude-User, Perplexity-User, GPTBot). No JavaScript runs. | Only the request: UA, headers and their order, TLS/h2 fingerprint, IP/ASN, Web Bot Auth signature, request pattern, and the *absence* of a browser-SDK beacon. |
| `browser-agent` | A real browser engine driven over CDP/WebDriver by a framework (Playwright, Puppeteer, Selenium) that an LLM loop (Browser Use, Stagehand, Skyvern, Playwright MCP) calls. Usually headless or in a container; sometimes the agent reads the DOM / accessibility tree, sometimes screenshots. | Everything a browser exposes: automation leaks (bindings, Runtime.enable side effects, stack markers, injected globals/overlays), headless/container forensics, DOM-harvesting bursts from `page.evaluate`, synthetic-but-trusted input with no human kinematics, LLM think time. |
| `computer-use-agent` | A model looks at screenshots and emits OS-level mouse/keyboard actions (xdotool, hosted browser input). The browser itself may be stock. | Input kinematics (teleporting pointer, coordinate quantisation from screenshot scaling, no hover, seconds between actions), hosted-environment forensics (container GPU/fonts/timezone, datacenter egress, fixed 1024x768-class viewports), and self-identification where vendors sign requests. |
| `extension-agent` / `human-assisted` | A user's own browser is driven (or read) by an extension or an agentic browser (Claude for Chrome, Atlas agent mode, Comet, Gemini in Chrome). The human may or may not be present. | Extension artifacts (debugger attach side effects, injected DOM/CSS, probeable resources, brands), a split between natural human input and synthetic agent input inside the same session, and DOM/a11y reads without corresponding scroll/viewport changes. |

Adversary capabilities we assume: full control of UA and headers; stealth patches
(patchright/rebrowser/nodriver) that close the classic CDP leaks; residential proxies; ability
to solve interactive CAPTCHAs with a vision model; ability to read any page text, including
instructions we leave for it. We do **not** assume it reproduces human motor behaviour,
maintains state across sessions like a returning user, or can hide the cost of an LLM step.

## 3. Design principles

1. **Layered evidence, never a single tell.** Twelve signal layers (declared, request, network,
   environment, probe, behavior, harvest, canary, extension, consistency, tie, challenge). Each
   layer has an independent failure mode; the engine caps what a layer, and what a family of
   correlated signals inside a layer, can contribute.
2. **Classify, attribute, then act.** The verdict carries `automation` (probability the session
   is not human-operated), an `actorClass`, a `provider` attribution with `verified` flag, and
   an ordered list of evidence. Policies key off all four; a verified Googlebot and an
   unverified "Googlebot" are different actors.
3. **Behaviour is the tiebreaker.** Environment tells are cheap to spoof and trip on privacy
   browsers; human kinematics are expensive to fake and pull the score *down*. The strongest
   human-favouring layer is behaviour, and non-deterministic blocks require it.
4. **Deterministic proofs exist and are used.** A Playwright binding, a Puppeteer stack frame,
   a verified Web Bot Auth signature, a canary hit, a failed challenge: these set the verdict
   on their own and are flagged `deterministic` so policies can block without hesitation.
5. **Explainable by construction.** Every number in a verdict is traceable to a signal with a
   one-line summary and a registry entry documenting its false-positive traps.
6. **Humble defaults.** `monitor` mode ships first; `enforce` is a policy switch. Assistive
   technology users are humans. Wanted bots are verified and allowed.
7. **Zero dependencies in the browser bundle, CSP-safe (no eval), passive listeners, idle-time
   work, < 35 KB gzipped target.**
8. **Replay-ready.** All signals, verdicts, decisions, interventions, interaction summaries and
   canary/challenge outcomes are emitted as `SessionEvent`s through an `EventSink` interface.

## 4. Components

```
                ┌──────────────────────────────────────────────────────────┐
                │  Browser SDK (@necterai/browser)                         │
  page load ───►│  session ─► collectors ─► probes ─► behaviour observers   │
                │            (environment)  (leaks)   (pointer/keys/scroll) │
                │  harvest instrumentation   canaries   extension probes    │
                │                     │                                     │
                │                     ▼                                     │
                │           core engine (local verdict) ─► interventions    │
                │                     │                     (overlay,        │
                │                     ▼                      challenge,      │
                │             transport (beacons) ◄──────────degrade, label) │
                └─────────────────────┬────────────────────────────────────┘
                                      │ POST /__necter/beacon (signals, verdict, summary)
                                      ▼
                ┌──────────────────────────────────────────────────────────┐
                │  Server SDK (@necterai/server)                           │
  request ─────►│  request forensics ─► network identity ─► Web Bot Auth   │
                │  (UA/headers/hints)   (IP ranges/ASN/rDNS)  (RFC 9421)   │
                │          │                                               │
                │          ▼                                               │
                │  session store (fusion of request + client signals)      │
                │          │                                               │
                │          ▼                                               │
                │  core engine ─► policy ─► server actions ─► EventSink    │
                │                 (allow/label/challenge/degrade/decoy/    │
                │                  tarpit/limit/redirect/block/notify)     │
                └──────────────────────────────────────────────────────────┘
```

### 4.1 `@necterai/core` (done, tested)

* `taxonomy.ts`: `ActorClass` (11 classes), provider registry.
* `signals.ts`: `Signal`, `SignalDefinition`, registry, strengths and default log-odds.
* `engine.ts`: capped log-odds accumulation; see 5.2.
* `policy.ts`: ordered rules matched on class, provider, automation band, deterministic/verified
  flags, evidence layers, path globs, stage, tags; `monitor` mode; default policy.
* `events.ts`: `SessionEvent` union, `InteractionSummary`, `EventSink` (memory, console, fanout).

### 4.2 `@necterai/signatures`

Data, not code: agent records (UA regexes, IP range source URLs, rDNS suffixes, robots tokens,
Web Bot Auth directory URLs, JS execution, default viewports), automation globals and DOM
artifacts, extension ids and probeable resources, HTTP-library header fingerprints, hosting
ASN lists, wanted-bot verification rules. A `sync` script snapshots published IP ranges into
`data/ip-ranges/`. Each record carries sources and a confidence.

### 4.3 `@necterai/browser`

Modules (all optional, all configurable):

* **session**: stable id (cookie + storage), first-visit/amnesia detection, page lifecycle.
* **collectors** (passive, once at init, some on idle): navigator, user-agent data, screen and
  window geometry, graphics (WebGL/WebGPU adapter), media devices and voices, permissions
  inconsistencies, fonts, timezone/locale, storage/history/referrer, `window.chrome`.
* **probes** (active): CDP Runtime leak, stack-frame markers, known automation globals,
  prototype/toString/Proxy tamper detection, fresh-realm comparison via a sandboxed iframe,
  debugger-attach side effects (infobar height jumps), extension resource probes.
* **behavior**: pointer kinematics (trajectory, velocity profile, pre-click path, hover dwell,
  centre-click ratio, coordinate lattice/quantisation, pressure/pointerType/movement), keyboard
  cadence (dwell/flight, `fill` vs typed input, insertText, paste), scroll provenance (wheel vs
  programmatic, delta quantisation, `scrollIntoView` jumps), timing (time to first interaction,
  inter-action gaps = LLM think time, idle micro-movements), focus/visibility.
* **harvest**: prototype instrumentation of layout/style/text reads with burst detection and
  stack-origin attribution; whitelists the site's own scripts.
* **canary**: visually-hidden instructions/links/fields with per-session tokens; hits are
  deterministic agent proofs; nothing harmful is ever instructed.
* **extension**: artifacts of agentic browsers and agent extensions.
* **consistency**: UA vs platform vs client hints vs WebGL vs fonts vs timezone vs IP (server).
* **engine**: the core engine with the registry; verdict stages `load` → `interaction` → `final`.
* **intervene**: block overlay, proof-of-presence challenge (kinematic slider; pluggable
  Turnstile/hCaptcha adapters), degrade (glyph scrambling font, text-to-canvas, element hiding
  by selector), decoy swap, tarpit (fetch/XHR delay), label (header injection on fetch/XHR,
  cookie, `window.__necter`), redirect, notify (callback).
* **transport**: batched `sendBeacon`/`fetch`, retries, page-hide flush, policy pull.
* **recorder** (stub): ring buffer of interaction events; rrweb adapter later.

### 4.4 `@necterai/server`

* **request forensics**: UA signature matching, header set/order and casing, Accept family,
  `Sec-Fetch-*`, client hints, cookie/referrer behaviour.
* **network identity**: published AI-agent IP ranges (snapshot + refresh), cloud/hosting ASN
  lists, rDNS verification for wanted bots, optional TLS/h2 fingerprint input from the edge
  (Cloudflare `cf.botManagement.ja4`, custom header from a proxy).
* **Web Bot Auth**: RFC 9421 verification with Ed25519 keys from the agent's
  `/.well-known/http-message-signatures-directory` (cached), replay protection on nonce.
* **session fusion**: memory store (pluggable: Redis/KV); merges request signals with client
  beacons; emits `tie` signals (HTML served, no beacon within N seconds; hint/JS mismatch).
* **policy + actions**: decision per request; server actions (403 block page, 402/redirect to
  the agent gateway, degrade/decoy HTML transforms, tarpit via delayed streaming, label headers,
  challenge page, webhook notify).
* **adapters**: WHATWG `Request`-based core (`inspect(request)`), with thin wrappers for Node
  `http`, Express, Hono, Next.js middleware, Cloudflare Workers and Vercel Edge.
* **endpoints**: `/__necter/beacon`, `/__necter/canary/:token`, `/__necter/challenge`,
  `/__necter/policy`, `/.well-known/agent-access` (gateway page), `/__necter/script.js`.

### 4.5 `apps/demo` and `apps/zoo`

The demo is a small Hono site (catalogue, article, form) with the SDK installed and a live
evidence panel. The zoo runs real attackers against it and prints a matrix of detection outcome
per attacker (see `docs/design/evaluation.md`): Playwright headless/headed, patchright,
Puppeteer, Python Playwright, httpx/curl/undici fetchers, a Browser-Use-style loop, a
computer-use-style loop, a Playwright MCP run, and a human simulator with realistic kinematics
to measure false positives.

## 5. Detection engine

### 5.1 Stages

| Stage | When | Typical evidence |
| --- | --- | --- |
| `request` | Server sees the HTTP request | declared, request, network, tie |
| `load` | SDK booted (≈ first 300 ms) | environment, probe, extension, consistency |
| `interaction` | Every N events / 1 s throttle | behavior, harvest, canary |
| `final` | Challenge outcome, canary hit, deterministic proof, or page hide | challenge, canary |

Policies can require a stage (e.g. never block at `load` without a deterministic signal).

### 5.2 Scoring

* Prior log-odds of automation: `logit(0.08)`.
* Each signal contributes `automation × reliability` log-odds (registry default or override);
  negative values favour human.
* Correlated signals share a **family** budget (default +3.5 / −3.0); each **layer** has its own
  budget (behaviour may pull −4.5, environment at most +3.5, probes up to +5).
* **Deterministic** signals (|w| ≥ 6) bypass caps but do not stack within a family.
* `automation = sigmoid(prior + Σ)`; `score = round(100 × automation)`.
* Class attribution: softmax over per-class evidence among automation classes; `human-assisted`
  is chosen when a person is present and assistant artifacts are seen.
* Provider attribution: noisy-OR over provider hints; verified hints (IP range, rDNS, Web Bot
  Auth) dominate unverified ones (UA strings).

### 5.3 Why this beats the incumbents (hypotheses the zoo must confirm)

* Agent-class taxonomy with provider attribution and a `verified` flag, rather than a scalar
  bot score.
* LLM-specific behavioural features: think-time gaps, centre-click ratio, teleporting pointer,
  screenshot-grid quantisation, `fill()`-style input, programmatic scroll provenance.
* DOM-harvest instrumentation: agents that read the whole DOM through `page.evaluate` leave a
  burst signature no human page does.
* Semantic canaries: agents that read hidden text act on it; humans never see it.
* Extension-agent detection: nobody at the edge can see a `chrome.debugger` attach; the page can.
* Explainable evidence and replay-ready events from day one, self-hostable, framework-agnostic.

## 6. Interventions

Severity order: `allow < observe < notify < label < limit < tarpit < degrade < decoy <
challenge < redirect < block`. Defaults: verified search/utility bots allowed; AI crawlers
blocked with a 403 that points at the agent gateway; fetch agents redirected to the gateway
(HTTP 402 with licensing terms); deterministic browser/computer-use/extension automation blocked;
strong-but-not-deterministic evidence challenged; moderate evidence degraded and labelled;
human-assisted sessions labelled so the app can hide sensitive data from the assistant.
`monitor` mode downgrades everything to observe + label.

## 7. Guardrails

* **Accessibility**: keyboard-only, screen-reader, switch and voice-control users produce no
  pointer kinematics; the absence of pointer data is never evidence of automation, and
  challenges have keyboard/AT paths. Voice-control grid clicks land near centres; centre-click
  evidence requires several clicks with no preceding hover and is capped.
* **Privacy browsers**: Brave/Firefox RFP/Tor trip environment tells; the environment layer cap
  and the behaviour layer's negative pull keep them human. No canvas/audio hashing is used as a
  tracking identifier; fingerprints are session-scoped.
* **Wanted bots**: verified by rDNS/IP before allowlisting; unverified impersonators are not.
* **Legal/ethical**: canaries contain no harmful instructions; decoy content is clearly
  separable from real content on the server; interventions respect `robots.txt`/Content-Signal
  declarations the site itself publishes; no PII in beacons by default.
* **Performance**: init work under 10 ms on the main thread, probes deferred to idle, listeners
  passive, batched beacons.

## 8. Roadmap after this phase

Review/replay service (ingest `SessionEvent`s, timeline UI, rrweb recordings), hosted policy
console, signature refresh pipeline, ML calibration on collected sessions, edge-native builds.
