# False-positive traps: everything that makes legitimate humans and wanted bots look like AI agents

Research date: 2026-10-24. Area: calibration / false-positive avoidance for the necter client-side SDK and edge companion.

Confidence legend used throughout:

- **confirmed** — read in a primary source (vendor doc, spec, browser source code, the project's own issue tracker, or a live endpoint fetched during this research) and the exact string is quoted.
- **likely** — consistent secondary evidence (reputable third-party list, multiple independent reports, or source code of a related component) but no primary vendor statement.
- **uncertain** — could not verify; stated so the implementation team knows it is a guess or an experiment to run.

Method note: ~70 primary-source fetches (vendor docs, IETF/Cloudflare docs, Chromium/WebKit/Firefox/Brave/Bitwarden/BotD/Lighthouse/Playwright source files, GitHub code search, live IP-list endpoints) plus ~15 web searches. Several anti-bot vendors' own sites (HUMAN, DataDome, Cloudflare Community, StackOverflow) and Anubis' own docs site returned HTTP 403 / "Access Denied" to this plain research fetcher, which is itself a data point about collateral damage (see §14.6).

---

## 0. TL;DR — the calibration doctrine

1. **No single environmental signal is ever sufficient to block.** Software WebGL renderers, small `hardwareConcurrency`, datacenter ASNs, UTC timezones, spoofed user agents, noisy canvases, `outerHeight == innerHeight`, missing plugins — every one of these has a large benign population (VDI, privacy browsers, cheap phones, corporate proxies, kiosks). Treat them as *environment class* labels that change which behavioral thresholds apply, not as bot evidence.
2. **"Teleporting" clicks with zero `mousemove` history and sub-millisecond press duration are exactly what screen readers and voice/switch control produce.** NVDA's Enter in browse mode moves the pointer to the button centre ~1 ms before `pointerdown`, releases in <1 ms, and jumps back; events are `isTrusted === true`, `pointerType === "mouse"`, `pressure 0.5` (§3.1). That is indistinguishable, field for field, from an automation agent's click. Any "teleport click" rule must be gated behind corroboration from a *different* signal family.
3. **Assistive-technology users must be treated as human by default.** Build an explicit "AT-possible" session class (keyboard-only navigation, focus-before-click, `detail === 0` / `sourceCapabilities === null` clicks, instantaneous value insertion from dictation) and route it to invisible or non-visual verification, never to visual CAPTCHAs or hard blocks.
4. **Wanted bots are identified by verification, not by user agent.** UA token → reverse-DNS or published IP range (JSON/CSV endpoints listed in §12) or Web Bot Auth signature → category policy. Unverifiable tokens are "claimed", not "verified". Refresh lists continuously (Google's files were regenerated 2026-10-23; OpenAI's `chatgpt-user.json` 2026-10-20).
5. **Privacy browsers break fingerprint *consistency* checks on purpose.** Brave re-seeds canvas/WebGL/audio per session and per eTLD+1; Firefox's default FPP randomizes canvas and collapses `hardwareConcurrency` to 4/8 in private windows; Safari fixes `screen` to the inner viewport and `screenX/Y` to 0; Tor letterboxes. Detect that an anti-fingerprinting mode is *present* and then down-weight fingerprint-consistency features for that session, instead of scoring "inconsistent fingerprint" as a bot.
6. **Shared and cloud egress is normal human traffic.** iCloud Private Relay egresses from Akamai/CDN address space (Team Cymru attributes the sampled IPv4 ranges to AS36183 Akamai), Cloudflare WARP/Zero Trust shares one source-IP pool across all tenants, Zscaler/Netskope proxy entire enterprises, Windows 365 Cloud PCs live in Azure. The Vercel BotID incident (§14.3) is a paying customer behind Zscaler flagged `"isBot": true`.
7. **Background tabs, prerenders and bfcache restores produce "dead" sessions.** Chrome wakes hidden-tab timers once per second after hiding and once per minute after 5 minutes; prerendered documents report `document.prerendering === true` and never see a user until `prerenderingchange`. "No interaction for N minutes" must only count visible, activated time.
8. **Browser autofill and password managers insert whole values with synthetic key events.** Chrome fires a trusted generic `keydown`/`keyup` with no key, then `input`/`change`; Bitwarden fires untrusted `click`, `keydown`, `keyup`, `input`, `change` with 20 ms between fields (§11). "Typed 24 characters in 0 ms" is a human with a password manager far more often than an agent.
9. **Extension DOM markers are cheap, high-precision *human* evidence** (Grammarly's `<grammarly-desktop-integration>`, 1Password's `<com-1password-button>` and `data-com-onepassword-filled`, Google Translate's `html.translated-ltr` and `<font>` wrappers). Use them as weak positive evidence for a human, never as negative evidence when absent.
10. **AI browsers with a human at the keyboard (Atlas, Comet, Claude in Chrome, Gemini in Chrome, Edge Copilot mode) present as stock Chrome.** Atlas's UA is byte-identical to Chrome 141 on macOS (§13). Classify *agent mode per session* from behaviour (paste-typing, pointer teleport, scroll bursts, sub-10 ms inter-key latency) and keep the human-mode visits of these browsers unblocked.
11. **Lighthouse removed its identifier in January 2023.** PageSpeed/Lighthouse runs now look like plain Chrome 136 on a "moto g power (2022)" at 412×823 @1.75 or a Mac at 1350×940. Do not expect `Chrome-Lighthouse` (§12.4).
12. **Ship in monitor mode, measure false-positive rate per segment (browser × OS × network class × AT-possible), name the signal on every block page, and give site owners a one-line allowlist (header/cookie secret, IP, ASN, UA token, verified-bot category).** Cloudflare's own troubleshooting docs list ad blockers, canvas blockers, VPN extensions, WebViews and email preview panes as known challenge-breakers; Anubis' JavaScript-only default locked out NoScript users and people with cookies disabled (12 complaints in one week at Duke) — those are the mistakes to design against.

---

## 1. Signal → benign-cause matrix

| Signal our detector is likely to use | Benign populations that trip it | Minimum corroboration before acting | Section |
|---|---|---|---|
| No `mousemove` before a click; click lands at element centre; press <5 ms | Screen readers (NVDA/JAWS via Enter), accessibility-API `Invoke()`, VoiceOver/TalkBack double-tap, Voice Control "Click 7", Switch Control item scanning, Dragon "click button" | Behavioural: no keyboard/focus activity either; network/env: datacenter ASN or automation flags; timing: sub-second think-time across many pages | 3.1–3.4 |
| Pointer "teleports" (large jump, no intermediate samples) | Dragon MouseGrid, Voice Control grid, Switch Control point scanning, RDP/VDI coarse sampling, gaze trackers | Same as above; and a sustained per-session pattern, not one jump | 3.3–3.5, 5 |
| Keyboard-only session (Tab/Enter/Space, no pointer) | Screen-reader users, keyboard power users, sticky-keys users, switch users | Treat as human by default; require network + env corroboration | 3.6 |
| Whole value appears in an input in one `input` event; no per-character keystrokes | Chrome/Safari autofill, 1Password/Bitwarden/LastPass/Dashlane, Dragon dictation, IME composition, paste | `:autofill` pseudo-class, password-manager DOM markers, trusted vs untrusted events; paste in agents comes with *no* preceding focus/click by a pointer | 11.1–11.3 |
| Uniform inter-key latency / very fast typing | Agents type at 0.5–10 ms (FP-Agent), but IMEs, autofill and macro tools also do | Combine with pointer history and paste-event presence | 13 |
| `isTrusted === false` input events | Password managers (Bitwarden dispatches untrusted `KeyboardEvent`/`Event`), form libraries, polyfills | Never block on this alone; agents driving via CDP/accessibility produce *trusted* events anyway | 11.2 |
| Software WebGL renderer (SwiftShader, llvmpipe, "Mesa OffScreen"), generic GPU strings | VDI/RDP/Citrix/Chrome Remote Desktop, VMs, Brave 1.93+ (generic vendor/renderer for everyone), Firefox RFP (spoofed), GPU-blocklisted machines | BotD only flags vendor `Brian Paul` + renderer `Mesa OffScreen` and only as a headless-Chrome hint | 5, 7.1, 7.2 |
| `hardwareConcurrency` 2/4/8, `deviceMemory` 2/4 | WebKit caps everyone at 4 or 8; Firefox FPP/RFP collapses to 4/8; Brave farbles; cheap phones; 2-vCPU VDI | Never a bot signal; at most an environment-class hint | 10 |
| Timezone UTC, `Atlantic/Reykjavik`, locale/timezone mismatch with IP | Firefox RFP/Tor (UTC → Reykjavik since FF128), travellers, VPN/Private Relay/WARP users, servers in offices | Combine with other RFP tells and treat as "privacy browser" class | 7.2, 8 |
| Canvas/WebGL/audio hash changes between reads or between sessions | Brave (per-session seed), Firefox FPP (default in private windows), Safari advanced protection, CanvasBlocker, Chrome with Privacy Sandbox? (no) | Detect anti-fingerprinting mode; down-weight consistency features | 7 |
| Spoofed/frozen UA (Windows 10, macOS 10_15_7, Android 10 "K", Chrome major.0.0.0) | **Every** Chrome ≥ 110 user (UA reduction), every Firefox RFP user, Lighthouse, Atlas, Comet | Use UA-CH high-entropy hints with consent, never UA string alone | 7.5, 13 |
| `outerWidth/outerHeight == innerWidth/innerHeight` or 0×0 | Fullscreen/kiosk, mobile browsers, Safari advanced protection (outer==inner by design), background tabs opened without focus (0×0) | BotD requires document focus and both outers 0 | 6.1 |
| `document.visibilityState === 'hidden'`, no activity, timers drifting | Background tabs (1 s / 1 min throttling), prerendering, bfcache | Gate clocks on visibility + `prerenderingchange` + `pageshow.persisted` | 6.2 |
| Datacenter / cloud / CDN ASN, shared IP with many sessions | Private Relay (Akamai AS36183 ranges), WARP/Zero Trust (shared pool), Zscaler, Netskope, Mullvad, Tor, Windows 365 / AWS WorkSpaces, CGNAT, Chrome prefetch proxy | Raise rate-limit budgets for known shared-egress lists; require behavioural evidence | 8 |
| Missing storage/cookies, missing APIs, odd UA tokens (`wv`, `FBAN`, no `Safari/`) | Android WebView, WKWebView, Facebook/Instagram/LINE/WeChat in-app browsers, email preview panes | Expect degraded environments on mobile; never challenge in a WebView with a visual CAPTCHA | 9 |
| Beacon/telemetry never arrives | uBlock Origin + EasyPrivacy block `fingerprint.com`, `/botd.gif?`, PerimeterX, Castle, DataDome and hCaptcha hosts; corporate proxies strip; no-JS clients | Treat "no JS telemetry" as *unknown*, not bot, unless server-side signals corroborate | 7.7 |
| DevTools-open heuristics (`outerWidth - innerWidth` thresholds) | Docked sidebars, zoom, extensions; the reference library itself says it now has "too many false-positives" | Do not use as a bot signal | 7.8 |
| DOM mutations by non-page scripts (shadow roots, `<font>` wrappers, injected buttons) | Grammarly, Google Translate, password managers, Dashlane, LastPass, accessibility overlays, TTS/reader extensions | Positive human evidence, not agent evidence | 11.4–11.6 |
| `navigator.webdriver === true`, headless UA, automation flags | Site owner's own Playwright/Puppeteer CI, Checkly (Playwright), Datadog/Pingdom browser tests, Lighthouse CI, prerender services, Screaming Frog JS rendering | Verified-bot allowlist + site-owner bypass token | 12 |
| Chrome-like fingerprint but behaviour "too regular" | Human using Atlas/Comet/Gemini in Chrome in assistant (non-agent) mode | Classify agent mode per session; per-flow human check at risky steps | 13 |

---

## 2. Scope note on "likely signals"

The implementation brief lists the detector families we expect to build: pointer/keyboard/scroll behaviour, timing regularity, `isTrusted`/`sourceCapabilities`/event-detail consistency, environment fingerprint (WebGL, canvas, audio, fonts, `hardwareConcurrency`, `deviceMemory`, screen geometry, timezone/locale), UA / UA-CH consistency, network reputation (ASN, shared egress, TLS/HTTP fingerprints at the edge), JS-telemetry presence, DOM-mutation and extension artefacts, declared identity (UA tokens, Web Bot Auth, Private Access Tokens). Every section below says which of these a benign population trips, quotes the evidence, and gives disambiguation and guardrails.

---

## 3. Assistive technology

### 3.1 Desktop screen readers (JAWS, NVDA, VoiceOver on macOS, Narrator)

**What they trip:** zero `mousemove`, clicks that appear at the exact element centre with no approach path, press durations under 1 ms, no `keydown`/`keyup` for the activating key, focus changes without pointer activity, sometimes `detail === 0` and `sourceCapabilities === null`.

**Evidence (confirmed, primary: adobe/react-spectrum issue #10310, measurements on Windows 11, Chrome 155.0.8059.40, NVDA 2026.2):**

- NVDA's Enter in browse mode "simulates a real mouse click" rather than using Chrome's accessibility action path. The pointer "jumped to the centre of the button" about 1 ms before `pointerdown`, at `clientX/Y 173.67, 357.5` for a button centred at `174, 357`, and about 5 ms after `pointerup` it "jumped back to where it had been."
- `pointerdown` → `pointerup` were "less than 1 ms apart (0.8 ms and 0.7 ms)" versus 87 ms and 120 ms for a hardware mouse.
- "No `keydown` or `keyup` for Enter reached the page, in either run."
- Field-for-field comparison with a hardware mouse: `pointerType` `mouse`, `width/height` 1/1, `pressure` 0.5, `mousedown.detail` 1, `click.detail` 1, `sourceCapabilities {firesTouchEvents: false}` — identical. The commenter: apart from timing and the pointer jumps, the events "matched a real mouse click field for field."
- UI Automation `InvokePattern.Invoke()` (the accessibility-API path used by other AT): `focus` fired *before* `pointerdown`; `mousedown.detail` was `0`; `sourceCapabilities` was `null` on `mousedown`, `mouseup` and `click`.
- Browser differences from the same issue: JAWS/NVDA + Chrome fire `click` and `pointerdown` with `pointerType` `mouse`; "`JAWS/NVDA + Firefox` and `VoiceOver` does not trigger a `pointerdown` event and the `pointerType` comes as an empty string."
- A maintainer: "there very well may not be enough information from the click/pointer events to sufficiently distinguish these screen reader clicks from mouse clicks."

**Are AT clicks `isTrusted`? Yes (confirmed from browser source).**

- Chromium, `third_party/blink/renderer/core/events/simulated_event_util.cc`:
  ```cpp
  created_event->SetTrusted(
      creation_scope == SimulatedClickCreationScope::kFromAccessibility ||
      (creation_scope == SimulatedClickCreationScope::kFromUserAgent &&
       (!underlying_event || underlying_event->isTrusted())));
  ```
  and for the accessibility scope: `initializer->setPointerId(PointerEventFactory::kMouseId); initializer->setPointerType(pointer_type_names::kMouse);`. The accessibility entry point is `AXObject::OnNativeClickAction()` → `element->AccessKeyAction(SimulatedClickCreationScope::kFromAccessibility)` (`ax_object.cc`), and `EventDispatcher::DispatchSimulatedClick` dispatches `pointerdown`, `mousedown`, `mouseup`, `click` for that scope (`event_dispatcher.cc`). By contrast `HTMLElement::click()` uses `SimulatedClickCreationScope::kFromScript` (`html_element.cc`), which is why MDN documents: "The `click` event fired through `HTMLElement.click()` sets the `isTrusted` property to `false`."
- WebKit, `Source/WebCore/dom/SimulatedClick.cpp`: `source == SimulatedClickSource::UserAgent ? IsTrusted::Yes : IsTrusted::No`; `Element::dispatchSimulatedClick` picks `SimulatedClickSource::UserAgent` when there is no underlying event or the underlying event is trusted (`Element.cpp` lines 661–667), and `AccessibilityObject::press()` ends with `pressElement->accessKeyAction(true) || pressElement->dispatchSimulatedClick(nullptr, SendMouseUpDownEvents)`.
- MDN `Event.isTrusted`: "`true` when the event was generated by the user agent (including via user actions and programmatic methods such as `HTMLElement.focus()`), and `false` when the event was dispatched via `EventTarget.dispatchEvent()`."

**Mode and key behaviour (likely, secondary):** a Vispero (JAWS vendor) article summarised in search results says pressing Enter in the virtual cursor fires mouse events, not keyboard events, and ArrowDown fires neither because the screen reader consumes it. Léonie Watson (tink.uk) stresses that "keyboard focus and screen reader focus are not the same thing!" and that screen-reader users navigate by headings/landmarks/lists with commands the page never sees.

**Prevalence (confirmed, WebAIM Screen Reader User Survey #10, Dec 2023–Jan 2024, 1,539 valid responses):** primary desktop screen reader JAWS 40.5%, NVDA 37.7%, VoiceOver 9.7%, Narrator 0.7%; browser used with it Chrome 52.3%, Edge 19.3%, Firefox 16.0%, Safari 8.0%; 49.5% use screen readers "about the same" on desktop and mobile; mobile readers VoiceOver 70.6%, TalkBack 34.7%.

**Disambiguation:**

- A **real agent's** session typically has *no* focus/keyboard events at all between navigation and the click, arrives with automation/network corroboration, and moves on within seconds. A **screen-reader** session has `focus`/`focusin` activity preceding clicks (Invoke path), reading dwell times of seconds to minutes per page, and often `keydown` events for Tab/Space/arrow keys in forms mode.
- `mousedown.detail === 0` with `sourceCapabilities === null` is a signature of the accessibility-API path (UIA/MSAA/AT-SPI/AX) — it is *evidence of AT*, not of automation. CDP-driven agents dispatch through the input pipeline and carry `sourceCapabilities` like a real mouse.
- Firefox + screen reader: `pointerType === ""` on clicks is documented AT behaviour, not spoofing.

**Guardrails:**

- Put "click without pointer history" in the *behavioural* family and require corroboration from a *different* family (network/env/declared) before any blocking action.
- Never serve a visual CAPTCHA to a session classified AT-possible; prefer invisible verification (Private Access Tokens, managed challenge with audio/accessible fallback, or simply allow with rate limits).
- Keep the AT heuristics explainable on the block/appeal page ("we saw no pointer movement"). Prosopo's advice: every block should name the signal that caused it.

### 3.2 Mobile screen readers (VoiceOver on iOS, TalkBack on Android)

**What they trip:** taps with no `touchstart`/`touchmove` gesture history, clicks at element centres, scrolling by three-finger swipes that yields scroll events without the normal touch sequence, long reading dwell.

**Evidence (confirmed, WebKit source `AccessibilityObject::press()`):** on `PLATFORM(IOS_FAMILY)`, if the element has a touch listener WebKit dispatches a simulated touch (`dispatchTouchEvent()`), otherwise it falls through to a simulated click; the comment reads "The simulated touch already dispatched pointerdown and pointerup, so like a tap, follow it with the compatibility mouse events and a click, but not a second set of pointer events." The target point is `clickPoint()` (hit-tested element centre). These are user-agent-sourced events, hence `isTrusted === true`. For Chromium Android/TalkBack the equivalent path is `OnNativeClickAction()` (likely; same code path as desktop AT, not separately verified on-device).

**Guardrails:** on touch-class devices do not require `touchstart`→`touchend` pairs around every `click`; accept "click-only" activation; use `pointerType`/`maxTouchPoints` consistency as an *environment* check, not an automation check.

### 3.3 Voice control (Dragon NaturallySpeaking, macOS Voice Control, Windows Voice Access)

**What they trip:** pointer teleports to numbered targets or grid-cell centres, OS-level synthetic clicks that look exactly like hardware clicks, long gaps between actions, dictation inserting whole phrases at once.

**Evidence:**

- WebAIM (confirmed): Dragon "only analyzes the first 200 links and form controls on the page"; the MouseGrid example is "MouseGrid, 1 [moving the mouse to the upper left corner], 5 [moving the cursor to the center of this area], click." The author calls MouseGrid "a very time consuming process", notes that "A small clickable target, such as a tiny radio button or image, may be very difficult to access with the MouseGrid", and that hover-only menus "may be difficult or impossible to access."
- Nuance Dragon 15 help (confirmed): MouseGrid "divides your screen or active window into nine numbered areas"; "The pointer moves to the area, and Dragon redraws the grid smaller"; selection is by saying "Mark" when "the pointer is positioned over the object"; "MouseGrid Window" confines it to the active window.
- Apple Voice Control (confirmed, "Use Voice Control commands"): "Show numbers"/"Show names" label items; click by saying "Click" plus the name or number; "Show grid" overlays a numbered grid, "To click a location, say 'Click' followed by the grid number"; "When an area can't be subdivided further, saying a number performs the Click command"; drag with "Drag <item> to <location>"; pointer nudges such as "Move cursor right 5 pixels".
- Windows Voice Access (uncertain on specifics): the overview page confirms the product; the "show numbers"/"show grid" command details are on sub-pages not retrieved.

**Signature:** because the OS injects the click, the browser sees a *hardware-class* mouse event (`pointerType "mouse"`, `pressure 0.5`, `sourceCapabilities` present) at a point that is the centre of a numbered element (close to element centre) or the centre of the smallest grid cell (not aligned to the element centre at all), preceded by a pointer jump and followed by seconds of silence while the user speaks the next command.

**Guardrails:** "pointer jump then click, repeated with multi-second gaps" should score *lower* than an agent's fast cadence; dictation ("whole phrase inserted at once") must not be treated as paste-by-agent without pointer-teleport-plus-fast-cadence corroboration.

### 3.4 Switch access and scanning

**Evidence (confirmed, Apple "Use Switch Control"):** item scanning — "Switch Control highlights each item or group as it scans" and the switch selects; point scanning — "a vertical blue line starts to glide across the screen", on switch press "the line stops and a horizontal blue line starts to glide", then "The pointer moves to the intersection of the two blue lines" and with Move & Click "the item located at the intersection of the two blue lines is selected"; high precision adds a slower refinement pass. Android Switch Access (confirmed, Google help): "Switch Access scans the items on your screen, highlighting each item in turn, until you make a selection"; switches can be external devices, keyboards, device buttons or camera switches.

**Signature:** item scanning activates elements through the accessibility API (no pointer at all; see §3.1 `detail 0`/`sourceCapabilities null`); point scanning produces one pointer teleport to an arbitrary intersection followed by a click; cadence is very slow and metronomic (auto-scan interval), which naive "regular timing" detectors can misread as machine regularity.

**Guardrail:** regularity at *multi-second* periods is a human AT pattern; agents are regular at sub-second periods. Make timing-regularity features period-aware.

### 3.5 Eye-gaze and dwell clicking

**Evidence (confirmed, Microsoft "Get started with eye control in Windows"):** supported trackers include Tobii Eye Tracker 4C, Tobii EyeX, Tobii Dynavox PCEye/EyeMobile/I-Series+, EyeTech TM5 Mini; "Gaze Trace enables a bubble which shows how your gaze moves on the screen"; focus follows gaze and selection is by dwell or switch. Dwell details were not on the page (uncertain).

**Signature (reasoning, uncertain):** gaze-driven pointers are saccadic (fast jumps, short fixations, micro-jitter), dwell clicks occur after the pointer has been stationary for ~0.5–2 s. A "mouse holds perfectly still then clicks" rule, or a "pointer jumps" rule, flags these users.

### 3.6 Keyboard-only users, sticky keys, power users

Keyboard-only sessions (Tab/Shift+Tab/Enter/Space, access keys, Vim-style extensions) produce no pointer events; sticky keys produce modifier-key sequences with unusual timing (modifier pressed and released before the key). Firefox RFP additionally "suppresses SHIFT and both ALT key modifier events" (arkenfox notes, confirmed). None of this correlates with automation. Treat "keyboard-only" as a human-common mode (shared with §3.1) and never as negative evidence.

---

## 4. Input hardware and display

### 4.1 Touchscreens and pens (`pointerType`, `pressure`, `width/height`, tilt)

- MDN `PointerEvent.pointerType` (confirmed): `"mouse"`, `"pen"`, `"touch"`, and "If the device type cannot be detected by the browser, the value can be an empty string (`""`)" — screen readers on Firefox/VoiceOver produce `""` (§3.1).
- MDN `PointerEvent.pressure` (confirmed): "For hardware that does not support pressure, such as a mouse, the value is `0.5` when the pointer is active buttons state and `0` otherwise." Pens report continuous 0–1 pressure and tilt; touch contacts report `width/height` > 1. A detector that models "human mouse ⇒ pressure 0.5" will mis-score pen users (pressure varies), hover (pressure 0) and NVDA (pressure 0.5 looks like mouse).
- Firefox RFP spoofs `pointerEvent.pointerid`, `azimuthAngle`/`altitudeAngle` (FF131) and `maxTouchPoints` ("0 = mac, linux | 10 = windows | 5 = mobile" in FF143; FPP collapses multi-touch to 5) — so pointer-capability consistency checks fail for RFP users by design (arkenfox user.js comments, confirmed).

### 4.2 Trackpads and momentum scrolling

- MDN `WheelEvent` (confirmed) exposes only `deltaX`, `deltaY`, `deltaZ`, `deltaMode` (plus legacy `wheelDelta*`). There is **no momentum/inertia phase property** in the web platform, so trackpad inertial scrolling is only visible as long trains of small, geometrically decaying deltas at ~60 Hz (reasoning, uncertain in exact shape; platform/driver dependent).
- FP-Agent (confirmed, §13) found agents scroll in "multiple scroll bursts" or "instantaneous jumps" while humans "scroll longer and with more variability." A trackpad's fling is a *burst that decays*; a mouse-wheel user produces fixed-step deltas (e.g. 100/120 px) in short bursts — i.e. "burstiness" alone cannot separate humans from agents. Use distributional features (scroll distance standard deviation ranked #6 in FP-Agent's feature table) over a window, not single-burst shape.

### 4.3 Browser zoom, HiDPI and fractional coordinates

- MDN `devicePixelRatio` (confirmed): "Page zooming affects the value of `devicePixelRatio`. When a page is zoomed in (made larger), the size of a CSS pixel increases, and so the `devicePixelRatio` value increases. Pinch-zooming does not affect `devicePixelRatio`." A value of 1 is a classic 96 DPI display, 2 is HiDPI/Retina, mobile is "often" > 2.
- Consequence: fractional `clientX/Y` (e.g. NVDA's `173.67`) and sub-pixel `getBoundingClientRect()` values are normal on zoomed or non-integer-DPR displays; integer-only coordinates are normal on DPR 1 unzoomed displays. Neither integer-ness nor fractional-ness is a bot signal. Firefox RFP additionally spoofs DPR (hard-coded 1, then 2 from FF127, then "make spoofed devicePixelRatio and CSS media queries match" FF133).

---

## 5. Remote desktop, VDI, virtual machines, cloud desktops

**What they trip:** software or generic WebGL renderers, tiny `hardwareConcurrency`/`deviceMemory`, limited fonts, cloud/datacenter egress ASN, coarse or bursty pointer sampling, and sometimes 0 ms "teleports" when the remote protocol coalesces mouse moves.

**Evidence:**

- Fingerprint's BotD `webgl.ts` (confirmed) flags **only** `vendor == 'Brian Paul' && renderer == 'Mesa OffScreen'` (the headless-specific Mesa offscreen string) and does nothing for missing WebGL or for SwiftShader. That is a deliberate calibration: SwiftShader/llvmpipe are legitimate on VDI/RDP, with hardware acceleration disabled, on GPU-blocklisted machines and driverless Linux (secondary sources in search agreed, calling it a "weak, low-severity signal").
- Brave 1.93+ returns "a single generic string" for WebGL vendor/renderer for *all* users and empties WebGPU adapter descriptors (confirmed, Brave privacy update #38) — so generic renderer strings are also the entire Brave population.
- Windows 365 (confirmed, Microsoft Learn): a Cloud PC is "a Windows Desktop running in Azure"; with a Microsoft Hosted Network "Microsoft manages the underlying network connectivity", i.e. web egress originates in Microsoft/Azure address space (the page does not state the exact egress ranges — uncertain). AWS WorkSpaces egress similarly comes from AWS ranges (uncertain; not fetched).
- The Vercel BotID incident (§14.3) shows a corporate proxy (Zscaler) was enough to flip a real customer to `"isBot": true` on a login route.
- RDP/Citrix/Chrome Remote Desktop pointer sampling: no primary source quantifies it (uncertain). Reasoning: the remote client forwards pointer positions at the frame/packet cadence of the protocol, so the guest browser sees fewer, larger steps than a local mouse, and under congestion a move can collapse into one jump followed by a click.

**Guardrails:** treat {software renderer, low core count, cloud ASN} as an *environment class* ("VDI-like") that (a) switches behavioural thresholds to tolerate coarse pointer sampling and (b) is logged, but never alone triggers block/challenge. Let site owners allowlist their enterprise egress (Zscaler/Netskope ranges, dedicated WARP egress IPs) in one line.

---

## 6. Window geometry, kiosk mode, background tabs, prerender, bfcache

### 6.1 `outerWidth/outerHeight` and kiosk/fullscreen

BotD `window_size.ts` (confirmed) is a good reference implementation of restraint: it reads only `outerWidth`/`outerHeight`, returns nothing unless the document is focused (code comment: a background tab opened without focus reports a 0×0 outer size, so the guard avoids a false positive), and only returns `HeadlessChrome` when `outerWidth === 0 && outerHeight === 0`. Fullscreen (F11), Chrome `--kiosk`, PWAs, mobile browsers and Safari's advanced protection (which sets `outerWidth/outerHeight` equal to `innerWidth/innerHeight` and `screenX/screenY` to 0 by design — confirmed, WebKit blog) all yield outer == inner; that equality must never be a signal.

### 6.2 Background tabs and timer throttling

Chrome 88+ (confirmed, Chrome developers blog): once-per-second throttling applies to hidden pages; **intensive throttling** (timers checked "once per minute") applies when "The page has been hidden for more than 5 minutes", "The chain count is 5 or greater", "The page has been silent for at least 30 seconds" and "WebRTC is not in use"; `requestAnimationFrame` pauses while hidden. Implication: behavioural clocks (`setInterval` heartbeats, idle timers) drift in background tabs; sessions opened in background tabs show load-then-nothing for minutes. Count idle/dwell only while `document.visibilityState === 'visible'` and use `visibilitychange` transitions as session boundaries.

### 6.3 Prerendering and Speculation Rules

Chrome docs (confirmed): "The `document.prerendering` API will return `true` while the page is prerendering"; when viewed, "the `prerenderingchange` event will be dispatched on the `document`"; `performance.getEntriesByType('navigation')[0].activationStart` is non-zero for a prerendered page; prerendered pages are requested with `Sec-Purpose: prefetch;prerender` and Speculation-Rules prefetches with `Sec-Purpose: prefetch`; Chrome's address bar prerenders at >50% confidence; "Google Analytics, Google Publisher Tag, and Google AdSense delay until activation by default"; cross-origin iframes are not rendered until activation; prerendering is suppressed for Save-Data, Energy Saver, memory pressure, "Preload pages" off and "Pages opened in background tabs." Recommended SDK pattern:

```js
const whenActivated = new Promise((resolve) => {
  if (document.prerendering) {
    document.addEventListener('prerenderingchange', resolve, {once: true});
  } else {
    resolve();
  }
});
```

Edge companion: log `Sec-Purpose` and never count a `prefetch;prerender` request as a human pageview or as bot traffic; it is the browser speculating on behalf of a human.

### 6.4 bfcache

web.dev (confirmed): `pageshow` fires with `event.persisted === true` on a bfcache restore; "browsers pause any pending timers or unresolved promises for pages in bfcache" and resume them on restore; "many popular analytics libraries don't measure bfcache restores as new pageviews." A restored page resumes with stale timers and an instantly "ready" DOM; treat `pageshow.persisted` as a new session segment, not as a suspicious zero-load-time navigation.

---

## 7. Privacy browsers and anti-fingerprinting extensions

### 7.1 Brave

- Farbling (confirmed, Brave privacy update #4 and wiki): values are "deterministically generated using a per-session, per-eTLD+1 seed"; a random session token is created at each browser start, never exposed, mixed with the first-party eTLD+1, and regenerates when Brave restarts; third-party frames share the top-level seed. Affected APIs listed: Canvas (`getImageData`, `measureText`, `isPointInPath`, `isPointInStroke`, `toDataURL`, `toBlob`, `convertToBlob`), WebGL/WebGL2 (`getParameter`, `getExtension`, `getShaderPrecisionFormat`, `readPixels`, `WEBGL_debug_renderer_info` UNMASKED_VENDOR/RENDERER), Web Audio (`AnalyserNode.getFloatFrequencyData` and related, `AudioBuffer.getChannelData`, `copyFromChannel`), `MediaDevices.enumerateDevices`, `NavigatorPlugins.plugins`, `NavigatorID.userAgent`, `XRSystem.isSessionSupported`. Levels: Off; Default ("small enough that it's not noticeable to humans"); Maximum ("randomized values are returned without incorporating any 'true' underlying input").
- `hardwareConcurrency` (confirmed, brave-core browser test): with the default level, if the real value is below `kMinProcessorsForFarbling = 4` it is unchanged, otherwise the fake value is between 4 and the real value; at maximum the test expects a completely fake value (7 in the test). iOS farbling script comment: "Adds a random value between 2 and the original hardware concurrency".
- GPU (confirmed, update #38, Brave 1.93): "Replace the WebGL vendor and renderer strings with a single generic string, ensuring that all Brave users get identical values", "Empty out the WebGPU adapter descriptors", "Inject randomization into the WebGL extension list so that hash-based fingerprinters see a different value per session, per site (eTLD+1) and per storage area."
- Detectability: `navigator.brave.isBrave()` resolves `true` (confirmed in brave-core iOS sources `brave_navigator.ts` / `BraveGetUA.js`; desktop exposes the same API — likely). Brave's UA string mirrors Chrome's with no "Brave" token (likely; widely observed, not quoted from a Brave doc here); UA-CH brands include "Brave" (likely).

**Trap:** any "same device, different canvas/WebGL/audio hash" linkage or "fingerprint changed mid-day" rule fires on every Brave restart. **Guardrail:** when `navigator.brave` exists or farbling is detected (two canvas reads differing within one session cannot happen in Brave — it is per-session-stable — but cross-session instability can), drop fingerprint-stability features from the score and rely on behaviour + network.

### 7.2 Firefox `privacy.resistFingerprinting` (RFP) and Tor Browser

arkenfox user.js comments (confirmed, each citing a Bugzilla number), RFP when enabled:

- UA/OS "spoofed as Windows 10, OS X 10.15, Android 10, or Linux" (JS); HTTP UA header spoofed as Windows 10 or Android 10 until FF136.
- Timezone: originally UTC (Bugzilla 1330890: the app runner sets `TZ=UTC`); since FF128 spoofed as "Atlantic/Reykjavik" (Bugzilla 1835987).
- `navigator.hardwareConcurrency` "as 4 except mac return 8 (FF143)".
- Canvas randomized (FF78; trained eyes spot the "wavy pattern"; earlier FF58+ returned all-white). WebGL "some fingerprinting resistance" and spoofed debug renderer info (FF140).
- Fonts limited to bundled and "Base Fonts" (FF80); system fonts normalized (FF128).
- Keyboard events spoofed, SHIFT and both ALT modifier events suppressed (FF59).
- `pointerEvent.pointerid` spoofed (FF65); `maxTouchPoints` "0 = mac, linux | 10 = windows | 5 = mobile" (FF143; Linux → 5 in FF150).
- `devicePixelRatio` spoofed; `prefers-color-scheme` always "light" (FF67); JS timing precision reduced to 16.67 ms (FF102); refresh rate locked to 60 Hz; `window.screen` and CSS media queries limited (FF41).
- Window sizing: inner window rounds "down in hundreds: width to 200s and height to 100s"; Firefox `StaticPrefList.yaml` (confirmed) defaults `privacy.window.maxInnerWidth` = 1400 and `privacy.window.maxInnerHeight` = 900; letterboxing (`privacy.resistFingerprinting.letterboxing`) "dynamically resizes the inner window by applying margins in stepped ranges" (Tor Browser enables it; Tor's exact step sizes not fetched — likely 200×100 steps per the same rounding).
- Spoof English (`privacy.spoof_english`, default 0): value 2 sets "en-US, en" for pages and "en-US" locale.

Known breakage: the Bugzilla thread on timezone states the problems RFP's UTC time causes with web sites are much higher than the rest of the measures; Mozilla support answers recommend FPP with `JSDateTimeUTC` exempted instead.

**Trap:** an RFP session looks like a machine: UTC/Reykjavik clock, Windows 10 UA on a Mac, 4 cores, 1400×900-ish viewport, light colour scheme, no Shift/Alt key events, generic WebGL, restricted fonts, 16.67 ms timers. **Guardrail:** recognise the RFP *bundle* (several of these together) as "privacy browser" and down-weight; Tor exit IPs can be matched against `https://check.torproject.org/torbulkexitlist` (confirmed live, plain-text list) to apply a shared-egress policy rather than a block.

### 7.3 Firefox Fingerprinting Protection (FPP) — on by default in private windows

`StaticPrefList.yaml` (confirmed): `privacy.fingerprintingProtection` default `false`, `privacy.fingerprintingProtection.pbmode` default `true` ("When the .pbmode pref is on, RFP or FPP will be enabled in PBM"); `privacy.resistFingerprinting` and `.pbmode` default `false`. `RFPTargetsDefault.inc` (confirmed) enables for desktop and Android: `CanvasRandomization`, `EfficientCanvasRandomization`, `FontVisibilityLangPack`, `JSMathFdlibm`, `ScreenAvailToResolution`, `NavigatorHWConcurrencyTiered`, `MaxTouchPointsCollapse`, `IMEStyle`; Nightly adds `WebGLRendererConstant` and `WebGLVendorSanitize`. arkenfox notes: `NavigatorHWConcurrencyTiered` = "less than 8 return 4 else return 8" (FF143+), `MaxTouchPointsCollapse` returns multi-touch as 5, canvas is "subtly randomize[d] per eTLD+1" (FF120+), WebGL `readPixels` subtly randomized (FF145+), screen height returns a fixed per-platform offset when not full screen (FF143+). The full target vocabulary (81 targets in `RFPTargets.inc`, e.g. `JSDateTimeUTC`, `NavigatorUserAgent`, `WindowOuterSize`, `ScreenRect`, `PointerEvents`, `KeyboardEvents`, `ReduceTimerPrecision`) is what remote-settings overrides can toggle.

**Trap:** *every Firefox private window* has a per-site randomized canvas and a 4/8 `hardwareConcurrency`. Canvas-hash drift between Firefox private sessions is not a bot.

### 7.4 Safari (ITP, Advanced Tracking and Fingerprinting Protection, WebKit caps)

- WebKit "Private Browsing 2.0" (confirmed): Safari 17 Private Browsing adds noise to 2D canvas and WebGL painted pixels, "Tiny noise" to Web Audio `AudioBuffer.getChannelData()` (made per-value consistent and normally distributed in 17.5, previously a fixed 0.1%), and fixes screen metrics: `screen.width/height` match `innerWidth/innerHeight`, `screenX/screenY` are (0, 0), `outerWidth/outerHeight` match inner; the same protections can be enabled for "All Browsing" (iOS: Settings > Apps > Safari > Advanced > Advanced Tracking and Fingerprinting Protection; macOS: Safari > Settings > Advanced).
- WebKit `NavigatorBase.cpp` (confirmed): `static int numberOfCores = WTF::numberOfProcessorCores() < 8 ? 4 : 8;` with the comment "Enforce a maximum for the number of cores reported to mitigate fingerprinting for the minority of machines with large numbers of cores"; under script-tracking privacy protection it returns 8 or 4 depending on `OverrideHardwareConcurrency`. So **every Safari/WebKit user reports 4 or 8**, never 2 or 16.

### 7.5 Chrome UA reduction

Chromium UA reduction (confirmed): unified format `Mozilla/5.0 (<unifiedPlatform>) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<majorVersion>.0.0.0 <deviceCompat> Safari/537.36`; frozen platforms `Windows NT 10.0; Win64; x64`, `Macintosh; Intel Mac OS X 10_15_7`, `X11; Linux x86_64`, `X11; CrOS x86_64 14541.0.0`, `Fuchsia`; Android frozen to `Linux; Android 10; K` with `Mobile` only on phones; minor version always `0.0.0`; no reduction for iOS or Android WebView; real values only via UA-CH (`Sec-CH-UA-*`, `navigator.userAgentData.getHighEntropyValues`). Android WebView followed with its own reduced string (confirmed, Android Developers Blog Dec 2024) e.g. `Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/125.000 Mobile Safari/537.36`.

**Trap:** "UA says Windows 10 / macOS 10.15.7 but platform hints say otherwise" is the *normal* state of every Chrome; UA-string ↔ reality mismatch is only meaningful against high-entropy UA-CH or JS-observed facts, and even then collides with Firefox RFP spoofing.

### 7.6 CanvasBlocker and similar extensions

CanvasBlocker README (confirmed): protects Canvas 2D, WebGL, Audio, History, Window (off by default), DOMRect, SVG, TextMetrics, Navigator (off by default), Screen; default block mode "fake" ("a consistent fingerprinting is not possible"); other modes ask for permission / block everything / list-based / allow everything. Whether the fake value changes per read, per domain or per session depends on its RNG settings (not documented on the README page — uncertain). Expect *intra-session* canvas instability from such extensions (unlike Brave, which is stable within a session).

### 7.7 Ad/privacy blockers removing telemetry

EasyPrivacy (confirmed by grepping the live list files): contains rules such as `/botd.gif?`, `||fingerprint.com/events/`, `||fpc.fingerprint.com^`, `||c.fingerprint.com^`, `||fingerprintjs.com/visitors/`, `/fingerprint2.min.js`, `||client.perimeterx.net^`, `||px-cloud.net/b/c/beacon`, `||px-cloud.net/b/s`, `||perimeterx.net/api/v1/collector/`, `||t.castle.io^`, `||m.castle.io/v1/monitor`, `||datadome.maisonsdumonde.com^`, `||datadome00.id.me/tags.js`, `||a.hcaptcha.com^`, `||arkoselabs.com/metrics/`, `/_vercel/insights/script.js`, plus a section titled "Port scanning Fingerprinting Trackers (Privacy and CPU abuse)". uBlock Origin ships EasyPrivacy on by default, so a material share of humans will never deliver vendor-style beacons. Cloudflare's supported-browsers doc (confirmed): ad and content blockers "may stop challenge scripts from loading" and privacy extensions with "fingerprinting protection, or canvas blockers can interfere with the challenge verification"; VPN or proxy extensions "may trigger extra checks."

**Guardrail:** first-party, non-"fingerprint"-named collection endpoints; treat "JS never reported" as *unknown* and fall back to edge-only signals with a conservative policy (label/log, light rate limit) rather than block.

### 7.8 DevTools open

The reference `devtools-detect` README (confirmed) admits "This package has a lot of flaws", "Doesn't work if DevTools is undocked", "will show false positive if you toggle any kind of sidebar", and "the detection now has too many false-positives." Developers, QA staff and curious users are all humans. Do not use DevTools heuristics as bot evidence.

---

## 8. Network look-alikes: proxies, VPNs, relays, cloud egress

### 8.1 iCloud Private Relay

- Apple developer doc (confirmed): the egress list is published at `https://mask-api.icloud.com/egress-ip-ranges.csv`; "The assigned relay IP address may be shared among more than one Private Relay user in the same area"; "the relay IP address will remain stable during a browsing session"; "Consider treating these addresses like larger carrier-grade NAT or enterprise IP addresses"; "All connections that use Private Relay validate that the client is an iPhone, iPad, or Mac and that the customer has a valid iCloud+ subscription"; relay IPs carry "coarse city-level location by default"; Apple recommends Private Access Tokens as the CAPTCHA alternative; uses QUIC/TLS 1.3 on 443.
- Live file (confirmed, fetched 2026-10-24): `text/plain`, 12,047,791 bytes, rows of `CIDR,country,region,city`, e.g. `172.224.226.0/27,GB,GB-EN,London`, `172.224.226.32/31,GB,GB-SC,Aberdeen`, many `/31` IPv4 and `/64` IPv6 rows (`2a02:26f7:b784:4dc7::/64,TW,...`). Team Cymru whois attributes the sampled IPv4 ranges `172.224.226.0/24` and `172.225.28.0/24` to **AS36183 "AKAMAI-AS - Akamai Technologies, Inc."** — i.e. Private Relay users arrive from CDN/datacenter address space and will be classed "hosting" by naive ASN reputation. Partner CDN operation (Cloudflare/Akamai/Fastly) is widely reported but not stated on Apple's page (likely).

### 8.2 Cloudflare WARP / Zero Trust Gateway

Cloudflare docs (confirmed): "traffic that exits through Cloudflare Gateway shares a source IP address with all other Cloudflare One Client users"; the default method "routes traffic through the default source IP range shared across all Zero Trust accounts"; Cloudflare "does not publish One Client egress ranges"; dedicated egress IPs are available per account. Consequence: enterprise and consumer WARP users appear from Cloudflare AS13335. Note the concrete trap in Anubis' default policy (§14.4): `aggressive-asns-without-functional-abuse-contact` adds `+10` weight for ASNs `13335`, `136907`, `45102` — penalising every WARP user.

### 8.3 Zscaler, Netskope, Mullvad, Tor, Google One VPN

- Zscaler (confirmed live): `https://config.zscaler.com/api/zscaler.net/cenr/json` returns ~131 KB of ranges grouped by continent/city with fields `range`, `vpn`, `gre`, `ext`, `hostname`, `latitude`, `longitude` (e.g. `159.254.250.0/23` for "Abu Dhabi II").
- Netskope: publishes tenant-specific egress ranges via its admin console/REST API (uncertain; not fetched).
- Mullvad (confirmed live): `https://api.mullvad.net/www/relays/all/` (~294 KB JSON) with `hostname`, `country_code`, `city_name`, `ipv4_addr_in`, `ipv6_addr_in`, `provider`, `owned`, `active` per relay.
- Tor (confirmed live): `https://check.torproject.org/torbulkexitlist` plain-text exit IPs (~17 KB).
- Google One VPN: reported discontinued in 2024 (uncertain; not verified in this run). Pixel VPN by Google continues (uncertain).
- Vercel/Zscaler incident (confirmed, §14.3): "Zscaler ... acting like a reverse proxy and obscuring signals we rely on for bot protection"; "this is a problem with any reverse proxy or zero trust proxy in front."

### 8.4 Chrome prefetch proxy and other on-behalf-of-user fetchers

The crawler-user-agents list (likely) records the UA `Chrome Privacy Preserving Prefetch Proxy` (used for `/.well-known/traffic-advice` probing); Chrome's doc page returned 404 during this run, so header details (`Sec-Purpose: prefetch;anonymous-client-ip`) are **uncertain**. Prefetches arrive from Google IPs without the user's cookies and are then consumed by a real human — never attribute them as bot sessions.

### 8.5 CGNAT and shared mobile IPs

HN thread (confirmed): users on CGNAT including T-Mobile home internet reported being flagged because of other users' behaviour on the same IP. IP-level reputation must be rate-based and decaying, with higher budgets for known shared-egress classes.

---

## 9. Mobile in-app WebViews and odd user agents

- Android WebView (confirmed, Android Developers Blog): default UA contains `wv` and `Version/4.0`; "sites can continue to look for the wv token in the User-Agent string, unless an application has decided to override the User-Agent string"; apps using `setUserAgentString()` won't send the reduced UA.
- iOS WKWebView: UA lacks the `Safari/` token (the detection regex `(iPhone|iPod|iPad)(?!.*Safari\/)` in the widely used `detect-inapp` library — confirmed from its source; Apple does not document this — likely).
- In-app browser tokens (confirmed from `detect-inapp` source regexes): Facebook family `\bFB[\w_]+\/` (matches `FBAN`/`FBAV`/`FB_IAB` style prefixes), Messenger `\bFB[\w_]+\/(Messenger|MESSENGER)`, `\bInstagram`, `\bLine\/`, `\bMicroMessenger\/` (WeChat), `\bPuffin`, `\bMiuiBrowser\/`, `\bTwitter`.
- Cloudflare (confirmed): "WebViews in mobile applications may have limited functionality compared to full browsers"; in-app browsers often restrict JavaScript; "email preview windows typically cannot complete Interactive Challenges"; WebView failure causes include missing DOM storage or cookie support, blocked access to `challenges.cloudflare.com`, and "a User Agent that changes during the session".

**Trap:** missing `localStorage`, blocked third-party cookies, missing APIs (`navigator.userAgentData` absent), truncated UA, and no window chrome (outer == inner) all co-occur in WebViews. **Guardrail:** detect WebView class first; apply mobile/WebView thresholds; never present visual challenges inside in-app browsers; allow silent degrade/label instead.

---

## 10. Old and low-end devices

- WebKit caps `hardwareConcurrency` at 4 or 8 (§7.4). Firefox FPP tiers to 4/8; RFP to 4 (8 on Mac). Brave farbles ≥4 down toward 4. Chromium reports true counts, but cheap Android phones genuinely have 4–8 small cores and Chromebooks 2–4.
- `navigator.deviceMemory` (confirmed, MDN): "A floating point number coarsened to a power of two value, clamped to implement-defined limits", "rounding the actual memory to the nearest power of 2, then dividing that number by 1024", bounds exist "to protect the privacy of owners of very low-memory or high-memory devices"; secure contexts only; not Baseline (Chromium-only in practice — likely).
- FP-Agent (confirmed) notes Manus reports "Linux x86_64, 4GB RAM, and 6 cores" and ChatGPT Agent "13 CPU cores" and a single font — i.e. agent hardware profiles overlap with real low-end Linux desktops; the paper warns the absence of overlap in its sample "should not be interpreted as evidence that such overlap would not occur in practice."

**Guardrail:** hardware-class values are never scored; they only parameterise expectations (e.g. slower JS timings on 2-core devices should not look like "throttled headless").

---

## 11. Browser features and extensions that mutate events or DOM

### 11.1 Chrome built-in autofill (payment, address, password)

Blink `web_form_control_element.cc` (confirmed):

```cpp
void WebFormControlElement::SetAutofillValue(const WebString& value,
                                             WebAutofillState autofill_state) {
  // The input and change events will be sent in setValue.
  if (IsA<HTMLInputElement>(*private_) || IsA<HTMLTextAreaElement>(*private_)) {
    if (!Focused())
      DispatchFocusEvent();
    // Simulate key events in case the website checks via JS that a keyboard
    // interaction took place.
    Unwrap<Element>()->DispatchScopedEvent(
        *Event::CreateBubble(event_type_names::kKeydown));
    Unwrap<TextControlElement>()->SetAutofillValue(
        value, value.IsEmpty() ? WebAutofillState::kNotFilled : autofill_state);
    Unwrap<Element>()->DispatchScopedEvent(
        *Event::CreateBubble(event_type_names::kKeyup));
    if (!Focused())
      DispatchBlurEvent();
  } ...
```

and `TextControlElement::SetAutofillValue` calls `SetValue(..., TextFieldEventBehavior::kDispatchInputAndChangeEvent, ...)`. So Chrome autofill produces, per field: trusted `focus` → one generic `keydown` (a plain `Event`, not a `KeyboardEvent`: no `key`/`code`) → `input` + `change` with the full value → one generic `keyup` → `blur`, all within the same task, across every field in the form at once. MDN `:autofill` (confirmed): the pseudo-class "matches when an `<input>` element has its value autofilled by the browser" and stops matching once edited; `:-webkit-autofill` is the alias.

**Trap:** "N fields filled in <10 ms with one input event each and no real keystrokes" is precisely Chrome autofill. Agents (Atlas, Comet, ChatGPT Agent) also paste (§13) — but they do it one field at a time, with pointer teleport clicks in between, and no `:autofill` state.

### 11.2 Password managers (Bitwarden, 1Password, LastPass, Dashlane)

Bitwarden `insert-autofill-content.service.ts` (confirmed): per field it calls `element.click()`, `element.focus()`, dispatches `new KeyboardEvent('keydown', {bubbles: true})` and `keyup`, assigns `element.value = value`, dispatches `keydown`/`keyup` again, then `new Event('input', {bubbles: true})` and `change`; checkbox/radio use `element.checked = true`; non-fillable elements get `innerText`; actions are sequenced with `delayActionsInMilliseconds = 20`; the fill animation class `com-bitwarden-browser-animated-fill` is removed after 200 ms. All of these are **`isTrusted === false`** (constructed and `dispatchEvent`ed from a content script) and the `KeyboardEvent`s carry no `key`.

DOM markers (confirmed via GitHub code search across many production codebases): 1Password injects a `<com-1password-button>` custom element and stamps `data-com-onepassword-filled` (values like `"light"`/`"dark"`) on filled inputs; LastPass uses `[data-lastpass-icon-root]` / `[data-lastpass-root]`; Dashlane uses `data-dashlane-rid`, `data-dashlane-classification`, `[data-dashlanecreated]`, `data-dashlane-uid`; Bitwarden's inline menu is commonly matched by `[style$="2147483647 !important;"]` (max z-index) — these selectors appear in `input-otp`, `bits-ui`, Discourse and others precisely to accommodate password managers.

**Trap:** untrusted key events + instant value insertion is the *textbook* "synthetic input" bot pattern, and here it is a human with a password manager. Also note: agents driving via CDP produce *trusted* events, so `isTrusted === false` is a **negative** indicator for sophisticated agents and a **positive** indicator for password managers. **Guardrail:** never score untrusted input events on `type=password`/credential/OTP/address fields; look for the DOM markers above as positive human evidence; whitelist the 20 ms Bitwarden cadence shape.

### 11.3 Form autocomplete, IME composition, dictation

Datalist/autocomplete selections and IME composition end with `input` events carrying `inputType` values like `insertReplacementText`/`insertCompositionText` (web platform behaviour; not separately fetched — likely). Dragon/Voice Control dictation inserts whole phrases (§3.3). All three resemble paste-typing. Feature the *context* (focus path, pointer history, cadence across fields) rather than single-field insertion speed.

### 11.4 Grammarly

Confirmed via GitHub code search of real pages/layouts: Grammarly injects `<grammarly-desktop-integration data-grammarly-shadow-root="true">` with an open declarative shadow root (`<template shadowrootmode="open">`) and stamps `<body data-new-gr-c-s-check-loaded="14.990.0" data-gr-ext-installed="">` (the attribute pair that triggers the well-known React/Next.js hydration-mismatch warnings). Extension-injected shadow roots and body attributes are strong **human-desktop** evidence (agents rarely carry a Grammarly install, though an Atlas/Comet profile could).

### 11.5 Google Translate (Chrome built-in translation)

Martijn Hols' write-up (confirmed): text nodes "are then replaced with `FontElement` elements with the new, translated, strings inside"; "the original `TextNode` is unmounted and replaced with a new `FontElement`". The React issue #11538 (confirmed) documents the resulting `Failed to execute 'removeChild' on 'Node'` crashes and the `translate="no"` / `<meta name="google" content="notranslate">` mitigations. Chrome adds `translated-ltr` / `translated-rtl` classes to `<html>` (confirmed by code search, e.g. LiaScript's `Translate.ts` comment "Google Translate adds 'translated-rtl' or 'translated-ltr' classes to the HTML element"). **Trap:** a MutationObserver-based "DOM tampering / injected script" detector will fire on every translated page; also honeypot text and `data-*` attributes may be re-wrapped. **Guardrail:** ignore mutations inside `<font>` wrappers when `html.translated-*` is present; treat translation as human evidence.

### 11.6 Reader View, text-to-speech, accessibility scanners, 3-D Secure iframes

- Reader View (Firefox `about:reader`, Safari Reader): the page script does not run in the reader document; expect a normal page load followed by zero interaction while the user reads for minutes (reasoning, uncertain in specifics).
- TTS/read-aloud extensions highlight text (DOM mutation) and may auto-scroll in a perfectly linear fashion while the human listens; Google's server-side `Google-Read-Aloud` fetcher is separate (§12). Linear auto-scroll must not be mistaken for agent scrolling without other evidence.
- Accessibility scanners: axe-core runs inside the page from the axe DevTools/Lighthouse context; WAVE injects icon elements and styles (uncertain exact markers). Lighthouse's accessibility audits use axe-core (likely).
- 3-D Secure / payment challenge iframes are cross-origin; while the user types an OTP in the issuer frame the top document sees `document.hasFocus() === false` and no events for tens of seconds. Do not treat focus loss during checkout as abandonment or automation (reasoning).

---

## 12. Wanted bots: tokens, verification, IP lists

All IP endpoints below were fetched live on 2026-10-24 unless marked otherwise; `creationTime` values are from the live files.

### 12.1 Search engines

| Bot | Exact UA token / string (confirmed unless noted) | Verification | IP list | robots.txt |
|---|---|---|---|---|
| Googlebot Smartphone | `Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/W.X.Y.Z Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)` | rDNS `crawl-***-***-***-***.googlebot.com` / `geo-crawl-***.geo.googlebot.com` then forward lookup; or IP JSON | `https://developers.google.com/static/crawling/ipranges/common-crawlers.json` (also served as `/static/search/apis/ipranges/googlebot.json`; `creationTime 2026-10-23T14:45:59`; 21,768 bytes) | obeys |
| Googlebot Desktop | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/W.X.Y.Z Safari/537.36` | same | same | obeys |
| Googlebot-Image / -Video / -News | `Googlebot-Image/1.0`, `Googlebot-Video/1.0`; News has no separate string | same | same | obeys |
| Storebot-Google, Google-InspectionTool, GoogleOther(-Image/-Video), Google-CloudVertexBot | per Google doc, e.g. `Mozilla/5.0 (compatible; Google-InspectionTool/1.0)`, `GoogleOther-Image/1.0` | same | same | obeys |
| Google-Extended | **no UA**; robots.txt control token only | n/a | n/a | token |
| Special-case: AdsBot-Google, AdsBot-Google-Mobile, Mediapartners-Google, APIs-Google, Google-Safety | `AdsBot-Google (+http://www.google.com/adsbot.html)`, `...(compatible; AdsBot-Google-Mobile; +http://www.google.com/mobile/adsbot.html)`, `Mediapartners-Google`, `APIs-Google (+https://developers.google.com/webmasters/APIs-Google.html)`, `Google-Safety` | rDNS `rate-limited-proxy-***-***-***-***.google.com` | `.../special-crawlers.json` (`2026-10-23T14:46:02`) | `*` group ignored; Google-Safety ignores robots entirely |
| User-triggered fetchers: FeedFetcher-Google, GoogleProducer, Google-Read-Aloud, Google-Site-Verification, GoogleMessages, Google-CWS, Google-Pinpoint, Google-GeminiNotebook (formerly Google-NotebookLM) | e.g. `FeedFetcher-Google; (+http://www.google.com/feedfetcher.html)`, `Mozilla/5.0 (compatible; Google-Site-Verification/1.0)`, `GoogleMessages`, browser-style strings containing `compatible; Google-Read-Aloud; +https://support.google.com/webmasters/answer/1061943` | rDNS `***.gae.googleusercontent.com` (Google-owned) or `google-proxy-***.google.com` (user-owned) | `.../user-triggered-fetchers.json` (72,503 bytes), `.../user-triggered-fetchers-google.json` | "generally ignore robots.txt rules" because a user requested the fetch |
| **Google-Agent** | browser-style strings containing `compatible; Google-Agent; +https://developers.google.com/crawling/docs/crawlers-fetchers/google-agent` (mobile Nexus 5X and desktop X11 Linux variants) | IP JSON; Google "is also experimenting with the Web Bot Auth protocol" using the identity `https://agent.bot.goog` | `.../user-triggered-agents.json` (1,413 bytes; `2001:4860:c::/124` etc.) | "used by agents hosted on Google infrastructure to navigate the web and perform actions upon user request"; user-triggered → generally ignores robots.txt |
| Bingbot | `Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)` (likely — Bing's doc page is JS-rendered and could not be read; string from the monperrus list); modern evergreen variants embed `bingbot/2.0` inside a Chrome UA (uncertain) | rDNS `*.search.msn.com` (likely) or IP JSON | `https://www.bing.com/toolbox/bingbot.json` (confirmed live: 28 `ipv4Prefix` entries, `creationTime 2024-01-03T10:00:00.121331`, e.g. `157.55.39.0/24`, `207.46.13.0/24`, `40.77.167.0/24`) | obeys |
| AdIdxBot, BingPreview, MicrosoftPreview | `... (compatible; adidxbot/2.0; +http://www.bing.com/bingbot.htm)`, `BingPreview/1.0b`, `MicrosoftPreview/2.0; +https://aka.ms/MicrosoftPreview` (likely, list instances) | as Bing | as Bing (uncertain whether previews share ranges) | |
| Applebot | `Mozilla/5.0 (Device; OS_version) AppleWebKit/WebKit_version (KHTML, like Gecko) Version/Safari_version Safari/WebKit_version (Applebot/Applebot_version; +http://www.apple.com/go/applebot)`; desktop example ends `Version/17.4 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)`; also seen `Mozilla/5.0 (compatible; Applebot/0.3; +http://www.apple.com/go/applebot)` (likely) | rDNS `*.applebot.apple.com` + forward; or IP JSON | `https://search.developer.apple.com/applebot.json` (confirmed live; `creationTime 2026-09-15`; `17.241.208.160/27` ...) | obeys; follows Googlebot rules if no Applebot group; ignores crawl-delay |
| Applebot-Extended | robots token only, "does not crawl pages" | n/a | n/a | token |
| DuckDuckBot | `DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)`; also `Mozilla/5.0 (compatible; DuckDuckBot-Https/1.1; https://duckduckgo.com/duckduckbot)` (likely) | IP list (hundreds of Azure-hosted /32s, e.g. `104.43.54.127`, `20.191.45.212`) | `https://duckduckgo.com/duckduckbot.json` (confirmed live; `2026-09-01`) | "respects WWW::RobotRules" |
| YandexBot | `Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)` (likely) | rDNS `*.yandex.ru` / `*.yandex.net` / `*.yandex.com` (likely; not verified here) | n/a | obeys |
| Baiduspider | `Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)`, `Baiduspider-render/2.0` (likely) | rDNS `*.baidu.com` / `*.baidu.jp` (likely) | n/a | obeys |
| Qwantify, Kagibot, MojeekBot, SeznamBot, PetalBot, Sogou | instances in the monperrus list (likely), e.g. `Mozilla/5.0 (compatible; Kagibot/1.0; +https://kagi.com/bot)` | vendor pages | n/a | |

Anubis' default `_allow-good.yaml` (confirmed) allowlists "Google, Apple, Bing, DuckDuckGo, Qwant, The Internet Archive, Kagi, Marginalia, Mojeek, and Arquivo.pt" — a reasonable minimal "wanted search" set to mirror.

### 12.2 Link unfurlers and previewers (act on behalf of a human; many ignore robots.txt)

| Service | UA (confirmed from vendor unless noted) | Notes |
|---|---|---|
| Slack | `Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)`, `Slack-ImgProxy 0.19 (+https://api.slack.com/robots)`, `Slackbot 1.0 (+https://api.slack.com/robots)` | "We do not currently honor `robots.txt` files"; no IP list; "fetches only part of the page" |
| Meta | `facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)` and `facebookexternalhit/1.1`; `meta-externalfetcher/1.1`; `meta-externalagent/1.1`; `meta-webindexer/1.1`; `meta-externalads/1.1` | `meta-externalfetcher` "may bypass robots.txt because it fetches pages that users request"; `facebookexternalhit` may bypass for integrity checks; Meta recommends IP allowlisting as "more secure" (ranges via `whois -h whois.radb.net -- '-i origin AS32934'` — likely, not on the fetched page) |
| X / Twitter | `Twitterbot/1.0` (likely; vendor page returned HTTP 402) | card previews |
| LinkedIn | `LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)` (likely; LinkedIn help page has no string) | Post Inspector |
| Discord | `Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)` (likely) | |
| WhatsApp | `WhatsApp/2.x.y A` / `WhatsApp/2.12.15/i` (likely) | fetches from the user's device or Meta infra depending on platform (uncertain) |
| Telegram | `TelegramBot (like TwitterBot)` (likely) | |
| Apple iMessage / Messages link previews | **uncertain**; commonly reported as `facebookexternalhit/1.1 Facebot Twitterbot/1.0` or device-side Safari UA; `Facebot/1.0` appears as a distinct Meta token in lists | verify by experiment |
| Pinterest, Reddit, Skype, Snapchat, Bluesky, Mastodon, Embedly, Iframely, Google Messages | `Mozilla/5.0 (compatible; Pinterestbot/1.0; +http://www.pinterest.com/bot.html)`, `Mozilla/5.0 (compatible; redditbot/1.0; +http://www.reddit.com/feedback)`, `... SkypeUriPreview Preview/0.5`, `Snap URL Preview Service; bot; snapchat; https://developers.snap.com/robots`, `Bluesky/...`, `http.rb/2.2.2 (Mastodon/1.5.1; +https://instance)`, `Mozilla/5.0 (compatible; Embedly/0.2; +http://support.embed.ly/)`, `Iframely/1.3.1 (+https://iframely.com/docs/about)`, `GoogleMessages` (Google: confirmed; others: likely) | Mastodon previews are fetched by **every federated instance**, producing bursts of identical fetches from many IPs seconds after a post — not a scraper |
| Email/link proxies | `YahooMailProxy; https://help.yahoo.com/kb/yahoo-mail-proxy-SLN28749.html`, `... (via ggpht.com GoogleImageProxy)` (likely) | image proxies for humans reading mail |

Cloudflare's legacy verified-bot categories include "Page Preview", "Feed Fetcher", "Webhooks", "Monitoring & Analytics", "Accessibility" (confirmed) — use the same vocabulary.

### 12.3 Uptime, synthetic and performance monitors

| Service | UA (confirmed unless noted) | IP list | Extra |
|---|---|---|---|
| Checkly | API/multistep: `Checkly/1.0 (https://www.checklyhq.com)`; browser checks (Playwright): `Checkly, https://www.checklyhq.com`; recommended Playwright `userAgent: "(Checkly, https://www.checklyhq.com)"` or `${devices['Desktop Chrome'].userAgent} (Checkly, https://www.checklyhq.com)`; allowlist on `Checkly/<UUID>` | `https://api.checklyhq.com/v1/static-ips` (confirmed live JSON array), `/static-ips.txt`, `/static-ips-by-region`, `/static-ipv6s`, `/static-ipv6s.txt`, `/static-ipv6s-by-region`; "We update this list very infrequently (6 months or less)" | optional `Cookie: "checkly-account:<UUID>"`; "Checkly is also registered with CloudFlare as a verified bot" |
| Datadog Synthetics | API tests: `Datadog/Synthetics`; browser tests: varies, "always ends with `DatadogSynthetics`" (observed: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.7204.168 Safari/537.36 DatadogSynthetics`) | `https://ip-ranges.datadoghq.com/synthetics.json` (confirmed live; `version 63`, `modified 2026-08-12`; `prefixes_ipv4`, e.g. `3.1.36.99/32`) | header `sec-datadog: Request sent by a Datadog Synthetics API Test ... test_id: <ID>` (Browser Test variant); `x-datadog-origin: synthetics` |
| Pingdom | keyword `pingdom` in UA; classic `Mozilla/5.0 (compatible; Pingdom.com_bot_version_1.4_(http://www.pingdom.com/))` (likely); transaction and page-speed checks "use a real Chrome browser" and run from AWS | `https://my.pingdom.com/probes/ipv4` (confirmed live, plain text), `/probes/ipv6`, RSS `https://my.pingdom.com/probes/feed` | |
| UptimeRobot | `Mozilla/5.0+(compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)` (likely; help page omits it) | `https://cdn.uptimerobot.com/api/IPv4.txt` (confirmed live), `IPv4andIPv6.txt`, JSON `https://api.uptimerobot.com/meta/ips` | checks from "randomly selected servers (IPs)" in one region, re-verified from others |
| Others (likely, list instances) | `StatusCake_Uptime_Checker/1.0`, `Site24x7`, `Better Uptime Bot Mozilla/5.0 ... Chrome/74...`, `BetterUptimeBot`, `Uptime-Kuma/1.23.x`, `HetrixTools Uptime Monitoring Bot. https://hetrix.tools/uptime-monitoring-bot.html`, `FreshpingBot/1.0 (+https://freshping.io/)`, `cron-job.org monitor`, `EasyCron/1.0 (https://www.easycron.com/)`, `GTmetrix` suffix on a Chrome UA | vendor pages | |

### 12.4 Lighthouse / PageSpeed Insights (important correction)

- Lighthouse changelog (confirmed): v10 entry "[BREAKING] emulation: bump chrome UA to m109 and drop LH identifier (#14384)"; PR #14384 merged 2023-01-26 with the body "Sorry for the inconvenience folks. But we had to make this change due to some developers who prioritize gaming over user experience."
- Current `core/config/constants.js` (confirmed): mobile UA `Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36`, desktop `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36`; screen emulation mobile 412×823 @1.75 (`mobile: true`), desktop 1350×940 @1; default form factor mobile. Only old fixtures still contain `Chrome-Lighthouse` (e.g. `Chrome/74.0.3694.0 Safari/537.36 Chrome-Lighthouse` in the monperrus list).
- chrome-launcher default flags (confirmed) include `--disable-extensions`, `--disable-background-timer-throttling`, `--disable-renderer-backgrounding`, `--mute-audio`, `--password-store=basic`, `--use-mock-keychain`, `--disable-ipc-flooding-protection`; `--enable-automation` is **not** in the list, but CLI/CI runs are usually headless (so `navigator.webdriver` is true there — likely).
- PSI egress IPs are not documented (uncertain). Guardrail: give site owners a bypass token for performance tooling and treat moto g power/136 + 412×823 + no extensions as "Lighthouse-like" label, not block.

### 12.5 SEO crawlers, prerender services, site-owner tooling

- Screaming Frog (confirmed, user guide): uses "its own 'Screaming Frog SEO Spider' user-agent string" (observed `Screaming Frog SEO Spider/5.1` — likely format `Screaming Frog SEO Spider/<version>`), ships presets for Googlebot, Bingbot and browsers (so it can look like Googlebot — verify with rDNS!), defaults to "Respect robots.txt" with options to ignore; JavaScript rendering mode uses an embedded headless Chromium (likely; section not retrieved).
- Prerender.io (confirmed via code search of real integrations): `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/W.X.Y.Z Safari/537.36 Prerender (+https://github.com/prerender/prerender)`.
- Rendertron (confirmed, `renderer.ts`): no identifying token; mobile UA override `Mozilla/5.0 (Linux; Android 8.0.0; Pixel 2 XL Build/OPD1.170816.004) ...`; injects `customElements.forcePolyfill = true`, `ShadyDOM = {force: true}`, `ShadyCSS = {shimcssproperties: true}` on every document — a distinctive in-page artefact of a wanted renderer.
- Site owner's own Playwright/Puppeteer tests: Playwright's current Chromium switches (confirmed, `chromiumSwitches.ts`) include `--disable-field-trial-config`, `--disable-background-networking`, `--disable-background-timer-throttling`, `--disable-backgrounding-occluded-windows`, `--disable-back-forward-cache`, `--disable-breakpad`, `--disable-component-extensions-with-background-pages`, `--disable-component-update`, `--no-default-browser-check`, `--disable-default-apps`, `--disable-dev-shm-usage`, `--disable-extensions`, `--allow-pre-commit-input`, `--disable-hang-monitor`, `--disable-ipc-flooding-protection`, `--disable-popup-blocking`, `--disable-prompt-on-repost`, `--disable-renderer-backgrounding`, `--force-color-profile=srgb`, `--metrics-recording-only`, `--no-first-run`, `--password-store=basic`, `--use-mock-keychain`, `--no-service-autorun`, `--enable-unsafe-swiftshader`, `--disable-infobars`, `--disable-sync` (note: `--enable-automation` is no longer in the list). CI runs are therefore "agent-identical" by construction; provide an explicit bypass (secret header/cookie, or Checkly-style UA suffix + IP allowlist) and document it in the SDK README.
- Ads quality bots: `AdsBot-Google`, `AdsBot-Google-Mobile`, `Mediapartners-Google` (Google), `OAI-AdsBot/1.0; +https://openai.com/adsbot` with `https://openai.com/adsbot.json` (OpenAI, confirmed), `SnapchatAds/1.0` (likely). Blocking these breaks the owner's own ad campaigns.
- Security scanners (likely, list instances): `Mozilla/5.0 (compatible; Nessus; http://www.nessus.org)`, `Mozilla/5.0 (compatible; Qualys; +https://www.qualys.com/)`, `Mozilla/5.0 (compatible; CensysInspect/1.1; +https://about.censys.io/)`, `Mozilla/5.0 zgrab/0.x`, Palo Alto `Expanse` text. Owner-commissioned scanners should be allowlisted by IP; third-party internet scanners are policy decisions, not AI agents.
- Feed readers (likely): `Feedly/1.0 (+http://www.feedly.com/fetcher.html; like FeedFetcher-Google)`, `Mozilla/5.0 (compatible; inoreader.com; 1 subscribers)`, `NewsBlur Feed Fetcher - 1 subscriber - ...`. See the RSS incident in §14.2.

### 12.6 AI user-triggered fetchers (in scope for the firewall, but must not be conflated with training crawlers)

| Fetcher | Exact UA (confirmed) | IP list | robots.txt per vendor |
|---|---|---|---|
| ChatGPT-User | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot` | `https://openai.com/chatgpt-user.json` (live; `2026-10-20T17:07:39`) | "Because these actions are initiated by a user, robots.txt rules may not apply" |
| OAI-SearchBot | contains `compatible; OAI-SearchBot/1.4; +https://openai.com/searchbot` | `https://openai.com/searchbot.json` (live; `2026-01-02`) | obeys; ~24 h propagation |
| GPTBot | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.4; +https://openai.com/gptbot` | `https://openai.com/gptbot.json` (live; `2026-09-22`) | obeys; robots.txt fetches may carry an extra `robots.txt` marker in the UA |
| Perplexity-User | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)` | `https://www.perplexity.com/perplexity-user.json` | "this fetcher generally ignores robots.txt rules" |
| PerplexityBot | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)` | `https://www.perplexity.com/perplexitybot.json` | obeys |
| Claude-User / ClaudeBot / Claude-SearchBot | tokens confirmed by Anthropic; observed strings `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)` and `Claude-User (claude-code/2.1.86; +https://support.anthropic.com/)` (likely) | `https://claude.com/crawling/bots.json` (confirmed URL) | honours robots.txt incl. `Crawl-delay` |
| Meta-ExternalFetcher | `meta-externalfetcher/1.1` | Meta IP ranges | may bypass robots.txt (user-requested) |
| Google-Agent | see §12.1 | `user-triggered-agents.json` | generally ignores robots.txt |

None of these are "false positives" per se — they are the firewall's subject matter — but they are the *server-side* half of an agent. The client-side SDK never sees them; the edge companion must verify them by IP list and must not confuse them with the *browser-side* agents (Atlas, Comet, Claude in Chrome) that arrive from the user's own device.

### 12.7 Verification standards to build on

- **Web Bot Auth** (confirmed, Cloudflare blog + docs; IETF `draft-meunier-web-bot-auth-architecture`, `draft-meunier-http-message-signatures-directory`, RFC 9421): request headers `Signature-Input` (components `"@authority" "signature-agent"`, params `created`, `expires`, `keyid` = JWK thumbprint, `tag="web-bot-auth"`, `alg="ed25519"`), `Signature` (`sig=...`), `Signature-Agent` (quoted `https://` URL of the key directory); directory at `/.well-known/http-message-signatures-directory` served as `application/http-message-signatures-directory+json` over HTTPS; "Cloudflare supports Ed25519"; "A minute is often sufficient" for `expires`; "there is currently no nonce validation". OpenAI "signs all Operator requests"; Google experiments with identity `https://agent.bot.goog`; Cloudflare: "Signed agents are now Verified" and it "is experimenting with forwarding information about the end user" via the RFC 7239 `Forwarded` header.
- **Cloudflare Verified Bots policy** (confirmed): honest self-identification (Web Bot Auth, or published IP list with stable UA, or rDNS), robots.txt and crawl-directive compliance, reasonable rates; behaviour taxonomy (BotBase): Search, Agent, Training, Transact, Data Collection, Security Testing, SEO, Ads Verification, Social / Link Preview, Feed Fetching, Monitoring & Operations; operator labels Direct vs Intermediary; legacy categories "Academic Research", "Accessibility", "Advertising & Marketing", "Aggregator", "AI Assistant", "AI Crawler", "AI Search", "Archiver", "Feed Fetcher", "Monitoring & Analytics", "Page Preview", "Search Engine Crawler", "Search Engine Optimization", "Security", "Social Media Marketing", "Webhooks", "Other".
- **Private Access Tokens / Apple Automatic Verification** (confirmed, Apple support + Cloudflare troubleshooting): "An Apple server validates your device and Apple Account", a third-party issuer mints a token and "the only information given to the app or website" is that token; on by default when signed into an Apple Account; Cloudflare notes a `401` on a PAT request "is expected and does not mean the visitor was blocked." Use PATs as the first, frictionless, non-visual human proof for Apple clients.

---

## 13. AI browsers with a human present (non-agent mode)

- **ChatGPT Atlas** (confirmed, Simon Willison): UA `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36`, "identical to the user-agent I get for the latest Google Chrome on macOS." MIT AI Agent Index: "Atlas currently identifies itself with a Chrome-like user agent string"; agent mode "Cannot run code in the browser", cannot access saved passwords or autofill, can run in "logged out mode" with no pre-existing cookies. Secondary reports (HUMAN, unreadable here due to 403) claim favicon fetches with a `ChatGPT Atlas` CFNetwork UA (uncertain) and one SEO blog claims Atlas identifies as `ChatGPT-User` (conflicts with the above; uncertain). OpenAI's bots page (confirmed) does not mention Atlas at all.
- **Perplexity Comet** (likely, secondary): HTTP UA may include a `Comet` token while `navigator.userAgent`/`userAgentData` look like Chrome; Comet's internal extension "leaves DOM-level artifacts during agentic actions" (HUMAN, via search summary — uncertain specifics).
- **Claude in Chrome** (confirmed, Anthropic help): "a browser extension that allows Claude to read, click, and navigate websites alongside you", uses the `debugger` permission to control the browser (clicking, typing, screenshots), `scripting` to read text, opens tabs in a coloured group; no documented self-identification to websites; human-in-the-loop approvals; 1Password integration where "Claude never sees your password or one-time code."
- **Gemini in Chrome / Edge Copilot mode**: no primary documentation found on how (or whether) they identify to sites (uncertain). Google's *cloud-hosted* agents use `Google-Agent` (§12.1); local Gemini-in-Chrome actions presumably present as the user's Chrome (uncertain).
- **FP-Agent (arXiv 2605.01247, confirmed):** studied Atlas, ChatGPT Agent, Claude for Chrome, Comet, Manus, Browser Use, Skyvern vs 56 undergraduates. Findings: Atlas, Browser Use and Claude "share fingerprints"; agents "directly teleport to the click location"; Atlas, Comet and ChatGPT Agent *paste* text, Claude "fills fields programmatically by default", Browser Use/Skyvern/Manus type with mean inter-key latency 5.31 / 9.52 / 1.39 ms vs humans 120.43 ms (Claude 0.56 ms); scrolling in "multiple scroll bursts" (Atlas, Browser Use, Claude, Comet, ChatGPT Agent) or "instantaneous jumps" (Skyvern, Manus); behavioural classifiers plateau after ~3 minutes (combined ~1 minute); Cloudflare's free bot management blocked only Manus; **limitations:** "a relatively narrow population of internet users: undergraduate students", browser-fingerprint classifier overfits, behavioural performance "drops substantially on unseen tasks", no evaluation of humans using these browsers in assistant mode, assistive technology or unusual configurations, and no false-positive rate reported.
- **Prosopo (confirmed):** an agentic browser "fails every classic automation test, and it is also a real customer with a real card"; "It is real Chromium on real hardware"; CDP-driven input can carry `isTrusted=true`, "indistinguishable from a hand on a mouse"; advice: "Block the behaviour you cannot absorb, not the client type", "Treat a declared agent string as a courtesy", require a human only at risky steps (limited inventory checkout, bulk export, account changes), and make every block name its signal.

**Guardrails:** never key policy on browser brand; score agent mode per session using the behavioural cluster (teleport clicks + paste or sub-10 ms typing + burst scrolling + machine cadence) and keep "assistant summarised the page" (one load, maybe a programmatic scroll, no form interaction) in the human bucket; honour Web Bot Auth when present; apply per-flow human checks rather than site-wide blocks; attribute (label/log) by default.

---

## 14. Public false-positive incidents and what they cost

### 14.1 Cloudflare challenge loops (HN, April 2023, "Tell HN: Cloudflare verification is breaking the internet")
Fedora 37 + Firefox 110 stuck in an endless "Verify you are a human" loop while Chrome worked; others: custom Firefox cookie settings, small Chromium forks ("basically unusable now"), Chrome on iPad (Safari worked), curl/RSS readers/API clients blocked (one user had to send Chrome's UA to reach an API), OpenBSD 6.0 TLS failures, Tor and corporate VPN CAPTCHA failures ("I get CAPTCHA fails from my work's corporate network"), CGNAT/T-Mobile users flagged for neighbours' behaviour, "I left it 'checking' for hours once". Affected sites named: science journals, ChatGPT, an egg seller, Google search via Tor, a doctor's patient portal, government sites, Stack Overflow (corporate VPN blocked half the time), banking/payment sites, RSS feeds. The OP's forum post was auto-closed with no replies; the eventual fix was unclear (clearing cookies after resetting `general.useragent.override`). Cloudflare's own supported-browsers doc now lists ad blockers, fingerprinting/canvas-blocker extensions, VPN extensions, DevTools overrides, mobile emulation and WebViews as known problems, and the troubleshooting page lists network issues, extensions, unsupported browsers, disabled JavaScript, VPN/proxy interference and "Detection errors: If Turnstile suspects bot-like behavior, you may encounter repeated challenges."

### 14.2 Cloudflare blocking RSS readers (Open RSS)
Bot Fight Mode and the "AI scrapers and crawlers" block "end up blocking users who access your website through RSS readers"; the human-verification challenge "requires a human to solve and, because an RSS reader is not a human, it can never complete them"; sometimes Cloudflare "will simply block the RSS reader from accessing your website without a reason"; site owners are "likely blocking these RSS users ... without realizing it"; the bot-verification program "isn't guaranteed to work". Cloudflare's docs (confirmed) also state Bot Fight Mode and Super Bot Fight Mode "may challenge API or mobile app traffic", "Cannot be customized, adjusted, or reconfigured via WAF custom rules", and "You cannot bypass or skip Bot Fight Mode using WAF custom rules or Page Rules"; Browser Integrity Check "challenges visitors without a user agent or with a non-standard user agent" and is on by default.

### 14.3 Vercel BotID (Kasada) blocks a paying customer behind Zscaler (Sep 2025)
Production login route with Deep Analysis; a customer in Dublin on Chrome 139/Windows got `"isBot": true, "isHuman": false`; Vercel staff: the customer was using Zscaler, "acting like a reverse proxy and obscuring signals we rely on for bot protection ... this is a problem with any reverse proxy or zero trust proxy in front"; recommended fixes: a firewall bypass by the user's IP, ASN or user agent (not hostname-wide) or a code-level feature flag by email; longer term "detecting VPN usage so that Zscaler users are not blocked." A separate project reported BotID challenging "every unfamiliar fingerprint" with "Failed to verify your browser", blocking signups and QA with private-browsing and VPN users (anecdotal).

### 14.4 Anubis (proof-of-work anti-scraper)
- Duke University Libraries pilot (LWN, confirmed): Anubis "blocked more than 4 million unwanted HTTP requests per day", but "12 people reported having a problem with Anubis in one week ... usually due to having cookies disabled"; the default challenge UI is "not ideal".
- LWN did not deploy it in part because it "would rather not block users who turn off JavaScript"; the no-JS `metarefresh` challenge arrived in 1.20.0 but is "currently off by default, as it is still considered somewhat experimental"; difficulty 4 "takes a few seconds", difficulty 6 "can take minutes"; the algorithm "is designed to waste time and memory" (slow devices suffer).
- Default policy (confirmed, `botPolicies.yaml`): `generic-browser` rule `user_agent_regex: Mozilla|Opera` → `WEIGH +10` (i.e. *every browser* starts suspicious and must pass the challenge); `countries-with-aggressive-scrapers` +10 for `BR` and `CN`; `aggressive-asns-without-functional-abuse-contact` +10 for ASNs `13335`, `136907`, `45102` (Cloudflare WARP users included); a `generic-bot-catchall` rule is shipped commented out because it "has a high false-positive rate"; `x-firefox-ai.yaml` challenges Firefox AI previews.
- Reported accessibility issues (secondary): screen readers announce "Making sure you're not a bot" with a percentage and no alternative path; Gentoo users on NoScript and on slow hardware were locked out (forum requires login; unverified quotes).
- Our own fetch of `https://anubis.techaro.lol/docs/` returned "Access Denied: error code ... Protected by Anubis From Techaro", version `v1.28.2-0.20261022214545-d535b9ba5661`.

### 14.5 Vendor self-reported numbers (for calibration targets)
DataDome claims a false-positive rate "below 0.01%" and that "out of 10,000 DataDome CAPTCHAs served, less than one is seen by a human", while noting "there's no strict, industry-standard definition of a false positive" (secondary; DataDome's page returned 403 to this fetcher). Fingerprint's BotD open-source README makes no FP claims and marks browser-automation detection as "partial". Akamai's false-positive guidance is behind a login wall (no data). Kasada publishes none.

### 14.6 Collateral damage observed during this research
Plain HTTPS fetches (no JS) of `humansecurity.com/ai-agent/*`, `datadome.co/bot-management-protection/crawlers-list/`, `datadome.co/learning-center/...`, `community.cloudflare.com/...`, `help.openai.com/.../release-notes` and Anubis' docs returned 403/"Access Denied"; StackOverflow is blocked at the tool level. Documentation pages — the very pages a site owner needs to configure allowlists — were unreachable to a non-browser reader. Design our block pages to always return a machine-readable reason and a `robots.txt`/docs carve-out (Anubis' `keep-internet-working.yaml` does exactly this for `/.well-known`, `favicon.ico` and `robots.txt`).

---

## 15. Recommended guardrails and calibration (implementation checklist)

1. **Four signal families, two required.** Families: (a) behavioural (pointer/keys/scroll/timing), (b) environment (fingerprint consistency, automation artefacts), (c) network/transport (ASN class, shared-egress lists, TLS/HTTP shape at the edge), (d) declared identity (UA tokens, Web Bot Auth, PATs, owner bypass tokens). No block, challenge, decoy or tarpit unless at least two families agree; environment alone may only *label*.
2. **Environment-class pre-classifier runs first** and rewrites thresholds: `privacy-browser` (Brave `navigator.brave`, RFP bundle, Safari advanced protection tells, CanvasBlocker instability), `vdi-like` (software renderer + ≤4 cores + cloud ASN), `webview` (`wv`, missing `Safari/`, `FB*`/`Instagram` tokens, missing storage), `mobile`, `hidden/prerender` (`document.prerendering`, `visibilityState`), `at-possible` (see 3). Each class has its own behavioural baselines and its own FP budget on the dashboard.
3. **AT-possible class** = any of: zero pointer activity with keyboard/focus activity; clicks with `detail === 0` and `sourceCapabilities === null`; `focus` preceding `pointerdown` on activation; `pointerType === ""` clicks; sub-2 ms press durations at element centres with multi-second gaps; scanning-period regularity (≥ 1 s period). Policy for this class: never visual CAPTCHA; prefer PAT / invisible verification / allow-with-rate-limit; log for review.
4. **Behavioural timing features must be visibility-aware:** start clocks at `prerenderingchange`/first `visible`, pause on `hidden`, reset on `pageshow.persisted`, and remember Chrome's 1 s / 1 min throttling tiers when judging heartbeat gaps.
5. **Typing features:** model *paste* (one `input` with `inputType insertFromPaste`/large delta) separately from *autofill* (`:autofill` matches, generic trusted `keydown`/`keyup` around a value set, all fields at once) and *password-manager fill* (untrusted `KeyboardEvent`s without `key`, 20 ms per-field cadence, `data-com-onepassword-filled`, `com-1password-button`, `data-lastpass-icon-root`, `data-dashlane-rid`). Only agent-style paste *plus* pointer teleport *plus* machine cadence counts.
6. **Fingerprint-consistency features are suspended for `privacy-browser` sessions** (Brave per-session seeds, Firefox FPP in private windows, Safari noise, CanvasBlocker). Do not treat two differing canvas reads as evasion in those classes.
7. **Network policy:** maintain and refresh (hourly/daily) the shared-egress lists — Private Relay CSV, Tor exit list, Zscaler JSON, Mullvad relays, dedicated-egress IPs supplied by site owners — and raise per-IP budgets for them; never block on hosting/VPN ASN alone; expose "allow my corporate egress" as a one-line config.
8. **Wanted-bot pipeline at the edge:** UA token → verify (rDNS double lookup or IP JSON/CSV with TTL ≤ 24 h, IPv4 *and* IPv6; Web Bot Auth signature where offered; PAT) → category (Search, Agent, Training, Social/Link Preview, Feed Fetching, Monitoring & Operations, Ads Verification, Security Testing, SEO, Webhooks, Accessibility) → owner policy per category. Unverified tokens are "claimed-<token>" and get the default policy for unknown automation, not the wanted-bot policy. Keep `/.well-known/*`, `robots.txt`, `favicon.ico`, sitemaps and docs paths always reachable.
9. **Owner's own automation:** ship a documented bypass (e.g. `X-NECTER-Bypass: <secret>` header or cookie, Checkly-style UA suffix + IP list) and detect Lighthouse-like, Prerender/Rendertron, Checkly/Datadog/Pingdom browser tests as "owner tooling" labels.
10. **Human-present AI browsers:** attribute (label) by brand when detectable, never block by brand; classify agent mode per session; per-flow step-up only on risky actions.
11. **Action ladder:** log/label → degrade (non-essential features) → invisible verification (PAT, managed challenge) → accessible challenge (with audio/text alternative, no proof-of-work heavier than a few hundred ms on a low-end phone) → block. Block pages state the signal, offer an appeal, and are cache-safe.
12. **Measurement:** launch every detector in monitor mode; track challenge-pass rate, bypass-rule usage, appeal volume and per-segment positive rates (browser × OS × network class × AT-possible × WebView); set an explicit FP budget (DataDome's marketing figure of <0.01% is the bar the market quotes); re-validate behavioural models on a diverse human panel (FP-Agent's cohort was undergraduates), including screen-reader, voice-control, switch, trackpad, pen and VDI users.

---

## 16. Unknowns and experiments to run

- Exact event shape of VoiceOver (iOS/macOS) and TalkBack activations in current Safari/Chrome builds (`detail`, `sourceCapabilities`, presence of `pointerdown/up`, coordinates) — measure.
- Dragon Professional and Windows Voice Access: whether "click <name>" clicks the element centre or the accessibility bounding-box centre; dictation `input` event shape (`inputType`) — measure.
- RDP / Citrix / Chrome Remote Desktop pointer sampling rates and jump statistics — measure on real sessions.
- Trackpad momentum delta sequences across macOS/Windows/Linux and Chrome/Firefox/Safari — collect distributions.
- iMessage/Apple Messages link-preview UA and IP origin; WhatsApp preview origin (device vs server).
- Modern Bingbot evergreen UA strings and whether BingPreview/MicrosoftPreview share `bingbot.json` ranges.
- Whether ChatGPT Atlas agent mode adds any header, UA-CH brand or signature; whether Comet's HTTP UA token is stable; Gemini in Chrome and Edge Copilot mode identification.
- PageSpeed Insights egress IP ranges; whether PSI still differs from CLI Lighthouse in any header.
- Netskope published ranges; Google One VPN status; AWS WorkSpaces/Windows 365 egress range documentation.
- Chrome private prefetch proxy request headers (doc page 404'd).
- Akamai/Kasada/HUMAN false-positive handling (login-walled or blocked documentation).
- WAVE/axe DOM markers; Safari Reader and Firefox Reader View script behaviour with our SDK.
- Brave desktop `navigator.brave.isBrave()` presence and UA-CH `Brave` brand (only iOS source was read).

---

## 17. Sources

Assistive technology
- https://github.com/adobe/react-spectrum/issues/10310 — NVDA/JAWS/UIA click measurements
- https://vispero.com/resources/event-handling-in-jaws-and-nvda/ — Vispero event-handling article (index only retrievable)
- https://tink.uk/the-difference-between-keyboard-and-screen-reader-navigation/
- https://webaim.org/projects/screenreadersurvey10/
- https://webaim.org/blog/at-experiment-dragon/
- https://www.nuance.com/products/help/dragon15/dragon-for-pc/enx/dpg-cp/Content/CommandandControl/using_your_mouse_with_mousegrid.htm
- https://support.apple.com/guide/mac-help/use-voice-control-commands-mh40719/mac
- https://support.microsoft.com/en-us/topic/use-voice-access-to-control-your-pc-author-text-with-your-voice-4dcd23ee-f1b9-4fd1-bacc-862ab611f55d
- https://support.apple.com/guide/mac-help/use-switch-control-mh43607/mac
- https://support.google.com/accessibility/android/answer/6122836
- https://support.microsoft.com/en-us/windows/get-started-with-eye-control-in-windows-1a170a20-1083-2452-8f42-17a7d4fe89a9
- https://developer.mozilla.org/en-US/docs/Web/API/Event/isTrusted
- https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/events/simulated_event_util.cc
- https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/dom/events/event_dispatcher.cc
- https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/accessibility/ax_object.cc
- https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/html/html_element.cc
- https://github.com/WebKit/WebKit/blob/main/Source/WebCore/dom/SimulatedClick.cpp
- https://github.com/WebKit/WebKit/blob/main/Source/WebCore/dom/Element.cpp
- https://github.com/WebKit/WebKit/blob/main/Source/WebCore/accessibility/AccessibilityObject.cpp

Input, display, geometry, lifecycle
- https://developer.mozilla.org/en-US/docs/Web/API/PointerEvent/pointerType
- https://developer.mozilla.org/en-US/docs/Web/API/PointerEvent/pressure
- https://developer.mozilla.org/en-US/docs/Web/API/WheelEvent
- https://developer.mozilla.org/en-US/docs/Web/API/Window/devicePixelRatio
- https://developer.mozilla.org/en-US/docs/Web/API/Navigator/deviceMemory
- https://github.com/fingerprintjs/BotD/blob/main/src/detectors/window_size.ts
- https://github.com/fingerprintjs/BotD/blob/main/src/detectors/webgl.ts
- https://github.com/fingerprintjs/BotD/blob/main/src/detectors/index.ts
- https://github.com/fingerprintjs/BotD/blob/main/README.md
- https://developer.chrome.com/docs/web-platform/prerender-pages
- https://web.dev/articles/bfcache
- https://developer.chrome.com/blog/timer-throttling-in-chrome-88

Privacy browsers and extensions
- https://brave.com/privacy-updates/4-fingerprinting-defenses-2.0/
- https://brave.com/privacy-updates/38-webgl-webgpu-fingerprinting-protections/
- https://github.com/brave/brave-browser/wiki/Fingerprinting-Protections
- https://github.com/brave/brave-core/blob/master/browser/farbling/brave_navigator_hardwareconcurrency_farbling_browsertest.cc
- https://github.com/brave/brave-core/blob/master/ios/browser/web/navigator/resources/brave_navigator.ts
- https://github.com/arkenfox/user.js/blob/master/user.js (section 4500 RFP notes)
- https://github.com/arkenfox/user.js/wiki/3.3-Overrides-%5BTo-RFP-or-Not%5D
- https://bugzilla.mozilla.org/show_bug.cgi?id=1330890 ; https://bugzilla.mozilla.org/show_bug.cgi?id=1581236
- https://github.com/mozilla-firefox/firefox/blob/main/toolkit/components/resistfingerprinting/RFPTargets.inc
- https://github.com/mozilla-firefox/firefox/blob/main/toolkit/components/resistfingerprinting/RFPTargetsDefault.inc
- https://github.com/mozilla-firefox/firefox/blob/main/modules/libpref/init/StaticPrefList.yaml
- https://webkit.org/blog/15697/private-browsing-2-0/
- https://github.com/WebKit/WebKit/blob/main/Source/WebCore/page/NavigatorBase.cpp
- https://www.chromium.org/updates/ua-reduction/
- https://android-developers.googleblog.com/2024/12/user-agent-reduction-on-android-webview.html
- https://github.com/kkapsner/CanvasBlocker/blob/master/README.md
- https://github.com/easylist/easylist/tree/master/easyprivacy (easyprivacy_specific.txt, easyprivacy_general.txt, easyprivacy_thirdparty.txt)
- https://github.com/sindresorhus/devtools-detect/blob/main/readme.md
- https://check.torproject.org/torbulkexitlist

Network look-alikes
- https://developer.apple.com/support/prepare-your-network-for-icloud-private-relay/
- https://mask-api.icloud.com/egress-ip-ranges.csv
- https://support.apple.com/en-us/102591 — Automatic Verification / Private Access Tokens
- https://developers.cloudflare.com/cloudflare-one/policies/gateway/egress-policies/
- https://config.zscaler.com/api/zscaler.net/cenr/json
- https://api.mullvad.net/www/relays/all/
- https://learn.microsoft.com/en-us/windows-365/enterprise/requirements-network
- https://community.vercel.com/t/botid-false-positive-what-now/21694
- https://vercel.com/docs/botid

WebViews and in-app browsers
- https://github.com/f2etw/detect-inapp/blob/master/src/inapp.js
- https://developers.cloudflare.com/cloudflare-challenges/reference/supported-browsers/
- https://developers.cloudflare.com/cloudflare-challenges/troubleshooting/challenge-solve-issues/

Autofill, password managers, extensions
- https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/exported/web_form_control_element.cc
- https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/html/forms/text_control_element.cc
- https://developer.mozilla.org/en-US/docs/Web/CSS/:autofill
- https://github.com/bitwarden/clients/blob/main/apps/browser/src/autofill/services/insert-autofill-content.service.ts
- GitHub code search results for `data-com-onepassword-filled`, `com-1password-button`, `data-lastpass-icon-root`, `data-dashlane-rid`, `grammarly-desktop-integration`, `data-new-gr-c-s-check-loaded`, `translated-ltr` (e.g. discourse/discourse, guilhermerodz/input-otp, huntabyte/bits-ui, LiaScript/LiaScript)
- https://martijnhols.nl/blog/everything-about-google-translate-crashing-react
- https://github.com/facebook/react/issues/11538

Wanted bots
- https://developers.google.com/search/docs/crawling-indexing/verifying-googlebot
- https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers
- https://developers.google.com/search/docs/crawling-indexing/google-special-case-crawlers
- https://developers.google.com/crawling/docs/crawlers-fetchers/google-user-triggered-fetchers
- https://developers.google.com/crawling/docs/crawlers-fetchers/google-agent
- https://developers.google.com/static/crawling/ipranges/common-crawlers.json ; .../special-crawlers.json ; .../user-triggered-fetchers.json ; .../user-triggered-fetchers-google.json ; .../user-triggered-agents.json
- https://www.bing.com/webmasters/help/which-crawlers-does-bing-use-8c184ec0 (JS-rendered; not readable) ; https://www.bing.com/toolbox/bingbot.json
- https://support.apple.com/en-us/119829 ; https://search.developer.apple.com/applebot.json
- https://duckduckgo.com/duckduckgo-help-pages/results/duckduckbot/ ; https://duckduckgo.com/duckduckbot.json
- https://api.slack.com/robots
- https://developers.facebook.com/docs/sharing/webmasters/web-crawlers
- https://github.com/monperrus/crawler-user-agents/blob/master/crawler-user-agents.json (secondary list with observed instances)
- https://www.checklyhq.com/docs/monitoring/allowlisting ; https://api.checklyhq.com/v1/static-ips
- https://docs.datadoghq.com/synthetics/guide/identify_synthetics_bots/ ; https://ip-ranges.datadoghq.com/synthetics.json
- https://documentation.solarwinds.com/en/success_center/pingdom/content/topics/pingdom-probe-servers-ip-addresses.htm ; https://documentation.solarwinds.com/en/success_center/pingdom/content/topics/google-analytics-and-pingdom.htm ; https://my.pingdom.com/probes/ipv4
- https://uptimerobot.com/help/locations/ ; https://cdn.uptimerobot.com/api/IPv4.txt
- https://github.com/GoogleChrome/lighthouse/blob/main/core/config/constants.js ; https://github.com/GoogleChrome/lighthouse/blob/main/changelog.md ; https://github.com/GoogleChrome/lighthouse/pull/14384
- https://github.com/GoogleChrome/chrome-launcher/blob/main/src/flags.ts
- https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/chromium/chromiumSwitches.ts
- https://www.screamingfrog.co.uk/seo-spider/user-guide/configuration/
- https://github.com/GoogleChrome/rendertron/blob/main/src/renderer.ts
- https://developers.openai.com/api/docs/bots ; https://openai.com/searchbot.json ; https://openai.com/chatgpt-user.json ; https://openai.com/gptbot.json
- https://docs.perplexity.ai/guides/bots
- https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler
- https://blog.cloudflare.com/web-bot-auth/
- https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/
- https://developers.cloudflare.com/bots/concepts/bot/verified-bots/policy/

AI browsers with a human present
- https://simonwillison.net/2025/Oct/21/introducing-chatgpt-atlas/
- https://aiagentindex.mit.edu/2025/chatgpt-atlas
- https://support.claude.com/en/articles/12012173-getting-started-with-claude-in-chrome
- https://arxiv.org/html/2605.01247v1 — FP-Agent: Fingerprinting AI Browsing Agents
- https://prosopo.io/blog/agentic-browsers/
- https://www.humansecurity.com/ai-agent/chatgpt-atlas/ ; https://www.humansecurity.com/ai-agent/perplexity-comet/ (403 to this fetcher; summarised from search results)

Incidents
- https://news.ycombinator.com/item?id=35742606
- https://openrss.org/blog/using-cloudflare-on-your-website-could-be-blocking-rss-users
- https://developers.cloudflare.com/bots/get-started/bot-fight-mode/
- https://developers.cloudflare.com/waf/tools/browser-integrity-check/
- https://lwn.net/Articles/1028558/
- https://github.com/TecharoHQ/anubis/blob/main/data/botPolicies.yaml
- https://anubis.techaro.lol/docs/ (returned "Access Denied ... Protected by Anubis")
- https://datadome.co/learning-center/bot-solution-provider-false-positives/ (403 to this fetcher; figures from search summary)
- https://docs.datadome.co/docs/device-check
