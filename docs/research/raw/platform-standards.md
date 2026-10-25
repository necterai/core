# Browser-platform and standards-level signals for AI-agent identification (state as of 2026-10-24)

Research area: browser-platform APIs, HTTP headers and standards proposals that a client-side SDK (plus an optional edge companion) can use to identify, fingerprint and attribute AI agents and automation. Everything below was verified against live primary sources on 2026-10-24 unless marked otherwise. Where a claim could not be confirmed it is marked **uncertain** and the evidence seen is described.

Two kinds of evidence are used:

1. **Live web sources** (vendor docs, specs, Chromium/WebKit/Firefox source on GitHub, IETF drafts, court opinion). URLs are in the Sources section and inline.
2. **Local measurements** made during this research on the machine that produced this report: Google Chrome **155.0.8059.86** (stable channel, macOS 26.6.2, Apple Silicon), driven in `--headless=new` mode, through a raw CDP client over `--remote-debugging-pipe`, and through the **Claude in Chrome** extension (chrome.debugger based) against a local logging HTTP server. Measurements are labelled **[measured]**. They are single-machine observations, not population statistics.

Note on process: the shared web-search budget for this workflow was exhausted mid-way; later verification used direct fetches of primary URLs only.

---

## 0. Executive summary: the highest-value items

| # | Signal / fact | Why it matters for an agent firewall | Status | Confidence |
|---|---|---|---|---|
| 1 | **WebMCP** (`document.modelContext`, declarative `toolname`/`tooldescription` forms) ships in Chrome 149+ origin trial and Edge 150 origin trial. When an agent invokes a declarative tool, the page receives `toolactivated` / `toolcancel` events and the form's `submit` event carries **`SubmitEvent.agentInvoked === true`**, plus `:tool-form-active` / `:tool-submit-active` pseudo-classes. This is the first browser-asserted, page-visible "an agent is acting" signal. | A site can register honeypot or real tools; any invocation is a definitive agent signal (for agents that use WebMCP: Gemini in Chrome "soon", Copilot in Edge, ChatGPT Desktop, Brave Leo, Meta Ray-Ban Display, chrome-devtools-mcp). | Origin trial (Chrome 149+, Edge 150+); W3C WebML CG draft (2026-10-20); WebKit **opposes**, Mozilla **neutral** | confirmed |
| 2 | **Web Bot Auth** became an adopted IETF WG document on 2026-09-01 (`draft-ietf-webbotauth-httpsig-protocol-00`): `Signature`, `Signature-Input`, `Signature-Agent`, `tag="web-bot-auth"`, keys at `/.well-known/http-message-signatures-directory`. Google signs a subset of **Google-Agent** requests as `Signature-Agent: g="https://agent.bot.goog"`; OpenAI's cloud browser / ChatGPT agent signs as `"https://chatgpt.com"`. | Cryptographic positive identification of cloud-side agents; absence proves nothing. Agentic *browsers* (Comet, Claude in Chrome, Gemini auto browse on-device, Edge Copilot) do **not** sign. | WG draft; shipped by Cloudflare, Google, OpenAI, Stytch, Akamai/Vercel consoles | confirmed |
| 3 | Companion IP-attestation drafts filed 2026-10-22: **SAIL** (`/.well-known/sail`, TOML, by Anthropic) and **JAFAR** (JSON IP-range format by Gary Illyes). | Standardised IP-to-identity confirmation/refutation for `User-Agent` product tokens. | Individual I-Ds (new) | confirmed |
| 4 | `navigator.webdriver` in Chromium is true when **any** of `--enable-automation`, `--headless`, `--remote-debugging-pipe`, or `--remote-debugging-port=0` is present (source-verified), or when a CDP client calls `Emulation.setAutomationOverride`. `--disable-blink-features=AutomationControlled` is processed last and wins **[measured]**. A *fixed* `--remote-debugging-port=9222` does not set it. | Explains exactly which stacks leak the flag: Puppeteer (passes `--enable-automation`), Playwright (no `--enable-automation`, but always `--remote-debugging-pipe` → flag set), ChromeDriver (`enable-automation` and `remote-debugging-port=0` → set even when `excludeSwitches` removes `enable-automation`). Extension-driven agents (Claude in Chrome) and `chrome-devtools-mcp --autoConnect` run in a normal Chrome → **false** [measured for Claude in Chrome]. | Shipped | confirmed |
| 5 | Chrome's new headless mode still sends `HeadlessChrome/155.0.0.0` in `User-Agent` while `Sec-CH-UA` brands say `"Google Chrome";v="155"` [measured]; `screen` is fixed at 800x600 while `--window-size` can make `outerWidth/outerHeight` exceed it [measured]. | Cheap, high-precision headless tells. | Shipped (Chrome 132+ unified headless) | confirmed |
| 6 | CDP `Input.dispatchMouseEvent/KeyEvent` produce **trusted** events that grant transient and sticky user activation (`navigator.userActivation.isActive === true`) [measured]; `element.click()` / `dispatchEvent` do not. But synthesized pointer events carry `pressure: 0` while `buttons: 1`, and press/release or key hold durations of ~0-2 ms [measured]. | "User activation" is *not* a human proof against CDP-driven agents; low-level event physics are. | Shipped | confirmed (single-machine) |
| 7 | Extension-initiated top-level navigations (Claude in Chrome) arrive with `Sec-Fetch-Site: cross-site`, **no** `Sec-Fetch-User`, **no** `Referer` [measured]; CDP `Page.navigate` arrives as `Sec-Fetch-Site: none` + `Sec-Fetch-User: ?1` (indistinguishable from a typed URL) [measured]. | Server-side Fetch-Metadata patterns per navigation class. | Shipped | confirmed (one extension, one build) |
| 8 | **Private Verification Tokens** origin trial Chrome 154-165: one-bit "trusted in regular browsing" token redeemed in Incognito via `Sec-Private-Verification-Token`. **Private State Tokens** survived the October 2025 Privacy Sandbox retirement (`document.hasPrivateToken` / `hasRedemptionRecord` present in Chrome 155 [measured]); Shared Storage, Protected Audience, Topics, Attribution Reporting, RWS/`requestStorageAccessFor` are being removed (deprecation listed in Chrome 153 notes; `sharedStorage` and `requestStorageAccessFor` already absent in Chrome 155 [measured]). | Trust-bit carrying mechanisms a firewall can issue/redeem; retired APIs are feature-presence tells for old spoofed builds. | OT / shipped / removed | confirmed |
| 9 | **Device Bound Session Credentials** shipped in Chrome 145 on Windows (TPM-bound), headers `Secure-Session-Registration`, `Secure-Session-Challenge`, `Secure-Session-Response`, `Sec-Secure-Session-Id`, `Secure-Session-Skipped`; W3C ED 2026-09-08. | A session that never completes DBSC registration on a platform that supports it is a weak automation signal. | Shipped (Windows) | confirmed |
| 10 | No `navigator.agent`, `Sec-Agent`, `Agent-Mode`, or agent client-hint exists in any browser or WICG/W3C proposal found. WebKit explicitly states a design invariant that sites should **not** be told a user relies on an agent. The W3C Strategy paper (2026-10-20/21) proposes an **Agentic Web WG** covering "agent identity and delegation", but no wire-level disclosure mechanism. | Do not wait for a browser-provided agent bit; the only cooperative signals are WebMCP events and Web Bot Auth. | n/a | confirmed (absence) |
| 11 | **ChatGPT Atlas was discontinued** (announced 2026-07-09, shut down 2026-08-09); OpenAI points users to the ChatGPT desktop app and a ChatGPT Chrome extension. **Amazon v. Perplexity** (9th Cir., 2026-08-04): Comet deliberately sends no identifying user-agent token; the court held the human user, not Perplexity, "accesses" Amazon. | Target list changes; legal precedent that device-side agents will stay unlabelled. | n/a | confirmed |
| 12 | **Safari 27.0** (2026-09-17) ships a **Safari MCP server** (`/usr/bin/safaridriver --mcp`) behind "Allow remote automation and external agents"; WebKit's `navigator.webdriver` returns `page->isControlledByAutomation()` unless an embedder policy forces it. | Coding-agent sessions in Safari are WebDriver automation sessions (orange Smart Search field, glass pane, isolated windows). | Shipped | confirmed (webdriver=true for MCP sessions is **likely**, not directly measured) |

---

## 1. Chrome milestones 147-156: what changed that matters (dates from developer.chrome.com)

| Milestone | Stable date (per source) | Relevant items |
|---|---|---|
| 147 | — | Element-scoped view transitions (I/O recap) |
| 148 | — | **Prompt API stable** (`LanguageModel` global; present in Chrome 155 [measured]) |
| 149 | — | **WebMCP experimental origin trial begins** (I/O 2026 blog, 2026-05-19) |
| 150 | 2026-06-30 (developer.chrome.com release notes; the Chrome Enterprise help page lists July 13/14 — conflicting) | **Lighthouse "Agentic browsing" category** requires Chrome 150+; Origin trials: Email Verification Protocol, `performance.getSpeculations()`, WebRTC diagnostic logging. No UA/navigator/headless changes listed. Last release supporting macOS 12. |
| 151 | 2026-07-28 | Speculation rules `form_submission` field (prerender for form submissions); `on-prefetch-activation` response header OT; `<usermedia>` capability element; `DeviceOrientationEvent.requestPermission()`; permissions-policy merger `direct-sockets-private` → `local-network` / `loopback-network` (Isolated Web Apps); `textStream()`. |
| 152 | 2026-08-25 | **Private Aggregation API removed** (with related Privacy Sandbox APIs); `window-drag` CSS; Isolated Web Apps sub-apps and `unframed` display mode; **CPU Performance API** (combinable with Compute Pressure); Connection Allowlists; "Suspicious site warnings"; Origin trials: client-side XSLT deprecation trial, speculation-rules "moderate viewport heuristics", **User Agent Image Replacement API** (page can detect browser-side generative image replacement). |
| 153 | 2026-09-08 | Planned deprecation/removal of **Protected Audience, Related Website Sets, Shared Storage API, `document.requestStorageAccessFor`, Attribution Reporting**; `<camera>` / `<microphone>` capability elements (require a user click); XML parsing in Rust; `Iterator.zip`; WebGPU `buffer_view`. |
| 154 | 2026-09-22 | **Private Verification Tokens origin trial**; Window Shape API (`window.setShape()`, IWA/ChromeOS, needs `window-management` permission); "Ask before HTTP" on by default; Secure Payment Confirmation locale validation; `targetAddressSpace` for WebSockets; Background Fetch CORS + Local Network Access restrictions. |
| 155 | Stable by 2026-10-24 (155.0.8059.86 installed locally); the release-notes URL returned 404 at fetch time | WebMCP: JSON-stringified tool input arguments deprecated (per Chrome WebMCP docs). |
| 156 | Beta 2026-09-30 | WebMCP `debugging` annotation; `window.ontoolactivated` / `window.ontoolcancel` no longer supported (events live on `document.modelContext`). Third-party sources say the WebMCP OT runs through 156 (**uncertain**; Chrome docs only state "from Chrome 149"). |

Also relevant from 2025: **Chrome 136** stopped honouring `--remote-debugging-port` / `--remote-debugging-pipe` against the default user-data directory (must pair with a non-standard `--user-data-dir`; Google recommends Chrome for Testing for automation). **Chrome 132.0.6793.0**: old headless mode only available as the separate `chrome-headless-shell` binary; **Chrome 112**: new headless creates real platform windows without displaying them. **Chrome 144+**: `chrome://inspect/#remote-debugging` lets a user allow a local MCP server (`chrome-devtools-mcp --autoConnect`) to attach to the running profile with a permission dialog.

---

## 2. Automation flags in Chromium (source-verified)

### 2.1 `navigator.webdriver` implementation

`third_party/blink/renderer/core/frame/navigator.cc`:

```cpp
bool Navigator::webdriver() const {
  if (RuntimeEnabledFeatures::AutomationControlledEnabled())
    return true;
  bool automation_enabled = false;
  probe::ApplyAutomationOverride(GetExecutionContext(), automation_enabled);
  return automation_enabled;
}
```

`content/child/runtime_features.cc` maps command-line switches to the Blink runtime feature:

```
{wrf::EnableAutomationControlled, switches::kEnableAutomation, true},
{wrf::EnableAutomationControlled, switches::kHeadless, true},
{wrf::EnableAutomationControlled, switches::kRemoteDebuggingPipe, true},
```

plus a special case: if `--remote-debugging-port` parses to **0** (ephemeral port, "how ChromeDriver launches the browser by default"), `WebRuntimeFeatures::EnableAutomationControlled(true)` is called; a specific port number is treated as a debugger attachment and leaves the flag unset. Order inside `SetRuntimeFeaturesDefaultsAndUpdateFromArgs`: Chromium feature defaults → switch table + port-0 case → combined args → `--enable-blink-features` then `--disable-blink-features` (disable wins) → `ResolveInvalidConfigurations()`.

`third_party/blink/renderer/core/inspector/inspector_emulation_agent.cc` (CDP `Emulation.setAutomationOverride`):

```cpp
protocol::Response InspectorEmulationAgent::setAutomationOverride(bool enabled) {
  if (enabled) InnerEnable();
  automation_override_.Set(enabled);
  return protocol::Response::Success();
}
void InspectorEmulationAgent::ApplyAutomationOverride(bool& enabled) const {
  enabled |= automation_override_.Get();
}
```

The override is OR-ed in: it can force `true` but cannot clear a command-line-set `true` [measured: `Emulation.setAutomationOverride(false)` left `navigator.webdriver === true` under `--remote-debugging-pipe`].

MDN summary (confirmed): Chrome sets it when "The `--enable-automation` or `--headless` flag is used, or the `--remote-debugging-port` flag specifying port 0 is used"; Firefox when "The `marionette.enabled` preference or `--marionette` flag is passed".

### 2.2 Which stacks trigger it

| Stack | Flags it passes (source) | `navigator.webdriver` |
|---|---|---|
| **Puppeteer** (`packages/puppeteer-core/src/node/ChromeLauncher.ts`) | `--enable-automation`, `--headless=new` (or `--headless` for `headless: 'shell'`), `--remote-debugging-pipe` (pipe mode) or `--remote-debugging-port=0`, `--disable-features=Translate,AcceptCHFrame,MediaRouter,OptimizationHints,...`, `--enable-features=PdfOopif`, `--force-color-profile=srgb`, `--password-store=basic`, `--use-mock-keychain`, `--hide-scrollbars`, `--mute-audio` | **true** (three independent triggers) |
| **Playwright** (`chromiumSwitches.ts`, `chromium.ts`) | **No** `--enable-automation`, **no** `--disable-blink-features=AutomationControlled`; always `--remote-debugging-pipe` ("Playwright manages remote debugging connection itself"), `--headless` with the **`chromium-headless-shell`** binary (old headless) when `headless: true`, `--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4`, `--no-startup-window`, `--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,AvoidCorsURLLoaderRestartOnRedirect,OptimizationHints,NetworkTimeServiceQuerying,AimEnabled,PreconnectToSearch,...`, `--enable-features=CDPScreenshotNewSurface,SkipListAccountsWithoutGaiaCookies` | **true** via `--remote-debugging-pipe` (unless the user adds `--disable-blink-features=AutomationControlled`) |
| **ChromeDriver** (`chrome/test/chromedriver/chrome_launcher.cc`) | `kCommonSwitches`: `enable-automation`, `allow-pre-commit-input`, disable-popup-blocking, `disable-background-networking`; `kDesktopSwitches`: `disable-hang-monitor`, `disable-prompt-on-repost`, `disable-sync`, `no-first-run`, `log-level=0`, `password-store=basic`, `use-mock-keychain`, **`test-type=webdriver`**; adds `remote-debugging-port=0` when no port/pipe given; `enable-logging`. `excludeSwitches` removes names after defaults are loaded (removing `user-data-dir`/`remote-debugging-port` only warns). | **true**; note `excludeSwitches: ["enable-automation"]` alone is insufficient because `remote-debugging-port=0` also triggers the flag |
| **chrome-devtools-mcp** (Google) | Launches Google Chrome / Chrome for Testing via Puppeteer (so Puppeteer's flags), or attaches to a running Chrome with `--autoConnect` (Chrome 144+, user approves at `chrome://inspect/#remote-debugging`), `--browserUrl`, `--wsEndpoint`. Flags include `--headless`, `--isolated`, `--channel`, `--categoryExperimentalWebmcp` (requires Chrome 150+ with `--enable-features=WebMCP`), `--categoryWebauthn`, `--chromeArg`. Docs note: "Some accounts may prevent sign-in when the browser is controlled via WebDriver" as the reason to attach to your own Chrome. | **true** when launched; **false** when attached to a user's running Chrome via `--autoConnect`/fixed port (**likely**; not measured) |
| **Playwright MCP** (Microsoft) | Persistent profile by default, `--isolated`, `--extension` (connect to a running Edge/Chrome through the "Playwright MCP Chrome Extension" and reuse logged-in tabs), `--cdp-endpoint`, `--headless`, `--user-agent`, `--browser chrome|firefox|webkit|msedge`; vision tools `browser_mouse_click_xy` etc. | **true** in launch modes (Playwright); **false** in `--extension` mode (**likely**) |
| **Claude in Chrome** (extension `fcoeoabgfenejglbffodgkkbkcdhcgfn`) | Uses the `debugger` permission (chrome.debugger → CDP) per Anthropic's help article; native messaging host `com.anthropic.claude_code_browser_extension.json`; relays via `bridge.claudeusercontent.com`; tabs grouped in a coloured tab group | **false** [measured] |
| **Chrome `--headless=new` CLI** | `--headless` → flag | **true** [measured]; `--disable-blink-features=AutomationControlled` → false [measured] |

### 2.3 Firefox and WebKit implementations

Firefox (`dom/base/Navigator.cpp`, main):

```cpp
bool Navigator::Webdriver() {
#ifdef ENABLE_WEBDRIVER
  nsCOMPtr<nsIMarionette> marionette = do_GetService(NS_MARIONETTE_CONTRACTID);
  if (marionette) { bool isBrowserAutomationRunning = false;
    marionette->GetIsBrowserAutomationRunning(&isBrowserAutomationRunning);
    if (isBrowserAutomationRunning) return true; }
  nsCOMPtr<nsIRemoteAgent> agent = do_GetService(NS_REMOTEAGENT_CONTRACTID);
  if (agent) { bool isBrowserAutomationRunning = false;
    agent->GetIsBrowserAutomationRunning(&isBrowserAutomationRunning);
    if (isBrowserAutomationRunning) return true; }
#endif
  return false;
}
```

So Firefox reports `true` whenever Marionette or the Remote Agent (WebDriver BiDi) is running. Firefox removed CDP entirely in **Firefox 141** (CDP off by default since 129; `remote.active-protocols` = 2 enabled CDP, 3 both; BiDi always on). The `--remote-debugging-port` flag starts the Remote Agent. Firefox 140 (2025-06-24, ESR) through 157 (2026-09-29) release notes contain no AI-agent features, no UA changes; WebDriver BiDi work continues (e.g. 157: `browser.setDownloadBehavior` requires `destinationFolder`). An open Bugzilla (1696425) still asks to bind the flag to session lifetime. A third-party report (peters/horizon PR #1404, Oct 2026) claims Google rejects Firefox sessions when `navigator.webdriver` is replaced by a script getter — i.e. **getter-replacement itself is detected** (unverified).

WebKit (`Source/WebCore/Modules/webdriver/NavigatorWebDriver.cpp`): `webdriver()` returns `isControlledByAutomation(navigator)`, which first consults the frame setting `navigatorWebDriverActivePolicy` (`Enabled` → true, `Disabled` → false, `Auto` → `page->isControlledByAutomation()`). Safari automation sessions run in isolated "Automation windows" with an **orange Smart Search field** and a **glass pane** that interrupts the session on stray input; only one Safari instance and one session at a time (WebKit blog, Safari 10 post; still the model in Safari 26/27).

---

## 3. Headless Chrome 155 (`--headless=new`) fingerprint [measured, macOS Apple Silicon]

HTTP request headers on the navigation (first request, before `Critical-CH` retry):

```
sec-ch-ua: "Google Chrome";v="155", "Chromium";v="155", "Not(A:Brand";v="24"
sec-ch-ua-mobile: ?0
sec-ch-ua-platform: "macOS"
User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/155.0.0.0 Safari/537.36
Sec-Fetch-Site: none
Sec-Fetch-Mode: navigate
Sec-Fetch-User: ?1
Sec-Fetch-Dest: document
Accept-Language: en-US,en;q=0.9
```

After `Accept-CH`/`Critical-CH` the retried request added: `sec-ch-ua-arch: "arm"`, `sec-ch-ua-platform-version: "26.6.2"`, `sec-ch-ua-model: ""`, `sec-ch-ua-bitness: "64"`, `sec-ch-ua-wow64: ?0`, `sec-ch-ua-full-version-list: "Google Chrome";v="155.0.8059.86", "Chromium";v="155.0.8059.86", "Not(A:Brand";v="24.0.0.0"`, `sec-ch-ua-form-factors: "Desktop"`, `sec-ch-prefers-color-scheme: dark`, `sec-ch-prefers-reduced-motion: no-preference`, `sec-ch-device-memory: 32`, `sec-ch-dpr: 1`, `sec-ch-viewport-width: 756`, `rtt: 50`, `downlink: 1.75`, `ect: 4g`. The same headers (minus `User-Agent`'s "Headless" prefix) were produced by the real Chrome used by the Claude in Chrome extension, so the **only header-level headless tell is the `HeadlessChrome` product token**, which the Chromium source inserts with `product.insert(0, "Headless")` whenever the `kHeadless` switch is present (`components/embedder_support/user_agent_utils.cc`). The UA-CH brand list is *not* changed, so `User-Agent` says `HeadlessChrome` while `Sec-CH-UA` says `Google Chrome` — a built-in inconsistency to check. `--user-agent=<custom>` blanks the high-entropy hints (feature `kUACHOverrideBlank`) or limits them to low-entropy hints, another mismatch class.

JavaScript-visible values in headless=new (default window):

| Property | Value | Note |
|---|---|---|
| `navigator.webdriver` | `true` (`false` with `--disable-blink-features=AutomationControlled`) | native getter, `configurable: true` |
| `navigator.userAgent` | `...HeadlessChrome/155.0.0.0 Safari/537.36` | |
| `navigator.userAgentData.getHighEntropyValues` | `formFactors: ["Desktop"]`, `platformVersion: "26.6.2"`, `architecture: "arm"`, full version list | identical to headful |
| `screen` | `800x600`, avail `800x600`, `colorDepth 24`, `dpr 1`, `isExtended false` | **fixed 800x600 regardless of `--window-size`** |
| `window` | inner `756x469`, outer `756x556`, `screenX/screenY = 22` | with `--window-size=1920,1080`: inner `1920x993`, outer `1920x1080` while `screen` stays `800x600` → `outerWidth > screen.width` |
| `document.hasFocus()` / `visibilityState` | `true` / `visible` | |
| `navigator.userActivation` | `isActive false`, `hasBeenActive false` on load | |
| `window.chrome` keys | `loadTimes`, `csi`, `app` | no `runtime` |
| `navigator.plugins.length` / `pdfViewerEnabled` | 5 / true | same as headful Chrome |
| `hardwareConcurrency` / `deviceMemory` | 18 / 32 | real host values (not clamped) |
| `navigator.languages` | `["en-US","en"]` | |
| `Intl` timezone | host timezone | |
| `speechSynthesis.getVoices().length` | 199 | macOS host voices (Linux containers typically 0) |
| WebGL `UNMASKED_RENDERER_WEBGL` | `ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Unspecified Version)` | real GPU on macOS; SwiftShader/llvmpipe strings are expected on GPU-less Linux hosts (**not measured here**) |
| WebGPU `adapter.info` | `vendor "apple"`, `architecture "metal-3"`, `device ""`, `description ""`, 23 features | |
| `mediaDevices.enumerateDevices()` | `audioinput`, `videoinput`, `audiooutput` with empty labels and **empty deviceId** | |
| `navigator.getBattery()` | charging true, level 0.99 | real laptop battery |
| `navigator.connection` | `effectiveType 4g`, `rtt 100`, `downlink 1.45` | |
| `navigator.keyboard.getLayoutMap().size` | 48 | API present |
| `matchMedia` | `(pointer:fine)` true, `(hover:hover)` true, `(prefers-color-scheme:dark)` true | inherits host prefs |
| `Notification.permission` / permissions query | `default` / `prompt` | (old headless returned `denied` for query) |
| API presence | `getScreenDetails`, `IdleDetector`, `PressureObserver`, `documentPictureInPicture`, `navigator.gpu`, `document.hasPrivateToken`, `document.hasRedemptionRecord`, `LanguageModel`, `Summarizer`, `Translator`, `DigitalCredential`, `navigator.login`, `fence`, `browsingTopics`, `joinAdInterestGroup`, `runAdAuction` all **present**; `window.sharedStorage` and `document.requestStorageAccessFor` **absent**; `document.hasTrustToken` absent (renamed); `document.modelContext` absent without the WebMCP flag/OT | useful for "claimed Chrome version vs. feature set" consistency checks |
| Error stack depth | 10696 | |
| Known automation globals (`cdc_`, `__playwright`, `__puppeteer`, `domAutomation`, ...) | none | none are present in plain headless Chrome |

Caveat: `--dump-dom` snapshots the DOM at the load event; async signals (`getHighEntropyValues`, `requestAdapter`) only appear if collected via CDP polling, which is how the table above was obtained.

---

## 4. Input provenance and user activation

### 4.1 Spec rules

HTML Standard, "Tracking user activation": an *activation triggering input event* must have `isTrusted === true` and be one of `keydown` (not Esc, not a UA-reserved shortcut), `mousedown`, `pointerdown` (pointerType `mouse`), `pointerup` (pointerType not `mouse`), or `touchend`. Transient activation lasts a UA-defined duration ("at most a few seconds"); `navigator.userActivation.isActive` reports transient, `hasBeenActive` sticky activation (Baseline since Nov 2023 per MDN).

Fetch Metadata: `Sec-Fetch-User: ?1` is sent only for navigation requests whose *user-activation* flag is set; address-bar and bookmark navigations are "directly user-initiated" and carry `Sec-Fetch-Site: none`.

### 4.2 CDP input through `--remote-debugging-pipe` [measured, Chrome 155 headless=new]

`content/browser/devtools/protocol/input_handler.cc`: `Input.dispatchMouseEvent` → `widget_host_->ForwardMouseEvent(...)`; `Input.dispatchKeyEvent` → `ForwardKeyboardEventWithCommands(...)`; touch → touch emulator or synthetic gesture. All injected events are tagged with the internal modifier `blink::WebInputEvent::kFromDebugger` (used only for ack matching; not exposed to pages). Consequences observed:

- Before input: `isActive false`, `hasBeenActive false`. After `mouseMoved`+`mousePressed`+`mouseReleased` at the button centre: `isActive true`, `hasBeenActive true`, `document.activeElement` = the button. Transient activation expired by 5.5 s (`isActive false`, `hasBeenActive true`).
- All pointer/mouse/focus/key events had `isTrusted: true`.
- Pointer events: `pointerId 1`, `pointerType "mouse"`, `width/height 1`, `isPrimary true`, **`pressure 0` even on `pointerdown` with `buttons 1`** (a real mouse reports 0.5 while a button is held), `tiltX/Y 0`, `twist 0`, `movementX/Y 0`, `clientX/Y` exactly the requested integers, `screenX/Y` = client + window offset (222, 239), `sourceCapabilities.firesTouchEvents false` on mouse events (null on pointer events).
- Timing: hover burst (`pointerrawupdate`, `pointerover`, `pointerenter`×4, `mouseover`, `mouseenter`×4, `pointermove`, `mousemove`) all share one `timeStamp` (expected for one OS event); `pointerdown` at 32.4 ms, `pointerup` at 33.7 ms → **~1.3 ms press duration**; `keydown` and `keypress` share a timestamp; `keyup` followed after ~20 ms (the test client's round trip). Humans typically hold mouse buttons/keys for tens of milliseconds; agents emit press/release back-to-back.
- `Input.insertText` on a focused `<button>` produced no key/input events (expected: no editable target).
- `element.click()` → `click` with `isTrusted false`, `pointerId -1`, `pointerType ""`, no activation change; `dispatchEvent(new PointerEvent('pointerdown'))` → `isTrusted false`, `pointerId 0`, no activation.
- Navigations: `Page.navigate` → `Sec-Fetch-Site: none`, `Sec-Fetch-Mode: navigate`, `Sec-Fetch-User: ?1`, no `Referer` (identical to typing a URL); `location.href = ...` from script after activation → `Sec-Fetch-Site: same-origin`, **no `Sec-Fetch-User`**, `Referer` set; CDP click on an `<a>` → `same-origin` + `Sec-Fetch-User: ?1` + `Referer`.
- Sticky activation (`hasBeenActive`) survived same-origin navigations in the same frame [measured], so `hasBeenActive === true` on a freshly loaded document is not proof of interaction on *that* document.

### 4.3 Claude in Chrome (chrome.debugger-driven extension) [measured, one run, real Chrome 155 profile]

- Navigation request from the extension: `User-Agent: ... Chrome/155.0.0.0 Safari/537.36` (no Headless), full UA-CH set on retry, `DNT: 1` (user setting), **`Sec-Fetch-Site: cross-site`, `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document`, no `Sec-Fetch-User`, no `Referer`**. Rationale: an extension-initiated `chrome.tabs.update`/`create` navigation has the extension origin as initiator (cross-site) and no user gesture. A human-clicked cross-site link normally carries `Sec-Fetch-User: ?1` and (policy permitting) a `Referer`; a typed URL carries `Sec-Fetch-Site: none`. This "cross-site, no user, no referer, top-level document" tuple is a strong server-side marker for extension-driven agents (**likely** generalises to other chrome.debugger / tabs-API agents; measured only for Claude in Chrome).
- Page state before interaction: `navigator.webdriver false`, `isActive false`, `hasBeenActive false`, `document.hasFocus() true`, outer=inner=`1728x919`, dpr 2, `'modelContext' in document` false, Permissions-Policy `tools` not allowed (`allowsFeature('tools') === false`, i.e. WebMCP not enabled in this build).
- After the extension's `left_click`: `isActive true`, `hasBeenActive true`, `activeElement` = button; pointer events `isTrusted true`, `pointerId 1`, `pointerType mouse`, `pressure 0` on move, exact integer coordinates (200,130), `screenY 1247` (window offset).
- After the extension's `type "ab"`: `keydown`/`keypress`/`keyup` for `a` all at the **same** `timeStamp` (24304.1999...), `keydown` for `b` 0.1 ms later → **zero key hold time and ~0.1 ms inter-key interval**; `sourceCapabilities.firesTouchEvents false`; `keyCode 65/97/65`. Typing into `<input>` produced `beforeinput`/`input` events with `inputType insertText` and the value was committed (`xy` + Return).
- The extension groups its tabs in a coloured Chrome tab group; the help article says the `debugger` permission "lets Claude control the browser by clicking buttons, typing text, and taking screenshots", `webNavigation` lets it intervene on high-risk sites, and `declarativeNetRequestWithHostAccess` lets it identify itself to Anthropic's servers (not to visited sites). Anthropic documents **no** header, UA token or site opt-out. Chrome displays its standard "started debugging this browser" infobar when chrome.debugger is attached (**not measured**; standard Chrome behaviour).

### 4.4 Implications

- `navigator.userActivation`, `isTrusted` and activation-gated APIs (popups, autoplay, clipboard, `requestPermission`) do **not** distinguish CDP/WebDriver/extension agents from humans; they only catch pure-JS automation (`dispatchEvent`, `.click()`).
- Physics-level features do: `pressure === 0` with `buttons & 1` on `pointerType "mouse"`; press/release and key hold durations under ~5 ms; identical `timeStamp` across a key's down/up; inter-key intervals < 10 ms; zero `movementX/Y` on every `pointermove`; a first pointer event that is already at the target with no prior `pointermove` trail; `clientX/Y` always integers (real Chrome on dpr 2 displays usually yields fractional coordinates); `screenX - clientX` constant and equal to the window offset.
- Server side: per-session distribution of `Sec-Fetch-Site`/`Sec-Fetch-User`/`Referer` on top-level navigations (all `none`+`?1` → scripted `Page.navigate`/WebDriver `goto`; `cross-site` without `?1`/`Referer` → extension-driven).

---

## 5. WebMCP (Web Model Context) — the cooperative agent channel

**Spec**: "WebMCP" Draft Community Group Report, Web Machine Learning CG, dated **2026-10-20**, editors Brandon Walderman (Microsoft), Khushal Sagar (Google), Dominic Farolino (Google), Samuel Dallstream (Microsoft). Not on the W3C standards track.

**Entry point**: `document.modelContext` (a `[SameObject]` attribute on `Document`; `ModelContext extends EventTarget`, Window-only, secure context). The spec no longer defines `navigator.modelContext`; third-party posts say the move happened in the 21 July 2026 draft and that Chrome 150 deprecated the old spelling (**uncertain**: Chrome's docs only use `document.modelContext`).

**Imperative API** (Chrome docs, updated 2026-10-16): `registerTool(tool, {exposedTo, signal})`, `getTools({fromOrigins})` (alphabetical; includes `origin`, `title`, `window`), `executeTool(tool, input, {signal})` (null when a navigation is triggered). Tool fields: `name`, `title`, `description`, `inputSchema`, `execute(args, {signal})`, `annotations: { readOnlyHint, untrustedContentHint, consequentialHint, debugging (Chrome 156) }`. Unregister via `AbortSignal`. Chrome 153: unregistering no longer cancels in-flight executions; Chrome 155: JSON-stringified input arguments deprecated. Events on `document.modelContext`: `toolchange`, `toolactivated` (`ToolActivatedEvent.toolName`), `toolcancel` (`ToolCancelEvent.toolName`); from Chrome 156 `window.ontoolactivated`/`ontoolcancel` are gone.

**Declarative API** (Chrome docs updated 2026-09-25; `declarative-api-explainer.md`): `<form toolname="..." tooldescription="..." [toolautosubmit] action="/x">` with `toolparamdescription` on controls (falls back to `<label>` then `aria-description`); control `name` becomes the schema property name. Without `toolautosubmit` the browser fills the form and "brings the submit button into focus" for the user; with it, "submission and navigation are triggered when the model invokes the tool". `SubmitEvent` gains **`agentInvoked`** (boolean) and **`respondWith(Promise)`** (must call `preventDefault()` first; the `action` will not navigate). Pseudo-classes `:tool-form-active` and `:tool-submit-active` while a tool is "running". Example from Chrome's docs:

```html
<form toolautosubmit toolname="search_tool" tooldescription="Search the web" action="/search">
  <input type=text name=query>
</form>
<script>
  document.querySelector("form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (e.agentInvoked) { e.respondWith(Promise.resolve("Search is done!")); }
  });
</script>
```

**Gating**: Permissions-Policy feature **`tools`**, default allowlist `'self'`; `Permissions-Policy: tools=()` disables WebMCP for the document and "every descendant frame"; cross-origin iframes need `allow="tools"` plus `exposedTo`.

**Status by platform** (`implementation-status.md`): Chrome — "An Origin Trial is live in Chrome 149"; local flag `chrome://flags/#enable-webmcp-testing`; Edge — "An Origin Trial is live in Edge 150"; Brave — experimental in Leo AI chat; **ChatGPT Desktop** — "WebMCP is supported in ChatGPT Desktop"; Meta Ray-Ban Display — coming, off by default, "letting Meta AI on the glasses call tools registered with `document.modelContext.registerTool()`"; Firefox/Safari — positions only. Google: "Gemini in Chrome will soon support WebMCP APIs" (I/O 2026). Chrome's example agents: an "Agentic Chrome Extension" (Gemini/OpenAI/Anthropic keys or the Prompt API) and a "Model Context Tool Inspector" extension, "separate from Gemini in Chrome". DevTools has a WebMCP panel (Available tools, invocation counters, Invoked Tools log, manual "Run tool"); `chrome-devtools-mcp` exposes `list_webmcp_tools` / `execute_webmcp_tool` behind `--categoryExperimentalWebmcp` (Chrome 150+ with `--enable-features=WebMCP`). Lighthouse (Chrome 150+) has an "Agentic browsing" category: *Registered WebMCP tools*, *Forms missing declarative WebMCP*, *WebMCP schema validity*, *Accessibility for agents*, *Layout stability (CLS)*, *llms.txt*; informational, pass-ratio scoring.

**Browser vendor positions**: WebKit — **oppose** (issue #670, closed 2026-06-11): agents acting for users are assistive technology; WebMCP would let sites give agents capabilities withheld from humans or block agents; unexamined cross-origin and Service-Worker invocation paths; no consent/reversibility model; `toolautosubmit` submits without review; over-parameterisation enables a "personalization-to-fingerprinting pipeline". Marcos Caceres (2026-06-17): "we should not expose to sites that a user is relying on an agent, and we should minimise any such signal". Mozilla — **neutral** (issue #1412, closed 2026-08-05; "come back to revisit it once there is more evidence"; concern about data collection via tool inputs; suggests WebExtension and WebDriver BiDi integrations; dislikes the "MCP" name).

**Security section of the spec** (relevant quotes): "When an agent visits a website, it carries the user's logged-in credentials and session state"; hints (`readOnlyHint`, `consequentialHint`, `untrustedContentHint`) "are not guarantees"; "There is no guarantee that a WebMCP tool's declared intent matches its actual behavior"; protection is "primarily the responsibility of the agent's own security model".

**Detection hooks**
- `'modelContext' in document` → the OT token/flag is active in this browser (Chrome 149+/Edge 150+), not that an agent is present.
- Register a tool and listen for `toolactivated`, `executeTool` calls, or `submit` with `agentInvoked === true`; count invocations per session. Any invocation is a definitive agent signal. Honeypot tools (never surfaced to humans) convert the channel into a tripwire; `consequentialHint: true` forces agents that honour it to confirm with the user.
- Observe `:tool-form-active` via `matches()` or MutationObserver-free polling; log `toolcancel`.
- Serve `Permissions-Policy: tools=()` to pages/iframes where agent tooling is unwanted; it also disables tools for all descendant frames.
- Caveat: only agents that implement WebMCP produce these signals; CDP/extension agents interacting with the DOM do not.

---

## 6. Gemini in Chrome, auto browse, Gemini "Task" (formerly Spark), Google-Agent

**Architecture** (Chrome Security blog, 2025-12-08, Nathan Parker): planner model + **User Alignment Critic** (separate Gemini model seeing only action metadata) + **Origin Sets** (gating function decides read-only vs read-writable origins; model-generated URLs pass "a deterministic check to restrict them to known, public URLs") + a parallel prompt-injection classifier + user confirmation for sensitive sites, password-manager sign-in, purchases/payments/messages. Actions "click, type" on read-writable origins; the mechanism (renderer tool vs synthetic input) is not described; no header, UA token or site opt-out is mentioned anywhere in Google's security or help pages.

**Auto browse** (Chrome Help): runs "in a tab" of the user's Chrome with an auto-browse icon on the tab, history entries get a Gemini action icon; "has access to all the same sites that you do, including sites you're signed into"; pauses for sign-in, financial transactions, ToS acceptance, account creation; US, 18+, English, AI Pro (20 tasks/day) or AI Ultra (200/day), desktop only, not Incognito. Gemini "Task" (renamed from Spark after beta) can use local Chrome auto browse or a **remote browser** in Google's cloud (a separate instance; cookies/sign-in saved for later; task pauses at sign-in). The help pages do not say what UA the remote browser presents (**uncertain**: plausibly `Google-Agent`, see below).

**Google-Agent** (developers.google.com, updated 2026-08-19): "used by agents hosted on Google infrastructure to navigate the web and perform actions upon user request"; generally ignores robots.txt. UA strings (reconstructed from two quoted fragments; the middle is contiguous):

- Desktop: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko; compatible; Google-Agent; +https://developers.google.com/crawling/docs/crawlers-fetchers/google-agent) Chrome/W.X.Y.Z Safari/537.36`
- Mobile: `Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/W.X.Y.Z Mobile Safari/537.36 (compatible; Google-Agent; +https://developers.google.com/crawling/docs/crawlers-fetchers/google-agent)` (middle portion inferred from Google's standard mobile template — **uncertain**)
- IP ranges: `https://developers.google.com/static/crawling/ipranges/user-triggered-agents.json` (plus `user-triggered-fetchers.json`, `user-triggered-fetchers-google.json`); rDNS `***-***-***-***.gae.googleusercontent.com` (Google-owned) or `google-proxy-***-***-***-***.google.com` (user-owned).
- **Web Bot Auth** (guide updated 2026-10-13): "a subset" of Google-Agent requests are signed as `https://agent.bot.goog`; header `Signature-Agent: g="https://agent.bot.goog"`; verify the `g`-labelled `Signature`/`Signature-Input` per RFC 9421 using keys from `https://agent.bot.goog/.well-known/http-message-signatures-directory` (fetched 2026-10-24: **five Ed25519 keys**, `kid` values `mhxuPw`, `cYSMkA`, `bUCe2A`, `DYiMjA`, `Ggh50g`, `alg EdDSA`, `key_ops ["verify"]`, no `nbf`/`exp`/`purpose`); "Google is not yet signing every request of agents using the protocol"; fall back to IP verification. Note the `kid`s are short labels, so a verifier must compute RFC 7638 thumbprints to match the `keyid` in `Signature-Input`.
- Other user-triggered fetcher tokens: `Google-GeminiNotebook` (replaces `Google-NotebookLM`, supported until August 2026), `Google-Read-Aloud`, `Google-Site-Verification/1.0`, `Google-CWS`, `FeedFetcher-Google`, `GoogleProducer`, `GoogleMessages`, `Google-Pinpoint`.

---

## 7. Other agentic browsers and extension agents (platform-level view)

| Agent | Where it runs | Identification at platform level | Source status |
|---|---|---|---|
| **ChatGPT Atlas** | macOS browser (Oct 2025 – Aug 2026) | **Discontinued**: announced 2026-07-09, shut down 2026-08-09; capabilities folded into the ChatGPT desktop app and a ChatGPT Chrome extension/sidebar. No signing was ever documented. | confirmed (9to5Mac, MacRumors, Wikipedia) |
| **ChatGPT agent / cloud browser** (ex-Operator) | OpenAI cloud (Azure ASN 8075 per Stytch 2025) | Signs with Web Bot Auth: `Signature-Agent: "https://chatgpt.com"`, `Signature-Input: sig1=("@authority" "@method" "@path" "signature-agent");created=...;keyid="...";expires=...;nonce="...";tag="web-bot-auth";alg="ed25519"`. Directory fetched 2026-10-24: one Ed25519 key (`kid ArwjqcCqtA5oxEWkzXGC-To_0A9whHmajCHtfe8I9aY`, `nbf 1735689600`, `exp 1793485614` ≈ 2026-10-31), `"signature_agent":"https://chatgpt.com"`, `"purpose":"ai"`; keys rotate (a different key expiring 2026-10-18 was seen by Centinel on 2026-10-11). Bot consoles label it "ChatGPT Agent" (Akamai, HUMAN), `chatgpt-agent` (Cloudflare), `chatgpt-operator` (Vercel). No UA token is documented on `developers.openai.com/api/docs/bots`, which lists only `OAI-SearchBot/1.4`, `OAI-AdsBot/1.0`, `GPTBot/1.4`, `ChatGPT-User/1.0` with IP JSON at `openai.com/{searchbot,adsbot,gptbot,chatgpt-user}.json`. | confirmed |
| **ChatGPT Desktop (browser agent) / ChatGPT Chrome extension** | user's device | ChatGPT Desktop "supports WebMCP" (CG status page). No other identification documented. | **uncertain** |
| **Perplexity Comet** | local Chromium-like browser; screenshots sent to Perplexity servers which return navigation instructions | Ninth Circuit (No. 26-1444, 2026-08-04): "At the core of the dispute was Perplexity's decision not to use a 'user-agent string' ... 'that would communicate that the user has activated an AI agent.'" Parties dispute whether Perplexity altered the string after Amazon first blocked it. Cloudflare (2025-08-04) separately documented Perplexity's stealth crawler impersonating `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36` from rotating non-listed IPs/ASNs. Declared tokens: `PerplexityBot/1.0`, `Perplexity-User/1.0` (ignores robots.txt), IP JSON at `perplexity.com/perplexitybot.json`, `perplexity-user.json`. | confirmed |
| **Claude in Chrome** | user's Chrome (Chrome and Edge for Claude Code; the consumer help page says Chrome only) | Web Store ID `fcoeoabgfenejglbffodgkkbkcdhcgfn`; `debugger` permission (CDP); native messaging host `com.anthropic.claude_code_browser_extension.json`; relay `bridge.claudeusercontent.com`; coloured tab group; `navigator.webdriver false`, normal UA/UA-CH, extension-style navigation headers (see §4.3). Anthropic's crawler page (2026-04-07) lists only `ClaudeBot`, `Claude-User`, `Claude-SearchBot` (IP list `claude.com/crawling/bots.json`); no Web Bot Auth/SAIL mention yet despite Anthropic authoring SAIL. | confirmed/measured |
| **Gemini in Chrome auto browse** | user's Chrome tab (or Google remote browser) | No documented header/UA; see §6. | confirmed (absence) |
| **Edge Copilot Mode / Copilot Actions** | user's Edge tab | HUMAN's agent directory says it inherits the normal browser UA with no separate identifier, does not follow robots.txt (vendor page; Microsoft docs not retrievable). Edge 150 runs a WebMCP origin trial. | **uncertain** |
| **Safari 27 MCP server** | user's Safari, local only | `claude mcp add safari-mcp -- "/usr/bin/safaridriver" --mcp`; requires Safari > Settings > Developer > "Allow remote automation and external agents"; "runs entirely on your local machine"; DOM, network, screenshots, console, accessibility. Automation sessions use isolated windows with an orange Smart Search field and glass pane; WebKit's `navigator.webdriver` reflects `page->isControlledByAutomation()` (**likely true** for MCP sessions; not measured). Safari 26.0 (2025-09-15) also lets SafariDriver load Web Extensions. | confirmed (feature), likely (flag) |
| **Apple Intelligence in Safari 26/27** | — | Only Passwords' "securely navigates through websites to sign in and upgrade ... passwords", tab organisation, "Notify Me" page monitoring, Highlights/summaries. No general agent mode found. | confirmed (absence) |
| **Firefox** | — | No agentic browsing feature in 140-157 release notes. | confirmed (absence) |
| **Manus Browser Operator** | user's Chrome/Edge extension | "appears legitimate to websites" per Manus; nothing published (Centinel). | uncertain |
| **browser-use** | Playwright/CDP | Issue #6109 (opened 2026-10-16) requests optional Web Bot Auth signing via CDP `Fetch`; not implemented; an earlier PR #4106 was auto-closed. | confirmed |

---

## 8. HTTP-layer identity standards

### 8.1 IETF Web Bot Auth WG (datatracker, 2026-10-24)

- **Adopted WG document**: `draft-ietf-webbotauth-httpsig-protocol-00` (2026-09-01, Standards Track, expires 2027-03-05; T. Meunier/Cloudflare, S. Major/Google). Replaces `draft-meunier-web-bot-auth-architecture-05` (2026-03-02) and `draft-meunier-webbotauth-httpsig-protocol-00` (2026-06-26). Key normative content:
  - Headers: `Signature`, `Signature-Input`, `Signature-Agent`, `Accept-Signature`; `Content-Digest` only when the body is covered.
  - `Signature-Agent` is a Dictionary; member values are https URIs; `type` parameter `directory` (default; resolve the well-known URI at that origin), `jwks_uri`, or `cimd` (Client ID Metadata Document). "Signers MUST send the dictionary form"; legacy bare-string accepted by verifiers. Example: `Signature-Agent: sig1="https://signature-agent.test/jwks.json";type=jwks_uri`.
  - Covered components: at least one of `@authority` / `@target-uri`, plus `"signature-agent";key="sig1"` keyed to the label; parameters `created`, `expires` (RECOMMENDED ≤ 24 h), `keyid` (base64url JWK SHA-256 thumbprint, RFC 7638 / RFC 8037 A.3 for Ed25519), `tag` MUST be `web-bot-auth`; nonce per RFC 9421 §7.2.2 (earlier draft: 64 random bytes).
  - Well-known: `/.well-known/http-message-signatures-directory`, media type `application/http-message-signatures-directory+json` (IANA registrations in this doc).
  - `Accept-Signature` with 403 to request a signature; 429 for over-used signatures; outcomes `verified` / `invalid` / `unverified` kept distinct ("A verifier that sees none has learned nothing about the sender"); covering only `@authority` "verifies against any method, path, or body".
- **Other I-Ds in the WG space**: `draft-meunier-webbotauth-registry-03` (2026-06-26; Guerreiro, Kirazci/Amazon, Meunier): "Signature Agent Card" = OAuth client metadata (`client_id`, `client_name`, `client_uri`, `logo_uri`, `contacts`, `jwks_uri`/`jwks`) plus `web_bot_auth` object with `expected-user-agent`, `rfc9309-product-token`, `rfc9309-compliance`, `trigger` (`fetcher`|`crawler`), `purpose`, `targeted-content`, `rate-control`, `rate-expectation`, `known-urls`, `ips_uri`; registries are lists of card URLs. `draft-rescorla-anonymous-webbotauth-01` (2026-07-19; Rescorla, Barnes/Cisco): Anchor issues a CWT Endorsement; client proves it in zero knowledge (Longfellow-ZK, MoLE architecture) to a Moderator which issues rate-limited anonymous credentials; no headers defined. `draft-singh-webbotauth-hosted-directories-00`, `draft-popov-webbotauth-semantic-anchor-00`, `draft-farzdusa-webbot-datacollection-01`, `draft-illyes-webbotauth-cbcp-01` (crawler best practices).
- **SAIL** `draft-kelley-webbotauth-sail-00` (2026-10-22, Kevin Kelley/Anthropic, Standards Track): operator publishes TOML at `https://<origin>/.well-known/sail` (≤ 512 KiB; `schema`, `modified`, `expires`/`expires_after` ≤ 30 d; `prefix_sets` with `exclusive`; `services` with `exhaustive`); verifiers match the `User-Agent` product token (case-insensitive) to a service and **confirm** (address inside prefixes) or **refute** (exhaustive service / exclusive prefix). Does not prove address ownership.
- **JAFAR** `draft-illyes-webbotauth-jafar-01` (2026-10-22, Gary Illyes, Informational): JSON (`application/jafar+json`): `synctoken`, `creationTime`, `notes`, `prefixes[]` of `{ipv4Prefix|ipv6Prefix, services[]}`; publisher updates ≥ daily; consumers poll ≤ hourly; longest-prefix wins; URL disclosed on the crawler description page (no well-known path).
- **IETF 126** (Vienna, 2026-07-22) poll: 22 for / 6 against building on HTTP Message Signatures (secondary source).

### 8.2 Deployed verifiers and signers

- **Cloudflare** (docs updated 2026-10-08): Web Bot Auth is a verification method for verified bots and **signed agents** (launched 2025-08-28 with ChatGPT agent, Goose/Block, Browserbase, Anchor Browser, Cloudflare Browser Rendering). Cloudflare currently requires the **structured-string** `Signature-Agent` form (`"https://signature-agent.test"`), not the dictionary form; rejects `@query-params`, `@status` and `sf`/`bs`/`key`/`req`/`name` parameters; test endpoint `crawltest.com/cdn-cgi/web-bot-auth` (200/401/400); rule field `cf.bot_management.verified_bot`; experimental `Forwarded: for=...;use=...` for transitive trust.
- **Stytch IsAgent** (competitor): client-side SDK calling Stytch's service (UA, client hints, TLS/network traits, archived-browser-build model); Stytch says it is "for analytics and agent experience ... not a good fit for security use cases"; supports Web Bot Auth verification without registration. Stytch's 2025-02 measurements: OpenAI Operator = full Chromium build (Chrome 130, ASN 8075), Anthropic computer-use = Firefox 128 on Ubuntu that "fails to reproduce certain characteristics of a real Firefox instance", Browserbase = Chromium with rotating UA (ASN 16509).
- **Akamai/HUMAN/Vercel** label the OpenAI cloud browser via its signature (names above).

### 8.3 RFC 9421 basics used by all of the above

`Signature-Input: sig1=("@authority" "@method" "@path" "signature-agent");created=1754053298;keyid="otMqcjr17mGyruktGvJU8oojQTSMHlVm7uO-lrcqbdg";expires=1754056898;nonce="...";tag="web-bot-auth";alg="ed25519"` and `Signature: sig1=:...base64...:` (example captured by Castle from an OpenAI Operator request, 2025-08-07). Verification: fetch directory → select JWK by thumbprint → rebuild signature base from covered components → verify Ed25519 → check `created`/`expires` and nonce replay.

---

## 9. Trust tokens, private browsing bits, device binding

### 9.1 Privacy Pass / Private Access Tokens (Apple, Cloudflare)

- Apple's PATs use a Privacy Pass variant with the device's Secure Enclave to attest "humanity"/device legitimacy; Cloudflare uses Privacy Pass as a signal in WAF/Bot Management and "millions of websites natively offer Privacy Pass" (Cloudflare blog). Issuance requires an Apple attester on Apple hardware with a signed-in Apple ID and Safari/WebKit; the browser mints tokens transparently when a server sends a `WWW-Authenticate: PrivateToken ...` challenge.
- Can agents mint them? No source in 2026 describes agents obtaining PATs. Reasoning (not a measured fact): an agent that drives a real Safari on a real Apple device (e.g. Safari 27 MCP server, a macOS computer-use agent) inherits the device's ability to answer PAT challenges, so a PAT proves *device/OS legitimacy*, not that a human performed the action; headless Chromium, Linux containers and cloud browsers cannot mint Apple PATs. Rescorla/Barnes' anonymous-webbotauth draft explicitly reuses Privacy Pass-adjacent machinery for **bots**, so "has a Privacy Pass token" will increasingly mean "has an attested *something*", not "is human".
- The `Private Access Tokens, also not great` analysis (Educated Guesswork) notes Privacy Pass is agnostic about what the attester checks.

### 9.2 Private State Tokens (PST)

Retained when Google retired most of the Privacy Sandbox on 2025-10-17 (retained: CHIPS, FedCM, Private State Tokens, an interoperable attribution standard via W3C; retired: Attribution Reporting, IP Protection, On-Device Personalization, Private Aggregation incl. Shared Storage, Protected Audience, Protected App Signals, Related Website Sets incl. `requestStorageAccessFor`, SelectURL, SDK Runtime, Topics). Chrome 155 exposes `document.hasPrivateToken` and `document.hasRedemptionRecord` [measured]; Google's current docs page (updated 2026-09-01) still describes the API, with no deprecation notice; usage is measured below 1% (2026 arXiv study, secondary). A firewall can act as a PST issuer to carry an "already verified on another site of mine" bit across origins.

### 9.3 Private Verification Tokens (PVT) — new in 2026

Chrome explainer (explainers-by-googlers): "an early design sketch", "has not been approved to ship in Chrome". Origin trial **Chrome 154 → 165** (desktop + Android; flag `kEnablePrivateVerificationTokens`; TAG review pending; no Firefox/WebKit signal). Mechanism: Anonymous Tokens with Hidden Metadata (ATHM, `draft-yun-cfrg-athm`), serialisation per RFC 9578 §5.3; issuance only in **regular** browsing via `POST` to a site-specified path (`Content-Type: application/private-token-request`, `Accept: application/private-token-response`), stored on disk; redemption only in **private browsing**: the first cookieless request to a registered https origin carries one token in **`Sec-Private-Verification-Token`** (base64); one token per origin per private session; at most 2 registered eTLD+1s per private session; `nBuckets = 2` (one bit); registration "similar to" PST registration (TBD) with a policy limiting use to "trust, rate limiting and IVT detection". For an agent firewall: a registered site can learn that an Incognito visitor was trusted in a normal profile on the same device; fresh automation profiles never have tokens.

### 9.4 Device Bound Session Credentials (DBSC)

Shipped in **Chrome 145 on Windows** (keys in the TPM); Help Net Security reports GA in Chrome 146 (2026-04-10) and macOS "in a subsequent release" (secondary); Google Workspace enabled by default (May 2026, secondary). W3C Editor's Draft 2026-09-08 (WebAppSec WG; editors from Google): headers `Secure-Session-Registration` (params `path`, `challenge`, `authorization`, federated `provider_*`), `Secure-Session-Challenge` (`id`), `Secure-Session-Response` (DBSC proof JWT, `typ: dbsc+jwt`, `alg` `ES256`/`RS256`/`none`, `jwk` on registration, `jti` = challenge), `Sec-Secure-Session-Id`, `Secure-Session-Skipped` (`unreachable`, `server_error`, `quota_exceeded`). Chrome docs example: `Secure-Session-Registration: (ES256 RS256); path="/StartSession"`; Chrome "gracefully falls back to standard behavior" when secure key storage is unavailable. Signal value: a Windows Chrome ≥ 145 session that never answers registration suggests a non-standard build/VM without TPM access, but legitimate users without TPMs also fall back — treat as weak.

### 9.5 WebAuthn / passkeys as presence proofs

A WebAuthn assertion with UP=1 proves a *gesture on an authenticator*, but automation can satisfy it: Chromium's CDP `WebAuthn` domain (`content/browser/devtools/protocol/webauthn_handler.cc`) implements `AddVirtualAuthenticator` with options `protocol` (`ctap2`/`u2f`), `transport` (internal/usb/nfc/ble/hybrid/smartcard), `ctap2Version`, `hasResidentKey`, `hasUserVerification`, `isUserVerified`, **`automaticPresenceSimulation` (default `true`)**, `hasLargeBlob`, `hasCredBlob`, `hasMinPinLength`, `hasPrf`, `hasHmacSecret`, `defaultBackupEligibility`, `defaultBackupState`; commands `SetUserVerified`, `SetAutomaticPresenceSimulation`, `AddCredential`, `GetCredentials`, `SetCredentialProperties`, etc.; the WebDriver spec exposes the same via Selenium's virtual authenticator (`isUserVerified`, `hasUserVerification`, `isUserConsenting`, `hasResidentKey`). A relying party can distinguish platform authenticators by attestation (AAGUID, `authenticatorAttachment`, `transports`, backup flags) but a virtual authenticator with `transport: internal` and self/none attestation is indistinguishable without attestation policy. Safari 26.0 added the Digital Credentials API (`org-iso-mdoc`), Safari 27 adds WebDriver commands to simulate wallet payloads and user rejection — i.e. identity-document flows are automatable in test configurations too.

---

## 10. User-Agent, UA reduction and Client Hints

- Chromium's reduced UA platform strings (source, `GetUnifiedPlatform()`): Windows `Windows NT 10.0; Win64; x64`, macOS `Macintosh; Intel Mac OS X 10_15_7`, Linux `X11; Linux x86_64`, Android `Linux; Android 10; K`, ChromeOS `X11; CrOS x86_64 14541.0.0`; Android desktop/XR may spoof as ChromeOS (`kAndroidDesktopUASpoofAsChromeOS`). UA template: `Mozilla/5.0 (%s) AppleWebKit/537.36 (KHTML, like Gecko) %s Safari/537.36`, product `Chrome/MAJOR.0.0.0` or `HeadlessChrome/...`, ` Mobile` appended with `kUseMobileUserAgent`.
- Safari 26 (2025-09-15): iOS/iPadOS/visionOS UA no longer reports the OS version (frozen `iPhone OS 18_6`), macOS frozen at `10_15_7`; `Version/26.0` still reveals the Safari release; third-party iOS browsers report the real OS version; Safari has **no** UA Client Hints. Safari 26 also "prevents known fingerprinting scripts from reliably accessing web APIs that may reveal device characteristics" (screen dimensions, hardwareConcurrency, SpeechSynthesis voices, 2D canvas) — expect degraded/perturbed values from *known* scripts.
- UA-CH (WICG draft, 2026-10-06): request headers `Sec-CH-UA`, `-Arch`, `-Bitness`, `-Form-Factors`, `-Full-Version` (deprecated), `-Full-Version-List`, `-Mobile`, `-Model`, `-Platform`, `-Platform-Version`, `-WoW64`; `getHighEntropyValues` hints `architecture`, `bitness`, `formFactors`, `fullVersionList`, `model`, `platformVersion`, `uaFullVersion`, `wow64`. **Form-factor values**: `"Desktop"`, `"Automotive"`, `"Mobile"`, `"Tablet"`, `"XR"`, `"EInk"`, `"Watch"` (lexical order, case-sensitive); shipped Chrome 123/124 (Intent to Ship 2024-02-20; Chromium adds `XR` on Android XR). GREASE brand `"Not(A:Brand";v="24"` etc. from the fixed pool `{"8","99","24"}` with seeded shuffles — a spoofed brand list that uses other GREASE versions or orderings is detectable.
- `Accept-CH` / `Critical-CH` work on `http://127.0.0.1` [measured], so a local test harness can request all hints.

---

## 11. Fetch Metadata, Sec-Purpose, speculation

- `Sec-Fetch-Site` ∈ `cross-site|same-origin|same-site|none`; `Sec-Fetch-Mode`; `Sec-Fetch-Dest`; `Sec-Fetch-User: ?1` only on user-activated navigations (Fetch Metadata spec). Measured matrix in §4.
- `Sec-Purpose: prefetch` (MDN: only defined purpose; sent for `<link rel=prefetch>` and speculation-rules prefetch) and `Sec-Purpose: prefetch;prerender` for prerenders (Chrome prerender docs); `Sec-Speculation-Tags: null | "tag", ...` lists the rules that triggered a speculation (Chrome 134+); Chrome 151 adds speculation `form_submission` and an `on-prefetch-activation` beacon header OT. In-page: `document.prerendering`, `prerenderingchange`, `PerformanceNavigationTiming.activationStart`. Address-bar prerendering happens above 50 % confidence (preconnect 30-50 %) and only with "Preload pages" enabled, never in Save-Data/energy-saver or low-memory. Automation stacks rarely produce speculation traffic; a session with zero `Sec-Purpose` requests on a site that ships speculation rules is a weak bot indicator; conversely scripted navigations never carry `Sec-Purpose`.

---

## 12. Device, presence and environment APIs (status and headless behaviour)

| API | Shape | Policy / gating | Browser status (MDN) | Automation note |
|---|---|---|---|---|
| Battery | `navigator.getBattery()` → `charging`, `level`, `chargingTime`, `dischargingTime`; `SecurityError` in insecure contexts (Chrome 103+) | `battery` permissions-policy | Chrome/Edge; not Firefox/Safari (no table in fetch) | headless on a laptop returns real values [measured]; VMs/containers return the "no battery" pattern (charging true, level 1, dischargingTime Infinity per spec) |
| Compute Pressure | `PressureObserver.observe("cpu"|"thermals")`, states `nominal/fair/serious/critical`; Chrome 152 adds a CPU Performance API | `compute-pressure` (default `'self'`); Window, Worker, SharedWorker; not Service Worker | Limited availability (Chrome) | present in headless [measured]; load patterns differ for cloud VMs |
| WebGPU adapter info | `adapter.info.{vendor, architecture, device, description}`, `isFallbackAdapter`, subgroup sizes | secure context | Chrome, Safari 26+ (WebGPU shipped), Firefox (partial) | headless on macOS reports the real Metal adapter [measured]; Linux headless typically exposes SwiftShader/fallback (**not measured**) |
| Window Management | `window.getScreenDetails()`, `screen.isExtended`, `ScreenDetailed` (`isPrimary`, `isInternal`, `label`, …), `requestFullscreen({screen})` | `window-management` permission + policy; `NotAllowedError` when blocked; `isExtended` false when blocked | Chrome/Edge | `getScreenDetails` present, `isExtended false` in headless [measured]; prompting for it reveals agents that auto-dismiss or can't answer prompts |
| Idle Detection | `IdleDetector.requestPermission()` (needs activation), `start({threshold ≥ 60000})`, `userState active/idle`, `screenState locked/unlocked` | `idle-detection` | Chrome/Edge | present in headless [measured]; an "active" user who never produces input is contradictory |
| Keyboard Map | `navigator.keyboard.getLayoutMap()` → `KeyboardLayoutMap` | `keyboard-map` policy; secure context; desktop only | Chrome/Edge | 48 entries in headless macOS [measured]; mismatch between layout map and typed `KeyboardEvent.code/key` pairs is a synthetic-typing tell |
| User Activation | `navigator.userActivation.isActive/hasBeenActive` | — | Baseline Nov 2023 | granted by CDP/extension input [measured] |
| Document PiP | `window.documentPictureInPicture` | requires user activation | Chrome 116+ | present in headless [measured] |
| Storage Access | `document.requestStorageAccess()`; `requestStorageAccessFor` removed with RWS | user activation | all engines | `requestStorageAccessFor` absent in Chrome 155 [measured] |
| Shared Storage | `window.sharedStorage` | — | **removed** (Chrome 152/153) | absent in Chrome 155 [measured]; presence in a "Chrome 155" UA = spoof |
| Isolated Web Apps | enterprise-installed signed bundles; `unframed` display, sub-apps (152), Window Shape API (154, ChromeOS), Direct Sockets with `local-network`/`loopback-network` policies (151) | — | Chrome (managed) | not relevant to public sites except as `display-mode` media queries |
| Trusted Types | `trustedTypes.createPolicy`, CSP `require-trusted-types-for 'script'`, `trusted-types <names>` | CSP | **Baseline Feb 2026** (all major engines) | use Trusted Types to harden the SDK itself; not an agent signal |
| Built-in AI | `LanguageModel` (Prompt API stable Chrome 148), `Summarizer`, `Translator`, `LanguageDetector` | — | Chrome | present in headless [measured]; Chrome's example WebMCP agent extension can run on the Prompt API, so built-in-AI availability is a precondition for some local agents, not an agent signal |
| Digital Credentials | `navigator.credentials.get({digital})`, `DigitalCredential.userAgentAllowsProtocol()` | user activation | Chrome, Safari 26 (`org-iso-mdoc`) | automatable in WebDriver (Safari 27) |

---

## 13. Permissions Policy features to know (exact names)

`tools` (WebMCP; default `'self'`), `compute-pressure`, `window-management`, `keyboard-map`, `battery`, `idle-detection`, `private-state-token-issuance` / `private-state-token-redemption` (PST; names per Chrome's PST docs — **uncertain**, not re-verified in 2026), `local-network`, `loopback-network` (Chrome 151, replaces `direct-sockets-private`), `display-capture`, `camera`/`microphone` (Chrome 153 adds declarative `<camera>`/`<microphone>` elements requiring a click). `Permissions-Policy: tools=()` is the only policy that specifically addresses agents.

---

## 14. Standards landscape for agent identification (what exists, what does not)

- **Does not exist (searched; nothing found)**: `navigator.agent`, `Sec-Agent`, `Agent-Mode`, `Sec-CH-UA-Agent`, any WICG client-hint or header that says "this request comes from an AI agent"; Chrome's I/O 2026 announcements, the agent-ready toolkit (2026-06-22) and the Chrome security architecture post mention no such signal. The UA-CH spec (2026-10-06) has no agent token.
- **WebKit's explicit stance** (standards-positions #670): WebMCP makes "an agent is driving" an observable fact, which WebKit regards as a design flaw; "we should not expose to sites that a user is relying on an agent, and we should minimise any such signal". Expect Safari never to ship a page-visible agent bit.
- **W3C** "W3C and the State of the Web in the AI Era" (Strategy Team discussion paper, finalised 2026-10-20, published 2026-10-21, to be presented at TPAC 2026-10-29): proposes a nine-point "Value of the web in the AI era" declaration (point 3: "Consequential actions need real human consent; people can see what was done, undo where possible"), chartering an **Agentic Web Working Group** "with explicit scope for security and privacy, agent identity and delegation, and the WebMCP-HTML-ARIA relationship", VC/DID-based agent identity ("Verifiable Credentials and DIDs can identify agents and express whom they act for"), WebAuthn/FedCM work on "How an agent presents delegated authority without holding credentials" paired with "Proof that a human approved; per-agent, revocable permissions", a WebMCP threat model in the Security IG, and consent definitions in the Privacy WG. No wire-level site-disclosure mechanism is proposed.
- **IETF**: webbotauth WG (above); WIMSE (`draft-ietf-wimse-arch`, agent identity drafts `draft-ni-wimse-ai-agent-identity-02`, `draft-klrc-aiagent-auth-00` not adopted); DAWN (agent discovery) charter under IESG review Sept 2026 (CSA note 2026-09-02). RFC 9421 (HTTP Message Signatures), RFC 9576-9578 (Privacy Pass) are the cryptographic bases.
- **Microsoft NLWeb**: Schema.org-based conversational layer where "each NLWeb instance acts as an MCP server" (core `ask` method; spec at nlweb.ai/spec; A2A "upcoming"); defines no caller identification.
- **Courts**: Amazon v. Perplexity establishes (for CFAA/CDAFA) that a locally running agent's requests are the *user's* access; site-level identification will have to be technical or contractual (ToS claims left open; rehearing reportedly denied 2026-09-10, secondary).

---

## 15. Detector design implications (platform-signal matrix)

| Agent class | Cooperative signals | Non-cooperative platform signals | What does NOT work |
|---|---|---|---|
| (a) Playwright/Puppeteer/Selenium stacks (Browser Use, Stagehand, Skyvern, Playwright MCP launch modes, chrome-devtools-mcp launch) | none (unless Web Bot Auth added; browser-use has not) | `navigator.webdriver` (Puppeteer, Playwright via pipe, ChromeDriver via port 0) unless `--disable-blink-features=AutomationControlled`; `HeadlessChrome` UA token vs normal `Sec-CH-UA` brands; `screen` 800x600 vs `outer*` from `--window-size`; `chromium-headless-shell` (Playwright headless) = old headless differences; Playwright's `--blink-settings=primaryPointerType=4...`; feature-presence vs claimed version; CDP input physics (`pressure 0`, ~ms press durations, integer coords, no move trail); `Page.navigate` pattern (`Sec-Fetch-Site: none` + `?1` + no Referer on every page); missing speculation traffic; empty `deviceId`/labels; `AcceptCHFrame` disabled in Puppeteer (no ACCEPT_CH frame support) | `isTrusted`, `userActivation`, popup/clipboard gating |
| (b) Cloud computer-use agents (ChatGPT agent/cloud browser, Google-Agent remote browser, Manus cloud) | Web Bot Auth signatures (OpenAI always, Google subset); UA tokens (`Google-Agent`); IP JSON lists; SAIL/JAFAR when published | datacenter ASN; `Google-Agent` UA uses frozen Linux/Nexus 5X templates; cloud browsers are Chromium with stable UA (Stytch) | relying on UA for OpenAI (none documented) |
| (c) Extension/agentic-browser agents (Claude in Chrome, Gemini auto browse, Comet, Edge Copilot, Playwright MCP `--extension`, chrome-devtools-mcp `--autoConnect`) | WebMCP tool invocations (`agentInvoked`, `toolactivated`) where supported (Gemini "soon", Copilot/Edge OT, Brave Leo) | `webdriver false`, normal UA; extension-initiated navigation headers (`cross-site`, no `Sec-Fetch-User`, no `Referer`); CDP input physics (zero hold time, 0.1 ms inter-key, `pressure 0`); tab-group/infobar are not page-visible; Comet: no UA token by design | UA, IP, cookies (real user's), DBSC/PAT/PST (real device) |
| (d) Fetch/tool-call agents and crawlers | UA tokens (`ChatGPT-User/1.0`, `OAI-SearchBot/1.4`, `GPTBot/1.4`, `OAI-AdsBot/1.0`, `PerplexityBot/1.0`, `Perplexity-User/1.0`, `Claude-User`, `ClaudeBot`, `Claude-SearchBot`, `Google-GeminiNotebook`, …), IP JSON, Web Bot Auth, SAIL/JAFAR | no JS execution → SDK never runs; server/edge only: missing `Sec-Fetch-*`/UA-CH, HTTP client fingerprints (other research area) | — |

Implementation hooks for the SDK (client) and edge companion:
1. **WebMCP tripwire module**: if `'modelContext' in document`, register a hidden tool (and a declarative form with `toolname` but no visible UI); report `toolactivated`, `executeTool`, `submit.agentInvoked`, `:tool-form-active` matches; expose `Permissions-Policy: tools=()` as an action.
2. **Automation-flag module**: read `navigator.webdriver` and verify the getter is native (`Object.getOwnPropertyDescriptor(Navigator.prototype,'webdriver').get` toString `[native code]`); flag getter replacement (Google reportedly does).
3. **UA/UA-CH consistency module**: `HeadlessChrome` vs brands; GREASE pool/shuffle validity; `formFactors` vs `screen`/pointer media; frozen platform strings; `platformVersion` vs feature set (e.g. `sharedStorage` must be absent ≥ 153; `document.hasPrivateToken` present; `LanguageModel` present ≥ 148).
4. **Window/screen geometry module**: `outerWidth/Height > screen.*`, `screen` exactly 800x600, `screenX/Y` constant 22, `isExtended`, dpr vs `sec-ch-dpr`.
5. **Input-physics module**: per pointer/key event capture `pressure`, `buttons`, `timeStamp` deltas (down→up, key hold, inter-key), `movementX/Y`, fractional coordinates, pre-click move trail, `sourceCapabilities`; emit per-session statistics.
6. **Fetch-Metadata module (edge)**: per-session histogram of `Sec-Fetch-Site`/`Sec-Fetch-User`/`Referer` on `Sec-Fetch-Dest: document` requests; presence of `Sec-Purpose`/`Sec-Speculation-Tags`; `Sec-Private-Verification-Token` redemption; DBSC registration completion.
7. **Signature module (edge)**: RFC 9421 verification against cached directories for `https://chatgpt.com`, `https://agent.bot.goog` and registry/agent-card entries; distinct `verified/invalid/unverified`; SAIL/JAFAR IP confirmation/refutation keyed on the `User-Agent` product token.
8. **Trust-bit module**: act as PST issuer/redeemer and (when the OT is available) PVT issuer; treat tokens as device/profile continuity, never as humanity.

---

## 16. Unknowns and items to verify next

- Exact Chrome 155 release notes (page 404 at fetch time) and whether the WebMCP OT really ends at 156.
- Whether Gemini in Chrome auto browse (local) or the Google remote browser presents any token (remote browser probably `Google-Agent`; unverified), and whether Gemini's actuation path yields the same event physics as CDP (not measurable without access).
- Edge Copilot Mode/Actions: Microsoft documentation of UA/headers (only a vendor claim that it inherits the UA).
- Safari 27 MCP sessions: confirm `navigator.webdriver === true` and the orange-field automation window behaviour for `safaridriver --mcp`.
- ChatGPT desktop app browser agent and the ChatGPT Chrome extension (Atlas successors): extension ID, UA, headers, WebMCP usage.
- Linux/container headless fingerprints (SwiftShader/llvmpipe WebGL strings, zero voices, no battery) — not measured here (macOS host).
- Whether Playwright's current Chromium builds grant `navigator.webdriver` through `--remote-debugging-pipe` identically in `chromium-headless-shell` (old headless) — inferred from source, not measured.
- Pointer `pressure`/timing of other CDP clients (Puppeteer `page.mouse`, Playwright, Claude in Chrome's pointerdown/up timing truncated in capture).
- Privacy Pass issuance to agents: no 2026 source; monitor Apple/Cloudflare and the anonymous-webbotauth draft.
- PST permissions-policy names and 2026 issuer-registration status were not re-verified.

---

## Sources

Chrome / Google
- https://developer.chrome.com/blog/chrome-at-io26 (I/O 2026 roundup; WebMCP OT Chrome 149; Prompt API stable 148)
- https://developer.chrome.com/blog/agent-ready-toolkit (2026-06-22; Lighthouse Agentic browsing from M150; `chrome://flags/#enable-webmcp-testing`)
- https://developer.chrome.com/docs/ai/webmcp , https://developer.chrome.com/docs/ai/webmcp/imperative-api , https://developer.chrome.com/docs/ai/webmcp/declarative-api
- https://developer.chrome.com/docs/devtools/application/webmcp ; https://developer.chrome.com/docs/lighthouse/agentic-browsing/scoring
- https://developer.chrome.com/release-notes/150 , /151 , /152 , /153 , /154 ; https://developer.chrome.com/blog/chrome-156-beta
- https://developer.chrome.com/docs/chromium/headless ; https://developer.chrome.com/docs/automation-and-testing/headless-cli
- https://developer.chrome.com/blog/remote-debugging-port (Chrome 136 change)
- https://developer.chrome.com/docs/web-platform/device-bound-session-credentials ; https://developer.chrome.com/blog/dbsc-windows-announcement
- https://developer.chrome.com/docs/privacy-security/private-state-tokens ; https://privacysandbox.google.com/blog/update-on-plans-for-privacy-sandbox-technologies (2025-10-17)
- https://developer.chrome.com/docs/web-platform/prerender-pages
- https://blog.google/security/architecting-security-for-agentic/ (2025-12-08)
- https://support.google.com/chrome/answer/16821166 (auto browse) ; https://support.google.com/gemini/answer/17094507 (Gemini Task/Spark)
- https://developers.google.com/crawling/docs/crawlers-fetchers/google-agent ; https://developers.google.com/crawling/docs/crawlers-fetchers/web-bot-auth ; https://developers.google.com/search/docs/crawling-indexing/google-user-triggered-fetchers
- https://agent.bot.goog/.well-known/http-message-signatures-directory (fetched 2026-10-24)
- https://raw.githubusercontent.com/explainers-by-googlers/private-verification-tokens/main/README.md ; https://ppc.land/chrome-tests-a-one-bit-signal-telling-sites-an-incognito-visitor-is-human/
- https://raw.githubusercontent.com/ChromeDevTools/chrome-devtools-mcp/main/README.md , docs/advanced-usage.md , docs/configuration.md
- https://groups.google.com/a/chromium.org/g/blink-dev/c/CVOCZ26iqMY (Sec-CH-UA-Form-Factor Intent to Ship)

Chromium / WebKit / Firefox source
- https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/frame/navigator.cc
- https://raw.githubusercontent.com/chromium/chromium/main/content/child/runtime_features.cc
- https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/inspector/inspector_emulation_agent.cc
- https://raw.githubusercontent.com/chromium/chromium/main/components/embedder_support/user_agent_utils.cc
- https://raw.githubusercontent.com/chromium/chromium/main/content/browser/devtools/protocol/input_handler.cc
- https://raw.githubusercontent.com/chromium/chromium/main/content/browser/devtools/protocol/webauthn_handler.cc
- https://raw.githubusercontent.com/chromium/chromium/main/chrome/test/chromedriver/chrome_launcher.cc
- https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/headless/headless_mode_util.cc
- https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/Modules/webdriver/NavigatorWebDriver.cpp
- https://raw.githubusercontent.com/mozilla-firefox/firefox/main/dom/base/Navigator.cpp
- https://raw.githubusercontent.com/puppeteer/puppeteer/main/packages/puppeteer-core/src/node/ChromeLauncher.ts
- https://raw.githubusercontent.com/microsoft/playwright/main/packages/playwright-core/src/server/chromium/chromiumSwitches.ts and chromium.ts
- https://raw.githubusercontent.com/microsoft/playwright-mcp/main/README.md

Specs and standards
- https://webmachinelearning.github.io/webmcp/ (Draft CG Report 2026-10-20) ; https://raw.githubusercontent.com/webmachinelearning/webmcp/main/README.md , implementation-status.md , declarative-api-explainer.md
- https://github.com/WebKit/standards-positions/issues/670 ; https://github.com/mozilla/standards-positions/issues/1412
- https://datatracker.ietf.org/wg/webbotauth/documents/ ; https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html ; https://www.ietf.org/archive/id/draft-meunier-webbotauth-httpsig-protocol-00.html ; https://www.ietf.org/archive/id/draft-meunier-webbotauth-registry-03.html ; https://www.ietf.org/archive/id/draft-rescorla-anonymous-webbotauth-01.html ; https://www.ietf.org/archive/id/draft-illyes-webbotauth-jafar-01.html ; https://www.ietf.org/archive/id/draft-kelley-webbotauth-sail-00.html
- https://wicg.github.io/ua-client-hints/ (2026-10-06) ; https://w3c.github.io/webappsec-fetch-metadata/ ; https://w3c.github.io/webappsec-dbsc/ (ED 2026-09-08) ; https://html.spec.whatwg.org/multipage/interaction.html
- https://www.w3.org/2026/10/w3c-and-state-of-web-in-ai-era.html ; https://ppc.land/w3c-drafts-9-point-declaration-putting-people-ahead-of-ai-agents/
- https://labs.cloudsecurityalliance.org/research/csa-research-note-ietf-agent-identity-standards-20260902-csa/
- MDN: https://developer.mozilla.org/en-US/docs/Web/API/Navigator/webdriver , /Web/HTTP/Reference/Headers/Sec-Purpose , /Sec-Speculation-Tags , /Web/API/UserActivation , /Web/API/Compute_Pressure_API , /Web/API/GPUAdapter/info , /Web/API/Window_Management_API , /Web/API/IdleDetector , /Web/API/Keyboard/getLayoutMap , /Web/API/Navigator/getBattery , /Web/API/Trusted_Types_API , /Mozilla/Firefox/Releases/140 , /157
- https://www.selenium.dev/documentation/webdriver/interactions/virtual_authenticator/

Vendors / agents
- https://developers.openai.com/api/docs/bots ; https://chatgpt.com/.well-known/http-message-signatures-directory (fetched 2026-10-24) ; https://blog.castle.io/how-to-authenticate-openai-operator-requests-using-http-message-signatures/
- Atlas shutdown: https://9to5mac.com/2026/07/09/openai-is-discontinuing-chatgpt-atlas-its-standalone-desktop-browser/ ; https://www.macrumors.com/2026/07/10/openais-chatgpt-atlas-browser-shutting-down/ ; https://en.wikipedia.org/wiki/ChatGPT_Atlas
- https://caselaw.findlaw.com/court/us-9th-circuit/294834.html (Amazon v. Perplexity, 2026-08-04) ; https://docs.perplexity.ai/guides/bots ; https://blog.cloudflare.com/perplexity-is-using-stealth-undeclared-crawlers-to-evade-website-no-crawl-directives/
- https://code.claude.com/docs/en/chrome ; https://support.claude.com/en/articles/12012173-getting-started-with-claude-in-chrome ; https://claude.com/chrome ; https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler
- https://webkit.org/blog/18325/webkit-features-for-safari-27-0/ ; https://webkit.org/blog/17333/webkit-features-in-safari-26-0/ ; https://webkit.org/blog/6900/webdriver-support-in-safari-10/ ; https://nielsleenheer.com/articles/2025/the-user-agent-string-of-safari-on-ios-26-and-macos-26/ ; https://www.apple.com/newsroom/2026/06/apple-intelligence-brings-powerful-ai-capabilities-into-everyday-experiences/
- https://fxdx.dev/deprecating-cdp-support-in-firefox-embracing-the-future-with-webdriver-bidi/ ; https://fxdx.dev/firefox-webdriver-newsletter-157/ ; https://www.firefox.com/en-US/firefox/150.0/releasenotes/ ; https://www.firefox.com/en-US/firefox/157.0/releasenotes/
- https://developers.cloudflare.com/bots/concepts/bot/verified-bots/web-bot-auth/ ; https://blog.cloudflare.com/signed-agents/ ; https://blog.cloudflare.com/privacy-pass-standard/
- https://stytch.com/blog/detecting-ai-agent-use-abuse/ ; https://www.isagent.dev/faq ; https://stytch.com/blog/stytch-supports-web-bot-auth/
- https://www.humansecurity.com/ai-agent/copilot-actions/ (vendor directory; 403 on direct fetch, content via search summary) ; https://www.centinelanalytica.com/blog/ai-browser-agents (2026-10-11 vendor-doc audit)
- https://github.com/browser-use/browser-use/issues/6109 ; https://raw.githubusercontent.com/nlweb-ai/NLWeb/main/README.md
- https://educatedguesswork.org/posts/private-access-tokens/ ; https://www.helpnetsecurity.com/2026/04/10/google-chrome-device-bound-session-credentials/

Local measurement artefacts (scratchpad, this session): `necter-platform-probe-7f3a19/` (probe page, CDP pipe client, JSON outputs) and `probe/out2/` (CDP input experiment JSON, request logs).
