import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fetch as undiciFetch, Agent } from 'undici';
import type { Attacker, AttackerContext, AttackerResult } from '../lib/types.js';
import { pythonWith, runPython } from '../lib/python.js';

const exec = promisify(execFile);

export const PAGES = ['/', '/products', '/products/3', '/article', '/robots.txt', '/products/7'];

function result(startedAt: number, uaMarker: string, notes: string[] = []): AttackerResult {
  return { startedAt, finishedAt: Date.now(), uaMarker, notes };
}

async function undiciRun(ctx: AttackerContext, ua: string, extraHeaders: Record<string, string>, keepCookies: boolean, pauseMs = 400): Promise<string[]> {
  const notes: string[] = [];
  let cookie: string | undefined;
  const dispatcher = new Agent({ connections: 2 });
  for (const path of PAGES) {
    const headers: Record<string, string> = { 'user-agent': ua, 'x-forwarded-for': ctx.ip, ...extraHeaders };
    if (keepCookies && cookie) headers['cookie'] = cookie;
    const res = await undiciFetch(ctx.base + path, { headers, dispatcher, redirect: 'manual' });
    const sc = res.headers.get('set-cookie');
    if (sc && keepCookies) cookie = sc.split(';')[0]!;
    notes.push(`${path} -> ${res.status} ${res.headers.get('x-necter-class') ?? ''}`);
    await res.text();
    await new Promise((r) => setTimeout(r, pauseMs + Math.random() * pauseMs));
  }
  await dispatcher.close();
  return notes;
}

/** UA of the reference MCP fetch server (modelcontextprotocol/servers, src/fetch): autonomous mode. */
export const MCP_FETCH_UA = 'ModelContextProtocol/1.0 (Autonomous; +https://github.com/modelcontextprotocol/servers)';

export const fetchers: Attacker[] = [
  {
    name: 'fetch-python-httpx',
    description: 'Python httpx client (the stack behind many LangChain / MCP fetch tools) with default headers.',
    expected: { actorClass: ['fetch-agent', 'scripted-automation'], automated: true },
    requires: ['python3'],
    check: async () => ((await pythonWith(['httpx'])) ? undefined : 'no python interpreter with httpx installed'),
    async run(ctx) {
      const startedAt = Date.now();
      const ua = `python-httpx/0.28.1`;
      const script = `
import httpx, time, sys, json
base=sys.argv[1]; pages=json.loads(sys.argv[2])
with httpx.Client(headers={'user-agent': sys.argv[3], 'x-forwarded-for': sys.argv[4]}, follow_redirects=False) as c:
    for p in pages:
        r=c.get(base+p); print(p, r.status_code, r.headers.get('x-necter-class','')); time.sleep(0.4)
`;
      const py = await pythonWith(['httpx']);
      if (!py) return { startedAt, finishedAt: Date.now(), skipped: 'no python interpreter with httpx installed' };
      const { stdout } = await runPython(py, script, [ctx.base, JSON.stringify(PAGES), ua, ctx.ip]);
      return result(startedAt, ua, stdout.trim().split('\n'));
    },
  },
  {
    name: 'fetch-mcp-reference',
    description:
      'Reference MCP fetch server behaviour (modelcontextprotocol/servers src/fetch): python httpx, UA "ModelContextProtocol/1.0 (Autonomous; +https://github.com/modelcontextprotocol/servers)", fetches /robots.txt first and honours it, follows redirects, then fetches pages one tool call at a time.',
    expected: { actorClass: 'fetch-agent', automated: true },
    requires: ['python3'],
    check: async () => ((await pythonWith(['httpx'])) ? undefined : 'no python interpreter with httpx installed'),
    async run(ctx) {
      const startedAt = Date.now();
      const script = `
import httpx, time, sys, json
base=sys.argv[1]; pages=json.loads(sys.argv[2]); ua=sys.argv[3]
# mirrors servers/src/fetch: check_may_autonomously_fetch_url() -> GET robots.txt with the same UA, then fetch_url() with follow_redirects=True
with httpx.Client(follow_redirects=True) as c:
    r=c.get(base+'/robots.txt', headers={'User-Agent': ua, 'x-forwarded-for': sys.argv[4]})
    print('/robots.txt', r.status_code, r.headers.get('x-necter-class',''))
    time.sleep(0.8)
    for p in pages:
        if p == '/robots.txt': continue
        r=c.get(base+p, headers={'User-Agent': ua, 'x-forwarded-for': sys.argv[4]})
        print(p, r.status_code, r.headers.get('x-necter-class',''))
        time.sleep(1.5)
`;
      const py = await pythonWith(['httpx']);
      if (!py) return { startedAt, finishedAt: Date.now(), skipped: 'no python interpreter with httpx installed' };
      const { stdout } = await runPython(py, script, [ctx.base, JSON.stringify(PAGES), MCP_FETCH_UA, ctx.ip]);
      return result(startedAt, 'ModelContextProtocol/1.0', stdout.trim().split('\n'));
    },
  },
  {
    name: 'fetch-curl-cffi',
    description:
      'curl_cffi with impersonate="chrome" (curl-impersonate: Chrome TLS ClientHello, HTTP/2 SETTINGS and header set); over plaintext HTTP it still sends "Upgrade: h2c" + "HTTP2-Settings", a fixed macOS UA and Accept-Language, and never executes JavaScript.',
    expected: { actorClass: ['fetch-agent', 'scripted-automation'], automated: true },
    requires: ['python3'],
    check: async () => ((await pythonWith(['curl_cffi'])) ? undefined : 'needs python curl_cffi (pip install curl_cffi); not installed'),
    async run(ctx) {
      const startedAt = Date.now();
      const py = await pythonWith(['curl_cffi']);
      if (!py) return { startedAt, finishedAt: Date.now(), skipped: 'needs python curl_cffi (pip install curl_cffi); not installed' };
      const script = `
import sys, json, time
from curl_cffi import requests
base=sys.argv[1]; pages=json.loads(sys.argv[2])
s = requests.Session(impersonate='chrome')
for p in pages:
    r = s.get(base+p, headers={'x-forwarded-for': sys.argv[3]}, allow_redirects=False)
    print(p, r.status_code, r.headers.get('x-necter-class',''), r.request.headers.get('user-agent','') if hasattr(r,'request') and r.request is not None else '')
    time.sleep(1.2)
`;
      const { stdout } = await runPython(py, script, [ctx.base, JSON.stringify(PAGES), ctx.ip]);
      const notes = stdout.trim().split('\n');
      // curl_cffi's chrome profile carries a macOS Chrome UA; the exact major depends on the installed version.
      return result(startedAt, 'Safari/537.36', notes);
    },
  },
  {
    name: 'fetch-curl',
    description: 'curl with default headers, six pages, cookie jar kept.',
    expected: { actorClass: ['fetch-agent', 'scripted-automation'], automated: true },
    requires: ['curl'],
    async run(ctx) {
      const startedAt = Date.now();
      const notes: string[] = [];
      const jar = `/tmp/necter-zoo-${ctx.tag}-${ctx.iteration}.jar`;
      for (const p of PAGES) {
        const { stdout } = await exec('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-H', `X-Forwarded-For: ${ctx.ip}`, '-c', jar, '-b', jar, ctx.base + p]);
        notes.push(`${p} -> ${stdout}`);
      }
      return result(startedAt, 'curl/', notes);
    },
  },
  {
    name: 'fetch-undici-default',
    description: 'Node undici fetch with its default UA (what a naive tool-call fetcher sends).',
    expected: { actorClass: ['fetch-agent', 'scripted-automation'], automated: true },
    async run(ctx) {
      const startedAt = Date.now();
      const ua = 'undici';
      const notes = await undiciRun(ctx, ua, {}, false);
      return result(startedAt, ua, notes);
    },
  },
  {
    name: 'fetch-spoofed-browser',
    description: 'undici fetch copying a full Chrome 155 header set (UA, Accept, Accept-Language, Sec-Fetch-*, client hints), no cookies, no JS: the hard fetcher case.',
    expected: { actorClass: ['fetch-agent', 'scripted-automation'], automated: true },
    async run(ctx) {
      const startedAt = Date.now();
      const ua = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36`;
      const headers = {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'accept-language': 'en-US,en;q=0.9',
        'accept-encoding': 'gzip, deflate, br, zstd',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        'sec-fetch-user': '?1',
        'upgrade-insecure-requests': '1',
        'sec-ch-ua': '"Google Chrome";v="155", "Chromium";v="155", "Not_A Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'x-zoo-tag': ctx.tag,
      };
      // A realistic on-demand fetcher spreads its page loads over more than the SDK's no-JS grace period.
      const notes = await undiciRun(ctx, ua, headers, false, 1800);
      return result(startedAt, 'Chrome/155.0.0.0 Safari/537.36', notes);
    },
  },
  {
    name: 'crawler-gptbot',
    description: 'OpenAI GPTBot user agent (declared AI training crawler).',
    expected: { actorClass: 'ai-crawler', automated: true, provider: 'openai' },
    async run(ctx) {
      const startedAt = Date.now();
      const ua = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot';
      const notes = await undiciRun(ctx, ua, { accept: 'text/html,*/*' }, false);
      return result(startedAt, 'GPTBot/1.2', notes);
    },
  },
  {
    name: 'agent-chatgpt-user',
    description: 'ChatGPT-User user agent (on-demand fetcher behind ChatGPT browsing / agents).',
    expected: { actorClass: 'fetch-agent', automated: true, provider: 'openai' },
    async run(ctx) {
      const startedAt = Date.now();
      const ua = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot';
      const notes = await undiciRun(ctx, ua, { accept: 'text/html,*/*' }, false);
      return result(startedAt, 'ChatGPT-User/1.0', notes);
    },
  },
  {
    name: 'agent-claude-user',
    description: 'Claude-User user agent (Anthropic on-demand fetcher).',
    expected: { actorClass: 'fetch-agent', automated: true, provider: 'anthropic' },
    async run(ctx) {
      const startedAt = Date.now();
      const ua = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)';
      const notes = await undiciRun(ctx, ua, { accept: 'text/html,*/*' }, false);
      return result(startedAt, 'Claude-User/1.0', notes);
    },
  },
];
