# Detectable artifacts of browser-automation and LLM-agent stacks (raw research)

- Area: open-source browser-automation / agent stacks that LLM agents are built on
- Researched: 2026-10-24, by reading source code on GitHub (sparse clones + raw files) and vendor docs. Line numbers refer to the `main` branch on that date.
- Confidence legend: **confirmed** = quoted from source/docs I read; **likely** = inferred from code I read; **uncertain** = not verified, flagged explicitly.
- Companion: this document is only about the *client-side / CDP-level* artifacts of the stacks. UA/IP-range crawler identification (GPTBot, ClaudeBot, …) is covered by a separate research area.

---

## 0. Executive summary: the signals that matter most

| # | Signal (observable from page JS or server) | Which stacks exhibit it (as shipped) | Confidence |
|---|---|---|---|
| 1 | `navigator.webdriver === true` (Blink `AutomationControlled`) | Chromedriver/Selenium (always), Puppeteer (`--enable-automation` + pipe/port 0), Playwright (headless `--headless`, and `--remote-debugging-pipe`), Chrome DevTools MCP (`pipe: true`), Firecrawl playwright-service, LangChain PlaywrightURLLoader, Playwright MCP (stock Playwright launch) | confirmed (Chromium source §1) |
| 2 | `HeadlessChrome/` token in UA and `navigator.userAgentData.brands` | any Chromium started with `--headless` or `--headless=new` (Playwright headless, Puppeteer headless, Browser Use headless, Crawl4AI headless, Steel headless, Firecrawl) unless the stack overrides the UA | confirmed (Chromium `user_agent_utils.cc`) |
| 3 | Viewport exactly 1280×720 (Playwright default) / 800×600 (Puppeteer default) / 1080×600 (Crawl4AI) / 1024×768 (OpenAI & Anthropic computer-use samples) / 1440×900 (Magentic-UI, AutoGen) / 1920×1080 (Skyvern, Steel, Kernel, UC) | see per-stack sections | confirmed |
| 4 | `Runtime.enable` side effects (console argument serialization runs `Error.prepareStackTrace` + extra `name` getter reads) | Playwright, Puppeteer, Chromedriver, Stagehand v4 understudy, Browser Use `actor`/integrations; **not** nodriver/zendriver, rebrowser, patchright | confirmed (detector code §27) |
| 5 | Main-world globals: `window.cdc_adoQpoasnfa76pfcZLmcfl_{Array,Object,Promise,Proxy,ShadowRoot,Symbol,JSON,Window}` (Chromedriver); `__playwright__binding__` + `__playwright__binding__controller__` (Playwright exposeFunction/exposeBinding); `puppeteer_<name>` + `window.<name>` wrapper containing the string `This is the Puppeteer binding` (Puppeteer exposeFunction); `window.elementIdCounter`, `GlobalSkyvernFrameIndex`, `buildTreeFromBody`… (Skyvern); `WebSurfer` / `MultimodalWebSurfer` (Magentic-UI / AutoGen); `__PW_CURSOR_VIS__`, `__pw_trails` (Skyvern cursor overlay) | confirmed |
| 6 | DOM injections: `div[data-browser-use-interaction-highlight]` corner brackets on every Browser Use click (default on), `#browser-use-debug-highlights` (debug), `#browser-use-demo-panel`; `unique_id="…"` attributes + `#boundingBoxContainer` (Skyvern); `__elementId="n"` attributes + `#red-cursor` (Magentic-UI/AutoGen); `[data-nanobrowser-border]` host with closed shadow root (Nanobrowser); `#__pw-cursor[data-pw-overlay]` (Skyvern video cursor); Playwright `x-pw-glass`, `x-pw-highlight`, `x-pw-tooltip` etc. (only when highlight/recorder/MCP devtools tools are used) | confirmed |
| 7 | Error-stack markers: `pptr:` sourceURL (Puppeteer `page.evaluate`), `UtilityScript.evaluate` frames (Playwright main-world evaluate) | confirmed |
| 8 | Synthetic (isTrusted=false) events after "real" input: Browser Use dispatches `new InputEvent('input',{inputType:'insertText'})`, `change`, `blur` after each typed field; nodriver `element.click()` is a JS `el.click()` (untrusted); Puppeteer/Playwright click/scroll are trusted CDP input | confirmed |
| 9 | Input timing signatures: Playwright click = 1 `mouseMoved` + `mousePressed` + `mouseReleased` with `force: 0.5` while pressed and no delay; Puppeteer identical but no `force`; Browser Use = move, 50 ms, press, 80 ms, release; Magentic-UI/AutoGen `delay=10`; Stagehand pipelined burst; nodriver `mouse_click` press/release **without** a preceding move | confirmed |
| 10 | Scroll signatures: Playwright `DOM.scrollIntoViewIfNeeded` then `scrollIntoView({block:'end'…})` retries, `mouseWheel` from `page.mouse.wheel`; Puppeteer `scrollIntoView({block:'center',inline:'center',behavior:'instant'})`; Browser Use `Input.synthesizeScrollGesture` at viewport centre with `speed: 50000`, one viewport height per step; nodriver `synthesizeScrollGesture speed 7777`; OpenAI sample `window.scrollBy()` via `page.evaluate`; Anthropic `xdotool click --repeat N 4/5` | confirmed |
| 11 | Launch-flag side effects visible to pages: `--disable-popup-blocking` (window.open without gesture works), `--disable-ipc-flooding-protection` (>200 `history.replaceState` in 10 s accepted), `--disable-features=ThirdPartyStoragePartitioning` (Playwright, Browser Use), `--blink-settings=primaryHoverType=2…primaryPointerType=4` (Playwright headless, Scrapling always), `Emulation.setFocusEmulationEnabled` (document.hasFocus() always true, Playwright), headless `Page.setFontFamilies` (Playwright) | confirmed (flags) / likely (page observables) |
| 12 | Extension-based agents (Playwright MCP extension `mmlmfjhmonkocbjadbfplnigmagldckm`, Browser MCP `bjfgambnhccakkhmkepdoekmckoijdlc`, Nanobrowser `imbddededgmcgfhfpcjmijokokekbkal`, Stagehand Runtime) drive the user's real Chrome through `chrome.debugger`; page-visible artifacts are limited to the ones each injects (§3, §13, §16, §17) | confirmed |

---

## 1. Chromium ground truth (why the flags matter)

Primary sources: Chromium `third_party/blink/renderer/core/frame/navigator.cc`, `content/child/runtime_features.cc`, `components/embedder_support/user_agent_utils.cc`.

### 1.1 `navigator.webdriver`

```cpp
bool Navigator::webdriver() const {
  if (RuntimeEnabledFeatures::AutomationControlledEnabled())
    return true;

  bool automation_enabled = false;
  probe::ApplyAutomationOverride(GetExecutionContext(), automation_enabled);
  return automation_enabled;
```

`AutomationControlled` is turned on by **four** different command-line conditions (`runtime_features.cc`):

```cpp
      {wrf::EnableAutomationControlled, switches::kEnableAutomation, true},
      {wrf::EnableAutomationControlled, switches::kHeadless, true},
      {wrf::EnableAutomationControlled, switches::kRemoteDebuggingPipe, true},
...
  // Set EnableAutomationControlled if the caller passes
  // --remote-debugging-port=0 on the command line. This means
  // the caller has requested an ephemeral port which is how ChromeDriver
  // launches the browser by default.
  if (command_line.HasSwitch(switches::kRemoteDebuggingPort)) {
    ...
    if (base::StringToInt(port_str, &port) && port == 0) {
      WebRuntimeFeatures::EnableAutomationControlled(true);
```

Consequences (confirmed):
- `--enable-automation` (Puppeteer default, chromedriver default) → webdriver=true.
- `--headless` **and** `--headless=new` → webdriver=true (the switch name is the same `kHeadless`).
- `--remote-debugging-pipe` (Playwright always, Chrome DevTools MCP `pipe: true`, Puppeteer when `pipe: true`) → webdriver=true.
- `--remote-debugging-port=0` (chromedriver default, see §8) → webdriver=true; a **non-zero** port (nodriver, zendriver, Browser Use, Steel 9222, Stagehand local launch) does **not** trigger it.
- `--disable-blink-features=AutomationControlled` wins because explicit blink-feature switches are applied **after** the switch map:

```cpp
  SetRuntimeFeaturesFromCommandLine(command_line);
  SetCustomizedRuntimeFeaturesFromCombinedArgs(command_line);
  // Enable explicitly enabled features, and then disable explicitly disabled
  // ones.
  for (const std::string& feature : FeaturesFromSwitch(command_line, switches::kEnableBlinkFeatures)) { ... }
  for (const std::string& feature : FeaturesFromSwitch(command_line, switches::kDisableBlinkFeatures)) {
    WebRuntimeFeatures::EnableFeatureFromString(feature, false);
```

Detector note: `navigator.webdriver` is a prototype getter; stacks that *delete* it (old puppeteer-extra stealth) produce `typeof navigator.webdriver === 'undefined'`, which is itself anomalous (rebrowser detector flags both `true` and `undefined`, plus non-empty `Object.getOwnPropertyNames(navigator)` and an own-property descriptor for `webdriver`).

### 1.2 `HeadlessChrome` user agent

```cpp
std::string GetUserAgentInternal() {
  std::string product = GetProductAndVersion();
  if (base::CommandLine::ForCurrentProcess()->HasSwitch(kHeadless)) {
    product.insert(0, "Headless");
  }
```

So every Chromium started with `--headless` (old shell **or** new headless) reports `HeadlessChrome/<ver>` in `navigator.userAgent` and in UA-CH brands unless the tool overrides the UA (`Network.setUserAgentOverride` / `--user-agent`). The Chrome docs confirm the mode split: "Since Chrome 132.0.6793.0 the old Headless mode is only available as a standalone binary named `chrome-headless-shell`" and "Chrome now has unified Headless and headful modes." (developer.chrome.com/docs/chromium/headless).

---

## 2. Playwright (JS + Python) — `microsoft/playwright` main (1.64.x era)

### 2.1 Launch flags (`packages/playwright-core/src/server/chromium/chromiumSwitches.ts`) — confirmed verbatim

```
'--disable-field-trial-config', '--disable-background-networking', '--disable-background-timer-throttling',
'--disable-backgrounding-occluded-windows', '--disable-back-forward-cache', '--disable-breakpad',
'--disable-component-extensions-with-background-pages', '--disable-component-update',
'--no-default-browser-check', '--disable-default-apps', '--disable-dev-shm-usage', '--disable-edgeupdater',
'--disable-extensions', '--disable-features=' + disabledFeatures.join(','), '--enable-features=' + enabledFeatures().join(','),
'--allow-pre-commit-input', '--disable-hang-monitor', '--disable-ipc-flooding-protection', '--disable-popup-blocking',
'--disable-prompt-on-repost', '--disable-renderer-backgrounding', '--disable-updater-scheduler',
'--force-color-profile=srgb', '--metrics-recording-only', '--no-first-run', '--password-store=basic',
'--use-mock-keychain', '--no-service-autorun', '--disable-search-engine-choice-screen',
'--unsafely-disable-devtools-self-xss-warnings', '--enable-unsafe-swiftshader', '--edge-skip-compat-layer-relaunch',
'--disable-stack-profiler', '--disable-infobars', options?.android ? '' : '--disable-sync', '--do-not-de-elevate',
```

`disabledFeatures`: `AvoidUnnecessaryBeforeUnloadCheckSync, DestroyProfileOnBrowserClose, LensOverlay, MediaRouter, PaintHolding, ThirdPartyStoragePartitioning, AvoidCorsURLLoaderRestartOnRedirect, OptimizationHints, NetworkTimeServiceQuerying, AimEnabled, PreconnectToSearch, msForceBrowserSignIn, msEdgeUpdateLaunchServicesPreferredVersion`.
`enabledFeatures`: `CDPScreenshotNewSurface` (unless `PLAYWRIGHT_LEGACY_SCREENSHOT`), `SkipListAccountsWithoutGaiaCookies`.

Notable: **current Playwright no longer passes `--enable-automation`** (the array has no such entry; `--disable-infobars` is present instead). `navigator.webdriver` is still `true` because Playwright always launches with `--remote-debugging-pipe` (see `chromium.ts` `defaultArgs()`: `chromeArguments.push('--remote-debugging-pipe')`) and, in headless, with `--headless`.

`chromium.ts` `_innerDefaultArgs` (confirmed): when `headless`:

```ts
chromeArguments.push('--headless');
chromeArguments.push('--hide-scrollbars', '--mute-audio',
    '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4');
```

plus `--no-sandbox` unless `chromiumSandbox === true`, `--user-data-dir=<tmp>`, `--remote-debugging-pipe`, `about:blank` (persistent) or `--no-startup-window`. Playwright **does not** add `--window-size` or `--disable-gpu`.

Headless binary selection (`getExecutableName`): `return options.headless ? 'chromium-headless-shell' : 'chromium';` — headless Playwright uses the **old headless shell** by default; `channel: 'chromium'` opts into new headless ("You can opt into the new headless mode by using `'chromium'` channel" — playwright.dev/docs/browsers). Either way the UA contains `HeadlessChrome` (§1.2). The headless shell additionally lacks `window.chrome` and answers `Notification.permission === 'denied'` while `permissions.query` says `prompt` (rebrowser detector `headless` test, §27).

Pointer media in headless: `(any-pointer: fine)`/`hover: hover` are forced by the `--blink-settings` above.

### 2.2 Default context: viewport, UA, fonts, focus

- `browserContext.ts:765`: `options.viewport = { width: 1280, height: 720 };` (default when neither `viewport` nor `noViewport` set) → `Emulation.setDeviceMetricsOverride({ width:1280, height:720, deviceScaleFactor: options.deviceScaleFactor || 1, mobile: !!options.isMobile, screenOrientation: {angle:0,type:'landscapePrimary'} })`. With `viewport: null` Playwright instead resizes the window using platform insets (`{ width: 8, height: 85 }` on Linux, +46 px height for persistent contexts).
- `crPage.ts` `_initialize` always sends `Emulation.setFocusEmulationEnabled { enabled: true }` on the main frame → `document.hasFocus()` is true even for background windows (weak signal).
- Headless only: `Page.setFontFamilies(platformToFontFamilies[platform])` (`defaultFontFamilies.ts`): linux → `standard: 'Times New Roman', fixed: 'Monospace', serif: 'Times New Roman', sansSerif: 'Arial', cursive: 'Comic Sans MS', fantasy: 'Impact'`; mac → `Times/Courier/Times/Helvetica/Apple Chancery/Papyrus` (+ jpan/hang script tables). A Linux headless Playwright page therefore resolves generic families to Windows font names → measurable via `getComputedStyle`/text metrics (likely signal, not independently tested).
- UA is **not** modified by Playwright at launch; `getUserAgent()` is only used as the WebSocket `User-Agent` header for `connectOverCDP`.
- `crBrowser.ts:83`: `browser.options.headful = !version.userAgent.includes('Headless');` (Playwright itself uses the UA token to detect headless).

### 2.3 CDP session bootstrap (`crPage.ts` `FrameSession._initialize`) — confirmed

Sent unconditionally per frame session: `Page.enable`, `Page.getFrameTree`, `Log.enable`, `Page.setLifecycleEventsEnabled {enabled:true}`, **`Runtime.enable`**, `Page.addScriptToEvaluateOnNewDocument { source: '', worldName: this._crPage.utilityWorldName }`, network manager (`Network.enable`), `Target.setAutoAttach { autoAttach:true, waitForDebuggerOnStart:true, flatten:true }`, `Runtime.runIfWaitingForDebugger`; per frame `Page.createIsolatedWorld { frameId, grantUniveralAccess: true, worldName: utilityWorldName }`. Conditional: `Runtime.addBinding { name: '__playwright__binding__' }` (only if bindings are needed), `Emulation.setFocusEmulationEnabled`, `Page.setBypassCSP` (if `bypassCSP`), `Security.setIgnoreCertificateErrors`, `Emulation.setTouchEmulationEnabled`, `Emulation.setScriptExecutionDisabled`, `Emulation.setLocaleOverride`, `Emulation.setTimezoneOverride`, `Page.setFontFamilies` (headless), `Emulation.setGeolocationOverride`, `Emulation.setEmulatedMedia`, `Page.setInterceptFileChooserDialog`, `Network.setBypassServiceWorker` (storage-state pages).

Utility world name is now **per page**: `this.utilityWorldName = \`__playwright_utility_world_${this._page.guid}\`;` (`crPage.ts:108`). Firefox/WebKit/BiDi still use the constant `'__playwright_utility_world__'` (`ffPage.ts:41`, `wkPage.ts:52`, `bidiPage.ts:42`). Isolated-world names are not observable from page JS; they are observable to anyone who can see CDP traffic (hosted-browser providers).

### 2.4 Main-world globals and markers

- `page.ts:1058`: `static kBindingName = '__playwright__binding__';` — the CDP binding (a native function on `window`) created by `Runtime.addBinding` when `exposeFunction`/`exposeBinding`/init-script-with-function-args are used.
- `packages/isomorphic/utilityScriptSerializers.ts:24`: `export const kBindingsControllerProperty = '__playwright__binding__controller__';` — the bootstrap init script does `globalThis[property] = new (module.exports.BindingsController())(globalThis, '__playwright__binding__')`, and each `exposeFunction(name)` adds `globalThis['__playwright__binding__controller__'].addBinding("name", false)`, which sets `window[name] = (...args) => this.callBinding(name, ...args)` (`packages/injected/src/bindingsController.ts`). So a page can detect `exposeFunction` by enumerating `window` for `__playwright__binding__` / `__playwright__binding__controller__`, or by `window.<name>.toString()` (arrow wrapper). The rebrowser detector additionally matches the older wrapper text `exposeBindingHandle supports a single argument` ("Playwright 1.59 or older, or Patchright").
- `page.ts` `InitScript` wraps user init scripts only as `(() => { ${source} })();` — the `window.__pwInitScripts` marker that the rebrowser detector tests for is **not present in current Playwright** (grep of the whole tree finds nothing); treat it as a *historic* indicator (older 1.4x releases).
- `javascript.ts:390`: `saveGlobalsSnapshotSource = \`window.__pwSnapshotGlobals = {...}\`` is injected into the main world **only** when the delegate has `noUtilityWorld()` (non-Chromium/webview paths), not for Chromium.
- Recorder/codegen bindings (`recorder.ts`): `__pw_recorderState`, `__pw_recorderElementPicked`, `__pw_recorderSetMode`, `__pw_recorderSetOverlayState`, `__pw_resume`, `__pw_recorderPerformAction`, `__pw_recorderRecordAction`, `window.__pw_refreshOverlay()` — only with `page.pause()`/codegen.
- Trace snapshotter (`snapshotterInjected.ts`, only when tracing): attributes `__playwright_shadow_root_`, `__playwright_value_`, `__playwright_checked_`, `__playwright_selected_`, `__playwright_scroll_top_`, `__playwright_scroll_left_`, `__playwright_style_sheet_`, `__playwright_target__`, `__playwright_custom_elements__`, `__playwright_current_src__`, `__playwright_bounding_rect__`, `__playwright_popover_open_`, `__playwright_dialog_open_`; custom events `__playwright_mark_target__`, `__playwright_reset_targets__`, `__playwright_snapshotter_global_listeners_check__`; global `__playwright_snapshot_streamer_<guid>`.
- Highlight overlay (`packages/injected/src/highlight.ts`, used by `locator.highlight()`, the recorder, and MCP's `browser_highlight`/video decorations): custom elements `x-pw-glass`, `x-pw-action-cursor`, `x-pw-title`, `x-pw-user-overlays`, `x-pw-action-point`, `x-pw-screencast-highlight`, `x-pw-screencast-point`, `x-pw-tooltip`, `x-pw-tooltip-line`, `x-pw-highlight`, `x-pw-dialog`, class `x-pw-user-overlay`.
- `crDevTools.ts:21`: binding `__pw_devtools__` (only with `PWDEBUG` devtools integration). Electron loader defines `globalThis.__playwright_run`.

### 2.5 Evaluate: which world, and the `UtilityScript` stack marker

`frames.ts`: `const context = await this.context(options.world ?? 'main');` → **`page.evaluate` runs in the main world by default**; selectors/actionability run in the utility world (`injected.*`). The utility script evaluates string expressions with an *indirect* eval on the target realm's global:

```ts
export class UtilityScript {
  readonly global: typeof globalThis;
  ...
  evaluate(isFunction, returnByValue, expression, argCount, ...argsAndHandles) {
    ...
    let result = this.global.eval(expression);
```

(`packages/injected/src/utilityScript.ts:68-75`; instantiated as `new (module.exports.UtilityScript())(globalThis, …)` in `javascript.ts:113`). Two consequences: (a) any function the page is tricked into calling from inside `page.evaluate` (e.g. a wrapped `document.getElementById`) sees `UtilityScript.evaluate` frames in `new Error().stack` — the rebrowser `sourceUrlLeak` test checks `error.stack.includes('UtilityScript.')`; (b) a *string* script passed to `page.evaluate` (Skyvern's `domUtils.js`, Magentic-UI's `page_script.js`) runs as global code, so its top-level `function`/`var` declarations become `window` properties (likely; see §14, §18).

rebrowser-patches renames the class per process ("The Playwright patch renames the helper to a short name picked at random per process", patch hunk: `source14.replace("var UtilityScript = class {", () => \`var ${name} = class {\`)` plus a random number of leading newlines `"\n".repeat(Math.floor(Math.random() * 100))`).

### 2.6 Input dispatch (`crInput.ts`, `input.ts`, `dom.ts`) — confirmed

Mouse (`RawMouseImpl`):

```ts
await progress.race(this._client.send('Input.dispatchMouseEvent', {
  type: 'mouseMoved', button, buttons: toButtonsMask(buttons), x, y,
  modifiers: toModifiersMask(modifiers),
  force: buttons.size > 0 ? 0.5 : 0,
}));
...
type: 'mousePressed', button, buttons, x, y, modifiers, clickCount, force: buttons.size > 0 ? 0.5 : 0,
...
type: 'mouseReleased', button, buttons, x, y, modifiers, clickCount
...
type: 'mouseWheel', x, y, modifiers, deltaX, deltaY,
```

- `Mouse.move` default `steps = 1` (one `mouseMoved`, linear interpolation only if `steps>1`). `click` = move(forClick) + down + up; `delay` default `null` → down/up dispatched back-to-back (`Promise.all`). `dblclick` = `clickCount: 2`. `hover` = move only. No randomisation anywhere.
- Pointer pressure: `force: 0.5` while a button is held → `PointerEvent.pressure` is 0.5 on `pointerdown`/drag moves, 0 otherwise (observable; a real mouse reports 0.5 on press in Chromium too, so weak on its own).
- Click point (`dom.ts` `_clickablePoint`): quads from `DOM.getContentQuads`, clipped to `innerWidth/innerHeight`, filtered `computeQuadArea(quad) > 0.99`, point = `quadMiddlePoint(quad)` (exact centre of the first visible quad), rounded to 1/100 px (`(point.x * 100 | 0) / 100`). With `position` option: `box.x + border.left + offset.x`. Retry back-off `waitTime = [0, 20, 100, 100, 500]` ms; before each attempt a hit-target check runs in the utility world (`injected.setupHitTargetInterceptor`).
- Scrolling before actions: first `DOM.scrollIntoViewIfNeeded { objectId, rect }` (protocol scroll), retries cycle `{block:'end',inline:'end'}`, `{block:'center',inline:'center'}`, `{block:'start',inline:'start'}` via `element.scrollIntoView({...options, behavior: 'instant'})`. `page.mouse.wheel(dx,dy)` → single `mouseWheel` event at the current mouse position.
- Keyboard (`RawKeyboardImpl.keydown`): `Input.dispatchKeyEvent { type: text ? 'keyDown' : 'rawKeyDown', modifiers, windowsVirtualKeyCode: description.keyCodeWithoutLocation, code, commands, key, text, unmodifiedText: text, autoRepeat, location, isKeypad }`; keyup with `type: 'keyUp'`. `keyboard.type()` default **no delay**; characters in the US layout go through `press` (keydown+keyup), others through `Input.insertText`.
- `fill()` (`dom.ts`): utility-world `injected.fill(node, value)` returns `'error:notconnected' | 'needsinput' | 'done'`; on `'needsinput'` Playwright calls `keyboard.insertText(value)` → **one `Input.insertText`** (no keydown/keyup/keypress; a single `input` event with `inputType: 'insertText'` carrying the whole string) or `keyboard.press('Delete')` for empty values. `pressSequentially`/`type` → per-character key events.
- Touch: `RawTouchscreenImpl` → `Input.dispatchTouchEvent` (only `hasTouch` contexts).

Implementation hook: a Playwright `fill()` produces exactly one `beforeinput/input` pair with `inputType:'insertText'` and `data` equal to the full value, with no `keydown` and no `compositionstart`; a human never does that for multi-character strings outside paste (`insertFromPaste`).

### 2.7 Aria snapshot refs (shared with Playwright MCP / agent tooling)

`packages/injected/src/ariaSnapshot.ts:234`: `ref: (options.refPrefix ?? '') + 'e' + (++lastRef)`; frames get `f<seq>` prefixes (`frames.ts`: "refs (f<seq>e<n>) minted against the previous document do not accidentally resolve"). The YAML renderer emits `[ref=e12]`, and the MCP backend parses `target.match(/\[ref=((?:f\d+)?e\d+)\]/)` (`tools/backend/tab.ts:640`). Refs live in a WeakMap in the utility world — **no DOM attribute is written**.

### 2.8 Other page-visible behaviours

- `--disable-popup-blocking` → `window.open()` works without a user gesture (detector `popupBlocking`).
- `--disable-ipc-flooding-protection` → 300 `history.replaceState()` calls in 10 s all succeed (detector `ipcFloodingProtection`).
- `--disable-features=ThirdPartyStoragePartitioning` → cross-site iframes share storage (detector `storagePartitioning`, Chromium 148+).
- `route.fulfill()` of the main document → `performance.getEntriesByType('navigation')[0].nextHopProtocol === ''` with `transferSize > 0` (detector `documentInterception`).
- `bypassCSP: true` → `Page.setBypassCSP` (detector `bypassCsp`).

---

## 3. `@playwright/mcp` (Playwright MCP) and the Playwright Extension

Source now lives in the monorepo: `packages/playwright-core/src/tools/mcp/*` and `tools/backend/*` (the `microsoft/playwright-mcp` repo's `src/` only contains a README). Confirmed:

- Browser: persistent context via `browserType.launchPersistentContext(userDataDir, { ...launchOptions, ...contextOptions, handleSIGINT:false, handleSIGTERM:false, ignoreDefaultArgs: ['--disable-extensions', ...] })` (`browserFactory.ts:198-212`) — i.e. **stock Playwright flags** (so `--remote-debugging-pipe` → `navigator.webdriver = true`, `--disable-popup-blocking`, etc.) but extensions enabled. `--isolated` uses `browserType.launch`. `--cdp-endpoint` uses `connectOverCDP`.
- Profile dir: `path.join(defaultCacheDirectory(), 'ms-playwright-mcp', \`mcp-${channel||browserName}-${sha256(cwd).slice(0,7)}\`)` (`browserFactory.ts:228-232`). README wording: `~/.cache/ms-playwright/mcp-{channel}-{workspace-hash}` (slightly different path; code is authoritative).
- Headless default: `browser.launchOptions.headless = os.platform() === 'linux' && !process.env.DISPLAY;` (`config.ts:146-147`) — headed on macOS/Windows, headless on display-less Linux. README: "run browser in headless mode, headed by default".
- Defaults (`config.ts` `defaultConfig`): `timeouts: { action: 5000, navigation: 60000, expect: 5000, settle: 500 }`; `launchOptions: {}`, `contextOptions: {}` → Playwright defaults apply (viewport 1280×720 in isolated mode; persistent contexts default to `viewport: null`? — not verified, uncertain).
- Tools act through Playwright locators resolved from `[ref=…]`: `browser_click` → `locator.click(options)` (`backend/snapshot.ts:95`), `browser_type` → `locator.fill(value)` unless `slowly: true` → `locator.pressSequentially(value)` (`backend/keyboard.ts:99-105`), `browser_fill_form` → `locator.fill`, `browser_mouse_click_xy` → `page.mouse.click(x, y, options)` (`backend/mouse.ts:139`). README: "`slowly`: Whether to type one character at a time … By default entire text is filled in at once."
- Snapshot: accessibility-tree YAML with `[ref=eN]` targets; "The server uses Playwright's accessibility tree, not pixel-based input".
- Tool list (README): `browser_snapshot`, `browser_click` (`element`, `target`, `doubleClick`, `button`, `modifiers`), `browser_type` (`element`, `target`, `text`, `submit`, `slowly`), `browser_press_key`, `browser_navigate`, `browser_hover`, `browser_drag`, `browser_select_option`, `browser_take_screenshot`, `browser_evaluate`, `browser_run_code_unsafe`, `browser_fill_form`, `browser_wait_for`, `browser_file_upload`, `browser_drop`, `browser_handle_dialog`, `browser_resize`, `browser_close`, `browser_console_messages`, `browser_navigate_back`, `browser_network_requests`, `browser_tabs`; vision caps `browser_mouse_click_xy`, `browser_mouse_move_xy`, `browser_mouse_drag_xy`, `browser_mouse_down/up`, `browser_mouse_wheel`; devtools caps `browser_highlight` (injects the `x-pw-*` overlay), `browser_start_video`, `browser_annotate`.
- CLI options (README): `--browser chrome|firefox|webkit|msedge`, `--headless`, `--isolated`, `--user-data-dir`, `--viewport-size 1280x720` (example, no stated default), `--user-agent`, `--cdp-endpoint`, `--cdp-timeout 30000`, `--extension`, `--caps vision,pdf,devtools`, `--device "iPhone 15"`, `--storage-state`, `--init-script`, `--proxy-server`, `--block-service-workers`, `--ignore-https-errors`, `--no-sandbox`, `--timeout-action 5000`, `--timeout-navigation 60000`, `--save-session`.
- Extension mode: `packages/extension/manifest.json`: `"name": "Playwright Extension"`, MV3, permissions `debugger, activeTab, tabs, tabGroups`, `host_permissions: ["<all_urls>"]`; Chrome Web Store ID `mmlmfjhmonkocbjadbfplnigmagldckm` (`tools/utils/extension.ts:21`). The MCP server runs a local `CDPRelayServer` with endpoints `/cdp/<guid>` (Playwright side) and `/extension/<guid>` (extension side) and connects with `playwright.chromium.connectOverCDP(relay.cdpEndpoint(), { isLocal: true, timeout: 0, noDefaults: true })`; the extension forwards `chrome.debugger.attach/sendCommand/onEvent/onDetach`. Auth via `PLAYWRIGHT_MCP_EXTENSION_TOKEN` shown in the extension UI. Because the real user profile is driven through `chrome.debugger`, launch-flag artifacts (webdriver, HeadlessChrome, viewport) are absent; the Playwright-level artifacts (Runtime.enable, utility world, `UtilityScript` frames, `__playwright__binding__` when bindings are used, actionability scrolls, instant click/fill signatures) remain.

---

## 4. Puppeteer — `puppeteer/puppeteer` main (25.x)

### 4.1 Flags (`node/ChromeLauncher.ts` `defaultArgs`) — confirmed verbatim

```
'--allow-pre-commit-input', '--disable-background-networking', '--disable-background-timer-throttling',
'--disable-backgrounding-occluded-windows', '--disable-breakpad', '--disable-client-side-phishing-detection',
'--disable-component-extensions-with-background-pages', '--disable-crash-reporter', '--disable-default-apps',
'--disable-dev-shm-usage', '--disable-hang-monitor', '--disable-infobars', '--disable-ipc-flooding-protection',
'--disable-popup-blocking', '--disable-prompt-on-repost', '--disable-renderer-backgrounding',
'--disable-search-engine-choice-screen', '--disable-sync', '--enable-automation', '--export-tagged-pdf',
'--force-color-profile=srgb', '--generate-pdf-document-outline', '--metrics-recording-only', '--no-first-run',
'--password-store=basic', '--use-mock-keychain',
`--disable-features=${disabledFeatures.join(',')}`, `--enable-features=${enabledFeatures.join(',')}`,
```

`enabledFeatures = ['PdfOopif']`; `disabledFeatures = ['Translate','AcceptCHFrame','MediaRouter','OptimizationHints','WebUIReloadButton','WebUIOmniboxPopup','WebUIOmniboxAimPopup', 'ProcessPerSiteUpToMainFrameThreshold','IsolateSandboxedIframes' (unless `PUPPETEER_TEST_EXPERIMENTAL_CHROME_FEATURES`)]`. Then: `--no-sandbox` only if `PUPPETEER_DANGEROUS_NO_SANDBOX=true`; `--user-data-dir=…`; `--auto-open-devtools-for-tabs` (devtools); headless → `headless === 'shell' ? '--headless' : '--headless=new'` plus `--hide-scrollbars`, `--mute-audio`; `--disable-extensions` unless `enableExtensions`; `about:blank`. Transport: `--remote-debugging-pipe` (`pipe: true`) or `--remote-debugging-port=${debuggingPort || 0}` → port 0 by default (→ AutomationControlled, §1.1). `headless` default `true` (new headless) → `HeadlessChrome` UA.

Server-side note (likely): `AcceptCHFrame` disabled means Puppeteer-launched Chrome ignores HTTP/2 `ACCEPT_CH` frames; `Accept-CH` response headers still work.

### 4.2 Defaults and CDP bootstrap

- `common/util.ts:38`: `export const DEFAULT_VIEWPORT = Object.freeze({width: 800, height: 600});` → `Emulation.setDeviceMetricsOverride({ mobile:false, width:800, height:600, deviceScaleFactor:1, screenOrientation:{angle:0,type:'portraitPrimary'} })` + `Emulation.setTouchEmulationEnabled {enabled:false}` (`EmulationManager.ts:306-337`). `defaultViewport: null` disables it.
- `common/util.ts:309`: `export const UTILITY_WORLD_NAME = '__puppeteer_utility_world__' + packageVersion;`
- `FrameManager.initialize`: `Page.enable`, `Page.getFrameTree`, `Page.setLifecycleEventsEnabled {enabled:true}`, **`Runtime.enable`** then `#createIsolatedWorld(UTILITY_WORLD_NAME)` = `Page.addScriptToEvaluateOnNewDocument { source: '//# sourceURL=pptr:internal', worldName }` + per-frame `Page.createIsolatedWorld { frameId, worldName, grantUniveralAccess: true }`; `Audits.enable` when issues enabled. `CdpPage`: `Performance.enable`, `Log.enable`; `NetworkManager`: `Network.enable`; `TargetManager`: `Target.setDiscoverTargets {discover:true, filter}`, `Target.setAutoAttach { waitForDebuggerOnStart:true, flatten:true, autoAttach:true, filter }`, `Runtime.runIfWaitingForDebugger`. `Emulation.setFocusEmulationEnabled` only via `page.emulateFocus()` (not default).

### 4.3 The `pptr:` sourceURL (confirmed)

`cdp/ExecutionContext.ts:396-440`: every `Runtime.evaluate` expression / `Runtime.callFunctionOn` functionDeclaration gets `\n//# sourceURL=${url}\n` appended unless it already contains a sourceURL (`SOURCE_URL_REGEX = /^[\x20\t]*\/\/[@#] sourceURL=\s{0,10}(\S*?)\s{0,10}$/m`). The URL is `PuppeteerURL.fromCallSite(functionName, site).toString()` → `` `pptr:${functionName};${encodeURIComponent(site.toString())}` `` (e.g. `pptr:evaluate;file%3A%2F%2F%2Fhome%2Fuser%2Fbot.js%3A12%3A20`) or `pptr:internal`. The detector test: `error.stack.toString().includes('pptr:')` inside a wrapped DOM API called from `page.evaluate`. The old marker `__puppeteer_evaluation_script__` (which puppeteer-extra-plugin-stealth's `sourceurl` evasion strips) is obsolete.

### 4.4 `exposeFunction` globals (confirmed)

`cdp/utils.ts:309`: `CDP_BINDING_PREFIX = 'puppeteer_'` — a native CDP binding `window.puppeteer_<name>` plus a JS wrapper installed by `addPageBinding`:

```js
  Object.assign(globalThis, {
    [name](...args) {
      // This is the Puppeteer binding.
      const callPuppeteer = globalThis[name];
      callPuppeteer.args ??= new Map();
      callPuppeteer.callbacks ??= new Map();
      const seq = (callPuppeteer.lastSeq ?? 0) + 1;
      ...
      globalThis[prefix + name](JSON.stringify({ type, name, seq, args, isTrivial: ... }));
```

So `window.<name>.toString()` contains `This is the Puppeteer binding` and `window.<name>.args/.callbacks/.lastSeq` exist; `for (key in window) key.startsWith('puppeteer_')` finds the binding (detector `exposeFunctionLeak`).

### 4.5 Input (`cdp/Input.ts`, `api/ElementHandle.ts`) — confirmed

- `CdpMouse.move`: `steps = 1`; each step `Input.dispatchMouseEvent { type:'mouseMoved', modifiers, buttons, button, x, y }` (no `force`).
- `click`: `[move, (down,up)×(count-1), down, (delay?), up]` all queued in one `Promise.all` when no delay.
- `wheel`: `{ type:'mouseWheel', pointerType:'mouse', deltaX, deltaY, buttons, x, y }`.
- `ElementHandle.click`: `scrollIntoViewIfNeeded()` (IntersectionObserver `threshold: 1`; if not fully visible → `element.scrollIntoView({ block:'center', inline:'center', behavior:'instant' })`) → `clickablePoint()` = centre of the **first** `getClientRects()` box with `width>=1 && height>=1`, clipped to the document viewport, or `box.x+offset.x` when an offset is given → `page.mouse.click(x, y)`.
- Keyboard: `type()` → per char `press(char, {delay})` for known keys else `sendCharacter` = `Input.insertText {text: char}`; `down` sends `{ type: text ? 'keyDown' : 'rawKeyDown', modifiers, windowsVirtualKeyCode, code, key, text, unmodifiedText: text, autoRepeat, location, isKeypad: location===3, commands }`, `up` sends `{ type:'keyUp', modifiers, key, windowsVirtualKeyCode, code, location }`. Default delay 0.
- Drag: `Input.setInterceptDrags` + `Input.dragIntercepted`.

---

## 5. `puppeteer-extra-plugin-stealth` (berstend/puppeteer-extra)

Evasion directory (confirmed listing): `chrome.app`, `chrome.csi`, `chrome.loadTimes`, `chrome.runtime`, `defaultArgs`, `iframe.contentWindow`, `media.codecs`, `navigator.hardwareConcurrency`, `navigator.languages`, `navigator.permissions`, `navigator.plugins`, `navigator.vendor`, `navigator.webdriver`, `sourceurl`, `user-agent-override`, `webgl.vendor`, `window.outerdimensions`.

- `navigator.webdriver`: "Will delete `navigator.webdriver` property" (`delete Object.getPrototypeOf(navigator).webdriver`) **and** appends `--disable-blink-features=AutomationControlled` to launch args (`options.args.push('--disable-blink-features=AutomationControlled')`). Deleting leaves `typeof navigator.webdriver === 'undefined'` on builds where the flag did not take effect — flagged by detectors.
- `sourceurl`: wraps `client.send` for `Runtime.evaluate`→`expression` and `Runtime.callFunctionOn`→`functionDeclaration` and strips `'//# sourceURL=__puppeteer_evaluation_script__'` — **does not strip the modern `pptr:` marker** (confirmed from the evasion source).
- `defaultArgs`: adds `--disable-extensions`, `--disable-default-apps`, `--disable-component-extensions-with-background-pages` to `ignoreDefaultArgs`; keeps `--enable-automation`.
- `user-agent-override`: `userAgent.replace('HeadlessChrome/', 'Chrome/')`, rewrites the OS token to `(Windows NT 10.0; Win64; x64)` when `maskLinux`, sets `platform`, `userAgentMetadata.brands/platform/platformVersion` and `acceptLanguage` via `Network.setUserAgentOverride`.
- Leak status 2026 (rebrowser docs): the plugin's `Proxy`-based overrides are caught by `nativeTampering` ("a `Proxy` that misses a cyclic `__proto__`") and `iframe.contentWindow` evasion "returns the parent window"; `workerConsistency` compares `navigator` in a Worker with the page (UA/platform/brands overridden only in the main thread).

---

## 6. rebrowser-patches / rebrowser-playwright / rebrowser-puppeteer

Confirmed from README + `patches/playwright-core/1.64.1/{lib,src}.patch`, `patches/puppeteer-core/25.14.0/*`:

- Fixes "the `Runtime.enable` leak": `// rebrowser-patches: skip Runtime.enable`; execution context IDs are obtained by `Page.createIsolatedWorld` (`alwaysIsolated`), or by a one-shot `Runtime.addBinding` with a random name + object lookup (`addBinding`, default), or `enableDisable` (brief `Runtime.enable`, "not fully leak-free"). Modes via `REBROWSER_PATCHES_RUNTIME_FIX_MODE` = `addBinding` (default) | `alwaysIsolated` | `enableDisable` | `0`.
- Utility world name: `this.utilityWorldName = process.env["REBROWSER_PATCHES_UTILITY_WORLD_NAME"] !== "0" ? process.env["REBROWSER_PATCHES_UTILITY_WORLD_NAME"] || "util" : \`__playwright_utility_world_${this._page.guid}\`` → default **`util`**; Puppeteer default `'__puppeteer_utility_world__' + packageVersion` → `util`.
- Playwright: `UtilityScript` class renamed to a random per-process name with random newline offset (`REBROWSER_PATCHES_SOURCE_URL === "0"` disables). Puppeteer: "adds no sourceURL at all, so frames show `<anonymous>`" (`REBROWSER_PATCHES_SOURCE_URL`).
- `REBROWSER_PATCHES_WEBDRIVER_FIX` (adds `--disable-blink-features=AutomationControlled`; Puppeteer drops `--enable-automation`), removes `--disable-popup-blocking`, `--disable-ipc-flooding-protection`, and for Playwright `ThirdPartyStoragePartitioning` from `--disable-features`.
- Puppeteer patch re-adds bindings after navigation: "without Runtime.enable, Chrome drops CDP bindings on navigation (crbug.com/382473087)".
- Explicitly **not** fixed: "the `HeadlessChrome` token in the headless user agent", "fingerprints (canvas, WebGL, fonts, screen), your IP reputation and how your script behaves", `page.pause()`, viewport defaults (detector `viewport`), `exposeFunction` wrappers. The addBinding fallback "could briefly see a global with a random name" (detector `cdpBindingGlobals` watched for "native functions with empty names" left by `Runtime.addBinding` in rebrowser ≤1.1.0).
- Versions tested as of 2026-10-14: puppeteer 25.14.0 (`25.14.101` drop-in), playwright 1.64.1 (`1.64.101`).

---

## 7. Patchright (Kaliiiiiiiiii-Vinyzu/patchright) — Playwright fork, Chromium only

Confirmed from README and `driver_patches/*.ts`:

- `chromiumSwitchesPatch.ts` removes `"assistantMode ? '' : '--enable-automation'"`, `'--disable-popup-blocking'`, `'--disable-component-update'`, `'--disable-default-apps'`, `'--disable-extensions'` and adds `'--disable-blink-features=AutomationControlled'`.
- `crPagePatch.ts`: "Removing Runtime.enable from the Promise.all call", removes `this._client.send('Runtime.addBinding', { name: PageBinding.kPlaywrightBinding })`, and resolves contexts with `Page.createIsolatedWorld` / `Runtime.addBinding { name, executionContextId }`. README: "patchright avoids using Runtime.enable by executing Javascript in (isolated) ExecutionContexts" and "Patchright patches this leak by disabling the Console API all together" (console messages do not work).
- Init scripts are injected by **rewriting HTML responses through Playwright routes** (`protocol.Route.commands.continue.parameters.patchrightInitScript = "boolean?"`) — this is why the rebrowser detector reports Patchright as failing `documentInterception` ("Patchright does this on every page load once it uses `addInitScript` or `exposeFunction`"), `exposeFunctionLeak` (wrapper text `exposeBindingHandle supports a single argument`) and `storagePartitioning`. README itself: "Patchright InitScripts can be detected by Timing Attacks".
- Adds `isolatedContext` option to `evaluateExpression`; closed shadow roots handled via `shadowRootType === "closed" && shadowRoot.backendNodeId` (`framesPatch.ts:1167`).
- Claims to pass "Brotector (with CDP-Patches), Cloudflare, Kasada, Akamai, Shape/F5, Bet365, Datadome, Fingerprint.com, CreepJS, Sannysoft, Incolumitas, IPHey, Browserscan, and Pixelscan"; recommends `channel="chrome"`, `headless=False`, `no_viewport=True`, persistent context.
- Downstream users: Crawl4AI `UndetectedAdapter` (`from patchright.async_api import Page`), Scrapling (`driven_browser_version(package="patchright")`), **Kernel cloud browsers** ("Kernel automatically applies Patchright to remove automation fingerprints, including headless indicators" — kernel.sh bot-detection overview).

---

## 8. Selenium / ChromeDriver (chromium/src `chrome/test/chromedriver`)

### 8.1 Main-world globals — confirmed verbatim (`devtools_client_impl.cc` `SetUpDevTools`)

```cpp
    SendCommandAndIgnoreResponse("Page.enable", base::DictValue());
    std::string script =
        "(function () {"
        "window.cdc_adoQpoasnfa76pfcZLmcfl_Array = window.Array;"
        "window.cdc_adoQpoasnfa76pfcZLmcfl_Object = window.Object;"
        "window.cdc_adoQpoasnfa76pfcZLmcfl_Promise = window.Promise;"
        "window.cdc_adoQpoasnfa76pfcZLmcfl_Proxy = window.Proxy;"
        "window.cdc_adoQpoasnfa76pfcZLmcfl_ShadowRoot = window.ShadowRoot;"
        "window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol = window.Symbol;"
        "window.cdc_adoQpoasnfa76pfcZLmcfl_JSON = window.JSON;"
        "window.cdc_adoQpoasnfa76pfcZLmcfl_Window = window.Window;"
        "}) ();";
    ... "Page.addScriptToEvaluateOnNewDocument" ... "Runtime.evaluate"
```

Eight `window.cdc_adoQpoasnfa76pfcZLmcfl_*` properties are installed on every page/frame (new documents **and** the current one via `Runtime.evaluate`). `call_function.js` reads them back (`window.cdc_adoQpoasnfa76pfcZLmcfl_Array || window.Array`, etc.). Detector hook: `Object.keys(window).some(k => /^cdc_[a-zA-Z0-9]{22}_(Array|Object|Promise|Proxy|ShadowRoot|Symbol|JSON|Window)$/.test(k))` — the prefix is randomised by undetected-chromedriver (§9) but the `_Array/_Object/...` suffix pattern survives unless the whole block is patched out. The older `document.$cdc_asdjflasutopfhvcZLmcfl_` marker was **not** found in current source (uncertain/historic).

### 8.2 Launch switches (`chrome_launcher.cc`) — confirmed

`kCommonSwitches`: `embedder_support::kDisablePopupBlocking` (= `disable-popup-blocking`), `enable-automation`, `allow-pre-commit-input`, `disable-features=IgnoreDuplicateNavs`, `disable-features=Prewarm`, `disable-background-networking`, `disable-background-timer-throttling`, `disable-backgrounding-occluded-windows`. `kDesktopSwitches`: `disable-hang-monitor`, `disable-prompt-on-repost`, `disable-sync`, `no-first-run`, `disable-background-networking`, `disable-client-side-phishing-detection`, `disable-default-apps`, `log-level=0`, `password-store=basic`, `use-mock-keychain`, **`test-type=webdriver`**, `no-service-autorun`. Transport: "if (!switches.HasSwitch("remote-debugging-port") && !switches.HasSwitch("remote-debugging-pipe")) switches.SetSwitch("remote-debugging-port", "0");" → `AutomationControlled` (§1.1) **even if `--enable-automation` is excluded**; `excludeSwitches` cannot remove `remote-debugging-port` ("excluding remote-debugging-port switch is not supported").

### 8.3 BiDi

"`webSocketUrl: true` means the WebDriver BiDi is enabled, which is run via BiDi-CDP Mapper in a dedicated tab" (chromedriver adds `disable-background-timer-throttling`). BiDi does not change the page-visible artifacts above.

### 8.4 Actions

Element clicks go through `ExecuteClickElement` → `GetElementClickableLocation` (scroll into view, centre of the element's in-view rect) → CDP mouse events; scripts via `Runtime.callFunctionOn` wrapped by `call_function.js` (W3C element key `element-6066-11e4-a52e-4f735466cecf`, shadow key `shadow-6066-11e4-a52e-4f735466cecf`). Exact move/press timings were not read (uncertain).

---

## 9. undetected-chromedriver (ultrafunkamsterdam) — confirmed from `patcher.py`, `__init__.py`

- Binary patch: `re.search(rb"\{window\.cdc.*?;\}", content)` replaced by `b'{console.log("undetected chromedriver 1337!")}'.ljust(len(target_bytes), b" ")`. Net effect: the per-document script chromedriver injects becomes `(function () {console.log("undetected chromedriver 1337!")   …   }) ();` → **no `cdc_` globals, but a `console.log("undetected chromedriver 1337!")` on every new document and once via `Runtime.evaluate` on the current document** (a page that wraps `console.log` before chromedriver's `Runtime.evaluate` fires can catch the literal string — likely, not tested). `is_binary_patched` looks for `b"undetected chromedriver"` in the driver binary; `gen_random_cdc()` exists but the current `patch_exe` uses the console.log replacement.
- Options always added: `--window-size=1920,1080`, `--start-maximized`, `--no-sandbox`, `--log-level=N`, `--lang=<lang>`; `--no-default-browser-check --no-first-run` (suppress_welcome); `--no-sandbox --test-type` (no_sandbox); headless → `--headless=new` (Chrome ≥108) else `--headless=chrome`. Chooses a free (non-zero) debugger port (`free_port()`), so Chromium's port==0 heuristic does not fire (likely).
- Headless mode extras (`_configure_headless`): if `navigator.webdriver` is truthy, injects via `Page.addScriptToEvaluateOnNewDocument` a `Proxy` over `navigator` (`has: key === "webdriver" ? false : key in target`, `get: ... ? false : ...`) and sets `Network.setUserAgentOverride` with `userAgent.replace("Headless", "")`. A proxied `navigator` is exactly what `nativeTampering`-style checks look for (`navigator.__proto__`, `Object.getOwnPropertyDescriptor(window,'navigator')` now a data property with `value`).
- Still a chromedriver: `Runtime.enable`-style serialisation effects, `--enable-automation` unless excluded, `test-type=webdriver`, remote debugging port.

---

## 10. nodriver and zendriver (CDP-only, no chromedriver)

Confirmed from `nodriver/core/{config,browser,tab,connection,element}.py` and zendriver `config.py`, `tab.py`, `connection.py`:

- Default args (nodriver): `--remote-allow-origins=*`, `--no-first-run`, `--no-service-autorun`, `--no-default-browser-check`, `--homepage=about:blank`, `--no-pings`, `--password-store=basic`, `--disable-infobars`, `--disable-breakpad`, `--disable-dev-shm-usage`, `--disable-session-crashed-bubble`, `--disable-search-engine-choice-screen`, then `--user-data-dir=<tmp uc_*>` (`tempfile.mkdtemp(prefix="uc_")`), `--disable-features=IsolateOrigins,site-per-process[,DisableLoadExtensionCommandLineSwitch]`, `--disable-site-isolation-trials` (expert), `--headless=new` (headless), `--no-sandbox` (no sandbox / root), `--remote-debugging-host=…`, `--remote-debugging-port=<free_port()>` (non-zero). **No `--enable-automation`, no `--disable-blink-features`** → `navigator.webdriver` is false natively in headful mode, true in `--headless=new` (§1.1). Zendriver adds `--disable-features=IsolateOrigins,DisableLoadExtensionCommandLineSwitch,site-per-process` always, `--user-agent=…`, `--lang=…`, optional `--webrtc-ip-handling-policy=disable_non_proxied_udp --force-webrtc-ip-handling-policy`, optional `--disable-webgl --disable-webgl2`.
- No `Runtime.enable`: `connection.py` never enables domains; `Tab` only sends `Page.enable` (expert mode / navigation helpers) and `DOM.enable`/`Overlay.enable` for element work. Hence immune to the Runtime.enable leak but the headless UA is handled by `_prepare_headless`: `Network.setUserAgentOverride(user_agent=ua.replace("Headless", ""))` (UA-CH brands remain unpatched — likely still contain `HeadlessChrome`, uncertain).
- Expert mode (`expert=True`) injects on every document: `console.log("hooking attachShadow"); Element.prototype._attachShadow = Element.prototype.attachShadow; Element.prototype.attachShadow = function () { console.log('calling hooked attachShadow'); return this._attachShadow( { mode: "open" } ); };` → `Element.prototype._attachShadow` exists and `attachShadow.toString()` is non-native (strong marker, expert mode only).
- Element actions: `Element.click()` = `Runtime.callFunctionOn("(el) => el.click()", userGesture=True)` after `flash(0.25)` (which injects a temporary highlight element) → **`isTrusted === false` click**. `Element.mouse_click()`/`Tab.mouse_click(x,y)` dispatch `mousePressed`+`mouseReleased` **without a prior `mouseMoved`** (no hover/mousemove history). `Tab.mouse_move(x,y,steps=10)` interpolates linearly. `send_keys()` focuses via JS then sends `Input.dispatchKeyEvent("char", text=char)` per character — **`char` events only, no `keydown`/`keyup`** (a page sees `keypress`/`input` without `keydown`). `scroll_down(amount=25)` = `Input.synthesizeScrollGesture(x=0, y=0, y_distance=-(window.height*amount/100), prevent_fling=True, repeat_delay_ms=0, speed=7777)`. `scroll_into_view` = `DOM.scrollIntoViewIfNeeded`.
- Zendriver README claims "Chrome Devtools Protocol instead of Selenium/WebDriver, making it (almost) impossible to detect"; no test matrix is published.

---

## 11. Camoufox (daijro/camoufox) — Firefox fork

Confirmed from README and `browser/patches/*`, `python/src/camoufox/utils.py`:

- Fingerprint is injected at C++ level from a JSON config passed through environment variables: `env_vars[f"CAMOU_CONFIG_{(i // chunk_size) + 1}"] = config_str[i : i + chunk_size]` (README: "The identity goes to the browser as the `CAMOU_CONFIG` environment variable"; "the browser reports it from C++, so a page sees native values rather than JavaScript overrides"). Identity source is fpgen (scrapfly/fingerprint-generator), not BrowserForge.
- Patch set: `navigator-spoofing`, `screen-spoofing`, `fingerprint-injection`, `font-list-spoofing`, `anti-font-fingerprinting`, `audio-context-spoofing`, `media-codec-spoofing`, `media-device-spoofing`, `speech-voices-spoofing`, `timezone-spoofing`, `locale-spoofing`, `geolocation-spoofing`, `touchscreen-fingerprint-spoofing`, `force-default-pointer`, `shadow-root-bypass`, `debugger-invisible-to-content` (`isDebuggeeVisibleToContent`, `allDebuggersInvisibleToContent` → hides Juggler/devtools debugger presence from SpiderMonkey realm checks), `trusted-automation-events` (`event->SetTrusted(true)` for automation-dispatched events → `isTrusted` true), `playwright/0-playwright.patch`, `playwright/1-leak-fixes.patch`.
- `1-leak-fixes.patch` replaces `Navigator::Webdriver()` body (which in Playwright's Firefox build ends with "Playwright is automating the browser, so we should pretend to be a webdriver / return true;") with `return false;`.
- Juggler "runs its page agent in an isolated world, so the page never sees automation code"; Playwright's evaluate/selectors/init scripts "run in an isolated world the page cannot see".
- Python launcher: default addon uBlock Origin (`DefaultAddons.UBO`), `headless='virtual'` → private Xvfb display; `'virtual-gpu'` → Xorg on a named GPU; `humanize` cursor movement replays one of "Cursory's 2356 recorded human movements"; WebRTC "ICE candidates, SDP and `getStats()` rewritten to the proxy IP".
- Explicitly not spoofed: canvas pixels ("noise would only mark the browser as a spoofer"), text widths, audio rendering; README: "Thousands of values must agree with each other, and anti-bot vendors look for the one that does not", and some WAFs "test SpiderMonkey engine behavior, which spoofing cannot turn into Chromium".
- Detection angles (likely): Firefox engine behaviour vs claimed OS/hardware coherence; uBlock Origin presence (blocked requests/`:has()` filters); Xvfb display characteristics; the `trusted-automation-events` patch makes Camoufox the only stack whose JS-dispatched events are trusted — a page cannot use `isTrusted` against it.

---

## 12. Browser Use (`browser-use/browser-use`, 0.9-era, CDP-native via `cdp-use`)

### 12.1 Launch

`browser_use/browser/profile.py` (confirmed): `CHROME_DEFAULT_ARGS` mirrors Playwright's switches plus "added by us": `--enable-features=NetworkService,NetworkServiceInProcess`, `--enable-network-information-downlink-max`, `--disable-sync`, `--allow-legacy-extension-manifests`, `--allow-pre-commit-input`, **`--disable-blink-features=AutomationControlled`**, `--install-autogenerated-theme=0,0,0`, `--log-level=2`, `--disable-focus-on-load`, `--disable-window-activation`, `--generate-pdf-document-outline`, `--no-pings`, `--ash-no-nudges`, `--disable-infobars`, `--simulate-outdated-no-au="Tue, 31 Dec 2099 23:59:59 GMT"`, `--hide-crash-restore-bubble`, `--suppress-message-center-popups`, `--disable-domain-reliability`, `--disable-datasaver-prompt`, `--disable-speech-synthesis-api`, `--disable-speech-api`, `--disable-print-preview`, `--safebrowsing-disable-auto-update`, `--disable-external-intent-requests`, `--disable-desktop-notifications`, `--noerrdialogs`, `--silent-debugger-extension-api`, `--disable-extensions-http-throttling`, `--extensions-on-chrome-urls`, `--disable-default-apps`, `--disable-features=<CHROME_DISABLED_COMPONENTS>` (includes `AutomationControlled`, `BackForwardCache`, `OptimizationHints`, `ProcessPerSiteUpToMainFrameThreshold`, `InterestFeedContentSuggestions`, `CalculateNativeWinOcclusion`, `HeavyAdPrivacyMitigations`, `PrivacySandboxSettings4`, `AutofillServerCommunication`, `CrashReporting`, `OverscrollHistoryNavigation`, `InfiniteSessionRestore`, `ExtensionDisableUnsupportedDeveloper`, `ExtensionManifestV2Unsupported`, `ExtensionManifestV2Disabled`, `GlobalMediaControls`, `HttpsUpgrades`, `ImprovedCookieControls`, `LazyFrameLoading`, `LensOverlay`, `MediaRouter`, `PaintHolding`, `ThirdPartyStoragePartitioning`, `Translate`). Note `--hide-scrollbars` is deliberately **not** used ("leave them visible! the agent uses them"). `ignore_default_args` default: `--enable-automation` ("we mask the automation fingerprint via JS and other flags"), `--disable-extensions`, `--hide-scrollbars`, Playwright's `--disable-features=…`.
- `CHROME_HEADLESS_ARGS = ['--headless=new']`; `CHROME_DOCKER_ARGS` (`--no-sandbox`, `--disable-gpu-sandbox`, `--disable-setuid-sandbox`, `--disable-dev-shm-usage`, `--no-xshm`, `--no-zygote`, `--disable-site-isolation-trials`); `CHROME_DETERMINISTIC_RENDERING_ARGS` (`--deterministic-mode`, `--js-flags=--random-seed=1157259159`, `--force-device-scale-factor=2`, `--enable-webgl`, `--font-render-hinting=none`, `--force-color-profile=srgb`).
- Window/viewport: `--window-size=W,H` if `window_size`, else `--start-maximized` when headful; `detect_display_configuration()`: `self.screen = self.screen or display_size or ViewportSize(width=1920, height=1080)`; headless → `viewport = viewport or window_size or screen` (so **1920×1080** on a display-less server); headful → `no_viewport=True` by default. `headless` default: `BROWSER_USE_HEADLESS` env else `not has_screen_available`.
- Local launch: Chrome subprocess with `--remote-debugging-port=<free port>` and a non-default `--user-data-dir` (`local_browser_watchdog.py:112-120`); executable preference custom → system/Playwright Chromium (`BROWSERUSE_DEFAULT_CHANNEL = BrowserChannel.CHROMIUM`). Headless + `--headless=new` → UA has `HeadlessChrome` (Browser Use does not strip it; `user_agent` only when set by the user).
- CDP: `Target.setAutoAttach { autoAttach: True, waitForDebuggerOnStart: False, flatten: True }`; enabled domains in the core session: `Page`, `Network`, `DOM`, `Fetch` (auth/proxy), `DOMStorage`, `Log`; **`Runtime.enable` only in `browser_use/actor/page.py` and the OpenAI/Anthropic integrations**, not in the main agent loop.

### 12.2 DOM harvesting (no injected tree-builder any more)

`dom/service.py`: `Accessibility.getFullAXTree` + `DOMSnapshot.captureSnapshot` + `Runtime.evaluate` in the **main world** for `document.readyState`, iframe scroll offsets, and click-listener discovery using the DevTools command-line API:

```python
'includeCommandLineAPI': True,  # enables getEventListeners()
```

with the marker constant `_JS_CLICK_LISTENER_OVERFLOW = '__browser_use_too_many_click_listeners__'` (returned, not stored on `window`). The historic `buildDomTree.js` with `#playwright-highlight-container` / `browser-user-highlight-id` is gone (only a test comment remains) — treat those as *legacy Browser Use ≤0.4 / forks* indicators.

### 12.3 DOM injections (confirmed, `browser/session.py`)

- **Interaction highlight, default ON** (`highlight_elements=True`, colour `rgb(255, 127, 39)`, 1.0 s): on every click/type the session evaluates a script that appends `<div data-browser-use-interaction-highlight="true" style="position:absolute; … z-index: 2147483647">` with four animated corner-bracket children to `document.body`; coordinate clicks add `data-browser-use-coordinate-highlight`. Cleanup removes `[data-browser-use-highlight]`, `#browser-use-debug-highlights`, `[data-browser-use-highlight="tooltip"]`.
- Debug DOM highlights (`dom_highlight_elements`, default False): container `id="browser-use-debug-highlights"`, `data-browser-use-highlight="container"`, children `data-browser-use-highlight="element"` + `data-element-id`, `console.log('=== BROWSER-USE HIGHLIGHTING ===')`.
- Demo mode panel (`demo_mode.py`): `#browser-use-demo-panel`, `#browser-use-demo-panel-style`, `#browser-use-demo-toggle`, attribute `data-browser-use-exclude-<SESSION_ID>`, CSS var `--browser-use-demo-panel-width`, classes `browser-use-demo-*`.
- Default agent highlights are drawn onto the **screenshot** in Python (`python_highlights.py`), not into the DOM.

### 12.4 Input signatures (`watchdogs/default_action_watchdog.py`, confirmed)

- Click: `DOM.scrollIntoViewIfNeeded` → centre of `DOM.getBoxModel` content quad → `Input.dispatchMouseEvent {type:'mouseMoved', x, y}` → `asyncio.sleep(0.05)` → `{type:'mousePressed', button:'left', clickCount:1}` → `asyncio.sleep(0.08)` → `{type:'mouseReleased', …}`. If the element is occluded: `Runtime.callFunctionOn('function() { this.click(); }')` (untrusted click). Triple-click selection uses `clickCount: 3`.
- Typing into an element: per character `keyDown` / `char` / `keyUp` with `asyncio.sleep(0.001)` between (≈1 ms cadence, i.e. ~1000 cps; "Small delay between characters to look human" is 1 ms); then `_trigger_framework_events` dispatches **synthetic** `new InputEvent('input', { bubbles:true, cancelable:true, data: element.value, inputType: 'insertText' })`, `new Event('change')`, `new Event('blur')` via `element.dispatchEvent` (all `isTrusted === false`, `data` = the entire value). Typing to the page (no element): 10 ms per key.
- Scroll: `_scroll_with_cdp_gesture(pixels)` → `Input.synthesizeScrollGesture { x: viewport_w/2, y: viewport_h/2, xDistance: 0, yDistance: -pixels, speed: 50000 }`; default step `pixels = int(params.pages * viewport_height)` (one viewport height per page); container scroll via `Input.dispatchMouseEvent {type:'mouseWheel', deltaY: pixels}` at the element centre; JS fallback otherwise.
- Everything is dispatched through CDP (trusted) except the fallbacks above.

---

## 13. Stagehand (browserbase/stagehand, current main = v4 "Stagehand Runtime")

Confirmed from the current tree (`packages/{cli,docs,evals,examples,extension,integrations,protocol,sdk-python,sdk-ts}`):

- Architecture: SDKs (TS/Python/Go) → local Chrome or Browserbase (`DEFAULT_BROWSERBASE_URL = "https://api.browserbase.com"`) → a Chrome extension named **"Stagehand Runtime"** (`manifest.json`: MV3, `minimum_chrome_version: "116"`, permissions `debugger, offscreen, scripting, tabs`, `host_permissions: <all_urls>`, content script `content-script.js` at `document_start`, `all_frames: true`, `world: "ISOLATED"`, `match_about_blank`) containing "understudy", a CDP driver. README: "Stagehand runs as an extension next to the browser, cutting round-trip latency on every action."
- Content script (ISOLATED world) defines `__stagehandExtensionWorld = { name: "stagehand", version: "stagehand.v4" }`, `__stagehandLocatorScripts`, `__stagehandLocatorWorld { kind, closedShadowRoots }` — in the extension's isolated world only (not visible to page JS). Fallback isolated world name `__stagehand_locator_fallback__` (`executionContextRegistry.ts:21`); health check uses `chrome.dom.openOrClosedShadowRoot` (closed shadow root access).
- CDP usage: `Runtime.enable` is sent liberally (`frame.ts`, `locator.ts`, `page.ts`, `a11y/*`) → the Runtime.enable leak applies; `Page.addScriptToEvaluateOnNewDocument { source }` for user init scripts (main world); `Page.createIsolatedWorld` for the locator world; a11y snapshots via `Accessibility` domain.
- Click (`understudy/locator.ts:395-455`): `DOM.scrollIntoViewIfNeeded {objectId}` → `DOM.getBoxModel` → centre of content quad → pipelined burst `mouseMoved (button:'none')`, `mousePressed`, `mouseReleased` ("Dispatch click events in a pipelined burst to reduce inter-click delay") — zero intentional delay. `page.ts:1905-1950` same for coordinate clicks.
- Type (`locator.ts:672-720`): focus via `Runtime.callFunctionOn(focusElement)`; without delay **`Input.insertText {text}`** (single insert); with delay `keyDown`+`keyUp` per char (`text: ch, key: ch`, no `char`/`code`/`windowsVirtualKeyCode`).
- Optional cursor overlay installed in the locator world (`__stagehandLocatorScripts.installCursorOverlay()`, element id constant `CURSOR_OVERLAY_ID` — value not captured) but the element is appended to the page DOM (visible to page JS even though the script runs isolated).
- Local launch (`sdk-ts/src/browser/localBrowser.ts`): spawns Chrome with a `--remote-debugging-port=<port>` (non-zero) and a profile dir → `cdpUrl = http://127.0.0.1:${port}`; no `--enable-automation`. Default viewport/headless not captured (uncertain).
- Historic (v1/v2, Playwright-based) artifacts such as `window.__stagehandInjected`, `getScrollableElementXpaths`, `processDom` were **not found** in the current repo (GitHub code search empty) — treat as legacy/uncertain.

---

## 14. Skyvern (Skyvern-AI/skyvern, Playwright-based)

Confirmed from `skyvern/webeye/*`, `skyvern/config.py`:

- Launch (`browser_factory.py`): `args = ["--disable-blink-features=AutomationControlled", "--disk-cache-size=1", "--start-maximized", "--kiosk-printing"]` (+ `--remote-debugging-port=<cdp_port>`, `--load-extension`), `ignore_default_args: ["--enable-automation"]`, `color_scheme: "no-preference"`, HAR recording (`record_har_path`), video recording (`record_video_dir`), `viewport: {width: settings.BROWSER_WIDTH (1920), height: settings.BROWSER_HEIGHT (1080)}`, `extra_http_headers`, `locale`, `timezone_id` from proxy location. Default `BROWSER_TYPE = "chromium-headful"`; Playwright's `--remote-debugging-pipe` remains → `navigator.webdriver` true unless the blink flag applies (it does, flag above).
- DOM harvesting: `domUtils.js` (`JS_FUNCTION_DEFS`) is evaluated **in the main world** via `frame.evaluate(expression=JS_FUNCTION_DEFS)` (`utils/page.py:772-779`) or, when a "main world prefix" is configured, via a raw `Runtime.evaluate` on a fresh CDP session with the opaque prefix prepended (`main_world_eval.py`: "so middleware that inspects script content sees the prefix intact"; `replMode` for lexical declarations). Because Playwright string-evaluate is an indirect `eval` (§2.5), the top-level declarations in `domUtils.js` become **window globals** (likely): `isElementVisible`, `expectHitTarget`, `isInteractable`, `buildElementObject`, `buildTreeFromBody`, `buildElementTree`, `drawBoundingBoxes`, `buildElementsAndDrawBoundingBoxes`, `captchaSolvedCallback`, `getCaptchaSolves`, `groupElementsVisually`, `getDOMElementBySkyvenElement`, `uniqueId`, `ownUniqueId`, `stampOtpInputBoxes` … Explicit globals (confirmed): `window.elementIdCounter`, `window.GlobalSkyvernFrameIndex`, `window.GlobalEnableAllTextualElements`, `window.globalHoverStylesMap`, `window.globalOneTimeIncrementElements`, `window.globalIncrementalJobCount`, `window.globalDomDepthMap`, `window.globalParsedElementCounter`, `window.globalObserverForDOMIncrement` (a `MutationObserver`), `window.globalListnerFlag`, `window.globalIncrementalSession`.
- DOM attributes/elements (confirmed): every interactable element gets `unique_id="<frame-prefix><id>"` (`element.setAttribute("unique_id", fresh)`; lookups `document.querySelector(\`[unique_id="…"]\`)`); OTP inputs get `data-skyvern-otp-box="1"` / `data-skyvern-otp-filled`; bounding-box debug container `id="boundingBoxContainer"`; elements with `data-pw-overlay` are skipped during scraping.
- Cursor overlay for recordings (`scraper/cursorOverlay.js`): "No product-specific naming — only generic __pw-* identifiers": `<div id="__pw-cursor" data-pw-overlay>` (20 px red dot, z-index 2147483647), `@keyframes __pw-trail-fade`, `__pw-click-ring`, `window.__PW_CURSOR_VIS__`, `window.__pw_trails`, functions `__pwCursorInit`, `__pwCursorMove` — deliberately mimics Playwright naming; detector should treat `__pw-cursor` as Skyvern, not Playwright.
- Actions (`actions/handler.py`, `handler_utils.py`): element clicks via Playwright `locator.click(timeout=…, position=point)`; coordinate actions `page.mouse.click(x=action.x, y=action.y, button=…)` and `click_count=3`; `scroll_into_view` before actions; text input `input_sequentially` = `locator.fill()` then `press_sequentially(delay=…)` for the remainder (per-char key events); checkbox verification via `is_checked`.
- `window.scroll`/`scrollTo` used by domUtils for scrolling during scraping (main-world JS scroll).

---

## 15. Chrome DevTools MCP (ChromeDevTools/chrome-devtools-mcp, Puppeteer-based)

Confirmed from `src/BrowserManager.ts`, `src/TextSnapshot.ts`, `src/tools/input.ts`, docs:

- Launch: `puppeteer.launch({ channel: 'chrome' | 'chrome-<channel>', defaultViewport: null, userDataDir, pipe: true, headless, args, ignoreDefaultArgs, acceptInsecureCerts, handleDevToolsAsPage: true, enableExtensions, handleSIGINT:false, … })` with `args = [...chromeArg, '--proxy-server=…', '--hide-crash-restore-bubble', headless ? '--screen-info={3840x2160}' : '', devtools ? '--auto-open-devtools-for-tabs' : '']`. So: Puppeteer default flags (`--enable-automation`, `--disable-popup-blocking`, …) + `--remote-debugging-pipe` → `navigator.webdriver = true`; real **Google Chrome stable** (not Chrome for Testing); headed by default (`--headless` default `false`); no viewport emulation; profile `$HOME/.cache/chrome-devtools-mcp/chrome-profile[-<channel>]` unless `--isolated`; `--autoConnect` attaches to a running Chrome 144+ with remote debugging enabled from `chrome://inspect/#remote-debugging`.
- Snapshot uids: `` `${snapshotId}_${idCounter++}` `` (e.g. `3_17`), from the a11y tree (`take_snapshot`).
- Actions: `click` → Puppeteer `handle.asLocator().click()` (Locator waits visible/enabled/stable, scrolls into view, clicks the centre); `fill` → `asLocator().fill(value)`; `type_text` → `page.pptrPage.keyboard.type(text)` (no delay); `click_at` (`--experimentalVision`) → `page.pptrPage.mouse.click(x, y)`; `press_key` → keyboard; `drag`, `hover`, `upload_file`, `handle_dialog`, `emulate` (`networkConditions`, `cpuThrottlingRate`, `viewport "<w>x<h>x<dpr>[,mobile][,touch][,landscape]"`, `geolocation`, `userAgent`, `extraHttpHeaders`, `colorScheme`), `resize_page`, `evaluate_script`, `navigate_page` (`initScript` option), `new_page`, `list_pages`, `wait_for`, `take_screenshot`, console/network/performance/lighthouse/heap tools.
- Telemetry: "Google collects usage statistics … To opt-out, run with --no-usage-statistics"; performance tools "may send trace URLs to the Google CrUX API".

---

## 16. Browser MCP (BrowserMCP/mcp + Chrome extension)

- README: "Browser MCP was adapted from the Playwright MCP server"; "Uses your existing browser profile, keeping you logged into all your services"; "Avoids basic bot detection and CAPTCHAs by using your real browser fingerprint."
- Extension: `https://browsermcp.io/install` redirects to `https://chromewebstore.google.com/detail/bjfgambnhccakkhmkepdoekmckoijdlc` → extension ID **`bjfgambnhccakkhmkepdoekmckoijdlc`** (confirmed via redirect).
- Server (`src/index.ts`): tools `browser_navigate`, `browser_go_back`, `browser_go_forward`, `browser_snapshot`, `browser_click`, `browser_hover`, `browser_type`, `browser_select_option`, `browser_press_key`, `browser_wait`, `browser_get_console_logs`, `browser_screenshot`; a local `WebSocketServer({ port: mcpConfig.defaultWsPort })` relays to the extension (the port constant lives in the private `@repo/config` package — **port value uncertain**).
- Artifacts: the user's real Chrome, driven by an extension (content-script/`chrome.debugger` based — not verified which). Expect Playwright-MCP-style aria `ref` targeting and real-profile fingerprints; no launch-flag artifacts.

---

## 17. Nanobrowser (nanobrowser/nanobrowser, Chrome extension)

Confirmed from `src/`:

- Store IDs: Chrome Web Store `imbddededgmcgfhfpcjmijokokekbkal`, Edge Add-ons `ajdioenfpgabnjlclgckbbnjjhdnjkhn`.
- Drives tabs with `puppeteer-core` over `ExtensionTransport.connectTab(tabId)` (`chrome.debugger`) and `connect({ transport, defaultViewport: null, protocol: 'cdp' })`.
- Isolated probe world: `PROBE_WORLD_NAME = 'nanobrowser-probe'`, defines `globalThis.__nbProbe` there (not visible to page JS).
- Visible overlay: a page border injected through `chrome.scripting.executeScript` in the extension's isolated world — `<div aria-hidden="true" data-nanobrowser-border style="all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;…">` with a **closed** shadow root (`host.attachShadow({ mode: 'closed' })`); the host element is page-visible via `document.querySelector('[data-nanobrowser-border]')`.
- Input: `mouseMoved` then `mousePressed`/`mouseReleased` (dialog-guarded, `clickCount` loop), hover = `mouseMoved`, wheel = `mouseWheel {deltaX, deltaY}` at a point, `DOM.scrollIntoViewIfNeeded` before actions, typing via `Input.dispatchKeyEvent` + `Input.insertText {text: value}`.
- The old `buildDomTree.js` port with `playwright-highlight-container` is gone from the current tree (GitHub code search empty).
- Chrome shows the "… is debugging this browser" infobar while `chrome.debugger` is attached (standard Chrome behaviour; not page-visible).

---

## 18. Magentic-UI (microsoft/magentic-ui) and AutoGen MultimodalWebSurfer

Confirmed:

- Viewport `1440×900` (`playwright_controller_fara.py:273-274`; AutoGen `VIEWPORT_WIDTH = 1440`, `VIEWPORT_HEIGHT = 900`); Docker browser runs `Xvfb :N -screen 0 1440x900x24` and launches Chrome with `--disable-blink-features=AutomationControlled --disable-dev-shm-usage --disable-features=Translate,BackForwardCache,MediaRouter,OptimizationHints,AcceptCHFrame --disable-background-networking …`; local launch `chromium.launch(headless=False, args=["--disable-extensions", "--disable-file-system"])`.
- `page_script.js` is evaluated in the **main world** (`await page.evaluate(self._page_script)` in `webpage_text_utils.py`; AutoGen uses `page.add_init_script(path=page_script.js)`) → global `var WebSurfer = …` (Magentic-UI) / `var MultimodalWebSurfer = …` (AutoGen) with `getInteractiveRects`, `getVisualViewport`, `getFocusedElementId`, `getPageMetadata`; every interactive element receives `setAttribute("__elementId", "" + (nextLabel++))` → `document.querySelectorAll('[__elementId]')` is a direct detector.
- Clicks: `page.mouse.click(x, y, delay=10)` at element centre (10 ms press); typing `page.keyboard.type(value, delay=100 if len(value) < 100 else 10)`; scroll `page.mouse.wheel(0, viewport_height - 50)`; right-click/triple-click via `button="right"` / `click_count=3`.
- `animate_actions=True` appends `<div id="red-cursor" style="width:10px;height:10px;background-color:red;position:absolute;border-radius:50%;z-index:10000">` and animates it.

---

## 19. OpenAI Agents SDK computer tool example (`examples/tools/computer_use.py`, `LocalPlaywrightComputer`)

Confirmed: `dimensions = (1024, 768)`; `chromium.launch(channel=BROWSER_CHANNEL ("chromium" default), headless=HEADLESS (default True unless COMPUTER_USE_HEADLESS=0), args=["--window-size=1024,768"])`, `page.set_viewport_size({"width":1024,"height":768})`; `click` → `page.mouse.click(x, y, button=…)` (no delay), `double_click` → `mouse.dblclick`, `scroll` → `page.mouse.move(x, y)` then **`page.evaluate(f"window.scrollBy({scroll_x}, {scroll_y})")`** (instant programmatic scroll, no wheel events), `type` → `page.keyboard.type(text)` (no delay), `keypress` → `keyboard.down/up`, `drag` → move/down/move…/up, `wait` = 1 s. (The `openai/openai-cua-sample-app` repository no longer contains the Python `computers/` package; it is now a Node console.)

## 20. Anthropic computer-use-demo (`anthropics/anthropic-quickstarts`)

Confirmed: Docker image with `Xvfb $DISPLAY -ac -screen 0 ${WIDTH}x${HEIGHT}x24 -retro -dpi $DPI -nolisten tcp -nolisten unix`, `WIDTH=1024`, `HEIGHT=768`, `DISPLAY_NUM=1`, `firefox-esr`, `mutter`, `tint2`, `x11vnc`, noVNC 1.5.0. `computer.py`: `xdotool mousemove --sync X Y`, `click 1|2|3`, `double_click: --repeat 2 --delay 10 1`, `triple_click: --repeat 3 --delay 10 1`, drag `mousemove --sync x y mousedown 1 mousemove --sync x y mouseup 1`, `type --delay 12 -- <50-char chunks>` (`TYPING_DELAY_MS = 12`, `TYPING_GROUP_SIZE = 50`), `key -- <keysym>`, scroll `click --repeat {scroll_amount} {4|5|6|7}` (with optional `keydown`/`keyup` modifier), screenshots via `gnome-screenshot -f … -p` or `scrot -p`, coordinates scaled to `XGA 1024x768` / `FWXGA 1366x768`. Page-visible profile: a stock Firefox ESR on Linux/Xvfb at 1024×768, OS-level input (trusted events, constant 12 ms key cadence, pixel-exact `mousemove --sync` jumps with no intermediate motion).

---

## 21. Crawl4AI (unclecode/crawl4ai)

Confirmed from `browser_manager.py`, `async_crawler_strategy.py`, `browser_adapter.py`, `async_configs.py`, `js_snippet/`:

- Defaults: `browser_type="chromium"`, `headless=True`, `viewport_width=1080`, `viewport_height=600`, `user_agent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/116.0.0.0 Safari/537.36"` (note: **no "(KHTML, like Gecko)" token and Chrome 116** — a malformed, outdated UA that is itself a strong signal; `user_agent_mode="random"` uses `ValidUAGenerator` with the same fallback), `enable_stealth=False`.
- Managed/persistent browser flags: `--no-sandbox`, `--disable-dev-shm-usage`, `--no-first-run`, `--no-default-browser-check`, `--disable-infobars`, `--window-position=0,0` / `400,0`, **`--disable-blink-features=AutomationControlled`**, `--disable-renderer-backgrounding`, `--disable-ipc-flooding-protection`, `--force-color-profile=srgb`, `--mute-audio`, `--disable-background-timer-throttling`, `--disable-features=MediaRouter,DialMediaRouteProvider`, `--disable-component-update`, `--disable-domain-reliability`, plus `--disable-gpu --disable-gpu-compositing --disable-software-rasterizer` **unless stealth** ("GPU flags disable WebGL which anti-bot sensors detect as headless"), `--headless=new`, `--window-size=W,H`, `--remote-debugging-port=<port>`, `--user-data-dir`.
- `js_snippet/navigator_overrider.js` (injected with `context.add_init_script` when `override_navigator`, `simulate_user` or `magic` is set): patches `navigator.permissions.query` for `notifications`, `Object.defineProperty(navigator, "webdriver", { get: () => undefined })` (→ `typeof navigator.webdriver === 'undefined'`, own property on the instance), `window.navigator.chrome = { runtime: {} }`, `navigator.plugins` → `[1, 2, 3, 4, 5]` (array of numbers, not a `PluginArray`), `navigator.languages` → `["en-US","en"]`, `document.hidden` → false, `document.visibilityState` → `"visible"`. All are trivially detectable (`Object.getOwnPropertyDescriptor(navigator,'webdriver')`, `navigator.plugins instanceof PluginArray === false`, `navigator.plugins[0] === 1`).
- `flatten_shadow_dom` option overrides `Element.prototype.attachShadow` to force `mode: 'open'` (non-native `attachShadow.toString()`).
- `enable_stealth=True` → `playwright_stealth.Stealth().apply_stealth_async(page)`; "undetected" mode → `patchright` (`UndetectedAdapter`, evaluates in isolated context).
- Other main-world scripts run on demand: `remove_overlay_elements`, `remove_consent_popups`, `update_image_dimensions`.

## 22. Firecrawl (firecrawl/firecrawl)

Confirmed: `apps/playwright-service-ts/api.ts` launches `chromium.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-accelerated-2d-canvas','--no-first-run','--no-zygote','--disable-gpu'] })` (stock Playwright → `HeadlessChrome` UA unless overridden, `navigator.webdriver` true), per-context `userAgent = userAgentOverride || new UserAgent().toString()` (random UA from the `user-agents` npm package — UA/platform/UA-CH mismatch expected), `viewport = { width: 1280, height: 800 }`, `serviceWorkers: 'block'`, traffic via a local SSRF proxy. The API's `fetch` engine uses `undici.fetch(url, { headers: meta.options.headers })` (no explicit UA → undici's default, uncertain). robots.txt is evaluated for the tokens `["FireCrawlAgent", "FirecrawlAgent"]` (`lib/robots-txt.ts:140`). Firecrawl publishes **no** crawler UA string or egress IP ranges (open issue #656); the Advanced Scraping Guide only documents the robots token.

## 23. Scrapling (D4Vinci/Scrapling)

Confirmed from `engines/constants.py`, `_browsers/_base.py`, `_browsers/_stealth.py`, `toolbelt/fingerprints.py`: current browser fetchers run on **patchright** (`driven_browser_version(package="patchright")`, Chromium ≥149 header generation via `browserforge`). `HARMFUL_ARGS` removed: `--enable-automation`, `--disable-popup-blocking`, `--disable-component-update`, `--disable-default-apps`, `--disable-extensions`. `DEFAULT_ARGS`: `--no-pings --no-first-run --disable-infobars --disable-breakpad --no-service-autorun --homepage=about:blank --password-store=basic --disable-hang-monitor --no-default-browser-check --disable-session-crashed-bubble --disable-search-engine-choice-screen`. `STEALTH_ARGS` (StealthyFetcher) include `--test-type`, `--mute-audio`, `--hide-scrollbars`, `--start-maximized` ("For headless check bypass"), `--window-position=0,0`, `--disable-blink-features=AutomationControlled`, `--enable-features=NetworkService,NetworkServiceInProcess,TrustTokens,TrustTokensAlwaysAllowIssuance`, **`--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4`** (forced even when headful), `--disable-features=AudioServiceOutOfProcess,TranslateUI,BlinkGenPropertyTrees`, `--font-render-hinting=none`, `--force-color-profile=srgb`; options add `--webrtc-ip-handling-policy=disable_non_proxied_udp --force-webrtc-ip-handling-policy`, `--disable-webgl --disable-webgl-image-chromium --disable-webgl2`, `--fingerprinting-canvas-image-data-noise`, `--dns-over-https-templates=https://cloudflare-dns.com/dns-query`, `--lang=<locale> --accept-lang=<locale>,<base>` ("The context `locale` option patches the main thread only … WAFs like Cloudflare flag the mismatch"). Headless runs set `user_agent` to a built-in default (`__default_chrome_useragent__`/`__default_useragent__`, values not captured). Built-in Cloudflare challenge detection (`cType: 'managed'`, Turnstile script). Older Scrapling versions used Camoufox for `StealthyFetcher`; the current `_stealth.py` does not import it (uncertain whether an option remains).

## 24. Lightpanda (lightpanda-io/browser, Zig headless browser)

Confirmed via GitHub code search: `src/Config.zig`: `const user_agent_base: [:0]const u8 = "Lightpanda/1.0";` with optional `user_agent_suffix` / `user_agent` overrides; `src/network/HttpClient.zig`: `transfer.setHeader("User-Agent", "Lightpanda/1.0", …)`; `src/browser/webapi/Navigator.zig`: `navigator.userAgent` returns `exec.session.browser.http_client.getUserAgent()` → **page JS sees `Lightpanda/1.0`** (plus suffix) unless configured; the Worker navigator matches. The CDP server lies to automation clients: `src/server/cdp/domains/browser.zig`: `CDP_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"`, `PRODUCT = "Chrome/124.0.6367.29"` ("used by the CDP server only to identify itself to" Puppeteer). README: "No graphical rendering engine", "Not based on Chromium, Blink, or WebKit", "16x lighter and 9x faster than Chromium"; coverage via Web Platform Tests. Detector hooks: UA `Lightpanda/`; absence of layout/paint APIs (no real `getBoundingClientRect` geometry, no WebGL/canvas pixels, no screenshots) — the specific gaps should be probed empirically (uncertain).

## 25. Hosted browsers

| Provider | Confirmed facts | Source |
|---|---|---|
| Browserbase | Standard sessions: "non-Verified sessions always use `linux`"; Verified (Scale plan): "purpose-built Chromium browser with real browser fingerprints", "default to the `windows` operating system", enabled with `browserSettings.verified: true`; `advancedStealth`: "Deprecated: use `verified` instead"; `solveCaptchas` "Defaults to `true`"; `recordSession`/`logSession` default true; `region` default `us-west-2`; `os` values `windows, mac, linux, mobile, tablet`; Web Bot Auth (beta) signs requests. No default viewport documented. | docs.browserbase.com stealth-mode + create-a-session |
| Steel (open source, Puppeteer) | `FingerprintGenerator({ devices:['desktop'], operatingSystems:['linux'], browsers:[{name:'chrome', minVersion:146}], locales:['en-US','en'], screen: {min/max = dimensions ?? 1920x1080} })`; UA from the generated fingerprint (UA-CH overridden via `page.setUserAgent(ua, metadata)`, fallback `fixedUaFullVersion: "131.0.6778.86"`, `fixedPlatformVersion "15.0.0"`); flags: `--remote-allow-origins=*`, `--disable-dev-shm-usage`, `--disable-gpu`, long `--disable-features=TranslateUI,BlinkGenPropertyTrees,LinuxNonClientFrame,PermissionPromptSurvey,IsolateOrigins,site-per-process,TouchpadAndWheelScrollLatching,TrackingProtection3pcd,InterestFeedContentSuggestions,PrivacySandboxSettings4,AutofillServerCommunication,OptimizationHints,MediaRouter,DialMediaRouteProvider,CertificateTransparencyComponentUpdater,GlobalMediaControls,AudioServiceOutOfProcess,LazyFrameLoading,AvoidUnnecessaryBeforeUnloadCheckSync,DisableLoadExtensionCommandLineSwitch,DisableDisableExtensionsExceptCommandLineSwitch`, `--enable-features=Clipboard`, `--webrtc-ip-handling-policy=disable_non_proxied_udp`, `--force-webrtc-ip-handling-policy`, `--disable-touch-editing`, `--disable-touch-drag-drop`, `--ozone-platform=x11`, `--use-gl=swiftshader`, `--in-process-gpu`, `--force-device-scale-factor=1`, `--remote-debugging-port=9222`, `--window-size=1920,1080`, headless: `--headless=new --hide-crash-restore-bubble --disable-blink-features=AutomationControlled`; `ignoreDefaultArgs: ["--enable-automation"]`, `defaultViewport: null`; dimensions default `{1920,1080}`; `--kiosk` when fullscreen. | steel-browser `api/src/services/cdp/cdp.service.ts` |
| Hyperbrowser | `useStealth` (default false) "applies anti-detection techniques"; `useUltraStealth` enterprise-only; `screen.width` default 1280, `height` 720; `solveCaptchas`, `adblock`, `trackers`, `annoyances` default false; `proxyCountry` default US; `enableWebRecording` default true (rrweb). | hyperbrowser.ai/docs/sessions/{stealth,parameters} |
| Kernel | "Kernel browsers ship in `headful` mode by default"; default viewport "1920x1080 at 25Hz"; "Every Kernel browser launches with anti-detection chrome configuration applied"; "Kernel automatically applies Patchright to remove automation fingerprints, including headless indicators"; `stealth: true` "adds two managed services on top": a default ISP proxy (static exit IP per session) and an automatic CAPTCHA solver; Web Bot Auth opt-in for Startup/Enterprise plans; browsers are Chromium in per-browser unikernel VMs. | kernel.sh/docs (bot-detection overview, stealth, viewport, headless) |
| Anchor Browser | `browser.extra_stealth.active: true` ("specialized Chrome browser environment", Growth plan) **requires** `session.proxy.active: true` ("if the proxy is disabled, extra stealth is automatically disabled"); `browser.captcha_solver.active`; "When extra stealth mode is enabled, `page.on('console')` events are disabled by default"; LinkedIn warm-up; sessions connect over CDP. | docs.anchorbrowser.io/essentials/stealth |

## 26. Other agent tooling in scope

- **Vercel `agent-browser`**: "Pure Rust daemon using direct CDP, no Node.js required"; Chrome for Testing; refs `- button "Submit" [ref=e2]` used as `click @e2`; `--cdp` / `--auto-connect` to existing Chrome; `--profile` copies a Chrome profile to a temp dir; `--user-agent`; headless by default (`--headed` opens a window); stealth only via "launch mutator plugin" or experimental `--engine obscura` ("consistent fingerprint, tracker blocking").
- **Mastra**: `@mastra/agent-browser` "using Playwright with accessibility-first element targeting", snapshot refs `@e1`, `cdpUrl` for remote browsers, local needs `npx playwright install chromium`; `@mastra/browser-viewer` launches Chrome via Playwright and exposes a CDP URL for CLI agents (browser-use, agent-browser). The Vercel AI SDK itself ships no browser tool (not verified — uncertain).
- **Open Operator** (browserbase): archived PoC — Browserbase + Stagehand + Next.js + OpenAI; source moved to `browserbase/gtm-demos`.
- **LangChain** (`langchain-community`): `WebBaseLoader`/`AsyncHtmlLoader` headers `{"User-Agent": get_user_agent(), "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.5"}`; `get_user_agent()` returns `os.environ["USER_AGENT"]` or **`"DefaultLangchainUserAgent"`** (with a logged warning), or `fake_useragent.UserAgent().random` if that package is installed and the UA is empty; `RecursiveUrlLoader` passes `headers=None` → `python-requests/x.y` / aiohttp defaults; `PlaywrightURLLoader` → `p.chromium.launch(headless=self.headless (True), proxy=…)` stock Playwright.
- **LlamaIndex** `SimpleWebPageReader`: `requests.get(url, headers=None, timeout=…)` → `python-requests/<ver>` UA.
- **MCP reference `fetch` server**: `DEFAULT_USER_AGENT_AUTONOMOUS = "ModelContextProtocol/1.0 (Autonomous; +https://github.com/modelcontextprotocol/servers)"`, `DEFAULT_USER_AGENT_MANUAL = "ModelContextProtocol/1.0 (User-Specified; +https://github.com/modelcontextprotocol/servers)"`.
- **cdp-use** (browser-use): "A type-safe Python client generator for the Chrome DevTools Protocol", generated from the official protocol JSON; no stealth logic.

---

## 27. The detection-bypass landscape in 2026 (what each defeats, what still leaks)

Primary source for the test mechanics: `rebrowser/rebrowser-bot-detector/index.js` (read in full).

### 27.1 Test mechanics worth re-implementing

- **runtimeEnableLeak** (works against Playwright, Puppeteer, Chromedriver, Stagehand v4): "With Runtime.enable on, Chrome serializes every console argument for Runtime.consoleAPICalled. Since Chrome 137 that no longer runs a user getter on error.stack, but it still formats the stack (Error.prepareStackTrace runs) and reads error.name an extra time." Probe: define `Error.prepareStackTrace` and `console.debug(new Error())` → count calls; also `class X extends Error { get name() { count++ } }` → `nameGetterCount / rounds > 1.5` means serialization happened. Pre-137: a getter on `e.stack` fires. Repeat every 100 ms for 10 s then every 1 s (DevTools open and some extensions also trigger it).
- **exposeFunctionLeak**: `window.exposedFn.toString().includes('This is the Puppeteer binding')`; keys starting with `puppeteer_`; key `__playwright__binding__`; functions with `__installed === true`; wrapper text `exposeBindingHandle supports a single argument` (Playwright ≤1.59 / Patchright).
- **pwInitScripts**: `window.__pwInitScripts !== undefined` (historic Playwright).
- **sourceUrlLeak**: wrap `document.getElementById` and inspect `new Error().stack` for `pptr:` (Puppeteer) or `UtilityScript.` (Playwright); "bare" frames like `at app.js:4:14` (scripts injected with a bare `//# sourceURL`) are a soft signal.
- **mainWorldExecution**: wrap `document.getElementsByClassName` and see whether automation calls it (anything evaluated in the main world; isolated worlds are "safe and not detectable").
- **documentInterception**: `nav.nextHopProtocol === '' && nav.transferSize > 0 && (nav.deliveryType ?? '') === '' && nav.workerStart === 0` (Playwright `route.fulfill`, Puppeteer `Fetch.fulfillRequest`, Patchright init scripts).
- **headless**: `ua.includes('HeadlessChrome') || brands.includes('HeadlessChrome')`; desktop Chromium with `typeof window.chrome === 'undefined'` ("chrome-headless-shell (Playwright's default headless mode, Puppeteer headless: 'shell') doesn't"); `Notification.permission === 'denied'` while `permissions.query` says `prompt`; `(any-pointer: none)` on desktop; screen `800x600`; SwiftShader WebGL renderer.
- **navigatorWebdriver**: `true`, or `undefined`, or non-empty `Object.getOwnPropertyNames(navigator)`, or an own descriptor for `webdriver`.
- **viewport**: `800x600` (Puppeteer) / `1280x720` (Playwright) using `max(clientWidth, innerWidth)`.
- **bypassCsp**: inject an external script under a CSP and see if it loads.
- Others described in the README: `platformMismatch` (UA vs `navigator.platform` vs UA-CH; `page.setUserAgent` leaving `userAgentData.brands` empty; CSS `ActiveText` system colour differs per OS), `workerConsistency` (navigator in a Worker vs page), `nativeTampering` (Proxy/`__proto__` cycles, `iframe.contentWindow` evasion), `mobileEmulation` (`maxTouchPoints === 1` with desktop platform), `popupBlocking`, `ipcFloodingProtection` (300 `history.replaceState` in a hidden iframe), `storagePartitioning` (Chromium 148+), `cdpBindingGlobals` (native functions with empty names on `window`).

### 27.2 Stack-by-stack status (as of 2026-10-24)

| Stack | Defeats | Still leaks (confirmed or per vendor/detector docs) |
|---|---|---|
| Stock Playwright | — | webdriver (pipe/headless), HeadlessChrome, 1280×720, Runtime.enable, `UtilityScript` frames, bindings globals, popup/IPC/storage-partitioning flags, focus emulation, headless font families, `fill` single-insert signature |
| Stock Puppeteer | — | webdriver (`--enable-automation`+pipe/port 0), HeadlessChrome, 800×600, Runtime.enable, `pptr:` sourceURL, `puppeteer_*` bindings, popup/IPC flags, `AcceptCHFrame` disabled |
| puppeteer-extra-stealth | webdriver flag, UA token, some navigator props | native tampering (Proxy), worker inconsistency, `pptr:` (its sourceurl evasion targets the obsolete marker), Runtime.enable, popup/IPC flags |
| rebrowser-patches | Runtime.enable, sourceURL/UtilityScript names, utility world name, webdriver flag, popup/IPC/storage flags | HeadlessChrome, default viewport, fingerprints, behaviour; `page.pause()` broken; addBinding fallback may briefly expose a random global |
| Patchright | Runtime.enable, Console, webdriver flag, `--enable-automation`, closed shadow roots | `documentInterception` on every page load once init scripts/exposeFunction are used, `exposeFunctionLeak`, `storagePartitioning`, init-script timing; console disabled; Chromium only |
| undetected-chromedriver | `cdc_` globals, `--enable-automation` removable, webdriver (Proxy in headless), UA token | still chromedriver (Runtime.enable serialization, `test-type=webdriver`), Proxy over `navigator`, `console.log("undetected chromedriver 1337!")` per document (likely), 1920×1080 forced |
| nodriver / zendriver | no chromedriver, no Runtime.enable, no `--enable-automation`, non-zero debug port, UA token stripped in headless | `--headless=new` → webdriver true unless flag; UA-CH brands (uncertain); untrusted `el.click()`; `char`-only typing; clicks without mousemove; expert-mode `attachShadow` hook + console logs; `uc_*` profile |
| Camoufox | C++-level fingerprint coherence, isolated-world automation, webdriver false, trusted automation events, hidden debugger | Firefox engine (SpiderMonkey) tells, canvas/text/audio real host values, uBlock Origin default, humanize is replay-based |
| Browser Use | `--disable-blink-features=AutomationControlled`, no `--enable-automation`, mostly isolated CDP data (AX tree / DOMSnapshot) | DOM corner-bracket highlights on each click (default), synthetic `input/change/blur` after typing, 1 ms key cadence, fixed 50/80 ms click timing, `synthesizeScrollGesture speed 50000`, `getEventListeners` via commandLineAPI, HeadlessChrome in headless, 1920×1080 headless viewport, `--disable-features=…ThirdPartyStoragePartitioning…` |
| Stagehand v4 | real Chrome via extension; a11y-based | Runtime.enable, pipelined zero-delay clicks, `Input.insertText` typing, main-world init scripts, cursor overlay element |
| Skyvern | AutomationControlled flag, `--enable-automation` removed | main-world `domUtils.js` globals, `unique_id` attributes, `__pw-cursor` overlay, HAR/video recording, 1920×1080, Playwright input signatures |
| Chrome DevTools MCP | real Google Chrome, real profile, no viewport emulation | webdriver true (pipe + `--enable-automation`), Runtime.enable, Puppeteer locator click/fill/type signatures |
| Playwright MCP / Browser MCP / Nanobrowser / Playwright Extension | real profile & fingerprint (extension modes) | Playwright/Puppeteer protocol-level signatures; Nanobrowser `[data-nanobrowser-border]`; MCP action cadence (LLM-paced, seconds between actions) |

---

## 28. Implementation hooks for the detector (prioritised)

1. **Chromium automation state**: `navigator.webdriver === true` → automation; `=== undefined` or own-property descriptor → tampering (Crawl4AI, stealth plugin, UC). Pair with `HeadlessChrome` in UA/`userAgentData.brands` and `screen 800x600` / `window.chrome` absence / Notification mismatch for headless-shell.
2. **Main-world global scan** (cheap, run once per load and again after 2 s): `cdc_*_Array|Object|Promise|Proxy|ShadowRoot|Symbol|JSON|Window` (Selenium), `__playwright__binding__`, `__playwright__binding__controller__`, `__pwInitScripts`, `__pwSnapshotGlobals`, `__pw_recorder*`, `puppeteer_*`, functions whose `toString()` contains `This is the Puppeteer binding`, `WebSurfer`/`MultimodalWebSurfer`, `elementIdCounter`+`GlobalSkyvernFrameIndex`+`buildTreeFromBody`, `__PW_CURSOR_VIS__`/`__pw_trails`, `Element.prototype._attachShadow`, non-native `Element.prototype.attachShadow`, `navigator.plugins[0] === 1`.
3. **DOM mutation watch** (MutationObserver on `documentElement`): attributes `unique_id`, `__elementId`, `data-browser-use-*`, `data-skyvern-*`, `data-pw-overlay`, `data-nanobrowser-border`; element ids `browser-use-debug-highlights`, `browser-use-demo-panel`, `boundingBoxContainer`, `red-cursor`, `__pw-cursor`; custom elements `x-pw-glass`, `x-pw-highlight`, `x-pw-tooltip`, `x-pw-action-point`.
4. **Runtime.enable probe** (prepareStackTrace / name-getter counting via `console.debug`) — distinguishes Playwright/Puppeteer/Chromedriver/Stagehand from nodriver/rebrowser/patchright/extension-less human browsing; DevTools-open is the main false positive.
5. **Error-stack probe** on wrapped DOM APIs: `pptr:` and `UtilityScript.` frames; bare sourceURL file names.
6. **Input-event forensics**: (a) `input` events with `inputType:'insertText'` whose `data.length > 1` and no preceding `keydown` (Playwright `fill`, Stagehand/Nanobrowser `Input.insertText`, Chrome DevTools MCP `fill`); (b) untrusted `input/change/blur` immediately after trusted keystrokes (Browser Use); (c) `keypress`/`input` with no `keydown` (nodriver `char` events); (d) `mousedown` with no prior `mousemove`/`pointermove` since load (nodriver `mouse_click`); (e) constant inter-key intervals (Browser Use ~1 ms, Anthropic 12 ms, Magentic 100/10 ms, Playwright/Puppeteer 0 ms); (f) click `mousedown→mouseup` deltas clustered at 0 ms (Playwright/Puppeteer/Stagehand), 10 ms (Magentic/AutoGen), ~80 ms (Browser Use); (g) `pointerdown.pressure === 0.5` with `pointerType:'mouse'` on an otherwise motionless cursor (Playwright `force`); (h) click coordinates at exact element centres rounded to 0.01 px (Playwright) or integer centres (Puppeteer, Browser Use), teleporting `mousemove` with a single intermediate event.
7. **Scroll forensics**: programmatic `scroll` events without `wheel` events (`window.scrollBy`/`scrollIntoView` — OpenAI sample, Playwright/Puppeteer actionability, Skyvern), scroll deltas equal to `innerHeight` or `innerHeight-50` (Browser Use, Magentic-UI), synthesized gestures with huge velocity (Browser Use 50000 px/s, nodriver 7777) producing many smooth `scroll` frames in a few ms.
8. **Flag side effects**: popup without gesture, >200 `history.replaceState` in 10 s, cross-site storage partitioning absent, `document.hasFocus()` true while `visibilityState` toggles, generic-font resolution to Windows names on Linux UA (Playwright headless), `(any-pointer: fine)` with no mouse events ever.
9. **Server-side correlation**: `DefaultLangchainUserAgent`, `ModelContextProtocol/1.0 (…)`, `python-requests/…`, `Lightpanda/1.0`, malformed Crawl4AI UA (`AppleWebKit/537.36 Chrome/116.0.0.0 Safari/537.36` without `(KHTML, like Gecko)`), `user-agents`-npm random UAs with mismatched UA-CH (Firecrawl), missing/incoherent `Sec-CH-UA-Platform` (Browserbase standard = linux; Steel = linux chrome≥146).
10. **Hosted-browser priors**: Linux platform + datacenter ASN + 1920×1080 (Steel/Kernel) or 1280×720 (Hyperbrowser) + fresh profile; Kernel/Patchright → documentInterception + storagePartitioning signals.

---

## 29. Unknowns / not verified

- Exact chromedriver mouse move/press timing and whether it emits an intermediate `mouseMoved` (did not read `element_commands.cc` in depth).
- Whether nodriver's UA-CH `brands` still include `HeadlessChrome` after `Network.setUserAgentOverride` without `userAgentMetadata` (likely yes).
- Browser MCP's WebSocket port (`mcpConfig.defaultWsPort` lives in a private package) and whether it uses `chrome.debugger` or content scripts.
- Stagehand cursor-overlay element id (`CURSOR_OVERLAY_ID` constant value not read) and default local viewport/headless.
- Scrapling's built-in headless UA strings (`__default_chrome_useragent__`), and whether a Camoufox path still exists.
- Firecrawl API `fetch` engine's effective User-Agent (undici default?) and its egress IP ranges (unpublished).
- Lightpanda's concrete Web API gaps for fingerprinting (needs empirical probing against a running instance).
- Playwright MCP persistent-context default viewport (`viewport: null` vs 1280×720) — not checked.
- The undetected-chromedriver `console.log("undetected chromedriver 1337!")` artifact was derived from the regex replacement; not observed at runtime.
- Whether Puppeteer's `AcceptCHFrame` disablement is observable server-side in practice.
- Vercel AI SDK: assumed to have no first-party browser tool (not verified).

---

## Sources (all read 2026-10-24)

Chromium
- https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/frame/navigator.cc
- https://raw.githubusercontent.com/chromium/chromium/main/content/child/runtime_features.cc
- https://raw.githubusercontent.com/chromium/chromium/main/components/embedder_support/user_agent_utils.cc
- https://developer.chrome.com/docs/chromium/headless
- https://raw.githubusercontent.com/chromium/chromium/main/chrome/test/chromedriver/chrome/devtools_client_impl.cc
- https://raw.githubusercontent.com/chromium/chromium/main/chrome/test/chromedriver/chrome_launcher.cc
- https://raw.githubusercontent.com/chromium/chromium/main/chrome/test/chromedriver/js/call_function.js
- https://raw.githubusercontent.com/chromium/chromium/main/chrome/test/chromedriver/element_commands.cc

Playwright
- https://github.com/microsoft/playwright (sparse clone): `packages/playwright-core/src/server/chromium/{chromiumSwitches.ts,chromium.ts,crPage.ts,crInput.ts,crBrowser.ts,defaultFontFamilies.ts}`, `server/{page.ts,dom.ts,frames.ts,input.ts,browserContext.ts,javascript.ts,recorder.ts,trace/recorder/snapshotterInjected.ts}`, `packages/injected/src/{injectedScript.ts,utilityScript.ts,bindingsController.ts,ariaSnapshot.ts,highlight.ts,highlight.css}`, `packages/isomorphic/utilityScriptSerializers.ts`, `packages/playwright-core/src/tools/{mcp/*,backend/*,utils/extension.ts}`, `packages/extension/{manifest.json,src/*}`
- https://raw.githubusercontent.com/microsoft/playwright-mcp/main/README.md
- https://raw.githubusercontent.com/microsoft/playwright/main/packages/extension/README.md
- https://playwright.dev/docs/browsers

Puppeteer & stealth
- https://github.com/puppeteer/puppeteer (sparse clone): `packages/puppeteer-core/src/{common/util.ts,node/ChromeLauncher.ts,cdp/Input.ts,cdp/ExecutionContext.ts,cdp/FrameManager.ts,cdp/utils.ts,cdp/Binding.ts,cdp/TargetManager.ts,cdp/EmulationManager.ts,cdp/Page.ts,api/ElementHandle.ts}`
- https://raw.githubusercontent.com/berstend/puppeteer-extra/master/packages/puppeteer-extra-plugin-stealth/evasions/{sourceurl,defaultArgs,navigator.webdriver,user-agent-override}/index.js and the evasions directory listing

Bypass tooling
- https://raw.githubusercontent.com/rebrowser/rebrowser-patches/main/README.md and `patches/playwright-core/1.64.1/{lib,src}.patch`, `patches/puppeteer-core/25.14.0/{lib,src}.patch`
- https://raw.githubusercontent.com/rebrowser/rebrowser-bot-detector/main/README.md and `index.js`
- https://raw.githubusercontent.com/Kaliiiiiiiiii-Vinyzu/patchright/main/README.md, `patchright_driver_patch.ts`, `driver_patches/{chromiumSwitchesPatch,crPagePatch,pageBindingPatch,javascriptPatch,framesPatch,crDevToolsPatch,crExecutionContextPatch,pagePatch}.ts`
- https://raw.githubusercontent.com/ultrafunkamsterdam/undetected-chromedriver/master/undetected_chromedriver/{patcher.py,__init__.py}
- https://github.com/ultrafunkamsterdam/nodriver (`nodriver/core/{config,browser,tab,connection,element}.py`)
- https://raw.githubusercontent.com/cdpdriver/zendriver/main/{README.md,zendriver/core/config.py,zendriver/core/tab.py,zendriver/core/connection.py}
- https://raw.githubusercontent.com/daijro/camoufox/main/README.md, `browser/patches/` listing, `browser/patches/playwright/1-leak-fixes.patch`, `browser/patches/trusted-automation-events.patch`, `browser/patches/debugger-invisible-to-content.patch`, `python/src/camoufox/{utils.py,addons.py}`

Agent frameworks
- https://github.com/browser-use/browser-use (sparse clone): `browser_use/browser/{profile.py,session.py,session_manager.py,demo_mode.py,python_highlights.py,watchdogs/default_action_watchdog.py,watchdogs/local_browser_watchdog.py,watchdogs/dom_watchdog.py}`, `browser_use/dom/service.py`, `browser_use/tools/service.py`, `browser_use/actor/page.py`
- https://raw.githubusercontent.com/browser-use/cdp-use/main/README.md
- https://github.com/browserbase/stagehand (sparse clone): `packages/extension/{manifest.json,content-script.ts,understudy/*,dom/locatorScripts/cursorOverlay.ts}`, `packages/sdk-ts/src/{clientSchemas.ts,browser/localBrowser.ts}`, `packages/cli/src/lib/driver/local-cdp-discovery.ts`; https://raw.githubusercontent.com/browserbase/stagehand/main/README.md
- https://github.com/Skyvern-AI/skyvern (sparse clone): `skyvern/webeye/{browser_factory.py,main_world_eval.py,cursor_visualization.py,scraper/domUtils.js,scraper/cursorOverlay.js,scraper/scraper.py,utils/page.py,actions/handler.py,actions/handler_utils.py}`; https://raw.githubusercontent.com/Skyvern-AI/skyvern/main/skyvern/config.py
- https://github.com/ChromeDevTools/chrome-devtools-mcp (sparse clone): `src/{BrowserManager.ts,TextSnapshot.ts,tools/input.ts}`, `docs/{tool-reference.md,configuration.md}`, README
- https://github.com/BrowserMCP/mcp (`src/{index.ts,ws.ts,tools/*}`), https://browsermcp.io/, https://browsermcp.io/install (→ chromewebstore id)
- https://github.com/nanobrowser/nanobrowser (sparse clone): `src/browser-control/{host/puppeteer.ts,probe/index.ts,core/interaction/pointer.ts,core/tools/text.ts,core/tools/act.ts}`, `src/extension/border.ts`, `src/store/rating.ts`
- https://github.com/microsoft/magentic-ui (sparse clone): `src/magentic_ui/tools/playwright/{playwright_controller_fara.py,page_script.js,browser/local_playwright_browser.py,browser/quicksand_browser_manager.py,utils/webpage_text_utils.py}`
- https://github.com/microsoft/autogen (sparse clone): `python/packages/autogen-ext/src/autogen_ext/agents/web_surfer/{playwright_controller.py,page_script.js,_multimodal_web_surfer.py}`
- https://raw.githubusercontent.com/openai/openai-agents-python/main/examples/tools/computer_use.py; https://github.com/openai/openai-cua-sample-app (tree listing)
- https://raw.githubusercontent.com/anthropics/anthropic-quickstarts/main/computer-use-demo/{computer_use_demo/tools/computer.py,Dockerfile,image/xvfb_startup.sh,image/entrypoint.sh}
- https://raw.githubusercontent.com/browserbase/open-operator/main/README.md
- https://raw.githubusercontent.com/vercel-labs/agent-browser/main/README.md
- https://mastra.ai/integrations/browsers/agent-browser (+ search results for BrowserViewer / browser overview)

Crawlers / loaders
- https://github.com/unclecode/crawl4ai (sparse clone): `crawl4ai/{browser_manager.py,async_crawler_strategy.py,browser_adapter.py,async_configs.py,user_agent_generator.py,js_snippet/navigator_overrider.js}`
- https://github.com/firecrawl/firecrawl (sparse clone): `apps/playwright-service-ts/api.ts`, `apps/api/src/scraper/scrapeURL/engines/fetch/index.ts`, `apps/api/src/lib/robots-txt.ts`; https://github.com/mendableai/firecrawl/issues/656; https://docs.firecrawl.dev/advanced-scraping-guide
- https://github.com/D4Vinci/Scrapling (sparse clone): `scrapling/engines/{constants.py,_browsers/_base.py,_browsers/_stealth.py,toolbelt/fingerprints.py}`
- https://raw.githubusercontent.com/lightpanda-io/browser/main/README.md; GitHub code search in lightpanda-io/browser (`src/Config.zig`, `src/network/HttpClient.zig`, `src/browser/webapi/Navigator.zig`, `src/server/cdp/domains/browser.zig`)
- https://raw.githubusercontent.com/steel-dev/steel-browser/main/README.md and `api/src/services/cdp/cdp.service.ts`
- https://raw.githubusercontent.com/langchain-ai/langchain-community/main/libs/community/langchain_community/{document_loaders/web_base.py,document_loaders/async_html.py,document_loaders/recursive_url_loader.py,document_loaders/url_playwright.py,utils/user_agent.py}
- https://raw.githubusercontent.com/run-llama/llama_index/main/llama-index-integrations/readers/llama-index-readers-web/llama_index/readers/web/simple_web/base.py
- https://raw.githubusercontent.com/modelcontextprotocol/servers/main/src/fetch/src/mcp_server_fetch/server.py

Hosted browsers
- https://docs.browserbase.com/features/stealth-mode ; https://docs.browserbase.com/reference/api/create-a-session
- https://www.hyperbrowser.ai/docs/sessions/stealth ; https://www.hyperbrowser.ai/docs/sessions/parameters
- https://kernel.sh/docs/ ; https://kernel.sh/docs/llms.txt ; https://kernel.sh/docs/browsers/bot-detection/{overview,stealth}.md ; https://kernel.sh/docs/browsers/{viewport,headless}.md ; https://kernel.sh/docs/overview/features.md ; https://kernel.sh/docs/start/quickstart.md
- https://docs.anchorbrowser.io/ ; https://docs.anchorbrowser.io/essentials/stealth
