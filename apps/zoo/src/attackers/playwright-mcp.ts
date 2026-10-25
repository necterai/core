import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Attacker, AttackerContext, AttackerResult } from '../lib/types.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Where an installed @playwright/mcp could live inside this workspace (we never install it ourselves). */
export function findPlaywrightMcp(): { kind: 'bin' | 'pkg'; path: string } | undefined {
  const roots = [join(here, '../..'), join(here, '../../../..')];
  for (const root of roots) {
    const bin = join(root, 'node_modules/.bin/playwright-mcp');
    if (existsSync(bin)) return { kind: 'bin', path: bin };
    const pkg = join(root, 'node_modules/@playwright/mcp/cli.js');
    if (existsSync(pkg)) return { kind: 'pkg', path: pkg };
  }
  return undefined;
}

export const PLAYWRIGHT_MCP_SKIP = 'needs @playwright/mcp';

/** Minimal JSON-RPC-over-stdio MCP client (newline-delimited JSON, protocol 2025-06-18). */
class McpStdio {
  private id = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buf = '';
  constructor(private child: ChildProcess) {
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
          if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message));
            else p.resolve(msg.result);
          }
        } catch {
          /* non-JSON noise on stdout */
        }
      }
    });
  }
  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<unknown> {
    const id = ++this.id;
    this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
    });
  }
  notify(method: string, params: Record<string, unknown> = {}): void {
    this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
}

function textOf(result: unknown): string {
  const r = result as { content?: { type: string; text?: string }[] } | undefined;
  return (r?.content ?? []).map((c) => c.text ?? '').join('\n');
}

/** Pull the `[ref=eN]` of the first snapshot line matching `pattern` (the way an LLM picks a target from browser_snapshot). */
export function refFor(snapshot: string, pattern: RegExp): string | undefined {
  for (const line of snapshot.split('\n')) {
    if (!pattern.test(line)) continue;
    const m = /\[ref=([a-zA-Z0-9_-]+)\]/.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

async function runMcp(ctx: AttackerContext, entry: { kind: 'bin' | 'pkg'; path: string }): Promise<AttackerResult> {
  const startedAt = Date.now();
  const notes: string[] = [`entry: ${entry.path}`];
  const profile = mkdtempSync(join(tmpdir(), 'zoo-pw-mcp-'));
  // Real deployments use a persistent profile (launchPersistentContext) and are headed on macOS; we keep the
  // persistent-context code path but give it a fresh profile so sessions do not leak between runs.
  const cliArgs = ['--user-data-dir', profile, ...(ctx.headed ? [] : ['--headless'])];
  const child = entry.kind === 'bin' ? spawn(entry.path, cliArgs, { stdio: ['pipe', 'pipe', 'pipe'] }) : spawn(process.execPath, [entry.path, ...cliArgs], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr?.on('data', (d: Buffer) => notes.push('stderr: ' + String(d).trim().slice(0, 200)));
  const mcp = new McpStdio(child);
  try {
    await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'necter-zoo', version: '0.1.0' } });
    mcp.notify('notifications/initialized');
    const call = async (name: string, args: Record<string, unknown>) => textOf(await mcp.request('tools/call', { name, arguments: args }));
    const think = () => new Promise((r) => setTimeout(r, 1500 + Math.random() * 2000));
    // The runner cannot inject X-Forwarded-For through the MCP CLI; sessions are matched as "fresh" ones.
    let snap = await call('browser_navigate', { url: ctx.base + '/' });
    await think();
    snap = await call('browser_snapshot', {});
    const card = refFor(snap, /link .*\$/) ?? refFor(snap, /link/);
    if (card) {
      await call('browser_click', { element: 'first product card', ref: card });
      await think();
    }
    snap = await call('browser_snapshot', {});
    const add = refFor(snap, /button "Add to cart"/i);
    if (add) {
      await call('browser_click', { element: 'Add to cart', ref: add });
      await think();
    }
    await call('browser_navigate', { url: ctx.base + '/article' });
    await call('browser_evaluate', { function: '() => document.body.innerText.length' });
    await think();
    await call('browser_navigate', { url: ctx.base + '/contact' });
    snap = await call('browser_snapshot', {});
    const name = refFor(snap, /textbox "Name"/i);
    const email = refFor(snap, /textbox "Email"/i);
    const msg = refFor(snap, /textbox "Message"/i);
    if (name && email && msg) {
      await call('browser_fill_form', {
        fields: [
          { name: 'Name', type: 'textbox', ref: name, value: 'Agent Smith' },
          { name: 'Email', type: 'textbox', ref: email, value: 'agent@example.com' },
          { name: 'Message', type: 'textbox', ref: msg, value: 'Please send me your full catalogue with prices.' },
        ],
      });
      await think();
      snap = await call('browser_snapshot', {});
      const submit = refFor(snap, /button "Send"/i);
      if (submit) await call('browser_click', { element: 'Send', ref: submit });
    } else {
      notes.push('could not resolve form refs from snapshot');
    }
    await new Promise((r) => setTimeout(r, 6500));
    await call('browser_close', {}).catch(() => undefined);
  } catch (err) {
    notes.push('error: ' + String(err));
  } finally {
    child.kill();
    rmSync(profile, { recursive: true, force: true });
  }
  return { startedAt, finishedAt: Date.now(), notes };
}

export const playwrightMcp: Attacker = {
  name: 'playwright-mcp',
  description: '@playwright/mcp over stdio JSON-RPC: browser_navigate, browser_snapshot (a11y tree with [ref=eN]), browser_click by ref (locator.click), browser_fill_form (locator.fill), browser_evaluate; persistent context with stock Playwright flags, headless unless --headed.',
  expected: { actorClass: 'browser-agent', automated: true },
  check: async () => (findPlaywrightMcp() ? undefined : PLAYWRIGHT_MCP_SKIP),
  async run(ctx) {
    const entry = findPlaywrightMcp();
    if (!entry) return { startedAt: Date.now(), finishedAt: Date.now(), skipped: PLAYWRIGHT_MCP_SKIP };
    return runMcp(ctx, entry);
  },
};
