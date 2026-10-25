import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const uiDir = join(dirname(fileURLToPath(import.meta.url)), '../ui');

/** The dashboard shell with its boot config. Files are read per request so edits show on reload. */
export function dashboardPage(cfg: { mode: 'monitor' | 'enforce'; upstream?: string; site: string }): string {
  const boot = JSON.stringify({ mode: cfg.mode, upstream: cfg.upstream ?? null, site: cfg.site }).replace(/</g, '\\u003c');
  return readFileSync(join(uiDir, 'index.html'), 'utf8').replace('__CONFIG__', boot);
}

const TYPES: Record<string, string> = { '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8' };

/** Static dashboard assets (app.css, app.js). */
export function dashboardAsset(name: string): { body: string; type: string } | undefined {
  if (!/^[a-z-]+\.(css|js)$/.test(name)) return undefined;
  try {
    return { body: readFileSync(join(uiDir, name), 'utf8'), type: TYPES[name.slice(name.lastIndexOf('.'))]! };
  } catch {
    return undefined;
  }
}
