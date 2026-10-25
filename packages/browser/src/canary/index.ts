/**
 * canary module: semantic canaries (detection-spec.md §5).
 *
 * Per page view a token `${session.id}.${12 url-safe chars}` is issued and used by:
 * - a hidden nofollow link to `${endpoint}/canary/<token>` (clicks here; fetches on the server);
 * - a hidden honeypot field `website_url_confirm` in every form (`config.canary.forms`);
 * - a hidden, benign instruction block (`config.canary.instructions`) whose text is
 *   watched through the harvest instrumentation (`registerSensitiveNode`).
 *
 * Hits are deterministic agent proofs (`canary.hidden-link-followed`,
 * `canary.hidden-field-filled`, `canary.instruction-followed`) or strong evidence
 * (`canary.hidden-text-selected`). Each hit also emits a `canary` session event so the
 * server can match it with the issued token.
 *
 * Research basis: interventions.md §8.1 (frontier agents refuse/mention in-band
 * instructions, small-model agents follow them 40–75%; a11y agents see off-screen
 * fields and may fill them; the fetch channel catches DOM-reading automation),
 * §7.3 (per-session inert tokens), false-positive-traps.md §11 (autofill and
 * password-manager shapes), §3 (AT users have no pointer path: the instruction
 * rule therefore requires the hidden text to have been read first).
 *
 * Documented limits: the gateway page is server-rendered without the SDK, so
 * "navigated to the gateway within 30 s" cannot be observed there; instead we
 * detect the click on a visible gateway link preceded by zero pointer path and
 * zero keyboard navigation *after* the instruction text was read by non-trusted
 * code, and we leave a sessionStorage marker (`__necter_canary`) for a future
 * SDK-enabled gateway. Programmatic navigation (`page.goto(gateway)`) is only
 * visible to the server (same session id, gateway path, within 30 s).
 */

import type { Module, ModuleContext } from '../types.js';
import { installInstrumentation, quiet, registerSensitiveNode, type SensitiveReadInfo } from '../harvest/instrument.js';
import type { StackClass } from '../harvest/stack.js';
import {
  CANARY_FIELD_NAME,
  createGatewayLink,
  createHiddenField,
  createHiddenLink,
  createInstructionBlock,
  isGatewayLink,
  isGatewayUrl,
  makeToken,
  pageIsRtl,
  type HiddenField,
} from './dom.js';

export { CANARY_FIELD_NAME, CANARY_LINK_TEXT, GATEWAY_LINK_LABEL, instructionText, isGatewayUrl, makeToken, pageIsRtl } from './dom.js';

/** `config.modules.canary` options. */
export interface CanaryModuleOptions {
  /** Render a small visible "Agent access" link when the page has none (default false). */
  renderGatewayLink?: boolean;
  /**
   * Watch reads of the hidden instruction text through the shared harvest hooks.
   * Default: on unless the harvest module is disabled (then the canary still works,
   * minus `canary.hidden-text-selected` from foreign reads; copy/selection still count).
   */
  textReads?: boolean;
}

type HitKind = 'link' | 'field' | 'instruction' | 'text-selection';

/** Pointer moves within this many ms before a click count as "a pointer path". */
const PATH_WINDOW_MS = 3000;
/** Keyboard activity within this many ms before a click counts as keyboard navigation. */
const KEY_WINDOW_MS = 3000;
const SELECTION_THROTTLE_MS = 500;
export const SESSION_STORAGE_KEY = '__necter_canary';

export function createCanaryModule(): Module {
  const cleanups: (() => void)[] = [];

  return {
    name: 'canary',
    start(ctx: ModuleContext) {
      if (typeof window === 'undefined' || typeof document === 'undefined') return;
      if (!ctx.config.canary.enabled) return;
      const opts = ctx.options;
      const token = makeToken(ctx.session.id);
      const base = ctx.config.canary.path ?? `${ctx.config.endpoint}/canary/`;
      const href = base.replace(/\/?$/, '/') + token;
      const gatewayUrl = ctx.config.text.gatewayUrl;

      // Optional coupling: share the prototype hooks with the harvest module (ref-counted)
      // unless the integrator disabled harvest; then nothing is wrapped on our behalf.
      const harvestDisabled = (ctx.config.modules as Record<string, unknown> | undefined)?.['harvest'] === false;
      const watchTextReads = opts['textReads'] === true || (opts['textReads'] !== false && !harvestDisabled);
      if (watchTextReads) {
        try {
          cleanups.push(installInstrumentation({ trustedScriptOrigins: ctx.config.trustedScriptOrigins ?? [] }));
        } catch {
          /* hooks unavailable: the other canaries still work */
        }
      }

      const perfNow = (): number => {
        try {
          return performance.now();
        } catch {
          return Date.now();
        }
      };

      // ── state ──
      const moves: number[] = []; // ring of recent pointermove timestamps
      let lastKeyTs = -Infinity;
      let keydowns = 0;
      let link: HTMLAnchorElement | undefined;
      let instruction: { block: HTMLDivElement; span: HTMLSpanElement; text: string } | undefined;
      const fields = new Set<HTMLInputElement>();
      const fieldWrappers = new Set<HTMLDivElement>();
      let gatewayLinkRendered: HTMLAnchorElement | undefined;
      let instructionRead: { ts: number; cls: StackClass; direct: boolean; api: string } | undefined;
      let lastGatewayClick = -Infinity;
      let textSelectedReliability = 0;
      const hitsSeen = new Set<HitKind>();
      const recentMoves = (): number => {
        const t = perfNow();
        let n = 0;
        for (let i = moves.length - 1; i >= 0; i--) {
          if (t - moves[i]! <= PATH_WINDOW_MS) n++;
          else break;
        }
        return n;
      };
      const recentKeys = (): boolean => perfNow() - lastKeyTs <= KEY_WINDOW_MS;

      // ── emission ──
      interface HitOptions {
        reliability?: number;
        /** Override weight (non-deterministic downgrade). */
        automation?: number;
        details?: Record<string, unknown>;
        value?: unknown;
      }
      const hit = (kind: HitKind, id: string, summary: string, o: HitOptions = {}): void => {
        const first = !hitsSeen.has(kind);
        hitsSeen.add(kind);
        if (first || kind === 'text-selection') {
          ctx.event({ type: 'canary', data: { token, kind, detail: { signal: id, summary, ...(o.details ?? {}) } } });
        }
        ctx.emit({
          id,
          summary,
          ...(o.value !== undefined ? { value: o.value } : {}),
          ...(o.reliability !== undefined ? { reliability: o.reliability } : {}),
          ...(o.automation !== undefined ? { automation: o.automation } : {}),
          details: { token, kind, ...(o.details ?? {}) },
        });
        const deterministic = o.automation === undefined && (o.reliability ?? 1) >= 0.9 && kind !== 'text-selection';
        if (deterministic) ctx.finalize(`canary:${kind}`);
      };
      const pathDescription = (ev: Event): string => {
        const n = recentMoves();
        return `isTrusted=${ev.isTrusted}, ${n} pointer move${n === 1 ? '' : 's'} in the last ${PATH_WINDOW_MS / 1000} s, ${recentKeys() ? 'recent keyboard activity' : 'no keyboard activity'}`;
      };

      // ── hidden text reads (via the harvest hooks) ──
      const onSensitiveRead = (info: SensitiveReadInfo): void => {
        const cls = info.stack.cls;
        if (cls === 'trusted') return;
        // Reads that count as "the agent read the instruction": evaluated code without a
        // script URL. Third-party scripts with a URL (session replay such as rrweb/Clarity/
        // Hotjar serialises every text node; translators; analytics) never count, even when
        // they read the canary node directly.
        const foreign = cls === 'anonymous' || cls === 'automation' || cls === 'none';
        if (foreign) {
          if (!instructionRead || (cls !== 'none' && instructionRead.cls === 'none')) {
            instructionRead = { ts: perfNow(), cls, direct: info.direct, api: info.api };
          }
        }
        let reliability: number;
        if (cls === 'anonymous' || cls === 'automation') reliability = info.direct ? 1 : 0.9;
        else if (cls === 'none') reliability = info.direct ? 0.6 : 0.5;
        else if (cls === 'extension') reliability = info.direct ? 0.4 : 0.3;
        else reliability = 0.2; // third-party page script (session replay, translators, analytics)
        if (reliability <= textSelectedReliability) return;
        textSelectedReliability = reliability;
        const target = info.target as Element;
        const where = info.direct ? 'the hidden instruction node itself' : `an ancestor (${(target && (target.nodeName || '')).toLowerCase() || 'node'})`;
        hit('text-selection', 'canary.hidden-text-selected', `hidden canary text read via ${info.api} on ${where} from ${cls} code${info.stack.sample ? ` (${info.stack.sample})` : ''}`, {
          reliability,
          details: { api: info.api, direct: info.direct, stackClass: cls, ...(info.stack.sample ? { frame: info.stack.sample } : {}), ...(info.stack.origins.length ? { origins: info.stack.origins } : {}) },
        });
      };

      // ── DOM injection ──
      const injectForms = (): void => {
        if (!ctx.config.canary.forms) return;
        try {
          quiet(() => {
            const forms = document.forms;
            for (let i = 0; i < forms.length; i++) {
              const form = forms[i]!;
              if (form.hasAttribute('data-necter-no-canary')) continue;
              if (form.querySelector(`input[name="${CANARY_FIELD_NAME}"]`)) continue;
              const f: HiddenField = createHiddenField(rtl);
              form.appendChild(f.wrapper);
              fields.add(f.input);
              fieldWrappers.add(f.wrapper);
            }
          });
        } catch {
          /* ignore */
        }
      };

      let injected = false;
      let rtl = false;
      const inject = (): void => {
        if (injected) return;
        const body = document.body;
        if (!body) return;
        injected = true;
        try {
          quiet(() => {
            rtl = pageIsRtl(document);
            link = createHiddenLink(href, rtl);
            body.appendChild(link);
            if (ctx.config.canary.instructions) {
              instruction = createInstructionBlock(token, rtl);
              body.appendChild(instruction.block);
              if (watchTextReads) cleanups.push(registerSensitiveNode(instruction.block, onSensitiveRead));
              if (opts['renderGatewayLink'] === true) {
                let existing = false;
                const anchors = document.getElementsByTagName('a');
                for (let i = 0; i < anchors.length && !existing; i++) {
                  if (isGatewayLink(anchors[i]!, gatewayUrl)) existing = true;
                }
                if (!existing) {
                  gatewayLinkRendered = createGatewayLink(gatewayUrl);
                  body.appendChild(gatewayLinkRendered);
                }
              }
            }
          });
        } catch (err) {
          ctx.log('canary injection failed', err);
        }
        try {
          sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ token, ts: Date.now(), url: location.href, gateway: gatewayUrl }));
        } catch {
          /* storage may be unavailable */
        }
        ctx.event({
          type: 'canary',
          data: {
            token,
            kind: 'other',
            detail: { phase: 'issued', link: href, instruction: !!instruction, forms: ctx.config.canary.forms },
          },
        });
        // Forms: idle (they may still be streaming in) plus a mutation watch for SPA forms.
        cleanups.push(ctx.schedule.idle(injectForms, 1500));
        try {
          if (ctx.config.canary.forms && typeof MutationObserver === 'function') {
            let pending: (() => void) | undefined;
            const mo = new MutationObserver((records) => {
              let formsChanged = false;
              for (const r of records) {
                for (let i = 0; i < r.addedNodes.length && !formsChanged; i++) {
                  const n = r.addedNodes[i] as Element;
                  if (n.nodeType !== 1) continue;
                  if (n.nodeName === 'FORM' || (typeof n.querySelector === 'function' && n.querySelector('form'))) formsChanged = true;
                }
                if (formsChanged) break;
              }
              if (!formsChanged || pending) return;
              pending = ctx.schedule.timeout(() => {
                pending = undefined;
                injectForms();
              }, 200);
            });
            mo.observe(body, { childList: true, subtree: true });
            cleanups.push(() => mo.disconnect());
            cleanups.push(() => pending?.());
          }
        } catch {
          /* ignore */
        }
      };

      if (document.body) inject();
      else {
        const onReady = (): void => inject();
        document.addEventListener('DOMContentLoaded', onReady, { once: true });
        cleanups.push(() => document.removeEventListener('DOMContentLoaded', onReady));
      }

      // ── listeners (capture phase, passive where allowed; never preventDefault) ──
      const add = <K extends keyof WindowEventMap>(target: Window | Document, type: K | string, fn: (ev: Event) => void, passive = true): void => {
        const opt: AddEventListenerOptions = { capture: true, passive };
        target.addEventListener(type, fn, opt);
        cleanups.push(() => target.removeEventListener(type, fn, { capture: true }));
      };

      // One clock for everything (Event.timeStamp semantics differ across engines/jsdom).
      add(window, 'pointermove', () => {
        moves.push(perfNow());
        if (moves.length > 32) moves.shift();
      });
      add(window, 'keydown', () => {
        keydowns++;
        lastKeyTs = perfNow();
      });

      const onActivate = (ev: Event): void => {
        try {
          const target = ev.target as Node | null;
          if (!target) return;
          if (link && (target === link || link.contains(target))) {
            hit('link', 'canary.hidden-link-followed', `hidden canary link activated by ${ev.type} (${pathDescription(ev)})`, {
              value: href,
              details: { event: ev.type, isTrusted: ev.isTrusted, pointerMoves: recentMoves(), keydowns },
            });
            return;
          }
          const el = target.nodeType === 1 ? (target as Element) : target.parentElement;
          const a = el && typeof el.closest === 'function' ? (el.closest('a[href]') as HTMLAnchorElement | null) : null;
          if (!a || a === link) return;
          if (!isGatewayLink(a, gatewayUrl)) return;
          onGatewayClick(ev);
        } catch {
          /* ignore */
        }
      };
      add(window, 'click', onActivate);
      add(window, 'auxclick', onActivate);

      const onGatewayClick = (ev: Event): void => {
        lastGatewayClick = perfNow();
        if (!instruction || !instructionRead) return; // without the read, a gateway click is a human reading the footer
        const elapsed = (perfNow() - instructionRead.ts) / 1000;
        if (elapsed > 30) return;
        const n = recentMoves();
        const keys = recentKeys();
        const common = { elapsedS: Math.round(elapsed * 10) / 10, pointerMoves: n, keyboard: keys, isTrusted: ev.isTrusted, readBy: instructionRead.cls, readApi: instructionRead.api, direct: instructionRead.direct };
        if (n === 0 && !keys) {
          hit('instruction', 'canary.instruction-followed', `gateway link opened ${common.elapsedS} s after the hidden instruction was read via ${instructionRead.api} from ${instructionRead.cls} code, with no pointer path and no keyboard navigation (isTrusted=${ev.isTrusted})`, {
            details: common,
          });
        } else {
          hit('instruction', 'canary.instruction-followed', `gateway link opened ${common.elapsedS} s after the hidden instruction was read from ${instructionRead.cls} code (${n} pointer moves, ${keys ? 'keyboard used' : 'no keyboard'})`, {
            automation: 2.0,
            details: common,
          });
        }
      };

      // Programmatic navigation to the gateway (`location.href = ...` from evaluated code) after the
      // instruction was read, without a click on a visible gateway link. Navigation API (Chromium);
      // browser-initiated navigations (CDP Page.navigate, address bar) do not fire it: server-side only.
      try {
        const nav = (window as unknown as { navigation?: EventTarget }).navigation;
        if (nav && typeof nav.addEventListener === 'function') {
          add(nav as unknown as Window, 'navigate', (ev) => {
            try {
              const url = (ev as Event & { destination?: { url?: string } }).destination?.url;
              if (!url || !instruction || !instructionRead) return;
              if (!isGatewayUrl(url, gatewayUrl)) return;
              if (perfNow() - lastGatewayClick < 1000) return; // a visible-link click already handled it
              const elapsed = (perfNow() - instructionRead.ts) / 1000;
              if (elapsed > 30) return;
              const elapsedS = Math.round(elapsed * 10) / 10;
              hit('instruction', 'canary.instruction-followed', `script navigated to the gateway ${elapsedS} s after the hidden instruction was read via ${instructionRead.api} from ${instructionRead.cls} code, without a link click`, {
                details: { elapsedS, via: 'navigate', readBy: instructionRead.cls, readApi: instructionRead.api, direct: instructionRead.direct, pointerMoves: recentMoves(), keyboard: recentKeys() },
              });
            } catch {
              /* ignore */
            }
          });
        }
      } catch {
        /* Navigation API unavailable */
      }

      // Hidden field: any input/change, or a non-empty value at submit.
      const onFieldInput = (ev: Event): void => {
        try {
          const input = ev.target as HTMLInputElement | null;
          if (!input || !fields.has(input)) return;
          fieldHit(input, ev, ev.type);
        } catch {
          /* ignore */
        }
      };
      add(document, 'input', onFieldInput);
      add(document, 'change', onFieldInput);
      add(
        document,
        'submit',
        (ev) => {
          try {
            const form = ev.target as HTMLFormElement | null;
            if (!form || typeof form.querySelector !== 'function') return;
            const input = form.querySelector(`input[name="${CANARY_FIELD_NAME}"]`) as HTMLInputElement | null;
            if (!input || !fields.has(input)) return;
            if (input.value) fieldHit(input, ev, 'submit');
            else {
              // Keep GET/POST payloads clean: an empty honeypot is not serialised.
              input.disabled = true;
              ctx.schedule.timeout(() => {
                input.disabled = false;
              }, 0);
            }
          } catch {
            /* ignore */
          }
        },
        false,
      );

      const fieldHit = (input: HTMLInputElement, ev: Event, source: string): void => {
        const value = input.value ?? '';
        let autofilled = false;
        try {
          autofilled = input.matches(':autofill') || input.matches(':-webkit-autofill');
        } catch {
          /* selector unsupported */
        }
        if (autofilled) {
          // Browser autofill is a person; clear the value so the server honeypot stays quiet.
          ctx.log('canary field autofilled by the browser; ignored');
          try {
            input.value = '';
          } catch {
            /* ignore */
          }
          return;
        }
        const focused = document.activeElement === input;
        const inputType = (ev as InputEvent).inputType;
        const shape = `${inputType ?? source}, isTrusted=${ev.isTrusted}, ${focused ? 'focused' : 'unfocused'}`;
        const details = { source, inputType: inputType ?? null, isTrusted: ev.isTrusted, focused, length: value.length, pointerMoves: recentMoves(), keydowns };
        if (source !== 'submit' && ev.isTrusted && !focused && inputType === undefined) {
          // Trusted value insertion into an unfocused field with no inputType: the autofill shape
          // (false-positive-traps.md §11.1) on a browser without :autofill support. Downgrade.
          hit('field', 'canary.hidden-field-filled', `hidden field "${CANARY_FIELD_NAME}" received ${value.length} chars while unfocused (${shape}); possible browser autofill`, {
            automation: 3,
            reliability: 0.6,
            details,
          });
          return;
        }
        hit('field', 'canary.hidden-field-filled', `hidden field "${CANARY_FIELD_NAME}" received ${value.length} chars (${shape})`, { details });
      };

      // Copy / selection containing the canary text.
      const selectionHasCanary = (): string | undefined => {
        try {
          const sel = window.getSelection?.();
          if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return undefined;
          const roots: Node[] = [];
          if (instruction) roots.push(instruction.block);
          if (link) roots.push(link);
          let touches = false;
          for (const r of roots) {
            if (sel.containsNode(r, true)) {
              touches = true;
              break;
            }
          }
          if (!touches) return undefined;
          const text = quiet(() => sel.toString());
          if (text.includes(token)) return 'token';
          if (instruction && text.includes(instruction.text)) return 'instruction';
          return undefined;
        } catch {
          return undefined;
        }
      };
      add(document, 'copy', (ev) => {
        const what = selectionHasCanary();
        if (!what) return;
        if (textSelectedReliability >= 1) return;
        textSelectedReliability = 1;
        hit('text-selection', 'canary.hidden-text-selected', `copy event with a selection containing the hidden canary ${what} (isTrusted=${ev.isTrusted})`, {
          reliability: 1,
          details: { via: 'copy', what, isTrusted: ev.isTrusted },
        });
      });
      let lastSelCheck = -Infinity;
      add(document, 'selectionchange', () => {
        const t = perfNow();
        if (t - lastSelCheck < SELECTION_THROTTLE_MS) return;
        lastSelCheck = t;
        const what = selectionHasCanary();
        if (!what || textSelectedReliability >= 0.8) return;
        textSelectedReliability = 0.8;
        hit('text-selection', 'canary.hidden-text-selected', `selection contains the hidden canary ${what} (user-select:none text cannot be selected by a person)`, {
          reliability: 0.8,
          details: { via: 'selectionchange', what },
        });
      });

      // Expose the token for tests/debug without a global: via the module context log.
      ctx.log('canary issued', token);

      cleanups.push(() => {
        try {
          link?.remove();
          instruction?.block.remove();
          gatewayLinkRendered?.remove();
          for (const w of fieldWrappers) w.remove();
          fields.clear();
          fieldWrappers.clear();
        } catch {
          /* ignore */
        }
      });
    },
    stop() {
      for (const c of cleanups.splice(0).reverse()) {
        try {
          c();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
