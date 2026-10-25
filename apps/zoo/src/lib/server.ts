import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

function tsxCli(): string {
  const candidates = [
    join(here, '../../../../node_modules/tsx/dist/cli.mjs'),
    join(here, '../../../demo/node_modules/tsx/dist/cli.mjs'),
    join(here, '../../node_modules/tsx/dist/cli.mjs'),
  ];
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error('tsx not found; run pnpm install');
  return found;
}

export async function startDemo(port: number, mode: 'monitor' | 'enforce'): Promise<{ base: string; stop: () => void }> {
  const demoDir = join(here, '../../../demo');
  const child: ChildProcess = spawn(process.execPath, [tsxCli(), 'src/server.ts'], {
    cwd: demoDir,
    env: { ...process.env, PORT: String(port), NECTER_MODE: mode },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr?.on('data', (d) => process.stderr.write(`[demo] ${d}`));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const r = await fetch(base + '/__necter/health');
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error('demo server did not start');
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { base, stop: () => child.kill() };
}
