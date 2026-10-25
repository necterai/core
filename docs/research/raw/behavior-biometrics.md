# Behavioral signatures: humans vs LLM-driven agents vs scripted automation

Research report for `necter` (client-side AI-agent firewall). Area: **behavioral biometrics and input-dispatch signatures** — how automation frameworks and computer-use agents actually inject mouse/keyboard/scroll input, what that looks like at the DOM event level, what the research literature says separates humans from synthetic input, concrete feature definitions with suggested thresholds, and the assistive-technology / unusual-hardware cases that produce false positives.

- Date of research: 2026-10-24.
- Method: primary sources only where possible — framework source files (Playwright, Puppeteer, ChromeDriver, Browser Use, Skyvern, ghost-cursor, xdotool, Anthropic/OpenAI reference code), Chromium source (CDP `Input` handler, Blink pointer/wheel/simulated-event code, platform input builders), W3C specs, arXiv/journal papers, public datasets (CMU keystroke benchmark and Balabit mouse data were downloaded and analysed locally), plus one **empirical probe of the Claude in Chrome extension** run in this workstation's Chrome (155, macOS, devicePixelRatio 2).
- Confidence legend used throughout: **[confirmed]** = read in source/spec/paper or measured; **[likely]** = strongly implied by source but not executed/measured end-to-end; **[uncertain]** = not verified, stated as hypothesis.
- Everything quoted is exact unless marked "paraphrase".
- Section 15 lists what could not be verified (web-search budget ran out mid-task; fetches continued).

---

## 1. Executive summary — the signals worth building first

| # | Signal | Why it separates | Evidence | Conf. |
|---|--------|------------------|----------|-------|
| 1 | **Click micro-timing**: `pointerdown→pointerup` < 20 ms, and `pointermove→pointerdown` < 20 ms | Every CDP-driven stack dispatches press/release back-to-back (Playwright queues down/up concurrently; Puppeteer no delay; xdotool 12 µs; Claude in Chrome measured 1.2–1.6 ms). Human click durations: Balabit median 94–109 ms, p5 62–78 ms; Browser Use is the exception (fixed 80 ms). | §2, §4, §12 | confirmed |
| 2 | **Single-step pointer teleport**: one `pointermove` (movementX = full delta) immediately before a click; zero `pointermove` events otherwise | Playwright/Puppeteer `steps=1`, ChromeDriver moved→pressed→released, Browser Use `mouseMoved` once, xdotool `mousemove` warps, PyAutoGUI instant move, Claude in Chrome measured. Humans: hundreds of moves (Castle: 378 vs 4). | §2, §5 | confirmed |
| 3 | **Exact-center / lattice click coordinates** | Playwright `quadMiddlePoint`, Puppeteer `box.x + width/2`, ChromeDriver center, Browser Use average of quad corners; computer-use agents produce `round(k×scale)` lattices (Anthropic `scale_coordinates`, Claude in Chrome scale 8/7 measured). Human endpoints are ~Normal with σ ≈ W/4.133. | §2, §5.6 | confirmed |
| 4 | **`pressure` on `pointerdown`** = 0 with `buttons=1` | CDP `force` default 0 → Blink pressure 0 for Puppeteer, ChromeDriver (`force(0.0)`), ghost-cursor, Browser Use. Real mouse → 0.5 (NaN force rule). Playwright and Claude in Chrome send 0.5 (so this is a *partial* tell). AT simulated clicks also give 0 (see §12). | §3 | confirmed (source) / measured for Chrome ext. |
| 5 | **`wheelDeltaY` ≡ ±120 while `deltaY` ≠ platform tick size** | CDP `mouseWheel` sets `wheel_ticks = ±1` regardless of delta; Blink `wheelDelta = ticks × 120`. Measured: `deltaY: 300, wheelDeltaY: -120`. Real: Windows 100 px/tick (ratio 1.2), mac trackpad ratio 3, X11 120 px/tick (ratio 1). | §7 | confirmed |
| 6 | **Keystroke dwell < 30 ms / inter-key < 40 ms / zero rollover** | Playwright/Puppeteer type with no delay (measured 0.1–0.3 ms in Chrome ext.), Browser Use 5 ms dwell, xdotool 6 ms/6 ms, Skyvern 10 ms, ChromeDriver back-to-back. Human hold time mean 90 ms (CMU, p1 = 38 ms) / 116 ms (Dhakal); IKI mean 239 ms, lower bound ~60 ms; rollover 25% of keystrokes. | §6 | confirmed |
| 7 | **`insertText` without key events** (`input.inputType === "insertText"`, `data.length > 1`, no `keydown`) | Playwright `fill()` → `select()` + `Input.insertText` (IME commit); Playwright MCP `browser_type` fills by default; Puppeteer `sendCharacter`. Caveats: IME/dictation/mobile. | §6.4 | confirmed |
| 8 | **Programmatic scroll with no input cause** (scroll/scrollend with no preceding wheel/key/touch/pointer) | `DOM.scrollIntoViewIfNeeded` (Playwright, Browser Use, ghost-cursor), `scrollIntoView({behavior:'instant', block:'center'})` (Puppeteer), `scrollIntoView({behavior:'smooth'})` (Browser Use find_text), `synthesizeScrollGesture` (Browser Use). Caveat: screen readers, focus(), hash navigation. | §7.4 | confirmed |
| 9 | **Think-time structure**: inter-action gaps ≥ 1–3 s with low dispersion, bursts of sub-10 ms actions, no idle movement in gaps | Papers (§8) show timing is the strongest attribution signal; Anthropic reference waits 2.0 s per screenshot; Browser Use 0.1 s + 0.25 s + 0.5 s + LLM latency. | §8 | confirmed (structure) / thresholds proposed |
| 10 | **Main-world DOM harvest bursts with foreign stack origin** (`pptr:`, `UtilityScript.`, URL-less `<anonymous>` frames; `unique_id` attribute mutations; `getEventListeners` probes) | Puppeteer appends `//# sourceURL=pptr:...`; Playwright wraps `page.evaluate` in `UtilityScript.evaluate`; Browser Use runs `document.querySelectorAll('*')`+`getEventListeners` and `elementFromPoint` in the main world via `Runtime.evaluate` (no sourceURL); Skyvern stamps `unique_id` attributes. Caveat: Playwright's own locator work is in an isolated world and invisible. | §10 | confirmed |
| 11 | **Untrusted events interleaved with trusted ones** (`isTrusted:false` `input`/`change`/`blur` right after trusted keystrokes or clicks) | Browser Use `_trigger_framework_events` and `_clear_text_field`; Claude in Chrome `form_input` (measured untrusted `change`+`input`); Playwright `fill` on date/color inputs dispatches untrusted `input`/`change`. | §2.6, §2.12 | confirmed |
| 12 | **Absence of hover dwell and absence of incidental events** (`mouseover` on non-targets, `selectionchange`, pointer leaving the viewport, `blur`/`visibilitychange`) | Agents only emit the minimal sequence for each action; Kang et al. event-proportion heatmap; our probe. | §9 | likely |

Design rule that falls out of §12: **never fire on one signal**. Keyboard-only users, screen readers, voice control, dwell/switch clickers, eye trackers, RDP/VNC sessions and trackpads each reproduce one or two of the above. The combination "teleport + sub-20 ms click + center/lattice coordinates + no incidental events + no idle movement + seconds-scale periodic gaps" is what separates agents; each single feature must be gated by the AT-safe checks in §12.

---

## 2. Ground truth: how each stack dispatches input

### 2.1 Chrome DevTools Protocol `Input` domain (what everything on Chromium reduces to)

Source: `content/browser/devtools/protocol/input_handler.cc` (Chromium main, fetched 2026-10-24) and the protocol definition (`ChromeDevTools/devtools-protocol`, `json/browser_protocol.json`).

Protocol parameters and defaults [confirmed]:

- `Input.dispatchMouseEvent`: `type` ∈ {`mousePressed`, `mouseReleased`, `mouseMoved`, `mouseWheel`}; `x`, `y` "relative to the main frame's viewport in CSS pixels"; `modifiers` (Alt=1, Ctrl=2, Meta/Command=4, Shift=8); `timestamp` (TimeSinceEpoch, optional); `button` (default `"none"`); `buttons` bitmask (Left=1, Right=2, Middle=4, Back=8, Forward=16); `clickCount` (default 0); **`force` "The normalized pressure, which has a range of [0,1] (default: 0)"**; `tangentialPressure`, `tiltX`, `tiltY`, `twist` (default 0); `deltaX`/`deltaY` "in CSS pixels for mouse wheel event (default: 0)"; `pointerType` ∈ {`mouse`, `pen`} (default `mouse`).
- `Input.dispatchKeyEvent`: `type` ∈ {`keyDown`, `keyUp`, `rawKeyDown`, `char`}; `text` "Not needed for for `keyUp` and `rawKeyDown` events (default: "")"; `unmodifiedText`, `keyIdentifier`, `code`, `key`, `windowsVirtualKeyCode` (default 0), `nativeVirtualKeyCode` (default 0), `autoRepeat` (false), `isKeypad` (false), `isSystemKey` (false), `location` (0), `commands` (editing commands such as `selectAll`).
- `Input.insertText`: "This method emulates inserting text that doesn't come from a key press, for example an emoji keyboard or an IME."
- `Input.dispatchTouchEvent`: `TouchPoint` = `x`, `y`, `radiusX` (default 1.0), `radiusY` (default 1.0), `rotationAngle` (0.0), `force` (default 1.0), `tangentialPressure`, `tiltX`, `tiltY`, `twist`, `id`.
- `Input.synthesizeScrollGesture`: `x`, `y`, `xDistance`, `yDistance` ("positive to scroll up"), `preventFling` (default true), `speed` "Swipe speed in pixels per second (default: 800)", `gestureSourceType` ∈ {`default`, `touch`, `mouse`}, `repeatCount`, `repeatDelayMs` (250).
- `Input.emulateTouchFromMouseEvent`, `Input.imeSetComposition`, `Input.dispatchDragEvent` also exist.

What the browser does with them (`input_handler.cc`) [confirmed, quoted]:

```cpp
mouse_event->button = event_button;
mouse_event->click_count = click_count.value_or(0);
mouse_event->pointer_type = GetPointerType(pointer_type.value_or(""));
mouse_event->force = force.value_or(0);
mouse_event->tangential_pressure = tangential_pressure.value_or(0);
...
mouse_event->SetPositionInWidget(CssPixelsToPointF(x, y, scale_factor));
mouse_event->SetPositionInScreen(mouse_event->PositionInWidget());
```

and later the screen position is corrected to the widget's screen bounds:

```cpp
gfx::PointF ConvertWidgetPointToScreenPoint(RenderWidgetHostViewBase& view, const gfx::PointF& point_in_widget) {
  gfx::Rect view_bounds_in_screen = view.GetViewBounds();
  return point_in_widget + view_bounds_in_screen.OffsetFromOrigin();
}
```

Wheel events:

```cpp
wheel_event->delta_x = static_cast<float>(scaled_delta_x);
wheel_event->delta_y = static_cast<float>(scaled_delta_y);
if (wheel_event->delta_x != 0.0f) {
  wheel_event->wheel_ticks_x = wheel_event->delta_x > 0.0f ? 1.0f : -1.0f;
}
if (wheel_event->delta_y != 0.0f) {
  wheel_event->wheel_ticks_y = wheel_event->delta_y > 0.0f ? 1.0f : -1.0f;
}
wheel_event->phase = blink::WebMouseWheelEvent::kPhaseBegan;
wheel_event->delta_units = ui::ScrollGranularity::kScrollByPrecisePixel;
```

followed by "// Send a synthetic wheel event with phaseEnded to finish scrolling." with `wheel_ticks_x = 0; wheel_ticks_y = 0; phase = kPhaseEnded`.

Timestamps: if `timestamp` is omitted, `GetEventTimeTicks` returns `base::TimeTicks::Now()`; if supplied, it is converted as `base::TimeTicks::Now() - (base::Time::Now() - event_time)` — i.e. **a caller can back-date or forward-date `Event.timeStamp`** (ghost-cursor has a `useTimestamps` option that does this).

Key events: `keyDown` → `WebInputEvent::Type::kKeyDown`, `rawKeyDown` → `kRawKeyDown`, `char` → `kChar`; `text` is copied into the event; `InsertText` → `widget_host->GetWidgetInputHandler()->ImeCommitText(...)` (an IME commit: produces `beforeinput`/`input` with `inputType: "insertText"` and no key events).

Touch: `radius_x/radius_y` default 1.0, `force` default 1.0, `pointer_type` always touch.

Each `dispatchMouseEvent` call produces exactly one `WebMouseEvent`; there is no interpolation in the browser. Movement is computed later in Blink (`pointer_event_factory.cc`): for non-raw-movement events `movementX/Y` = current screen position − last screen position, truncated with `base::saturated_cast<int>` — so CDP-driven `movementX/Y` are *consistent* (they equal the teleport delta), not zero. Measured: `mx=39 my=87` on a one-step move (§2.12).

### 2.2 Playwright (Chromium backend)

Sources: `packages/playwright-core/src/server/chromium/crInput.ts`, `server/input.ts`, `server/dom.ts`, `server/chromium/crPage.ts`, `server/javascript.ts`, `packages/injected/src/injectedScript.ts`, `packages/injected/src/utilityScript.ts` (main branch, 2026-10-24).

- **Mouse move** (`RawMouseImpl.move`): `type: 'mouseMoved'`, `buttons: toButtonsMask(buttons)`, **`force: buttons.size > 0 ? 0.5 : 0`**. Playwright deliberately mimics the real-mouse pressure value. `Mouse.move` default `steps = 1`; with `steps > 1` it interpolates linearly: `const middleX = fromX + (x - fromX) * (i / steps)` and awaits each CDP call.
- **Mouse down/up**: `type: 'mousePressed'`, `clickCount`, `force: buttons.size > 0 ? 0.5 : 0`; `mouseReleased` with `clickCount`.
- **Click** (`Mouse.click`): `const { delay = null, clickCount = 1, steps } = options;` then `await this.move(progress, x, y, { forClick: true, steps });` and, **when no delay is given, down and up are queued concurrently**: `promises.push(this.down(...)); promises.push(this.up(...));` → press/release arrive at the renderer back-to-back (sub-millisecond to ~2 ms apart).
- **Wheel**: `type: 'mouseWheel', x, y, modifiers, deltaX, deltaY` (no `force`, no ticks).
- **Keyboard**: `type: text ? 'keyDown' : 'rawKeyDown'`, `windowsVirtualKeyCode: description.keyCodeWithoutLocation`, `commands`, `unmodifiedText: text`, `autoRepeat`, `isKeypad: location === input.keypadLocation`; keyup is always `keyUp`. `Keyboard.type`: `const delay = (options && options.delay) || undefined;` — **no default inter-key delay**; characters in the US layout go through `press`, everything else through `insertText`. `insertText` → `Input.insertText`.
- **Touch**: `RawTouchscreenImpl.tap` sends `touchStart` with `touchPoints: [{ x, y }]` (so radius 1.0 / force 1.0 defaults apply) and `touchEnd` **in parallel** → zero-duration taps.
- **Where it clicks** (`dom.ts _clickablePoint`): content quads from `DOM.getContentQuads`, clipped to the viewport, filtered by `computeQuadArea(quad) > 0.99`, then `const quad = filtered[0];` and `quadMiddlePoint(quad)` = **average of the four corners (exact center of the first visible quad)**. On Firefox it searches for an integer point (`findIntegerPointInsideQuad`) "because Firefox uses integer coordinates".
- **Click pipeline** (`_performPointerAction`): wait for states `['visible', 'enabled', 'stable', 'non-inert']` (stable = "same bounding box for at least two consecutive animation frames", per docs), scroll into view via `DOM.scrollIntoViewIfNeeded` (`crPage.ts _scrollRectIntoViewIfNeeded`), hit-target check with an injected capture-phase interceptor on `window` for `mousedown, mouseup, pointerdown, pointerup, click, auxclick, dblclick, contextmenu` (hover: `mousemove`; tap: `pointerdown, pointerup, touchstart, touchend, touchcancel`), then `mouse.click`. Retry backoff `[0, 20, 100, 100, 500]` ms. Forced scroll alternates alignments and uses `behavior: 'instant'`.
- **fill()** (`injectedScript.fill`): for `color/date/time/datetime-local/month/range/week` inputs it sets `.value` and dispatches **untrusted** `new Event('input', { bubbles: true, composed: true })` + `new Event('change', { bubbles: true })`. For text-like inputs/textarea/contenteditable it calls `selectText` (`input.select(); input.focus();`) and returns `'needsinput'`; the server then calls `keyboard.insertText(value)` → **`Input.insertText`**, i.e. one IME commit with the whole string, no `keydown`/`keypress`/`keyup`. Playwright's own docs: `keyboard.insertText` "Dispatches only input event, does not emit the keydown, keyup or keypress events."
- **Focus emulation**: `crPage.ts` sends `Emulation.setFocusEmulationEnabled { enabled: true }` → `document.hasFocus()` is true regardless of real window focus. Also `Runtime.enable`, `Page.createIsolatedWorld`, `Page.addScriptToEvaluateOnNewDocument` with `worldName: this._crPage.utilityWorldName` where `this.utilityWorldName = \`__playwright_utility_world_${this._page.guid}\``. `Emulation.setTouchEmulationEnabled` only when touch is requested.
- **Main-world evaluation**: `page.evaluate` is wrapped as `(utilityScript, ...args) => utilityScript.evaluate(...args)`; `UtilityScript.evaluate` does `let result = this.global.eval(expression);` → stack frames of anything the evaluated code calls contain `UtilityScript.evaluate` (`eval at evaluate (<anonymous>...)`). The DOM-locator engine itself runs in the isolated utility world and is **not visible** to page-level instrumentation.

Actionability table (docs): click/dblclick/tap/check require Visible, Stable, Receives Events, Enabled; fill requires Visible, Enabled, Editable; `press`/`pressSequentially` have no checks. `pressSequentially` "types character by character, as if it was a user with a real keyboard" (events `keydown`, `keyup`, `keypress`), optional `delay`.

### 2.3 Puppeteer (CDP backend)

Sources: `packages/puppeteer-core/src/cdp/Input.ts`, `api/ElementHandle.ts`, `cdp/ExecutionContext.ts`, `common/util.ts`.

- `CdpMouse.move`: `const {steps = 1} = options;` loop dispatching `type: 'mouseMoved', buttons, button: getButtonFromPressedButtons(buttons), ...position` — **no `force`, no `pointerType`** → CDP default `force 0`.
- `down`/`up`: `type: 'mousePressed'`/`'mouseReleased'`, `clickCount`, `buttons` mask; `const {button = MouseButton.Left, clickCount = 1} = options;`.
- `click`: `const {delay, count = 1} = options;` — delay applied only if a number is passed; otherwise down/up are pushed back-to-back.
- `wheel`: `type: 'mouseWheel', pointerType: 'mouse'`, `deltaX = 0, deltaY = 0` defaults.
- `touchStart`: `radiusX: 0.5, radiusY: 0.5, force: 0.5` (so Puppeteer touches are 1×1 CSS px contacts with pressure 0.5 — real fingers report tens of pixels).
- Keyboard `down`: `type: text ? 'keyDown' : 'rawKeyDown'`, `windowsVirtualKeyCode: description.keyCode`, `code`, `key`, `text`, `unmodifiedText: text`, `autoRepeat`, `location`, `isKeypad: description.location === 3`, `commands`. `type`: `const delay = options.delay || undefined;` (no default). `sendCharacter` → `Input.insertText`.
- `ElementHandle.clickablePoint`: `#clickableBox()` reads `getClientRects()`, clips to the frame, returns the first box ≥ 1×1 px; the point is `x: box.x + box.width / 2` (and height/2) unless an offset is given → **exact center**.
- `scrollIntoViewIfNeeded`: only if not fully intersecting (`isIntersectingViewport({threshold: 1})` via IntersectionObserver), then `element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })` — an **instant programmatic scroll with no wheel/key event**.
- Source URL leak: every `page.evaluate` string/function gets `//# sourceURL=${url}` appended where the URL is a `PuppeteerURL` with scheme `pptr:` (`static INTERNAL_URL = 'pptr:internal'`; `toString()` → `pptr:${functionName};${encodeURIComponent(site)}`), and calls use `userGesture: true`, `awaitPromise: true`.

### 2.4 ChromeDriver / Selenium (WebDriver classic on Chrome)

Sources: `chrome/test/chromedriver/element_commands.cc`, `element_util.cc`, `chrome/web_view_impl.cc`, `chrome/ui_events.cc`, `key_converter.cc`.

- `ExecuteClickElement` builds `events.emplace_back(kMovedMouseEventType, kNoneMouseButton, ...)`, `kPressedMouseEventType, kLeftMouseButton`, `kReleasedMouseEventType, kLeftMouseButton` and calls `DispatchMouseEvents` → `Input.dispatchMouseEvent` with `params.Set("buttons", ...)`, `params.Set("clickCount", ...)`, **`params.Set("force", it->force)`** where the `MouseEvent` constructor initialises `force(0.0)` (touch events use `force(1.0)`). So Selenium clicks on Chrome show `pressure 0` on `pointerdown`.
- Click point: `GetElementClickableLocation` → element region, then `location->Offset(rect.Width() / 2, rect.Height() / 2)` → **center**.
- Typing (`key_converter.cc`): per character a `kRawKeyDownEventType`, then a `kCharEventType` carrying the text, then `kKeyUpEventType`; some dispatches use `SendCommandAndIgnoreResponse`, so events are back-to-back with no inter-key delay.
- W3C WebDriver spec (`Element Click`): "Let click point be the element's in-view center point", then a `pointerMove` (origin = element), `pointerDown`, `pointerUp` action list is dispatched; `Element Send Keys`: "For each char of text" a `keyDown` and a `keyUp` action; the in-view center point is defined via `getClientRects()` and `floor((left + right) / 2.0)` [likely — definition section not captured verbatim].

### 2.5 Browser Use (CDP-native, 2026 codebase)

Sources: `browser_use/browser/watchdogs/default_action_watchdog.py`, `browser_use/browser/profile.py`, `browser_use/dom/service.py`, `browser_use/tools/service.py` (main, 2026-10-24).

- **Click target**: element rect from `get_element_coordinates()` expanded to a quad; the click point is the **average of the four corners (center of the bounding box)**, then clamped: `center_x = max(0, min(viewport_width - 1, center_x))`. Before clicking it runs `DOM.scrollIntoViewIfNeeded` (backendNodeId) + `asyncio.sleep(0.05)`, and `_check_element_occlusion` which evaluates **`document.elementFromPoint` in the page** (main world) — if occluded it falls back to `this.click()` via `Runtime.callFunctionOn` (an **untrusted** click).
- **Mouse sequence**: `Input.dispatchMouseEvent mouseMoved` → `sleep(0.05)` → `mousePressed` (`button: 'left'`, `clickCount: 1`) → `sleep(0.08)` → `mouseReleased`. No `force` → pressure 0. Coordinate clicks sleep 0.05 s between press and release. So Browser Use clicks have **click duration ≈ 80 ms with ~1–3 ms jitter** and **hover dwell ≈ 50 ms** — inside the human range for the mean, but with near-zero variance (cf. `click_duration_std` in §8.2).
- **Typing**: per character `keyDown` (`key`, `code`, `modifiers`, `windowsVirtualKeyCode`) → `sleep(0.005)` → `char` (`text`) → `keyUp` → `sleep(0.001)`; page-level typing and `send_keys` use `sleep(0.010)` between characters. Enter is `rawKeyDown` + `char '\r'` + `keyUp` (`windowsVirtualKeyCode: 13`). **No `random` import; every delay is a fixed constant** (0.001, 0.005, 0.01, 0.05, 0.08, 0.1, 0.2 s).
- **Clearing a field**: (1) native prototype value setter → `""` and **untrusted `input` + `change`**, (2) triple-click (`clickCount: 3`) + `Delete`, (3) select-all + `Backspace`. After typing, `_trigger_framework_events` calls `element.focus()` and dispatches untrusted `input`, `change`, `blur`. Date/time/color/range inputs are set directly with focus/input/change/blur events.
- **Scrolling**: page scroll via `Input.synthesizeScrollGesture` at the viewport center with `xDistance: 0, yDistance: -pixels, speed: 50000`; element scroll via `mouseWheel` with `deltaY: pixels` at the box-model center; iframes via `scrollTop +=`. `pages` → pixels = `pages × viewport height` from `Page.getLayoutMetrics` (`cssVisualViewport`, fallback `cssLayoutViewport`, else 1000); one `ScrollEvent` per whole page, 0.15 s between steps; result text "Scrolled down 800px". `find_text` walks text nodes with a TreeWalker and calls `node.parentElement.scrollIntoView({behavior: 'smooth', block: 'center'})`.
- **Profile defaults**: `wait_between_actions: float = Field(default=0.1)`, `minimum_wait_page_load_time: 0.25`, `wait_for_network_idle_page_load_time: 0.5`, `highlight_elements: True`, `wait(seconds=3)` sleeps `min(max(seconds-1,0),30)`. Chrome is launched with `--disable-blink-features=AutomationControlled` and without `--enable-automation` ("we mask the automation fingerprint via JS and other flags").
- **DOM extraction** (`dom/service.py`): no JS tree-walker any more — `DOMSnapshot.captureSnapshot` (`computedStyles: REQUIRED_COMPUTED_STYLES`, `includePaintOrder: True`, `includeDOMRects: True`), `DOM.getDocument {depth: -1, pierce: True}`, `Accessibility.getFullAXTree` per frame, `Page.getLayoutMetrics`. Main-world JS is still used for: `document.readyState`; iframe scroll positions (`document.querySelectorAll('iframe')`); and a **click-listener probe**: `if (typeof getEventListeners !== 'function')` guard, `const allElements = document.querySelectorAll('*');`, `if (allElements.length > 10000) return null;`, per-element `getEventListeners(el)` for click/mousedown/mouseup/pointerdown/pointerup, capped at `_MAX_JS_CLICK_LISTENER_ELEMENTS = 100`, sent with `'includeCommandLineAPI': True,  # enables getEventListeners()` and `'returnByValue': False`, comment "Detect elements with JavaScript click event listeners (without mutating DOM)." The legacy `buildDomTree.js` (v0.1.40) did run in the main world: `getBoundingClientRect`/`getComputedStyle` per element with `WeakMap` caches, `document.elementFromPoint` at element centers, `checkVisibility({checkOpacity:true, checkVisibilityCSS:true})`, and injected a `div#playwright-highlight-container` (`position: fixed`, `zIndex: 2147483647`) with `.playwright-highlight-label` labels and permanent `scroll`/`resize` listeners.
- Behaviour in the wild (Kang et al. 2026, §8.3): "Browser Use, a DOM-based agent, does not show the mouse movement in all scenarios"; 100 % Sec-Fetch rule violations; `HeadlessChrome` UA.

### 2.6 Skyvern

Sources: `skyvern/webeye/utils/dom.py`, `skyvern/constants.py`, `skyvern/webeye/scraper/domUtils.js`, `skyvern/webeye/scraper/scraper.py`, `skyvern/webeye/main_world_eval.py`, `skyvern/webeye/cursor_visualization.py`, `skyvern/webeye/utils/page.py`.

- **Click point is randomised**: `move_mouse_to` uses `epsilon = 0.01`, `dest_x = uniform(x + epsilon, x + width - epsilon) if width > 2 * epsilon else (x + width) / 2` (same for y), then `page.mouse.click(click_x, click_y)` (or `dblclick`). Primary click path is Playwright `locator.click()` via `EventStrategyFactory.click_element`, with fallbacks to coordinate click and `click_in_javascript` (untrusted). **Uniform landing inside the box is itself non-human** (humans cluster around the center, §5.6).
- **Typing**: `TEXT_INPUT_DELAY = 10  # 10ms between each character input`; `TEXT_PRESS_MAX_LENGTH = 10` — long values "seed a prefix" (fill) and the tail is typed. `hover_to_reveal` settle 0.15 s.
- **Scroll constants**: `SCROLL_AMOUNT_MULTIPLIER = 100`, `EXTRACT_ACTION_SCROLL_AMOUNT = 500`.
- **DOM side**: `domUtils.js` (`buildTreeFromBody`, `buildElementTree`, `isInteractable`, `isElementVisible`, `getVisibleText`, `drawBoundingBoxes` (deprecated), `QuadTreeNode`, ...) calls `getBoundingClientRect`, `getComputedStyle` (`defaultView.getComputedStyle`), `checkVisibility()`, `getClientRects`, `elementFromPoint`/`elementsFromPoint`, `innerText || textContent`, `createRange`; it **stamps elements with a `unique_id` attribute** (`setAttribute` in `ownUniqueId`; "4–6 alphanumeric characters, prefixed by a frame-index code"), `data-skyvern-otp-box="1"`, and defines `window.elementIdCounter`, `window.GlobalEnableAllTextualElements`, `window.captchaSolvedCounter`, `window.GlobalSkyvernFrameIndex`; scraper.py refers to `window.globalObserverForDOMIncrement`, `startGlobalIncrementalObserver`, `() => document.body.innerText`, and "visual bounding box overlays are no longer rendered during scraping". `main_world_eval.py` runs scripts via a CDP session `Runtime.evaluate` ("page.evaluate is avoided here because Playwright's function-string normalisation requires an unprefixed function head") — i.e. **main-world evaluation with no sourceURL** when a prefix is configured; otherwise `frame.evaluate` (isolated world). `cursorOverlay.js` draws a visible cursor overlay in the page (`ensure_cursor_overlay_loaded`, `cursor_move`, `cursor_click_ring`) when `BROWSER_CURSOR_VISUALIZATION` is on — a DOM-injection tell [likely; overlay markup not read].
- Behaviour in the wild (Kang et al.): "Skyvern (vision-based agent) shows much longer mouse trajectory lengths compared to other agents", highest mouse-move proportions, 17 TLS extensions, non-standard `sec-gpc` header.

### 2.7 Stagehand (Browserbase)

`@browserbasehq/stagehand` 4.3.0 is now a thin SDK (`dependencies`: `@browserbasehq/sdk`, OpenTelemetry, `zod`; no playwright/puppeteer) that drives either a local Chrome (`localBrowser.launch({ userDataDir })`, "Local runs need Chrome installed") or Browserbase; "Stagehand runs as an extension next to the browser, cutting round-trip latency on every action." The browser-side input path is not in the public TS package → **unknown** [uncertain]. Earlier Stagehand versions used Playwright `locator.click()`/`page.mouse.click` (center) and injected DOM scripts; treat current behaviour as "CDP-like, center click, instant move" until measured.

### 2.8 Playwright MCP (used by Claude Code, Cursor, etc.)

README (microsoft/playwright-mcp; code now lives in the Playwright monorepo): `browser_click` ("Perform click on a web page", `doubleClick`, `button`, `modifiers`, `target` = snapshot ref or selector) → Playwright `locator.click()` semantics (§2.2); `browser_type` — "By default entire text is filled in at once." with `slowly`: "Whether to type one character at a time."; `submit` presses Enter; `browser_press_key`; `browser_hover`; `browser_drag`; `browser_snapshot` ("Capture accessibility snapshot of the current page, this is better than screenshot") — aria snapshots are computed in Playwright's isolated world (invisible to the page); vision tools `browser_mouse_click_xy`, `browser_mouse_move_xy`, `browser_mouse_drag_xy`, `browser_mouse_wheel` (`deltaX`/`deltaY`). Consequence: default MCP typing is `fill` → `Input.insertText` (no key events); clicks are exact-center single-step with concurrent down/up.

### 2.9 Anthropic computer use (reference implementation + docs)

Source: `anthropic-quickstarts/computer-use-demo/computer_use_demo/tools/computer.py`; docs `platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool`.

- Constants: `TYPING_DELAY_MS = 12`, `TYPING_GROUP_SIZE = 50`, `_screenshot_delay = 2.0` s, `MAX_SCALING_TARGETS` = XGA 1024×768, WXGA 1280×800, FWXGA 1366×768; `CLICK_BUTTONS`: left `1`, right `3`, middle `2`, `double_click` = `"--repeat 2 --delay 10 1"`, `triple_click` = `"--repeat 3 --delay 10 1"`.
- Shell commands: `xdotool mousemove --sync {x} {y}`; `xdotool click 1`; `xdotool mousemove --sync {sx} {sy} mousedown 1 mousemove --sync {ex} {ey} mouseup 1` (drag = two teleports); scroll = optional `mousemove --sync x y` then `click --repeat {amount} {button}` with up=4, down=5, left=6, right=7 (modifier keys wrapped in `keydown`/`keyup`); `xdotool type --delay 12 -- {50-char chunk}`; `xdotool key -- {text}`; `hold_key` = `keydown … sleep {duration} keyup`; `left_mouse_down`/`up` = `mousedown 1`/`mouseup 1`. A screenshot is taken 2.0 s after each action.
- `scale_coordinates`: picks the target whose aspect ratio matches within 0.02 and whose width is smaller than the display; `x_scaling_factor = target_width / self.width`; API→computer coordinates are divided by the factor and **`round()`ed** (Python round-half-even), computer→API multiplied and rounded → a **lattice** of reachable physical pixels with spacing = 1/factor (e.g. 1.5 px for 1920→1280).
- Docs (2026 toolset `computer_toolset_20260801`, 17 member tools: `screenshot`, `zoom`, `left_click`, `right_click`, `middle_click`, `double_click`, `triple_click`, `left_click_drag`, `mouse_move`, `left_mouse_down`, `left_mouse_up`, `cursor_position`, `scroll`, `type`, `key` (`repeat` 1–100), `hold_key`, `wait` (≤ 300 s)): "For general desktop tasks, use 1024x768 or 1280x720; for web applications, use 1280x800 or 1366x768." / "Avoid resolutions above 1920x1080 to prevent performance issues." / "**Coordinates are in screenshot pixels.** … If you scale screenshots down before returning them, scale Claude's coordinates back up before applying them to the real display." / "**macOS Retina displays** capture screenshots at a device pixel ratio of 2... Either downscale the screenshot by 2x before sending, or halve the coordinates Claude returns before issuing the click." `scroll_amount` = "number of scroll-wheel clicks". Recommended pattern "Add action delays": `click_and_wait(x, y, wait_time=0.5)`; batches "Run blocks in order and stop at the first failure." (→ bursts of actions inside one model turn).

### 2.10 xdotool / XTest (Linux computer-use agents, also VNC)

Sources: `jordansissel/xdotool` `xdo.c`, `cmd_click.c`, man page.

- `#define DEFAULT_DELAY 12` used as `usleep(DEFAULT_DELAY)` between `xdo_mouse_down` and `xdo_mouse_up` in `xdo_click_window` → **12 µs** between press and release at the X level (the man page says "(currently 12ms)"; the code says 12 µs — either way far below human). `click --repeat N` sleeps `--delay` between clicks: `useconds_t delay = 100000; /* 100ms */` default → wheel ticks or double-clicks spaced 100 ms unless overridden (Anthropic passes `--delay 10` for double/triple click, nothing for scroll → 100 ms between wheel events).
- `xdo_enter_text_window`: `down_delay = up_delay = delay / 2;` (cap 50 ms on the press half) → with `type --delay 12`: **6 ms key hold, 6 ms gap**, every key.
- `xdo_move_mouse`: `XTestFakeMotionEvent(xdo->xdpy, 0, x, y, CurrentTime)` (or `XWarpPointer` on other screens) → **a single warp, no intermediate motion**. `mousemove --sync` "wait until the mouse is actually moved".
- Buttons/keys go through `XTestFakeButtonEvent` / `XTestFakeKeyEvent` ("we only use XSendEvent when a specific window is targeted. Otherwise, we use XTEST"). XTest events are real X input to the browser → `isTrusted: true`, real platform event builders (so `pressure` 0.5 while pressed, platform wheel ticks, OS timestamps).
- Caveat: VNC servers inject the remote *human's* input through the same XTest path; the browser cannot distinguish XTest from a physical device. Only trajectory/timing statistics separate xdotool agents from VNC users (§12.8).

### 2.11 PyAutoGUI (OpenAI CUA sample app 2026, Open Interpreter, many DIY agents)

OpenAI's sample app now has the model write PyAutoGUI code (`exec_py` tool: "Use PyAutoGUI mouse and keyboard input… Screenshots use the same coordinates as PyAutoGUI input, including on Retina displays."; worker resizes screenshots to `pyautogui.size()` on Retina). PyAutoGUI docs: "Normally the mouse cursor will instantly move to the new coordinates." / "If the duration is less than `pyautogui.MINIMUM_DURATION` the movement will be instant. By default, `pyautogui.MINIMUM_DURATION` is 0.1."; movement with a duration goes "directly towards the destination in a straight line at a constant speed" (linear tween by default); `click()` = "pushing the button down and then releasing it up" with no pause; `scroll()` takes "an integer number of 'clicks'" and "The amount of scrolling in a 'click' varies between platforms." OpenAI docs: "The model can request `click`, `double_click`, `drag`, `move`, `scroll`, `keypress`, `type`, `wait`, or `screenshot`." and "map the model's coordinates back to the environment's coordinate space before executing actions."; the pickup lab sets viewport `{ width: 1024, height: 768 }` and clicks with `await this.page.mouse.click(action.x, action.y);` (integer screenshot coordinates straight into Playwright).

### 2.12 Claude in Chrome (extension) — empirical probe, 2026-10-24

Setup: a local page (`probe.html`) registering capture-phase listeners for 39 event types and wrapping `getBoundingClientRect`, `getClientRects`, `getComputedStyle`, `elementFromPoint(s)`, `querySelectorAll`, `checkVisibility`, `innerText`, `textContent`, `scrollIntoView`, `HTMLElement.click`, `dispatchEvent` with call counters and sampled `Error().stack`. Driven with the extension's `computer` tool (hover, left_click, type, key, scroll ×2, double_click, left_click_drag, click-by-ref, scroll_to), `form_input`, `read_page`, `find`, `javascript_tool`. Environment: Chrome 155 (UA `Chrome/155.0.0.0`), macOS, `devicePixelRatio 2`, viewport 1728×919, `navigator.webdriver === false`, `document.hasFocus() === true`. Raw log: 160 events (saved locally during research). Findings [measured]:

1. **Coordinate quantisation**: the extension's screenshot frame was 1512×804 for a 1728×919 viewport (scale 7/8). Requested `(204,190)` landed at `(233,217)`; `(238,266)` → `(272,304)`; drag `(300,600)→(500,650)` → `(343,686)→(571,743)` — i.e. `clientX = round(x_model × 8/7)`. Reachable client coordinates form a lattice (every 8th integer unreachable). Click-by-ref landed at `(205,190)` = element center `(204.5,190.375)` rounded to integers.
2. **One pointer sample per action**: each hover/click emitted exactly one `pointerrawupdate` + `pointermove` (+ `mousemove`) with `movementX/Y` equal to the full jump (e.g. `mx=39 my=87`, `mx=-366 my=-553`), `getCoalescedEvents().length === 1`, `getPredictedEvents().length === 0`. The drag produced 5 intermediate samples inside ~1.5 ms (coalesced 1–2, predicted 10 on two frames).
3. **Pointer properties**: `pointerType "mouse"`, `pointerId 1`, `isPrimary true`, `width/height 1`, `pressure 0` when hovering and **0.5 during press** (so this path sets `force 0.5`, like Playwright, unlike Puppeteer), `tiltX/Y 0`, `persistentDeviceId 1` (click events: `persistentDeviceId 0`, `isPrimary false` — normal Chrome click-event quirks), `sourceCapabilities {firesTouchEvents:false}`, `isTrusted true`.
4. **Timing**: `pointermove → pointerdown` 1.7–2.0 ms (9 ms for the ref click); **`pointerdown → pointerup` 1.2–1.6 ms**; double-click = two full clicks 0.7 ms apart; `mousedown.detail` 1/2 as expected; `Event.timeStamp − performance.now()` skew < 2 ms for discrete events; wheel events had 10–16 ms latency (rAF alignment).
5. **Typing** (`type "ab cd"`): full `keydown`/`keypress`/`keyup` per character with correct `keyCode`/`code`, **dwell 0.1–0.2 ms, inter-key 0.1–0.3 ms** (5 characters in 0.9 ms). `key Tab`: 1.0 ms dwell.
6. **Scroll** (`scroll_amount 3`): **one `wheel` event with `deltaY 300`, `deltaMode 0`, `wheelDeltaY -120`** (ratio 0.4 — impossible for a real device, §7), then either a smooth-scroll animation (17 `scroll` events over ~150 ms, 8 ms apart) or an instant 300 px jump (second scroll). `scroll_to` (ref) and click-by-ref scrolled programmatically (`scroll` to 0 with no wheel/key).
7. **`form_input`**: trusted `focus`/`focusin` on the field, then **untrusted `change` and `input`** (`isTrusted:false`), value set programmatically, no key events.
8. **Page reading**: `read_page`/`find` produced **no main-world calls** to the wrapped prototypes (`calls == {gbcr: 2}`, both from my own script) → the accessibility-tree reading is invisible to page instrumentation. `javascript_tool` code executes in the main world with stack frames `at <anonymous>:1:44` (no script URL).
9. Session shape: `visibilitychange`/`blur`/`focus` pairs when the extension switched tabs; the pointer never left the viewport; no incidental `mouseover` on non-targets besides those on the path of the single-step move.

Caveat: single run, one machine, one extension version; numbers are indicative but the mechanisms (quantised coordinates, single-step moves, sub-2 ms clicks and keystrokes, ±120 wheelDelta) are structural.

### 2.13 Humanizer libraries (ghost-cursor and relatives)

Source: `Xetera/ghost-cursor` `src/spoof.ts`.

- Paths: `bezierCurve(start, end, spreadOverride)`; Fitts: `const a = 0`, `const b = 2`, `id = Math.log2(distance / width + 1)`, `DEFAULT_WIDTH = 100`; steps: `Math.ceil((Math.log2(fitts(length, width) + 1) + baseTime) * 3)` with `MIN_STEPS = 25`, `baseTime = speed * MIN_STEPS`, `speed = 25 / moveSpeed` (random when unset); points = `curve.getLUT(steps)` (equal parameter spacing), clamped ≥ 0.
- Overshoot: only when `magnitude(direction(a, b)) > overshootThreshold` (default `500` px); `OVERSHOOT_SPREAD = 10`, `OVERSHOOT_RADIUS = 120`; second corrective curve.
- Landing point: `getRandomBoxPoint` → uniform inside the box (optionally padded) — **uniform, not center-biased**.
- Dispatch: each point sent as `Input.dispatchMouseEvent {type:'mouseMoved'}` **with no sleep between points** (timestamps optional via `useTimestamps`/`generateTimestamps` — i.e. the library can forge `Event.timeStamp` spacing while the real arrival cadence is "as fast as CDP acks"); no `force` → pressure 0 on press.
- Click: `hesitate: 0`, `waitForClick: 0` defaults → `mouseDown` immediately followed by `mouseUp`; `moveDelay: 2000` (×`Math.random()`) *after* a click.
- Scroll: `DOM.scrollIntoViewIfNeeded` fast path, else `mouseWheel` steps, else `scrollIntoView({block:'center', behavior: scrollSpeed < 90 ? 'smooth' : undefined})`.

Detector consequences: ≥ 25 samples per move regardless of distance; arrival cadence ≈ CDP round-trip (≈ 0.3–3 ms), not 8/16 ms; velocity profile from an equal-parameter Bézier LUT is smooth with no tremor/sub-movements (BeCAPTCHA's stroke count N ≈ 1); overshoot appears only beyond 500 px and with a fixed 120 px radius; zero-duration clicks; uniform landing distribution. The DMTG paper (§5.4) measured simple classifiers detecting ghost-cursor trajectories at 0.89–0.96 accuracy.

---

## 3. Event-property tells for synthetic vs OS input (Chromium)

All rows are for Chromium unless stated. Blink sources: `pointer_event_factory.cc`, `web_pointer_properties.h`, `mouse_event.cc`, `wheel_event.cc`, `simulated_event_util.cc`, `event_dispatcher.cc`; platform builders `web_input_event_builders_win.cc`, `components/input/web_input_event_builders_mac.mm`, `ui/events/x/events_x_utils.cc`, `ui/events/pointer_details.cc`.

| Property | Real OS mouse | CDP (Puppeteer/ChromeDriver/Browser Use/ghost-cursor) | Playwright / Claude in Chrome | `element.click()` / `dispatchEvent` | Chrome AT simulated click (`kFromAccessibility`) | Keyboard-activated click (`kFromUserAgent`) |
|---|---|---|---|---|---|---|
| `isTrusted` | true | true | true | **false** | true | true (if underlying key event trusted) |
| `pressure` on `pointerdown` | **0.5** (force NaN → `GetPointerEventPressure`: `if (!buttons) return 0; if (std::isnan(force)) return 0.5; return force;`) | **0** (`force.value_or(0)` → returns force) | 0.5 (explicit) | 0 (init default) | **0** (PointerEventInit default) | n/a (no pointerdown) |
| `pointerId` | 1 (`kMouseId = 1`, "Mouse id is 1 to behave the same as MS Edge") | 1 | 1 | 0 (default) | 1 (`setPointerId(kMouseId)`) | **−1** (`kReservedNonPointerId`) |
| `pointerType` | "mouse" | "mouse" (default) or "pen" | "mouse" | "" | "mouse" | "" |
| `width`/`height` | 1 for mouse | 1 | 1 | 1 | 1 | 1 |
| `movementX/Y` | per-sample deltas (raw on mac when `kCGEventUnaccelerated…` available) | consistent teleport deltas (computed from `last_global_position`) | same | 0 | 0 | 0 |
| `screenX/Y` | widget origin + chrome offset | `point_in_widget + view_bounds_in_screen.OffsetFromOrigin()` (consistent with window) | same | 0 unless set | element center in screen coords | 0 |
| `clientX/Y` | integer for `click`/`auxclick`/`contextmenu`; fractional allowed on other pointer events (Chrome shipped fractional coordinates for mouse-type PointerEvents; 2021 W3C note: "click, auxclick and contextmenu events will be instances of PointerEvents but their coordinates will be integers") | any float the caller passes (center = `.5`/`.25` multiples) | same | 0 | **element border-box center (rounded)**: `PhysicalBorderBoxRect().Center()` → `ToRoundedPoint` | 0 |
| `detail` on `mousedown`/`click` | 1, 2, 3 (click count) | from `clickCount` param (default 0 → detail 0 if omitted!) | 1 | 0 | `mousedown` 0 / `click` **1** (`setDetail(1)` only for click) | 0 |
| `buttons` on `pointerdown` | 1 | from `buttons` param (Puppeteer/Playwright set it) | 1 | 0 | 1 (`kLeftButtonDown`) | 0 |
| `sourceCapabilities` | `InputDeviceCapabilities{firesTouchEvents:false}` | same (measured `{fte:false}`) | same | null | **null** (only set when the underlying event is a MouseEvent) | null |
| `getCoalescedEvents().length` on `pointermove` | ≥ 1; > 1 when the device rate exceeds the frame rate (mice "typically at 100Hz (but can be anywhere up to 2000Hz)" vs 60 Hz refresh) | 1 (each CDP call is one event; measured 1, occasionally 2 in a fast drag) | 1 | 0 | n/a | n/a |
| `persistentDeviceId` | spec: "A unique identifier for the pointing device… `0` … could not be identified" | measured 1 for the extension's synthetic mouse [uncertain what real devices report] | 1 | 0 | ? | ? |
| `Event.timeStamp` | OS event time (Windows: ms message time; X11: ms server time; mac: NSEvent timestamp) | `base::TimeTicks::Now()` at browser receipt, **or any caller-supplied `timestamp`** | same | dispatch time | `TimeTicks::Now()` | underlying key event time |
| `wheelDeltaY` vs `deltaY` | platform ratio (§7) | `wheelDelta = ±120` regardless of `deltaY` | same | caller-defined | n/a | n/a |
| `deltaMode` | 0 (pixels) on Chrome | 0 (`kScrollByPrecisePixel`) | 0 | caller | n/a | n/a |

Notes:

- Chrome's `Event.timeStamp` and `performance.now()` are coarsened to 100 µs (5 µs when cross-origin isolated) since Chrome 91 (developer.chrome.com "Align performance API timer resolution"); Firefox rounds `Event.timeStamp` to 1 ms ("0.02 ms in cross-origin-isolated contexts", 16.667 ms with `privacy.resistFingerprinting`) — so sub-millisecond intervals are measurable in Chrome but not in Firefox. Do not rely on timestamp granularity as a bot signal; coarse clocks are legitimate (the Balabit RDP data, §4.2, is quantised to ~15.6 ms).
- `persistentDeviceId` is new (Pointer Events Level 3); its values for real mice are not established here — measure before using.
- The Pointer Events spec: "the value MUST be `0.5` when in the active buttons state and `0` otherwise" for hardware without pressure; width/height default 1; "All `pointerup` events have a `pressure` value of `0`."
- `UIEvent.sourceCapabilities` is only populated by Blink for input-originated events and for simulated clicks whose underlying event is a mouse event; it is a cheap way to tell a trusted UA-simulated click (null) from a trusted pointer-originated click (non-null).

---

## 4. Event ordering, timing and human baselines

### 4.1 Micro-sequences

Real pointer click on a fresh target (Chrome): `pointerrawupdate` (secure contexts) → `pointerover`/`pointerenter` → `mouseover`/`mouseenter` → N × (`pointermove`, `mousemove`) → `pointerdown` → `mousedown` → (`focus`/`focusin`) → `pointerup` → `mouseup` → `click`. Continuous events are rAF-aligned since Chrome 60 ("Starting in Chrome 60, the input pipeline will delay dispatching continuous events" — wheel, mousewheel, touchmove, pointermove, mousemove — "right before the rAF callback"); discrete events (keydown, keyup, mouseup, mousedown, touchstart, touchend) "will be dispatched right away along with any pending events"; `getCoalescedEvents()` since Chrome 58 recovers the raw samples.

Synthetic sequences:

- Playwright/Puppeteer/ChromeDriver/Browser Use/Claude in Chrome: exactly one `pointermove` (from wherever the pointer last was, possibly hundreds of px away) → `pointerdown` within ~2 ms (Browser Use: 50 ms) → `pointerup` within ~1–2 ms (Browser Use: 80 ms) → `click`.
- xdotool/PyAutoGUI: one OS motion event (warp) → press → release 12 µs/≈0 ms later (the browser timestamps them separately; expect sub-ms to few-ms `mousedown→mouseup`).
- Chrome AT simulated click: `pointerdown`, `mousedown`, `pointerup`, `mouseup`, `click` with **no pointermove/over/enter at all** (Blink TODO: "User Agent Simulated Clicks should change hover states, fire events like mouseout/mouseover etc.").
- Keyboard activation (Enter/Space on a button): only `click` (`detail 0`, coords 0, `pointerId -1`), preceded by `keydown`.
- `element.click()`: only an untrusted `click`.

### 4.2 Human baselines (measured here from public datasets)

**Mouse click duration (press→release)** — Balabit Mouse-Dynamics-Challenge training sessions (RDP-captured; 3 sessions, 5,252 left clicks):

| session | n | mean | p5 | p25 | p50 | p75 | p95 |
|---|---|---|---|---|---|---|---|
| user12/session_2144641057 | 1021 | 178.8 ms | 63 | 93 | 109 | 125 | 780 |
| user15/session_0205904470 | 1062 | 137.9 ms | 78 | 93 | 109 | 124 | 203 |
| user16/session_0735651357 | 3169 | 159.7 ms | 62 | 78 | 94 | 109 | 656 |

(Values cluster on multiples of ~15.6 ms because the RDP client timestamps are 1/64 s quantised — a reminder that real data can have coarse clocks.) Balabit README: "record timestamp: elapsed time (in sec) since the start of the session as recorded by the netork monitoring device", "client timestamp … as recorded by the RDP client"; 10 users.

**Mouse move sampling in the same RDP data**: Move→Move Δt p25 = 109 ms, p50 = 110–124 ms, p95 = 468–717 ms, with many samples sharing one timestamp (batches) — i.e. remote-desktop sessions deliver movement in ~100 ms bursts, not 8 ms samples (§12.8). Chu et al. (2013): "in Windows 7, the polling rate is 125Hz, namely polling every 8 milliseconds"; Chrome blog: mice "typically at 100Hz (but can be anywhere up to 2000Hz)"; BeCAPTCHA synthesis at 200 Hz; Dhakal et al.: USB polling "standard is set to 10 ms".

**Keystrokes** — CMU keystroke benchmark (Killourhy & Maxion, `DSL-StrongPasswordData.csv`, 51 subjects × 400 repetitions of a fixed 10-character password; 224,400 hold samples, 204,000 digraphs):

- Hold (dwell) time: mean 90.1 ms; p1 38, p5 49, p25 69, p50 86, p75 106, p95 145, p99 182 ms.
- Down-Down latency: mean 249 ms; p5 78, p25 128, p50 191, p75 301, p95 602, p99 1040 ms.
- Up-Down (flight): mean 159 ms; **10.8 % negative (rollover)**.

Dhakal et al. CHI 2018 (136,857,600 keystrokes, 168,960 participants): WPM 51.56 (SD 20.20); IKI 238.66 ms (SD 111.6), "A lower bound of about 60 ms can be observed"; fast typists IKI "∼120 ms, with a standard deviation of only 11 ms", slow "over 480 ms"; keypress duration "116.24 ms (SD = 23.88) … (80–150 ms)"; rollover ratio 25 % (49.9 % fast typists, 7.6 % slow); "Local logging of timestamps is accurate to 1 ms".

Chu et al. 2013 (Computer Networks 57:634–646, "Blog or Block"): "About 21.49% of bot keystrokes are less than 0.05 second, and only 5.82% of human keystrokes are issued within that range."; bots show peaks "at 0.05 and 0.25 seconds" ("periodic timers"); "While 45.42% of bot keystrokes are held less than 0.3 second, only 23.11% of human keystrokes are within that range."

### 4.3 Suggested timing thresholds (proposal, calibrate per site)

| Feature | Definition | Human (from data) | Synthetic | Threshold / scoring |
|---|---|---|---|---|
| `click_dur` | `t(pointerup) − t(pointerdown)` same pointerId | p5 ≈ 60–80 ms, median ≈ 95–110 ms, long tail (drags) | Playwright/Puppeteer/ChromeDriver/xdotool/PyAutoGUI/Claude-ext: 0–3 ms; Browser Use ≈ 80 ms | `< 20 ms` ⇒ strong synthetic (AT-gated, §12.5); `20–40 ms` ⇒ weak |
| `click_dur_std` | std of `click_dur` over ≥ 5 clicks | tens of ms | < 3 ms (Browser Use), ≈ 0.5 ms (CDP) | `< 5 ms` with n ≥ 5 ⇒ strong (top-2 feature in arXiv 2607.26935) |
| `pre_click_move_gap` | `t(pointerdown) − t(last pointermove)` | 100–600 ms typical (verification phase) | ≈ 2 ms (Playwright), 50 ms (Browser Use), 9 ms (ext ref click) | `< 10 ms` ⇒ strong; combine with `moves_before_click` |
| `moves_before_click` | count of `pointermove` in the 2 s before `pointerdown` | tens–hundreds (Castle: 378 vs 4) | 0–1 (CDP), 25+ (ghost-cursor, but ≈ 1 ms apart) | `≤ 1` ⇒ strong; also check Δt distribution |
| `move_dt_mode` | modal inter-`pointermove` interval | ≈ display frame period (8.3/16.7 ms) | ≈ 0.3–3 ms (ghost-cursor, Playwright steps) or n/a | mode `< 5 ms` with ≥ 20 moves ⇒ strong |
| `key_dwell` | `t(keyup) − t(keydown)` same code | mean 90–116 ms, p1 ≈ 38 ms | 0.1–0.3 ms (Playwright/Puppeteer/ext), 5 ms (Browser Use), 6 ms (xdotool), 10 ms (Skyvern) | `< 30 ms` for ≥ 3 keys ⇒ strong |
| `iki` | down→down between printable keys | mean 239 ms, ≥ 60 ms lower bound | ≤ 12 ms | `< 40 ms` for ≥ 3 keys ⇒ strong; `CV(iki) < 0.1` over ≥ 10 keys ⇒ strong (periodic timers) |
| `rollover_ratio` | share of UD < 0 | 25 % mean (7.6–49.9 %) | 0 % (sequential dispatch) | `0 %` over ≥ 40 keys from a typist with mean IKI < 150 ms ⇒ weak support |
| `dblclick_gap` | `t(mousedown₂) − t(mouseup₁)` | tens–hundreds of ms (Windows limit 500 ms) | 0.7 ms (ext), 10 ms (Anthropic `--delay 10`), ≈ 0 (Playwright clickCount 2) | `< 15 ms` ⇒ strong |

---

## 5. Mouse dynamics: research feature sets and what catches synthetic paths

### 5.1 Feature taxonomy (survey arXiv 2208.09061, "Mouse Dynamics Behavioral Biometrics: A Survey")

Spatial/geometry: traveled distance ("Distance between two adjacent mouse positions"), curve length, movement offset, deviation distance ("Maximum distance from mouse trajectory to straight line"), straightness/efficiency ("The ratio of straight line distance to trajectory distance"), jitter ("Tremor of movement measured as the ratio of the interpolated path length"), self-intersection, regularity, central moments of curvature. Temporal: elapsed time/mouse digraph, acceleration beginning time, trajectory of center of mass, scattering coefficient. Kinematic: velocity (magnitude+direction), horizontal/vertical velocity and acceleration, tangential velocity/acceleration/jerk, angle of movement θ ("Angle of the path tangent to the x axis"), angular velocity ω, curvature κ ("one over radius"), curvature velocity, rate of curvature, total angles/bending energy; click features: "time to click, paused time, the number of pauses and paused ratio". Statistics: min, max, median, mean, max−min, SD, variance, skewness, kurtosis. Public datasets listed: Chaoshen-1 (58 users, fixed sequence, 17.4k samples/user), Chaoshen-2 (28), ISOT (48), Balabit (10), DFL (21), BB-MAS (117), TWOS (24/20), Minecraft (10→40). "benchmarking studies based on common datasets do not exist."

### 5.2 BeCAPTCHA-Mouse (Acien, Morales, Fierrez, Vera-Rodriguez; Pattern Recognition 2022, arXiv 2005.00890)

- Neuromotor model: each velocity profile decomposed into N lognormal strokes (Sigma-Lognormal / Plamondon kinematic theory); per stroke six parameters D_i, t0_i, μ_i, σ_i, θs_i, θe_i; max/min/mean per parameter per trajectory half (36) + N → **37 features**. Fused with a "global" feature set attributed to Chu et al. (reported as 66 features: duration, distance, displacement, average angle, average velocity, move efficiency = distance/displacement).
- Data: Shen et al. dataset, 58 users, 8-button point-and-click task (8 trajectories/task); synthetic: function-based (linear/quadratic/exponential shapes × constant/logarithmic/Gaussian velocity profiles; point count M drawn from the human distribution) and a GAN (two LSTM layers 128/64; seed R = 100; 200 Hz).
- Results (Random Forest, per single trajectory): neuromotor 94.7–99.3 %, global 95.3–99.8 %, fused 98.0–99.9 %; GAN samples were *easier* to detect than function-based ("surprising"). Training on real only vs real+fake: fused 59.9 % → 98.2 % ("95.4% relative error reduction"). Ablation: SVM 98.0/98.5, RF 98.5/99.7, GRU 98.4/99.3, KNN 93.4/94.1 (function-based/GAN). Headline: ~93 % with one trajectory on average, up to 98.7 %.
- Implication: the **number of lognormal sub-movements N and the lognormal shape of the velocity profile** (bell-shaped with asymmetric tail, corrective sub-movements near the target) are what Bézier/linear generators lack. Train with synthetic negatives generated by the same libraries agents use (ghost-cursor, Bézier, linear).

### 5.3 Chu, Gianvecchio, Koehl, Wang, Jajodia 2013 ("Blog or Block", Computer Networks)

- Actions parsed from raw events: Keystroke, Click, Point-and-Click ("A point followed by a click within 0.4 s"), Drag-and-Drop, Silence. Features (Table 2): duration, distance, displacement, displacement angle, average speed, move efficiency (displacement/distance), virtual key value, **timing entropy** (corrected conditional entropy of the raw inter-event interval sequence, Q-binned — detects periodic timers).
- Measurements: human Point-and-Click displacement "About 60.64% of displacements are less than 400 pixels, while only 8.52% are greater than 1000 pixels. In contrast, bots tend to move the mouse at all displacements."; "The average speed of bot is 1520.83 pixels per second in our observation, but the average speed of human is 427.43 pixels per second. Furthermore, human speed is limited within 3500 pixels per second"; "About 59.23% of bot movements achieve efficiency greater than 0.94, while only 28.60% of human movements are equally efficient."; human efficiency "follows a lognormal (3P) distribution"; "some bots move the mouse at fixed speeds".
- Detection: C4.5/J48 on action groups; TPR 0.974 (2 actions/group) to 0.9945 (4), TNR 0.9989–0.9996; "overall detection accuracy greater than 99%"; 97.9 % of contemporary blog bots. Bot classes: form-injection (no UI data), human-mimic (OS API events: "move the mouse cursor in straight lines at a constant speed, or strike keys with fixed intervals"), replay (recorded human traces — hardest; see ReMouse dataset for repeat-session defence).

### 5.4 Generated trajectories vs detectors (DMTG, arXiv 2410.18233)

Ten detectors (DT, RF, XGB, GB, MLP, CNN, RNN, LSTM, BiLSTM, TCN) on SapiMouse (120 users) + Open Images traces; accuracy ranges per generator: independent setting — DMTG 0.868–0.919, **Ghost (ghost-cursor) 0.890–0.965**, SapiAgent 0.888–0.9995, Bézier 0.962–0.987, Linear 0.905–0.998, GAN 0.994–0.9996; unified setting — DMTG 0.726–0.876, Ghost 0.837–0.942, SapiAgent 0.836–0.974, Bézier 0.932–0.975, Linear 0.933–0.972, GAN 0.939–0.975. Distribution gap (JSD): DMTG 0.3025, Ghost 0.3565, GAN 0.5865, SapiAgent 0.6325. Physical properties the authors found necessary: "slow initiation" and direction-dependent acceleration (push vs pull). Also: "For reCAPTCHA v3, the paper says it found that mouse trajectory is not a significant factor." Takeaway: naive generators are ~95–99 % detectable; diffusion-based generators push a generic classifier to ~80 %, so **mouse-path realism alone must not be the only line of defence** (combine with §3/§4 dispatch-level tells, which generators cannot fix without changing the dispatch mechanism).

### 5.5 Vendor observations

- Castle.io ("Bot or not: can you spot the automated mouse movements?"): simple bots "instantly jump between two locations"; straight lines mean "zero acceleration"; humans' acceleration "is almost never close to zero"; "A count that is not in the hundreds is generally suspicious" (378 mousemove events for the human path vs four for the bot); Bézier bots are "much harder to differentiate … both visually and by using detection rules".
- Bureau (DELBOT-Mouse dataset analysis, Aug 2025): human displacement "Gaussian-like curve centered around 300–400 pixels", bots bimodal with a peak ">800 pixels"; efficiency = Euclidean/path length, human peak "around 0.3–0.4"; bot angles show "Sharp peaks at fixed angles (0, ±π/2, ±π)"; bot pauses "cluster in a narrow window"; bot heat "concentrated in corners and along straight lines". (Vendor blog; no accuracy numbers.)

### 5.6 Click-position statistics (center bias vs human endpoint spread)

- Automation: Playwright `quadMiddlePoint`, Puppeteer `box.x + width/2`, ChromeDriver `rect.Width()/2`, Browser Use corner average, WebDriver "in-view center point", Chrome AT clicks `PhysicalBorderBoxRect().Center()` (rounded), Claude-in-Chrome ref click = center rounded. Skyvern and ghost-cursor: uniform inside the box.
- Humans: ISO 9241-9/-411 effective width `We = 4.133 SDx` — "SDx – standard deviation in selection coordinates along axis of approach", "We is the central 96% of the spatial distribution", "Assumption: distribution is normal (generally true)" (MacKenzie). With nominal-width targets (We ≈ W), σ ≈ W/4.133 per axis. Probability a human lands within ±0.5 px of the exact center on one axis ≈ 1/(σ√2π) ≈ 1.65/W → for a 100 px-wide button ≈ 1.6 %, both axes for 100×40 px ≈ 0.07 %. Ten consecutive dead-center clicks are astronomically unlikely for a human and routine for CDP stacks.
- Features: `center_dist_norm = ‖p − c‖ / (W/2, H/2)` per click; `exact_center_frac` (|dx| ≤ 0.5 ∧ |dy| ≤ 0.5); `center_z = dx/(W/4.133)` distribution (humans ~N(0,1) with a slight bias toward the approach side; bots δ at 0 or uniform); `landing_uniformity` (KS test against uniform over the box → Skyvern/ghost-cursor).
- Lattice test for computer-use agents: collect device-pixel click coordinates `X = clientX × devicePixelRatio`; for candidate scale factors s ∈ {8/7, 1.25, 4/3, 1.5, 1.6, 1.875, 2, 2.5, 1.35 (1728/1280), 1.5 (1920/1280), 2.25 (2880/1280)} compute the fraction of coordinates with `|X − s·round(X/s)| ≤ 0.5`; humans ≈ chance (≈ 1/s), agents ≈ 1. With DPR 2 and the Anthropic "halve the coordinates" guidance, all client coordinates are integers while a human at DPR 2 produces `.5` fractions about half the time on `pointerdown` (not on `click`, which Chrome keeps integer). Need ≥ 8–10 clicks for a confident call; AT voice-grid clicks (§12.3) also land on cell centers — gate with movement features.
- Sub-device-pixel impossibility: for real input, `clientX × devicePixelRatio` is an integer (OS pixels) on Windows/Linux and for mouse on macOS [likely; pen/touch can be sub-pixel]. CDP centers like `204.5` at DPR 1 (`409 device px` is fine) vs `100.25` (not reachable) — compute `frac(clientX × DPR)`; non-zero beyond float noise ⇒ synthetic coordinates. Verify per platform before enabling.

### 5.7 Trajectory feature definitions (for the SDK)

For each movement segment (sequence of pointermove samples between pauses > 100 ms or clicks), using coalesced samples when available:

- `n_samples`, `duration`, `path_len = Σ‖Δp‖`, `displacement = ‖p_end − p_start‖`, `efficiency = displacement/path_len` (human median ≈ 0.3–0.9 by task; bots ≈ 1 for straight lines; Chu: 59 % of bot moves > 0.94 vs 29 % human).
- Velocity `v_i = ‖Δp_i‖/Δt_i`, acceleration `a_i = Δv_i/Δt_i`, jerk `j_i = Δa_i/Δt_i`; summary: max/mean/SD/skew/kurtosis; `frac_zero_accel` (|a| < ε) — Castle: bots ≈ 1, humans ≈ 0; `n_velocity_peaks` (≈ number of sub-movements; humans usually 1 main + 1–3 corrective peaks; Bézier LUT paths have 1 smooth peak; linear constant-velocity paths have none).
- Bell-shape fit: fit a lognormal (or Gaussian) to the normalised velocity profile; `R²` and asymmetry (humans: fast rise, slow tail; constant/linear profiles fit badly).
- Curvature `κ_i = |Δθ_i| / ‖Δp_i‖`, `total_turn = Σ|Δθ|`, `max_deviation` from the chord, `jitter = path_len / smoothed_path_len` (humans > 1 by tremor; Bézier ≈ 1.00), `angle_hist` on 8 bins (bots: axis-aligned peaks).
- Endpoint behaviour: `overshoot` (max projection beyond the target along the chord), `n_direction_reversals` near the end (humans often 1–2 corrections; ghost-cursor: overshoot only when > 500 px with fixed 120 px radius), `hover_dwell` (time from entering the target box to pointerdown; humans 100–600 ms).
- Timing: `dt_mode`, `dt_cv`, `frac_dt_lt_5ms`, `coalesced_mean` (`getCoalescedEvents().length` average on pointermove: real ≈ device_rate/frame_rate, e.g. 125/60 ≈ 2; synthetic ≈ 1), `timestamp_skew = performance.now() − e.timeStamp` at handler time (real: 0–20 ms, rAF-bounded; forged timestamps show negative or drifting skew).
- Fitts' law residual: regress `MT` on `log2(A/W + 1)` across a session's clicks (humans: positive slope, R² moderate; ghost-cursor imposes a=0, b=2 structure on *step count*, not time; CDP teleports: MT ≈ 0 regardless of A).

Suggested session-level scores: `trajectory_score` = mean over segments of a small gradient-boosted model trained on human (Balabit/SapiMouse/DFL/BeCAPTCHA human) vs synthetic (ghost-cursor, Bézier, linear, GAN, CDP-step interpolations) using the above features; this is where the literature's 93–99 % numbers come from, with the caveat that diffusion generators degrade it (§5.4).

---

## 6. Keystroke dynamics and text-entry tells

### 6.1 Human vs synthetic timing

See §4.2–4.3. Additional synthetic signatures by stack: Playwright `type` without delay (per-char `keyDown`+`keyUp` awaited over the websocket → ≈ 0.2–2 ms dwell, ≈ 1–3 ms IKI; measured 0.1–0.3 ms in the Chrome extension), Puppeteer identical, ChromeDriver `rawKeyDown`+`char`+`keyUp` back-to-back, Browser Use 5 ms dwell / ≈ 6–10 ms IKI (fixed), xdotool `type --delay 12` → 6 ms/6 ms (fixed), Skyvern 10 ms IKI, PyAutoGUI `typewrite(interval=0)`.

### 6.2 Structural keystroke features

- `dwell` per key, `iki`, `ud` (flight), `rollover_ratio`, `dwell_cv`/`iki_cv` over the session (periodic timers → CV ≈ 0; Chu's timing entropy).
- `keydown_without_keypress` for printable keys: CDP `rawKeyDown` (no `text`) produces `keydown` but no `keypress`/`input`; Playwright/Puppeteer only use it for non-printing keys, so a printable `key` with no `keypress` is unusual [likely]. Conversely `keyCode === 0` on a printable `keydown` cannot come from a physical keyboard; CDP callers that omit `windowsVirtualKeyCode` produce it [likely].
- `repeat === true` runs: humans holding a key produce auto-repeat `keydown` bursts at OS rate (~30 Hz after ~500 ms); CDP `autoRepeat` default false — an agent "holding" Backspace sends N distinct presses with dwell ≈ 0 [likely].
- Modifier realism: humans press Shift ≥ 50 ms before the letter and release after; Playwright's `press('Shift+A')` sends modifier down/up around the key with ~0 ms gaps.
- Key event `location`/`isComposing` consistency; `code`/`key` layout consistency with `navigator.language` (CDP uses a US layout table even for non-US users — weak).

### 6.3 Typing cadence vs content

Agents type whole strings with no corrections: `backspace_ratio ≈ 0`, no pauses at word boundaries (humans pause longer before words/after punctuation; Dhakal: hand-alternation bigrams 30–60 ms faster). Agents' per-character IKI is near-constant irrespective of bigram → `iki_bigram_variance ≈ 0`.

### 6.4 Text inserted without keys (`fill`, `insertText`, `form_input`)

- Trusted `beforeinput`/`input` with `inputType === "insertText"` and `data.length > 1` with **no `keydown` within the preceding 50 ms** and `isComposing === false`: produced by Playwright `fill()` (preceded by a trusted `select` event from `input.select()` and a `selectionchange`), Playwright MCP `browser_type` default, Puppeteer `sendCharacter`, Browser Use's `_set_value_directly`.
- Untrusted `input`/`change` (`isTrusted:false`) with no key events: Browser Use clear/framework events, Claude-in-Chrome `form_input` (measured), Playwright `fill` on date/color/range inputs, password managers and many extensions (benign).
- False-positive sources for trusted `insertText`: IME commits (but those arrive with `compositionstart`/`compositionend` and `insertCompositionText`), OS dictation, mobile keyboards' suggestion taps, browser autofill (inputType may be empty), paste (`insertFromPaste`), drop (`insertFromDrop`). Gate: desktop pointerType, no composition in the last 1 s, no `paste` event, document has focus; and treat it as *moderate* evidence only.
- Autocomplete/autofill attribution: Chrome autofill fires `input` events with empty `inputType` [uncertain] — do not flag.

---

## 7. Scroll behaviour

### 7.1 Platform wheel quantisation (what real wheels produce in Chromium)

- **Windows** (`web_input_event_builders_win.cc`): `num_ticks = wheel_delta / WHEEL_DELTA` (120), `scroll_delta = ticks × SPI_GETWHEELSCROLLLINES` (default 3 lines; `WHEEL_PAGESCROLL` → page granularity) × `kScrollbarPixelsPerLine = 100.0f / 3.0f` ("Here we use 100 px per three lines (the default scroll amount is three lines per wheel tick)"); `wheel_ticks_y = num_ticks`. ⇒ `deltaY = 100 × ticks` (or `33.3 × lines × ticks`), `wheelDeltaY = 120 × ticks`; high-resolution wheels give fractional ticks (e.g. 0.25 → deltaY 25, wheelDelta 30). Ratio `|wheelDeltaY/deltaY| = 3.6 / lines` = **1.2** by default.
- **macOS** (`components/input/web_input_event_builders_mac.mm`): continuous devices (trackpad, Magic Mouse) → `kScrollByPrecisePixel`, `delta = kCGScrollWheelEventPointDeltaAxis*` (pixels), `wheel_ticks = delta / ui::kScrollbarPixelsPerCocoaTick` with `kScrollbarPixelsPerCocoaTick = 40.0` ⇒ ratio exactly **3**; momentum phases carry `momentum_phase` → `WheelEvent.is_momentum` (not web-exposed, but deltas decay geometrically). Non-continuous (notched) mice → `delta = [event deltaX/Y] × 40` (accelerated; Chromium comment: "a value of 0.1 is typical for one mousewheel click … up to about 15.0"), `wheel_ticks = CGEvent integer delta axis` (notches) ⇒ `wheelDelta = 120 × notches`, `deltaY = 40 × accelerated value` (often 4 px per slow notch, growing with speed).
- **Linux X11** (`ui/events/x/events_x_utils.cc`): "Scroll amount for each wheelscroll event. 120 is what Chrome uses on Windows, Fuchsia WHEEL_DELTA, and also it roughly matches Firefox on Linux." → `kWheelScrollAmount = 120` px per button-4/5 event (XI2 smooth scrolling scales by the same constant). xdotool `click 5` ⇒ one wheel event of **120 px** (not 53; older Chromium used 53). Ratio ≈ **1**.
- Blink (`wheel_event.cc`): `wheel_delta_ = wheel_ticks × kTickMultiplier` with `constexpr static int kTickMultiplier = 120;` (one constructor divides by `devicePixelRatio`, but our DPR-2 probe still observed ±120, so treat `wheelDelta = 120 × ticks`). `deltaMode` is 0 (pixels) for all Chromium wheel events.

### 7.2 Synthetic wheel signatures

- CDP `mouseWheel` (Playwright `mouse.wheel`, Puppeteer `mouse.wheel`, ghost-cursor, Browser Use element scroll, Playwright MCP `browser_mouse_wheel`, Claude in Chrome): **`wheel_ticks = sign(delta)`** ⇒ `|wheelDeltaY| = 120` for any `deltaY` (measured 300 → −120). Feature: `wheel_ratio = |wheelDeltaY| / |deltaY|` ∉ {platform set} or `|wheelDeltaY| == 120 ∧ |deltaY| ∉ {100, 120, 40·k}` ⇒ synthetic. Also `deltaY` values are "model-ish" (100·k, 250, 300, 500, viewport height) and identical across events; real notched wheels on Windows deliver 100-multiples too (collision), so weight by ratio, not value.
- `Input.synthesizeScrollGesture` (Browser Use page scroll, `speed: 50000`): produces gesture-driven scrolling; the DOM sees `scroll`/`scrollend` and (on desktop) wheel-like events whose per-frame deltas derive from speed/frame-rate; `yDistance` = exactly the CSS viewport height (`"Scrolled down 800px"`) [likely; the exact DOM-level shape needs measurement].
- `DOM.scrollIntoViewIfNeeded` / `scrollIntoView({behavior:'instant'})` / `window.scrollTo`: **instant `scroll` jump with no `wheel`, `keydown`, `touchmove` or pointer activity** within the preceding frame.
- `scrollIntoView({behavior:'smooth'})` (Browser Use `find_text`): ease-out sequence of `scroll` events (~300–500 ms) with no input cause.
- xdotool scroll: N real X wheel events of 120 px, **spaced 100 ms** (cmd_click default) unless `--delay` is given (Anthropic reference: default) → `wheel` Δt ≈ 100 ms exactly; humans' notch intervals vary (30–200 ms, decelerating).

### 7.3 Real-scroll texture to compare against

- Mouse wheel + smooth scrolling (Chrome default): each notch produces one `wheel` event (`deltaY` 100 on Windows) and an animated run of `scroll` events (~150–250 ms, ease-out); with smooth scrolling disabled or `prefers-reduced-motion` the jump is instant — **so "instant jump" alone is not programmatic**; the `wheel` event is the discriminator.
- Trackpad: many small `wheel` events (deltaY 1–60, fractional allowed) per frame, then momentum events with geometrically decaying deltas; `wheelDeltaY = 3 × deltaY` on mac.
- Keyboard: `keydown` (Space/PageDown/ArrowDown/Home/End) precedes the scroll; screen readers may swallow keys (§12.2).
- Touch: `touchstart/touchmove/touchend` + `pointermove` with `pointerType touch`, then fling.
- Scrollbar drag: `pointerdown` on the scrollbar track region (clientX ≥ innerWidth − 17 or so) then `pointermove`s.

### 7.4 Features

`scroll_cause` per `scroll` burst ∈ {wheel, key, touch, scrollbar, momentum, programmatic} (programmatic = no trusted input in the last ~120 ms and not within 1 s after `hashchange`/`popstate`/navigation/focus change); `programmatic_scroll_frac`; `wheel_ratio_ok_frac`; `wheel_delta_entropy` (distinct `deltaY` magnitudes; agents reuse 1–2 values); `wheel_dt_cv` (xdotool ≈ 0); `scroll_reversals` and `deep_scroll` statistics (from arXiv 2605.14786: `max_scroll_pct`, `n_deep_scrolls`, `scroll_reversals`); `scroll_speed_variance`/`scroll_interval_variance` (arXiv 2607.26935; "Agent scroll events: null in all 1,025 normal agent sessions").

---

## 8. LLM "think time", session structure and interaction diversity

### 8.1 Mechanistic sources of agent timing

- Browser Use: `wait_between_actions 0.1 s` + `minimum_wait_page_load_time 0.25 s` + `wait_for_network_idle_page_load_time 0.5 s` + model latency per step; inside a step, actions are fixed-delay bursts (50/80 ms clicks, 1–10 ms per key, 0.15 s between scroll pages).
- Anthropic reference loop: every action followed by `_screenshot_delay = 2.0` s, then model inference (seconds) → inter-action gaps ≳ 3 s with low dispersion; the 2026 toolset allows batching several actions per turn → bursts separated by long gaps (the "pause-think-act" cycle).
- Claude in Chrome: our batch of actions ran with ~1 s waits inserted by the operator; without them, consecutive actions were 1–3 ms apart (e.g. drag end → ref-click scroll 2.3 ms, scroll → move 55.7 ms, move → click 9 ms).
- Kang et al. 2026: "Claude, which has the lowest CV, consistently performs tasks across trials, whereas AutoGen exhibits high [variance]"; "The consistent intervals indicate that the agent regulates the pacing according to its strategy."; plan-first agents (Claude, Gemini, Skyvern) "skipped Scenario 5, a delayed feedback of button click" in all 30 trials because they "enumerate the URL list before beginning execution" (they do not wait for UI feedback at all).

### 8.2 What the 2026 detection literature found

- **"Known By Their Actions: Fingerprinting LLM Browser Agents via UI Traces" (arXiv 2605.14786)** — 14 models (Qwen3-VL, Qwen3.5, GLM-4.6V, UI-TARS-1.5-7B, Gemma-4, GPT-5.4, Gemini-3.1/3-Flash, Claude Opus 4.6, Seed-2.0-Lite) via Midscene.js PlaywrightAgent, headless Chromium 1280×768, 1,050 episodes; a `page_tracer.js` init script records click (coordinates, target type), keydown (inter-keystroke timing), scroll (direction, magnitude), navigate, beforeunload, focus at ms resolution. 41 features (`mean_iei_ms`, `std_iei_ms`, `median_iei_ms`, `p10/p90_iei_ms`, `t_first_action_ms`, `iei_trend`, `total_duration_s`, `mean_click_iei_ms`, `std_click_iei_ms`, `mean_nav_iei_ms`, `max_page_dwell_ms`, `mean_key_iei_ms`, `std_key_iei_ms`, `n_clicks`, `n_scrolls`, `n_navigations`, `n_keydowns`, `page_count`, `actions_per_page`, `nav_to_click_ratio`, `popstate_ratio`, `max_scroll_pct`, `mean_scroll_pct`, `n_deep_scrolls`, `scroll_reversals`, `click_x_std`, `click_y_std`, `click_bbox_area_frac`, `click_top_frac`, `link_click_ratio`, `structural_key_ratio`, `mean_exit_scroll_pct`). Closed-set macro-F1 72.6–79.4 (XGBoost) for *which model*; SHAP dominated by `std_iei_ms`, `mean_click_iei_ms`, `t_first_action_ms`; injecting random delays makes F1 "drop sharply" until retrained, after which weight shifts to residual timing variability, click-coordinate dispersion, `structural_key_ratio`, `link_click_ratio`; signal "typically recoverable from fewer than 15 observed events". No human baseline (assumes bot detection already happened). Mouse movement not recorded.
- **"What Does It Take to Detect an AI Agent? Minimal Feature Sets" (arXiv 2607.26935)** — Claude driving Chrome via Playwright + MCP, 1,025 agent sessions over 10 tasks, humans from CaptchaSolve30k (3,000 rows), synthetic bots (2,000). 17 continuous features: `trajectory_entropy`, `movement_efficiency`, `mouse_teleportation`, `cursor_path_linearity`, `click_duration_mean`, `click_duration_std`, `mouse_event_rate`, `inter_event_entropy`, `inter_action_gap_variance`, `inter_action_gap_bimodality`, `action_burst_ratio`, `time_to_first_action`, `typing_speed_mean`, `typing_speed_std`, `teleport_click_ratio` ("fraction of clicks preceded within 100 ms by a raw-event mousemove jump of more than 100 px and under 50 ms"), `scroll_speed_variance`, `scroll_interval_variance`; 7 binary flags (`no_mouse_events`, `no_scroll_events`, `no_keyboard_events`, `zero_dimensions`, `webdriver_flag`, `has_untrusted_events`, `no_micro_jitter`) excluded as "trivially spoofable". Results: agent F1 1.000 in all 30 runs; **minimal pair {`mouse_event_rate`, `click_duration_std`} gives macro-F1 0.904 with agent precision/recall 1.000**, exhaustive best pair {`mouse_event_rate`, `teleport_click_ratio`} 0.926; existing human-vs-bot detectors let agents through at 30–39 % (RF/SAINT/MLP) but XGBoost 0 %; the hypothesised think-time features (gap variance, bimodality, burst ratio) did **not** survive backward elimination — "a browser-automation artifact, not evidence of agent reasoning". Human click duration prior used by their generator: N(110, 30) ms. Caveat stated by authors: OS-level input simulation or hardware emulators would likely evade.
- **"Whose Agent Are You? Multi-Layer Fingerprinting and Attribution of Autonomous Web Agents" (Kang, Jeong, Sheffey, Datta, Houmansadr; arXiv 2606.20910)** — instrumented site with five scenarios (S1 subscribe button variants, S2 scrollable panel with a button at the bottom, S3 hover-dependent button, S4 semantic mismatch, S5 delayed feedback 1,500–3,000 ms), six agents (AutoGen, Browser Use, Skyvern with GPT-5-mini; Operator; Claude `computer-use-2025-11-24`; Gemini `gemini-2.5-computer-use-preview-10-2025`), 30 trials each, 30 human participants, three legacy crawlers; logger throttles mousemove at 16 ms, `performance.now()` timestamps, `sendBeacon` flush. Findings: Browser Use never moves the mouse; Skyvern has the longest trajectories and most mousemove; "Agents generally use keyboard controls rather than mouse movements, except for Skyvern"; Operator is the only agent with keydowns on S2–S4; AutoGen "passive"; request-timing CV separates Claude (lowest) from AutoGen; headers: `HeadlessChrome` in Sec-Ch-Ua for AutoGen 99 %, Claude 100 %, Gemini 100 %; `Sec-Fetch-Site always none` 92–100 % (Skyvern 19 %); Browser Use 100 % Sec-Fetch logic violations, Operator 41 %; Operator 39 % Firefox TLS; Skyvern 17 TLS extensions; non-standard headers `signature`/`signature-agent` (Operator), `sec-gpc` (Skyvern); decision-tree identification of agents/humans/crawlers **97 %**; "Behavioral telemetry can distinguish agents when network fingerprints are similar."
- Iliou et al. 2021 ("Detection of Advanced Web Bots by Combining Web Logs with Mouse Behavioural Biometrics", DTRAP) is the standard citation for combining log + mouse features; not fetched (ACM 403) [uncertain details].

### 8.3 Proposed session-level features

- `iei_*` (inter-action intervals between discrete actions = click/keyburst/scrollburst/navigation): `min_iei`, `p10_iei`, `frac_iei_lt_500ms` (humans high during form-filling/double-clicks; agents only inside batched bursts), `iei_cv`, `iei_lag1_autocorr` (periodicity), `iei_bimodality` (burst + long gaps), `t_first_action` after `load` (agents: fixed page-load waits + inference).
- `think_gap_movement_frac`: share of gaps > 2 s containing ≥ 1 `pointermove` (humans fidget/read-with-cursor at a substantial rate; agents 0; keyboard-only humans also 0 → use only as supporting evidence).
- `event_type_entropy` (Shannon entropy over event-type histogram incl. `mouseover` on non-targets, `selectionchange`, `contextmenu`, `dblclick`, `resize`, `blur`, `visibilitychange`, `pointerleave` on `documentElement`); `incidental_event_ratio` (events not attributable to the action sequence); `viewport_exit_count` (pointer leaving the document: `mouseout` with `relatedTarget === null` / `pointerleave` on `html` — CDP agents never leave; humans do constantly to reach the tab bar/URL bar); `hover_targets_count` (distinct elements hovered without clicking).
- `action_vocabulary`: set of distinct trusted input primitives used (agents: {click, type, wheel} ± scrollIntoView; humans add text selection, right-click, drag-select, Ctrl+F, Tab focus, back/forward).
- Keep `structural_key_ratio`, `link_click_ratio`, `click_x_std/click_y_std` (agents' click dispersion is "wherever the targets are", humans similar — weak; but `click_bbox_area_frac` in the literature).

Thresholds (proposal): `min_iei > 1.0 s` across ≥ 6 actions **and** `frac_iei_lt_500ms == 0` ⇒ moderate; `iei_cv < 0.35` over ≥ 8 actions ⇒ moderate; `think_gap_movement_frac == 0` with ≥ 5 long gaps and ≥ 1 click (i.e. not keyboard-only) ⇒ weak-moderate; `viewport_exit_count == 0` over a session > 2 min with pointer use ⇒ weak.

---

## 9. Idle micro-movements, hover dwell, interaction diversity, visibility/focus

- Humans produce "idle" `pointermove`s (tremor, repositioning, reading with the cursor) and hover/verification dwell before clicking; CDP agents produce none (measured: zero pointermoves outside the single pre-click step). The arXiv 2607.26935 flag `no_micro_jitter` is listed as trivially spoofable — treat as supporting evidence only.
- Hover dwell (`pointerover` on target → `pointerdown`): humans ≥ 100 ms (Fitts' verification phase); Playwright ≈ 2 ms, Browser Use 50 ms (fixed), xdotool ≈ 0, Claude-ext 2–9 ms.
- Focus/visibility: Playwright forces `document.hasFocus() === true` (`Emulation.setFocusEmulationEnabled`), `visibilityState` stays `visible`; long human sessions almost always contain at least one `blur`/`visibilitychange` pair (tab switch) — agents in headless contexts never do, but the Claude extension does (measured) because it switches tabs. Weak signal; useful as "no blur in 20 min of activity".
- Pointer never leaves the viewport: CDP coordinates are clamped to the viewport (Browser Use `viewport_width - 1`); humans leave to use browser chrome. `mouseleave` on `document.documentElement` with `relatedTarget === null` count = 0 over a long active session ⇒ weak-moderate.
- Selection: humans accidentally select text (`selectstart`/`selectionchange` with non-collapsed ranges) during drags; agents only when triple-clicking to clear fields (Browser Use strategy 2: `clickCount: 3` + Delete — a distinctive "triple-click then Delete then type" pattern).

---

## 10. DOM-harvesting bursts and attribution via stack traces

### 10.1 Who harvests the DOM from the main world (visible to page instrumentation)

- Puppeteer `page.evaluate`/`$$eval` users (LangChain/LangGraph browser tools, Crawl4AI's JS hooks, Firecrawl's actions, custom scrapers): every evaluated script carries `//# sourceURL=pptr:<name>;<site>` (fallback `pptr:internal`), so any DOM API they call has `pptr:` in `Error().stack` (rebrowser-bot-detector test `sourceUrlLeak` checks `includes('pptr:')`).
- Playwright `page.evaluate` (Browser Use ≤ 0.1.x `buildDomTree.js`, old Stagehand DOM scripts, Skyvern `frame.evaluate` path when no prefix is set runs in the isolated world — *not* visible): main-world evaluation shows `UtilityScript.evaluate` / `eval at evaluate` frames (rebrowser checks `includes('UtilityScript.')`). Playwright's locator/aria-snapshot engine runs in `__playwright_utility_world_<guid>` and is invisible.
- Browser Use 2026 (CDP `Runtime.evaluate` without sourceURL): `document.querySelectorAll('*')` + `getEventListeners()` probe on every page state (unless > 10,000 elements), `document.elementFromPoint(cx, cy)` immediately before each click, `document.querySelectorAll('iframe')` scroll probe, `document.readyState`. Stack frames: `at <anonymous>:L:C` (no URL, not nested in any page script).
- Skyvern `evaluate_in_main_world` (CDP `Runtime.evaluate`, prefixed scripts) + `domUtils.js`: `buildTreeFromBody` walks everything calling `getBoundingClientRect`, `getComputedStyle`, `checkVisibility()`, `getClientRects`, `elementFromPoint(s)`, `innerText`, and **writes `unique_id` attributes** on interactable elements (a `MutationObserver` with `attributes: true, attributeFilter: ['unique_id','data-skyvern-otp-box']` catches it with zero cost) and defines `window.elementIdCounter`, `window.GlobalSkyvernFrameIndex`, `window.globalObserverForDOMIncrement`.
- Claude in Chrome: `read_page`/`find` are invisible (no main-world calls); `javascript_tool` is main-world `<anonymous>`.
- ChromeDriver/Selenium `execute_script`: main world, stack shows `at eval (eval at executeScript` … [likely; not re-verified].

### 10.2 Instrumentation design (feasible, cheap)

1. Early (first script in `<head>`), wrap: `Element.prototype.getBoundingClientRect`, `getClientRects`, `checkVisibility`, `scrollIntoView`; `Window.getComputedStyle`; `Document.prototype.elementFromPoint/elementsFromPoint/querySelectorAll/getElementsByTagName`; `HTMLElement.prototype.innerText` getter; `Node.prototype.textContent` getter; `HTMLElement.prototype.click`; `EventTarget.prototype.dispatchEvent`. Keep natives' `toString` (define `toString` to return the native string) — rebrowser's `nativeTampering` test shows how detectors (and agents) look for wrapped natives.
2. Count calls per 50 ms window; a **burst** = > 200 geometry/style calls in 50 ms not attributable to the page's own frameworks (allow-list by stack origin of the site's bundles).
3. Sample `new Error().stack` on every 32nd call inside a burst (cost ≈ 10–50 µs each) or use `Error.prepareStackTrace` CallSites (`getScriptNameOrSourceURL()`, `getEvalOrigin()`, `isEval()`), classify: `pptr:` → Puppeteer; `UtilityScript.` → Playwright main-world evaluate; frames with no script URL and no page-script ancestor → foreign CDP/extension evaluation; `chrome-extension://<id>/` → extension content script injected into main world (rare; isolated-world scripts don't show).
4. `MutationObserver` on `document` for attributes `unique_id`, `data-skyvern-*`, nodes with id `playwright-highlight-container`, class `playwright-highlight-label`, Skyvern cursor overlay nodes [name unverified], any fixed `z-index: 2147483647` overlays appended within 100 ms of a harvest burst.
5. Record `window` property additions (`Object.keys(window)` diff on a timer or `Proxy` is too costly) — rebrowser checks `__pwInitScripts`, `__playwright__binding__`, `puppeteer_*`, functions with `__installed === true`, bare native-looking functions added by `Runtime.addBinding`.

Caveats: main-world instrumentation is defeatable (agents can snapshot natives before the page runs — Playwright's `noUtilityWorld` option injects a `mainWorldGlobalsSnapshotSource` of built-ins; Browser Use masks `AutomationControlled`), and Playwright-based agents that only use locators are invisible. Treat harvest-burst signals as attribution/forensics, not as the primary classifier.

---

## 11. Touch vs mouse; accessibility-tree navigation patterns

- Real touch: `pointerType "touch"`, `touchstart` radii ~10–30 CSS px (Android/iOS report contact area), `pointerdown.width/height` > 1, `pressure` device-dependent (often 1 or variable), tap duration 50–150 ms, `pointermove` jitter even during a "tap". CDP touch: Playwright `tap` = `touchStart` and `touchEnd` dispatched in parallel (≈ 0 ms), radius 1.0, force 1.0, `width/height` 2; Puppeteer radius 0.5/force 0.5. `Emulation.setTouchEmulationEnabled` on a desktop profile → `maxTouchPoints` set while the UA/platform says desktop (rebrowser `mobileEmulation` flags `maxTouchPoints === 1`/`0` with mobile UA).
- Mobile OS automation (`adb shell input tap`, iOS XCUITest) produces trusted taps with fixed pressure/size and zero duration [uncertain values].
- Accessibility-tree navigation: Playwright MCP (`ariaSnapshot`), Browser Use (`Accessibility.getFullAXTree` + `DOMSnapshot`), Claude in Chrome (`read_page`) read structure without touching main-world APIs; the *actions* that follow are ref/center clicks. Humans using screen readers also navigate by the accessibility tree — the difference is the dispatch shape (§12.1–12.2): AT clicks have no pointermove and `sourceCapabilities === null`; agent clicks have one teleport move and non-null capabilities.
- Pattern: agents interact only with elements present in the AX tree (buttons/links/inputs with roles); humans click on arbitrary targets (text, images, whitespace, container backgrounds). `non_interactive_target_ratio` (clicks whose target has no interactive role/handler) ≈ 0 for agents, > 0 for humans (misclicks) — weak but cheap.

---

## 12. False positives: assistive technology, unusual hardware, remote sessions

### 12.1 Chrome's accessibility-initiated click (screen readers, switch access, voice "click <name>")

`ax_object.cc`: "`AccessKeyAction()` has special handling that needs to be available to assistive tools." → `element->AccessKeyAction(SimulatedClickCreationScope::kFromAccessibility)`; `event_dispatcher.cc DispatchSimulatedClick` for `kFromAccessibility` dispatches `pointerdown`, `mousedown`, `pointerup`, `mouseup`, then `click`; `simulated_event_util.cc` sets coordinates to the element center ("If we have an element we will set coordinates to the center of the element."), `screenX/Y` via `FrameToScreen`, `button = kLeft`, `buttons = kLeftButtonDown` for down/click, `detail = 1` on click only, `pointerId = kMouseId (1)`, `pointerType "mouse"`, `isPrimary true`, `SetTrusted(true)`, timestamp `TimeTicks::Now()`; no hover events ("TODO(crbug.com/1171924)…"). **This is nearly identical to a Puppeteer click** (center, pressure 0, instant down/up) except: no `pointermove`, `mousedown.detail == 0`, `sourceCapabilities == null`, `movementX == 0`. The SDK must classify `{no pointermove ∧ sourceCapabilities === null ∧ pointerId === 1 ∧ trusted}` as **AT click → exempt from click-timing/center/pressure scoring**.

### 12.2 Keyboard-only users and screen-reader browse mode

Enter/Space on a focused control → `kFromUserAgent` simulated `click` only: `pointerId -1`, `pointerType ""`, `detail 0`, `clientX/Y 0`, `isTrusted` = underlying key event trusted; preceded by `keydown`/`keyup` and focus navigation (`focusin` chains via Tab). NVDA (user guide): "Activate current navigator object" "Activates the navigator object, similar to clicking with the mouse or pressing space when it has system focus"; "Move mouse to current navigator object" "Moves the mouse to the location of the current navigator object" (a pointer warp exactly like xdotool, followed by "Left mouse button click"); browse-mode arrow keys are consumed by the screen reader (the page sees no `keydown`) while the virtual cursor scrolls content into view → **programmatic-looking scrolls with no input events**. Mitigation: treat sessions with `pointerId -1` clicks, Tab-driven focus chains, or AT-style simulated clicks as "keyboard/AT profile" and disable pointer-based scoring; never score "scroll without input" when the session has zero pointer events.

### 12.3 Voice control and grid clicking

macOS Voice Control (Apple support): "Show numbers"/"Show names" label items; "Show grid" / "Show window grid" overlays a numbered grid; "To click a location, say a command such as "Click" followed by the grid number"; refining shows "a more detailed grid in that area"; "When a cell can't be subdivided further, saying a number performs the Click command"; "Drag … to …". Windows Voice Access has equivalent number/grid overlays [likely; page text not captured]. Effect: OS-level pointer warp to a label/cell center + immediate click → identical to computer-use agents' lattice/center clicks with no trajectory. Mitigation: grid clicks come in slow cadence (speech latency ≥ 1 s), no keyboard bursts, and the OS click has normal `sourceCapabilities`; without trajectory data these users will look like agents on spatial features — keep spatial signals as *supporting*, require timing + harvest/dispatch evidence before blocking, and offer a non-blocking challenge path.

### 12.4 Dwell/switch/eye-gaze/head pointers

Dwell clickers (Windows Eye Control, macOS Dwell Control, Tobii, Dwell Clicker software) and switch-scanning tools emit an OS click after the pointer rests; the synthetic click is typically down+up with ~0 ms between them [uncertain per tool] — so `click_dur < 20 ms` **does occur for assistive users**. Their movement, however, is rich: eye trackers produce saccadic jumps + fixation jitter at 30–120 Hz; head pointers produce smooth low-frequency motion. Rule: a sub-20 ms click only counts if the preceding 2 s contain ≤ 1 pointermove (teleport); with a jittery fixation trace it is AT.

### 12.5 Trackpads, touchscreens, high-DPI, zoom, reduced motion

- Trackpad tap-to-click produces short press durations (OS-synthesised) [uncertain magnitude]; precise wheel deltas are fractional with momentum; `wheelDeltaY = 3 × deltaY` on mac.
- Touch laptops: `pointerType "touch"` mixed with mouse in one session.
- DPR 1.25/1.5/2 and browser zoom: `clientX` fractions are multiples of `1/DPR` on pointer events (not on `click`); `movementX` truncated to int; coordinates rescale after Ctrl+±. Lattice/fraction tests must use `devicePixelRatio` at event time and tolerate ±0.5 device px.
- `prefers-reduced-motion` / smooth scrolling disabled: wheel notches produce instant 100 px jumps (one `scroll` per `wheel`) — identical to CDP instant scrolls except that a `wheel` event precedes them; `scrollIntoView` smooth → instant; never use "jump without animation" as a bot signal.
- High-refresh displays: at 120–240 Hz a 125 Hz mouse yields `getCoalescedEvents().length` of 1 most frames; use `pointerrawupdate` rate or Δt regularity instead of coalesced count alone. Gaming mice (1000 Hz) give coalesced ≈ 8–16 per frame — large values are human-only evidence.
- Firefox: pointer events integer-only (Playwright searches integer points), `Event.timeStamp` 1 ms, no `pointerrawupdate` [uncertain]; Safari: no `getCoalescedEvents` (spec optional), coarser timers — feature availability must be per-engine, with missing features treated as "unknown", not "bot".

### 12.6 Remote desktop (RDP/Citrix/VNC/Chrome Remote Desktop)

Balabit data (captured from RDP sessions) shows Move→Move intervals of ~109–124 ms with multiple samples per timestamp and ~15.6 ms clock quantisation, i.e. **human motion arrives in bursts**; velocity/acceleration computed from timestamps becomes spiky and "impossible" (several px jumps with Δt = 0). VNC servers inject the remote human's input through XTest — the same path xdotool uses — so the browser sees trusted, platform-built events with realistic trajectories but network-jittered timing. Mitigation: compute kinematics on positions ordered by sequence with Δt floors (≥ 1 ms), use burstiness features (`frac_dt_eq_0`, `dt_cv`) only against the *agent* patterns (perfect regularity), and treat "many samples with identical timestamps" as remote-desktop evidence, not bot evidence.

### 12.7 Hardware emulators and OS-level humanizers

Agents that drive a real OS cursor (xdotool, PyAutoGUI, Windows `SendInput`, macOS `CGEvent`) get platform-correct `pressure`, wheel ticks, timestamps and `sourceCapabilities`; only trajectory (instant warps, straight constant-speed tweens), click duration (≈ 0), key timing (fixed 12 ms) and session structure remain. arXiv 2607.26935 explicitly notes such agents "would likely evade" their detector. Expect the next generation to add human-like paths (ghost-cursor on top of CDP, DMTG-style generators); §5.2/§5.4 features and §8 timing then carry the load.

### 12.8 Policy recommendations for the SDK

1. Compute an **AT/keyboard profile flag** first (pointerId −1 clicks, `sourceCapabilities === null` trusted clicks, Tab-chain focus, zero pointermove with clicks, screen-reader scroll pattern) and down-weight all pointer-kinematic and spatial features when set.
2. Require **two independent families** (dispatch-level property tells, micro-timing, trajectory/spatial, session timing, harvest/attribution) before any blocking action; single-family evidence → label/log/degrade only.
3. Prefer *impossibility* tells (wheel ratio, sub-device-pixel coordinates, `pressure 0` with buttons on a non-AT click sequence, keystroke dwell < 30 ms with full `keypress` sequences, `insertText` after a trusted `select` event) over *statistical* tells for high-confidence actions.
4. Ship a replayable event log (all fields in §3) so review/replay can re-score with new rules and so AT false positives can be audited.

---

## 13. Consolidated feature table with suggested thresholds

| Family | Feature | Human reference | Agent/automation | Score rule (proposal) | Conf. |
|---|---|---|---|---|---|
| Dispatch | `pointerdown.pressure == 0 && buttons == 1 && pointerType == 'mouse'` | 0.5 (Win/mac/Linux mouse) | Puppeteer, ChromeDriver, Browser Use, ghost-cursor: 0; Playwright, Claude-ext: 0.5 | strong unless AT-click shape | confirmed |
| Dispatch | `abs(wheelDeltaY) == 120 && abs(deltaY) ∉ platform set` or `ratio ∉ {1.2 (Win,3 lines), 3 (mac precise), 1 (X11)}` | platform ratio | CDP `mouseWheel` always ±120 | strong (per event) | confirmed |
| Dispatch | trusted `input` `inputType:'insertText'` with `data.length > 1`, no `keydown` ≤ 50 ms, no composition, desktop | paste/IME/dictation only | Playwright `fill`, MCP `browser_type`, Puppeteer `sendCharacter` | moderate; strong if preceded by trusted `select` event within 20 ms | confirmed |
| Dispatch | untrusted `input`/`change`/`blur` within 100 ms after trusted key events | rare (frameworks re-dispatch sometimes) | Browser Use, Claude-ext `form_input` | moderate | confirmed |
| Dispatch | `mousedown.detail == 0` with trusted `click.detail == 1`, no pointermove, `sourceCapabilities == null` | AT click | AT click | **exempt** (AT) | confirmed |
| Dispatch | `click` with `pointerId == -1`, coords (0,0) | keyboard activation | keyboard activation / Playwright `press('Enter')` | neutral; mark keyboard profile | confirmed |
| Timing | `click_dur < 20 ms` (n ≥ 2) | p5 ≈ 60 ms | 0–3 ms (most), 80 ms (Browser Use) | strong (AT-gated) | confirmed |
| Timing | `click_dur_std < 5 ms` (n ≥ 5) | tens of ms | ≈ 0–3 ms | strong | confirmed/literature |
| Timing | `pre_click_move_gap < 10 ms` ∧ `moves_before_click ≤ 1` | ≥ 100 ms, many moves | ≈ 2 ms, 1 move | strong (AT-gated) | confirmed |
| Timing | `key_dwell < 30 ms` (n ≥ 3) or `iki < 40 ms` (n ≥ 3) | dwell p1 38 ms; IKI ≥ 60 ms | ≤ 12 ms | strong | confirmed |
| Timing | `iki_cv < 0.1` (n ≥ 10) | ≥ 0.4 | fixed timers | strong | literature (Chu) |
| Timing | `dblclick_gap < 15 ms` | 50–300 ms | 0.7–10 ms | strong | confirmed |
| Timing | `wheel_dt` ≈ constant 100 ms (n ≥ 3) | variable | xdotool default | moderate | confirmed (source) |
| Spatial | `exact_center_frac ≥ 0.6` (n ≥ 5) | ≈ 0.001–0.02 | CDP stacks ≈ 1 | strong (AT/voice-gated) | confirmed |
| Spatial | lattice fit `≥ 0.95` for some s > 1.1 (n ≥ 8) | ≈ 1/s | computer-use agents ≈ 1 | moderate-strong (voice-grid caveat) | confirmed (mechanism) |
| Spatial | `frac(clientX × DPR) ≠ 0` on `pointerdown` (mouse) | 0 | CDP fractional centers | moderate (verify per OS) | likely |
| Spatial | landing uniform over box (KS p > 0.2 vs uniform, n ≥ 15) | Normal, σ ≈ W/4.133 | Skyvern, ghost-cursor | moderate | confirmed (source)/literature |
| Trajectory | `moves_per_click`, `dt_mode < 5 ms`, `coalesced_mean == 1 ∧ dt ≈ RTT` | ≥ 20 moves; dt ≈ 8–16 ms; coalesced ≥ 1 | 0–1 (CDP); ≥ 25 at RTT spacing (ghost-cursor) | strong | confirmed |
| Trajectory | `frac_zero_accel > 0.8`, `efficiency > 0.94` for > 50 % of segments, single-peak smooth velocity, no tremor | lognormal efficiency, multi-stroke | linear/Bézier generators | moderate (ML model) | literature |
| Trajectory | `timestamp_skew` negative or drifting | 0–20 ms | forged CDP timestamps | strong | confirmed (mechanism) |
| Scroll | `programmatic_scroll_frac > 0.5` (n ≥ 3) in a session with pointer use | ≈ 0 (except hash/focus) | scrollIntoView-driven agents | moderate (AT-gated) | confirmed |
| Session | `min_iei > 1 s ∧ frac_iei_lt_500ms == 0` (n ≥ 6); `iei_cv < 0.35` | sub-second bursts common | inference-bound loops | moderate | literature |
| Session | `think_gap_movement_frac == 0` (≥ 5 gaps, pointer session) | > 0 | 0 | weak-moderate | likely |
| Session | `viewport_exit_count == 0` over > 2 min pointer session; `event_type_entropy` low | exits common | CDP-clamped | weak | likely |
| Harvest | burst of > 200 geometry/style calls in 50 ms from `pptr:`/`UtilityScript.`/URL-less frames; `unique_id` attribute mutations; `getEventListeners` probes | 0 | Puppeteer/Playwright-evaluate/Browser Use/Skyvern | strong attribution | confirmed |

---

## 14. Evaluation plan and datasets

- Human mouse: Balabit (GitHub `balabit/Mouse-Dynamics-Challenge`, 10 users, RDP), SapiMouse (120 users), DFL (21), BeCAPTCHA-Mouse testbed (GitHub BiDAlab), ReMouse (IEEE DataPort 10.21227/jkmt-za31; repeat sessions for replay-bot defence), DELBOT-Mouse (labelled human/bot, used by Bureau), CaptchaSolve30k (used in arXiv 2607.26935). Keystrokes: CMU DSL-StrongPasswordData (51 users), Dhakal 136M (168k users). Synthetic negatives: ghost-cursor, python_ghost_cursor, Bézier/linear/constant-speed, GAN/SapiAgent, DMTG where available; CDP interpolation (`steps = N`); xdotool/PyAutoGUI traces recorded in a VM.
- Agent traces: record each framework against a fixed task suite (Browser Use, Playwright MCP with Claude/GPT, Puppeteer-based LangChain tools, Skyvern, Anthropic computer-use demo in Docker, PyAutoGUI loop, Claude in Chrome, Comet/Atlas/Gemini-in-Chrome when available) using the §2.12 probe page extended with every field in §3.
- AT matrix (must be in CI): NVDA/JAWS/VoiceOver activation clicks; keyboard-only; macOS Voice Control numbers+grid; Windows Voice Access; dwell clicker; eye tracker (if available); trackpad vs mouse vs touchscreen; RDP and VNC sessions; DPR 1/1.25/1.5/2 with zoom 80–150 %; reduced-motion; 60/120/144 Hz displays; Firefox/Safari.
- Metrics: per-feature ROC on human-vs-agent, false-positive rate on each AT condition (target < 0.1 % per condition for blocking actions), time-to-detect in events (literature: < 15 events), robustness to timing jitter injection and ghost-cursor-style paths.

---

## 15. Unknowns / not verified

- Exact DOM-level shape of `Input.synthesizeScrollGesture` scrolls (wheel events? ticks?) — needs measurement.
- `persistentDeviceId` values for real mice/trackpads across OSes (measured 1 for the extension's synthetic mouse).
- Whether Windows/Linux mouse events ever carry fractional device coordinates (sub-pixel test), and macOS trackpad pointer precision.
- Stagehand v4's browser-side input path (hosted/extension; source not public in the SDK package).
- Claude for Chrome internals beyond the measured behaviour (CDP via `chrome.debugger` is assumed, and the exact downscale rule for other viewport sizes); Gemini in Chrome, Perplexity Comet, OpenAI Atlas, Edge Copilot mode, Manus, Nova Act, Project Mariner — not measured.
- Dwell-clicker/switch-software click durations and tap-to-click press durations.
- Windows Voice Access grid behaviour (page text not retrieved).
- WebDriver "in-view center point" exact floor() wording (section not captured; behaviour confirmed via ChromeDriver source).
- Iliou et al. 2021 details (ACM paywall).
- Playwright's historical commit rationale for `force: 0.5` (not fetched; behaviour confirmed in code).
- Chrome autofill `inputType` values.
- Web search quota was exhausted mid-task; later items were resolved by direct fetches of known URLs only.

---

## 16. Sources

Framework / agent source code (GitHub raw, fetched 2026-10-24):
- Playwright: https://raw.githubusercontent.com/microsoft/playwright/main/packages/playwright-core/src/server/chromium/crInput.ts ; https://raw.githubusercontent.com/microsoft/playwright/main/packages/playwright-core/src/server/input.ts ; https://raw.githubusercontent.com/microsoft/playwright/main/packages/playwright-core/src/server/dom.ts ; https://raw.githubusercontent.com/microsoft/playwright/main/packages/playwright-core/src/server/chromium/crPage.ts ; https://raw.githubusercontent.com/microsoft/playwright/main/packages/playwright-core/src/server/javascript.ts ; https://raw.githubusercontent.com/microsoft/playwright/main/packages/injected/src/injectedScript.ts ; https://raw.githubusercontent.com/microsoft/playwright/main/packages/injected/src/utilityScript.ts ; docs https://playwright.dev/docs/actionability ; https://playwright.dev/docs/input ; https://playwright.dev/docs/api/class-keyboard
- Playwright MCP: https://raw.githubusercontent.com/microsoft/playwright-mcp/main/README.md ; https://raw.githubusercontent.com/microsoft/playwright-mcp/main/src/README.md
- Puppeteer: https://raw.githubusercontent.com/puppeteer/puppeteer/main/packages/puppeteer-core/src/cdp/Input.ts ; https://raw.githubusercontent.com/puppeteer/puppeteer/main/packages/puppeteer-core/src/api/ElementHandle.ts ; https://raw.githubusercontent.com/puppeteer/puppeteer/main/packages/puppeteer-core/src/cdp/ExecutionContext.ts ; https://raw.githubusercontent.com/puppeteer/puppeteer/main/packages/puppeteer-core/src/common/util.ts
- ghost-cursor: https://raw.githubusercontent.com/Xetera/ghost-cursor/master/src/spoof.ts ; https://www.npmjs.com/package/ghost-cursor
- Browser Use: https://raw.githubusercontent.com/browser-use/browser-use/main/browser_use/browser/watchdogs/default_action_watchdog.py ; https://raw.githubusercontent.com/browser-use/browser-use/main/browser_use/browser/profile.py ; https://raw.githubusercontent.com/browser-use/browser-use/main/browser_use/dom/service.py ; https://raw.githubusercontent.com/browser-use/browser-use/main/browser_use/tools/service.py ; https://raw.githubusercontent.com/browser-use/browser-use/0.1.40/browser_use/dom/buildDomTree.js
- Skyvern: https://raw.githubusercontent.com/Skyvern-AI/skyvern/main/skyvern/webeye/utils/dom.py ; https://raw.githubusercontent.com/Skyvern-AI/skyvern/main/skyvern/constants.py ; https://raw.githubusercontent.com/Skyvern-AI/skyvern/main/skyvern/webeye/scraper/domUtils.js ; https://raw.githubusercontent.com/Skyvern-AI/skyvern/main/skyvern/webeye/scraper/scraper.py ; https://raw.githubusercontent.com/Skyvern-AI/skyvern/main/skyvern/webeye/main_world_eval.py ; https://raw.githubusercontent.com/Skyvern-AI/skyvern/main/skyvern/webeye/cursor_visualization.py ; https://raw.githubusercontent.com/Skyvern-AI/skyvern/main/skyvern/webeye/utils/page.py ; https://raw.githubusercontent.com/Skyvern-AI/skyvern/main/skyvern/webeye/actions/handler.py ; https://raw.githubusercontent.com/Skyvern-AI/skyvern/main/skyvern/webeye/actions/handler_utils.py
- Stagehand: https://raw.githubusercontent.com/browserbase/stagehand/main/README.md ; https://raw.githubusercontent.com/browserbase/stagehand/main/packages/sdk-ts/package.json
- Anthropic computer use: https://raw.githubusercontent.com/anthropics/anthropic-quickstarts/main/computer-use-demo/computer_use_demo/tools/computer.py ; https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool
- OpenAI computer use: https://developers.openai.com/api/docs/guides/tools-computer-use ; https://raw.githubusercontent.com/openai/openai-cua-sample-app/main/python-app/app/browser.py ; https://raw.githubusercontent.com/openai/openai-cua-sample-app/main/python-app/app/responses_loop.py ; https://raw.githubusercontent.com/openai/openai-cua-sample-app/main/python-app/app/desktop/worker.py
- PyAutoGUI docs: https://pyautogui.readthedocs.io/en/latest/quickstart.html ; https://pyautogui.readthedocs.io/en/latest/mouse.html
- xdotool: https://raw.githubusercontent.com/jordansissel/xdotool/master/xdo.c ; https://raw.githubusercontent.com/jordansissel/xdotool/master/cmd_click.c ; https://man.archlinux.org/man/extra/xdotool/xdotool.1.en
- rebrowser-bot-detector: https://raw.githubusercontent.com/rebrowser/rebrowser-bot-detector/main/index.js

Chromium / Blink / ChromeDriver sources (https://chromium.googlesource.com/chromium/src/+/main/…):
- content/browser/devtools/protocol/input_handler.cc ; third_party/blink/renderer/core/events/pointer_event_factory.cc ; third_party/blink/public/common/input/web_pointer_properties.h ; third_party/blink/renderer/core/events/wheel_event.cc and wheel_event.h ; third_party/blink/renderer/core/events/mouse_event.cc ; third_party/blink/renderer/core/events/simulated_event_util.cc ; third_party/blink/renderer/core/dom/events/event_dispatcher.cc ; third_party/blink/renderer/core/dom/events/simulated_click_options.h ; third_party/blink/renderer/core/html/html_element.cc ; third_party/blink/renderer/modules/accessibility/ax_object.cc ; ui/events/x/events_x_utils.cc ; ui/events/pointer_details.cc ; ui/events/blink/web_input_event.cc ; ui/events/blink/web_input_event_builders_win.cc ; components/input/web_input_event_builders_mac.mm ; ui/events/cocoa/events_mac.mm ; ui/events/cocoa/cocoa_event_utils.h ; chrome/test/chromedriver/element_commands.cc ; chrome/test/chromedriver/element_util.cc ; chrome/test/chromedriver/chrome/web_view_impl.cc ; chrome/test/chromedriver/chrome/ui_events.cc ; chrome/test/chromedriver/key_converter.cc
- CDP protocol definition: https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/browser_protocol.json

Specs / platform docs:
- Pointer Events: https://w3c.github.io/pointerevents/ ; WebDriver: https://w3c.github.io/webdriver/ ; MDN Event.timeStamp: https://developer.mozilla.org/en-US/docs/Web/API/Event/timeStamp ; Chrome aligned input events: https://developer.chrome.com/blog/aligning-input-events ; Chrome timer resolution: https://developer.chrome.com/blog/cross-origin-isolated-hr-timers ; fractional pointer coordinates: https://groups.google.com/a/chromium.org/g/blink-dev/c/ssfd-_V26Ls/m/YwcZTqyqBgAJ and https://lists.w3.org/Archives/Public/public-pointer-events/2021AprJun/0011.html ; trackpad/wheel discussion: https://lists.w3.org/Archives/Public/public-pointer-events/2026JanMar/0031.html
- Accessibility: Apple Voice Control https://support.apple.com/guide/mac-help/use-voice-control-mh40719/mac ; NVDA user guide https://download.nvaccess.org/documentation/userGuide.html ; Windows Eye Control https://support.microsoft.com/en-us/windows/get-started-with-eye-control-in-windows-1a170a20-1083-2452-8f42-17a7d4fe89a9

Research papers and datasets:
- BeCAPTCHA-Mouse: https://arxiv.org/abs/2005.00890 (html https://ar5iv.labs.arxiv.org/html/2005.00890)
- Chu, Gianvecchio, Koehl, Wang, Jajodia, "Blog or block", Computer Networks 2013: https://www.eecis.udel.edu/~hnw/paper/comnet13.pdf ; "Bot or Human?" (2018) DBLP https://dblp.uni-trier.de/pid/15/5877.html
- Mouse dynamics survey: https://arxiv.org/abs/2208.09061 (html https://ar5iv.labs.arxiv.org/html/2208.09061)
- DMTG: https://arxiv.org/abs/2410.18233
- ReMouse: https://www.mdpi.com/2624-800X/3/1/7 ; https://ieee-dataport.org/comment/3880
- Known By Their Actions: https://arxiv.org/html/2605.14786v1
- What Does It Take to Detect an AI Agent?: https://arxiv.org/html/2607.26935
- Whose Agent Are You?: https://arxiv.org/pdf/2606.20910
- Dhakal et al., Observations on Typing from 136 Million Keystrokes (CHI 2018): https://userinterfaces.aalto.fi/136Mkeystrokes/ (PDF https://userinterfaces.aalto.fi/136Mkeystrokes/resources/chi-18-analysis.pdf)
- CMU keystroke benchmark (Killourhy & Maxion): https://www.cs.cmu.edu/~keystroke/DSL-StrongPasswordData.csv
- Balabit Mouse Dynamics Challenge: https://github.com/balabit/Mouse-Dynamics-Challenge
- MacKenzie, Fitts' law lecture (We = 4.133 SDx): https://www.yorku.ca/mack/UCLAN2018/FittsLaw.pdf
- Castle.io blog: https://blog.castle.io/bot-or-not-can-you-spot-the-automated-mouse-movements/
- Bureau blog: https://bureau.id/resources/blog/mouse-movement-behavioral-patterns-can-reliably-tell-bots-from-humans
- SapiAgent / Hungarian follow-up: https://ojs.emt.ro/enelko-szamokt/article/view/1014
- Iliou et al. 2021 (not fetched): https://dl.acm.org/doi/10.1145/3447815

---

## Appendix A. Claude in Chrome probe — raw event excerpt (2026-10-24, Chrome 155, macOS, DPR 2, viewport 1728×919)

Columns: index, Δt from previous row (ms), event type, isTrusted, selected properties (`cx/cy` clientX/Y, `sx/sy` screenX/Y, `mx/my` movementX/Y, `btn/btns`, `det` detail, `pt` pointerType, `pid` pointerId, `pr` pressure, `w/h` width/height, `coal` getCoalescedEvents().length, `pred` getPredictedEvents().length, `pdid` persistentDeviceId, `sc` sourceCapabilities, `dx/dy/dm/wdy` wheel deltas/deltaMode/wheelDeltaY, `kc` keyCode, `lat` = performance.now() − timeStamp at handler time). Requested model coordinates: hover/click (204,190) → landed (233,217); click (238,266) → (272,304); drag (300,600)→(500,650) → (343,686)→(571,743); click-by-ref on the 241×53 px button whose center is (204.5,190.375) → (205,190).

```
  4 +  507.1ms t=pointerrawupdate trusted=True ts=37137.3 lat=0.9 cx=233 cy=217 sx=233 sy=1334 mx=0 my=0 btn=-1 btns=0 det=0 pt=mouse pid=1 pr=0 w=1 h=1 coal=1 pred=0 pdid=1 sy=1334 tgt=BODY
  5 +    0.0ms t=pointerover trusted=True ts=37137.3 lat=1.2 cx=233 cy=217 sx=233 sy=1334 mx=0 my=0 btn=-1 btns=0 det=0 pt=mouse pid=1 pr=0 w=1 h=1 coal=0 pred=0 pdid=1 sy=1334 tgt=BODY
  6 +    0.0ms t=mouseover trusted=True ts=37137.3 lat=1.3 cx=233 cy=217 sx=233 sy=1334 mx=0 my=0 btn=0 btns=0 det=0 sc={'fte': False} sy=1334 tgt=BODY
  7 +    0.0ms t=pointermove trusted=True ts=37137.3 lat=1.3 cx=233 cy=217 sx=233 sy=1334 mx=0 my=0 btn=-1 btns=0 det=0 pt=mouse pid=1 pr=0 w=1 h=1 coal=1 pred=0 pdid=1 sy=1334 tgt=BODY
  8 +    0.0ms t=mousemove trusted=True ts=37137.3 lat=1.3 cx=233 cy=217 sx=233 sy=1334 mx=0 my=0 btn=0 btns=0 det=0 sc={'fte': False} sy=1334 tgt=BODY
  9 + 1076.4ms t=pointerrawupdate trusted=True ts=38213.7 lat=0.2 cx=233 cy=217 sx=233 sy=1334 mx=0 my=0 btn=-1 btns=0 det=0 pt=mouse pid=1 pr=0 w=1 h=1 coal=1 pred=0 pdid=1 sy=1334 tgt=BODY
 10 +    0.0ms t=pointermove trusted=True ts=38213.7 lat=0.7 cx=233 cy=217 sx=233 sy=1334 mx=0 my=0 btn=-1 btns=0 det=0 pt=mouse pid=1 pr=0 w=1 h=1 coal=1 pred=0 pdid=1 sy=1334 tgt=BODY
 11 +    0.0ms t=mousemove trusted=True ts=38213.7 lat=0.8 cx=233 cy=217 sx=233 sy=1334 mx=0 my=0 btn=0 btns=0 det=0 sc={'fte': False} sy=1334 tgt=BODY
 12 +    1.7ms t=pointerdown trusted=True ts=38215.4 lat=0.4 cx=233 cy=217 sx=233 sy=1334 mx=0 my=0 btn=0 btns=1 det=0 pt=mouse pid=1 pr=0.5 w=1 h=1 coal=0 pred=0 pdid=1 sy=1334 tgt=BODY
 13 +    0.0ms t=mousedown trusted=True ts=38215.4 lat=0.5 cx=233 cy=217 sx=233 sy=1334 mx=0 my=0 btn=0 btns=1 det=1 sc={'fte': False} sy=1334 tgt=BODY
 14 +    1.2ms t=pointerup trusted=True ts=38216.6 lat=0 cx=233 cy=217 sx=233 sy=1334 mx=0 my=0 btn=0 btns=0 det=0 pt=mouse pid=1 pr=0 w=1 h=1 coal=0 pred=0 pdid=1 sy=1334 tgt=BODY
 15 +    0.0ms t=mouseup trusted=True ts=38216.6 lat=0.1 cx=233 cy=217 sx=233 sy=1334 mx=0 my=0 btn=0 btns=0 det=1 sc={'fte': False} sy=1334 tgt=BODY
 16 +    0.0ms t=click trusted=True ts=38216.6 lat=0.2 cx=233 cy=217 sx=233 sy=1334 mx=0 my=0 btn=0 btns=0 det=1 pt=mouse pid=1 pr=0 w=1 h=1 coal=0 pred=0 pdid=0 sc={'fte': False} sy=1334 tgt=BODY
 19 + 1069.7ms t=pointerrawupdate trusted=True ts=39286.3 lat=0.5 cx=272 cy=304 sx=272 sy=1421 mx=39 my=87 btn=-1 btns=0 det=0 pt=mouse pid=1 pr=0 w=1 h=1 coal=1 pred=0 pdid=1 sy=1421 tgt=spacer
 20 +    0.0ms t=pointerout trusted=True ts=39286.3 lat=0.7 cx=272 cy=304 sx=272 sy=1421 mx=0 my=0 btn=-1 btns=0 det=0 pt=mouse pid=1 pr=0 w=1 h=1 coal=0 pred=0 pdid=1 sy=1421 tgt=BODY
 21 +    0.0ms t=pointerover trusted=True ts=39286.3 lat=0.7 cx=272 cy=304 sx=272 sy=1421 mx=0 my=0 btn=-1 btns=0 det=0 pt=mouse pid=1 pr=0 w=1 h=1 coal=0 pred=0 pdid=1 sy=1421 tgt=spacer
 22 +    0.0ms t=mouseover trusted=True ts=39286.3 lat=0.8 cx=272 cy=304 sx=272 sy=1421 mx=0 my=0 btn=0 btns=0 det=0 sc={'fte': False} sy=1421 tgt=spacer
 23 +    0.0ms t=pointermove trusted=True ts=39286.3 lat=0.8 cx=272 cy=304 sx=272 sy=1421 mx=39 my=87 btn=-1 btns=0 det=0 pt=mouse pid=1 pr=0 w=1 h=1 coal=1 pred=0 pdid=1 sy=1421 tgt=spacer
 24 +    0.0ms t=mousemove trusted=True ts=39286.3 lat=0.8 cx=272 cy=304 sx=272 sy=1421 mx=39 my=87 btn=0 btns=0 det=0 sc={'fte': False} sy=1421 tgt=spacer
 25 +    2.0ms t=pointerdown trusted=True ts=39288.3 lat=0.6 cx=272 cy=304 sx=272 sy=1421 mx=0 my=0 btn=0 btns=1 det=0 pt=mouse pid=1 pr=0.5 w=1 h=1 coal=0 pred=0 pdid=1 sy=1421 tgt=spacer
 26 +    0.0ms t=mousedown trusted=True ts=39288.3 lat=0.6 cx=272 cy=304 sx=272 sy=1421 mx=0 my=0 btn=0 btns=1 det=1 sc={'fte': False} sy=1421 tgt=spacer
 27 +    1.6ms t=pointerup trusted=True ts=39289.9 lat=0.2 cx=272 cy=304 sx=272 sy=1421 mx=0 my=0 btn=0 btns=0 det=0 pt=mouse pid=1 pr=0 w=1 h=1 coal=0 pred=0 pdid=1 sy=1421 tgt=spacer
 28 +    0.0ms t=mouseup trusted=True ts=39289.9 lat=0.2 cx=272 cy=304 sx=272 sy=1421 mx=0 my=0 btn=0 btns=0 det=1 sc={'fte': False} sy=1421 tgt=spacer
 29 +    0.0ms t=click trusted=True ts=39289.9 lat=0.2 cx=272 cy=304 sx=272 sy=1421 mx=0 my=0 btn=0 btns=0 det=1 pt=mouse pid=1 pr=0 w=1 h=1 coal=0 pred=0 pdid=0 sc={'fte': False} sy=1421 tgt=spacer
 32 +    3.2ms t=keydown trusted=True ts=39293.1 lat=0.7 key=a code=KeyA kc=65 tgt=BODY
 33 +    0.0ms t=keypress trusted=True ts=39293.1 lat=1.3 key=a code=KeyA kc=97 tgt=BODY
 34 +    0.2ms t=keyup trusted=True ts=39293.3 lat=1.2 key=a code=KeyA kc=65 tgt=BODY
 35 +    0.0ms t=keydown trusted=True ts=39293.3 lat=1.2 key=b code=KeyB kc=66 tgt=BODY
 36 +    0.0ms t=keypress trusted=True ts=39293.3 lat=1.3 key=b code=KeyB kc=98 tgt=BODY
 37 +    0.1ms t=keyup trusted=True ts=39293.4 lat=1.2 key=b code=KeyB kc=66 tgt=BODY
 38 +    0.1ms t=keydown trusted=True ts=39293.5 lat=1.1 key=  code=Space kc=32 tgt=BODY
 39 +    0.0ms t=keypress trusted=True ts=39293.5 lat=1.1 key=  code=Space kc=32 tgt=BODY
 40 +    0.0ms t=keyup trusted=True ts=39293.5 lat=1.2 key=  code=Space kc=32 tgt=BODY
 41 +    0.1ms t=keydown trusted=True ts=39293.6 lat=1.1 key=c code=KeyC kc=67 tgt=BODY
 42 +    0.0ms t=keypress trusted=True ts=39293.6 lat=1.1 key=c code=KeyC kc=99 tgt=BODY
 43 +    0.0ms t=keyup trusted=True ts=39293.6 lat=1.2 key=c code=KeyC kc=67 tgt=BODY
 44 +    0.3ms t=keydown trusted=True ts=39293.9 lat=0.9 key=d code=KeyD kc=68 tgt=BODY
 45 +    0.0ms t=keypress trusted=True ts=39293.9 lat=0.9 key=d code=KeyD kc=100 tgt=BODY
 46 +    0.1ms t=keyup trusted=True ts=39294 lat=0.8 key=d code=KeyD kc=68 tgt=BODY
 47 +    2.7ms t=keydown trusted=True ts=39296.7 lat=0.1 key=Tab code=Tab kc=9 tgt=BODY
 48 +    0.3ms t=focus trusted=True ts=39297 lat=0.1 tgt=out
 49 +    0.1ms t=focusin trusted=True ts=39297.1 lat=0 tgt=out
 50 +    0.6ms t=keyup trusted=True ts=39297.7 lat=0.1 key=Tab code=Tab kc=9 tgt=out
 51 +    8.2ms t=scroll trusted=True ts=39305.9 lat=0.2 sy=9.5 sy=9.5
 52 +    0.0ms t=scroll trusted=True ts=39305.9 lat=0.4 sy=9.5 sy=9.5
 53 +   -6.4ms t=wheel trusted=True ts=39299.5 lat=15.6 cx=457 cy=572 sx=457 sy=1689 mx=0 my=0 btn=0 btns=0 det=0 dx=0 dy=300 dm=0 wdy=-120 sy=1689 tgt=spacer
 54 +   15.5ms t=scroll trusted=True ts=39315 lat=0.2 sy=32.5 sy=32.5
 55 +    0.0ms t=scroll trusted=True ts=39315 lat=0.3 sy=32.5 sy=32.5
 56 +    0.0ms t=scrollend trusted=True ts=39315 lat=0.3
 57 +    7.7ms t=scroll trusted=True ts=39322.7 lat=0.1 sy=63 sy=63
 58 +    0.0ms t=scroll trusted=True ts=39322.7 lat=0.2 sy=63 sy=63
 87 +    7.4ms t=scroll trusted=True ts=39447.3 lat=0.2 sy=899 sy=899
 88 +    0.0ms t=scroll trusted=True ts=39447.3 lat=0.3 sy=899 sy=899
 89 +   11.6ms t=scrollend trusted=True ts=39458.9 lat=0.2
 90 + 1187.3ms t=wheel trusted=True ts=40646.2 lat=10.5 cx=457 cy=572 sx=457 sy=1689 mx=0 my=0 btn=0 btns=0 det=0 dx=0 dy=-300 dm=0 wdy=120 sy=1689 tgt=spacer
 91 +   10.2ms t=scroll trusted=True ts=40656.4 lat=0.5 sy=599 sy=599
 92 +    0.0ms t=scroll trusted=True ts=40656.4 lat=0.7 sy=599 sy=599
 93 +    0.1ms t=scrollend trusted=True ts=40656.5 lat=0.6
 94 + 1398.2ms t=pointerrawupdate trusted=True ts=42054.7 lat=0.4 cx=233 cy=217 sx=233 sy=1334 mx=-39 my=-87 btn=-1 btns=0 det=0 pt=mouse pid=1 pr=0 w=1 h=1 coal=1 pred=0 pdid=1 sy=1334 tgt=spacer
 95 +    0.0ms t=pointermove trusted=True ts=42054.7 lat=0.7 cx=233 cy=217 sx=233 sy=1334 mx=-39 my=-87 btn=-1 btns=0 det=0 pt=mouse pid=1 pr=0 w=1 h=1 coal=1 pred=0 pdid=1 sy=1334 tgt=spacer
 96 +    0.0ms t=mousemove trusted=True ts=42054.7 lat=0.7 cx=233 cy=217 sx=233 sy=1334 mx=-39 my=-87 btn=0 btns=0 det=0 sc={'fte': False} sy=1334 tgt=spacer
 97 +    1.7ms t=pointerdown trusted=True ts=42056.4 lat=0.5 cx=233 cy=217 sx=233 sy=1334 mx=0 my=0 btn=0 btns=1 det=0 pt=mouse pid=1 pr=0.5 w=1 h=1 coal=0 pred=0 pdid=1 sy=1334 tgt=spacer
 98 +    0.0ms t=mousedown trusted=True ts=42056.4 lat=0.6 cx=233 cy=217 sx=233 sy=1334 mx=0 my=0 btn=0 btns=1 det=1 sc={'fte': False} sy=1334 tgt=spacer
 99 +    0.6ms t=blur trusted=True ts=42057 lat=0 tgt=out
100 +    0.1ms t=focusout trusted=True ts=42057.1 lat=0 tgt=out
101 +    1.3ms t=pointerup trusted=True ts=42058.4 lat=0.3 cx=233 cy=217 sx=233 sy=1334 mx=0 my=0 btn=0 btns=0 det=0 pt=mouse pid=1 pr=0 w=1 h=1 coal=0 pred=0 pdid=1 sy=1334 tgt=spacer
102 +    0.0ms t=mouseup trusted=True ts=42058.4 lat=0.3 cx=233 cy=217 sx=233 sy=1334 mx=0 my=0 btn=0 btns=0 det=1 sc={'fte': False} sy=1334 tgt=spacer
103 +    0.0ms t=click trusted=True ts=42058.4 lat=0.3 cx=233 cy=217 sx=233 sy=1334 mx=0 my=0 btn=0 btns=0 det=1 pt=mouse pid=1 pr=0 w=1 h=1 coal=0 pred=0 pdid=0 sc={'fte': False} sy=1334 tgt=spacer
104 +    0.7ms t=pointerdown trusted=True ts=42059.1 lat=0.1 cx=233 cy=217 sx=233 sy=1334 mx=0 my=0 btn=0 btns=1 det=0 pt=mouse pid=1 pr=0.5 w=1 h=1 coal=0 pred=0 pdid=1 sy=1334 tgt=spacer
105 +    0.0ms t=mousedown trusted=True ts=42059.1 lat=0.2 cx=233 cy=217 sx=233 sy=1334 mx=0 my=0 btn=0 btns=1 det=2 sc={'fte': False} sy=1334 tgt=spacer
106 +    0.9ms t=pointerup trusted=True ts=42060 lat=0.2 cx=233 cy=217 sx=233 sy=1334 mx=0 my=0 btn=0 btns=0 det=0 pt=mouse pid=1 pr=0 w=1 h=1 coal=0 pred=0 pdid=1 sy=1334 tgt=spacer
107 +    0.0ms t=mouseup trusted=True ts=42060 lat=0.3 cx=233 cy=217 sx=233 sy=1334 mx=0 my=0 btn=0 btns=0 det=2 sc={'fte': False} sy=1334 tgt=spacer
108 +    0.0ms t=click trusted=True ts=42060 lat=0.3 cx=233 cy=217 sx=233 sy=1334 mx=0 my=0 btn=0 btns=0 det=2 pt=mouse pid=1 pr=0 w=1 h=1 coal=0 pred=0 pdid=0 sc={'fte': False} sy=1334 tgt=spacer
109 +    0.3ms t=dblclick trusted=True ts=42060.3 lat=0 cx=233 cy=217 sx=233 sy=1334 mx=0 my=0 btn=0 btns=0 det=2 sc={'fte': False} sy=1334 tgt=spacer
110 +    3.3ms t=pointerrawupdate trusted=True ts=42063.6 lat=0.4 cx=343 cy=686 sx=343 sy=1803 mx=110 my=469 btn=-1 btns=0 det=0 pt=mouse pid=1 pr=0 w=1 h=1 coal=1 pred=0 pdid=1 sy=1803 tgt=spacer
111 +    0.0ms t=pointermove trusted=True ts=42063.6 lat=1.5 cx=343 cy=686 sx=343 sy=1803 mx=110 my=469 btn=-1 btns=0 det=0 pt=mouse pid=1 pr=0 w=1 h=1 coal=1 pred=0 pdid=1 sy=1803 tgt=spacer
115 +    2.2ms t=pointerdown trusted=True ts=42065.8 lat=0.4 cx=343 cy=686 sx=343 sy=1803 mx=0 my=0 btn=0 btns=1 det=0 pt=mouse pid=1 pr=0.5 w=1 h=1 coal=0 pred=0 pdid=1 sy=1803 tgt=spacer
116 +    0.0ms t=mousedown trusted=True ts=42065.8 lat=0.5 cx=343 cy=686 sx=343 sy=1803 mx=0 my=0 btn=0 btns=1 det=1 sc={'fte': False} sy=1803 tgt=spacer
117 +    1.5ms t=pointerrawupdate trusted=True ts=42067.3 lat=0.1 cx=389 cy=697 sx=389 sy=1814 mx=46 my=11 btn=-1 btns=1 det=0 pt=mouse pid=1 pr=0.5 w=1 h=1 coal=1 pred=0 pdid=1 sy=1814 tgt=spacer
118 +    0.0ms t=pointermove trusted=True ts=42067.3 lat=0.3 cx=389 cy=697 sx=389 sy=1814 mx=46 my=11 btn=-1 btns=1 det=0 pt=mouse pid=1 pr=0.5 w=1 h=1 coal=1 pred=0 pdid=1 sy=1814 tgt=spacer
121 +    0.4ms t=pointermove trusted=True ts=42067.9 lat=0 cx=480 cy=720 sx=480 sy=1837 mx=91 my=23 btn=-1 btns=1 det=0 pt=mouse pid=1 pr=0.5 w=1 h=1 coal=2 pred=0 pdid=1 sy=1837 tgt=spacer
124 +    0.0ms t=pointermove trusted=True ts=42068.1 lat=0.6 cx=525 cy=732 sx=525 sy=1849 mx=45 my=12 btn=-1 btns=1 det=0 pt=mouse pid=1 pr=0.5 w=1 h=1 coal=1 pred=10 pdid=1 sy=1849 tgt=spacer
127 +    0.0ms t=pointermove trusted=True ts=42068.5 lat=4.7 cx=571 cy=743 sx=571 sy=1860 mx=46 my=11 btn=-1 btns=1 det=0 pt=mouse pid=1 pr=0.5 w=1 h=1 coal=1 pred=10 pdid=1 sy=1860 tgt=spacer
131 +    5.3ms t=pointerup trusted=True ts=42073.8 lat=0.3 cx=571 cy=743 sx=571 sy=1860 mx=0 my=0 btn=0 btns=0 det=0 pt=mouse pid=1 pr=0 w=1 h=1 coal=0 pred=0 pdid=1 sy=1860 tgt=spacer
132 +    0.0ms t=mouseup trusted=True ts=42073.8 lat=0.3 cx=571 cy=743 sx=571 sy=1860 mx=0 my=0 btn=0 btns=0 det=1 sc={'fte': False} sy=1860 tgt=spacer
133 +    0.0ms t=click trusted=True ts=42073.8 lat=0.3 cx=571 cy=743 sx=571 sy=1860 mx=0 my=0 btn=0 btns=0 det=1 pt=mouse pid=1 pr=0 w=1 h=1 coal=0 pred=0 pdid=0 sc={'fte': False} sy=1860 tgt=spacer
134 +    2.3ms t=scroll trusted=True ts=42076.1 lat=4.2 sy=0 sy=0
136 +    0.0ms t=scrollend trusted=True ts=42076.1 lat=4.2
137 +   55.7ms t=pointerrawupdate trusted=True ts=42131.8 lat=0.3 cx=205 cy=190 sx=205 sy=1307 mx=-366 my=-553 btn=-1 btns=0 det=0 pt=mouse pid=1 pr=0 w=1 h=1 coal=1 pred=0 pdid=1 sy=1307 tgt=target
141 +    0.0ms t=pointermove trusted=True ts=42131.8 lat=7.9 cx=205 cy=190 sx=205 sy=1307 mx=-366 my=-553 btn=-1 btns=0 det=0 pt=mouse pid=1 pr=0 w=1 h=1 coal=1 pred=0 pdid=1 sy=1307 tgt=target
143 +    9.0ms t=pointerdown trusted=True ts=42140.8 lat=0.4 cx=205 cy=190 sx=205 sy=1307 mx=0 my=0 btn=0 btns=1 det=0 pt=mouse pid=1 pr=0.5 w=1 h=1 coal=0 pred=0 pdid=1 sy=1307 tgt=target
145 +    0.6ms t=focus trusted=True ts=42141.4 lat=0 tgt=target
147 +    0.7ms t=pointerup trusted=True ts=42142.1 lat=0.1 cx=205 cy=190 sx=205 sy=1307 mx=0 my=0 btn=0 btns=0 det=0 pt=mouse pid=1 pr=0 w=1 h=1 coal=0 pred=0 pdid=1 sy=1307 tgt=target
149 +    0.0ms t=click trusted=True ts=42142.1 lat=0.2 cx=205 cy=190 sx=205 sy=1307 mx=0 my=0 btn=0 btns=0 det=1 pt=mouse pid=1 pr=0 w=1 h=1 coal=0 pred=0 pdid=0 sc={'fte': False} sy=1307 tgt=target
152 +  507.0ms t=blur trusted=True ts=160339 lat=0 tgt=target
154 +    0.4ms t=focus trusted=True ts=160339.4 lat=0 tgt=field
156 +    3.8ms t=change trusted=False ts=160343.2 lat=0 tgt=field
157 +    0.0ms t=input trusted=False ts=160343.2 lat=0 tgt=field
```

Summary counts for the whole run (160 events): `pointerrawupdate` 10, `pointermove` 10, `mousemove` 10, `pointerdown/mousedown` 6, `pointerup/mouseup` 6, `click` 6, `dblclick` 1, `keydown` 6, `keypress` 5, `keyup` 6, `wheel` 2, `scroll` 40 (document+window listeners both fired), `scrollend` 4, untrusted `change` 1 + `input` 1 (from `form_input`), `visibilitychange` 4, `blur` 3, `focus` 4. Main-world prototype call counters after `read_page`/`find`: `{gbcr: 2}` (both from the probe's own script); `javascript_tool` stack frame: `at <anonymous>:1:44`.

## Appendix B. Dataset statistics computed for this report

CMU keystroke benchmark (`DSL-StrongPasswordData.csv`; 20,400 rows; 224,400 hold samples; 204,000 digraphs; units converted to ms):

| metric | mean | p1 | p5 | p25 | p50 | p75 | p95 | p99 |
|---|---|---|---|---|---|---|---|---|
| Hold (H.*) | 90.1 | 38 | 49 | 69 | 86 | 106 | 145 | 182 |
| Down-Down (DD.*) | 249.2 | 51 | 78 | 128 | 191 | 301 | 602 | 1040 |
| Up-Down (UD.*) | 158.9 | — | — | — | — | — | — | — |

Rollover: 22,118 of 204,000 flights negative (10.8 %).

Balabit (training_files; `client timestamp`, Move→Move Δt limited to (0, 2000) ms; left-button press→release):

| session | rows | Move Δt n | mean | p5 | p25 | p50 | p75 | p95 | share Δt ≤ 8 ms | clicks n | click mean | p5 | p25 | p50 | p75 | p95 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| user12/session_2144641057 | 30,288 | 23,647 | 202.3 | 93 | 109 | 110 | 156 | 717 | 0.0 % | 1,021 | 178.8 | 63 | 93 | 109 | 125 | 780 |
| user15/session_0205904470 | 17,157 | 13,058 | 200.3 | 93 | 109 | 124 | 187 | 624 | 0.0 % | 1,062 | 137.9 | 78 | 93 | 109 | 124 | 203 |
| user16/session_0735651357 | 53,817 | 40,214 | 172.3 | 93 | 109 | 110 | 156 | 468 | 0.0 % | 3,169 | 159.7 | 62 | 78 | 94 | 109 | 656 |

(The first rows of a session show several Move records sharing one timestamp — RDP batching; all click-duration quantiles fall on multiples of ≈ 15.6 ms.)
