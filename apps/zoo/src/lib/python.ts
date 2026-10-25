import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Interpreters we try, in order. Homebrew/user-site installs usually carry httpx/playwright; Apple's python3 is last-but-tried. */
export const PYTHON_CANDIDATES = ['python3.13', 'python3.12', '/opt/homebrew/bin/python3', 'python3', 'python'];

const cache = new Map<string, Promise<string | undefined>>();

/** First interpreter on this machine that can import every module in `modules` (memoised per module set). */
export function pythonWith(modules: string[]): Promise<string | undefined> {
  const key = modules.join(',');
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      for (const py of PYTHON_CANDIDATES) {
        try {
          await exec(py, ['-c', modules.map((m) => `import ${m}`).join(';')], { timeout: 20_000 });
          return py;
        } catch {
          /* try next */
        }
      }
      return undefined;
    })();
    cache.set(key, p);
  }
  return p;
}

/** Run a Python script (passed via -c) and return stdout lines. */
export async function runPython(py: string, script: string, args: string[], timeoutMs = 180_000): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await exec(py, ['-c', script, ...args], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  return { stdout, stderr };
}
