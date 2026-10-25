# Extension-based and agentic-browser agents: detecting them from inside a web page

Research snapshot: 2026-10-24. Area: browser extensions and "agentic browsers" that operate a user's real browser (Claude in Chrome, Gemini in Chrome / Chrome Actor, Perplexity Comet, ChatGPT Atlas, OpenAI ChatGPT/Codex extension, Edge Copilot Mode, Playwright MCP Bridge, Browser MCP, Nanobrowser, HARPA AI, Chrome MCP Server, Taxy AI, Cursor browser automation, Opera Neon, Dia, Fellou, Browserbase/Steel).

Evidence classes used in this document:

- **[LOCAL]** read directly from files installed on the research machine (Chrome 155.0.8059.86 on macOS 26; Claude in Chrome 1.0.102 unpacked from the Web Store; the Codex "browser" plugin bundle; Cursor's bundled `cursor-browser-automation` extension; Chrome's `ActorSafetyLists` component and feature-state files).
- **[LIVE]** measured by loading a purpose-built probe page in Chrome and driving it with the real Claude in Chrome extension (clicks, typing, `form_input`, `javascript_tool`, `read_page`, `read_console_messages`). The probe page source is at `/private/tmp/claude-501/-Users-dev-Projects-necter/3044e935-0f92-4a55-99e9-6a0b4223c15f/scratchpad/agentprobe/probe.html` (copy it into the repo's test fixtures; it is a good regression harness).
- **[PRIMARY]** vendor docs, Chromium source on GitHub mirror, IETF datatracker, GitHub READMEs/manifests, Chrome Web Store listings.
- **[SECONDARY]** blog posts / vendor-security write-ups / search summaries. Always marked.

Where a string could not be confirmed it is marked **uncertain** and the reason is given. Nothing below is invented; every exact string was copied from a file or page listed in the Sources section.

---

## 0. Executive summary (what a detector can use today)

| # | Signal | Agents it identifies | Evidence | Reliability |
|---|--------|----------------------|----------|-------------|
| 1 | `fetch("chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/assets/accessibility-tree.js-B-oUarrX.js")` resolves (HTTP 200, `type: "basic"`) because the Claude extension declares these files in `web_accessible_resources` with `matches: ["<all_urls>"]` and `use_dynamic_url: false` | Claude in Chrome (installed, not necessarily acting) | [LOCAL] manifest + [LIVE] fetch succeeded | Very high while the hashed filename is known; the hash changes per release, so ship a per-version table (two current paths below) |
| 2 | A bare `<div>` (zero attributes, zero light-DOM children) appended as the **last child of `<body>`** whose computed `display` is `contents` (set by `:host { all: initial !important; display: contents !important; }` inside a **closed** shadow root). Appears the instant the agent starts acting and persists for the page lifetime | Claude in Chrome (actively acting on this tab) | [LOCAL] `agent-visual-indicator.js` + [LIVE] `DOM_ADDED` 47 ms after the tab was activated | Very high; survives obfuscation of inner IDs because the host style is observable via `getComputedStyle` |
| 3 | Infobar slide-in: a burst of ~14 `resize` events, `innerHeight` shrinking in 3–4 px steps every ~8 ms, `outerHeight` constant, total −56 px, right after the first CDP action | Every `chrome.debugger`-based agent on desktop Chrome: Claude in Chrome, Playwright MCP Bridge, Browser MCP, Nanobrowser, Taxy AI, OpenAI ChatGPT/Codex extension, Comet Assistant (uncertain for component extensions) | [LIVE] measured; [PRIMARY] Chromium `debugger_api.cc`, `global_confirm_info_bar.h`, `generated_resources.grd` | High on desktop Chrome/Edge; the bar is **global** (every tab of every window), so it fires in all open pages; suppressed for policy-installed extensions and with `--silent-debugger-extension-api`; Android uses a "message" instead |
| 4 | Trusted-but-robotic input: `isTrusted: true`, `pointerType: "mouse"`, `pressure: 0.5` on down / `0` on up, `movementX/Y: 0`, one `pointerover` then `pointerdown` 9 ms later, mousedown→mouseup **4.8 ms**, inter-key gap **~3 ms**, several key events sharing an **identical `event.timeStamp`** | All CDP `Input.dispatch*` drivers (Claude, Codex/ChatGPT extension, Playwright bridge, Browser MCP, Nanobrowser, Taxy) and Chrome's own Actor (renderer-synthesized `WebMouseEvent`/`WebKeyboardEvent`) | [LIVE] + [PRIMARY] Chromium `click_dispatcher.cc` / `key_dispatcher.cc` | High as a behavioural score; cannot name the vendor by itself |
| 5 | `isTrusted: false` `input`/`change` events that are plain `Event` objects (no `inputType`, no `data`) preceded by a trusted `focusin` | Claude `form_input`; any content-script "set value + dispatchEvent" tool (Chrome MCP Server, HARPA likely) | [LIVE] | High |
| 6 | Main-world globals / DOM left by the driver: `globalThis.__browserUseClipboardBridge` (installed with `Page.addScriptToEvaluateOnNewDocument` + `Runtime.addBinding`), a hidden shadow host containing an `<iframe name="codex-webmcp-probe-97adecab-75be-4770-bbe4-654cac643843">`, `codex-agent-overlay-root`, `document.__codexNativeWebMcpState` | OpenAI Codex "browser" plugin driving the ChatGPT extension (`hehggadaopoacecdllhhajmbjkdcmajg`) | [LOCAL] `browser-service.mjs` | High for presence; exact injection timing needs a live run with the ChatGPT extension (not installed here) |
| 7 | `window.__cursorBrowserAutomationInjected`, `window.__cursorAreaScreenshotInjected`, `[data-cursor-ref="e<N>"]` attributes on elements, `data-cursor-overlay` | Cursor IDE's built-in browser automation (drives its embedded browser; could also target a user Chrome if configured) | [LOCAL] Cursor.app bundle | High |
| 8 | Nothing in the DOM, no globals, no headers: Gemini in Chrome (Chrome "Actor") acts from the browser process into the renderer (`WebWidget::HandleInputEvent`) and renders its glow/overlay/handoff button in browser UI, not in the page | Gemini in Chrome | [PRIMARY] Chromium `chrome/renderer/actor/*`, `chrome/browser/actor/ui/*` | You are limited to behavioural/timing signals (#4), the absence of `pointermove` trails, constant key-down/up durations, and possibly navigation header anomalies (hypothesis, see §5) |
| 9 | HTTP-level identity exists only for **cloud** agents: `Signature-Agent: "https://chatgpt.com"` + `Signature-Input`/`Signature` (Web Bot Auth, RFC 9421) on ChatGPT agent / ChatGPT Work cloud browser; signed-agent cohort at Cloudflare: ChatGPT agent, Goose, Browserbase, Anchor Browser, Cloudflare Browser Rendering | Cloud browser agents | [PRIMARY] IETF draft-ietf-webbotauth-httpsig-protocol-00, Cloudflare docs/blog, Simon Willison's capture | High for signed traffic; **local** agentic browsers (Atlas, Comet, Claude in Chrome, Gemini in Chrome, Edge) send plain Chrome UA + brands and no signature |
| 10 | The `Runtime.enable` "serialization leak" probes (Proxy-prototype `console.groupEnd`, `Error.stack` getter, enumerable getter in `console.log`) **did not fire** on Chrome 155 even with `Runtime.enable` verifiably active (console tracking on) | — | [LIVE] negative result | Treat these probes as **dead on Chrome 155** for extension-driven CDP; keep them only as low-weight legacy checks |

---

## 1. Environment and method

- Chrome `155.0.8059.86` (from `~/Library/Application Support/Google/Chrome/RunningChromeVersion`), macOS Darwin 25.6.0, DPR 2. [LOCAL]
- Installed extensions in the Default profile (IDs → names from manifests) [LOCAL]:
  `fcoeoabgfenejglbffodgkkbkcdhcgfn` = "Claude" ("Claude in Chrome") 1.0.102; `fklakbbaaknbgcedidhblbnhclijnhbi` = HTTP-TRACKER; `ghbmnnjooekpmoecnnnilnnbdlolhkhi` = Google Docs Offline; `gmbmikajjgmnabiglmofipeabaddhgne` = (Google print/Save to Drive, localized name); `lhobafahddgcelffkeicbaginigeejlf` = Allow CORS; `lmhkpmbekcpmknklioeibfkpmmfibljd` = Redux DevTools; `lpcaedmchfhocbbapmcbpinfpgnhiddi` = Google Keep; `nkbihfbeogaeaoehlefnkodbefgpgknn` = MetaMask; `nmmhkkegccagdldgiimedpiccmgmieda` = Chrome Web Store Payments; `okfkdaglfjjjfefdcppliegebpoegaii` = Scribe; `pejdijmoenmkgeppbflobdenhhabjlaj` = 1Password-style password manager (localized name; has `nativeMessaging`).
- Native messaging host manifests present in `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` [LOCAL]:
  - `com.anthropic.claude_browser_extension.json` → `/Applications/Claude.app/Contents/Helpers/chrome-native-host`, `allowed_origins`: `chrome-extension://dihbgbndebgnbjfmelmegjepbnkhlgni/`, `chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/`, `chrome-extension://dngcpimnedloihjnnfngkgjoidhnaolf/` (Claude Desktop / Cowork pairing).
  - `com.anthropic.claude_code_browser_extension.json` → `~/.claude/chrome/chrome-native-host`, `allowed_origins`: `chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/` (Claude Code `--chrome`).
  - `com.perplexity.comet.json` → `/Applications/Perplexity.app/Contents/MacOS/comet-native-host`, `allowed_origins`: `chrome-extension://npclhjbddhklpbnacpjloidibaggcgon/` ("Perplexity Mac Native Messaging Host").
- Live probe: a static page served from `127.0.0.1:8765` logging UA/brands, viewport geometry on every `resize`, focus/visibility changes, a `MutationObserver` on the whole document (tag, attributes, computed `display`, shadow state, position in `<body>`), every pointer/mouse/keyboard/input event with `isTrusted`, coordinates, `pointerType`, `pressure`, `timeStamp`, `inputType`; `fetch()` + `<img>` probes of `chrome-extension://` URLs; `performance.getEntriesByType('resource')`; `Runtime.enable` leak probes every 500 ms; `longtask` observer; and a 1 s poll for "bare `<div>` with `display: contents` as last body child". The page was then driven with Claude in Chrome's own tools.
- Limits: the shared WebSearch budget ran out mid-research; everything after that point came from direct fetches of primary URLs and local files. Pages on humansecurity.com, help.openai.com, openai.com and chrome-stats.com returned 403 and are cited only through secondary summaries where used. The Chrome Web Store CRX of the OpenAI "ChatGPT" extension was not downloaded (no user approval for downloads); its internals are inferred from the Codex plugin that drives it.

---

## 2. Claude in Chrome (Anthropic) — `fcoeoabgfenejglbffodgkkbkcdhcgfn`

### 2.1 Identity

- Chrome Web Store: name **"Claude"**, developer Anthropic (claude.com), **20,000,000 users**, version **1.0.102**, last updated **October 21, 2026**; listing text: "Claude reads the page, clicks, types, navigates, and fills forms, while you watch" and "can't reach anything you haven't approved". [PRIMARY: chromewebstore.google.com/detail/fcoeoabgfenejglbffodgkkbkcdhcgfn]
- Installed copy: `~/Library/Application Support/Google/Chrome/Default/Extensions/fcoeoabgfenejglbffodgkkbkcdhcgfn/1.0.102_0/`, `git-hash.txt` = `1c823704a35df0c3039e40d450166c172048e538`, Secure Preferences `location: 1`, `from_webstore: true` (so the debugger infobar is **not** suppressed by the policy-install exemption). [LOCAL]
- The same extension serves three products: the consumer side panel, **Claude Code `--chrome`** (native host `com.anthropic.claude_code_browser_extension`, Unix socket `/tmp/claude-mcp-browser-bridge-{USER}/*.sock` per OriginHQ) and **Claude Desktop/Cowork** (native host `com.anthropic.claude_browser_extension`; CSP `connect-src` allows `wss://bridge.claudeusercontent.com`). Two extra extension IDs appear in the Desktop host allow-list (`dihbgbndebgnbjfmelmegjepbnkhlgni`, `dngcpimnedloihjnnfngkgjoidhnaolf`); the Web Store returns an empty listing for the first, so treat them as **internal/unlisted builds** (uncertain). [LOCAL + PRIMARY]
- Supported browsers per third-party setup guides: Chrome and Edge; Brave and Arc "currently not supported" [SECONDARY].

### 2.2 Manifest (verbatim, key fields) [LOCAL]

```json
"name": "Claude", "version": "1.0.102", "manifest_version": 3, "description": "Claude in Chrome",
"permissions": ["sidePanel","storage","activeTab","scripting","debugger","tabGroups","tabs","alarms","notifications","webNavigation","declarativeNetRequestWithHostAccess","offscreen","nativeMessaging","unlimitedStorage","downloads","identity"],
"host_permissions": ["<all_urls>"],
"content_scripts": [
  {"js":["assets/content-script.ts-loader-D2HlXAAI.js"],"matches":["https://claude.ai/*","https://*.claude.ai/*"],"run_at":"document_end"},
  {"all_frames":true,"js":["assets/accessibility-tree.js-B-oUarrX.js"],"matches":["<all_urls>"],"run_at":"document_start"},
  {"all_frames":false,"js":["assets/agent-visual-indicator.js-uaVFxZ2f.js"],"matches":["<all_urls>"],"run_at":"document_idle"}],
"web_accessible_resources": [
  {"matches":["https://*.claude.ai/*","https://claude.ai/*"],"resources":["assets/onboarding-prompts-CJtFEMjA.js","assets/content-script.ts-C6lrM1Zv.js"],"use_dynamic_url":false},
  {"matches":["<all_urls>"],"resources":["assets/accessibility-tree.js-B-oUarrX.js","assets/agent-visual-indicator.js-uaVFxZ2f.js"],"use_dynamic_url":false}],
"background": {"service_worker":"service-worker-loader.js","type":"module"},
"externally_connectable": {"matches":["https://claude.ai/*","https://*.claude.ai/*"]},
"minimum_chrome_version": "116",
"commands": {"toggle-side-panel": {"suggested_key": {"default":"Ctrl+E","mac":"Command+E"}}},
"content_security_policy": {"extension_pages": "script-src 'self'; object-src 'self'; connect-src 'self' https://api.anthropic.com wss://api.anthropic.com https://claude.ai https://platform.claude.com https://*.ingest.us.sentry.io https://browser-intake-us5-datadoghq.com wss://bridge.claudeusercontent.com wss://bridge-staging.claudeusercontent.com; ..."}
```

Notes: no `world: "MAIN"` on any manifest content script (both run in the **isolated world**); the two `<all_urls>` content scripts are also the two `<all_urls>` web-accessible resources, which is what makes probe #1 work. `managed_schema.json` exposes enterprise policies `blockedUrlPatterns` and `forceLoginOrgUUID` (admins can block the agent per URL pattern; a blocked page shows the bundled `blocked.html`, which is extension UI, not page DOM).

### 2.3 Content script 1: `assets/accessibility-tree.js-B-oUarrX.js` (6,806 bytes, isolated world, all frames, `document_start`) [LOCAL]

```js
window.__claudeElementMap||(window.__claudeElementMap={}),
window.__claudeElementReverseMap||(window.__claudeElementReverseMap=new WeakMap),
window.__claudeRefCounter||(window.__claudeRefCounter=0),
window.__generateAccessibilityTree=function(e,t,r,i){ ... }
```

- Generates the text tree used by `read_page`/`find`: walks `document.body` (max 10,000 elements, default depth 15), assigns `"ref_"+ ++window.__claudeRefCounter` per element, stores `new WeakRef(e)` in `__claudeElementMap`, filters with `getBoundingClientRect()` against `window.innerWidth/innerHeight` (viewport filter), redacts `type=password`, `type=hidden` and `autocomplete` values `current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp*` as `"[value redacted]"`, emits lines like `button "CLICK ME" [ref_3]`, `textbox "type here" [ref_4] placeholder="type here"`, plus `Viewport: WxH`.
- **No DOM mutation**: refs live in JS maps, not attributes. The globals are isolated-world only — the live test confirmed `typeof window.__claudeElementMap === "undefined"` in the main world. **Do not** look for them from page JS.
- Observable side effect: a full-tree `getBoundingClientRect()` pass forces layout on the main thread; on heavy pages this can surface as a `longtask` with no page-side cause (none appeared on the small probe page). Low-weight signal.

### 2.4 Content script 2: `assets/agent-visual-indicator.js-uaVFxZ2f.js` (18,585 bytes, isolated world, top frame only, `document_idle`) [LOCAL]

Everything is created lazily on messages from the service worker (`SHOW_AGENT_INDICATORS`, `HIDE_AGENT_INDICATORS`, `UPDATE_PHANTOM_CURSOR`, `HIDE_FOR_TOOL_USE`, `SHOW_AFTER_TOOL_USE`, `SHOW_STATIC_INDICATOR`, `HIDE_STATIC_INDICATOR`, `HIDE_STATIC_PILL`; outbound `STOP_AGENT`, `STOP_AGENT_DROPPED`, `STATIC_INDICATOR_HEARTBEAT`, `SWITCH_TO_MAIN_TAB`, `DISMISS_STATIC_INDICATOR_FOR_GROUP`).

Host element (the only thing in the light DOM):

```js
const n=document.createElement("div"),i=n.attachShadow({mode:"closed"});
i.appendChild(/*<style>*/ ":host { all: initial !important; display: contents !important; } @keyframes claude-pulse {...} #claude-agent-glow-border-inner { animation: claude-pulse 2s ease-in-out infinite; } @media (prefers-reduced-motion: reduce) {...}");
e=n,t=i; for(const t of e.getAttributeNames())e.removeAttribute(t);
const n=document.body||document.documentElement;
return e.parentNode!==n&&n.appendChild(e),t
// A(): E().appendChild(t), e.nextElementSibling&&e.parentNode.appendChild(e)   <- keeps itself LAST child of body
```

Inside the closed shadow root (not reachable from page JS, but documented for completeness and for screenshot/visual classifiers):

- `#claude-agent-glow-border` (`position: fixed; inset 0; pointer-events: none; z-index: 2147483646`) with `#claude-agent-glow-border-inner` (`box-shadow: inset 0 0 15px rgba(217,119,87,0.7), inset 0 0 25px rgba(217,119,87,0.5), inset 0 0 35px rgba(217,119,87,0.2)`; pulsing) — the orange "Claude is acting" frame.
- `#claude-agent-stop-container` / `#claude-agent-stop-button` — text **"Stop Claude"**, background `#FAF9F5`, color `#141413`, `z-index: 2147483647`, bottom-centered. Click handler only honours `e.isTrusted`.
- `#claude-phantom-cursor` (`position: fixed; pointer-events: none; z-index: 2147483646; transition: transform 180ms cubic-bezier(0.2,0,0,1)`) containing two SVG arrows `#claude-phantom-cursor-plain` (white/#111) and `#claude-phantom-cursor-styled` (`#D97757` fill, `#FAF9F5` stroke, drop-shadow `rgba(217,119,87,0.9)`), path `M0 0 L0 18 L4.5 14 L7.5 21.5 L11 20 L8 13 L14 13 Z`, moved with `translate3d(x,y,0)` on `UPDATE_PHANTOM_CURSOR`.
- `#claude-static-indicator-container` — pill with the text **"Claude is active in this tab group"**, `#claude-static-chat-button` (tooltip "Open chat"), `#claude-static-close-button` (tooltip "Dismiss"), heartbeat every 5 s.
- A toast "Stop didn’t reach Claude — close the side panel to stop." in its own closed-shadow host at `bottom:88px`.
- A silent `AudioContext` (`createGain` with `gain=0` + `createConstantSource`) is started when the agent is active (presumably to keep the tab from being throttled); it is suspended on hide. Not observable from page JS.

**What the page can see:** the host `<div>` (no attributes, closed shadow → `el.shadowRoot === null`, `childNodes.length === 0`, `getBoundingClientRect()` all zeros, `getComputedStyle(el).display === "contents"`), inserted into `<body>` (or `documentElement` if body is missing) and re-appended so that it stays `document.body.lastElementChild`. **Live:** `DOM_ADDED {tag:"DIV", attrs:[], parent:"BODY", display:"contents", position:"static", zIndex:"auto", openShadow:false, childCount:0, isLastOfBody:true, html:"<div></div>"}` 47 ms after the tab became visible; the host was never removed afterwards (polled for 5 minutes, still present after the agent went idle and the tab was hidden). Page-world `attachShadow` hooks do **not** catch it (isolated world has its own prototypes); use `MutationObserver` + `getComputedStyle`.

### 2.5 Side-panel overlays injected with `chrome.scripting.executeScript` (observable IDs) [LOCAL]

From `assets/sidepanel-BYbpfNZ8.js` (user-initiated features, default isolated world unless noted):

- `#claude-screenshot-overlay` (`position: fixed; top:0; left:0; width:100vw; ...`) — region screenshot picker.
- `#claude-prompt-overlay`, `#claude-prompt-container` — prompt overlay.
- `#claude-element-overlay` — element picker; this flow also runs `chrome.scripting.executeScript({world:"MAIN", func: ...})` which walks React fiber internals (`FunctionComponent:0, ClassComponent:1, HostComponent:5, ForwardRef:11, MemoComponent:14, SimpleMemoComponent:15`, skipping Next.js `LayoutRouter*` contexts) to build a "React Component Stack"; it also posts `window.postMessage({type:"CLAUDE_ELEMENT_SELECTION"...})` / `"CLAUDE_ELEMENT_SELECTION_CLEANUP"` with `"*"` target — a page can observe these `message` events.

These IDs appear in the light DOM (not in a shadow root) and are trivially detectable, but only during the user-driven screenshot/element-picker flows, not during autonomous actions.

### 2.6 How actions are executed (CDP via `chrome.debugger`) [LOCAL: `assets/mcpPermissions-BAI1woDG.js`]

```js
chrome.debugger.attach({tabId:e},"1.3", ...)            // per tab; errors: "debugger_attach_error: chrome.debugger.attach timed out ... DevTools may be open on this tab, or the renderer may have crashed."
// attachDebuggerImpl:
if (consoleTrackingEnabled.has(tab)) sendCommandOnce(tab,"Runtime.enable")
if (networkTrackingEnabled.has(tab)) sendCommandOnce(tab,"Network.enable",{maxPostDataSize:65536})
sendCommandOnce(tab,"Page.enable")                        // always
ensureFocusEmulation(tab) -> "Emulation.setFocusEmulationEnabled",{enabled:true}   // + tab mute/unmute bookkeeping
```

- Refuses `chrome://`-style pages: `"Cannot attach debugger to ${scheme}// pages. Navigate to a regular web page (http:// or https://) first, then retry."`
- Input: `Input.dispatchMouseEvent` (types `mousePressed/mouseReleased/mouseMoved/mouseWheel`, `buttons`, `clickCount`, `force: 0.5` when a button is down — this is the `pressure: 0.5` seen by the page), `Input.dispatchKeyEvent` (`{modifiers:0,...}`), `Input.insertText`. Before a click: `hideIndicatorForToolUse(tab)` then `await dt(50)` (50 ms) so the overlay is hidden during the click.
- Screenshots: `Page.captureScreenshot {format:"jpeg", quality, captureBeyondViewport:false, fromSurface:true}` including for **hidden tabs** (`drawHiddenTab`), i.e. the agent can act on background tabs; JPEG quality starts at 0.75 and steps down by 0.05 to fit 1,398,100 base64 chars.
- `javascript_tool` = `Runtime.evaluate {expression, returnByValue:true, awaitPromise:true, replMode:true}` in the **main world** (live: `window.__PROBE_LOG` visible, `window.__claudeElementMap` undefined). The result serializer redacts keys matching `/password/i`, `/token/i`, ….
- `read_console_messages` enables `Runtime.enable` (live-verified: a `console.log('zzz-marker-1')` was returned by the tool); `read_network_requests` enables `Network.enable`. Neither is on by default.
- Dialog handling: `Page.javascriptDialogOpening` → `Page.handleJavaScriptDialog`; `beforeunload` outcomes tracked per tab.
- Tool names in the bundle: `browser_batch, computer, file_upload, find, form_input, get_page_text, gif_creator, javascript_tool, navigate, read_console_messages, read_network_requests, read_page, resize_window, shortcuts_execute, tabs_close_mcp, tabs_context_mcp, tabs_create_mcp, upload_image`.
- Focus emulation means `document.hasFocus()` can be `true` for a tab whose window is not focused; the service worker also sends `Emulation.setFocusEmulationEnabled {enabled:false}` to still-attached targets on startup (`resetFocusEmulationOnStartup`).

### 2.7 Headers / network

- The only `declarativeNetRequest` rule sets `anthropic-client-version` on `XMLHTTPREQUEST`/`OTHER` requests to `${apiBaseUrl}/*` (Anthropic's API), plus session rules for the claude.ai bridge. **No header is added to requests to third-party sites.** Pages see the normal Chrome UA/brands (`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36`, brands `Google Chrome 155 / Chromium 155 / Not(A:Brand 24`, `navigator.webdriver === false`). [LOCAL + LIVE]
- `performance.getEntriesByType("resource")` did **not** record the successful `chrome-extension://` fetches (empty list after 1.5 s) — resource-timing is not a usable probe channel for extension resources. [LIVE]

### 2.8 Live event trace (Claude in Chrome driving the probe page) [LIVE]

| Tool | What the page observed |
|------|------------------------|
| tab activated for tool use | `visibilitychange → visible`, `focus` (`isTrusted:true`), `document.hasFocus()` false→true; indicator host `<div>` appended 47 ms later |
| `computer left_click ref_3` | `pointerover` (271204.4) → `pointerdown` (271213.1, `pressure:0.5`, `buttons:1`, `width/height:1`) → `mousedown` (`detail:1`) → `focusin` → `pointerup` (271217.9) → `mouseup` → `click` (271217.9, `detail:1`, `isPrimary:false`) — all `isTrusted:true`, `screenX/Y` consistent with the real window position, `movementX/Y: 0`, `sourceCapabilities.firesTouchEvents:false`. Down→up **4.8 ms**. `mousemove` count rose by a handful (one `mouseMoved` per click, no trail) |
| `computer type "abc"` | per char: `keydown` → `keypress` → `beforeinput(insertText)` → `input(insertText)` → `keyup`; `code` correct (`KeyA`), `keyCode` 65/97; 'a','b','c' keydowns at 271287.0 / 271287.0 / 271287.2 — **three keys in 0.2 ms of event-timestamp**, keyups share the keydown timestamp; real wall-clock spacing ≈ 3 ms |
| `computer key Tab` | trusted `keydown Tab` → `change` → `focusin` on next focusable → `keyup` |
| `form_input ref_4 "zzz"` | trusted `focusin`, then `change` and `input` with **`isTrusted:false`** and no `inputType`/`data` (plain `Event`, not `InputEvent`); value replaced wholesale |
| `computer hover` | trusted `pointerover` at exact coordinates, no intermediate moves |
| `computer scroll` | trusted `wheel` at the coordinates |
| `javascript_tool` | runs in main world via `Runtime.evaluate`; no DOM artifact |
| `read_page` / `find` | no DOM change, no long task on a small page |
| `read_console_messages` | `Runtime.enable` sent; the infobar re-appeared: 14 `resize` events, `innerHeight` 919→863 in 4 px steps ~8 ms apart, `outerHeight` 1006 constant (−56 px) |

### 2.9 Detector recipe for Claude in Chrome (ordered)

1. **Presence probe (installed):** `fetch(url, {mode:'no-cors'})` on `chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/assets/accessibility-tree.js-B-oUarrX.js` and `/assets/agent-visual-indicator.js-uaVFxZ2f.js` → `response.ok && response.status === 200` (type `basic`). Non-WAR paths (`manifest.json`, `assets/onboarding-prompts-CJtFEMjA.js`) throw `TypeError: Failed to fetch`, which is the "not accessible" baseline. An `<img>` probe fails for both (JS is not an image) — use `fetch` or `<script>`/`<link rel=prefetch>`. Maintain a table `{version → [paths]}`; 1.0.101 was live until Oct 17 2026 and its hashes may differ (unknown). Chrome MV3 forbids `use_dynamic_url:false` resources being hidden, so this works until Anthropic flips `use_dynamic_url` or narrows `matches`.
2. **Active-agent indicator:** `MutationObserver(document.documentElement, {childList:true, subtree:true})`; flag an added `DIV` with `attributes.length === 0`, `childNodes.length === 0`, `shadowRoot === null`, `getComputedStyle(n).display === "contents"`, parent `BODY`/`HTML`, and `n === document.body.lastElementChild` (re-check on later mutations since the script re-appends it). Expect it ~50 ms after the agent takes the tab; it persists afterwards, so a page loaded during a session will see it appear right after its own `document_idle`.
3. **Infobar burst** (shared with all `chrome.debugger` agents): see §3.
4. **Input fingerprint:** see §3.4.
5. **Synthetic form fill:** `input`/`change` with `isTrusted === false` on an element that just received a trusted `focusin`.
6. **Focus anomaly:** `document.hasFocus() === true` while the page received no `focus` event in the window, or while `document.visibilityState === "hidden"` (focus emulation; weak).
7. **Session-level:** a new `window` created by `chrome.windows.create` with a colored tab group titled "Claude (MCP)" (not page-visible; mention only for support/forensics).

---

## 3. `chrome.debugger` side effects shared by every extension-based CDP agent

### 3.1 The infobar (Chromium source, `main` as of 2026-10-24) [PRIMARY]

- String: `IDS_DEV_TOOLS_INFOBAR_LABEL` = `"<ph name="CLIENT_NAME">$1<ex>Extension Foo</ex></ph>" started debugging this browser` (`chrome/app/generated_resources.grd`) → rendered as **"Claude" started debugging this browser**, "Playwright Extension" started debugging this browser, etc.
- Shown from `ExtensionDevToolsClientHost::Attach()` (`chrome/browser/extensions/api/debugger/debugger_api.cc`) unless `suppress_warning` = `base::CommandLine::ForCurrentProcess()->HasSwitch(::switches::kSilentDebuggerExtensionAPI)` **or** `Manifest::IsPolicyLocation(extension_->location())` ("We allow policy-installed extensions to circumvent the normal infobar warning"). Desktop uses the infobar; Android uses the Messages API (`ExtensionDevToolsMessageDelegate`).
- Two desktop code paths: legacy `ExtensionDevToolsInfoBarDelegate::Create()` → `GlobalConfirmInfoBar::Show()`; migrated path (`infobars::IsInfoBarMigrated(EXTENSION_DEV_TOOLS_INFOBAR_DELEGATE)`) → `ExtensionDevToolsInfoBarController::OnClientHostAttached()` → `infobars::BrowserInfoBarManager::ShowGlobally(...)`. Both are **global**: `GlobalConfirmInfoBar` "is shown for every tab in every browser until it is dismissed or the close method is called" (`chrome/browser/devtools/global_confirm_info_bar.h`). Consequence: the viewport shrinks in **every open tab**, not just the automated one — a page in another tab can detect that some extension started debugging.
- Auto-close: `kAutoCloseDelay = base::Seconds(5)` after the last client host detaches. Pressing the bar's button → `WarningUiDestroyed()` → `detach_reason_ = kCanceledByUser` → the extension's `chrome.debugger.onDetach` fires and the automation loses the tab (a user can kill the agent via the bar).
- Attach limits: "Another debugger is already attached to the * with id: *" (DevTools open or a second extension); enterprise errors "Host access is restricted by policy.", "Screenshot capture is restricted by policy.", "Screenshot capture is restricted on this target."; `Target.attachToTarget`/`Target.autoAttachRelated` filtered by `ExtensionMayAttachToAgentHost`. `--silent-debugger-extension-api` is also what allows attaching to extension background pages (chrome.debugger docs).

### 3.2 Live measurement of the infobar on Chrome 155 / macOS [LIVE]

Sequence when the debugger (re)attached: `resize` events at +0, 8, 16, 25, 33, 41, 45, 53, 61, 70, 78, 86, 94 ms with `innerHeight` 908→904→900→896→892→888→885→881→877→873→869→865→863, `innerWidth` and `outerHeight` unchanged (1728 / 1006). Net viewport loss **56 px** (919 → 863). No layout change in `outerHeight`, so `outerHeight - innerHeight` jumps from ~87 to ~143 px. Heuristic: ≥8 `resize` events within 150 ms, each −2…−5 px, `innerWidth` constant, `outerHeight` constant, cumulative −40…−60 px → `cdp.infobar.appeared` (and the mirror image with positive deltas 5 s after the agent detaches → `cdp.infobar.closed`). A user-dragged resize produces larger, irregular deltas on both axes; DevTools docking changes `innerWidth` or produces one large jump. Note the task brief's "~40 px" figure is from older Chrome UI; on this build with the refreshed infobar it is 56 CSS px (verify on Windows/Linux, Edge, and at DPR 1).

### 3.3 `Runtime.enable` leak probes — negative result on Chrome 155 [LIVE + PRIMARY]

- History: the classic `Error.stack` getter + `console.debug` probe was neutralized by V8 commits of 7 May 2025 ("Avoid error side effects in DevTools") and 9 May 2025 ("Apply getter guard throughout error preview") per Castle; svebaa.github.io (March 2026, tested in a content_shell build) proposed the Proxy-prototype + `console.groupEnd` variant as still working, and claims an undisclosed bypass of the getter guard.
- Measured here with `Runtime.enable` verifiably active (console tracking returned the marker): `{proxyGroupEnd:false, errorStack:false, plainGetterLog:false}` both when run through `Runtime.evaluate` and from the page's own 500 ms interval. So on **Chrome 155 stable with an extension's `chrome.debugger` Runtime domain, none of the three serialization probes fire.** Keep them as low-weight checks for older Chromium forks and Puppeteer/Playwright-launched browsers; do not rely on them for agentic browsers.
- `Runtime.evaluate` itself (used by Claude's `javascript_tool`, Codex, Cursor) leaves no probe-able trace unless the evaluated code mutates the page.

### 3.4 Input-level fingerprints common to CDP `Input.dispatch*` [LIVE + PRIMARY]

- `isTrusted` is **true** for everything dispatched through CDP (`Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Input.insertText`) — the "isTrusted" check is useless against these agents and only catches content-script synthetic events (`form_input`, Chrome MCP Server's selector clicks, HARPA-style DOM automation).
- Pointer: `pointerType:"mouse"`, `pointerId:1`, `width:1`, `height:1`, `pressure` exactly `0.5` while pressed (CDP `force:0.5`) and `0` otherwise, `movementX/Y` always 0, `isPrimary:true` on pointer events but `false` on the derived `click`; the only `mousemove`/`pointerover` is the single jump to the target (no path, no hover jitter, no `pointerrawupdate` stream); `mousedown→mouseup` ≈ 5 ms; `pointerover→pointerdown` ≈ 9 ms.
- Keyboard: `keydown/keypress/keyup` all present with correct `code`, but several events share **identical `timeStamp`** values and successive characters arrive ≈3 ms apart; `beforeinput`/`input` carry `inputType:"insertText"` with fresh timestamps. Humans: 30–150 ms inter-key, 40–120 ms hold time, never identical timestamps across distinct keys.
- Wheel: trusted `wheel` at exact integer coordinates with no preceding movement.
- Score these as a behavioural "robotic input" feature set; combine with #2/#3 for attribution.

### 3.5 Other observables

- Focus emulation (`Emulation.setFocusEmulationEnabled`) is used by Claude and by the Codex driver; pages see `document.hasFocus() === true` without a `focus` event or while hidden. Weak but cheap.
- `Page.captureScreenshot` with `fromSurface:true` on hidden tabs: the page is being screenshotted while `document.visibilityState === "hidden"` — not observable directly, but agents acting on hidden tabs produce trusted input events while `visibilityState === "hidden"`, which never happens for humans. **Strong anomaly rule:** trusted pointer/keyboard events while hidden.
- `chrome.scripting.executeScript` overlays and content-script DOM insertions are visible to page JS (shared DOM) even though their JS globals are not (isolated world).
- Extension-installed `Page.addScriptToEvaluateOnNewDocument` scripts run in the main world unless a `worldName` is specified (Codex's clipboard bridge is main-world; see §4).

---

## 4. OpenAI: ChatGPT extension, Codex "browser" plugin, ChatGPT Atlas, ChatGPT agent

### 4.1 The "ChatGPT" Chrome/Edge extension (drives a user's real browser) [LOCAL + PRIMARY]

- `~/.codex/plugins/cache/openai-bundled/browser/26.1021.31345/scripts/extension-ids.json`:
  - Chrome Web Store: `hehggadaopoacecdllhhajmbjkdcmajg` (`https://chromewebstore.google.com/detail/chatgpt/hehggadaopoacecdllhhajmbjkdcmajg`), also used for Brave, Opera, Vivaldi.
  - Edge Add-ons: `odlomjlbamekndcpllcnffbgeohgkmjh` (`https://microsoftedge.microsoft.com/addons/detail/odlomjlbamekndcpllcnffbgeohgkmjh`).
  - Native messaging host name: `com.openai.codexextension`; Windows manifest dir `AppData/Local/OpenAI/extension`, registry `HKCU\Software\Google\Chrome\NativeMessagingHosts`; macOS manifest dirs for Chrome/Chromium/Chrome for Testing/Edge/Brave/Opera/Vivaldi.
- Web Store listing: name **"ChatGPT"**, developer OpenAI, **7,000,000 users**, version **1.26.1020.11845**, updated **October 22, 2026**, summary "Control your browser with ChatGPT"; it "lets ChatGPT desktop and web use your browser to complete tasks", works "without ever taking over your active browsing session", asks before using history or uploading/downloading files. Rating 1.79/5 (1,008 votes) per extpose.
- Plugin description: "Browser / browser-use plugin … Aliases: @browser, @browser-use, browser-use, Browser, in-app browser." The same driver controls OpenAI's in-app browser ("Dot") and external browsers via the extension (`plugin://browser@openai-bundled?mention=tab-v1&source=extension&browserId=...&tabId=...`). Local IPC socket `/tmp/codex-browser-use` (Windows pipe `\\.\pipe\codex-browser-use`). Config file `~/.codex/chrome-native-hosts-v2.json`.

### 4.2 How the Codex driver acts (from `scripts/browser-service.mjs`, 1.6 MB bundle) [LOCAL]

- CDP through the extension: `Input.dispatchMouseEvent` (`mouseMoved` with `button:"none"`, then `mousePressed`/`mouseReleased` with `clickCount`), `Input.dispatchKeyEvent`, `Input.insertText`, `DOM.scrollIntoViewIfNeeded`, `DOM.getContentQuads`, `DOM.getBoxModel`, `Page.captureScreenshot`, `Accessibility.getFullAXTree` (per frame, merged with a DOM snapshot; a WASM accessibility engine `browser-accessibility.wasm.br` ships in the plugin), `DOMSnapshot.*`, `Target.setAutoAttach {autoAttach:true, flatten:true, waitForDebuggerOnStart:false}` for OOPIFs, and — per attached frame session — `Page.enable` **and `Runtime.enable`** then `Page.getFrameTree` (`runAttachedFrameSessionInitialization`), plus `Emulation.setFocusEmulationEnabled {enabled:true}` (`enableFocusEmulation`).
- Isolated worlds created by name: `Page.createIsolatedWorld {worldName:"browser-use-input-guard"}` and `{worldName:"browser-use-virtual-clipboard"}` (not page-visible by themselves).
- **Main-world artifacts a page can see:**
  - Clipboard bridge: `Runtime.addBinding {name:"__browserUseClipboard_<32hex>"}` then `Page.addScriptToEvaluateOnNewDocument {runImmediately:true, source}` (no `worldName` → main world) which installs `globalThis.__browserUseClipboardBridge` with `bindingName`, `respond()` and `cleanup()`; the driver then checks `globalThis.__browserUseClipboardBridge?.bindingName === "<name>"` via `Runtime.evaluate`. Detect with `typeof globalThis.__browserUseClipboardBridge === "object"` or by enumerating `Object.getOwnPropertyNames(globalThis).filter(n => n.startsWith("__browserUseClipboard"))` (the binding name itself is also exposed as a global function by `Runtime.addBinding`).
  - WebMCP discovery: `readNativeWebMcpFrameTools()` reads `document.modelContext.getTools()`; to detect page-provided WebMCP tools in frames it appends to `document.documentElement` a `div` host with `style.display = "none !important"` whose **closed** shadow root contains an `<iframe name="codex-webmcp-probe-97adecab-75be-4770-bbe4-654cac643843">`; state is cached on `document["__codexNativeWebMcpState"]`. A `MutationObserver` sees the host div insertion; the iframe name is fixed, but it is inside a closed root, so match on "attribute-less div with `display:none` appended to `<html>` (not `<body>`)" plus `window.frames.length` increasing with a frame whose `name` cannot be read.
  - Overlay root constant `"codex-agent-overlay-root"` (an element id/class used by the agent overlay; the injecting code lives in the extension, not in this bundle — exact tag uncertain).
  - Bundled Playwright injected-script code (`__pw_resume`, `__pwClock`, `playwright.selector(element)` helpers, `x-pw-user-overlay`): Playwright normally evaluates this in a utility world, so treat `__pw*` globals as uncertain for this driver.
- Tab semantics: tabs are "claimed" per turn (`browser.user.claimTab`), external tabs are controlled "without moving it into an agent tab group"; the agent can keep the browser hidden ("Keep browser work in the background by default" — `docs/visibility.md`). Safety docs (`browser-safety.md`, `confirmations.md`) require confirmation before transmitting data, submitting forms, purchases, and treat WebMCP tool instructions as untrusted.
- Input guard: `blockClosedShadowInput` option when dispatching keys (Playwright-style hit-target interception checks `isTrusted` on the page side).

### 4.3 ChatGPT Atlas (macOS Chromium fork) [PRIMARY/SECONDARY]

- Page requests: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36` at launch (Oct 2025) — identical to Chrome on macOS; HUMAN Security reports `navigator.userAgent` and `navigator.userAgentData` brands "effectively indistinguishable from Chrome" [SECONDARY]. Background fetches (favicon/logo) use a CFNetwork UA containing `ChatGPT Atlas` (`ChatGPT%20Atlas/... CFNetwork/... Darwin/...`) [SECONDARY, two independent reports] — a server-side signal when `/favicon.ico` is fetched with a Darwin UA by a client that otherwise looks like Chrome.
- Agent mode (OpenAI help text quoted by Simon Willison): "Cannot run code in the browser, download files, or install extensions"; no access to saved passwords/autofill; "ChatGPT is trained to ask before taking many important actions"; pages visited in agent mode "are not added to your browsing history"; "logged out mode": "ChatGPT won't use any pre-existing cookies and won't be logged into any of your online accounts"; UI shows "Take control" and "Stop". Atlas "uses ARIA tags to interpret page structure and interactive elements" and OpenAI asks site owners to add roles/labels/states — i.e. the agent is accessibility-tree driven, so expect **no DOM mutation** and trusted input. Whether Atlas's agent dispatches input through CDP-equivalent plumbing or a renderer-side path is **uncertain** (no source).
- Agent mode in Atlas does **not** carry Web Bot Auth signatures (it runs in the local browser); only OpenAI's cloud browser does (§8). [PRIMARY: OpenAI bots page lists no Atlas UA; help article on Cloud browser allowlisting states signing for "ChatGPT Work's Cloud browser" — summary via search since help.openai.com returned 403]

### 4.4 ChatGPT agent / Operator (cloud) [PRIMARY]

Captured headers (Simon Willison, 4 Aug 2025): UA `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36` with `Sec-Ch-Ua-Platform: "Linux"` (platform mismatch!), `Signature-Agent: "https://chatgpt.com"`, `Signature-Input: sig1=("@authority" "@method" "@path" "signature-agent");created=...;...;tag="web-bot-auth";alg="ed25519"`, `Signature: ...`; keys at `https://chatgpt.com/.well-known/http-message-signatures-directory`. Cloudflare bot tag `chatgpt-agent` (secondary). OpenAI's documented crawler UAs: `ChatGPT-User/1.0; +https://openai.com/bot`, `OAI-SearchBot/1.4; +https://openai.com/searchbot`, `GPTBot/1.4; +https://openai.com/gptbot`, `OAI-AdsBot/1.0; +https://openai.com/adsbot`; IP lists `https://openai.com/chatgpt-user.json`, `/searchbot.json`, `/gptbot.json`, `/adsbot.json`.

---

## 5. Google: Gemini in Chrome / Chrome's built-in "Actor" framework

### 5.1 Presence on this machine (Chrome 155) [LOCAL]

- `ChromeFeatureState` lists `GlicActor`, `GlicActorUi` (both under study `GlicActorRolloutControl`, param `glic-actor-eligible-tiers`), `GlicWebActuationSettingsToggle`, `GlicActorObservationDelayExcludeAdFrameLoading`, `AIPageContentTrackedElementsPassword`, `AnnotatedPageContentWithMediaData` (disabled), `GlicMediaData`, `GlicPrivateApi`, `GlicTieredAccessMac`, `EnterpriseDataProtectionForGlic`, `glic_actor_enterprise_pref_default`, status endpoint `https://geminiweb-pa.googleapis.com/v1/glicStatus`. "Glic" is Chrome's internal name for Gemini in Chrome; "Actor" is the agent engine.
- Component `ActorSafetyLists` version `9.8200.9609` (`manifest.json` + 2.6 MB `listdata.json`): `navigation_blocked` (2,144 `{from,to}` rules; starts with `accounts.google.com`, `chromewebstore.google.com`, `myaccount.google.com`, `gemini.google.com`, `passwords.google.com`, then thousands of alcohol/vape/gambling domains like `[*.]1800tequila.com`) and `navigation_allowed` (20,751 cross-origin pairs such as `https://play.prodigygame.com → https://sso.prodigygame.com`).
- Profile prefs: optimization-guide types `GLIC_ACTION_PAGE_BLOCK` (server-delivered per-URL block hints; `site_policy.cc` fails **open** when hints are missing and blocks only on an explicit `kFalse`), `AUTOFILL_ACTOR_IFRAME_ORIGIN_ALLOWLIST`, `GLIC_CONTEXTUAL_CUEING`, `GLIC_ZERO_STATE_SUGGESTIONS`; `.glic.completed_fre`, side panel width `kGlic`.
- Flags to disable the framework (README): `--disable-features=GlicActor,GlicActorUi`.

### 5.2 Architecture and tools (Chromium `main`) [PRIMARY]

- Browser side (`chrome/browser/actor/`): `ActorKeyedService` (1/profile) → `ActorTask` → `ExecutionEngine` → `ToolController` → `Tool`/`ToolRequest`; `actor_navigation_throttle`, `actor_commit_deferring_condition`, `site_policy`, `actor_enterprise_policy_checker`, `tab_observation_controller`, `headless_web_contents_manager`, `aggregated_journal_render_frame_binder`. Tools dir: `click_tool`, `drag_and_release_tool`, `mouse_move_tool`, `file_upload_tool`, `navigate_tool`, `open_url_tool`, `open_known_page_tool`, `page_tool`, `find_and_highlight_tool`, `perform_search_tool`, `load_and_extract_content_tool`, `bookmark_management_tool`, `history_tool`, `media_control_tool`, `gemini_panel_tool`, `observation_delay_controller`, plus `autofill/`, `one_time_token/`, `password_manager/`.
- Renderer side (`chrome/renderer/actor/`): `click_tool`, `type_tool`, `scroll_tool`, `select_tool`, `drag_and_release_tool`, `mouse_move_tool`, `script_tool`, `no_op_tool`, `click_dispatcher`, `key_dispatcher`, `tool_executor`, `journal`, `chrome_page_stability_monitor_delegate`.
- Click (`click_dispatcher.cc`): optional `WebMouseEvent` move (`features::kGlicActorMoveBeforeClick`, delay `kGlicActorMoveBeforeClickDelay`), then `kMouseDown` (`button_`, `click_count`, `WebInputEvent::kNoModifiers`, `SetPositionInWidget(target_.widget_point)`), then a copy re-typed to `kMouseUp` after `kActorClickDelayParam`, each via `widget->HandleInputEvent(WebCoalescedInputEvent(event, ui::LatencyInfo()))` — the same renderer entry point real input uses, so DOM events will be `isTrusted:true` with `pointerType:"mouse"` and no pressure (uncertain: not measured). Occluded targets use `element.SimulateAccessibilityClick()` ("accessibility-style simulated click path", `kGlicActorOccludedDirectActivation`) — a click **without pointer events**, which is itself a fingerprint (`click` with no preceding `pointerdown`).
- Type (`type_tool.cc`, `key_dispatcher.cc`): focusing click, `ExecuteCommand("SelectAll")`, then per character `RawKeyDown → Char → KeyUp` (`WebKeyboardEvent`, text in `key_event.text[0]`, dead-key composition for accents, AltGr map), paced by `kGlicActorKeyDownDuration` / `kGlicActorKeyUpDuration` (× `kGlicActorIncrementalTypingLongMultiplier` for long text), Enter via `kActorTypeToolEnterDelayParam`; unsupported/very long text falls back to `focused_element.PasteText(...)` (a single `paste`/`insertFromPaste` input, no key events). Fixed, feature-param-driven key durations → **constant keydown→keyup and inter-key deltas** (exact defaults not retrieved; `actor_features.cc` was not found on the mirror — uncertain).
- Navigate (`navigate_tool.cc`): `PAGE_TRANSITION_AUTO_TOPLEVEL`, browser-initiated, `has_user_gesture = true` (or `user_gesture=false` under `kGlicNavigateWithoutUserGesture`), opaque initiator origin under `kGlicNavigateToolUseOpaqueInitiator`. No headers added. Hypothesis to test server-side: agent-driven top-level navigations arrive with `Sec-Fetch-Site: none` and possibly without `Sec-Fetch-User: ?1` and without `Referer`, mid-session, from a client that otherwise sends referrers — weak.
- UI is browser chrome, not page DOM: `actor_border_view_controller` (the glow around the tab), `actor_overlay_ui`/`actor_overlay_web_view` (WebUI overlay), `handoff_button_controller`, `actor_ui_tab_controller`, `actor_ui_window_controller`, `actor_task_unload_handler`, `dom_node_geometry` (reads page geometry for overlays). The 9to5google Sept 18 2025 write-up: "A glow indicates when Gemini is active, and you can take over at any time"; the agent clicks, scrolls and types, pauses before purchases; rollout to Windows/Mac US users, agentic features "in the coming months" (later marketed as "Auto Browse" per Neowin, which returned 403 here).
- Security design (Google, Dec 2025, `blog.google/security/architecting-security-for-agentic/`): planner "uses page content shared in Chrome"; **Agent Origin Sets** (read-only vs read-writable origins; iframes from unrelated origins hidden from the model; model-generated URLs restricted to known public URLs); **User Alignment Critic** (separate model that "is architected to see only metadata about the proposed action and not any unfiltered untrustworthy web content"); prompt-injection classifier on every page; confirmations before sensitive sites (deterministic list), password-manager sign-in, purchases/payments/messages; work log; stop/take-over.

### 5.3 What a page can and cannot detect

- No extension ID, no `web_accessible_resources`, no content script, no `chrome.debugger` infobar (it is not an extension), no header, no global, no DOM insertion. UA/brands = normal Chrome.
- Available: robotic input timing (constant durations), click without pointer events (occluded-target path), paste-fallback typing, trusted input while `document.visibilityState === "hidden"` is **not** expected (the Actor can run in a `headless_web_contents_manager`, i.e. background tabs — uncertain), absence of hover trails, pre-navigation stability waits (`observation_delay_controller`: the agent waits for "page stability" before each observation, producing regular action cadence). Also the page may be loaded with ad frames excluded from observation delay (`GlicActorObservationDelayExcludeAdFrameLoading`), irrelevant to detection.
- The `ActorSafetyLists` navigation block list is not something a site can join; there is **no site-level opt-out** (robots.txt/meta/header) in `site_policy.cc` — blocks come from Google's lists, enterprise policy, Safe Browsing, lookalike-domain and IP-address rules (`kIpAddress`, `kWrongScheme`, `kTabIsErrorDocument`, `kDangerousMimeType`, `kBlockedByContainerConfig`).

---

## 6. Perplexity Comet

- Comet is "a Chromium-based browser" with "support for most Chrome extensions"; the Assistant can be allowed/prohibited to "access your browser history, navigate the web, and interact with sites"; per-site blocking exists ("Block tasks on specific websites"); "Comet never has access to your passwords or payment data"; the Assistant "pulls in the visible text, headlines, and website metadata from your open page" and can run tasks "while you browse other pages" (parallel background tasks). [PRIMARY: Perplexity help center]
- The assistant is a built-in component extension with ID **`npclhjbddhklpbnacpjloidibaggcgon`** — confirmed by two independent sources: Perplexity's own native-messaging manifest on this machine (`com.perplexity.comet.json`, `allowed_origins: chrome-extension://npclhjbddhklpbnacpjloidibaggcgon/`) and Hacktron's UXSS write-up ("Most of Comet Assistant's inner workings live inside the extension"). Manifest facts from Hacktron: `externally_connectable.matches = ["https://*.perplexity.ai/*"]` (any perplexity.ai subdomain can message it — the UXSS vector, patched Aug 2025); external message types `COMET_CLOSE_SIDECAR`, `DEACTIVATE_SCREENSHOT_TOOL`, `MAKE_TASK_VISIBLE`, `MOVE_THREAD_TO_SIDECAR`, `TEST_RUN_ACTION`, `RUN_IDLE_TEST`, `CALL_TOOL`, port action `startAgentFromPerplexity` (connects to `wss://www.perplexity.ai`); tool class methods `GetContent`, `GetSidecarContext`, `SearchBrowser`, `GetVisibleTabScreenshot`, `OpenTab`, `CloseTabs`, `GroupTabs`, `UngroupTabs`, `SearchTabGroups`; `RUN_IDLE_TEST` uses `chrome.debugger.sendCommand` → `DOMSnapshot.captureSnapshot` returning `snapshotHtml` and `snapshotAxTree`; the backend "returns selectors" and the extension executes clicks. Whether clicks go through `chrome.debugger` (`Input.*`, trusted) or content-script DOM events (untrusted) is **uncertain** — the Hacktron text says actions are executed "in the page". [LOCAL + SECONDARY]
- Consequences: (a) the extension holds the `debugger` permission; if it attaches with `chrome.debugger`, the global infobar logic applies **unless** Comet suppresses it (component/forked builds can pass `--silent-debugger-extension-api` or special-case their own extension — uncertain); (b) `web_accessible_resources` unknown (no manifest available) — probe `chrome-extension://npclhjbddhklpbnacpjloidibaggcgon/<path>` only once a path is known; (c) UA/brands reported as indistinguishable from Chrome [SECONDARY: HUMAN], "Perplexity-specific headers" claimed by HUMAN's Comet page but not specified (uncertain, page 403).
- Cloud-side UAs (not Comet): `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)` and `... Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)`; IP lists `https://www.perplexity.com/perplexitybot.json`, `https://www.perplexity.com/perplexity-user.json`; Perplexity-User "typically disregards robots.txt". [PRIMARY]
- The macOS Perplexity app (`ai.perplexity.macv3` 26.39.0) ships `comet-native-host`; Comet itself was not installed here, so no live measurement.

---

## 7. Microsoft Edge Copilot Mode / Copilot Actions

- Microsoft's product page (explore.microsoft.com/en-us/edge/copilot-mode) describes Copilot reading across tabs, Journeys, Copilot new-tab; it does not describe Actions mechanics or indicators. Microsoft's UA guidance: Edge UA = Chromium UA + trailing `Edg/<version>` token; recommends UA-CH over UA sniffing; nothing about Copilot. [PRIMARY]
- HUMAN Security's "Copilot Actions" page (via search summary; page not fetched) claims Copilot Actions "inherits the user's browser UA" and has "no signed HTTP identity"; TestingCatalog/WindowsReport describe "Copilot Actions" / "Browser Actions" as hidden/beta features that automate browsing from the Copilot new-tab page. [SECONDARY]
- Detection: no primary technical signal found. Treat like Gemini in Chrome: brands `Microsoft Edge`/`Chromium`, behavioural signals only. Verify with a live Edge Canary run (Edge is not installed here).

---

## 8. HTTP-level identity for agents (Web Bot Auth)

- IETF: **draft-ietf-webbotauth-httpsig-protocol-00**, "HTTP Message Signatures for automated traffic", 1 Sept 2026 (expires 5 Mar 2027), WG draft (replaces draft-meunier-webbotauth-httpsig-protocol), authors Thibault Meunier (Cloudflare), Sandor Major (Google), Standards Track. Headers: `Signature`, `Signature-Input` (params `created`, `expires`, `keyid`, `tag`), `Signature-Agent`; optional `Content-Digest`; origins may request a signature with `Accept-Signature`. `Signature-Agent` is now a **Dictionary** (`sig1="https://signature-agent.test"`, member param `type` ∈ `directory` (default) | `jwks_uri` | `cimd`); legacy bare quoted-string form may be accepted but "signers MUST send the dictionary form". [PRIMARY]
- Cloudflare docs: `tag="web-bot-auth"` on requests, `tag="http-message-signatures-directory"` on directory responses, directory at `/.well-known/http-message-signatures-directory`, `@authority` recommended, `signature-agent` must be in the covered components; transitive trust via `Forwarded: for="openai"` style headers (experimental). Signed agents (Aug 28 2025 blog): "generally directed by an end user", infrastructure "signs its requests with Web Bot Auth"; first cohort **ChatGPT agent (OpenAI), Goose (Block), Browserbase, Anchor Browser, Cloudflare Browser Rendering**; Radar directory `https://radar.cloudflare.com/bots/directory`. Verified-bot categories usable in WAF rules include "AI Crawler", "AI Assistant", "AI Search" (e.g. `Perplexity-User`, `DuckAssistBot`, `OAI-SearchBot`). [PRIMARY]
- Implication for this product: a server/edge companion should verify `Signature-Agent`/`Signature-Input`/`Signature` (RFC 9421, ed25519) and fetch the directory; treat a valid signature as attribution (`chatgpt.com`, Browserbase, Anchor). None of the local agentic browsers/extensions sign anything, so the client-side SDK remains the only way to see them.

---

## 9. Other extensions and drivers

### 9.1 Playwright MCP Bridge — "Playwright Extension" `mmlmfjhmonkocbjadbfplnigmagldckm` [PRIMARY]

- Web Store: name **"Playwright Extension"**, Microsoft (Playwright Team), 100,000 users, **v0.4.0**, updated **September 1, 2026** (earlier listed as "Playwright MCP Bridge"). Enabled with `@playwright/mcp --extension`; env `PLAYWRIGHT_MCP_EXTENSION_TOKEN` skips the approval dialog; `--profile-dir-name` / `PLAYWRIGHT_MCP_PROFILE_DIR_NAME` picks the profile.
- `packages/extension/manifest.json`: `"permissions": ["debugger","activeTab","tabs","tabGroups"]`, `"host_permissions": ["<all_urls>"]`, background `lib/background.mjs` (module), **no `content_scripts`, no `web_accessible_resources`, no `externally_connectable`** → nothing to probe by URL; no DOM injection.
- `relayConnection.ts`: a WebSocket relay that only executes `chrome.debugger.attach`, `chrome.debugger.detach`, `chrome.debugger.sendCommand`, `chrome.tabs.create`, `chrome.tabs.remove` ("resolved reflectively"); forwards `chrome.debugger.onEvent`/`onDetach`, `tabs.onCreated`/`onRemoved`; holds traffic until `extension.initialized` so `Target.setAutoAttach` sees the tab model; reattaches 150 ms after `target_closed` (verify ≤2500 ms, 3000 ms cooldown). All CDP (including Playwright's own `Runtime.enable`, `Page.addScriptToEvaluateOnNewDocument` init scripts, utility worlds) comes from the Playwright client unfiltered.
- `connectedTabGroup.ts`/`background.ts`: tab group titled **"Playwright · <clientName>"** (suffix `(2)` on duplicates), colours cycling green, blue, purple, orange, pink, cyan, yellow, red; connected tabs get a green `✓` badge with tooltip "Connected to Playwright client"; `chrome://`, `edge://`, `devtools://` tabs are not attached; status page `status.html`; keepalive every ~20 s.
- Detection: infobar burst ("Playwright Extension" started debugging this browser), trusted-but-robotic input (Playwright moves the mouse in steps when `steps` is set, otherwise a single move), plus whatever the Playwright client leaks (`Runtime.enable` per frame, `__playwright__binding__`/`__pwInitScripts` in utility world — not page-visible; `navigator.webdriver` stays `false` because the real Chrome profile is used).

### 9.2 Browser MCP `bjfgambnhccakkhmkepdoekmckoijdlc` [PRIMARY/SECONDARY]

- Web Store: **"Browser MCP - Automate your browser using VS Code, Cursor, Claude, and more"**, 100,000 users, **v1.3.4**, updated **May 7, 2025**, site browsermcp.io. README (github.com/BrowserMCP/mcp): "adapted from the Playwright MCP server", automates "the user's existing browser"; marketing: "Avoids basic bot detection and CAPTCHAs by using your real browser fingerprint". Server↔extension WebSocket on **port 9009** bound to all interfaces with no token (secondary review); the extension attaches CDP to the connected tab and dispatches input (secondary). Unrelated projects with the same name (@agent360/browser-mcp, ports 9876–9895; others on 12800/8787) exist.
- Detection: infobar burst, robotic trusted input; extension manifest not public (WAR unknown).

### 9.3 Nanobrowser `imbddededgmcgfhfpcjmijokokekbkal` [PRIMARY]

- Web Store: **"Nanobrowser"**, 70,000 users, **v0.3.0**, updated **October 16, 2026**, nanobrowser.ai (Edge build reported under `ajdioenfpgabnjlclgckbbnjjhdnjkhn` — secondary). README: "talks to the page only through Chrome's `chrome.debugger` API", "uses Puppeteer to keep track of frames on the page", "Each element the agent sees gets an ID that is tied to that exact element". PR #313 (Apr 28 2026) proposes moving `debugger` to `optional_permissions`. `wxt.config.ts`: `host_permissions: ['<all_urls>']`, `minimum_chrome_version: '125'`, permissions spread from `./src/ui/manifest-permissions` (reported set: storage, scripting, tabs, activeTab, debugger, unlimitedStorage, webNavigation, sidePanel — secondary), no `content_scripts`/`web_accessible_resources` in the config, commands `open-panel` (`Alt+Shift+N`) and `open-test-panel`.
- Detection: infobar burst, Puppeteer-over-chrome.debugger behaviour (Puppeteer sends `Runtime.enable`, `Page.enable`, `Target.setAutoAttach`, and uses `Page.addScriptToEvaluateOnNewDocument` with `__puppeteer_utility_world__` — world-scoped, not page-visible), element-index highlighting overlays if the agent draws them (uncertain for current version).

### 9.4 HARPA AI `eanggfilgoajaocelnaflolkadkeghjp` [PRIMARY]

- Web Store: **"HARPA AI: Web Automation with ChatGPT, Claude, Gemini, Grok"**, HARPA AI TECHNOLOGIES OY, 400,000 users, **v16.1.0**, updated **October 24, 2026**. Requires "On all sites" access; injects a floating quick-access bar on text selection and a popup UI; AI Commands "navigate to a page, click a button, extract data"; Web Monitors with auto-refresh. The DOM-based automation strongly implies content-script synthetic events (`isTrusted:false`) and injected UI (likely shadow-rooted) — **uncertain** without the manifest (crx mirrors not consulted).

### 9.5 Chrome MCP Server (hangwin/mcp-chrome) [PRIMARY]

- Extension loaded unpacked from GitHub releases (no stable store ID confirmed — uncertain); native host via npm `mcp-chrome-bridge` (`register` step), Streamable HTTP at `http://127.0.0.1:12306/mcp` or STDIO. Tools: `chrome_click_element` (ref/CSS selector/coordinates), `chrome_fill_or_select`, `chrome_keyboard`, `chrome_screenshot` (`background` capture "viewport-only uses CDP"), `chrome_inject_script` ("Inject content scripts into web pages") + `chrome_send_command_to_inject_script`, `chrome_network_capture_*` (webRequest) and `chrome_network_debugger_*` ("Debugger API with response bodies"). Architecture (WXT + Vue): "Content Scripts: Page interaction and content extraction", offscreen documents for a local semantic-similarity model.
- Detection: selector/ref clicks are content-script DOM events → `isTrusted:false` (likely); `chrome.debugger` only for network/background screenshots → infobar only in those modes.

### 9.6 Taxy AI (open-source, "Taxy AI Alpha") [PRIMARY]

`src/manifest.json`: permissions `tabs, activeTab, storage, clipboardWrite, debugger, management`; content script `contentScript.bundle.js` + `content.styles.css` on `http://*/*`, `https://*/*`, `<all_urls>`; `web_accessible_resources` with `"matches": []` (not probeable); background `background.bundle.js`. Acts via `chrome.debugger` (infobar) and injects a stylesheet (a `<link>`/`<style>` with extension-origin CSS is visible as a stylesheet whose `href` starts with `chrome-extension://` in `document.styleSheets` — check `sheet.href`). Project is largely dormant; low priority.

### 9.7 Cursor "Browser Automation" (built into Cursor.app) [LOCAL]

`/Applications/Cursor.app/Contents/Resources/app/extensions/cursor-browser-automation/` ("Cursor Browser Automation", "MCP server for browser automation in Cursor", 1.0.0). It drives Cursor's embedded browser through `Runtime.evaluate` (18 uses) and `Page.captureScreenshot`; no `Input.dispatch*`, no `remote-debugging-port`, no Puppeteer/Playwright strings. It injects page JS (`injectBrowserUIScript`) that sets `window.__cursorBrowserAutomationInjected = true` ("Only inject in top-level frame"), `window.__cursorAreaScreenshotInjected`, `window.__cursorAreaScreenshotCommand`, tags elements with **`data-cursor-ref="e<N>"`** (`/^e\d+$/`, scanning open shadow roots too) and draws a `data-cursor-overlay`. Because these go through `Runtime.evaluate`, they are main-world and trivially detectable (`document.querySelector('[data-cursor-ref]')`, `window.__cursorBrowserAutomationInjected`). Whether Cursor can be pointed at a user's external Chrome is unknown (no CDP endpoint strings found).

### 9.8 Browser Use, MultiOn/Please, Opera Neon, Dia, Fellou, Browserbase/Steel

- **Browser Use**: README mentions `Browser.from_system_chrome()` (reuse a Chrome profile), control of "an existing remote browser over CDP", Browser Use Cloud "stealth browsers", residential proxies, CAPTCHA solving; no Chrome extension, no extension ID found (uncertain whether one exists). Its DOM highlighting attributes were not verifiable from the README.
- **MultiOn → Please**: please.ai now markets a mobile to-do/reminders app ("Research preview", App Store link), no Chrome extension mentioned; the original MultiOn extension appears discontinued (uncertain; no search budget to confirm an ID).
- **Opera Neon** (operaneon.com): "Neon Do" can "read the page", "browse the web", take "direct action on your behalf", connects agents via MCP/CLI, "login credentials and cookies stay on your device"; no technical detail, UA unknown (Opera normally appends `OPR/<ver>`; whether Neon does is uncertain).
- **Dia** (diabrowser.com): page describes context gathering across tabs/tools, not page actuation; UA unknown (Arc/Dia historically use plain Chrome UA — uncertain).
- **Fellou** (fellou.ai): "Deep Action" runs tasks in a "shadow workspace"/"back-end workspace" (local vs cloud unspecified), handles "logins, authentication, and even CAPTCHA challenges" by "simulating human behavior", can "operate local apps and manage files" with permission; no UA/indicator information.
- **Browserbase**: cloud browsers can load custom extensions (`extensions.create` with a ≤100 MB zip containing `manifest.json`, then `extensionId`/`extension_id` on session create); signs requests with Web Bot Auth (Cloudflare signed-agent cohort). **Steel**: cloud "headless browser API", "rotating proxies, stealth configs, and CAPTCHA solving". Neither was found to control a user's local Chrome via an extension (the brief's "remote Chrome via extension" item remains **unknown**).

---

## 10. Technique-by-technique evaluation (for the SDK)

| Technique | Verdict | Notes |
|-----------|---------|-------|
| Probe `web_accessible_resources` by extension ID | **Works** for Claude (two `<all_urls>` resources, static URLs). Not available for Playwright Extension (no WAR), Taxy (`matches: []`), Nanobrowser (none in config); unknown for ChatGPT, Browser MCP, HARPA, Comet | Use `fetch(..., {mode:'no-cors'})`; success = `ok && status===200`, failure = `TypeError`. Not recorded in resource timing. Rotate the hash table per version; probing is silent (no CSP violation unless `connect-src` blocks `chrome-extension:` — pages with strict CSP need a `<link rel="prefetch">`/`<script>` fallback and `onerror` timing). Chrome also allows `web_accessible_resources` with `use_dynamic_url:true` to defeat this; Anthropic currently does not use it |
| `chrome.debugger` infobar → `innerHeight` shrink | **Works** on desktop Chrome/Edge; global across tabs; 56 px here (brief said ~40); animated (≈14 resize events, 4 px steps) | Suppressed for policy-installed extensions, `--silent-debugger-extension-api`, Android; no infobar for Chrome's own Actor or for Atlas/Comet internal plumbing if they bypass the extension API |
| `Runtime.enable` leak probes | **Dead on Chrome 155** for extension CDP (3 variants tested, `Runtime.enable` verified active) | Keep as legacy low-weight check; revisit with new Chromium releases |
| Content-script DOM side effects | **Works** for Claude (indicator host), Codex (hidden WebMCP probe host, overlay root), Cursor (`data-cursor-ref`), Claude's picker overlays; none for Playwright/Nanobrowser/Browser MCP/Gemini | Watch `MutationObserver` for attribute-less hosts with closed shadow roots and `display: contents` / `display: none` at the end of `<body>`/`<html>` |
| CSS injection via `getComputedStyle` | Claude: `:host` rule is inside the closed root but its effect (`display: contents`) is readable on the host — **works**; Taxy injects a content stylesheet (check `document.styleSheets[i].href`); others none | |
| `performance` entries with `chrome-extension:` URLs | **Does not work** for `fetch` of extension resources (no entries) | Might still work for extension-injected `<script src=chrome-extension://…>` or images; untested |
| AX-tree-driven agents (no DOM change) | Claude `read_page`/`find`, Codex `Accessibility.getFullAXTree`, Comet `DOMSnapshot.captureSnapshot`, Atlas (ARIA), Gemini (AnnotatedPageContent) — all silent | Only indirect: forced layout long tasks, action cadence after "page stability" |
| Isolated vs main world | Manifest content scripts (Claude) = isolated → globals invisible; `chrome.scripting.executeScript({world:"MAIN"})` (Claude element picker), `Runtime.evaluate` (Claude `javascript_tool`, Cursor), `Page.addScriptToEvaluateOnNewDocument` without `worldName` (Codex clipboard bridge) = main → globals visible | Enumerate `Object.getOwnPropertyNames(window)` deltas after load; look for `__browserUseClipboard*`, `__cursor*` |
| `isTrusted` | CDP input (`Input.dispatch*`) and Chrome Actor input are **trusted**; content-script tools (`form_input`, selector clicks) are **untrusted** | Use event *shape* and *timing* rather than `isTrusted` |
| Keyboard/mouse timing | Strong behavioural signal for all drivers (3 ms inter-key, 5 ms click, identical timestamps, no hover path, `pressure` 0.5) | Needs per-site calibration; combine with session-level features |
| Headers / client hints | None for local agents; `Signature-Agent` only for cloud agents; favicon UA `ChatGPT Atlas` (secondary) | Server companion verifies Web Bot Auth; log Darwin/CFNetwork favicon UAs |
| Extension-name/ID via `chrome.runtime` | Not reachable from pages unless `externally_connectable` matches the page (Claude: claude.ai only; Comet: *.perplexity.ai; Redux DevTools/MetaMask accept any id) | Not usable for third-party sites |

---

## 11. Suggested detector modules (pseudo-code sketches)

```js
// ext.war — presence of known agent extensions (run once at load, async)
const WAR = {
  "claude-in-chrome": ["chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/assets/accessibility-tree.js-B-oUarrX.js",
                       "chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/assets/agent-visual-indicator.js-uaVFxZ2f.js"], // v1.0.102
};
for (const [agent, urls] of Object.entries(WAR)) for (const u of urls)
  fetch(u, {mode:'no-cors', cache:'no-store'}).then(r => r.ok && report('ext.war', agent, u)).catch(()=>{});

// claude.indicator — bare display:contents host appended last in body
new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) {
  if (n.nodeType!==1 || n.tagName!=='DIV' || n.attributes.length || n.childNodes.length || n.shadowRoot) continue;
  const cs = getComputedStyle(n);
  if (cs.display==='contents' && (m.target===document.body||m.target===document.documentElement) && n===m.target.lastElementChild) report('claude.indicator');
  if (cs.display==='none' && m.target===document.documentElement) report('codex.webmcp-probe-host');   // Codex hidden host (iframe inside closed root)
}}).observe(document.documentElement,{childList:true,subtree:true});

// cdp.infobar — animated global infobar
let burst=[]; addEventListener('resize',()=>{ burst.push({t:performance.now(),ih:innerHeight,iw:innerWidth,oh:outerHeight});
  burst=burst.filter(b=>performance.now()-b.t<200);
  if (burst.length>=8 && burst.every((b,i)=>i===0||(b.iw===burst[0].iw&&b.oh===burst[0].oh&&burst[i-1].ih-b.ih>=2&&burst[i-1].ih-b.ih<=5))
      && burst[0].ih-burst.at(-1).ih>=40) report('cdp.infobar'); });

// input.robotic — per-event features (feed a scorer)
// pressure===0.5 on pointerdown, movementX===0&&movementY===0 always, pointerover→pointerdown<15ms, mousedown→mouseup<15ms,
// inter-keydown<10ms, keydown.timeStamp===keyup.timeStamp, click without pointerdown (Chrome Actor occluded path),
// trusted input while document.visibilityState==='hidden', input/change with isTrusted===false and !(e instanceof InputEvent)

// globals.main — main-world residue
for (const k of Object.getOwnPropertyNames(window)) if (/^__browserUseClipboard|^__cursor|^__pw|^__codex/.test(k)) report('globals.main', k);
if (document.querySelector('[data-cursor-ref]')) report('cursor.refs');
```

Attribution mapping: `ext.war:claude` + `claude.indicator` → Claude in Chrome acting; `cdp.infobar` + robotic input without any DOM residue → Playwright Extension / Browser MCP / Nanobrowser / Comet (needs WAR tables to split); `globals.main:__browserUseClipboard*` or `codex.webmcp-probe-host` → OpenAI ChatGPT/Codex extension; `cursor.refs` → Cursor; robotic input with **no** infobar, no residue, Chrome brands → Gemini in Chrome (or Atlas/Comet/Edge if brands/UA/CFNetwork favicon say so).

---

## 12. Unknowns and follow-ups

1. Claude in Chrome per-version `web_accessible_resources` hashes (only 1.0.102 captured; 1.0.101 and earlier unknown) — build a crawler over Web Store CRX versions (requires an approved download step).
2. Whether Comet's assistant dispatches input via `chrome.debugger` (trusted) or content scripts (untrusted), whether Comet shows/suppresses the debugger infobar, and its WAR list — needs Comet installed and the probe page.
3. ChatGPT Atlas agent-mode input path and any DOM residue; `navigator.userAgentData` full high-entropy values (`getHighEntropyValues({hints:['fullVersionList','uaFullVersion','platformVersion']})`) might reveal a non-Chrome `fullVersionList` entry — untested (needs a Mac with Atlas).
4. OpenAI "ChatGPT" extension manifest (`hehggadaopoacecdllhhajmbjkdcmajg`): permissions, WAR, content scripts, the real overlay element for `codex-agent-overlay-root`, whether it sends `Runtime.enable` on every tab (the driver does per frame session), and infobar behaviour.
5. Gemini in Chrome: exact `kGlicActor*` timing defaults (feature file not found on the GitHub mirror — search `chromium.googlesource.com` for `kGlicActorKeyDownDuration`), whether `WebWidget::HandleInputEvent` events expose `pressure` and `isPrimary` like OS input, whether the Actor acts on hidden/headless tabs, and the `Sec-Fetch-User` hypothesis.
6. Edge Copilot Actions: no primary technical source; needs a live run in Edge Canary with the probe page.
7. Opera Neon, Dia, Fellou, Browser Use extension, MultiOn/Please, Browserbase/Steel "extension" products: identities and mechanics unresolved (search budget exhausted).
8. `Runtime.enable` probes: re-test on Chrome 156+ and on Chromium forks; the svebaa "Path B" bypass is undisclosed.
9. Infobar geometry on Windows/Linux, DPR 1, Edge, and the "migrated" infobar path (`BrowserInfoBarManager::ShowGlobally`) — confirm the 56 px figure and the animation profile.
10. Long-task attribution for AX-tree generation on heavy pages (Claude's `__generateAccessibilityTree` walk) — measure on a 10k-element fixture.

---

## 13. Sources

Local files (research machine):
- `~/Library/Application Support/Google/Chrome/Default/Extensions/fcoeoabgfenejglbffodgkkbkcdhcgfn/1.0.102_0/` — `manifest.json`, `assets/accessibility-tree.js-B-oUarrX.js`, `assets/agent-visual-indicator.js-uaVFxZ2f.js`, `assets/mcpPermissions-BAI1woDG.js`, `assets/service-worker.ts-jNvObEJy.js`, `assets/sidepanel-BYbpfNZ8.js`, `managed_schema.json`, `git-hash.txt`
- `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/{com.anthropic.claude_browser_extension,com.anthropic.claude_code_browser_extension,com.perplexity.comet}.json`
- `~/Library/Application Support/Google/Chrome/Default/Secure Preferences` (extension install location), `Default/Preferences` (glic/optimization-guide keys), `ChromeFeatureState`, `RunningChromeVersion`, `ActorSafetyLists/9.8200.9609/{manifest.json,listdata.json}`
- `~/.codex/plugins/cache/openai-bundled/browser/26.1021.31345/` — `.codex-plugin/plugin.json`, `scripts/extension-ids.json`, `scripts/browser-service.mjs`, `docs/{visibility,tab-claiming-chrome,tab-claiming-dot,webmcp,accessibility,browser-safety,confirmations,api-use-behavior}.md`; `~/.codex/chrome-native-hosts-v2.json`
- `/Applications/Cursor.app/Contents/Resources/app/extensions/cursor-browser-automation/{package.json,dist/*.js}`
- Probe page: `/private/tmp/claude-501/-Users-dev-Projects-necter/3044e935-0f92-4a55-99e9-6a0b4223c15f/scratchpad/agentprobe/probe.html`

Web:
- https://chromewebstore.google.com/detail/fcoeoabgfenejglbffodgkkbkcdhcgfn (Claude, 20M users, 1.0.102, 2026-10-21)
- https://extpose.com/ext/fcoeoabgfenejglbffodgkkbkcdhcgfn ; https://extpose.com/ext/hehggadaopoacecdllhhajmbjkdcmajg
- https://www.originhq.com/research/claude-for-chrome-takeover (native host internals, storage keys, tab group "Claude (MCP)")
- https://github.com/anthropics/claude-code/issues/23218 , /21783 , /31971 (native host connection issues)
- https://chromewebstore.google.com/detail/hehggadaopoacecdllhhajmbjkdcmajg (ChatGPT extension, 7M users, 1.26.1020.11845, 2026-10-22)
- https://chromewebstore.google.com/detail/mmlmfjhmonkocbjadbfplnigmagldckm (Playwright Extension 0.4.0, 2026-09-01)
- https://raw.githubusercontent.com/microsoft/playwright/main/packages/extension/README.md ; .../manifest.json ; .../src/relayConnection.ts ; .../src/background.ts ; .../src/connectedTabGroup.ts ; https://playwright.dev/mcp/configuration/browser-extension
- https://chromewebstore.google.com/detail/bjfgambnhccakkhmkepdoekmckoijdlc (Browser MCP 1.3.4, 2025-05-07) ; https://raw.githubusercontent.com/BrowserMCP/mcp/main/README.md ; https://browsermcp.dev/docs/what-is-browser-mcp/
- https://chromewebstore.google.com/detail/imbddededgmcgfhfpcjmijokokekbkal (Nanobrowser 0.3.0, 2026-10-16) ; https://github.com/nanobrowser/nanobrowser ; https://raw.githubusercontent.com/nanobrowser/nanobrowser/master/wxt.config.ts ; https://github.com/nanobrowser/nanobrowser/pull/313
- https://chromewebstore.google.com/detail/eanggfilgoajaocelnaflolkadkeghjp (HARPA AI 16.1.0, 2026-10-24) ; https://harpa.ai/welcome
- https://raw.githubusercontent.com/hangwin/mcp-chrome/master/README.md ; .../docs/ARCHITECTURE.md ; .../docs/TOOLS.md
- https://raw.githubusercontent.com/TaxyAI/browser-extension/main/src/manifest.json
- https://raw.githubusercontent.com/browser-use/browser-use/main/README.md
- https://www.hacktron.ai/blog/perplexity-comet-uxss (Comet assistant extension `npclhjbddhklpbnacpjloidibaggcgon`)
- https://www.perplexity.ai/help-center/en/articles/11172798-getting-started-with-comet ; https://www.perplexity.ai/help-center/comet/ ; .../comet/en/articles/11734688-assistant-panel ; .../comet/en/articles/12658082-control-what-comet-assistant-can-use ; https://docs.perplexity.ai/guides/bots
- https://www.humansecurity.com/learn/blog/chatgpt-atlas-vs-perplexity-comet-agentic-browsers/ ; https://www.humansecurity.com/ai-agent/perplexity-comet/ ; https://www.humansecurity.com/ai-agent/copilot-actions/ (403 on fetch; cited via search summaries)
- https://www.chrisrcook.com/2025/10/22/chatgpt-atlas-user-agent/ ; https://www.aisearchoptimization.in/blog/chatgpt-atlas-user-agent-why-youre-suddenly-seeing-it-in-your-server-logs/ (favicon UA)
- https://simonwillison.net/2025/Oct/21/introducing-chatgpt-atlas/ ; https://simonwillison.net/2025/Aug/4/chatgpt-agents-user-agent/
- https://developers.openai.com/api/docs/bots ; https://help.openai.com/en/articles/11845367-chatgpt-works-cloud-browser-allowlisting (403; via search summary)
- https://blog.google/security/architecting-security-for-agentic/ ; https://9to5google.com/2025/09/18/gemini-in-chrome/ ; https://9to5google.com/2025/12/08/gemini-chrome-agentic-security/
- Chromium (GitHub mirror, `main`): https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/actor/README.md ; https://github.com/chromium/chromium/tree/main/chrome/browser/actor ; .../chrome/browser/actor/tools ; .../chrome/browser/actor/ui ; .../chrome/renderer/actor ; https://raw.githubusercontent.com/chromium/chromium/main/chrome/renderer/actor/click_tool.cc ; .../click_dispatcher.cc ; .../key_dispatcher.cc ; .../type_tool.cc ; .../chrome/browser/actor/tools/navigate_tool.cc ; .../chrome/browser/actor/site_policy.cc ; .../chrome/browser/extensions/api/debugger/debugger_api.cc ; .../extension_dev_tools_infobar_delegate.cc ; .../extension_dev_tools_infobar_delegate.h ; .../chrome/browser/devtools/global_confirm_info_bar.h ; .../chrome/app/generated_resources.grd (IDS_DEV_TOOLS_INFOBAR_LABEL)
- https://developer.chrome.com/docs/extensions/reference/api/debugger
- https://blog.castle.io/why-a-classic-cdp-bot-detection-signal-suddenly-stopped-working-and-nobody-noticed/ ; https://svebaa.github.io/personal/blog/cdp-fingerprinting/ ; https://github.com/copyleftdev/palimpsest/issues/3 ; https://datadome.co/threat-research/how-new-headless-chrome-the-cdp-signal-are-impacting-bot-detection/
- https://datatracker.ietf.org/doc/draft-ietf-webbotauth-httpsig-protocol/ ; https://developers.cloudflare.com/bots/concepts/bot/verified-bots/web-bot-auth/ ; https://developers.cloudflare.com/bots/concepts/bot/signed-agents/ ; https://blog.cloudflare.com/signed-agents/ ; https://radar.cloudflare.com/bots/directory
- https://learn.microsoft.com/en-us/microsoft-edge/web-platform/user-agent-guidance ; https://explore.microsoft.com/en-us/edge/copilot-mode ; https://www.testingcatalog.com/microsoft-surfaces-hidden-copilot-browser-actions-in-edge/ ; https://windowsreport.com/we-tested-copilot-actions-in-microsoft-edge-beta-heres-what-it-can-do/
- https://www.operaneon.com/ ; https://www.diabrowser.com/ ; https://fellou.ai/ ; https://please.ai/
- https://docs.browserbase.com/features/browser-extensions ; https://docs.steel.dev/overview/intro-to-steel
