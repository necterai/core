# Computer-use and hosted-browser agents: observable mechanics (as of 2026-10-24)

Research area: agents that look at screenshots (or an accessibility/DOM snapshot) and emit mouse/keyboard actions, either in a vendor-hosted browser/VM or inside the user's own browser. Scope: Anthropic computer use + Claude in Chrome + browser toolset; OpenAI CUA / Operator / ChatGPT agent / ChatGPT Work cloud browser / Atlas (retired); Google Gemini Computer Use / Project Mariner (retired) / Google-Agent / Gemini in Chrome auto browse; Perplexity Comet; Manus; Amazon Nova Act; Microsoft Magentic-UI and Edge Copilot Mode; H Company (Runner H / Surfer-H / Holo); Simular; Browserbase Open Operator / Hyperbrowser / Steel; plus notes on Meta Muse, Skyvern, OpenClaw and MultiOn/Convergence where facts were found.

Method: live web verification on 2026-10-24 (WebFetch of vendor docs and GitHub sources at pinned commits, direct HTTP probes of `/.well-known/http-message-signatures-directory` endpoints with response headers, two arXiv papers extracted with `pdftotext`, and a handful of vendor pages that block fetchers read through a Chrome tab). Web search budget ran out part-way; everything below is tied to a URL in the Sources section. Nothing is fabricated: where a string, header, extension ID or IP could not be confirmed, it is marked **uncertain** and the text says what was actually seen.

Confidence legend: **[confirmed]** = read in a primary source (vendor doc, source code, live HTTP response) or two independent measurements; **[likely]** = one credible secondary source or strong inference from primary facts; **[uncertain]** = single unverified claim, or vendor marketing.

Related: the host workspace had a local page titled "Agent Probe" at `http://127.0.0.1:8765/probe.html` open in Chrome; the lab-verification items in section 12 are written to be run against such a probe page.

---

## 0. Executive summary (what a detector can actually use)

1. **Only three hosted-agent families currently self-identify in a verifiable way, all with Web Bot Auth (RFC 9421 HTTP Message Signatures):** OpenAI's cloud browser (`Signature-Agent: "https://chatgpt.com"`, key directory live, `"purpose":"ai"`), Google's hosted agents (experimental identity `https://agent.bot.goog`, 5 Ed25519 keys live; plus a `Google-Agent` UA token and a published IP list `user-triggered-agents.json`), and Browserbase sessions (beta; directory live at `www.browserbase.com`, `"purpose":"rag"`). Anthropic (claude.ai, anthropic.com, api.anthropic.com), Perplexity, Manus, Anchor and Genspark return 404 for the directory path. **[confirmed, probed 2026-10-24]**
2. **Everything running in the user's own browser (Claude in Chrome, Comet, Gemini in Chrome auto browse, Manus Browser Operator, H HoloTab, the ChatGPT desktop app/extension, Nova Act local) presents the user's real UA, IP, cookies, screen and TLS stack.** Network-layer attribution is impossible there; attribution has to come from (a) DOM/extension artifacts, (b) input-event forensics, (c) cadence. **[confirmed by arXiv 2606.30119 measurements for Claude in Chrome and by Castle/HUMAN for Comet]**
3. **Input injection paths cluster into four classes with distinct page-visible signatures:**
   - OS-level X11/XTEST (`xdotool`) in a VM: Anthropic reference demo and OpenAI's Docker sample. Events are fully trusted and indistinguishable from a real X pointer *except* for cadence: warps (one motion event), `click` = mousedown+mouseup with a fixed ~12 ms gap, `type --delay 12` = perfectly uniform 12 ms keystrokes, wheel = N discrete button-4/5 clicks. **[confirmed from source]**
   - CDP `Input.dispatchMouseEvent` (Claude in Chrome via `chrome.debugger`, Comet's internal extension, Anthropic's reference CDP driver, Playwright/Puppeteer under the hood): `isTrusted: true`, but typically exactly one `mouseMoved` (or none) before `mousePressed/Released`, press→release gap 0–10 ms, empty `getCoalescedEvents()`, zero `movementX/Y`. **[confirmed for the reference driver and Comet; likely for Claude in Chrome]**
   - Playwright `page.mouse.*` (OpenAI CUA sample, Gemini sample, Magentic-UI, Nova Act, Browser Use/Stagehand, Skyvern): `mouse.move(steps=1)` "emits a single mousemove event at the destination", `click` delay defaults to 0 ms; scrolling is either `mouse.wheel` (Magentic-UI 400 px) or **`window.scrollBy()` with no wheel event at all** (OpenAI sample). **[confirmed from source]**
   - Out-of-process IPC into the renderer (Atlas "OWL") and content-script form filling (Claude in Chrome `form_input`, Comet overlay): mixed trusted/untrusted, DOM mutation without input events. **[likely]**
4. **Coordinate quantization is real and measurable.** Anthropic scales screenshots to XGA/WXGA/FWXGA and maps back with `round(x / factor)`, so on a 1920×1080 display clicks land on a ~1.406 px lattice; Gemini emits 0–999 normalized coordinates denormalized with `int(x/1000*width)` (1.44 px stride at 1440 wide, 1.92 px at 1920); OpenAI CUA and the Claude browser toolset emit integer screenshot/viewport pixels. Clicks therefore have integer `clientX/Y` and, after scaling, only hit a subset of columns/rows. **[confirmed from source; lattice effect is derived]**
5. **Fixed cloud environments are fingerprintable even without identity headers.** The hosted ChatGPT agent measured in Jan–Feb 2026 had a fixed 1280×960 screen, 13 logical cores, failing `navigator.permissions.query`, a Mac UA on a Linux platform (`Sec-CH-UA-Platform: "Linux"`, worker/main-thread `navigator.platform` mismatch), one ASN (Cloudflare infrastructure in the EU), TCP-only TLS with 28 cipher suites and 12 extensions, and a JA4 unique to it. Skyvern: Edge UA on Linux, SwiftShader WebGL, 32 cores, residential proxies. Browser Use cloud: 1512×982, 10 cores. **[confirmed, arXiv 2606.30119 + Castle + Simon Willison]**
6. **Cadence beats everything for in-browser agents.** Every stack is an observe→think→act loop: bursts of 1–5 actions separated by multi-second LLM pauses (Claude in Chrome screenshots take 2–5 s, 20 s+ on heavy pages; Manus averages 30–50 steps per task; HUMAN: "that process isn't faster than a human"). The arXiv 2607.26935 study got agent recall of 100% with two features: `mouse_event_rate` and `teleport_click_ratio`, and even human-trajectory replay was caught because the final click was still a programmatic dispatch without motion. **[confirmed]**
7. **CAPTCHA behavior is itself a classifier:** Claude refuses (20/20 refusals on Prosopo), Gemini is instructed to "MUST NEVER attempt to solve or bypass", OpenAI's CUA "seeks user confirmation for ... responding to CAPTCHA forms" (hand-off to a human: long idle, then human-like events), Manus hands over via "Take Over", while ChatGPT agent "was shown to be capable of solving simple CAPTCHA challenges" early on and passed Prosopo, Anubis and reCAPTCHA v3 in the honeysite study but was blocked by Turnstile. **[confirmed]**

---

## 1. Taxonomy and quick-reference table

| Product (status Oct 2026) | Where it runs | Input path | UA seen by site | Self-ID to sites | IP origin | Key page-visible artifacts |
|---|---|---|---|---|---|---|
| Anthropic computer use tool (API, `computer_toolset_20260801`) | Customer's VM/container | Customer's harness; reference = `xdotool` on Xvfb | Whatever browser the harness runs (ref: Firefox ESR on Ubuntu 22.04) | None | Customer's | 12 ms key cadence, 12 ms click hold, wheel-click scrolls, lattice coords |
| Anthropic browser use tool (API, `browser_toolset_20260801`) | Customer's browser | Customer's driver; reference = CDP `Input.dispatchMouseEvent` | Customer's Chromium | None ("sites Claude visits see your executor's network identity") | Customer's | 1 `mouseMoved` then press/release, `Runtime.enable` |
| Claude in Chrome (extension `fcoeoabgfenejglbffodgkkbkcdhcgfn`, v1.0.102) | User's Chrome, local | `chrome.debugger` (CDP) for screenshot/click/type; content scripts for read/find/form_input | User's real Chrome UA | None documented | User's | Trusted CDP clicks, no pre-click motion, 2–20 s per screenshot step; refuses CAPTCHAs |
| OpenAI Operator (retired Aug 2025) → ChatGPT agent (Jul 2025–~Aug 2026) → ChatGPT Work cloud browser (2026) | OpenAI-hosted Linux VM ("own virtual computer") | Undocumented custom stack (not Playwright per arXiv); pixel in/mouse-keyboard out | Stock Chrome UA claiming macOS (Chrome/138→141→…) | **Yes**: `Signature-Agent: "https://chatgpt.com"` + RFC 9421 signature | Cloud (Cloudflare infra, EU PoP observed; IPv6 `2a09:bac5:...` observed) | 1280×960 screen, 13 cores, platform mismatch, failing permissions.query, unique JA4 |
| OpenAI CUA API (`computer-preview` → `computer`) | Customer's env | Sample: Playwright `page.mouse` / `window.scrollBy`; Docker: `xdotool`; desktop: PyAutoGUI | Customer's | None | Customer's | `scrollBy` without wheel events; 1024×768 or 1440×900 viewport |
| ChatGPT Atlas (macOS, Oct 21 2025 – Aug 9 2026, retired) | User's Mac, local | Out-of-process "OWL" IPC into Chromium, no JS injection | Stock Chrome/141–142 macOS UA; favicon fetches `ChatGPT%20Atlas/... CFNetwork/... Darwin/...` | None on page loads | User's | Missing Google TTS voices in `speechSynthesis`, favicon UA, logged-out mode |
| Google Gemini Computer Use API | Customer's env | Sample: Playwright `page.mouse` | Customer's | None | Customer's | 0–999 grid → stride lattice; `type_text_at` clears with Meta+A/Backspace then Enter |
| Google Project Mariner (extension Dec 2024 → cloud VMs May 2025 → shut down May 4 2026) / Gemini agent / Spark | Google cloud VMs | Undocumented | "Generic Chrome" (HUMAN); hosted agents may send `Google-Agent` token | Partial: `Google-Agent` UA, `user-triggered-agents.json`, experimental WBA `https://agent.bot.goog` | Google ranges | — |
| Gemini in Chrome auto browse (Jan 2026 desktop, Android 2026) | User's Chrome tab, local | Undocumented | User's | None | User's | Pauses to confirm sensitive actions |
| Perplexity Comet (Chromium fork, Jul 2025–) | User's machine, local | Hidden internal extension; `chrome.debugger.sendCommand("Input.dispatchMouseEvent", ...)` | Chrome-identical UA and brands (Chrome/139 in Aug 2025, /142 later) | None (Perplexity: assistant should be "indistinguishable from you") | User's | `#pplx-agent-overlay-stop-button`, overlay.js, `comet-extension://npclhjbddhklpbnacpjloidibaggcgon/`, click-only teleports |
| Manus cloud browser / Browser Operator | Linux VM with headed Chromium (cloud) / user's Chrome or Edge via extension | browser-use protocol layer (cloud); extension (local) | Undocumented | None found (manus.im directory 404) | Data-center IPs (cloud, documented) / user's | Take Over hand-off on CAPTCHA/MFA |
| Amazon Nova Act | Customer's machine or AgentCore Browser (cloud) | Playwright (Chrome preferred), headed by default | Playwright default UA, with `NovaAct` token per docs | Yes-ish: "look for `NovaAct` in the user agent string" | Customer's / AWS | Playwright artifacts |
| Microsoft Magentic-UI / MagenticLite | Local Docker/Quicksand VM | Playwright coordinate clicks (`delay=10`), `mouse.wheel(400)` | Hardcoded Win10 Chrome/Edg 122 UA (non-persistent path) | None | Customer's | `div#red-cursor`, `[__elementId]` red borders |
| Microsoft Edge Copilot Mode "Actions" | User's Edge, local | Undocumented | User's | None documented | User's | Visual cues in browser chrome only |
| H Company Agents API (cloud browser / `user_device`) | H cloud or user's Chrome via `--remote-debugging-port=9222` | CDP | Undocumented | None | H cloud (managed proxy optional) / user's | 1200×1200 default visual viewport, `start_url` bing.com |
| Simular Sai | Simular-hosted Windows/Linux computer or user's Mac/Windows | Screen→click/type (OS-level) | Chrome on that OS | None | Simular / user's | Approval cards for sign-ins |
| Browserbase / Hyperbrowser / Steel (hosted browsers underneath many agents) | Vendor cloud | CDP/Playwright by the agent framework | Linux Chromium by default (Browserbase non-verified "always use linux"; "verified" defaults to Windows fingerprints) | Browserbase: WBA beta; others none | Data-center unless residential proxy enabled | Playwright globals, UTC timezone, worker/main platform mismatch (Browserbase basic tier) |

---

## 2. Anthropic

### 2.1 Computer use tool (API) — versions, actions, coordinates

Source: https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/computer-use-tool (read 2026-10-24) and `computer_use_demo/tools/groups.py`.

**Tool versions and beta headers** [confirmed]:

| `ToolVersion` (demo) | API `type` | Beta header | Notes |
|---|---|---|---|
| `computer_use_20241022` | `computer_20241022` | `computer-use-2024-10-22` | key, type, mouse_move, left_click, left_click_drag, right_click, middle_click, double_click, screenshot, cursor_position |
| `computer_use_20250124` / `computer_use_20250429` | `computer_20250124` | `computer-use-2025-01-24` | adds left_mouse_down, left_mouse_up, scroll, hold_key, wait, triple_click |
| `computer_use_20251124` | `computer_20251124` | `computer-use-2025-11-24` | adds zoom (`enable_zoom`) |
| `computer_toolset_20260801` | `computer_toolset_20260801` | none (GA) | "one `{"type": "computer_toolset_20260801"}` entry in `tools` gives Claude 17 member tools"; rejects `display_width_px`, `display_height_px`, `display_number`, `enable_zoom`, `name`; every `tool_use` carries `"toolset_name": "computer"` |

Earlier-version tool entry (exact, from the migration section):
```json
{ "type": "computer_20251124", "name": "computer", "display_width_px": 1024, "display_height_px": 768, "display_number": 1 }
```

**Member/action set (toolset)** [confirmed]: `screenshot`, `zoom` (`region: [x0,y0,x1,y1]`), `left_click`/`right_click`/`middle_click`/`double_click`/`triple_click` (`coordinate` optional, `text` = modifiers `shift|ctrl|alt|super`, `+`-joined), `left_click_drag` (`start_coordinate`, `coordinate`), `mouse_move`, `left_mouse_down`, `left_mouse_up`, `cursor_position`, `scroll` (`scroll_direction: up|down|left|right`, `scroll_amount` = "number of scroll-wheel clicks", optional `coordinate`), `type` (`text`), `key` (`text` such as `"Return"`, `"ctrl+s"`, `"alt+Tab"`; `repeat` 1–100), `hold_key` (`duration` ≤ 300 s), `wait` (`duration` ≤ 300 s). Example scroll call: `{"coordinate": [500, 400], "scroll_direction": "down", "scroll_amount": 3}`.

**Coordinate system** [confirmed]: "Coordinates are in screenshot pixels" with origin top-left; after `zoom`, coordinates are still in full-screenshot space. "If you scale screenshots down before returning them, scale Claude's coordinates back up before applying them to the real display." macOS Retina: downscale by 2 or halve coordinates. The API no longer downscales oversized images: "An oversized `tool_result` image is rejected with a validation error." Limits: Opus 4.7+ and all toolset models 2,576 px long edge / 4,784 visual tokens (≈3.75 MP); earlier models 1,568 px / ≈1.15 MP. Screenshot cost "roughly 1,000–1,800 input tokens each".

**Resolution guidance** [confirmed]: "For general desktop tasks, use 1024x768 or 1280x720; for web applications, use 1280x800 or 1366x768." "Avoid resolutions above 1920x1080 to prevent performance issues." Best-practices post (https://claude.com/blog/best-practices-for-computer-and-browser-use-with-claude): "Start with 1280x720" (≈80% of the 4.6 pixel budget), start at 1080p for Opus 4.7, avoid below 960×540, and a 16 px checkbox at 3840×2160 "becomes roughly 5px at 1280x720"; tiling, coordinate grid overlays and resize-algorithm choice "did not produce reliable gains". Sonnet 4.6 "more mechanically precise at clicking".

**Latency statements** [confirmed]: Limitations: "The current computer use latency for human-AI interactions might be too slow compared to regular human-directed computer actions." Oct 2024 research post: "Claude's computer use remains slow and often error-prone"; the model "counts how many pixels vertically or horizontally it needs to move a cursor"; screenshots are a "flipbook" that "can miss short-lived actions or notifications". Batch actions: several `tool_use` blocks per turn, executed in order, stop on first failure, halt text `Not executed: an earlier computer action in this turn failed.`

**Identification/CAPTCHA**: the docs say nothing about identifying to websites and nothing about CAPTCHAs. Security guidance asks for human confirmation for "accepting cookies, completing financial transactions, or agreeing to terms of service". Prompt-injection classifiers scan screenshots server-side.

### 2.2 Reference implementation (`anthropic-quickstarts/computer-use-demo`) — the canonical xdotool harness

Sources: Dockerfile, `image/xvfb_startup.sh`, `computer_use_demo/tools/computer.py`, `loop.py`, README (raw.githubusercontent.com, main, 2026-10-24). [confirmed]

Environment:
- `FROM docker.io/ubuntu:22.04`; `ARG DISPLAY_NUM=1`, `ARG HEIGHT=768`, `ARG WIDTH=1024` → `ENV`; user `computeruse`, home `/home/computeruse`. Packages: `xvfb`, `xdotool`, `mutter`, `tint2`, `firefox-esr`, `scrot`, `imagemagick`, `libreoffice` (no `gnome-screenshot`; no font, locale or timezone packages, so the container inherits Debian defaults — **inference**: `C.UTF-8`/POSIX locale, UTC, DejaVu/Liberation fonts).
- Xvfb: `Xvfb $DISPLAY -ac -screen 0 $RES_AND_DEPTH -retro -dpi $DPI -nolisten tcp -nolisten unix &` with `DPI=96`, `RES_AND_DEPTH=${WIDTH}x${HEIGHT}x24`. Ports 5900 (VNC), 6080 (noVNC), 8501 (Streamlit), 8080 (combined UI).
- System prompt: `"You are utilising an Ubuntu virtual machine using {platform.machine()} architecture with internet access."`, `"Note, firefox-esr is what is installed on your system."`, `"When using your computer function calls, they take a while to run and send back to you."`, `"Where possible/feasible, try to chain multiple of these calls all into one function calls request."`
- README: "We do not recommend sending screenshots in resolutions above" XGA/WXGA; "Relying on the image resizing behavior in the API will result in lower model accuracy and slower performance"; the bundled tool scales images and coordinates down itself; pad small displays with black to 1024×768.

Input dispatch (`computer.py`):
```
mouse_move:        xdotool mousemove --sync {x} {y}
left/middle/right: xdotool [mousemove --sync x y] click 1 | click 2 | click 3     (modifiers: keydown {text} ... keyup {text})
double/triple:     xdotool click --repeat 2 --delay 10 1   /  click --repeat 3 --delay 10 1
left_click_drag:   xdotool mousemove --sync {sx} {sy} mousedown 1 mousemove --sync {ex} {ey} mouseup 1
scroll:            xdotool [mousemove --sync x y] [keydown mod] click --repeat {scroll_amount} {4|5|6|7} [keyup mod]
type:              xdotool type --delay 12 -- '{chunk}'   (TYPING_DELAY_MS = 12, TYPING_GROUP_SIZE = 50, one screenshot after all chunks)
key:               xdotool key -- {text}      (toolset: shell-quoted, with --repeat)
hold_key:          xdotool keydown {k} sleep {duration} keyup {k}
```
After every action the tool waits `_screenshot_delay = 2.0` seconds, captures with `gnome-screenshot` if present else `scrot`, then `convert {path} -resize {x}x{y}! {path}` (the `!` forces exact size). `zoom` crops with `convert -crop` and resizes to fit the screenshot frame.

Scaling (`scale_coordinates`) — verbatim logic:
```python
MAX_SCALING_TARGETS = {"XGA": {1024, 768}, "WXGA": {1280, 800}, "FWXGA": {1366, 768}}   # chosen when |aspect - target| < 0.02 and target width < display width
x_scaling_factor = target_dimension["width"] / self.width      # < 1
if source == ScalingSource.API:
    if x > self.width or y > self.height: raise ToolError(f"Coordinates {x}, {y} are out of bounds")
    return round(x / x_scaling_factor), round(y / y_scaling_factor)   # scale up
return round(x * x_scaling_factor), round(y * y_scaling_factor)       # scale down
```
Consequences a page can measure (derived, [likely]):
- On a 1920×1080 display the model sees 1366×768 and every click maps to `round(k × 1.4056)`: reachable x values are a lattice with spacing alternating 1/2 px (columns like 1, 3, 4, 6, 7, 8, 10 ...). On 1280×800 (16:10) no scaling occurs (target equals display → factor 1). On 2560×1600 → 1280×800, factor 2: only even pixels are reachable. A histogram of `clientX mod stride` over a session separates "model pixel picks through a scale factor" from a human pointer.
- xdotool `click` is "a mousedown followed by mouseup ... with a short delay between the two (currently 12ms)" (man page) → `mousedown→mouseup` ≈ 12 ms with very low variance (human ≈ 100–120 ms, σ ≈ 30 ms per arXiv 2607.26935).
- `xdotool type --delay 12` → inter-keystroke interval ≈ 12 ms, uniform; no dwell variation; Firefox sees `keydown/keypress/input/keyup` per char.
- `xdotool mousemove` is an XTEST warp: the browser receives a single `mousemove` at the destination (a "teleport"), then press/release. There are no intermediate motion samples, `getCoalescedEvents()` is trivial, `movementX/Y` reflect the whole jump on the first event (Firefox) — [likely, verify in lab].
- Scrolling arrives as N discrete button-4/5 presses (`wheel` events with Firefox line-mode deltas, `deltaMode` likely 1 → exact per-click delta uncertain), spaced by xdotool's internal `--delay` (unspecified for scroll in the demo, so back-to-back).
- Cadence: 2.0 s fixed post-action delay + model round trip (seconds) → per-step latency is multi-second; actions inside one batched turn fire back-to-back.

### 2.3 Browser use tool (`browser_toolset_20260801`) and the SDK drivers

Sources: https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool, https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-sdk, `claude-quickstarts/browser-toolset/python/cdp_browser.py`. [confirmed]

- Client-side: "Your application runs every call against its own browser automation; nothing runs on Anthropic's side." "the sites Claude visits see your executor's network identity." No beta header in the quick start; models `claude-fable-5-1`, `claude-mythos-5-1`, `claude-fable-5`, `claude-mythos-5`, `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-5-5`, `claude-sonnet-5`, `claude-haiku-5-5`.
- 31 members (27 enabled by default): `navigate`, `screenshot`, `zoom`, `left_click`, `right_click`, `middle_click`, `double_click`, `triple_click`, `hover`, `left_click_drag`, `left_mouse_down`, `left_mouse_up`, `mouse_move`, `scroll` (`scroll_amount` 1–10, default 3), `scroll_to`, `type`, `key` (single key, chord `"ctrl+a"`, or sequence `"Backspace Backspace"`), `hold_key`, `wait`, `read_page`, `find`, `get_page_text`, `form_input`, `file_upload` (off), `read_console` (off), `read_network` (off), `javascript_exec` (off), `new_tab`, `list_tabs`, `switch_tab`, `close_tab`. Targets are `{"type":"coordinate","x":640,"y":380}` or `{"type":"ref","ref":"ref_2"}` (refs from `read_page`/`find`). "Coordinates are viewport pixels"; Claude "infers the viewport size from the screenshots you return". Halt text: `Not executed: an earlier action in this turn failed.`
- Partner drivers: "Browser Use, Browserbase, Daytona, and E2B publish their own drivers for the SDK toolsets"; Browserbase's is Stagehand (`stagehand-claude-sdk`, repo `browserbase/claude-cua-toolset`). SDK scaling example: `SCREENSHOT_SIZE = (1280, 720)`, `DISPLAY_SIZE = (2560, 1440)`.
- Reference CDP driver (`cdp_browser.py`, "isn't production code"): launches Chromium with `--remote-debugging-port=0`, `--user-data-dir=...`, `--window-size=1280,720`, `--disable-extensions`, optional `--headless=new`; enables `Page.enable`, `Page.setLifecycleEventsEnabled`, **`Runtime.enable`** (the classic CDP leak surface); `left_click` sends exactly:
  ```python
  self._send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y})
  for kind in ("mousePressed", "mouseReleased"):
      self._send("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": y, "button": "left", "clickCount": 1})
  ```
  A ref click first runs `el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })` in page JS (so the element is centered before the click: scroll position jumps without any `wheel` event). `read_page` and `get_page_text` use `Runtime.evaluate` over `document.querySelectorAll` / `document.body.innerText`, not the Accessibility domain.

### 2.4 Claude in Chrome (extension)

Sources: https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome, Chrome Web Store listing, https://claude.com/blog/claude-for-chrome, GitHub issue anthropics/claude-code#28013, arXiv 2606.30119, and the MCP tool surface exposed in this session. 

- Identity [confirmed]: Chrome Web Store `https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn` — name "Claude", developer Anthropic, version 1.0.102, updated October 21, 2026, 20,000,000 users. "Claude in Chrome is not supported on other Chromium-based web browsers or mobile devices." The arXiv study ran version 1.0.40 on Chrome 144.0.7559.96 (Jan–Feb 2026).
- Permissions and Anthropic's stated purpose [confirmed]: `debugger` — "This is what allows Claude to actually control your browser – clicking buttons, typing text, and taking screenshots when you ask it to complete tasks for you."; `scripting` — "lets Claude read text on webpages"; `system.display` — "lets Claude know the size of your screen so it can accurately click in the right places"; `tabs`, `tabGroups` (Claude's tabs go in a separately colored group), `webNavigation` ("intervene if it detects that you are on a high-risk website"), `declarativeNetRequestWithHostAccess` (identify itself **to Anthropic's servers**), `nativeMessaging` (Claude Desktop/Claude Code bridge), `alarms`, `downloads`, `storage`, `unlimitedStorage`, `sidePanel`, `notifications`, `offscreen`. The support page says nothing about identifying to websites.
- Mechanism [likely]: the debugger permission means CDP via `chrome.debugger`. Issue #28013 (user reverse-engineering, not confirmed by Anthropic) names `attachDebugger(tabId)`, `sendCommand`, `chrome.debugger.onEvent` listeners, `Page.captureScreenshot` ("on a complex page takes 20s+"), error strings `Error capturing screenshot: Detached while handling command.` and `Browser extension is not connected`, and says the non-screenshot tools (`navigate`, `javascript_tool`, `read_page`, `find`, `form_input`) "use content scripts, not the debugger API". Reported latencies: `navigate` ≈ 350 ms, first `screenshot` 2–5 s, `scroll`+`screenshot` 20 s+, tool-call timeout 120000 ms. Chrome displays its standard "is debugging this browser" infobar while `chrome.debugger` is attached (user-visible, not page-visible) [likely, general Chrome behavior].
- Tool surface observed in this very session (the `mcp__claude-in-chrome__*` tools): `computer` (actions incl. `left_click`, `right_click`, `double_click`, `triple_click`, `left_click_drag`, `key`, `type`, `screenshot`, `scroll`, `zoom`), `find`, `form_input`, `get_page_text`, `javascript_tool`, `navigate`, `read_console_messages`, `read_network_requests`, `read_page`, `resize_window`, `upload_image`, `file_upload`, `gif_creator`, `shortcuts_*`, `tabs_*`, `browser_batch` (sequential batches; "coordinates you write in THIS batch refer to the screenshot taken BEFORE this call"). The product therefore mixes coordinate clicks (CDP) with DOM-level `form_input` (sets values without key events) and `find`/`read_page` (accessibility-tree-style references). [confirmed for tool names; dispatch path per tool is inferred]
- Page-visible facts from the honeysite study [confirmed, arXiv 2606.30119 Table 11 and §6]: UA and screen are the host's (Linux Chrome 144, 1920×1080, 8 cores in the authors' setup); cookies `SHARED_WITH_HUMAN` ("extensions like Claude can inherit cookies from the user's browser"); permission states "more closely align with what we observe for our human-based visits"; JA4 identical to a human Chrome 144 (`1, 3, 11`); IP = user's. Claude Chrome "refused to solve [Prosopo CAPTCHA] in 20 separate attempts"; with Sonnet 4.5 it passed robots.txt, UA filtering and Turnstile-protected honeysites, with Opus 4.5 it was "less capable". Safety blog: blocked categories "financial services, adult content, and pirated content"; confirmation before "publishing, purchasing, or sharing personal data"; prompt-injection ASR 23.6% → 11.2% (autonomous mode), browser-specific set 35.7% → 0%.
- No Web Bot Auth: `https://claude.ai/.well-known/http-message-signatures-directory`, `https://www.anthropic.com/...` and `https://api.anthropic.com/...` all returned 404 on 2026-10-24. [confirmed]

---

## 3. OpenAI

### 3.1 Timeline (what is live in October 2026)

| Date | Event | Source |
|---|---|---|
| 2025-01-23 | Operator research preview (Pro, US) at operator.chatgpt.com, powered by the Computer-Using Agent (CUA) model; Operator System Card published | openai.com/index/computer-using-agent, openai.com/index/operator-system-card [confirmed] |
| 2025-03 | `openai-cua-sample-app` published; `computer-use-preview` model in the Responses API | GitHub commit history [confirmed] |
| 2025-05-15 | Cloudflare Web Bot Auth post quotes OpenAI: "OpenAI signs all Operator requests so site owners can verify they genuinely originate from Operator" (RFC 9421); then-`signature-agent` host `operator.openai.com` | blog.cloudflare.com/web-bot-auth [confirmed]; `operator.openai.com` no longer resolves (DNS `ENOTFOUND` on 2026-10-24) |
| 2025-07-17 | ChatGPT agent launched (Pro/Plus/Team): visual browser + text browser + terminal + API access on "its own virtual computer"; "The Operator research preview site will remain functional for a few more weeks, after which it will be sunset" | openai.com/index/introducing-chatgpt-agent [confirmed] |
| 2025-08-28 | Cloudflare "Signed Agents": first cohort "ChatGPT agent (OpenAI), Goose (Block), Browserbase, Anchor Browser, Cloudflare Browser Rendering" | blog.cloudflare.com/signed-agents [confirmed] |
| 2025-10-21 | ChatGPT Atlas (macOS only) with agent mode | Wikipedia, Simon Willison [confirmed] |
| 2026-07-09 | ChatGPT Work and the unified desktop app with a built-in browser; Atlas deprecation announced | ppc.land, 9to5mac, Prosopo [likely] |
| ~2026-08 | ChatGPT "agent mode" removed from ChatGPT; users pointed to ChatGPT Work and "a separate cloud browser feature" | Wikipedia snippet via search, Prosopo [likely, single-sourced] |
| 2026-08-09 | Atlas switched off ("chatgpt.com/atlas now loads the ordinary ChatGPT page"); OpenAI help article "ChatGPT Atlas retirement": "ChatGPT Atlas has been retired and no longer receives updates." | Prosopo; help.openai.com/en/articles/20001371 [confirmed] |
| 2026-10 | "ChatGPT Work's Cloud browser" is the live hosted agent; its allowlisting article was "Updated: 5 days ago" on 2026-10-24 | help.openai.com/en/articles/11845367 [confirmed] |

The July 2025 launch post now carries the banner "This launch post is outdated. For current agentic work and team workflows, explore: Workspace agents, ChatGPT Work".

### 3.2 How OpenAI's hosted agent identifies itself (official text)

OpenAI help article "ChatGPT Work's Cloud browser allowlisting" (https://help.openai.com/en/articles/11845367-chatgpt-works-cloud-browser-allowlisting), read 2026-10-24 [confirmed]:

- "ChatGPT Work's Cloud browser uses Web Bot Auth to sign outbound HTTP requests, allowing website operators to verify that requests genuinely originate from ChatGPT."
- "Each request includes: A Signature header. A Signature-Input header. A Signature-Agent header set to "https://chatgpt.com"."
- Keys: `https://chatgpt.com/.well-known/http-message-signatures-directory`.
- Vendor labels: Akamai "bot name ChatGPT Agent in its Artificial Intelligence bots category"; Cloudflare "Bot tag: chatgpt-agent", "Detection ID: 129220581", shown in the dashboard as "ChatGPT Operator"; HUMAN Sightline/AgenticTrust "ChatGPT Agent"; Vercel "ChatGPT Agent entry, identified as chatgpt-operator".
- Capability statement: "at launch, Cloud browser cannot sign in to websites or complete payments."
- Verification recipe for other CDNs: "Confirm the Signature-Agent header exactly matches "https://chatgpt.com", including the quotation marks." Troubleshooting: make sure proxies preserve `Signature`, `Signature-Input`, `Signature-Agent`.

Live key directory, probed 2026-10-24 with `curl` [confirmed]:
```
GET https://chatgpt.com/.well-known/http-message-signatures-directory
HTTP/2 200
content-type: application/http-message-signatures-directory+json
cache-control: no-store, no-transform
signature-input: sig1=("@authority";req "content-digest");created=1792881611;expires=1792968011;keyid="ArwjqcCqtA5oxEWkzXGC-To_0A9whHmajCHtfe8I9aY";tag="http-message-signatures-directory";alg="ed25519"
signature: sig1=:7k7KCbusf4caGqNnl2K4yG2nQFQZJgCounq2qPt1qIIRm2p8v+wLXYG3PjEw2PCKx+41rVAJfS2rKeiVmfz/Cg==:

{"keys":[{"crv":"Ed25519","kty":"OKP","x":"P_1c4SX6fCavDcq6FRegWcVvaOKsp_aXHPEN1FcKDIA","kid":"ArwjqcCqtA5oxEWkzXGC-To_0A9whHmajCHtfe8I9aY","use":"sig","nbf":1735689600,"exp":1793486411}],"signature_agent":"https://chatgpt.com","purpose":"ai"}
```
`nbf` = 2025-01-01T00:00:00Z; `exp` ≈ 2026-10-31 (a week after the probe, and the `exp` value differed between two probes minutes apart, i.e. it is a rolling window: do not pin the key, re-fetch). Note the directory is served `no-store`.

Request-side observations:
- Simon Willison, 2025-08-04 (ChatGPT agent hitting his site) [confirmed]: `User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36`; `Sec-Ch-Ua: "Not)A;Brand";v="8", "Chromium";v="138"`; **`Sec-Ch-Ua-Platform: "Linux"`** (a macOS UA on a Linux client); `Signature-Agent: "https://chatgpt.com"`; `Signature-Input: sig1=("@authority" "@method" "@path" "signature-agent");created=1754340838;...keyid=...;nonce=...;tag="web-bot-auth";alg="ed25519"`; `Cf-Connecting-Ip: 2a09:bac5:665f:1541::21e:154`, `Cf-Ipcountry: US`.
- Castle (mid-2025, "OpenAI Operator") [confirmed]: same Mac Chrome/138 UA; `Signature-Input: sig1=("@authority" "@method" "@path" "signature-agent")` + `created`, `expires`, `keyid`; `navigator.webdriver` not set; "No CDP artifacts"; TLS and JS environment match stock Chrome; "`navigator.platform` may differ between the main thread and a web worker".
- cloudless.sh (12-hour window, 2026) [confirmed]: OpenAI signer `chatgpt.com`, covered components `@authority @method signature-agent`, validity ≈ 1 hour, nonce present, "Ordinary Chrome" UA, `Signature-Agent` sent "in the legacy bare-string form" (`"https://chatgpt.com"`), all ed25519, verified against the published key.
- OpenAI community thread (2026) [uncertain]: requests labeled `ChatGPT-Agent` carrying `Signature`/`Signature-Input` with `alg="ed25519"`, `tag="web-bot-auth"` but User-Agents `Python-urllib/3.12`, `python-requests/2.34.2`, `curl/8.5.0` — consistent with the agent's terminal/text-browser tools also being signed. No OpenAI staff reply.
- Seer Interactive / CHEQ, early 2025 [likely]: Operator "identified itself as a Linux operating system using Chrome" while testers were on Windows; that quirk "is now obsolete"; GA4 saw `direct / (none)` or Bing organic/cpc; "We couldn't open the developer console in Operator".
- OpenAI's own crawler page lists no agent UA; `ChatGPT-User/1.0` (`Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot`, IPs at `https://openai.com/chatgpt-user.json`) is a different fetcher and "is not used for crawling the web in an automatic fashion". There is **no published IP list for the cloud browser** (aicrawlercheck, centinelanalytica) [confirmed].

### 3.3 Hosted-browser environment fingerprint (ChatGPT agent, Jan–Feb 2026 measurements)

From Fayolle et al., "On the Internet, Nobody Knows You're an LLM Bot" (arXiv:2606.30119, honeysites, tests on 2026-01-28, 02-08, 02-09) [confirmed]:
- Browser: Chromium 141.0.7390.122; UA `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36`; "ChatGPT Agent exposes a unique Chrome version and platform combination".
- Screen: "fixed screen resolution of 1280 × 960, having a V-Score of 1" (unique in the dataset). CPU cores: 13. Permissions: "the majority of permission queries through the API navigator.permissions.query fail for Crawl4AI and ChatGPT Agent" (Table 11 shows `NS` for 12 of 13 permissions and `d` for the last). Cookies: `REUSED_COOKIE` — "ChatGPT Agent, Skyvern, and OpenClaw share cookies across multiple sessions to use a continuous user identity". Headers: `signature` and `signature-agent` (`https://chatgpt.com`).
- Network: 1 ASN, IP hosting proportion 0.88, abuser proportion 0.14; "ChatGPT Agent always visited our honeysites from the Cloudflare infrastructure located in the European Union". (Simon Willison's IPv6 `2a09:bac5::/32`-area address is also Cloudflare space [likely].)
- TLS: "ChatGPT Agent only establishes TCP connections and advertises 28 cipher suites, which is more than most evaluated tools, while exposing only 12 TLS extensions"; its dominant JA4 (index 18) was unique and "ChatGPT Agent was perfectly classified using only its JA4 fingerprint".
- Anti-bot outcomes (Table 3): accessed sites with no defense, robots.txt, UA filtering, reCAPTCHA v3, Prosopo, Anubis, and Cloudflare "BFM & Block AI Bots"; **blocked by Turnstile** and by the combined configuration B. Behaviors: "ChatGPT Agent may attempt to retrieve its user-agent string either through an external website or by opening a terminal. When facing Turnstile, ChatGPT Agent sometimes navigates to alternative honeysites ... and clicks buttons associated with the protected site". The agent does not adapt its UA/headers even when prompted to.
- Volume: DataDome Q3-2026 report (via mediacopilot.ai): "ChatGPT's cloud browser made 27.4 million requests in September" 2026 [likely].

HUMAN's profile (https://www.humansecurity.com/ai-agent/chatgpt-agent/) [confirmed]: "Useragent: Generic Chrome", "robots.txt Compliance: No", "Authentication: HTTP Message Signatures (RFC 9421)", "Early in its release, ChatGPT Agent was shown to be capable of solving simple CAPTCHA challenges", "Right now, that process isn't faster than a human", and in AgenticTrust "By default, it is permitted to read, log in, and make purchases."

### 3.4 Operator / CUA mechanics and safety behavior (vendor statements)

- CUA post [confirmed]: "CUA processes raw pixel data to understand what's happening on the screen and uses a virtual mouse and keyboard to complete actions." Loop = Perception (screenshots) → Reasoning (chain-of-thought) → Action ("clicking, scrolling, or typing"). "CUA seeks user confirmation for sensitive actions, such as entering login details or responding to CAPTCHA forms." Benchmarks: OSWorld 38.1%, WebArena 58.1%, WebVoyager 87.0%. Mitigations: refusals; "Blocklist: Operator cannot access websites that we've preemptively blocked, such as many gambling sites, adult entertainment, and drug or gun retailers"; "Watch mode: On particularly sensitive websites, such as email, Operator requires active user supervision"; "Monitoring: ... an additional model to monitor and pause execution if it detects suspicious content on the screen"; "CUA is not precise at text editing."
- Operator System Card [confirmed]: confirmations recall 92% on 607 risky tasks ("reduced the risk by approximately 90%"); autonomy evals run in "a macOS desktop environment" with "a maximum of 400 steps"; the model "would almost always decide to read the text visually from the screen (instead of copying and pasting it)" → OCR errors; prohibition on users "bypassing any protective measures implemented in OpenAI services, including rate limits".
- ChatGPT agent post [confirmed]: tools = "a visual browser that interacts with the web through a graphical-user interface, a text-based browser for simpler reasoning-based web queries, a terminal, and direct API access"; "you can log in on any website by taking over the browser"; "Secure browser takeover mode: ... ChatGPT does not collect or store any data you enter during these sessions, such as passwords"; "cookies persist based on each visited website's cookie policies"; "Watch Mode" for emails; refuses "bank transfers"; benchmark environment "OSX environment and LibreOffice" for SpreadsheetBench (the hosted computer for spreadsheet work was macOS-like at the time; the browser itself reports Linux client hints — treat OS as **uncertain**).

### 3.5 CUA API and the sample apps (what a developer-run CUA looks like)

Old sample app (commit `a8a75a30`, 2025-04-08) [confirmed from source]:
- Tool definition: `{"type": "computer-preview", "display_width": dimensions[0], "display_height": dimensions[1], "environment": computer.get_environment()}` with `environment ∈ {"windows", "mac", "linux", "browser"}`, model `computer-use-preview`, `truncation="auto"`, `pending_safety_checks` must be echoed as `acknowledged_safety_checks`, `current_url` returned for browser environments and checked against a blocklist.
- Action protocol: `click(x, y, button)`, `double_click`, `scroll(x, y, scroll_x, scroll_y)`, `type(text)`, `wait(ms=1000)`, `move(x, y)`, `keypress(keys)`, `drag(path)`, `screenshot()`.
- `LocalPlaywrightComputer`: `chromium.launch(chromium_sandbox=True, headless=False, args=["--window-size=1024,768", "--disable-extensions", "--disable-file-system"], env={"DISPLAY": ":0"})`, `get_dimensions() = (1024, 768)`, `page.set_viewport_size`, starts at `https://bing.com`, no UA override.
- `BasePlaywrightComputer` dispatch: `click` → `page.mouse.click(x, y, button=...)` (`"back"`/`"forward"` buttons navigate history; `"wheel"` → `page.mouse.wheel(x, y)`); `double_click` → `page.mouse.dblclick`; **`scroll` → `page.mouse.move(x, y)` then `page.evaluate(f"window.scrollBy({scroll_x}, {scroll_y})")`** (programmatic scroll, no `wheel` event); `type` → `page.keyboard.type(text)` (no per-key delay); `keypress` → `keyboard.down` for each mapped key then `keyboard.up` in reverse; `drag` → `mouse.move(p0)`, `mouse.down()`, `mouse.move(p_i)...`, `mouse.up()`; `screenshot` → `page.screenshot(full_page=False)`.
- `DockerComputer`: `xdotool mousemove {x} {y} click {b}` (`button_map = {"left": 1, "middle": 2, "right": 3}`), double click `click --repeat 2 1`, **scroll = `xdotool click 4|5` repeated `abs(scroll_y)` times** (so the model's `scroll_y` is treated as wheel clicks, `scroll_x` ignored), `xdotool type -- '{text}'` with **no `--delay`** (xdotool default 12 ms applies), `xdotool key {combo}`, drag `mousemove sx sy mousedown 1 ... mouseup 1`, screenshot `import -window root png:- | base64 -w 0`, default dimensions `(1280, 720)` replaced by `xdotool getdisplaygeometry`, `wait()` 1000 ms, README runs the container with `--dns=1.1.1.3` "to restrict accessible websites to a smaller, safer set".
- Current docs (https://developers.openai.com/api/docs/guides/tools-computer-use, 2026): tool is `{ type: "computer" }`; items `computer_call` / `computer_call_output` / `computer_screenshot`; actions "`click`, `double_click`, `drag`, `move`, `scroll`, `keypress`, `type`, `wait`, or `screenshot`"; batched example `{ "type": "click", "button": "left", "x": 405, "y": 157 }`; Playwright examples use `viewport: { width: 1024, height: 768 }`; the JavaScript code-execution tool says "The context viewport is 1440x900"; models `gpt-6.1-sol` (computer tool) and `gpt-6-astra`; "Treat screen content as untrusted"; "Use a fresh browser profile or isolated desktop". Current sample app (`python-app/app/browser.py`): Chromium launched with `--remote-debugging-address=127.0.0.1 --remote-debugging-port=0 --no-startup-window --no-first-run --no-default-browser-check --window-size=1440,900`, `DEFAULT_VIEWPORT = {"width": 1440, "height": 900}`, `connect_over_cdp`, headful only ("Local PyAutoGUI requires a visible browser."); desktop runtime is a PyAutoGUI worker (OS-level input, 60 s execution timeout). [confirmed]

### 3.6 ChatGPT Atlas (retired 2026-08-09) — still worth knowing because the desktop app inherited the approach

- Vendor statements (via Simon Willison quoting OpenAI's help page) [confirmed]: agent mode "Cannot run code in the browser, download files, or install extensions", cannot access "other apps on your computer or your file system" or saved passwords/autofill; "Pages ChatGPT visits in agent mode are not added to your browsing history"; logged-out mode: "won't use any pre-existing cookies"; "ChatGPT is trained to ask before taking many important actions"; ARIA labels and roles are used "to interpret page structure and interactive elements".
- UA [confirmed]: page loads use a stock macOS Chrome UA with no Atlas token — `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36` (chrisrcook.com, Oct 22 2025) and `.../Chrome/142.0.0.0 Safari/537.36` (HUMAN). `navigator.userAgentData.brands` = `[{"brand":"Chromium","version":"142"},{"brand":"Google Chrome","version":"142"},{"brand":"Not_A Brand","version":"99"}]`.
- Side-channel UA [confirmed]: favicon/logo requests from the sidebar preview use an Apple CFNetwork client: pattern `ChatGPT%20Atlas/2025xxxx CFNetwork/xxxx.x Darwin/xx.x.x` (aisearchoptimization.in; HUMAN: "A user agent string associated with ChatGPT Atlas" + "A CFNetwork signature").
- Architecture (HUMAN) [likely]: "the agent and its control logic operate outside of Chromium and communicate with it through OWL, OpenAI's Web Layer ... The two processes exchange data through native inter-process communication (no JavaScript injection)". Page-visible divergence: "Standard Chrome exposes a list of Google TTS voices. Comet preserves these voices. Atlas does not surface them in the same way." `atlas://extensions` appears empty.
- CDP/automation flags: none reported; Castle did not test Atlas. Status now: retired; successors are the ChatGPT desktop app's built-in browser (macOS/Windows 2026-07-09, Linux preview 2026-08-14) and a ChatGPT Chrome extension — **no published identification for either** (Prosopo: the extension "does not announce itself with a distinctive browser build") [likely].

---

## 4. Google

### 4.1 Gemini Computer Use API (developer-run)

Sources: https://ai.google.dev/gemini-api/docs/interactions/computer-use, https://ai.google.dev/gemini-api/docs/generate-content/computer-use (labelled Legacy), https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/computer-use. [confirmed]

- Legacy/Gemini-3-Flash action set: `open_web_browser`, `wait_5_seconds`, `go_back`, `go_forward`, `search`, `navigate(url)`, `click_at(x,y)`, `hover_at(x,y)`, `type_text_at(x,y,text, press_enter=True, clear_before_typing=True)`, `key_combination(keys)`, `scroll_document(direction)`, `scroll_at(x,y,direction, magnitude=800)`, `drag_and_drop(x,y,destination_x,destination_y)`. Coordinates: "The x and y values are based on a 1000x1000 grid and are scaled to the screen dimensions"; denormalize `int(x / 1000 * screen_width)` (JS: `Math.floor((x / 1000) * screenWidth)`).
- Newer action set (Gemini 3.5 Flash and later, `ENVIRONMENT_BROWSER`): `click`, `double_click`, `triple_click`, `middle_click`, `right_click`, `mouse_down`, `mouse_up`, `move`, `drag_and_drop`, `type(text, press_enter=false)`, `press_key`, `key_down`, `key_up`, `hotkey(keys)`, `wait(seconds=1)`, `take_screenshot`, `scroll(direction, magnitude_in_pixels=300)`, `go_back`, `navigate(url)`, `go_forward`; all actions carry an `intent` string. Docs are internally inconsistent about pixel vs 0–999 coordinates; the sample code uses 0–999. Sample screen sizes 1440×900 (ai.google.dev) and 1920×1080 (Cloud docs). Models listed in Oct 2026: `gemini-4-argon`, `gemini-3.8-flash` ("The recommended model for computer use"), `gemini-3.5-flash-lite`, `gemini-3-flash-preview`; the 2025 preview id `gemini-2.5-computer-use-preview-10-2025` is no longer on the page [likely from search snippets].
- Playwright sample dispatch: `page.mouse.click(actual_x, actual_y)` (`button="right"|"middle"`), `page.mouse.dblclick`, `page.mouse.move`, type = optional click, `page.keyboard.press("Meta+A")`, `page.keyboard.press("Backspace")`, `page.keyboard.type(text)`, `page.keyboard.press("Enter")` if `press_enter`; `page.goto`, `go_back`, `go_forward`; `time.sleep(args.get("seconds", 1))`. The sample does not implement `scroll` (no `page.mouse.wheel`).
- Safety: `safety_decision` with `decision: "require_confirmation"` and `explanation`; client echoes `safety_acknowledgement: true`; policies `FINANCIAL_TRANSACTIONS`, `SENSITIVE_DATA_MODIFICATION`, `COMMUNICATION_TOOL`, `ACCOUNT_CREATION`, `DATA_MODIFICATION`, `USER_CONSENT_MANAGEMENT`, `LEGAL_TERMS_AND_AGREEMENTS`; sample system instruction under "Robot Detection": "You MUST NEVER attempt to solve or bypass the following" — "CAPTCHAs (of any kind)"; terms: "not to automatically bypass or circumvent any safety responses requiring end user human confirmation".
- Derived page-visible effect [likely]: a `type_text_at` leaves the signature sequence click → `Meta+A`/`Ctrl+A` → `Backspace` → text → `Enter`; `click_at` lands on an `int()`-truncated lattice (stride = width/1000: 1.44 px at 1440, 1.92 px at 1920 — roughly every other column unreachable at 1080p).

### 4.2 Project Mariner → Gemini agent / Spark; Google-Agent identity

- Timeline [confirmed]: research-prototype Chrome extension 2024-12-11 (screenshots of the active tab; "visibly moving the cursor, clicking, and typing while the user watched" — HUMAN); 2025-05-20 cloud version ("Google runs Mariner in browsers on virtual machines", "up to roughly ten simultaneous tasks"); "Project Mariner was discontinued on May 4, 2026" (Wikipedia); labs.google.com/mariner/landing now only shows a sign-in. Successors: Gemini app agent (Gemini Spark), Chrome auto browse, AI Mode agentic features [likely].
- HUMAN profile [confirmed]: "User Agent: Generic Chrome", "Authentication: No", "Robots.txt Compliance: No", "There is no signed identity signal today", "It presents as a normal Chrome browser from Google infrastructure or end-user environments."
- **Google-Agent** (https://developers.google.com/crawling/docs/crawlers-fetchers/google-agent) [confirmed]: "is used by agents hosted on Google infrastructure to navigate the web and perform actions upon user request." Desktop UA: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko; compatible; Google-Agent; +https://developers.google.com/crawling/docs/crawlers-fetchers/google-agent) Chrome/W.X.Y.Z Safari/537.36`. Mobile UA: `Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/W.X.Y.Z Mobile Safari/537.36 (compatible; Google-Agent; +https://developers.google.com/crawling/docs/crawlers-fetchers/google-agent)`. IP ranges: `https://developers.google.com/static/crawling/ipranges/user-triggered-agents.json` (on 2026-10-23: 20 prefixes — 8 IPv6 `2001:4860:c::/124` … `2001:4860:c::70/124`, IPv4 `136.121.16.0/24`, `136.121.24.0/21`, `136.121.40.0/21`, `136.122.0.0/16`, `74.125.232.0/28`, `74.125.232.112/28`, `74.125.232.16/28`, …). robots.txt: "these fetchers generally ignore robots.txt rules". "The user agent string can be spoofed." Reverse DNS masks for user-triggered fetchers: `***-***-***-***.gae.googleusercontent.com` (Google-owned) or `google-proxy-***-***-***-***.google.com` (user-owned). Web Bot Auth: "Google is also experimenting with the Web Bot Auth protocol" "using the `https://agent.bot.goog` identity"; centinelanalytica observed `Signature-Agent: g="https://agent.bot.goog"` (dictionary form) on some requests and says not all requests are signed [likely]. Google's docs do **not** say which products emit Google-Agent (Gemini agent mode / Spark / AI Mode are the obvious candidates) [uncertain].
- Live directory probe 2026-10-24 [confirmed]:
```
GET https://agent.bot.goog/.well-known/http-message-signatures-directory
HTTP/2 200   content-type: application/http-message-signatures-directory+json   cache-control: public, max-age=3600   server: ESF
signature-input: g=("@authority";req);created=1792881611;expires=1792881911;keyid="DYiMjA";alg="ed25519";tag="http-message-signatures-directory"
{"keys":[{"alg":"EdDSA","crv":"Ed25519","key_ops":["verify"],"kid":"mhxuPw","kty":"OKP","use":"sig","x":"X53rIypL6muU_xeVU6Vm0uoGQcKKxm5FCRIFZHR0CZA"}, {"kid":"cYSMkA",...}, {"kid":"bUCe2A",...}, {"kid":"DYiMjA",...}, {"kid":"Ggh50g",...}]}
```
Note the short `kid`s are **not** RFC 7638 thumbprints (the IETF draft says `keyid` "MUST be a base64url JWK SHA-256 Thumbprint"), and the signature label is `g=` rather than `sig1=`; a verifier must match `keyid` against the directory's `kid` values literally rather than recomputing thumbprints.

### 4.3 Gemini in Chrome auto browse (local)

- Jan 28 2026 post ("The new era of browsing: Putting Gemini to work in Chrome") [confirmed]: auto browse "handles multi-step chores on your behalf" (forms, quotes, expense reports, carts with discount codes, "Filling in forms with information from a PDF"), "designed to pause and explicitly ask for your confirmation" before purchases or posting, can use Google Password Manager for sign-in with permission; "AI Pro and Ultra subscribers in the U.S."; Chrome will support the Universal Commerce Protocol (UCP). Android: May 12 2026 (Pro/Ultra), all US Android users Aug 18 2026. Nothing about where the browser runs or identification; centinelanalytica: runs in a tab of the user's Chrome; "Gemini Spark may use a separate remote browser instance when the device is unavailable" and the help page "doesn't say whether the remote browser sends Google-Agent" [likely].

---

## 5. Perplexity Comet (local agentic browser)

Sources: Castle "From detection to trust" (https://blog.castle.io/from-detection-to-trust-the-evolving-challenge-of-ai-bot-authentication/), HUMAN blog + profile, Wikipedia, Perplexity "Bullying is not innovation", Prosopo, 4sysops (search snippet only; the article itself sits behind a bot challenge).

- Product facts [confirmed]: Chromium/Blink fork; Windows & macOS 2025-07-09, free download Oct 2025, Android 2025-11-20, iOS 2026-03-18. Credentials "are stored securely only in your device"; Perplexity's position: a user agent "acts solely on your behalf" and should be "indistinguishable from you"; "works only at your specific request".
- UA/Client Hints [confirmed]: identical to Chrome. HUMAN: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36` with brands `Chromium 142 / Google Chrome 142 / Not_A Brand 99`; 4sysops (Aug 2025, snippet): "Instead of identifying with its own user agent, it masquerades as Chrome/139.0.0.0". Castle: "No obvious globals such as `window.brave`". HUMAN's profile line "Chromium-based UA strings with Perplexity-specific headers" names no header — treat the "Perplexity-specific headers" claim as **uncertain**.
- Hidden internal extension [confirmed, Castle + HUMAN]: `chrome://extensions` redirects to `comet://extensions` and shows nothing, but DevTools shows `comet-extension://npclhjbddhklpbnacpjloidibaggcgon/background.js`, content script `comet-agent/content.js` with `const B = "npclhjbddhklpbnacpjloidibaggcgon";`, and `overlay.js` active in agent mode. HUMAN: the extension is "responsible for: Highlighting elements on the page; Displaying visual overlays and progress indicators; Blocking or intercepting user interactions while the agent is working; Capturing screenshots and state for the assistant UI" and "is implemented inside the browser's renderer process".
- DOM artifacts [confirmed, Castle]: `const p = "pplx-agent-overlay", O = "pplx-agent-overlay-stop-button";` an element with id `pplx-agent-overlay-stop-button` labelled "Stop Comet Assistant" is appended via `document.body.appendChild(i)`; detectable with `new MutationObserver(...).observe(document.body, { childList: true, subtree: true })` and `node.id === 'pplx-agent-overlay-stop-button'`. Style overrides are applied with `Object.assign(s.style, { position: "fixed", inset: "-1em", ... })`, including `opacity: "0"` and `cursor: "progress"`. Passive test that works "whether the agent is active or not": create a div with id `pplx-agent-overlay-stop-button` styled `background-color: blue` and check `getComputedStyle(div).backgroundColor === 'rgb(255, 254, 251)'` (Comet's injected stylesheet wins). [confirmed as of the Castle test date; selectors may change]
- Input path [confirmed, Castle]: background script calls `chrome.debugger.sendCommand` with `"Input.dispatchMouseEvent"`, `type: "mousePressed"`, `button: "left"`, `clickCount: 1`. "In agent mode, mouse movement is simulated with no `mousemove` events, only clicks. This produces impossible cursor 'teleports' between clicks." Events are `isTrusted: true` (CDP path).
- Network [confirmed]: local machine, user's residential IP, user's cookies; screenshots are sent to Perplexity's servers (court record via centinelanalytica). No key directory at perplexity.ai (404 on 2026-10-24). Prosopo: "A Comet session is a real Chromium engine on a consumer connection", fetches "Everything a browser fetches".
- Legal/behavioral context [confirmed]: Amazon sued alleging Comet disguised itself as Chrome; Amazon "deployed a technical block in August 2025 that Perplexity got around with a software update within 24 hours"; preliminary injunction 2026-03-09/10, vacated by the Ninth Circuit 2026-08-04 ("it is Amazon's customers—not Perplexity—that access Amazon's computer systems"). HUMAN observed a Comet session with "rapid card additions, repeated payment attempts, and a fallback to loyalty-point redemption" (carding-like). Prompt-injection history: Brave disclosure Aug 2025, "CometJacking" (LayerX).

## 6. Manus

Sources: https://manus.im/docs/features/cloud-browser.md, https://manus.im/docs/features/browser-operator.md, https://manus.im/docs/integrations/manus-browser-operator.md, ZenML case study, Wikipedia. 

- Cloud browser [confirmed]: "Manus's dedicated browser environment that runs in the cloud"; "Cloud Browser operates from data center IP addresses, not residential IPs"; "a separate, isolated browser instance" per user; "Manus doesn't store your passwords"; Take Over for "SMS codes, CAPTCHA, multi-factor authentication"; data-center IPs "may cause additional verification (CAPTCHA, security checks)"; "Certain services may flag the activity as automated". Nothing on UA, headers or screen size. ZenML (Manus engineering talk) [likely]: each task gets "a dedicated VM with a complete Linux environment", "A real Chromium browser" (not headless), Manus "only implemented the browser communication protocol layer" of browser-use; per step the model receives viewport text, a screenshot, and a screenshot "with bounding boxes overlaid to indicate clickable elements"; "an average Manus task requires 30-50 steps"; a Tokyo office search took ≈24 minutes end-to-end (≈30–50 s per step). Earlier wiki claims of E2B/Firecracker microVMs are **uncertain**.
- Browser Operator (local) [confirmed]: "a browser extension that enables Manus to operate directly within your local browser environment"; "Chrome and Edge are currently recommended"; Manus "works in a dedicated tab" in a task-named tab group; "You must authorize every session"; requests come from your "local IP address" and activity "appears as coming from your local machine" and can "clear standard access barriers automatically"; "Some websites with aggressive anti-bot measures may require manual intervention"; "Complex interactions (drag-and-drop, multi-step forms) may not work perfectly"; beta for Pro/Plus/Team. Permissions/dispatch mechanism not documented (**uncertain**; the tab-group + "dedicated tab" pattern mirrors Claude in Chrome, suggesting `chrome.debugger`).
- Identity: no directory at `manus.im` (404); Fingerprint's marketing lists "Manus" among signed AI agents it can verify — contradiction, so Manus signing is **uncertain** (possibly a different signer domain).
- Corporate: Meta acquisition announced Dec 2025, blocked by China's NDRC 2026-04-27, Meta cut ties 2026-06-15, Manus independent 2026-08-11 [confirmed, Wikipedia].

## 7. Amazon Nova Act

Source: https://raw.githubusercontent.com/aws/nova-act/main/README.md [confirmed].

- "Nova Act comes with Playwright's Chrome and Chromium browsers. These use the default User Agent set by Playwright." "Nova Act works best with Google Chrome"; `headless (bool)` "defaults to `False`"; "Nova Act is optimized for resolutions between `864×1296` and `1536×2304`" (the README writes the pairs this way; it also accepts `screen_width`/`screen_height`, e.g. 1920×1080).
- Self-identification statement: "If you are using our browsing environment defaults, look for `NovaAct` in the user agent string to identify our agent. If you operate Nova Act in your own browsing environment or customize the user agent, we recommend that you include that same string." The exact token format (e.g. `NovaAct/<version>` suffix) is **uncertain** — not shown in the README; the SDK is closed-source.
- Infra: `cdp_endpoint_url`/`cdp_headers` to attach to an external browser (AgentCore Browser Tool, "fully managed cloud-based browser automation solution"); "Chrome does not allow CDP connections into instances started with the system default user_data_dir"; `user_data_dir` is cloned per instance; `proxy` "is not supported when connecting to a CDP endpoint or using the default Chrome browser"; `storage_state` cookie restore. Developers can drive `nova.page` (Playwright `Page`) directly, so credential typing often happens via Playwright `fill()` outside the model loop.
- Derived: expect Playwright input semantics (section 11.3) plus a `NovaAct` UA token when defaults are used.

## 8. Microsoft

### 8.1 Magentic-UI / MagenticLite (open source, Playwright)

Sources: `src/magentic_ui/tools/playwright/playwright_controller_fara.py`, `utils/animation_utils.py`, `browser/local_playwright_browser.py`, README [confirmed].
- Click: `page.mouse.click(x, y, delay=10)` (10 ms press), right/triple via `button="right"` / `click_count=3`, `page.mouse.dblclick`; hover `page.mouse.move(x, y)`; fill: click → 50 ms → optional Ctrl/Cmd+A, Backspace → `keyboard.type` with **100 ms per key under 100 chars, 10 ms otherwise** → Enter by default; scroll: `page.mouse.wheel`, **400 px default**, page scroll = viewport height − 50; keypress via `CUA_KEY_TO_PLAYWRIGHT_KEY` with down/up in reverse; drag `mouse.down()` → `mouse.move(end)` → `mouse.up()`; viewport default `1440×900`.
- DOM artifacts when animation is on: `div#red-cursor` (10 px dot, `radial-gradient(circle at center, #fff 20%, #f00 100%)`, `pointerEvents = 'none'`, `zIndex = '10000'`, `transition: left 0.05s linear, top 0.05s linear`) moved in 10–20 linear steps with 20–50 ms sleeps; target highlight `elm.style.border = '2px solid red'` on `[__elementId='...']` (set-of-marks attribute). Cleanup removes them.
- Launch: `--disable-extensions`, `--disable-file-system`, `channel` chrome/msedge optional, and a **hardcoded Windows 10 x64 Chrome/Edge 122 UA** in the non-persistent path. Current repo: "MagenticLite", browser sessions "run inside a lightweight VM sandbox" (Quicksand), browser-use model "Fara".

### 8.2 Edge Copilot Mode / Actions

Source: https://blogs.windows.com/msedgedev/2025/07/28/introducing-copilot-mode-in-edge-a-new-way-to-browse-the-web/ [confirmed for July 2025]: opt-in experimental mode on Edge for Windows and Mac; "Starting today, Copilot in Edge supports natural voice navigation"; coming: "give Copilot permission to access the additional browser context it needs, such as your history and credentials" to take actions such as making a booking; "there will always be clear, visual cues on your browser when Copilot is viewing or listening". No statement about identification to websites. Current (Oct 2026) "Copilot Actions" mechanics could not be verified (search budget exhausted; explore.microsoft.com and Microsoft Learn pages fetched only mention Journeys) — **uncertain**; assume local Edge, user's UA/IP.

## 9. H Company (Runner H / Surfer-H / Holo), Simular, Genspark, Convergence, MultiOn

- H Company [confirmed from hub.hcompany.ai]: Agents API environments `{"kind": "web", "host": "cloud" | "user_device"}`; cloud browser visual viewport defaults `width: 1200`, `height: 1200`; `start_url` default `https://www.bing.com`; `network`: `managed_proxy` or `proxy_url`; browser profiles and vaults (secrets filled by `fill_secret_at` — "The value goes straight into the page, never into the agent's context"); local control: "The SDK attaches to a Chrome with remote debugging open on port `9222`" or launches one with profile `~/.hai/chrome-profile` ("The SDK never touches your everyday Chrome profile"); HoloTab free Chrome extension; Holo4 models (OSWorld 85.2%). Runner H / Surfer-H names no longer appear on the homepage. No UA or identity statements.
- Simular [confirmed from platform.simular.ai]: Sai runs on "a Windows or Linux cloud computer that Simular hosts, or on your own Mac or Windows PC", works "by seeing the screen, clicking and typing"; sign-ins and phone checks "go to the human as an approval link"; `POST https://api.simular.ai/v1/agents/message` with `autonomous` flag and approval events (`approvalType: "exec"`). No UA/identity info; input is OS-level on a desktop (expect trusted events with model cadence).
- Genspark: genspark.ai returns 403 to fetchers; no directory; **unknown**.
- Convergence "Proxy": convergence.ai returns 403; **unknown** (status as of 2026 unverified).
- MultiOn: `multion.ai` now 301-redirects to `theagi.company` (AGI Inc., "AGI-0" on-device Android action model) — the web-agent product appears discontinued/pivoted [confirmed redirect; interpretation likely]. "Please" (please.ai) not verified.
- Meta Muse (new, 2026; not in the original list but a hosted agent at scale) [likely, DataDome Q3-2026 via mediacopilot.ai]: 19.5 M requests in its first nine days; 99.3% of sampled requests from cloud/CDN infrastructure; 8.9% reached "login pages, payment systems, account creation, and online forms"; Fingerprint: it "logs in, shops, and browses for its users without identifying itself".

## 10. Hosted-browser infrastructure (what sits under Open Operator, Skyvern, Browser Use cloud, many CUA deployments)

- Browserbase [confirmed]: Castle's basic-stealth test saw `window.playwright__binding` (a Playwright global), timezone `UTC`, `navigator.platform` "Mac" in the main thread but "Linux" in a worker, a CDP leak, `navigator.webdriver` absent, no self-identification. Docs: "Verified sessions default to the `windows` operating system; non-Verified sessions always use `linux`"; Verified = "Real browser fingerprints - not randomly generated configurations" (Scale plan); CAPTCHA solving and residential/datacenter proxies available; "Browserbase offers Web Bot Auth in beta" — "A valid signature doesn't grant access or sign your agent into a user account." Live directory 2026-10-24: `https://www.browserbase.com/.well-known/http-message-signatures-directory` → 200, two Ed25519 keys (`kid` `NVhTndQWodGQ47Kmhm1bhTdt0swWS7EHmUEMo-opsXU`, `DJuTDnlBxNZzalQhhvktwvkF3lWss-T56g7s4xubuhU`), `"purpose":"rag"`, response signed twice (`binding0`, `binding1`, `expires` = created + 3600). Founding Cloudflare Signed Agent; Fingerprint partner ("passport"). Open Operator = Stagehand on Browserbase (repo moved to `browserbase/gtm-demos/apps/open-operator`).
- Hyperbrowser [confirmed]: session `screen` default `1280x720`; `useStealth` (default false), `useUltraStealth` (enterprise), `useProxy` with `proxyCountry`, `acceptCookies`; no Web Bot Auth.
- Steel [confirmed]: "Steel creates a desktop, headful session with a default `timeout` of 5 minutes"; browsers run only in `us-east`; by default "your requests originate from the datacenter/machine's IP addresses"; `useProxy: true` → residential ("Hundreds of millions of IP addresses"); `stealthConfig.humanizeInteractions` "simulates human pointer movements and keystrokes", `skipFingerprintInjection`, `autoCaptchaSolving`; `fullscreen` = 1920×1080; mobile 508×1074; `userAgent` override; Claude integration examples use 1024×768 / 1280×768 and convert Claude's `scroll_amount` to `delta_y` with "100 per step" (`click_mouse`, `type_text`, `press_key` Input API). No Web Bot Auth.
- Skyvern (cloud, for comparison) [confirmed, Castle + arXiv]: UA `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0` (Edge 143/144 in 2026), WebGL `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)`, failed emoji/uncommon-font canvas test, locale `en-US`, 1920×1080, 32 logical cores, `ROTATING_COOKIE`, "high-quality US residential and ISP proxies" (34 ASNs), no `navigator.webdriver`, no CDP artifacts, no identifying headers; two dominant JA4s (with/without PSK).
- Browser Use cloud (for comparison) [confirmed, arXiv]: Mac Chrome/144 UA, 1512×982 screen, 10 cores, `ROTATING_COOKIE`, 35 ASNs of US residential proxies (stealth mode oddly "directly connects from low-reputation datacenter IP addresses", 0.98 hosting), permissions mostly `denied`, unique JA4 (index 10).

---

## 11. Cross-cutting mechanics

### 11.1 Web Bot Auth as deployed (exact strings)

| Item | Value | Source |
|---|---|---|
| Request headers | `Signature-Agent`, `Signature-Input`, `Signature` | OpenAI help 11845367; IETF draft-meunier-web-bot-auth-architecture |
| `Signature-Agent` format in the wild | quoted sf-string: `"https://chatgpt.com"` (OpenAI), `"https://chatgpt.com"` legacy bare-string form noted by cloudless.sh; Google uses dictionary form `g="https://agent.bot.goog"` | OpenAI help; cloudless.sh; centinelanalytica |
| `Signature-Input` (OpenAI) | `sig1=("@authority" "@method" "@path" "signature-agent");created=…;expires=…;keyid="…";nonce="…";tag="web-bot-auth";alg="ed25519"` (validity ≈ 1 h) | Simon Willison; Castle; cloudless.sh |
| Spec requirements | `tag` "MUST be `web-bot-auth`"; `keyid` "MUST be a base64url JWK SHA-256 Thumbprint"; `created` and `expires` required, "RECOMMENDED the expiry to be no more than 24 hours"; nonce "RECOMMENDED to use a 64-byte array"; agents "MUST include at least one of" `@authority` / `@target-uri`; origins MAY challenge with `Accept-Signature` (403 recommended, 429 for replay); "The key used for signing MUST NOT be tied to a specific human individual" | IETF draft |
| Directory | `/.well-known/http-message-signatures-directory`, media type `application/http-message-signatures-directory+json`, response itself signed with `tag="http-message-signatures-directory"`; Cloudflare validation requires the quoted-string `Signature-Agent`, `https://`, `signature-agent` listed in covered components, rejects `@query-params`, `@status`, `sf`, `bs`, `key`, `req`, `name` params; "A minute is often sufficient" for `expires`; Cloudflare does not validate nonces; experimental `Forwarded: for="openai"` operator identity | IETF directory draft; developers.cloudflare.com web-bot-auth page |
| Live signers found 2026-10-24 | `chatgpt.com` (1 key, `purpose: ai`, `no-store`), `agent.bot.goog` (5 keys, non-thumbprint `kid`s, `max-age=3600`), `www.browserbase.com` (2 keys, `purpose: rag`); 404: claude.ai, anthropic.com, api.anthropic.com, perplexity.ai, manus.im, anchorbrowser.io, genspark.ai; `operator.openai.com` no longer resolves | curl probes (this report) |
| Vendor labels for the OpenAI cloud browser | Cloudflare `chatgpt-agent` / detection ID `129220581` / dashboard name "ChatGPT Operator"; Akamai "ChatGPT Agent"; HUMAN "ChatGPT Agent"; Vercel `chatgpt-operator`; Fingerprint `bot_info.name = "ChatGPT Agent"`, `category = ai_agent`, `identity ∈ {signed, verified, unknown, spoofed}` | OpenAI help; Fingerprint docs |
| Cloudflare policy | Signed Agents program (Aug 28 2025); since July 1 2026 signed agents are Verified bots distinguished by `Direct` vs `Intermediary` operation labels in BotBase; Browser Rendering always bot score 1 | blog.cloudflare.com/signed-agents; developers.cloudflare.com verified-bots |

Verification nuances for an implementation: fetch directories live (OpenAI's `exp` rolls weekly and the body is `no-store`); accept both sf-string and sf-dictionary `Signature-Agent`; match `keyid` to directory `kid` literally (Google's are not thumbprints); treat a present-but-invalid signature as `spoofed` (Fingerprint's term); remember a valid signature proves the operator, not the user or intent, and Cloud browser "cannot sign in to websites or complete payments" at launch (so a *signed* session reaching a checkout is itself anomalous).

### 11.2 Input injection paths and what the page sees

| Path | Who | Trusted? | Pre-click motion | Press→release | Typing | Scrolling | Other tells |
|---|---|---|---|---|---|---|---|
| X11 XTEST (`xdotool`) in Xvfb | Anthropic demo, OpenAI Docker sample, most self-hosted Linux CUAs | yes (OS-level) | one warp (`mousemove --sync`), no interpolation | ≈12 ms (`click`), `--delay 10` between repeats | `type --delay 12` → uniform 12 ms; OpenAI sample uses default 12 ms too | N× button 4/5 presses (`click --repeat N 5`); OpenAI sample N = `abs(scroll_y)` | Xvfb 24-bit, DPI 96, Firefox ESR, Ubuntu 22.04 fonts, no GPU (software WebGL), container TZ/locale defaults |
| CDP `Input.dispatchMouseEvent` / `dispatchKeyEvent` / `insertText` | Claude in Chrome (chrome.debugger), Comet internal extension, Anthropic reference CDP driver, H `user_device`, Playwright/Puppeteer internally | `isTrusted: true` ("the event enters Chromium's input pipeline as if it came from the OS") | reference driver: exactly one `mouseMoved` at the target; Comet: none ("only clicks") | 0–10 ms unless the driver sleeps | per-char key events or `Input.insertText` (fires no `keydown`/`keyup`); `form_input`-style value setting fires `input`/`change` without key events | `mouseWheel` events with driver-chosen deltas, or `scrollIntoView`/`scrollBy` with no `wheel` at all | `getCoalescedEvents()` empty/trivial; `movementX/Y` 0 on PointerEvents in Chrome; constant `pressure`; possible `Runtime.enable` console/Error.stack side effects |
| Playwright `page.mouse.*` / `page.keyboard.*` | OpenAI CUA sample, Gemini sample, Magentic-UI, Nova Act, Browser Use, Stagehand/Open Operator, Skyvern | yes (CDP underneath) | `mouse.click` = `move` (steps=1 → "emits a single mousemove event at the destination location") + down + up | `delay` default 0 (Magentic-UI 10) | `keyboard.type` default 0 ms between keys (Magentic-UI 100 ms) | `mouse.wheel(dx, dy)` (Magentic-UI 400 px) or `window.scrollBy` (OpenAI sample: no wheel event) | Playwright globals (`__playwright__binding__`, `__pwInitScripts`, `playwright__binding`), `navigator.webdriver` unless patched |
| Out-of-process IPC (Atlas OWL) | Atlas (retired), possibly ChatGPT desktop app browser | n/a | unknown | unknown | unknown | unknown | no JS injection; favicon fetch via CFNetwork; missing Google TTS voices |
| Desktop OS APIs (PyAutoGUI, macOS/Windows input) | OpenAI CUA desktop sample, Simular, Anthropic computer use on real desktops | yes | PyAutoGUI `moveTo` default duration 0 → warp (library default; **uncertain** for each vendor) | library default | library default | OS wheel notches | real GPU/fonts; cadence remains model-paced |
| Content scripts / DOM mutation (no input events) | Claude in Chrome `form_input`/`javascript_tool`, Comet overlay, Magentic-UI marks | n/a | — | — | value set without key events (`InputEvent.inputType` absent or `insertText` without preceding `keydown`) | `scrollIntoView` | injected elements/ids/attributes (`pplx-agent-overlay*`, `red-cursor`, `[__elementId]`) |

### 11.3 Coordinate quantization and click placement

- Anthropic: screenshot space is the scaled XGA/WXGA/FWXGA frame; `round(x / factor)` maps back. For display W, lattice stride = W / target_width (1920→1366: 1.4056; 2560→1280 or 1366: 2.0 / 1.874; 1024/1280x800/1366 displays: 1.0, no quantization). Toolset models accept up to 2576 px long edge, so harnesses may now send 1920×1080 unscaled; then clicks are integer screen pixels with no lattice.
- Gemini: 0–999 grid, `int(x/1000*W)` → stride W/1000 with floor truncation (a systematic bias toward the top-left of the intended point by up to one stride).
- OpenAI CUA: integer coordinates in the 1024×768 (or 1440×900) screenshot = viewport; no scaling in the samples. The hosted ChatGPT agent used a 1280×960 screen — whether the model sees a downscaled frame is **unknown**.
- Claude browser toolset: "Coordinates are viewport pixels"; refs resolve to element nodes, and the reference driver clicks the ref's center after `scrollIntoView({block:'center'})` — so ref clicks land at exact element centers and the viewport jumps to center the element first.
- Click target choice: pixel-picking models aim at the visual center of the control they perceive, with the quantization above; cside reports tools that click "at the exact center", "consistently off-center to the right", or "random noise within the button" — distribution of (click − element center) per session is a usable per-stack signature [likely].
- Pointer coordinates are integers in all these paths; on a 1× display human `clientX/Y` are also integers, so integrality alone is weak — use the lattice/offset distribution instead.

### 11.4 Timing and cadence

- Loop structure: screenshot → model → 1–N actions → (fixed delay) → screenshot. Anthropic demo sleeps 2.0 s before every screenshot; OpenAI sample `wait()` = 1000 ms; Gemini sample `wait` default 1 s; Claude in Chrome screenshot 2–5 s (20 s+ on heavy pages); "a 200k window can fill in under 100 screenshots" (so sessions are typically < 100 steps); Manus 30–50 steps per task, ≈24 min for a research task; Claude in Chrome ≈10 min for a Zillow task (AIPex blog, vendor source); HUMAN on ChatGPT agent: "that process isn't faster than a human".
- Within a batch (Anthropic multi-action turns, `browser_batch`), actions fire back-to-back with only the driver's sleeps between them → bursts.
- Measured feature values (arXiv 2607.26935, Claude via Playwright/MCP, 1,025 sessions): human click duration ≈100–120 ms (σ≈30), automation "<10 ms and uniform"; human typing σ≈55 ms; human `mouse_event_rate` ≈10–50 Hz vs "sparse and programmatic"; `scroll_speed_var` null in all 1,025 agent sessions (no wheel events); `teleport_click_ratio` = share of clicks preceded within 100 ms by a >100 px raw-event jump; `{mouse_event_rate, teleport_click_ratio}` → macro-F1 0.926 with agent precision 0.994; `{mouse_event_rate, click_duration_std}` → agent precision 1.000; agent recall stayed 100% through five evasion levels including Bézier paths (15 steps at 8–25 ms), WGAN-GP trajectories and human replay (lognormal(6.0, 0.5) gaps, N(110, 30) ms holds, N(180, 60) ms typing gaps) because "the final click is still a programmatic dispatch without preceding motion, and scrolls come from an event loop".
- Generic timing tells (crawlex): human `mousemove` gaps cluster at the frame interval (~16.7 ms at 60 Hz) with `getCoalescedEvents()` sub-samples; synthetic streams are "spaced exactly 10ms apart, or all sharing a single timestamp"; `performance.now()` is clamped to 100 µs so round intervals (exactly 50/100 ms) stand out; an interaction "within a few tens of milliseconds of an element becoming clickable" implies no perception delay (human visual reaction ≈250 ms).

### 11.5 Environment fingerprints by deployment

| Deployment | Screen | Cores | Platform/UA consistency | Timezone/locale | GPU | Cookies | Network |
|---|---|---|---|---|---|---|---|
| ChatGPT agent (hosted, 2026) | 1280×960 fixed | 13 | Mac UA, Linux client hints, worker/main `navigator.platform` mismatch | unknown (EU PoP) | unknown | reused across sessions | single ASN, Cloudflare infra, TCP-only unique JA4, signed |
| Browser Use cloud | 1512×982 | 10 | Mac UA | unknown | unknown | rotating | 35 ASNs residential (stealth: datacenter) |
| Skyvern cloud | 1920×1080 | 32 | Linux Edge UA | en-US | SwiftShader | rotating | 34 ASNs residential |
| Browserbase (basic) | — | — | Mac main / Linux worker | UTC | — | — | datacenter unless proxy; WBA beta |
| Anthropic demo VM | 1024×768 default (Xvfb) | host | Linux Firefox ESR | container default | none/software | fresh profile | customer's |
| Claude in Chrome / Comet / auto browse / Manus Operator | user's | user's | consistent | user's | user's | shared with human | user's residential |

---

## 12. Detection hooks catalog (implementation-ready, ranked)

Each hook lists the layer, the exact check, which agents it catches, and confidence.

1. **Web Bot Auth verifier (edge/server)** — parse `Signature-Agent` (accept `"https://…"` and `k="https://…"`), require `tag="web-bot-auth"`, `created ≤ now ≤ expires`, fetch/cache the signer's directory (honor `no-store`; re-fetch on unknown `keyid`), verify Ed25519 over the covered components (at minimum `@authority` + `signature-agent`). Outcomes: `signed:chatgpt.com` (OpenAI cloud browser), `signed:agent.bot.goog` (Google hosted agents), `signed:www.browserbase.com` (Browserbase sessions), `spoofed` (header present, verification failed), `unsigned`. Also honor `Accept-Signature` challenges as an active probe (REDbot-style clients sign only after a 401/403/429 challenge). Catches: OpenAI cloud browser, Google agents, Browserbase. **[confirmed]**
2. **UA ↔ Client-Hints ↔ JS platform consistency** — compare the OS token in `User-Agent` with `Sec-CH-UA-Platform`, `navigator.userAgentData.platform`, `navigator.platform` in the main thread and in a Worker, and `getHighEntropyValues(['uaFullVersion','platformVersion'])`. ChatGPT agent/Operator (Mac UA + "Linux"), Browserbase basic (Mac main / Linux worker), Crawl4AI stealth (UA version downgraded) all fail. Comet/Atlas/Claude in Chrome pass (they *are* real Chrome). **[confirmed]**
3. **Fixed-environment signature bundles** — `screen.width×height`, `hardwareConcurrency`, `navigator.permissions.query` outcome pattern across ~13 permissions, timezone, WebGL renderer, font coverage (emoji/uncommon fonts via canvas), cookie-reuse behavior. Known bundles: ChatGPT agent 1280×960/13/permissions-fail; Browser Use cloud 1512×982/10/denied; Skyvern 1920×1080/32/Edge/SwiftShader; Browserbase UTC; Anthropic demo 1024×768 Xvfb + Firefox ESR. Maintain as versioned rules; they drift with vendor updates. **[confirmed for the measured dates]**
4. **DOM/extension artifacts** — MutationObserver for `#pplx-agent-overlay-stop-button` / `#pplx-agent-overlay` and the passive `rgb(255, 254, 251)` style-override test (Comet); `div#red-cursor` and `[__elementId]` red borders (Magentic-UI); any element whose text is "Stop Comet Assistant". Probe web-accessible resources of known extension IDs via `fetch('chrome-extension://<id>/<path>')` (LinkedIn/Castle technique) — the Claude extension ID is `fcoeoabgfenejglbffodgkkbkcdhcgfn` but its `web_accessible_resources` paths are **unknown** (lab item); Comet's internal extension lives under the custom scheme `comet-extension://npclhjbddhklpbnacpjloidibaggcgon/` which a page cannot fetch by `chrome-extension://` URL (**uncertain** whether any probe works). **[confirmed for Comet/Magentic-UI; uncertain for Claude]**
5. **Pre-click motion forensics (`teleport_click_ratio`, `mouse_event_rate`)** — for each `pointerdown`, inspect the preceding 300 ms of `pointermove`: zero moves (Comet, Playwright locator clicks, `element.click()`), exactly one move that jumps >100 px (CDP reference driver, Playwright `mouse.click`, xdotool warp), or a human-like trajectory. Combine with session `mousemove` Hz (humans 10–50 Hz; agents ≈0 between actions). The two-feature detector reached 0.994 agent precision at 100% recall across evasion levels. **[confirmed]**
6. **Press/release and keystroke cadence** — `pointerdown→pointerup` ≈12 ms constant (xdotool), 0–2 ms (Playwright default), 10 ms (Magentic-UI), vs ≈100–120 ms ±30 (human). Inter-key intervals: 12 ms uniform (xdotool `type`), ~0 ms (Playwright `keyboard.type`), 100 ms uniform (Magentic-UI); humans vary (σ≈55 ms, doubled letters faster). Also flag `input` events without any `keydown` (CDP `insertText`, DOM value setting, `form_input`), and text appearing as one `insertText` for a whole field. **[confirmed]**
7. **Scroll forensics** — viewport position changes without `wheel`/touch events (OpenAI sample `window.scrollBy`, `scrollIntoView` before ref clicks, Playwright `scrollIntoViewIfNeeded`); wheel bursts of N identical-delta events back-to-back (xdotool button 4/5, `scroll_amount` clicks); fixed deltas (Magentic-UI 400 px, Steel 100 px per Claude step, Gemini 800/1000·height or 300 px) and `deltaMode` inconsistent with the claimed OS. **[confirmed from source]**
8. **Pointer-event field plausibility** — Chrome PointerEvents from CDP carry `movementX/Y = 0`, empty `getCoalescedEvents()`, constant `pressure`, `pointerType: "mouse"`; a bare `click` without the `pointerover→pointerdown→mousedown→pointerup→mouseup→click` sequence indicates `element.click()`. **[likely; verify per browser version]**
9. **Coordinate lattice / offset distribution** — collect `clientX/Y` of clicks relative to the clicked element's box; test for stride lattices (1.4056 from 1920→1366 Anthropic scaling, 1.44/1.92 from Gemini 1000-grid, 2.0 from Retina halving) and for abnormally tight clustering at element centers (ref-based clicks) or constant off-center bias. **[likely; derived]**
10. **Step cadence model** — segment the session into bursts (gap > 1 s); agents show bimodal gaps: intra-burst < 100 ms, inter-burst 2–30 s with low variance of the *minimum* per-step latency (screenshot + model time), and no idle micro-movements between bursts; a sudden switch to human-like motion after a login/CAPTCHA page = takeover mode (OpenAI, Manus, Simular, Comet). **[confirmed qualitatively; thresholds are lab work]**
11. **Network/TLS layer** — Cloudflare-infra source + Mac UA + no QUIC (ChatGPT agent); datacenter ASN for Manus cloud browser, Steel/Browserbase default sessions; Google `user-triggered-agents.json` prefixes; JA4 of ChatGPT agent (28 ciphers / 12 extensions) — cheap pre-JS triage. Local agents are invisible here by design. **[confirmed]**
12. **Side-channel UAs** — favicon/`/apple-touch-icon` fetches with `CFNetwork/… Darwin/…` UAs containing `ChatGPT%20Atlas` (historical); `python-requests`/`curl`/`Python-urllib` requests arriving *with* valid `chatgpt.com` signatures (agent terminal tool); `Google-Agent` token. **[confirmed/likely]**
13. **Behavioral policy signals** — ChatGPT agent refuses to pass Turnstile but tries sibling hostnames ("navigates to alternative honeysites"); Claude refuses CAPTCHAs; Skyvern loops/reloads; Gemini asks for confirmation on `USER_CONSENT_MANAGEMENT` (cookie banners) — a decoy/challenge step that a human would dismiss trivially but an agent is *instructed* not to touch is an identification lever. **[confirmed]**

### 12.1 Lab verification plan (run against the local "Agent Probe" page)

Record for each product: raw `pointer*`, `mouse*`, `wheel`, `key*`, `input`, `beforeinput`, `focus`, `scroll`, `visibilitychange` events with `isTrusted`, `timeStamp`, `movementX/Y`, `pressure`, `getCoalescedEvents().length`, `inputType`; `navigator.*`/client hints/permissions/screen/cores/timezone/WebGL/fonts/`speechSynthesis.getVoices()`; a MutationObserver log; a `fetch('chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/<candidate>')` probe list; server-side headers (`Signature-*`, `Sec-CH-UA-*`, JA4/HTTP2 fingerprint). Products to drive: Claude in Chrome (this machine), Anthropic computer-use-demo container (1024×768 and 1920×1080), OpenAI `computer` tool with the Playwright and Docker samples, Gemini sample at 1440×900, Comet, Gemini in Chrome auto browse, Manus (cloud + Operator), Nova Act, Magentic-UI, a Browserbase/Steel/Hyperbrowser session, ChatGPT Work cloud browser (via a public URL on the probe host).

---

## 13. Unknowns and open questions

1. Claude in Chrome's exact dispatch per tool (CDP `Input.*` vs content-script synthetic events for `form_input`), whether it calls `Runtime.enable`, and whether it exposes any `web_accessible_resources` — only user-side reverse engineering exists.
2. The hosted ChatGPT Work cloud browser's current screen size, OS, UA version, and egress ranges (OpenAI publishes none); whether its screenshots are downscaled before the model; whether the terminal/text-browser requests are always signed.
3. Whether the ChatGPT desktop app's built-in browser and the ChatGPT Chrome extension (Atlas successors) sign requests or expose any token — no documentation found.
4. Which Google products emit `Google-Agent` and the `agent.bot.goog` signature (Gemini Spark? AI Mode agentic checkout?), and what the Gemini Spark "remote browser instance" looks like.
5. Comet's "Perplexity-specific headers" (HUMAN) — no header name published; Comet's current Chromium version and whether the overlay selectors changed after the Amazon litigation.
6. Nova Act's exact UA token format (`NovaAct/<version>`?) and AgentCore Browser's egress ranges.
7. Manus cloud browser UA/screen; whether Manus signs requests anywhere (Fingerprint claims it verifies "Manus" as a signed agent; manus.im has no directory).
8. Microsoft Edge "Copilot Actions" (2026) mechanics; Windows "Copilot Actions" agent workspace; Genspark and Convergence Proxy internals (sites blocked fetchers).
9. Per-step latency distributions per product (only anecdotes and the 2607 paper's synthetic evasion parameters exist; no vendor publishes them).
10. Exact wheel `deltaY`/`deltaMode` produced by xdotool button-4/5 clicks in Firefox ESR vs Chromium inside Xvfb (lab item).
11. Whether OpenAI's `computer` tool (2026) still accepts `environment`/`display_*` fields — the current guide shows only `{ type: "computer" }`.
12. Status of "Please" (ex-MultiOn), Runner H consumer app, and Simular's browser UA.

---

## 14. Sources

Anthropic
- https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/computer-use-tool
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-sdk
- https://claude.com/blog/best-practices-for-computer-and-browser-use-with-claude
- https://claude.com/blog/claude-for-chrome (redirect from https://www.anthropic.com/news/claude-for-chrome)
- https://www.anthropic.com/news/developing-computer-use
- https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome
- https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn
- https://github.com/anthropics/claude-code/issues/28013
- https://raw.githubusercontent.com/anthropics/anthropic-quickstarts/main/computer-use-demo/computer_use_demo/tools/computer.py
- https://raw.githubusercontent.com/anthropics/anthropic-quickstarts/main/computer-use-demo/computer_use_demo/tools/groups.py
- https://raw.githubusercontent.com/anthropics/anthropic-quickstarts/main/computer-use-demo/computer_use_demo/loop.py
- https://raw.githubusercontent.com/anthropics/anthropic-quickstarts/main/computer-use-demo/Dockerfile
- https://raw.githubusercontent.com/anthropics/anthropic-quickstarts/main/computer-use-demo/image/xvfb_startup.sh
- https://raw.githubusercontent.com/anthropics/anthropic-quickstarts/main/computer-use-demo/README.md
- https://raw.githubusercontent.com/anthropics/claude-quickstarts/main/browser-toolset/python/cdp_browser.py
- https://www.claudechrome.com/blog/how-claude-chrome-works (competitor blog; low weight)

OpenAI
- https://help.openai.com/en/articles/11845367-chatgpt-works-cloud-browser-allowlisting
- https://help.openai.com/en/articles/20001371-chatgpt-atlas-retirement
- https://openai.com/index/introducing-chatgpt-agent/
- https://openai.com/index/operator-system-card/
- https://openai.com/index/computer-using-agent/
- https://developers.openai.com/api/docs/guides/tools-computer-use
- https://developers.openai.com/api/docs/bots
- https://chatgpt.com/.well-known/http-message-signatures-directory
- https://raw.githubusercontent.com/openai/openai-cua-sample-app/a8a75a301304137656c6b56168c521bfc326d17d/agent/agent.py
- https://raw.githubusercontent.com/openai/openai-cua-sample-app/a8a75a301304137656c6b56168c521bfc326d17d/computers/computer.py
- https://raw.githubusercontent.com/openai/openai-cua-sample-app/a8a75a301304137656c6b56168c521bfc326d17d/computers/shared/base_playwright.py
- https://raw.githubusercontent.com/openai/openai-cua-sample-app/a8a75a301304137656c6b56168c521bfc326d17d/computers/default/local_playwright.py
- https://raw.githubusercontent.com/openai/openai-cua-sample-app/a8a75a301304137656c6b56168c521bfc326d17d/computers/default/docker.py
- https://raw.githubusercontent.com/openai/openai-cua-sample-app/main/python-app/app/browser.py
- https://raw.githubusercontent.com/openai/openai-cua-sample-app/main/javascript-app/src/browser/session.ts
- https://simonwillison.net/2025/Aug/4/chatgpt-agents-user-agent/
- https://simonwillison.net/2025/Oct/21/introducing-chatgpt-atlas/
- https://www.chrisrcook.com/2025/10/22/chatgpt-atlas-user-agent/
- https://www.aisearchoptimization.in/blog/chatgpt-atlas-user-agent-why-youre-suddenly-seeing-it-in-your-server-logs/
- https://community.openai.com/t/python-user-agents-coming-with-proper-web-bot-auth-signature-headers/1409085
- https://en.wikipedia.org/wiki/ChatGPT_Atlas
- https://ppc.land/openai-kills-atlas-browser-folds-it-into-new-chatgpt-work-agent/
- https://prosopo.io/blog/chatgpt-atlas-discontinued/
- https://aicrawlercheck.com/directory/ai-bots/chatgpt-agent
- https://botcrawl.com/bots/chatgpt-work-cloud-browser/
- https://www.seerinteractive.com/insights/how-will-you-know-when-open-ais-operator-agent-hits-your-website

Google
- https://ai.google.dev/gemini-api/docs/interactions/computer-use
- https://ai.google.dev/gemini-api/docs/generate-content/computer-use
- https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/computer-use
- https://developers.google.com/crawling/docs/crawlers-fetchers/google-agent
- https://developers.google.com/crawling/docs/crawlers-fetchers/google-user-triggered-fetchers
- https://developers.google.com/search/docs/crawling-indexing/verifying-googlebot
- https://developers.google.com/static/crawling/ipranges/user-triggered-agents.json
- https://agent.bot.goog/.well-known/http-message-signatures-directory
- https://blog.google/products-and-platforms/products/chrome/gemini-3-auto-browse/
- https://blog.google/products-and-platforms/products/chrome/gemini-in-chrome-android-auto-browse/
- https://en.wikipedia.org/wiki/Project_Mariner
- https://labs.google.com/mariner/landing
- https://www.humansecurity.com/ai-agent/google-mariner/

Perplexity / Comet
- https://blog.castle.io/from-detection-to-trust-the-evolving-challenge-of-ai-bot-authentication/
- https://www.humansecurity.com/learn/blog/chatgpt-atlas-vs-perplexity-comet-agentic-browsers/
- https://www.humansecurity.com/ai-agent/perplexity-comet/
- https://www.humansecurity.com/ai-agent/chatgpt-atlas/
- https://www.humansecurity.com/ai-agent/chatgpt-agent/
- https://www.perplexity.ai/hub/blog/bullying-is-not-innovation
- https://prosopo.io/blog/perplexity-comet-browser/
- https://en.wikipedia.org/wiki/Comet_(web_browser)
- https://www.cnbc.com/2026/03/10/amazon-wins-court-order-to-block-perplexitys-ai-shopping-agent.html (via search)
- https://www.pymnts.com/news/artificial-intelligence/2026/ninth-circuit-narrows-cfaa-reach-in-perplexity-agentic-commerce-ruling/ (via search)
- https://4sysops.com/archives/ai-browser-comet-with-efficient-ad-blocking-perplexitys-deception-and-hypocrisy/ (search snippet only)

Manus, Nova Act, Microsoft, H, Simular, others
- https://manus.im/docs/features/cloud-browser.md
- https://manus.im/docs/features/browser-operator.md
- https://manus.im/docs/integrations/manus-browser-operator.md
- https://www.zenml.io/llmops-database/building-an-ai-agent-platform-with-cloud-based-virtual-machines-and-extended-context
- https://en.wikipedia.org/wiki/Manus_(AI_agent)
- https://raw.githubusercontent.com/aws/nova-act/main/README.md
- https://raw.githubusercontent.com/microsoft/magentic-ui/main/src/magentic_ui/tools/playwright/playwright_controller_fara.py
- https://raw.githubusercontent.com/microsoft/magentic-ui/main/src/magentic_ui/tools/playwright/utils/animation_utils.py
- https://raw.githubusercontent.com/microsoft/magentic-ui/main/src/magentic_ui/tools/playwright/browser/local_playwright_browser.py
- https://raw.githubusercontent.com/microsoft/magentic-ui/main/README.md
- https://blogs.windows.com/msedgedev/2025/07/28/introducing-copilot-mode-in-edge-a-new-way-to-browse-the-web/
- https://hub.hcompany.ai/computer-use-agents/browser/local-control
- https://hub.hcompany.ai/computer-use-agents/browser/configuration
- https://www.hcompany.ai/
- https://platform.simular.ai/ and https://platform.simular.ai/documentation/api-reference/message
- https://www.multion.ai/ (301 → https://theagi.company/)
- https://mediacopilot.ai/ai-agent-traffic-datadome-muse/ (DataDome Q3-2026 figures, Meta Muse)

Hosted-browser infrastructure
- https://docs.browserbase.com/features/stealth-mode
- https://browserbase.mintlify.app/platform/identity/overview
- https://www.browserbase.com/.well-known/http-message-signatures-directory
- https://raw.githubusercontent.com/browserbase/open-operator/main/README.md
- https://docs.stagehand.dev/v4/integrations/agent-frameworks/claude-cua-toolset-quickstart
- https://hyperbrowser.ai/docs/sessions/create.md and https://hyperbrowser.ai/docs/sessions/stealth.md
- https://docs.steel.dev/overview/sessions-api/configuration.md, https://docs.steel.dev/overview/stealth/proxies.md, https://docs.steel.dev/integrations/claude-computer-use.md, https://docs.steel.dev/cookbook/claude-computer-use.md

Standards, vendors, measurements
- https://datatracker.ietf.org/doc/html/draft-meunier-web-bot-auth-architecture
- https://datatracker.ietf.org/doc/html/draft-meunier-http-message-signatures-directory
- https://blog.cloudflare.com/web-bot-auth/
- https://blog.cloudflare.com/signed-agents/
- https://developers.cloudflare.com/bots/concepts/bot/verified-bots/web-bot-auth/
- https://developers.cloudflare.com/bots/concepts/bot/verified-bots/
- https://developers.cloudflare.com/bots/concepts/bot/verified-bots/categories/
- https://cloudless.sh/log/web-bot-auth-in-the-wild/
- https://www.centinelanalytica.com/blog/ai-browser-agents
- https://docs.fingerprint.com/docs/ai-agents
- https://fingerprint.com/blog/how-to-detect-ai-agents/
- https://fingerprint.com/blog/product-update-ai-assistant-detection/
- https://fingerprint.com/blog/product-update-ai-agent-detection/
- https://cside.com/blog/guide-to-detect-ai-agent-traffic-on-your-website
- https://arcjet.com/learn/identify-ai-agents-and-bots
- https://blog.castle.io/detecting-browser-extensions-for-bot-detection-lessons-from-linkedin-and-castle/
- https://blog.castle.io/roll-your-own-bot-detection-fingerprinting-javascript-part-1/
- https://blog.crawlex.net/blog/synthesizing-human-input-events/
- https://blog.crawlex.net/blog/detecting-automation-via-timing/
- https://arxiv.org/pdf/2606.30119 — Fayolle et al., "On the Internet, Nobody Knows You're an LLM Bot: Unmasking Web Agents with Multi-Layer Fingerprinting" (2026)
- https://arxiv.org/html/2607.26935v1 — "What Does It Take to Detect an AI Agent? Minimal Feature Sets for Behavioral Detection under Browser Automation" (2026)
- https://playwright.dev/python/docs/api/class-mouse
- https://man.archlinux.org/man/xdotool.1
- https://chromedevtools.github.io/devtools-protocol/tot/Input/ (redirected; parameter names cited from the CDP spec as known, not re-read)
