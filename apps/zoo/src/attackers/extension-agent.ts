import { chromium, type BrowserContext } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Attacker, AttackerContext, AttackerResult } from '../lib/types.js';

const here = dirname(fileURLToPath(import.meta.url));
export const EXTENSION_DIR = join(here, '../../extension');

async function launchWithExtension(headless: boolean, profile: string, ip: string): Promise<BrowserContext> {
  // Playwright supports MV3 extensions headless only through the `chromium` channel (new headless).
  return chromium.launchPersistentContext(profile, {
    headless,
    ...(headless ? { channel: 'chromium' as const } : {}),
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
    extraHTTPHeaders: { 'x-forwarded-for': ip },
    viewport: null,
  });
}

async function extensionId(context: BrowserContext): Promise<string> {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  return new URL(worker.url()).host;
}

async function drive(ctx: AttackerContext): Promise<AttackerResult> {
  const startedAt = Date.now();
  const notes: string[] = [];
  const profile = mkdtempSync(join(tmpdir(), 'zoo-ext-'));
  let context: BrowserContext | undefined;
  let sid: string | undefined;
  try {
    try {
      context = await launchWithExtension(!ctx.headed, profile, ctx.ip);
    } catch (err) {
      if (!ctx.headed) return { startedAt, finishedAt: Date.now(), skipped: `headless extension launch failed (${String(err).split('\n')[0]}); run with --headed` };
      throw err;
    }
    let id: string;
    try {
      id = await extensionId(context);
    } catch (err) {
      if (!ctx.headed) return { startedAt, finishedAt: Date.now(), skipped: `extension service worker did not start headless (${String(err).split('\n')[0]}); run with --headed` };
      throw err;
    }
    notes.push(`extension id ${id}; headless=${!ctx.headed}`);
    const control = await context.newPage();
    await control.goto(`chrome-extension://${id}/options.html?base=${encodeURIComponent(ctx.base)}&run=1&task=shop`);
    await control.waitForFunction(() => document.title === 'done' || document.title.startsWith('error'), undefined, { timeout: 150_000 });
    const title = await control.title();
    const statusText = await control.locator('#status').textContent();
    if (title.startsWith('error')) notes.push(title);
    try {
      const st = JSON.parse(statusText ?? '{}') as { steps?: string[]; sid?: string | null; error?: string | null };
      notes.push(...(st.steps ?? []).slice(0, 30));
      if (st.sid) sid = st.sid;
      if (st.error) notes.push('error: ' + st.error);
    } catch {
      notes.push('status: ' + (statusText ?? '').slice(0, 300));
    }
    if (!sid) sid = (await context.cookies(ctx.base)).find((c) => c.name === '__necter_sid')?.value;
    if (title.startsWith('error') && /debugger_attach_error/.test(title)) {
      notes.push('chrome.debugger.attach failed while Playwright held its own CDP session on the tab');
    }
  } catch (err) {
    notes.push('error: ' + String(err));
  } finally {
    await context?.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
  return { startedAt, finishedAt: Date.now(), notes, ...(sid ? { sessionIds: [sid] } : {}) };
}

export const extensionAgentSim: Attacker = {
  name: 'extension-agent-sim',
  description:
    'Unpacked MV3 extension (apps/zoo/extension) driving a tab through chrome.debugger exactly like Claude in Chrome / the Playwright Extension: Page.enable + focus emulation, Runtime.evaluate reads (read_page), one Input.dispatchMouseEvent mouseMoved then mousePressed/Released with force 0.5 (~5 ms), per-char Input.dispatchKeyEvent 3 ms apart, trusted mouseWheel scrolls, form_input-style untrusted value set, 1.5-3.5 s think time; Chromium launchPersistentContext --load-extension (headless via the chromium channel, headed with --headed where the infobar also appears).',
  expected: { actorClass: 'extension-agent', automated: true },
  // Launch artefacts of the Playwright-started Chromium; a real extension agent lives in the user's own headed
  // Chrome. CDP probes stay in: real extension agents drive tabs through chrome.debugger.
  harnessArtifacts: ['declared.headless-ua', 'env.webdriver', 'env.default-automation-viewport', 'env.chromium-build', 'env.no-google-voices', 'tie.no-js-execution'],
  run: drive,
};
