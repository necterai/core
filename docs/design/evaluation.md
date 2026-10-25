# Evaluation: agent zoo results

Date: 2026-10-25. Stack: `@necterai/browser` (IIFE, 214 KB minified / 70.7 KB gzip) + `@necterai/server` in monitor mode behind the demo shop, Chrome 155/156 on macOS.
Command: `corepack pnpm exec tsx src/run.ts --mode monitor --dataset --timeout 120 --repeat 3` in `apps/zoo`.
Raw results (`apps/zoo/results/`, including the labelled event dataset `…-events.jsonl`) are not committed; `pnpm zoo` regenerates them.

## Headline

| | Result (3 full iterations, 20 attackers each) |
| --- | --- |
| Detection | **59 / 60** |
| Class attribution | **57 / 60** |
| False positives (screen reader, password manager) | **0 / 6** (scored 8–16 once harness artefacts are removed) |
| Run-to-run stability | identical verdicts in all 3 iterations except one extension-agent score (74 vs 99) |

Detection threshold: automation ≥ 0.75. Skipped (tooling not installed): `fetch-curl-cffi` (python `curl_cffi`), `playwright-mcp` (`@playwright/mcp`).

## Per attacker

| Attacker | Expected | Got | Score | Notes |
| --- | --- | --- | --- | --- |
| fetch-python-httpx | fetch-agent | fetch-agent | 100 | declared library UA |
| fetch-mcp-reference | fetch-agent | fetch-agent | 100 | MCP reference fetch server UA |
| fetch-curl | fetch-agent | fetch-agent | 100 | |
| fetch-undici-default | fetch-agent | fetch-agent | 100 | |
| fetch-spoofed-browser | fetch-agent | fetch-agent | 95–99 | Chrome UA + headers, caught by no-JS execution + header order; verdict after ~8 s |
| crawler-gptbot | ai-crawler / openai | ai-crawler / openai | 100 | |
| agent-chatgpt-user | fetch-agent / openai | fetch-agent / openai | 100 | |
| agent-claude-user | fetch-agent / anthropic | fetch-agent / anthropic | 100 | |
| pw-chromium-headless | browser-agent | browser-agent | 100 | |
| pw-chrome-new-headless | browser-agent | browser-agent | 100 | CDP Runtime leak in 32 ms |
| pw-stealth-patchright | browser-agent | browser-agent | 93 | no Runtime leak; behaviour + environment, ~6 s |
| browser-use-sim | browser-agent | browser-agent | 100 | |
| computer-use-sim | computer-use-agent | computer-use-agent* | 98* | |
| human-sim (humanised patchright) | browser-agent | browser-agent | 100 | Bezier paths, jitter, fidgeting: still caught |
| puppeteer-headless | browser-agent | browser-agent | 100 | |
| playwright-python | browser-agent | browser-agent | 100 | |
| extension-agent-sim | extension-agent | browser-agent* | 74–99* | see gaps |
| xdotool-sim | computer-use-agent | computer-use-agent* | 100* | |
| at-nvda-sim (NVDA user) | human | human* | 8–16* | |
| password-manager-sim (Bitwarden fill) | human | human* | 14* | |

\* Judged with harness artefacts removed (next section). Raw scores for these rows are 100 / browser-agent because the Playwright driver itself is detected.

## Harness artefacts

Every browser attacker in the zoo is launched and driven by Playwright or patchright. Some signals come from that driver, not from the behaviour being simulated: Playwright's injected-script stack frames and CDP Runtime leaks, `navigator.webdriver`, the headless window (outer size = inner size, screen = viewport), and a locale override that does not reach Workers.

A real NVDA user, a real Bitwarden user, a real xdotool-driven computer-use agent or a real Claude in Chrome user never emits these. So attackers that simulate one of those declare `harnessArtifacts` (`apps/zoo/src/attackers/browsers.ts`, `PLAYWRIGHT_HARNESS_ARTIFACTS`). The zoo re-scores them from the raw signal events with those signals removed, and that adjusted score decides PASS/FAIL. Behaviour, canary and harvest signals are never removed, because that is where a real false positive would show.

## Bugs found and fixed by this evaluation

1. **Every browser session was flagged as an agent.** The client sends a `canary` event with `phase: 'issued'` when it plants canaries. The server mapped every canary event to `canary.hidden-link-followed` (+7, deterministic), so every visitor with JS enabled, humans included, scored 100. The server now ignores `issued`. For real hits it keeps the client's own signal (with its reliability) and only fills in a full-weight signal when none arrived. Regression test: `packages/server/test/server.test.ts`.
2. **Behaviour-only automation was labelled browser-agent.** Most behaviour signals carry equal or higher browser-agent class weight, so OS-level-input agents defaulted to browser-agent. The engine now damps browser-agent class mass (×0.4, `DRIVERLESS_BROWSER_AGENT_DAMPING`) when no probe, declared, harvest or webdriver evidence points to an in-page driver. Tests: `packages/core/test/engine.test.ts`.
3. **Zoo hangs.** `waitForLoadState('load')` after a link click resolves against the old page, and Playwright input sent mid-navigation can hang forever (one run stalled for 4 h). Fixed with `humanClickNavigate` (waits for the URL to change), plus a per-attacker `--timeout` (default 120 s) and forced exit.

## Gaps and open risks

- **Extension-agent class needs a headed run.** Headless, the simulated extension agent is still caught (99 in 2 of 3 runs, 74 in one, just under threshold) but reads as browser-agent. The discriminating signal, Chrome's "started debugging this browser" infobar, only exists in a headed window. Next: run `--headed` and add the Claude-in-Chrome DOM artefacts (indicator host, web-accessible resources) to the simulated extension.
- **Simulators, not the real agents.** None of these rows is the real Claude in Chrome, ChatGPT agent, Gemini in Chrome, Comet or Atlas. Their published behaviour is encoded in the catalog and simulators, but a live run against each is the next validation step.
- **Intermittent dropout (seen once).** In one of six full runs, client beacons from most browser sessions never reached the server and they scored as the 8 % prior. It did not recur in the 3× run. Suspected load or timing; needs a soak test (`--repeat 10`), and the client should retry beacons on failure.
- **Human baseline is two simulators.** A real-traffic false-positive study (real users, assistive tech, autofill, translation extensions, session-replay tools) is still needed before enforce mode goes on any production site.
- **Bundle size.** 70.7 KB gzip against a 35 KB target. Candidates: split behaviour and harvest into a lazily loaded second chunk; drop the debug panel from the production build.
- **Not exercised here.** Web Bot Auth verified agents, IP-range verification from real provider egress, and TLS/JA4 fingerprints (the demo sits behind no TLS terminator). These are unit-tested only.

## Reproduce

```bash
export PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH"
corepack pnpm build
cd apps/zoo && corepack pnpm exec tsx src/run.ts --mode monitor --repeat 3 --timeout 120
```
