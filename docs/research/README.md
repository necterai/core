# Research evidence base (2026-10-24)

Twelve research reports, each written from primary sources (vendor docs, framework and Chromium source, IETF drafts,
live endpoint fetches) plus local measurements on Chrome 155/156. Every claim carries a confidence tag
(`confirmed` / `likely` / `uncertain`) and a source URL. They are the ground truth behind
`packages/core/src/catalog.ts` and `docs/design/detection-spec.md`.

| Report | What it answers |
| --- | --- |
| [`raw/providers-tier1.md`](raw/providers-tier1.md) | Wire identity of OpenAI, Anthropic and Google agents and crawlers: UA strings, IP range JSONs, rDNS, robots tokens, Web Bot Auth status. |
| [`raw/providers-tier2.md`](raw/providers-tier2.md) | Same for Meta, Perplexity, Microsoft, Amazon, Apple, xAI, ByteDance, Mistral, DeepSeek, DuckDuckGo and others. |
| [`raw/automation-stacks.md`](raw/automation-stacks.md) | Page-visible artifacts of Playwright, Puppeteer, Selenium, patchright, nodriver, Browser Use, Stagehand, Skyvern, Playwright MCP and hosted browsers (read from source). |
| [`raw/cdp-leak-techniques.md`](raw/cdp-leak-techniques.md) | Which in-page automation leaks still work on Chrome 155/156 (measured), headless tells, stack markers, residue globals, tamper detection. |
| [`raw/computer-use-agents.md`](raw/computer-use-agents.md) | Input mechanics and environments of computer-use agents (xdotool cadence, coordinate lattices, hosted profiles, CAPTCHA behaviour). |
| [`raw/extension-agents.md`](raw/extension-agents.md) | Detecting Claude in Chrome, the ChatGPT/Codex extension, Comet, Gemini in Chrome, MCP bridges from inside a page (live-measured indicator host, debugger infobar, WAR probes). |
| [`raw/behavior-biometrics.md`](raw/behavior-biometrics.md) | Human vs agent input signatures with dataset-backed thresholds (Balabit, CMU) and per-stack dispatch mechanics. |
| [`raw/server-fingerprints.md`](raw/server-fingerprints.md) | Measured TLS/JA4, HTTP/2 and header-order fingerprints for 20+ HTTP clients; IP intelligence feeds; the Web Bot Auth verification algorithm. |
| [`raw/platform-standards.md`](raw/platform-standards.md) | Browser-platform signals: client hints, userActivation, WebMCP, Privacy Pass, Chrome Actor, Safari/Firefox equivalents. |
| [`raw/false-positive-traps.md`](raw/false-positive-traps.md) | Everything that makes humans or wanted bots look like agents (assistive tech, privacy browsers, VDI, autofill, shared egress) and the calibration doctrine. |
| [`raw/interventions.md`](raw/interventions.md) | Effectiveness of blocks, challenges, proof-of-work, tarpits, decoys, canaries and agent gateways per agent class. |
| [`raw/competitors.md`](raw/competitors.md) | Market landscape (Cloudflare, Akamai, DataDome, HUMAN, Kasada/Vercel, Fingerprint, Arcjet, Stytch...), gaps, and legal constraints. |

Supporting material:

* `raw/artifacts/` — live Web Bot Auth key directories, CDP probe scripts and results, probe pages.
* `raw/cdp-probe/` — the stdlib-only CDP harness and per-browser measurements behind `cdp-leak-techniques.md`.
* `datasets/` — Balabit mouse sessions and the CMU keystroke benchmark used to calibrate the behaviour module.

## Findings that shaped the design

1. **Local agents are invisible to the network.** Claude in Chrome, Comet, Gemini in Chrome and the ChatGPT extension use
   the user's own browser, IP, cookies and TLS stack. Only the page can see them, through DOM artifacts, extension
   side effects and input forensics. This is the gap no edge-only vendor can close.
2. **Behaviour beats fingerprints for agents.** Independent 2026 studies reach near-perfect agent recall from a handful
   of input features (teleporting clicks, click micro-timing, paste/insertText typing, think-time gaps), while
   fingerprints alone plateau because agents share stock browsers.
3. **Several famous leaks are dead.** The `Error.stack` getter Runtime.enable probe stopped working in Chrome 138;
   the extension-driven CDP path did not trip any serialisation probe on Chrome 155. Still alive: page
   `Error.prepareStackTrace` invocation, inherited name/message getter read counts, residue globals, stack markers.
4. **Verified identity exists for some cloud agents.** OpenAI (`https://chatgpt.com`), Google (`https://agent.bot.goog`),
   Browserbase, Meta, DuckDuckGo, Amazon AgentCore and ~50 others sign with Web Bot Auth. Anthropic and Perplexity do
   not; they publish IP ranges instead.
5. **Assistive technology looks like automation.** NVDA's Enter produces a trusted, sub-millisecond, centre-of-element
   click with no keydown. Every pointer-kinematics rule is gated behind an "AT-possible" session class.
6. **CAPTCHAs hand off to humans rather than stopping agents.** Canary tokens and behavioural challenges that score the
   *motion* are the interventions with evidence behind them.

## Open research gaps

The gap-fill round (Meta Muse identity, OpenAI post-Atlas surfaces, a live agentic-browser lab, hosted-stack fingerprint
bank, human baselines on VDI/containers, legal/privacy review) did not complete and should be rerun before GA.
