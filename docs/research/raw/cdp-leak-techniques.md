# In-page detection of browser automation: CDP leaks, headless tells, tamper detection (2024 – Oct 2026)

Research area: state of the art in detecting browser automation from inside the page with JavaScript, plus the server-visible tells of headless/automated Chromium, Firefox and WebKit.

Date of research: 2026-10-24. Author: research subagent for necter.

How to read confidence labels:

- **confirmed** = read in primary source code/docs AND/OR reproduced locally in this session.
- **likely** = stated by a credible primary-ish source (vendor research with code, project README) but not reproduced here.
- **uncertain** = secondary claim, contradictory sources, or inferred; verify before relying on it.

Local measurements in this report were taken on macOS (Darwin 25.6, Apple Silicon) with:

| Label | Binary | Reported `Browser` (from `/json/version`) |
|---|---|---|
| chrome155 | `/Applications/Google Chrome.app` (stable) | `Chrome/155.0.8059.86`, V8 `15.5.35.25` |
| cft156 | Puppeteer cache `chrome/mac_arm-156.0.8078.47` (Chrome for Testing) | `Chrome/156.0.8078.47` |
| headless_shell156 | Puppeteer cache `chrome-headless-shell/mac_arm-156.0.8078.47` | `HeadlessChrome/156.0.8078.47` |
| pw_headless_shell1248 | Playwright cache `chromium_headless_shell-1248` | `HeadlessChrome/156.0.8078.4` |
| pw_chromium1248 | Playwright cache `chromium-1248` (this is also a "Google Chrome for Testing" .app) | `Chrome/156.0.8078.4` (hung on `Page.navigate` in my harness; only version captured) |

All launched with `--headless --remote-debugging-port=0 --user-data-dir=<tmp> --no-first-run --no-default-browser-check about:blank` plus per-run extras. The harness (stdlib-only Python CDP client), the raw JSON per run and the stack-frame comparison output are in `docs/research/raw/cdp-probe/` (`probe.py`, `stack_fp.py`, `<label>.json`, `stack_frames_chrome155.txt`). No headed (windowed) baseline was captured in this session, so every "headed Chrome does X" statement below cites a source or is marked uncertain.

---

## 0. Executive summary (what still works in Oct 2026, ranked)

1. **`Runtime.enable` console-serialization leaks still exist on current Chrome (155/156), but the famous `Error.stack` getter probe is dead.** V8 commits `61a907540d` (2025-05-07) and `e08e973474` (2025-05-09) added `getErrorProperty()` so user-defined getters are skipped during object/error preview. The fix is absent from every V8 13.7.152.x tag (Chrome 137) and present from 13.8.258.x (Chrome 138). What still fires with `Runtime.enable` active, measured on Chrome 155/156 and inside Web Workers: (a) a page-installed `Error.prepareStackTrace` is invoked when the inspector formats a logged error's stack (`1` hit with Runtime enabled, `0` without); (b) an inherited `name` getter on an `Error` subclass is read 3x instead of 1x, and an inherited `message` getter 2x instead of 1x. [confirmed]
2. **Who still sends `Runtime.enable`:** Puppeteer (`FrameManager.initialize`), Playwright (`FrameSession._initialize`), chromium-bidi (`CdpTarget.#unblock`, i.e. WebDriver BiDi on Chrome, Puppeteer BiDi mode, Selenium BiDi), and anything built on them (Playwright MCP, chrome-devtools-mcp, Skyvern, Stagehand v2-era, most "AI browser agents" on Playwright). Not sent by: rebrowser-patches, Patchright, nodriver, Selenium-Driverless, browser-use ≥0.5 (cdp-use; verified in `session.py`, `session_manager.py`, `dom/service.py`, watchdogs). DevTools being open also triggers it (false positive; disambiguate with the `debugger;` timing check: with the Debugger domain enabled a `debugger;` statement blocks, measured 507 ms vs 0 ms). [confirmed]
3. **`navigator.webdriver`** is `true` under `--enable-automation`, `--headless`, `--remote-debugging-pipe`, `--remote-debugging-port=0`, or the CDP command `Emulation.setAutomationOverride`. It is `false` with `--disable-blink-features=AutomationControlled`, and the property keeps a native getter, so tamper checks cannot see the difference. But `--disable-blink-features` is in Chrome's bad-flags list, so it raises the "unsupported command-line flag" infobar, which (measured) removes 56 CSS px from `innerHeight` even in headless. Playwright-driven *headed* Chrome has `webdriver === true` because Playwright always uses `--remote-debugging-pipe`. [confirmed]
4. **New headless (Chrome ≥ 128 `--headless`, measured on 155/156) still has hard tells:** UA still contains `HeadlessChrome/<major>.0.0.0`; default `screen` is 800x600 with the window at (22,22) sized 756x556 outer / 756x469 inner (macOS); `Emulation.setDeviceMetricsOverride` (Puppeteer 800x600, Playwright 1280x720 default viewports) makes `innerWidth > outerWidth` and `innerWidth > screen.width`; `--window-size=1920,1080` makes `outerWidth (1920) > screen.width (800)`; `document.hasFocus()` is `false` until an input event; `--disable-gpu` leaves **no WebGL at all** on Chrome 155 unless `--enable-unsafe-swiftshader` (Playwright passes it) in which case the renderer is `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver)` on macOS arm64 (`(Subzero)` variant on x86 Linux per sources); popup blocking and the 200-calls/10 s `history.replaceState` throttle are intact unless the automation passes `--disable-popup-blocking` / `--disable-ipc-flooding-protection` (Puppeteer and Playwright do). [confirmed]
5. **Chrome for Testing (what Puppeteer and Playwright download) is a Chromium-branded build:** `navigator.userAgentData.brands` = `Chromium` + GREASE only, no `Google Chrome` brand; `navigator.languages` is `["en-US"]` (single entry) vs `["en-US","en"]` in Google Chrome; CfT also shows its own infobar by default (`--disable-infobars` restores the 469 px inner height). chrome-headless-shell (old headless) still has every classic tell: `HeadlessChrome` brand in client hints, un-reduced full version in the UA (`HeadlessChrome/156.0.8078.47`), no `window.chrome`, 0 plugins, `Notification.permission === "denied"` while `permissions.query` says `prompt`, `connection.rtt === 0`, SwiftShader, `inner === outer`, popup blocking off, `screenX === clientX` for CDP input. [confirmed]
6. **CDP-synthesised input has two cheap tells.** `Input.dispatchMouseEvent` defaults `force` to 0 (`mouse_event->force = force.value_or(0)`) while a real mouse carries `NaN`, so Blink's `GetPointerEventPressure` yields `pointerdown.pressure === 0` with `buttons === 1` for CDP clicks vs `0.5` for a real mouse (Chromium source; measured 0 on Chrome 155/156, headed real-mouse baseline not re-measured here). The older `screenX === clientX` leak (crbug 1477537) is fixed in the full browser (screen position is now widget point + view bounds; measured offset +22/+109 on Chrome 155) but still present in chrome-headless-shell. [confirmed / baseline likely]
7. **Stack-trace markers:** code run via `Runtime.evaluate` / `callFunctionOn` without a sourceURL shows frames like `at <anonymous>:1:10` with `CallSite.getFileName() === ""`, `getScriptNameOrSourceURL() === ""`, `isEval() === false`, `getScriptHash() === ""`. Puppeteer adds `//# sourceURL=pptr:<fn>;<site>` (legacy `__puppeteer_evaluation_script__`), Playwright frames contain `UtilityScript.evaluate`, puppeteer-extra-stealth shows `newHandler.<computed> [as apply] (<anonymous>...)`. False-positive sources that also produce bare `<anonymous>` frames: `setTimeout("string")`; `new Function`/`eval` are distinguishable (`eval at …` frames with an eval origin and a non-empty script hash). Isolated-world code (Patchright, Playwright utility world) never reaches main-world hooks at all. [confirmed]
8. **Residue globals still worth scanning:** chromedriver `window.cdc_adoQpoasnfa76pfcZLmcfl_{Array,Object,Promise,Proxy,ShadowRoot,Symbol,JSON,Window}` (injected by `DevToolsClientImpl::SetUpDevTools` via `Page.addScriptToEvaluateOnNewDocument` and `Runtime.evaluate`) and implicit global `ret_nodes`; Playwright `__playwright__binding__` (`Runtime.addBinding`); `__pwInitScripts` existed only up to Playwright 1.52 (gone in 1.53); any `Runtime.addBinding` result is an own, enumerable, writable `window` property whose function has `name === ""` and `toString() === "function () { [native code] }"`. [confirmed]
9. **Tamper/lie detection** remains the strongest layer against stealth plugins: `Function.prototype.toString` consistency, own-property/descriptor checks, Proxy traps and prototype-chain cycles (CreepJS, rebrowser `nativeTampering`), fresh-realm `<iframe>` comparisons, worker-vs-page consistency, and UA/client-hints/`navigator.platform`/WebGL/fonts cross-checks. `Emulation.setUserAgentOverride` without `userAgentMetadata` zeroes `userAgentData` (`brands: []`, `platform: ""`); with metadata the WebGL renderer, fonts and `navigator.platform` (`MacIntel` under a Windows UA) still betray the host. [confirmed]
10. **Firefox / WebKit:** Firefox `navigator.webdriver` is `true` whenever Marionette or the Remote Agent is running (Playwright's Firefox build hard-codes `true`; Camoufox patches it to `false`); Firefox dropped CDP (BiDi only since 141). WebKit returns `isControlledByAutomation()` (safaridriver sessions are `true`, with an orange Smart Search field and a "glass pane"). Playwright WebKit on Linux presents a `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 … Safari/605.1.15` UA that does not exist in the wild. [confirmed from source; Playwright-WebKit UA likely]

---

## 1. `navigator.webdriver` and `--disable-blink-features=AutomationControlled`

### 1.1 Implementation (Blink)

`third_party/blink/renderer/core/frame/navigator.cc` (main, read 2026-10-24):

```cpp
bool Navigator::webdriver() const {
  if (RuntimeEnabledFeatures::AutomationControlledEnabled())
    return true;
  bool automation_enabled = false;
  probe::ApplyAutomationOverride(GetExecutionContext(), automation_enabled);
  return automation_enabled;
}
```

Two independent sources of `true`:

1. The runtime feature `AutomationControlled`, set from the command line in `content/child/runtime_features.cc`:

   ```cpp
   {wrf::EnableAutomationControlled, switches::kEnableAutomation, true},
   {wrf::EnableAutomationControlled, switches::kHeadless, true},
   {wrf::EnableAutomationControlled, switches::kRemoteDebuggingPipe, true},
   ```
   plus a special case:
   ```cpp
   // Set EnableAutomationControlled if the caller passes
   // --remote-debugging-port=0 on the command line. This means
   // the caller has requested an ephemeral port which is how ChromeDriver
   // launches the browser by default.
   // If the caller provides a specific port number, this is
   // more likely for attaching a debugger, so we should leave
   // EnableAutomationControlled unset ...
   if (command_line.HasSwitch(switches::kRemoteDebuggingPort)) {
     ... if (base::StringToInt(port_str, &port) && port == 0) {
       WebRuntimeFeatures::EnableAutomationControlled(true);
   ```
   `--disable-blink-features=AutomationControlled` turns the feature off again (that is all the flag does).

2. The CDP command `Emulation.setAutomationOverride {enabled}` (`inspector_emulation_agent.cc`):
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
   Measured (chrome155, launched with `--disable-blink-features=AutomationControlled`): `navigator.webdriver` `false` → after `Emulation.setAutomationOverride {enabled:true}` → `true` → after `{enabled:false}` → `false`. Any CDP client (including an extension using `chrome.debugger`) can flip it; I did not find a current automation library that calls it (chromedriver's `web_view_impl.cc` first 100 KB has no reference) — [uncertain who uses it].

### 1.2 Measured truth table (this session)

| Launch | `navigator.webdriver` | `'webdriver' in navigator` | descriptor |
|---|---|---|---|
| `--headless --remote-debugging-port=0` | `true` | `true` | `Navigator.prototype` accessor, `function get webdriver() { [native code] }`, enumerable+configurable |
| `… --disable-blink-features=AutomationControlled` | `false` | `true` | identical native getter |
| `… --disable-blink-features=AutomationControlled` + `Emulation.setAutomationOverride(true)` | `true` | `true` | identical |

Consequences:

- A **real user never has `true`** (Chrome never sets it without those switches), so `true` is a zero-false-positive "confession" signal. Everything from Puppeteer/Playwright/chromedriver with default flags confesses; headless always confesses (the `--headless` switch alone sets the feature).
- Playwright launches Chromium with `--remote-debugging-pipe`, so even **headed** Playwright/Playwright-MCP/Skyvern-headed sessions report `true` unless `--disable-blink-features=AutomationControlled` is added (Skyvern and browser-use add it; Playwright MCP does not by default). Puppeteer adds `--enable-automation` (ChromeLauncher `defaultArgs`) and uses `--remote-debugging-pipe` or `--remote-debugging-port=0`, so it is `true` headed too.
- `--disable-blink-features=AutomationControlled` is **undetectable from the property itself** (native getter, present on the prototype, returns `false`). Stealth plugins that *delete* or redefine the property are detectable: `'webdriver' in navigator === false`, `Object.getOwnPropertyDescriptor(Navigator.prototype,'webdriver') === undefined`, or a non-native getter `toString`.
- Side effect of the flag (new in this report): `switches::kDisableBlinkFeatures` is in Chrome's `kBadFlags` list (`chrome/browser/ui/startup/bad_flags_prompt.cc`, message `IDS_BAD_FLAGS_WARNING_MESSAGE`, "You are using an unsupported command-line flag …" — text not quoted from source, well known), together with `--no-sandbox`, `--disable-web-security`, `--ignore-certificate-errors`, `--enable-blink-features`, `--disable-gpu-sandbox`, `--disable-setuid-sandbox`, `--single-process`, `--enable-unsafe-webgpu`, etc. Only the first matching flag shows. Measured in headless on chrome155: `innerHeight` 469 → 413 when the flag is present (same 56 px drop as the `--enable-automation` infobar). So the single most popular stealth flag makes the browser *look different* in geometry terms; see §9.3.
- Firefox: `Navigator::Webdriver()` (gecko-dev `dom/base/Navigator.cpp`, under `#ifdef ENABLE_WEBDRIVER`) returns `true` if `nsIMarionette.running` or `nsIRemoteAgent.running`. Playwright's Firefox patch (`browser_patches/firefox/patches/bootstrap.diff`) replaces the body with `// Playwright is automating the browser, so we should pretend to be a webdriver` / `return true;`; Camoufox's `browser/patches/playwright/1-leak-fixes.patch` turns that into `return false;`.
- WebKit: since r217391 (2017-05-24, bug 171997) `navigator.webdriver` is a static getter returning `isControlledByAutomation()`; safaridriver "Automation windows" return `true`.

Reliability: FP ≈ 0. Bypass status 2026: trivially disabled by every stealth stack (rebrowser-patches, Patchright, browser-use, Skyvern, nodriver, Camoufox). Use as a high-weight positive signal, never as a negative one.

---

## 2. The `Runtime.enable` console-serialization leak family

### 2.1 Mechanism

- Chromium only emits `Runtime.*` events to a DevTools session after that session sends `Runtime.enable`. Puppeteer, Playwright and chromium-bidi send it on every page/frame/worker session to receive `Runtime.executionContextCreated` (needed to know execution-context ids).
- Once enabled, every `console.*` call produces a `Runtime.consoleAPICalled` event whose `args` are serialized as `RemoteObject`s with previews. Building the preview of an `Error` goes through `descriptionForError()` in `v8/src/inspector/value-mirror.cc`, which reads `name`, `message` and `stack`. Before May 2025 it did so with `object->Get(...)`, which runs user-defined getters (DataDome's June 13 2024 technique):

  ```js
  var detected = false;
  var e = new Error();
  Object.defineProperty(e, 'stack', { get() { detected = true; } });
  console.log(e);           // getter runs only if a CDP client has Runtime enabled (or DevTools is open)
  ```
  (DataDome used `console.log`; most detectors use `console.debug` because it is hidden by default in the DevTools console.)

### 2.2 The V8 fix and its exact Chrome milestone

- `61a907540d4c1dda4733476e54c977910f31041d` — "[inspector] Prevent side effects during object preview", Pavel Feldman, authored 2025-05-06, committed 2025-05-07, bug 415094795. Adds `deepBoundFunction` helper and tests `test/inspector/runtime/preview-sideeffects.js`.
- `e08e97347454255a337dcea361808fb25ca09077` — "[inspector] Prevent side effects during error preview", committed 2025-05-09, same bug. Adds `getErrorProperty()`; `descriptionForError` now calls `getErrorProperty(context, object, toV8String(isolate, "name"|"stack"|"message"))`. Test `error-preview-sideeffects.js` asserts `stackCalled : false`, `stackCalledOnBase : false`, `stackCalledOnProxy : false`.
- Guard logic (current main, refactored into `isBuiltinGetter`):
  ```cpp
  if (function->GetBoundFunction()->IsFunction()) return false;
  return function->ScriptId() == v8::UnboundScript::kNoScriptId;   // builtin getters only
  ...
  if (!getDescriptor->IsFunction() || !isBuiltinGetter(getDescriptor.As<v8::Function>())) {
      return v8::MaybeLocal<v8::Value>();   // skip user getters
  }
  ...
  return object->Get(context, name);        // data properties / builtin accessors
  ```
  `buildObjectPreviewInternal` unwraps proxies (`while (value->IsProxy()) value = value.As<v8::Proxy>()->GetTarget();`) and renders non-invoked accessors as `PropertyPreview::TypeEnum::Accessor`.
- Milestone: `getErrorProperty` is **absent** in V8 tags `13.7.152.14` and `13.7.152.19` (the last 13.7 tag) and in branch `13.7-lkgr`, and **present** in `13.8.258.26` and `13.8-lkgr`. V8 13.7 ↔ Chrome 137, 13.8 ↔ Chrome 138. So the classic probe died with **Chrome 138** (stable late June 2025), not 137 as crawlex ("shipped on the M137 train") and rebrowser's note ("Chrome 136 and older") imply. Castle's write-up (2025-08-28) does not name a milestone. [confirmed via tags]

### 2.3 What still leaks on Chrome 155/156 (measured)

Probe set run three times per page: (a) before `Runtime.enable`, (b) with it enabled, (c) after `Runtime.disable`. Identical results on chrome155, cft156, headless_shell156, pw_headless_shell1248 and in a dedicated Web Worker whose session had `Runtime.enable`:

| Probe (all via `console.debug` unless noted) | Runtime disabled | Runtime enabled | after `Runtime.disable` |
|---|---|---|---|
| own `stack` getter on an Error (classic) | 0 | **0** | 0 |
| `Error.prepareStackTrace = (err, frames) => …` installed, then log a fresh Error | 0 | **1** | 0 |
| Error subclass with inherited `get name()` | 1 | **3** | 1 |
| Error subclass with inherited `get message()` | 1 | **2** | 1 |
| Proxy with `ownKeys` trap as prototype, `console.groupEnd(obj)` (svebaa, Mar 2026) | 0 | 0 | 0 |
| same object via `console.debug` | 0 | 0 | 0 |
| Proxy with `get`/`has` traps as prototype | 1 | 1 | 1 |
| plain object own enumerable getter | 0 | 0 | 0 |
| `Symbol.toStringTag` getter | 1 | 1 | 1 |
| `Map` subclass `size` getter | 0 | 0 | 0 |
| custom `toString`/`valueOf` | 0 | 0 | 0 |
| getter on array index 1 | 1 | 1 | 1 |
| `Date` with overridden `toString`/`toISOString` | 1 | 1 | 1 |
| 101st enumerable getter on a large object | 0 | 0 | 0 |
| getter inside `error.cause` | 0 | 0 | 0 |
| `console.dir`/`log`/`table` of getter object | 0 | 0 | 0 |

Why the survivors work:

- `prepareStackTrace`: V8 formats `error.stack` lazily. The own `stack` property is a *builtin* accessor (no script id), so `getErrorProperty` falls through to `object->Get`, which calls `ErrorUtils::FormatStackTrace` → `JSReceiver::GetProperty(isolate, global_error, "prepareStackTrace")` on the error's realm `Error` constructor → `Execution::Call(prepare_stack_trace, …)` if it is a function (guarded by `isolate->formatting_stack_trace()` recursion check and `HasPrepareStackTraceCallback`, which Blink does not set). The page's hook therefore runs exactly once per serialized error.
- Inherited `name`/`message`: `getErrorProperty` only inspects the **own** descriptor; `Error` instances have no own `name`, so `object->Get` walks the prototype chain and runs the subclass getter. The baseline read (1) comes from V8 building the console message text (`Error.prototype.toString`) even without a client; the extra reads come from `descriptionForError` (description + preview). rebrowser-bot-detector's threshold is `nameGetterCount / rounds > 1.5` (averaged over rounds) or `prepareStackTraceCount > 0`.
- The Proxy-prototype `ownKeys` channel reported by svebaa (tested on a March 2026 content_shell) did not fire on Chrome 155: current `debug-property-iterator.cc` skips proxies in the prototype chain (`AdvanceIgnoringProxies(); while (... IsJSProxy(...)) AdvanceIgnoringProxies();`) and collects keys `kOwnOnly` per prototype. Treat as closed on ≥155 (exact closing commit not identified; "[inspector] Prevent synchronous JS execution during Map/Set entry preview", 2026-07-10, is in the same area). [uncertain which commit]

What the event carries (chrome155, `Runtime.consoleAPICalled` for the probes): `type:"debug"`, arg `{type:"object", subtype:"error", className:"Error"|"LeakErr", description:"LeakErr: probeC\n    at <anonymous>:15:17\n    at <anonymous>:47:3", preview.properties: ["stack","message"]}`. 18 events were emitted for the 18 console calls of one probe round — i.e. the serialization cost scales with page logging, which also makes "console-heavy" probes cheap to hide inside normal logging.

### 2.4 Which stacks trigger it (Oct 2026)

| Stack | Sends `Runtime.enable`? | Evidence |
|---|---|---|
| Puppeteer (CDP mode, 25.x) | yes, per frame, plus workers via `Target.setAutoAttach` | `packages/puppeteer-core/src/cdp/FrameManager.ts`: `client.send('Runtime.enable')` |
| Playwright (1.5x–1.64) | yes | `packages/playwright-core/src/server/chromium/crPage.ts` `FrameSession._initialize`: `this._client.send('Runtime.enable', {})` |
| chromium-bidi (WebDriver BiDi on Chrome; Puppeteer BiDi; Selenium/WebdriverIO BiDi) | yes | `src/bidiMapper/modules/cdp/CdpTarget.ts` `#unblock()`: `Page.enable`, `Page.setLifecycleEventsEnabled`, `Runtime.enable`, `Network.enable`, `Target.setAutoAttach`, `Runtime.runIfWaitingForDebugger` |
| chromedriver (classic) | DevToolsClientImpl does **not** send it in `devtools_client_impl.cc`; DataDome/Castle/deviceandbrowserinfo report Selenium flagged by the probe in 2024 (their Selenium test had `navigator.webdriver` removed and still tripped the CDP check) | [likely yes via other classes; not verified in source] |
| Playwright MCP 0.0.83 | yes (playwright 1.64.0-alpha) | `package.json` |
| chrome-devtools-mcp 1.12.0 | yes (puppeteer 25.16.0) | `package.json` |
| Skyvern 1.0.56 | yes (playwright 1.56.0) | `pyproject.toml`, `skyvern/webeye/browser_factory.py` |
| Stagehand 4.3.0 SDK | unknown: `@browserbasehq/stagehand` has no playwright/puppeteer dependency; browser control moved behind a protocol/server (packages: `cli, docs, evals, examples, extension, integrations, protocol, sdk-python, sdk-ts`) | [uncertain] |
| browser-use 0.13.13 | **no** (`cdp-use==1.4.5`; no `Runtime.enable` in `browser/session.py`, `browser/session_manager.py`, `dom/service.py`, `watchdogs/{dom,default_action,aboutblank}_watchdog.py`) | source |
| rebrowser-patches (Puppeteer 25.14 / Playwright 1.64.1) | no (`addBinding` default mode; `alwaysIsolated`; `enableDisable` = brief window) | README |
| Patchright | no ("executing Javascript in (isolated) ExecutionContexts"; also disables Console API) | README |
| nodriver / Selenium-Driverless | no (by design; DataDome names them) | READMEs |
| Chrome DevTools UI open | yes (plus `Debugger.enable`) | all sources; measured `debugger;` pause |
| `chrome.debugger` extension agents | only if the extension calls `Runtime.enable` itself | [unknown per product] |

Rebrowser's `enableDisable` mode and any "enable, read contexts, disable" approach leaves a race window: the leak fires only for console calls made while enabled (confirmed: after `Runtime.disable` all counters return to baseline).

Workers: Puppeteer/Playwright auto-attach dedicated workers with `waitForDebuggerOnStart:true` and enable Runtime in the worker session. Measured: with that setup the worker's `prepareStackTrace` probe hit 1 and inherited-name count 3; without a worker session 0/1. A detector should therefore run the same probe inside a Blob worker (deviceandbrowserinfo lists `isAutomatedWithCDPInWebWorker`). rebrowser's `alwaysIsolated` mode cannot touch workers ("web workers don't allow creating new worlds").

### 2.5 Reliability, false positives, bypass

- FP: open DevTools (rebrowser's estimate "<0.1%" of visitors), console-inspecting extensions, and bots that deliberately launch with `--auto-open-devtools-for-tabs` to look like developers (DataDome). Disambiguation: DevTools also enables `Debugger`, so time a `debugger;` statement (measured 0 ms without Debugger domain; blocks until `Debugger.resume` once enabled — 507 ms in my run; Brotector classifies `time > 180 ms` as `devtools`). Automation libraries almost never enable `Debugger` (Puppeteer/Playwright do not in normal operation; Playwright `page.pause()` does).
- Bypass: every serious stealth stack removes `Runtime.enable`; the signal now mostly catches stock Puppeteer/Playwright/BiDi and AI-agent products built on them (Playwright MCP, chrome-devtools-mcp, Skyvern, most LangChain/LlamaIndex "browser tools").
- Cost: essentially free; run several rounds (rebrowser: every 100 ms for the first 10 s, then every 1 s) because the automation may enable Runtime later (new frame, reattach) and enable/disable modes have windows.

Recommended composite probe (page-side; returns `{cdp, devtoolsLikely}`):

```js
function cdpConsoleProbe() {
  let pst = 0, nameReads = 0, legacyStack = 0;
  const e1 = new Error('p');                                   // prepareStackTrace channel (Chrome ≥138 and older)
  const prev = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
  Error.prepareStackTrace = (err, frames) => { if (err === e1) pst++; return 'x'; };
  console.debug(e1);
  prev ? Object.defineProperty(Error, 'prepareStackTrace', prev) : delete Error.prepareStackTrace;
  class N extends Error { get name() { nameReads++; return 'N'; } }   // inherited getter channel
  console.debug(new N('p'));
  const e2 = new Error('p');                                   // legacy channel (Chrome ≤137, Firefox N/A)
  Object.defineProperty(e2, 'stack', { get() { legacyStack++; return ''; }, configurable: true });
  console.debug(e2);
  const t0 = performance.now(); debugger; const dbg = performance.now() - t0;   // DevTools disambiguation
  return { cdp: pst > 0 || nameReads > 1 || legacyStack > 0, devtoolsLikely: dbg > 100 };
}
```
Run it in the main thread and in a Blob worker (drop the `debugger;` line in the worker, or keep it — a paused worker is also a signal).

---

## 3. Stack-trace markers of automation-invoked code

### 3.1 What V8 prints (measured, Chrome 155; file `stack_frames_chrome155.txt`)

A page hooked `document.querySelector` and recorded `new Error().stack` for each caller:

| Caller | Second frame as printed |
|---|---|
| inline `<script>` in the document | `at http://127.0.0.1:61764/stack:3:18` |
| function in external `app.js` | `at pageCaller (http://127.0.0.1:61764/app.js:8:41)` |
| `new Function("…")` in app.js | `at eval (eval at <anonymous> (http://127.0.0.1:61764/app.js:10:33), <anonymous>:3:17)` |
| `eval("…")` in app.js | `at eval (eval at window.triggerFromEval (http://127.0.0.1:61764/app.js:11:47), <anonymous>:1:10)` |
| `setTimeout("string", 0)` | `at <anonymous>:1:10`  ← indistinguishable from CDP by text |
| `<script src="blob:…">` | `at blob:http://127.0.0.1:61764/b071ff49-…:1:10` |
| `<script src="data:text/javascript,…">` | `at data:text/javascript,document.querySelector("%23p6"):1:10` |
| CDP `Runtime.evaluate` (no sourceURL) | `at <anonymous>:1:10` |
| CDP `Runtime.evaluate` + `//# sourceURL=pptr:evaluate;Page.evaluate` | `at pptr:evaluate;Page.evaluate:1:10` |
| CDP + `//# sourceURL=__puppeteer_evaluation_script__` | `at __puppeteer_evaluation_script__:1:10` |
| CDP `Runtime.callFunctionOn` | `at <anonymous>:1:30` |
| Playwright-shaped wrapper `(utilityScript, ...args) => utilityScript.evaluate(...args)` | `at <anonymous>:1:109` / `at Object.evaluate (<anonymous>:1:85)` / `at <anonymous>:1:44` (real Playwright: `UtilityScript.evaluate`) |
| CDP in an isolated world (`Page.createIsolatedWorld`) | hook never called (main-world override invisible) |
| CDP `DOM.querySelector` (no JS) | hook never called |

Structured view via `Error.prepareStackTrace = (e, callsites) => callsites.map(...)`: CDP frames have `getFunctionName() === null`, `getFileName() === ""`, `getScriptNameOrSourceURL() === ""`, `isEval() === false`, `getScriptHash() === ""`; `new Function`/`eval` frames have `isEval() === true`, an `getEvalOrigin()` string and a 64-hex `getScriptHash()`. `setTimeout("string")` code is the one page-origin construct that also yields an empty-filename, non-eval frame — rare in modern sites but real (legacy ad/analytics code), so weight accordingly or require the hooked call to occur outside timer callbacks.

### 3.2 Library-specific markers (source)

- Puppeteer ≥ 20 (`packages/puppeteer-core/src/common/util.ts`): `PuppeteerURL.INTERNAL_URL = 'pptr:internal'`; serialized as ``pptr:${functionName};${encodeURIComponent(siteString)}``; `getSourceUrlComment(url)` returns ``//# sourceURL=${url}``; `SOURCE_URL_REGEX = /^[\x20\t]*\/\/[@#] sourceURL=\s{0,10}(\S*?)\s{0,10}$/m` (existing sourceURL comments in user functions are respected). Utility world name: `UTILITY_WORLD_NAME = '__puppeteer_utility_world__' + packageVersion` (used for `Page.createIsolatedWorld` and `Page.addScriptToEvaluateOnNewDocument {worldName}`). Legacy (v13 `src/common/ExecutionContext.ts`): `EVALUATION_SCRIPT_URL = '__puppeteer_evaluation_script__'`, appended as `expression + '\n' + '//# sourceURL=__puppeteer_evaluation_script__'`; pyppeteer: `__pyppeteer_evaluation_script__` (Brotector regex).
- Playwright: class `UtilityScript` (`packages/injected/src/utilityScript.ts`, methods `evaluate`, `jsonValue`); `packages/playwright-core/src/server/javascript.ts` builds ``(utilityScript, ...args) => utilityScript.evaluate(...args)`` with no sourceURL; utility world `__playwright_utility_world_${guid}` (crPage, `createIsolatedWorld` with the misspelled `grantUniveralAccess: true`); binding `PageBinding.kBindingName = '__playwright__binding__'`; `window.__pwSnapshotGlobals` when `noUtilityWorld` (Firefox/WebKit paths). rebrowser-patches: renames `UtilityScript` to a random per-process name and shifts its line numbers; removes Puppeteer's sourceURL (frames become `<anonymous>`); utility world name becomes `util` (`REBROWSER_PATCHES_UTILITY_WORLD_NAME`).
- puppeteer-extra-plugin-stealth `sourceurl` evasion only strips `//# sourceURL=__puppeteer_evaluation_script__` from `Runtime.evaluate.expression` and `Runtime.callFunctionOn.functionDeclaration` ("It can be used to identify the presence of pptr via stacktraces"). Its Proxy-based overrides leave frames such as Brotector's regex `at newHandler\.<computed> \[as apply\] \((<anonymous>:[0-9]+:[0-9]+|…` in the stack of any hooked native — a tamper tell.
- Detector implementations: rebrowser `sourceUrlLeak` (wraps `document.getElementById`, looks for `pptr:`, `UtilityScript.`, or bare filenames with no URL like `at app.js:4:14` as a soft signal), Brotector `stack.signature` (hooks `HTMLElement.click`, `querySelector(All)`, `Function.prototype.apply`), BotD `errorTrace` (PhantomJS only).
- "VM<n>" naming: scripts without a URL are shown as `VM215`-style ids only in the DevTools UI/profiles; in `Error.stack` text they are `<anonymous>`. Castle's second-CDP-client method (`Debugger.scriptParsed` + `Debugger.getScriptSource`, filtering `VizNullHypothesis`) and the DevTools memory sampling profile (`VM215`, `VM216`) expose `Page.addScriptToEvaluateOnNewDocument` payloads of anti-detect browsers, but that is an operator-side forensic tool, not a page-side signal.

Reliability: medium. Bypass status: stock Puppeteer/Playwright still leak `pptr:`/`UtilityScript`; rebrowser/Patchright/isolated-world stacks remove or hide them; CDP-only agents (browser-use, nodriver) that call `Runtime.callFunctionOn("function(){ this.click(); }")` (browser-use's fallback) show `<anonymous>` frames when a hooked native is involved.

---

## 4. `Page.addScriptToEvaluateOnNewDocument`, bindings and isolated worlds

### 4.1 Artifacts measured

- Main-world init script (`Page.addScriptToEvaluateOnNewDocument {source}`): runs before any page script; functions it defines report `at injectedFn (<anonymous>:1:57)`.
- Isolated-world init script (`{source, worldName}`): its globals are invisible to the page (`typeof window.__necter_iso === 'undefined'`), but it shares the DOM: a `MutationObserver`-based writer set `data-necter-iso="set-from-isolated-world/loading/pageScriptRan=undefined"` on `<html>` while `document.readyState === "loading"` and before the page's own inline script ran. Isolated-world code also sees the same `navigator.webdriver` value.
- `Page.createIsolatedWorld` + `Runtime.evaluate {contextId}`: calling `document.querySelector` from the isolated world did **not** increment a main-world counter installed by overriding `document.querySelector` (0 vs 1 for a main-world call). This is the mechanism behind Patchright's and Playwright-utility-world invisibility to `stack.signature`-style hooks.
- `Runtime.addBinding {name:'__necter_binding'}` (works without `Runtime.enable`): creates `window.__necter_binding` as an own data property `{writable:true, enumerable:true, configurable:true}`; `name === ""`; `Function.prototype.toString` → `function () { [native code] }`. rebrowser-bot-detector's `cdpBindingGlobals` samples `window` for exactly this (empty-name native functions). Playwright uses the fixed name `__playwright__binding__`; rebrowser's `addBinding` fallback "could briefly" expose "a global with a random name".
- Playwright `__pwInitScripts`: the `InitScript` wrapper was

  ```ts
  globalThis.__pwInitScripts = globalThis.__pwInitScripts || {};
  const hasInitScript = globalThis.__pwInitScripts[${JSON.stringify(guid)}];
  if (hasInitScript) return;
  globalThis.__pwInitScripts[${JSON.stringify(guid)}] = true;
  ```
  in v1.46.1 and v1.52.0; in v1.53.0, 1.54.0, 1.55.0, 1.56.0, 1.58.0 and main it is just `(() => { ${source} })();`. Brotector's `PWinitScript` and rebrowser's `pwInitScripts` therefore only catch Playwright 1.46–1.52.
- chromedriver (`chrome/test/chromedriver/chrome/devtools_client_impl.cc`, `SetUpDevTools`), injected with `Page.addScriptToEvaluateOnNewDocument` *and* `Runtime.evaluate` after `Page.enable`:

  ```js
  (function () {
  window.cdc_adoQpoasnfa76pfcZLmcfl_Array = window.Array;
  window.cdc_adoQpoasnfa76pfcZLmcfl_Object = window.Object;
  window.cdc_adoQpoasnfa76pfcZLmcfl_Promise = window.Promise;
  window.cdc_adoQpoasnfa76pfcZLmcfl_Proxy = window.Proxy;
  window.cdc_adoQpoasnfa76pfcZLmcfl_ShadowRoot = window.ShadowRoot;
  window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol = window.Symbol;
  window.cdc_adoQpoasnfa76pfcZLmcfl_JSON = window.JSON;
  window.cdc_adoQpoasnfa76pfcZLmcfl_Window = window.Window;
  }) ();
  ```
  `call_function.js` reads them back (`window.cdc_adoQpoasnfa76pfcZLmcfl_Array || window.Array`) and assigns the implicit global `ret_nodes` (sloppy mode) on every `executeScript`/element interaction (Castle: `window.ret_nodes` appears after `driver.executeScript()`). undetected-chromedriver renames the `cdc_` prefix in the binary; Brotector still regex-scans `/cdc_[a-z0-9]/ig` and BotD matches `/^([a-z]){3}_.*_(Array|Promise|Symbol)$/`. Older Selenium left `document.$cdc_asdjflasutopfhvcZLmcfl_`, `$chrome_asyncScriptInfo`, `__webdriver_evaluate`, `__selenium_evaluate`, `__fxdriver_*`, `__driver_*` (BotD `distinctive_properties.ts`; full list in §10.1).
- `page.exposeFunction()` wrappers: rebrowser `exposeFunctionLeak` reads `toString()` of the exposed function and scans `window` for `puppeteer_` keys, `__playwright__binding__`, or functions with `__installed = true` (Playwright ≤1.59 and Patchright).
- browser-use: no page init scripts; only its `about:blank` "DVD screensaver" via `Runtime.evaluate` (`window.__dvdAnimationRunning`, `#pretty-loading-animation`, logo `https://cf.browser-use.com/logo.svg`, `document.title = "Starting agent <label>..."`) — invisible to third-party sites.

### 4.2 Detecting isolated-world automation

Nothing in the page can enumerate worlds. Observable side effects that survive isolation:

1. Input tells (§6): clicks still arrive via `Input.dispatchMouseEvent` (`pressure 0`, `kFromDebugger` internal flag, integer coordinates, no preceding human-like `mousemove` cadence).
2. Navigation-timing tells when the driver intercepts the document to inject scripts (Patchright README: "Init Scripts … injected by intercepting HTML requests with Playwright Routes … can be detected by timing attacks"). Measured with `Fetch.fulfillRequest`: `performance.getEntriesByType('navigation')[0].nextHopProtocol === ""` (normal: `"http/1.0"`/`"h2"`), `transferSize` stays non-zero (366) — so key on the empty protocol, not on zero bytes (rebrowser `documentInterception` keys on empty protocol + zero bytes + empty `deliveryType` + `workerStart 0`). A service worker or cached document can also produce empty/odd fields — check `deliveryType`/`workerStart` and apply only on cold loads.
3. DOM mutations with no main-world JS activity and no user input (e.g. Playwright's highlight/`scrollIntoViewIfNeeded`, Patchright's closed-shadow-root piercing) — heuristic, unmeasured here [uncertain].
4. Geometry/flags (§9) and `navigator.webdriver` are world-independent.

---

## 5. `debugger` statement timing and DevTools-open detection

- Measured: `(()=>{const t=performance.now(); debugger; return performance.now()-t})()` → `0` ms with no Debugger domain; after `Debugger.enable` the page emitted `Debugger.paused {reason:"other"}` and the statement returned only after `Debugger.resume` (507 ms with a 500 ms delay). DevTools always enables the Debugger domain; Puppeteer/Playwright do not (coverage, `page.pause()` excepted).
- Brotector's `Runtime.enabled` detection combines the console probe with `getDebuggerTiming` (a bare `debugger;` timed in a worker after 200 ms): `type = "devtools"` when `stackLookupCount > 1 && time > 180 && nameLookupCount >= 2`, else `type = "webdriver"`; bare `time > 180` sets `devtools_open`.
- devtools-detect (archived 2026-05-12): `threshold = 170`; `outerWidth - innerWidth > threshold || outerHeight - innerHeight > threshold` (plus `Firebug.chrome.isInitialized`); orientation `vertical` if the width threshold fired. The README admits "Doesn't work if DevTools is undocked", "false positive if you toggle any kind of sidebar", "too many false-positives".
- The classic `console.log(image)` with an `id` getter trick depends on preview/property reads of user getters; after the May 2025 V8 change previews no longer invoke user accessors, so assume it is dead on Chrome ≥138 [uncertain; not re-measured].
- CDP `Inspector.detached` with reason `replaced_with_devtools` is sent to the automation client when a human opens DevTools on an automated tab (crawlex); `chrome.debugger` extensions get `onDetach` with `"canceled_by_user"` when DevTools is invoked for the attached tab (Chrome extension docs).
- Bots deliberately launching with `--auto-open-devtools-for-tabs` to pass "DevTools open ⇒ human developer" heuristics (DataDome 2024): never treat DevTools-open as exculpatory.

---

## 6. CDP-synthesised input (`Input.dispatchMouseEvent`) tells

Chromium `content/browser/devtools/protocol/input_handler.cc`:

```cpp
mouse_event->force = force.value_or(0);          // protocol param 'force' defaults to 0
mouse_event->pointer_type = GetPointerType(pointer_type.value_or(""));   // "pen" or mouse
mouse_event->tangential_pressure = tangential_pressure.value_or(0); tilt_x/tilt_y/twist = 0
int result = blink::WebInputEvent::kFromDebugger;   // every injected event carries this modifier (internal)
mouse_event->SetPositionInWidget(CssPixelsToPointF(x, y, scale_factor));
mouse_event->SetPositionInScreen(mouse_event->PositionInWidget());
// later, OnWidgetForDispatchMouseEvent:
event->SetPositionInScreen(ConvertWidgetPointToScreenPoint(target, point));   // widget point + view_bounds_in_screen.OffsetFromOrigin()
```

Blink `pointer_event_factory.cc`:

```cpp
float GetPointerEventPressure(float force, uint16_t buttons) {
  if (!buttons) return 0;
  if (std::isnan(force)) return 0.5;
  return force;
}
```

Real mouse input: `ui::PointerDetails(EventPointerType::kMouse, id)` delegates with `/* force */ std::numeric_limits<float>::quiet_NaN()` (`ui/events/pointer_details.cc`); `MakeWebMouseEventFromUiEvent` copies `webkit_event.force = event.pointer_details().force` (`ui/events/blink/web_input_event.cc`); `WebPointerProperties::force` default is `quiet_NaN()` ("NaN meaning pressure is not supported by the input device"). The macOS NSEvent builder file (`web_input_event_builders_mac.mm`) was not readable at the expected path; `ui/events/cocoa/events_mac.mm` builds `PointerDetails(EventPointerType::kMouse)` (NaN force) for mouse events.

Measured on chrome155/cft156 headless (listeners on `document`, capture phase), after `mouseMoved(120,80)`, `mouseMoved(135,90)`, `mousePressed`, `mouseReleased`:

```
pointermove  isTrusted:true clientX:120 clientY:80 pageX:120 pageY:80 screenX:142 screenY:189 movementX:0 movementY:0 pointerType:"mouse" pressure:0 width:1 height:1 coalesced:1 sourceCapabilities:null
mousemove    isTrusted:true … screenX:142 screenY:189 movementX:0 sourceCapabilities.firesTouchEvents:false
pointermove  … clientX:135 clientY:90 screenX:157 screenY:199 movementX:15 movementY:10
pointerdown  isTrusted:true clientX:135 clientY:90 screenX:157 screenY:199 buttons:1 pressure:0 width:1 height:1 coalesced:0 sourceCapabilities:null
mousedown    isTrusted:true buttons:1 detail:1
```

Tells and status:

| Tell | Status (Oct 2026) | FP risk |
|---|---|---|
| `pointerdown`/`pointermove` with `buttons !== 0` and `pressure === 0` and `pointerType === 'mouse'` | present for every CDP driver that does not pass `force` (Puppeteer, Playwright, browser-use `_click_on_coordinate` params are `type/x/y/button/clickCount` only, chrome.debugger extensions) | real mouse on Win/Linux/mac gives 0.5 per spec and Chromium source; pen/touch devices report real force; verify a headed baseline per OS before shipping [likely] |
| `screenX === clientX && screenY === clientY` (crbug 1477537) | **fixed** in the full browser (screen = widget + view bounds; measured +22/+109 and +22/+165 with an infobar); still true in chrome-headless-shell (view origin 0,0) and in any window at (0,0) without browser chrome | kiosk/fullscreen users (Brotector resets score when `outerHeight - innerHeight <= 1`); CDP-Patches says the upstream fix shipped around Chrome 142 |
| `isTrusted` | always `true` for CDP input; `false` only for JS-dispatched events (`element.click()`, `dispatchEvent`) — Brotector `Input.untrusted` | none for the `false` case; `true` proves nothing |
| `movementX/Y` | computed normally on Chrome 155 (old headless reported 0 per crawlex) | — |
| `PointerEvent.sourceCapabilities === null` for CDP pointer events while the paired `MouseEvent` has one | observed; real-input baseline not measured | [uncertain] |
| coordinates always integers, identical inter-event timing, straight-line paths, no micro-corrections | behavioral layer (cside, maskbreak) | needs sessions, not single events |
| `Input.synthesizeScrollGesture` (browser-use uses `speed: 50000`) and `mouseWheel` deltas | wheel events with constant deltas; not measured | [uncertain] |

CDP-Patches (kaliiiiiiiiii) works around input tells by dispatching OS-level input (Windows/Linux, headful only) and notes CoalescedEvents are now emitted for CDP input too.

---

## 7. `window.chrome`, `chrome.csi`, `chrome.loadTimes`, `chrome.runtime`

- `chrome/renderer/loadtimes_bindings.cc` still registers `"loadTimes"` and `"csi"` on the object returned by `content::GetOrCreateChromeObject` (TODOs to remove, no deprecation strings). Measured in new headless (chrome155, cft156): `Object.keys(window.chrome)` → `["loadTimes","csi","app"]`; `chrome.runtime` → `undefined` on an `http://127.0.0.1` page; `Function.prototype.toString.call(chrome.csi)` → `function () { [native code] }` (anonymous).
- chrome-headless-shell: `window.chrome` is `undefined` entirely (`ReferenceError: chrome is not defined`) — the HEADCHR_CHROME_OBJ tell is alive for the shell.
- `chrome.runtime` on ordinary web pages exists only when an installed extension exposes messaging to that origin (`externally_connectable`); puppeteer-extra-stealth's `chrome.runtime` evasion mocks `sendMessage`/`connect` "if not available (e.g. when running headless) and on a secure site", which is a lie on most real pages and detectable through `toString`/descriptor checks. Do not treat missing `chrome.runtime` as a bot signal.
- cside notes real Chrome exposes `csi()`, `loadTimes()`, `runtime`; only the first two are reliable.

---

## 8. Permissions API consistency

- New headless (chrome155, cft156, http origin): `Notification.permission === "default"`; `permissions.query` → `prompt` for notifications, geolocation, camera, microphone, clipboard-read, push. Consistent, no tell.
- chrome-headless-shell 156: `Notification.permission === "denied"` while `permissions.query({name:'notifications'}).state === "prompt"` — the impossible pair (BotD `detectNotificationPermissions`: Chrome + `denied` + `prompt` ⇒ `headless_chrome`; rebrowser `headless` rating 1).
- puppeteer-extra-stealth `navigator.permissions` evasion: forces `Notification.permission` to `'default'` on secure origins and makes `query({name:'notifications'})` resolve `denied` on insecure origins (comments: "In headful on secure origins the permission should be "default", not "denied""; "On insecure origins in headful the state is "denied", whereas in headless it's "prompt""). The patched `Permissions.prototype.query` is a Proxy → `nativeTampering` catches it.
- FP: a user who denied notifications shows `denied`/`denied` (consistent). Insecure origins and `data:`/sandboxed iframes have their own semantics; only flag the specific `denied` + `prompt` combination.

---

## 9. New headless (Chrome 130–156) tells, measured

### 9.1 History and builds

- Chrome 96: new headless behind `--headless=chrome`; 109: `--headless=new`; 112: officially supported ("Chrome creates, but doesn't display, any platform windows"); 128: plain `--headless` means new headless; 132.0.6793.0: old implementation removed from the Chrome binary ("As of M132, headless shell functionality is no longer part of the Chrome binary, so --headless=old has no effect"), surviving as the separate `chrome-headless-shell` (downloadable since M118/120). Puppeteer: `headless: true` = new, `headless: 'shell'` = old; Playwright ships `chromium-headless-shell` separately and uses it for headless runs by default; Selenium ≥4.10 removed `setHeadless()`.
- Today's downloads: Puppeteer and Playwright both fetch "Google Chrome for Testing" (Playwright's `chromium-1248` directory contains `Google Chrome for Testing.app`). CfT is Chromium-branded in client hints (`GetUserAgentBrandList` only adds the product brand `#if !BUILDFLAG(CHROMIUM_BRANDING)`): measured brands `[{"brand":"Not:A-Brand","version":"8"},{"brand":"Chromium","version":"156"}]`, `fullVersionList` likewise; Google Chrome stable headless: `Google Chrome 155`, `Chromium 155`, `Not(A:Brand 24`. rebrowser's `useragent` test: `Chromium` present but `Google Chrome` absent ⇒ "You might be using Google Chrome for Testing which is a red flag", then it compares the `Google Chrome` full version with chromiumdash Stable to flag non-stable channels.
- UA string: `GetUserAgentInternal` does `product.insert(0, "Headless")` when `--headless` is present, so new headless still sends `HeadlessChrome/155.0.0.0` (reduced minor version). chrome-headless-shell sends the **full** version `HeadlessChrome/156.0.8078.47` and adds a `HeadlessChrome` brand (`"Not:A-Brand";v="8", "Chromium";v="156", "HeadlessChrome";v="156"`) in `navigator.userAgentData` and `Sec-CH-UA` (deviceandbrowserinfo 2024 example: `"Not/A)Brand";v="8", "Chromium";v="126", "HeadlessChrome";v="126"`). `page.setUserAgent()` fixes the UA string but not the headers/brands unless metadata is also set (§10.3).

### 9.2 Full measured table (defaults unless noted)

| Property | Google Chrome 155 `--headless` | CfT 156 `--headless` | chrome-headless-shell 156 |
|---|---|---|---|
| `navigator.userAgent` | `… HeadlessChrome/155.0.0.0 Safari/537.36` | `… HeadlessChrome/156.0.0.0 …` | `… HeadlessChrome/156.0.8078.47 …` |
| `userAgentData.brands` | Google Chrome, Chromium, Not(A:Brand | Not:A-Brand, Chromium | Not:A-Brand, Chromium, **HeadlessChrome** |
| `getHighEntropyValues` | `architecture:"arm", bitness:"64", platform:"macOS", platformVersion:"26.6.2", formFactors:["Desktop"], uaFullVersion:"155.0.8059.86"` | same shape, Chromium-only lists | same shape, HeadlessChrome in lists |
| `navigator.webdriver` | `true` | `true` | `true` |
| `navigator.languages` | `["en-US","en"]` | **`["en-US"]`** | `["en-US"]` |
| `navigator.platform` / `vendor` / `productSub` | `MacIntel` / `Google Inc.` / `20030107` | same | same |
| `hardwareConcurrency` / `deviceMemory` | 18 / 32 (host) | 18 / 32 | 18 / 32 |
| `navigator.connection` | `{rtt:50, downlink:1.55, effectiveType:"4g"}` | `{rtt:100, downlink:1.7}` | **`{rtt:0, downlink:9.2}`** |
| `Intl` timezone / offset | `America/New_York` / 240 (host) | same | same |
| `innerWidth x innerHeight` | 756 x 469 | 756 x **413** (CfT infobar; 469 with `--disable-infobars`) | 800 x 600 |
| `outerWidth x outerHeight` | 756 x 556 | 756 x 556 | 800 x 600 |
| `screenX, screenY` | 22, 22 | 22, 22 | 0, 0 |
| `screen.width x height`, `availWidth x availHeight`, `availTop/Left` | 800 x 600, 800 x 600, 0/0 | same | same |
| `devicePixelRatio` / `colorDepth` | 1 / 24 | 1 / 24 | 1 / 24 |
| `screen.isExtended` / orientation | false / `landscape-primary` | same | same |
| `document.hasFocus()` at load | **false** (true after the first CDP click) | false | true |
| `visibilityState` | visible | visible | visible |
| `window.chrome` keys | `loadTimes, csi, app`; `runtime` undefined | same | **`window.chrome` undefined** |
| `Notification.permission` / query | `default` / `prompt` | `default` / `prompt` | **`denied` / `prompt`** |
| `plugins.length` / names / `mimeTypes.length` / `pdfViewerEnabled` | 5 (`PDF Viewer, Chrome PDF Viewer, Chromium PDF Viewer, Microsoft Edge PDF Viewer, WebKit built-in PDF`) / 2 / true | same | **0 / 0 / false** |
| `matchMedia any-pointer / any-hover / pointer` | fine / hover / fine | same | same |
| `prefers-color-scheme: dark` | true (host setting) | true | false |
| WebGL unmasked vendor / renderer | `Google Inc. (Apple)` / `ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Unspecified Version)`, MAX_TEXTURE_SIZE 16384, 39 extensions | same | `Google Inc. (Google)` / `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver)`, 8192, 35 |
| WebGL with `--disable-gpu` | **no WebGL/WebGL2 context at all** | n/m | n/a |
| WebGL with `--disable-gpu --enable-unsafe-swiftshader` | SwiftShader string as in the shell column | n/m | n/a |
| WebGPU adapter (`navigator.gpu.requestAdapter`) | `{vendor:"apple", architecture:"metal-3"}` | same | **null adapter** (also null with `--disable-gpu` on Chrome) |
| `AudioContext` | `state:"suspended", sampleRate:48000, baseLatency:0.005333, outputLatency:0, maxChannelCount:2` | same | same |
| `speechSynthesis.getVoices()` after `voiceschanged` | first non-empty list = 19 Google (network) voices, 0 local (timing artefact; local voices arrive later) | 180 local (`Samantha|en-US|true` …), **0 Google voices** | 180 local, 0 Google |
| `enumerateDevices()` (no permission) | `audioinput, videoinput, audiooutput` with empty label and deviceId | same | same |
| `getBattery()` | real laptop values (`charging:true, level:0.97`) | same | same |
| `requestAnimationFrame` deltas (40 frames) | min 16.5–16.6, median 16.7, max 16.8 ms (synthetic 60 Hz) | same | same |
| `setTimeout(0)` | 0.1 ms | same | same |
| `performance.now()` min delta | 0.1 ms | same | same |
| `canPlayType` h264 / hevc / aac / mp3 / vp9 ; `MediaSource.isTypeSupported(avc1)` | probably / probably / probably / probably / probably ; true | same (CfT ships proprietary codecs) | **hevc `""`**, rest probably |
| fonts present (canvas measure) | Arial, Helvetica Neue, Menlo, Monaco, Tahoma, Times New Roman, PingFang SC, Hiragino Sans, Courier New, Verdana, Georgia (host macOS set) | same | same |
| `window.open()` without gesture | blocked | blocked | **opens** |
| `history.replaceState` x300 | 200 applied (`location.hash === "#f200"`, no exception) | 200 | 200 |
| `SharedArrayBuffer` / `crossOriginIsolated` | undefined / false | same | same |

n/m = not measured. Host-dependent values (CPU count, memory, timezone, battery, fonts, color scheme, WebGL on a GPU host) are the same as headed Chrome on the same machine; they become tells only in containers (Linux fonts such as DejaVu/Liberation under a Windows/mac UA, `timeZone === "UTC"`, `hardwareConcurrency` 2–4, `deviceMemory` ≤ 8, `getBattery` `charging:true, level:1`, no `speechSynthesis` voices on Linux without speech-dispatcher, empty `enumerateDevices()` — all [likely], not measured here).

### 9.3 Geometry tells (new headless) and their mechanics

Measured on chrome155:

| Launch / CDP state | inner | outer | screen | screenX/Y |
|---|---|---|---|---|
| default | 756x469 | 756x556 | 800x600 | 22,22 |
| `--enable-automation` (infobar) | 756x**413** | 756x556 | 800x600 | 22,22 |
| `--disable-blink-features=AutomationControlled` (bad-flags infobar) | **413** high | 556 | 800x600 | 22,22 |
| `--window-size=1920,1080` | 1920x993 | 1920x1080 | **800x600** | 22,22 |
| `--window-size=1366,768 --disable-blink-features=…` | 1366x625 | 1366x768 | 800x600 | 22,22 |
| `Emulation.setDeviceMetricsOverride {1280x720}` (Playwright default viewport) | **1280x720** | 756x556 | 800x600 | 22,22 |
| same with `screenWidth:1920, screenHeight:1080` | 1280x720 | 756x556 | 1920x1080 | 22,22 |
| chrome-headless-shell default | 800x600 | 800x600 | 800x600 | 0,0 |
| chrome-headless-shell + override 1280x720 | 1280x720 | 1280x720 | 800x600 | 0,0 |

Derived checks (cheap, world-independent):

- `innerWidth > outerWidth || innerHeight > outerHeight` ⇒ viewport emulation over a smaller window (Puppeteer `defaultViewport` 800x600 on the 756x556 window; Playwright 1280x720). Real browsers never do this.
- `outerWidth > screen.width || outerHeight > screen.height || innerWidth > screen.availWidth` ⇒ `--window-size` larger than the 800x600 default headless screen (no `--screen-info`), or emulation without `screenWidth/Height`. Real multi-monitor setups can exceed `screen.*` of the current screen only slightly; treat ≥ 2x as hard.
- `screen.width === 800 && screen.height === 600` ⇒ new or old headless default screen (deviceandbrowserinfo `hasHeadlessChromeDefaultScreenResolution`, rebrowser rating 0.5).
- `outerHeight - innerHeight` is **87** on macOS new headless (a fake title-bar/toolbar height) and **143** with one infobar; `outerWidth - innerWidth === 0`. puppeteer-extra's `window.outerdimensions` evasion hard-codes `outerHeight = innerHeight + 85` ("probably OS and WM dependent") — a constant 85/87 across sessions is itself a weak fingerprint. On a real macOS Chrome the delta is roughly 85–130 depending on bookmarks bar [uncertain; not measured].
- Infobars shift the content area by 56 CSS px: `outerHeight - innerHeight` jumps, `screenY - clientY` offset grows (189 → 245 in the CDP input test) and a `resize` event fires without `outerHeight` changing. This is how a page can notice the "Chrome is being controlled by automated test software" bar, Chrome for Testing's bar, the bad-flags bar, or an extension's "started debugging this browser" bar appearing mid-session (§12).
- `screenX === 22 && screenY === 22` with an 800x600 screen is the macOS new-headless default placement [measured on macOS only; Linux/Windows values unknown].
- `document.hasFocus() === false` with `visibilityState === "visible"` on a fresh page: Puppeteer headless until the first click; Playwright hides it with `Emulation.setFocusEmulationEnabled` (in `_initialize`). Weak (background tabs of humans).

### 9.4 Rendering / media tells

- SwiftShader strings seen in the wild: `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)` (x86, deviceandbrowserinfo/crawlex), `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver)` (arm64 macOS, measured), `Google SwiftShader`, `llvmpipe` (Mesa software), `ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0)` (Windows VMs). BotD's legacy check: vendor `Brian Paul` + renderer `Mesa OffScreen`. rebrowser rates SwiftShader on Chrome ≥138 at 0.5. Vendor string for SwiftShader is `Google Inc. (Google)`.
- Chrome 155 with `--disable-gpu` (common in Docker recipes) has **no WebGL** unless `--enable-unsafe-swiftshader` is passed; Playwright passes it (chromiumSwitches "enable unsafe SwiftShader"), Puppeteer does not. "Desktop Chrome, no WebGL" is therefore a strong tell for Puppeteer-in-Docker, and "SwiftShader renderer" for Playwright-in-Docker. GPU-less hosts also return `requestAdapter() === null` for WebGPU while real desktop Chrome (and headless on a GPU host) returns an adapter — cross-check `WEBGL_debug_renderer_info` with `GPUAdapterInfo` (deviceandbrowserinfo `hasInconsistentGPUFeatures`).
- Canvas/text rasterization differs between software and GPU paths (DataDome/thebrowserlayer: "a few differing dots near circle borders"); keep canvas hashes as a *consistency* input (hash vs claimed GPU), not a bot flag.
- `AudioContext.outputLatency === 0` and `state === "suspended"` in headless: outputLatency is 0 on headless; on headed macOS it is normally non-zero [uncertain, not measured].
- rAF cadence: headless uses a synthetic 60 Hz BeginFrame source regardless of the real display (this Mac drives a 120 Hz-capable panel); jitter < 0.3 ms across 40 frames. Headed Chrome follows the real vsync (60/120/144 Hz) with more jitter; maskbreak calls the headless cadence "software-generated". Weak but cheap: `median ≈ 16.67 && max - min < 0.5 ms` after warm-up. [likely]
- Speech voices: Google Chrome includes Google network voices (`Google US English` etc.); CfT/Chromium builds have none (deviceandbrowserinfo: `numGoogleVoices` 0 vs 19). Combine with brands (Chromium-only) as a "not Google Chrome" fingerprint. Always wait for `voiceschanged` before counting.
- Codecs: `canPlayType('video/mp4; codecs="hvc1…"')` is `""` in chrome-headless-shell and in stock Chromium builds; CfT reports `probably`. crawlex: proprietary codecs (H.264/HEVC/AAC/xHE-AAC) are a build-flag property (`proprietary_codecs`, `ffmpeg_branding`), so "Chrome UA + no H.264" ⇒ Chromium build.

### 9.5 Launch flags that are page-visible

| Flag | Who passes it | Page-visible effect (measured) |
|---|---|---|
| `--enable-automation` | Puppeteer `defaultArgs`, chromedriver; Playwright stopped in 1.64 (rebrowser) | `navigator.webdriver` true; infobar `IDS_CONTROLLED_BY_AUTOMATION` ("Chrome is being controlled by automated test software", no buttons, `ShouldExpire() false`); 56 px `innerHeight` loss even in headless |
| `--headless` | all headless | `webdriver` true, `HeadlessChrome` UA, geometry above |
| `--remote-debugging-pipe` / `--remote-debugging-port=0` | Playwright (pipe), Puppeteer (pipe or port 0), chromedriver (port 0) | `webdriver` true even headed |
| `--disable-blink-features=AutomationControlled` | browser-use, Skyvern, rebrowser, Patchright, most stealth recipes | `webdriver` false; bad-flags infobar (56 px) |
| `--disable-popup-blocking` | Puppeteer, Playwright | `window.open()` without gesture returns a window (rebrowser `popupBlocking`) |
| `--disable-ipc-flooding-protection` | Puppeteer, Playwright | 300/300 `replaceState` calls applied (`#f300`) vs 200 cap (rebrowser `ipcFloodingProtection`) |
| `--disable-features=…ThirdPartyStoragePartitioning…` | Playwright | nested cross-site iframe can read top-level `localStorage` (rebrowser `storagePartitioning`, Chromium ≥148 on specific domains) |
| `--enable-unsafe-swiftshader` | Playwright | SwiftShader WebGL instead of no WebGL on GPU-less hosts |
| `--disable-infobars` | Playwright (for CfT) | hides CfT's infobar (469 vs 413 px) |
| `--no-sandbox`, `--disable-web-security`, `--ignore-certificate-errors`, `--disable-gpu-sandbox`, `--disable-setuid-sandbox` | browser-use Docker args, Skyvern `disable_security`, many containers | bad-flags infobar (first match only) |
| `--window-size=W,H` without `--screen-info` | browser-use (`window_size` or `--start-maximized`), Skyvern `--start-maximized` | `outer > screen` (800x600) |
| `--mute-audio`, `--hide-scrollbars` | Puppeteer headless | scrollbar width 0 in `innerWidth - document.documentElement.clientWidth` on overflowing pages [uncertain, not measured] |
| `--force-color-profile=srgb`, `--font-render-hinting=none`, `--deterministic-mode` | Puppeteer (srgb), browser-use deterministic rendering (opt-in) | `color-gamut` srgb only; canvas/text hash shifts |

---

## 10. Tamper / lie detection (how to catch stealth overrides)

### 10.1 Open detector inventories (what each tests)

**BotD 1.9.1** (`@fingerprintjs/botd`, MIT; `detectors/*`, verdicts): `appVersion` `/headless/i|/electron/i|/slimerjs/i`; `documentAttributes` on `<html>` containing `selenium|webdriver|driver` ⇒ selenium; `errorTrace` (`null[0]()` stack `/PhantomJS/i`); `evalLength` (`eval.toString().length` 33/37/39 vs engine ⇒ unknown); `functionBind` missing ⇒ phantomjs; `languagesLengthInconsistency` (`navigator.languages.length === 0` ⇒ headless_chrome); `notificationPermissions` (Chrome && `denied` && query `prompt` ⇒ headless_chrome); `pluginsArray` (not `PluginArray` ⇒ headless_chrome); `pluginsLengthInconsistency` (desktop Chromium && 0 plugins ⇒ headless_chrome); `process` (`window.process.type === 'renderer'` or `process.versions.electron` ⇒ electron); `userAgent` `/PhantomJS/i|/Headless/i|/Electron/i|/slimerjs/i`; `webDriver` (`navigator.webdriver` truthy ⇒ headless_chrome); `webGL` (vendor `Brian Paul` + renderer `Mesa OffScreen`); `windowExternal` (`window.external.toString()` `/Sequentum/i`); `windowSize` (`document.hasFocus()` && `outerWidth === 0 && outerHeight === 0` ⇒ headless_chrome — old headless only); `mimeTypesConsistent`, `productSub` (`20030107` for Chrome/Safari/Opera/WeChat); `distinctiveProperties`: window `awesomium`, `RunPerfTest`, `CefSharp`, `emit`, `fmget_targets`, `geb`, `__nightmare`/`nightmare`, `__phantomas`, `callPhantom`/`_phantom`, `spawn`, `_Selenium_IDE_Recorder`/`_selenium`/`calledSelenium`/`/^([a-z]){3}_.*_(Array|Promise|Symbol)$/`, `wdioElectron`, `webdriver`/`__webdriverFunc`/`__lastWatirAlert`/`__lastWatirConfirm`/`__lastWatirPrompt`/`_WEBDRIVER_ELEM_CACHE`/`ChromeDriverw`, `domAutomation`/`domAutomationController`; document `__selenium_evaluate`, `selenium-evaluate`, `__selenium_unwrapped`, `$cdc_asdjflasutopfhvcZLmcf`, `$cdc_asdjflasutopfhvcZLmcfl_`, `$chrome_asyncScriptInfo`, `__$webdriverAsyncExecutor`, `__webdriver_evaluate` and the `__driver`/`__fxdriver` family. `rtt` is collected (`navigator.connection.rtt`) but no detector uses it in 1.9.1.

**rebrowser-bot-detector** (bot-detector.rebrowser.net): `runtimeEnableLeak`, `sourceUrlLeak`, `mainWorldExecution` (hooks `document.getElementsByClassName`; any call from the main world is logged), `window.dummyFn`, `navigatorWebdriver`, `useragent` (CfT / non-stable), `pwInitScripts`, `viewport` (800x600 Puppeteer, 1280x720 Playwright, yellow), `bypassCsp`, `headless` (HeadlessChrome UA/brand; missing `window.chrome`; `denied`+`prompt`; `any-pointer: none` only; 800x600 screen; SwiftShader on ≥138), `popupBlocking`, `ipcFloodingProtection`, `storagePartitioning`, `platformMismatch` (UA OS vs `navigator.platform` vs `userAgentData.platform`; empty brands after `setUserAgent`; Chromium version mismatch; CSS `ActiveText` colour `rgb(0, 102, 204)` on Windows), `workerConsistency` (userAgent/platform/brands strong; languages/hardwareConcurrency soft), `nativeTampering` (Proxy wrappers, patched `Function.prototype.toString`, cyclic `__proto__`, own props on `navigator`, non-native getter `toString` for `Navigator.userAgent`/`Permissions.query`, automation frames in thrown errors, `srcdoc` iframe returning the parent's `Navigator`), `mobileEmulation` (`maxTouchPoints 1` + desktop platform + Chromium engine behind an iPhone UA), `documentInterception`, `exposeFunctionLeak`, `cdpBindingGlobals`.

**Brotector** (kaliiiiiiiiii): `navigator.webdriver`; `Runtime.enabled` (webdriver vs devtools by debugger timing); `Input.cordinatesLeak` (`pageX == screenX && pageY == screenY`, score 1, reset in fullscreen, 0.5 on touch); `window.cdc` (`/cdc_[a-z0-9]/ig` over `window`); `Input.untrusted` (`isTrusted === false`); `canvasMouseVisualizer` (full-page canvas with `pointer-events` pass-through drawing arcs at the cursor — bot visualizers); `UA_Override` (`getHighEntropyValues` all-empty, score 0.9); `SeleniumScriptInjection` (hooks `Function.prototype.apply`, matches `"WebDriver", "W3C", "Execute-Script", "cdc_adoQpoasnfa76pfcZLmcfl", "Chromium", "shadow-6066-11e4-a52e-4f735466cecf"` in the callee source; can crash chromedriver frameworks); `PWinitScript` (`__pwInitScripts`, `__playwright__binding__`); `stack.signature` (regexes for `__pyppeteer_evaluation_script__`, `__puppeteer_evaluation_script__`, stealth's `newHandler.<computed> [as apply]`); `pdfStyle` (iframe PDF `<style>` leak under Puppeteer/`--enable-field-trial-config`, "There might be false-positives"); `popupCrash` (crbug 340836884 crash of Playwright/Puppeteer on `window.open` from a data-URL iframe with `top=9999,left=9999,width=1,height=1`). Targets: Selenium (incl. undetected-chromedriver, SeleniumBase), Puppeteer (+stealth, pyppeteer), Playwright (+undetected-playwright, Botright), Driverless, Nodriver, @ulixee/hero.

**CreepJS lie engine** (`src/lies/index.ts`): walks prototypes of browser APIs (`searchLies`) and for each function/getter (`queryLies`) records: `failed illegal error` (getter called on prototype must throw `TypeError`), `failed undefined properties` (own descriptors on `screen`/`navigator` instances), `failed call/apply interface error`, `failed new instance error`, `failed class extends error`, `failed null conversion error` (`Object.setPrototypeOf(fn, null).toString()`), `failed toString` (native-code string of `fn` and `fn.toString` against known forms, compared via `scope.Function.prototype.toString` from a hidden "phantom" iframe realm, nested twice on Blink), `failed "prototype" in function`, `failed descriptor` / `failed own property` (`arguments, caller, prototype, toString`), `failed descriptor keys` / `own property names` / `own keys names` (must be exactly `length,name`), `failed object toString error` (stack line `at Function.toString` vs `at Object.toString` for `Object.create(new Proxy(fn, {}))`), `failed at incompatible proxy error` (strict-mode `arguments`/`caller` message, Gecko), `failed at too much recursion error`, and the Proxy/prototype-chain cycle battery (`failed at too much recursion __proto__ error`, `chain cycle error`, `chain cycle __proto__ error`, `reflect set proto`, `reflect set proto proxy`, `instanceof check error`, `define properties`). Hidden iframe: `left:-10000px; visibility:hidden`, window taken from `self[numberOfIframes]`.

**deviceandbrowserinfo "Are you a bot"** (22 signals): `hasBotUserAgent`, `hasWebdriverTrue`, `hasWebdriverInFrameTrue`, `isPlaywright` (Playwright globals), `hasInconsistentChromeObject`, `isPhantom`, `isNightmare`, `isSequentum`, `isSeleniumChromeDefault` (`document.$cdc_…`), `isHeadlessChrome`, `isWebGLInconsistent`, `hasInconsistentWebGLShaderLang` (`WEBGL_debug_shaders` vs claimed backend), `hasInconsistentTimingResolution`, `isAutomatedWithCDP`, `isAutomatedWithCDPInWebWorker`, `hasInconsistentClientHints`, `hasInconsistentGPUFeatures` (WebGL vs WebGPU), `isIframeOverridden` (`contentWindow` proxies), `hasInconsistentWorkerValues`, `hasHighHardwareConcurrency`, `hasHeadlessChromeDefaultScreenResolution` (800x600), `hasSuspiciousWeakSignals`; plus a behavioral page (mouse/typing/"CDP mouse leak").

**sannysoft** (bot.sannysoft.com): Intoli tests `User Agent (Old)`, `WebDriver (New)`, `WebDriver Advanced`, `Chrome (New)`, `Permissions (New)`, `Plugins Length (Old)`, `Plugins is of type PluginArray`, `Languages (Old)`, `WebGL Vendor`, `WebGL Renderer`, `Broken Image Dimensions`, plus fp-collect dumps and five canvas variants (including sandboxed iframes). **browserscan** groups: Webdriver, User-Agent, CDP ("Detectable use of developer tools to simulate browsers"), Navigator ("Detect whether the Navigator is deceptive"), and a tool list (Selenium, NightmareJS, PhantomJS, Awesomium, Cef, CefSharp, Coachjs, FMiner, Phantomas, Rhino, Webdriverio, Headless Chrome). pixelscan was not readable in this session.

### 10.2 Core tamper primitives (implementation notes)

1. **Native-code string**: `Function.prototype.toString.call(f)` must equal `function name() { [native code] }` with the right name (`get userAgent`, `query`) and the same result through a fresh iframe's `Function.prototype.toString`; `f.toString === Function.prototype.toString`; `Object.getOwnPropertyNames(f)` must be `["length","name"]`; `'prototype' in f` false for methods/getters. Proxies pass `toString` only if the stealth also patches `Function.prototype.toString`, which CreepJS catches with the proxy/prototype cycle battery and `Object.setPrototypeOf(fn, null).toString()`.
2. **Descriptors and placement**: overridden values become own properties (`Object.getOwnPropertyDescriptor(navigator, 'webdriver')`, `Object.keys(navigator)` non-empty) or accessors with JS getters (`descriptor.get.toString()` not native).
3. **Fresh-realm comparison**: create an `<iframe>` (and a `srcdoc` iframe; rebrowser checks for the stealth plugin's `contentWindow` proxy returning the parent's `Navigator`, `iframe.contentWindow.self === window.top` must be false, `frameElement` must be the iframe), compare `navigator.*`, `screen.*`, `WebGL`, `chrome` and `Function.prototype.toString` outputs. Overrides applied via `Page.addScriptToEvaluateOnNewDocument` do run in about:blank/srcdoc child frames in modern Chrome, but many stealth scripts guard on `top === self` or skip frames.
4. **Worker realm**: a Blob worker has no stealth overrides unless the driver injects into workers (rebrowser notes `puppeteer-extra-plugin-stealth` turns `workerConsistency` red). Compare `userAgent`, `platform`, `userAgentData.brands`, `languages`, `hardwareConcurrency`, `deviceMemory` (measured identical in stock builds).
5. **Cross-signal consistency**: UA OS vs `navigator.platform` vs `userAgentData.platform` vs `getHighEntropyValues().platformVersion/architecture/bitness` vs WebGL renderer family (Apple/Metal, Intel/Mesa, NVIDIA/D3D11) vs font set (Segoe UI/Calibri ⇒ Windows; PingFang/Hiragino/Helvetica Neue ⇒ macOS; DejaVu/Liberation/Noto-only ⇒ Linux) vs `Intl` timezone vs `Accept-Language`/`navigator.languages`. Measured: `Emulation.setUserAgentOverride` with a Windows UA leaves `navigator.platform === "MacIntel"`, WebGL `Apple M5 Pro`, no `Segoe UI`.

### 10.3 Client hints after UA override (measured)

- `Emulation.setUserAgentOverride {userAgent}` with no `userAgentMetadata` (what Puppeteer `page.setUserAgent(string)` sends): `navigator.userAgentData.brands` → `[]`, `.platform` → `""`, `getHighEntropyValues([...])` → all empty strings and `brands: []`, `fullVersionList: []`; the UA string and `appVersion` change, `navigator.platform` does not. Brotector `UA_Override` and rebrowser `platformMismatch` key on this. Chrome also stops sending `Sec-CH-UA*` headers in this state [likely; headers not captured here].
- With `userAgentMetadata`: brands/platform/platformVersion are spoofed consistently (Playwright computes metadata when a UA is set), so rely on WebGL/fonts/`navigator.platform`/worker checks instead.

---

## 11. WebDriver BiDi, Firefox (Marionette, Remote Agent, juggler, Camoufox), Safari

- **Chrome BiDi** is implemented by the chromium-bidi mapper on top of CDP; `CdpTarget.#unblock()` sends `Page.enable`, `Page.setInterceptFileChooserDialog`, `Page.getFrameTree`, `Page.setLifecycleEventsEnabled`, `Runtime.enable`, `Network.enable`, `Target.setAutoAttach`, `Runtime.runIfWaitingForDebugger`, then `Emulation.*`/`Network.*` user-context config and `Page.createIsolatedWorld` for sandboxes (hidden helper sandbox named by a UUID). Preload scripts (`script.addPreloadScript`) and channels (`Runtime.addBinding`) live in the script module. So BiDi sessions keep the Runtime.enable family and binding tells; browser launch flags come from the client (Puppeteer/Selenium), so `navigator.webdriver` is true by default. Foil (July 2026) argues BiDi "changes the specific artifacts but not the underlying probe categories".
- **Firefox**: `navigator.webdriver` true whenever Marionette or the Remote Agent runs (`--marionette`, `--remote-debugging-port`); `remote.active-protocols` was removed in Firefox 141 ("WebDriver BiDi is the only available protocol"), i.e. no CDP in Firefox, so no `Runtime.enable` tells. BiDi preload scripts run in sandboxes the page cannot see; Firefox shows a remote-control indicator in the UI (not page-visible) [UI claim uncertain]. Playwright Firefox ("juggler") returns `webdriver === true` by patch, uses a custom build (UA pinned to the bundled Firefox version), and juggler runs its page agent in an isolated world. Camoufox (Firefox fork, Linux-only builds, "under development"): C++-level spoofing of navigator, screen/window, WebGL/WebGL2 parameters, WebGPU presence, audio latency, fonts, voices, media devices, codecs, timezone/locale/Intl per realm (workers too), geolocation from GeoIP, WebRTC SDP/ICE rewriting, touch identity; `navigator.webdriver` false via `playwright/1-leak-fixes.patch`; patches named `debugger-invisible-to-content`, `trusted-automation-events`, `font-list-spoofing`, `audio-context-spoofing`, `webgl-spoofing`, `process-title-environ-leak`, `window-setter-seal`, `screen-spoofing`, `navigator-spoofing`, `media-device-spoofing`, `speech-voices-spoofing`, `webrtc-ip-spoofing`. Admitted tells in its own README: "Camoufox can still be detected", "Some WAFs test SpiderMonkey engine behaviour, which no amount of spoofing turns into Chromium", canvas on a non-host OS "looks like LibreWolf, Tor Browser, or Mullvad Browser", software rendering "looks like a GPU falling back to software rendering", `instantAnimations` "detectable; warns", headless "reports a fine pointer". Detection approach: engine-behaviour probes (JS engine quirks, CSS/layout differences, `Error` message formats, `Intl` output) against a Chrome UA; font-metric and canvas class membership; the Firefox-only automation surface (`webdriver`) is useless against it. [Camoufox detections: likely]
- **WebKit / Safari**: `navigator.webdriver` = `isControlledByAutomation()` (WebKit r217391). safaridriver requires `safaridriver --enable` / "Develop > Allow Remote Automation"; "Automation windows are easy to recognize by their orange Smart Search field"; Safari installs a "glass pane" that "blocks any stray interactions (mouse, keyboard, resizing, and so on)" and lets the user end the session via a dialog; sessions run in isolated Automation windows with a clean profile (WebKit blog 6900). No other page-visible tells documented. Playwright WebKit on Linux/Windows is a WebKitGTK/WPE-style build; its UA is built from `X11; Linux x86_64` + `AppleWebKit/605.1.15 (KHTML, like Gecko) Version/<x> Safari/605.1.15` (WebKit `UserAgentGLib.cpp`), a combination no real Safari produces; `navigator.platform === "Linux x86_64"` with a Safari UA is the simplest server/page check. [likely]

---

## 12. Extension-driven agents and `chrome.debugger`

- Attaching `chrome.debugger` shows a **global** infobar (`ExtensionDevToolsInfoBarDelegate::Create` → `GlobalConfirmInfoBar::Show`, message `IDS_DEV_TOOLS_INFOBAR_LABEL` — source comment: "Creates the "Foo started debugging this browser" warning", button label `IDS_APP_CANCEL`, `ShouldExpire() false`, auto-close timer once no clients remain, one bar per extension id). `debugger_api.cc` suppresses it only with `::switches::kSilentDebuggerExtensionAPI` (`--silent-debugger-extension-api`) or for policy-installed extensions ("We allow policy-installed extensions to circumvent the normal infobar warning. See crbug.com/41302695"). Because it is an infobar, every tab loses the same vertical space measured for the automation infobar (56 CSS px at DPR 1 on macOS), fires `resize`, and changes `outerHeight - innerHeight` without `outerHeight` changing. A page can watch for that transition (and for the reverse when the user clicks Cancel, which detaches the extension).
- `chrome.debugger` sessions are CDP sessions: the same `Input.dispatchMouseEvent` tells (`pressure 0`, screen offsets), `Runtime.enable` tells if the extension enables Runtime, `Runtime.addBinding`/`Page.addScriptToEvaluateOnNewDocument` artifacts, `Emulation.setAutomationOverride` if used. The extension must declare the `"debugger"` permission; attaching to extension background pages needs the silent switch; DevTools opening on the tab detaches it (`onDetach` reason `canceled_by_user`).
- `navigator.webdriver` stays `false` for extension-driven sessions (no automation switch) unless the extension calls `Emulation.setAutomationOverride`.
- Product specifics (Claude for Chrome, Gemini in Chrome, Comet, Atlas, Edge Copilot) were not verified in this session: whether they use `chrome.debugger`, content scripts (`isolated world` + `isTrusted:false` synthetic events), or native browser hooks is **unknown** here and is the main gap for this category. Chromium's bad-flags list now contains `actor::switches::kDisableActorSafetyChecks`, i.e. Chrome has a native "actor" subsystem for agentic features; its page-visible footprint was not researched.

---

## 13. Server-visible tells (summary for the edge companion)

- `User-Agent` containing `HeadlessChrome/` (new headless keeps it; reduced minor version `X.0.0.0`; chrome-headless-shell sends the full build e.g. `156.0.8078.47`, which also violates UA reduction).
- `Sec-CH-UA` / `Sec-CH-UA-Full-Version-List`: `"HeadlessChrome"` brand ⇒ chrome-headless-shell; `Chromium` without `Google Chrome` ⇒ Chrome for Testing or Chromium build (Puppeteer/Playwright downloads, browser-use/Skyvern defaults when they use Playwright/Puppeteer-installed browsers); brands missing entirely while the UA says Chrome ⇒ `Emulation.setUserAgentOverride` without metadata [likely]; `Sec-CH-UA-Platform` vs UA OS mismatches.
- `Accept-Language` absent (old headless, crawlex) or inconsistent with `navigator.languages`; single `en-US` from CfT.
- TLS/HTTP2: Chrome randomises ClientHello extension order since 2023 (JA3 unreliable; use JA4-style). Claims that headless Chromium has a different TLS fingerprint from Chrome (crawlex) are unsupported by the sources read; cside says only that the fingerprint is "stack-specific". Treat as [uncertain]; Chromium/CfT and Chrome share BoringSSL defaults.
- Proprietary codec absence is not server-visible; `Sec-CH-UA-Form-Factors`, `Sec-CH-UA-Arch/Bitness/Model/Platform-Version` are available on request via `Accept-CH` and should be compared with the JS values (Puppeteer disables the `AcceptCHFrame` feature by default — `--disable-features=…AcceptCHFrame…` — so HTTP/2 ACCEPT_CH frames are ignored by Puppeteer-launched Chrome; a server that relies on the H2 ACCEPT_CH frame instead of the header will see no high-entropy hints from such clients) [likely].
- browser-use sets `User-Agent: browser-use/<version>` only on its CDP WebSocket connection, not on page traffic.

---

## 14. Agent / framework matrix (defaults, Oct 2026)

| Stack | Transport | `Runtime.enable` | `webdriver` | Notable residue / flags | Input |
|---|---|---|---|---|---|
| Puppeteer 25.x | CDP (pipe or port 0) | yes (+workers) | true (`--enable-automation`, pipe/port 0, headless) | `pptr:` sourceURL, `__puppeteer_utility_world__<ver>`, `--disable-popup-blocking`, `--disable-ipc-flooding-protection`, `--disable-features=Translate,AcceptCHFrame,MediaRouter,OptimizationHints,…`, `--enable-features=PdfOopif`, `--force-color-profile=srgb`, headless adds `--hide-scrollbars --mute-audio`; default viewport 800x600 | `Input.dispatchMouseEvent` (pressure 0) |
| Playwright 1.5x–1.64 | CDP via `--remote-debugging-pipe` | yes (+workers) | true unless user adds AutomationControlled flag | `UtilityScript.evaluate` frames, `__playwright__binding__`, `__playwright_utility_world_<guid>`, `Emulation.setFocusEmulationEnabled`, `Page.createIsolatedWorld grantUniveralAccess`, `--disable-popup-blocking`, `--disable-ipc-flooding-protection`? (rebrowser removes both for Playwright too), `--enable-unsafe-swiftshader`, `ThirdPartyStoragePartitioning` disabled, `--disable-infobars`, no `--enable-automation` since 1.64; default viewport 1280x720; headless uses chrome-headless-shell by default (old-headless tells!) | CDP input (pressure 0) |
| Playwright MCP 0.0.83 | Playwright | yes | true (headless) / true (headed via pipe) | as Playwright | as Playwright |
| chrome-devtools-mcp 1.12.0 | Puppeteer 25.16 | yes | true | as Puppeteer | as Puppeteer |
| Skyvern 1.0.56 | Playwright 1.56 | yes | **false** (`--disable-blink-features=AutomationControlled`, ignores `--enable-automation`) | bad-flags infobar, `--start-maximized` (outer > 800x600 screen in headless), `--kiosk-printing`, `--disk-cache-size=1`; optional `--remote-debugging-port=9222 --remote-debugging-address=0.0.0.0` | Playwright |
| browser-use 0.13.13 | cdp-use (raw CDP) | **no** | **false** | ~100 flags incl. `AutomationControlled` disabled twice (blink feature + `--disable-features`), bad-flags infobar, Docker `--no-sandbox`…; no page init scripts; `Target.setAutoAttach` (waitForDebuggerOnStart false), `Accessibility.getFullAXTree`, `DOMSnapshot.captureSnapshot`, `Runtime.evaluate includeCommandLineAPI:true` (uses `getEventListeners`), `Runtime.getProperties`, `DOM.describeNode` | `Input.dispatchMouseEvent` mouseMoved→mousePressed→mouseReleased without `force`; `Input.dispatchKeyEvent` per char with delays; `Runtime.callFunctionOn "function() { this.click(); }"` fallback (`isTrusted:false`); `Input.synthesizeScrollGesture speed 50000` / `mouseWheel` |
| Stagehand 4.3.0 | Browserbase protocol/server (SDK has no browser dep) | unknown | unknown | unknown | unknown |
| rebrowser-patches | Puppeteer/Playwright patched | no (`addBinding` default; `alwaysIsolated`; `enableDisable`) | false | sourceURL removed (`<anonymous>`), `UtilityScript` renamed, world `util`, `--enable-automation`/popup/IPC flags dropped, `REBROWSER_PATCHES_*` env; README: does not fix `HeadlessChrome` UA, canvas/WebGL/fonts/screen, IP, timing/mouse | CDP input (pressure 0) |
| Patchright | Playwright fork | no (isolated contexts; Console API disabled) | false | init scripts via HTML route interception (`nextHopProtocol ""`), `--enable-automation/--disable-popup-blocking/--disable-component-update/--disable-default-apps/--disable-extensions` removed; closed shadow roots pierced; Chromium only | CDP input (pressure 0) |
| nodriver / Selenium-Driverless | raw CDP | no | false | Driverless unmaintained ("out of maintenance"); nodriver "expert mode" opens shadow roots and disables web security ("more detectable") | CDP input unless CDP-Patches (OS-level, headful) |
| chromedriver / Selenium classic | CDP + WebDriver | likely | true (`--enable-automation`, port 0) | `cdc_adoQpoasnfa76pfcZLmcfl_*`, `ret_nodes`, chromedriver JS strings in `Function.prototype.apply` callees; undetected-chromedriver renames `cdc_` | CDP input |
| Camoufox | Firefox fork + juggler | n/a (no CDP) | false | C++ spoofing; SpiderMonkey behaviour under a Firefox UA (it does not pretend to be Chrome) | Firefox native input handlers ("trusted-automation-events") |
| Playwright Firefox | juggler | n/a | true | pinned build; isolated-world agent | juggler |
| Playwright WebKit | WebKit patches | n/a | unknown | impossible `X11; Linux` Safari UA | — |
| safaridriver | WebDriver | n/a | true | orange Smart Search field, glass pane (UI only) | native |
| DevTools (human) | CDP | yes (+`Debugger`) | false | `debugger;` pauses | real |
| `chrome.debugger` extension agents | CDP via extension | depends | false | global infobar (unless silent switch / policy) | CDP input (pressure 0) |

---

## 15. Recommended detector architecture for necter (identification layer)

Signal tiers (weights are starting points):

- **Tier A — confessions (weight ≈ 1.0, FP ≈ 0):** `navigator.webdriver === true` (main frame, iframe and worker); `HeadlessChrome` in UA or brands; chromedriver `cdc_`/`$cdc_` residue; `__playwright__binding__`/`__pwInitScripts`/`puppeteer_` globals; `pptr:`/`__puppeteer_evaluation_script__`/`UtilityScript.` frames when a hooked native is called; `innerWidth > outerWidth` or `outerWidth > 2 * screen.width`; `denied`+`prompt` notification pair; desktop Chrome UA with no WebGL context or SwiftShader renderer while WebGPU adapter is null.
- **Tier B — protocol side effects (weight 0.6–0.9):** CDP console probe (prepareStackTrace / inherited name / legacy stack), in page and in a worker, repeated for 10 s; `pointerdown` with `buttons` and `pressure === 0`; `screenX === clientX` outside fullscreen; `nextHopProtocol === ""` on a cold navigation; empty-name native functions appearing on `window`; `Runtime.addBinding`-style own properties; popup-blocking disabled; `replaceState` flood not throttled; `localStorage` visible from a nested cross-site iframe; `debugger;` timing to split DevTools from drivers.
- **Tier C — environment consistency (weight 0.3–0.6, needs several to fire):** 800x600 screen; `screenX/Y === 22` + 87/143 px frame; `hasFocus()` false + visible; rAF cadence locked to 16.67 ms with <0.5 ms jitter; `AudioContext.outputLatency === 0`; Chromium-only brands + no Google voices + single `en-US`; UA/platform/client-hints/WebGL/font/timezone contradictions; worker vs page mismatches; fresh-iframe mismatches; tamper lies (non-native `toString`, Proxy traps, own props on `navigator`).
- **Tier D — behavioral (session-level, separate research area):** input entropy, integer-only coordinates, straight paths, zero `mousemove` before meaningful actions.

Operational notes:

- Rotate probe code and names (Foil rotates server-side); avoid fixed global names so stealth stacks cannot special-case them.
- Run probes early (before page scripts need the console) and again after 1 s and 5 s; Playwright/Puppeteer attach workers and new frames lazily.
- Keep DevTools-open as a *suspicious but not conclusive* state; bots exploit `--auto-open-devtools-for-tabs`.
- Prefer measured consistency (A/B/C above) over any single "headless" property; the old-headless property tells (plugins, `window.chrome`, outer 0x0, permissions) now identify only chrome-headless-shell, which is still what Playwright uses for headless Chromium by default.
- Record raw values, not just verdicts, so the review/replay side can attribute sessions (brands+voices+codecs ⇒ "CfT/Chromium build"; `pptr:` ⇒ Puppeteer; `UtilityScript` ⇒ Playwright; `cdc_` ⇒ chromedriver; CDP probe positive + no webdriver + no residue ⇒ rebrowser/Patchright-class or extension; CDP-negative + pressure 0 + no residue ⇒ browser-use/nodriver-class).

---

## 16. Unknowns and things to verify next

1. Headed real-input baselines on macOS/Windows/Linux for `pointerdown.pressure` (expected 0.5), `PointerEvent.sourceCapabilities`, `outerHeight - innerHeight` ranges, `AudioContext.outputLatency`, rAF jitter.
2. Linux-container values for new headless: default `screenX/Y`, frame height, fonts, voices, `enumerateDevices()`, WebGL/WebGPU defaults with and without `--enable-unsafe-swiftshader`; Windows values.
3. Whether current chromedriver sends `Runtime.enable` (only `devtools_client_impl.cc` and the first 100 KB of `web_view_impl.cc` were read) and who calls `Emulation.setAutomationOverride`.
4. Stagehand ≥3 architecture (browser control moved out of the SDK) and whether Browserbase browsers expose Playwright/CDP residue.
5. How Claude for Chrome, Gemini in Chrome, Perplexity Comet, OpenAI Atlas and Edge Copilot drive pages (chrome.debugger vs content scripts vs native actor); Chrome's native `actor` subsystem footprint.
6. Whether `Sec-CH-UA*` headers are entirely absent when `Emulation.setUserAgentOverride` lacks metadata (JS side confirmed empty).
7. Playwright WebKit's exact UA/`navigator.platform` on Linux and whether it sets `navigator.webdriver`.
8. Which V8 commit closed the Proxy-prototype `ownKeys` preview channel (svebaa, Mar 2026) — it does not fire on Chrome 155.
9. The Playwright `chromium-1248` (CfT 156.0.8078.4) hang on `Page.navigate` in my harness (environmental; retest with `--no-sandbox` or on Linux).
10. TLS fingerprint differences between CfT/headless-shell and Google Chrome (claimed by one blog, unsupported).

---

## 17. Sources

Primary source code / docs (read 2026-10-24):

- Chromium `third_party/blink/renderer/core/frame/navigator.cc` — https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/frame/navigator.cc
- Chromium `content/child/runtime_features.cc` — https://raw.githubusercontent.com/chromium/chromium/main/content/child/runtime_features.cc
- Chromium `third_party/blink/renderer/core/inspector/inspector_emulation_agent.cc` — https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/inspector/inspector_emulation_agent.cc
- Chromium `components/embedder_support/user_agent_utils.cc` — https://raw.githubusercontent.com/chromium/chromium/main/components/embedder_support/user_agent_utils.cc
- Chromium `chrome/browser/ui/startup/bad_flags_prompt.cc` — https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/ui/startup/bad_flags_prompt.cc
- Chromium `chrome/browser/ui/startup/automation_infobar_delegate.cc` — https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/ui/startup/automation_infobar_delegate.cc
- Chromium `chrome/browser/extensions/api/debugger/debugger_api.cc` and `extension_dev_tools_infobar_delegate.cc` — https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/extensions/api/debugger/debugger_api.cc , https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/extensions/api/debugger/extension_dev_tools_infobar_delegate.cc
- Chrome extensions `chrome.debugger` reference — https://developer.chrome.com/docs/extensions/reference/api/debugger
- Chromium `chrome/renderer/loadtimes_bindings.cc` — https://raw.githubusercontent.com/chromium/chromium/main/chrome/renderer/loadtimes_bindings.cc
- Chromium `content/browser/devtools/protocol/input_handler.cc` — https://raw.githubusercontent.com/chromium/chromium/main/content/browser/devtools/protocol/input_handler.cc
- Chromium `third_party/blink/renderer/core/events/pointer_event_factory.cc` — https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/events/pointer_event_factory.cc
- Chromium `third_party/blink/public/common/input/web_pointer_properties.h`, `ui/events/pointer_details.h`, `ui/events/pointer_details.cc`, `ui/events/blink/web_input_event.cc`, `ui/events/cocoa/events_mac.mm` — https://raw.githubusercontent.com/chromium/chromium/main/ui/events/pointer_details.cc , https://raw.githubusercontent.com/chromium/chromium/main/ui/events/blink/web_input_event.cc
- Chromium chromedriver `chrome/test/chromedriver/chrome/devtools_client_impl.cc`, `chrome/test/chromedriver/js/call_function.js`, `chrome/test/chromedriver/chrome/web_view_impl.cc` — https://raw.githubusercontent.com/chromium/chromium/main/chrome/test/chromedriver/chrome/devtools_client_impl.cc , https://raw.githubusercontent.com/chromium/chromium/main/chrome/test/chromedriver/js/call_function.js
- Chromium headless README — https://chromium.googlesource.com/chromium/src/+/main/headless/README.md ; Chrome headless docs — https://developer.chrome.com/docs/chromium/headless ; headless CLI — https://developer.chrome.com/docs/automation-and-testing/headless-cli ; chrome-headless-shell blog — https://developer.chrome.com/blog/chrome-headless-shell ; Chrome for Testing blog — https://developer.chrome.com/blog/chrome-for-testing
- V8 commits — https://chromium.googlesource.com/v8/v8/+/61a907540d , https://chromium.googlesource.com/v8/v8/+/e08e973474 , diff https://github.com/v8/v8/commit/e08e97347454255a337dcea361808fb25ca09077.diff
- V8 `src/inspector/value-mirror.cc` at main, `13.7-lkgr`, `13.8-lkgr`, tags `13.7.152.14`, `13.7.152.19`, `13.8.258.26` — https://raw.githubusercontent.com/v8/v8/main/src/inspector/value-mirror.cc (and the tag paths)
- V8 `src/execution/messages.cc` (prepareStackTrace) — https://raw.githubusercontent.com/v8/v8/main/src/execution/messages.cc ; `src/debug/debug-property-iterator.cc` — https://raw.githubusercontent.com/v8/v8/main/src/debug/debug-property-iterator.cc ; history — https://github.com/v8/v8/commits/main/src/debug/debug-property-iterator.cc
- Playwright `crPage.ts`, `page.ts` (main, v1.46.1, v1.52.0, v1.53.0, v1.54.0, v1.55.0, v1.56.0, v1.58.0), `javascript.ts`, `injected/src/utilityScript.ts`, `chromiumSwitches.ts`, `browser_patches/firefox/patches/bootstrap.diff` — https://raw.githubusercontent.com/microsoft/playwright/main/packages/playwright-core/src/server/chromium/crPage.ts , https://raw.githubusercontent.com/microsoft/playwright/v1.52.0/packages/playwright-core/src/server/page.ts , https://raw.githubusercontent.com/microsoft/playwright/v1.53.0/packages/playwright-core/src/server/page.ts , https://raw.githubusercontent.com/microsoft/playwright/main/packages/playwright-core/src/server/javascript.ts , https://raw.githubusercontent.com/microsoft/playwright/main/packages/injected/src/utilityScript.ts , https://raw.githubusercontent.com/microsoft/playwright/main/packages/playwright-core/src/server/chromium/chromiumSwitches.ts , https://raw.githubusercontent.com/microsoft/playwright/main/browser_patches/firefox/patches/bootstrap.diff
- Puppeteer `common/util.ts`, `cdp/FrameManager.ts`, `node/ChromeLauncher.ts`, v13 `ExecutionContext.ts` — https://raw.githubusercontent.com/puppeteer/puppeteer/main/packages/puppeteer-core/src/common/util.ts , https://raw.githubusercontent.com/puppeteer/puppeteer/main/packages/puppeteer-core/src/cdp/FrameManager.ts , https://raw.githubusercontent.com/puppeteer/puppeteer/main/packages/puppeteer-core/src/node/ChromeLauncher.ts , https://raw.githubusercontent.com/puppeteer/puppeteer/v13.0.0/src/common/ExecutionContext.ts
- chromium-bidi `CdpTarget.ts`, `BrowsingContextImpl.ts` — https://raw.githubusercontent.com/GoogleChromeLabs/chromium-bidi/main/src/bidiMapper/modules/cdp/CdpTarget.ts
- puppeteer-extra-plugin-stealth evasions (`sourceurl`, `iframe.contentWindow`, `navigator.permissions`, `window.outerdimensions`, `chrome.runtime`) — https://raw.githubusercontent.com/berstend/puppeteer-extra/master/packages/puppeteer-extra-plugin-stealth/evasions/sourceurl/index.js (and siblings)
- rebrowser-patches README — https://github.com/rebrowser/rebrowser-patches ; rebrowser blog — https://rebrowser.net/blog/how-to-fix-runtime-enable-cdp-detection-of-puppeteer-playwright-and-other-automation-libraries ; rebrowser-bot-detector README + `index.js` — https://github.com/rebrowser/rebrowser-bot-detector , https://raw.githubusercontent.com/rebrowser/rebrowser-bot-detector/main/index.js
- Patchright README — https://github.com/Kaliiiiiiiiii-Vinyzu/patchright ; Brotector README + `brotector.js` — https://github.com/kaliiiiiiiiii/brotector , https://raw.githubusercontent.com/kaliiiiiiiiii/brotector/master/brotector.js ; CDP-Patches — https://github.com/Kaliiiiiiiiii-Vinyzu/CDP-Patches ; Selenium-Driverless README — https://raw.githubusercontent.com/kaliiiiiiiiii/Selenium-Driverless/master/README.md ; nodriver README — https://raw.githubusercontent.com/ultrafunkamsterdam/nodriver/main/README.md
- BotD 1.9.1 bundle and sources — https://cdn.jsdelivr.net/npm/@fingerprintjs/botd@1/dist/botd.esm.js , https://github.com/fingerprintjs/botd
- CreepJS lies — https://raw.githubusercontent.com/abrahamjuliot/creepjs/master/src/lies/index.ts
- devtools-detect — https://github.com/sindresorhus/devtools-detect , https://raw.githubusercontent.com/sindresorhus/devtools-detect/main/index.js
- Camoufox README and patch tree — https://raw.githubusercontent.com/daijro/camoufox/main/README.md , https://raw.githubusercontent.com/daijro/camoufox/main/browser/patches/playwright/1-leak-fixes.patch
- Gecko `dom/base/Navigator.cpp` — https://raw.githubusercontent.com/mozilla/gecko-dev/master/dom/base/Navigator.cpp ; Firefox remote protocol prefs — https://firefox-source-docs.mozilla.org/remote/Prefs.html
- WebKit bug 171997 — https://bugs.webkit.org/show_bug.cgi?id=171997 ; WebKit blog "WebDriver Support in Safari 10" — https://webkit.org/blog/6900/webdriver-support-in-safari-10/ ; WebKit `UserAgentGLib.cpp` — https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/platform/glib/UserAgentGLib.cpp
- browser-use `pyproject.toml`, `browser/profile.py`, `browser/session.py`, `browser/session_manager.py`, `dom/service.py`, `watchdogs/default_action_watchdog.py`, `watchdogs/dom_watchdog.py`, `watchdogs/aboutblank_watchdog.py` — https://raw.githubusercontent.com/browser-use/browser-use/main/pyproject.toml (and siblings)
- Skyvern `pyproject.toml`, `skyvern/webeye/browser_factory.py` — https://raw.githubusercontent.com/Skyvern-AI/skyvern/main/pyproject.toml
- Stagehand `packages/sdk-ts/package.json` — https://raw.githubusercontent.com/browserbase/stagehand/main/packages/sdk-ts/package.json ; Playwright MCP `package.json` — https://raw.githubusercontent.com/microsoft/playwright-mcp/main/package.json ; chrome-devtools-mcp `package.json` — https://raw.githubusercontent.com/ChromeDevTools/chrome-devtools-mcp/main/package.json

Research posts with code or measurements:

- DataDome / Antoine Vastel, "How New Headless Chrome & the CDP Signal Are Impacting Bot Detection" (2024-06-13) — https://datadome.co/threat-research/how-new-headless-chrome-the-cdp-signal-are-impacting-bot-detection/ (read via https://securityboulevard.com/2024/06/how-new-headless-chrome-the-cdp-signal-are-impacting-bot-detection)
- Castle, "Why a classic CDP bot detection signal suddenly stopped working (and nobody noticed)" (2025-08-28) — https://blog.castle.io/why-a-classic-cdp-bot-detection-signal-suddenly-stopped-working-and-nobody-noticed/ ; "Analyzing anti-detect browsers: How to detect scripts injected via CDP in Chrome" — https://blog.castle.io/how-to-detect-scripts-injected-via-cdp-in-chrome-2/ ; "How to detect Selenium bots?" — https://blog.castle.io/how-to-detect-selenium-bots/
- svebaa, "How V8 Leaks Your Headless Browser's Identity" (2026) — https://svebaa.github.io/personal/blog/cdp-fingerprinting/
- crawlex, "Detecting CDP in the wild: the Runtime.enable leak and the V8 patch war" — https://blog.crawlex.net/blog/detecting-cdp-runtime-enable/ ; "The Chrome DevTools Protocol as a detection vector" (2026-04-17) — https://blog.crawlex.net/blog/cdp-detection-vector/ ; "Headless Chrome detection: every tell…" — https://blog.crawlex.net/blog/headless-chrome-detection/
- deviceandbrowserinfo: "(Unmodified) Headless Chrome instrumented with Puppeteer: fingerprint in 2024" — https://deviceandbrowserinfo.com/learning_zone/articles/fingerprint-unmodified-chrome-puppeteer ; "detecting headless Chrome + Puppeteer (2024)" — https://deviceandbrowserinfo.com/learning_zone/articles/detecting-headless-chrome-puppeteer-2024 ; "+ Selenium (2024)" — https://deviceandbrowserinfo.com/learning_zone/articles/detecting-headless-chrome-selenium-2024 ; WebGL renderer values — https://deviceandbrowserinfo.com/learning_zone/articles/webgl_renderer_values ; "Are you a bot" test list — https://deviceandbrowserinfo.com/are_you_a_bot ; automation infobar — https://deviceandbrowserinfo.com/learning_zone/articles/remove-chrome-controlled-by-automated-test-puppeteer
- thebrowserlayer, old vs new headless — https://thebrowserlayer.com/posts/chromium-headless-mode-differences-between-old-and-new-headless
- cside, "Headless Browser Detection: Signals, Methods, and What Works in 2026" — https://cside.com/blog/headless-browser-detection ; maskbreak (formerly sntlhq) — https://maskbreak.com/blog/headless-browser-detection-2026 ; webscraping.cc — https://webscraping.cc/blog/headless-chrome/ ; Foil, "CDP detection in 2026" — https://usefoil.com/learn/cdp-detection ; Virix Labs, "Playwright Stealth Not Working? Patchright vs Camoufox (2026)" — https://humanbrowser.cloud/blog/playwright-stealth-not-working-2026 (vendor posts; used only for context)
- sannysoft test page — https://bot.sannysoft.com/ ; browserscan — https://www.browserscan.net/bot-detection

Local measurement artefacts: `docs/research/raw/cdp-probe/probe.py`, `stack_fp.py`, `chrome155_default.json`, `chrome155_pptrlike.json`, `chrome155_disablegpu.json`, `chrome155_disablegpu_unsafeswiftshader.json`, `chrome155_windowsize1920.json`, `chrome155_enable_automation_only.json`, `chrome155_remote_debugging_pipe_style_no_headless_flag_check.json`, `cft156_puppeteer_default.json`, `cft156_disable_infobars.json`, `headless_shell156_puppeteer.json`, `playwright_headless_shell1248.json`, `stack_frames_chrome155.txt`.
