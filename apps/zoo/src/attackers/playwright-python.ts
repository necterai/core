import type { Attacker } from '../lib/types.js';
import { pythonWith, runPython } from '../lib/python.js';

/**
 * Python Playwright (sync API) driving its bundled headless Chromium: the stack under Browser Use (pre-CDP-native),
 * Skyvern, Magentic-UI, the OpenAI CUA sample and most LangChain browser tools. Same scripted task as the TS
 * attackers: locator clicks (element centres, actionability scroll), fill(), evaluate()-based DOM harvesting,
 * window.scrollBy() reading, form submit, fetch from the page.
 */
const SCRIPT = `
import sys, json, time
from playwright.sync_api import sync_playwright
base, ip = sys.argv[1], sys.argv[2]
notes = []
def harvest(page):
    n = page.evaluate("""() => {
      const out = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const r = n.getBoundingClientRect(); const cs = getComputedStyle(n);
        out.push([n.tagName, r.x, r.y, r.width, r.height, cs.display, cs.visibility, cs.cursor, (n.innerText || '').slice(0, 60)]);
      }
      return out.length;
    }""")
    page.evaluate("() => document.body.innerText")
    notes.append(f"harvested {n} elements on {page.url}")
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(base_url=base, extra_http_headers={"x-forwarded-for": ip})
    page = context.new_page()
    page.goto("/", wait_until="load")
    harvest(page)
    page.wait_for_timeout(300)
    page.locator("a.card").first.click()
    page.wait_for_load_state("load")
    harvest(page)
    page.wait_for_timeout(300)
    page.locator("button[data-add]").click()
    page.wait_for_timeout(300)
    page.goto("/article")
    harvest(page)
    for _ in range(3):
        page.evaluate("() => window.scrollBy(0, window.innerHeight)")
        page.wait_for_timeout(300)
    page.goto("/contact")
    harvest(page)
    page.locator("input[name=name]").fill("Agent Smith")
    page.locator("input[name=email]").fill("agent@example.com")
    page.locator("textarea[name=message]").fill("Please send me your full catalogue with prices.")
    page.wait_for_timeout(300)
    page.locator("button[type=submit]").click()
    page.wait_for_load_state("load")
    status = page.evaluate("async () => (await fetch('/api/products')).status")
    notes.append(f"api status {status}")
    page.wait_for_timeout(6500)
    sid = next((c["value"] for c in context.cookies() if c["name"] == "__necter_sid"), None)
    context.close(); browser.close()
print(json.dumps({"sid": sid, "notes": notes}))
`;

export const playwrightPython: Attacker = {
  name: 'playwright-python',
  description: 'Python Playwright 1.6x sync API + bundled headless Chromium: locator clicks, fill(), evaluate() DOM harvesting, window.scrollBy, same task as pw-chromium-headless (the stack under Skyvern, Magentic-UI, the OpenAI CUA sample, LangChain browser tools).',
  expected: { actorClass: 'browser-agent', automated: true },
  requires: ['python3'],
  check: async () => ((await pythonWith(['playwright'])) ? undefined : 'needs python playwright (pip install playwright && playwright install chromium)'),
  async run(ctx) {
    const startedAt = Date.now();
    const py = await pythonWith(['playwright']);
    if (!py) return { startedAt, finishedAt: Date.now(), skipped: 'needs python playwright' };
    const { stdout, stderr } = await runPython(py, SCRIPT, [ctx.base, ctx.ip]);
    const last = stdout.trim().split('\n').pop() ?? '{}';
    let parsed: { sid?: string | null; notes?: string[] } = {};
    try {
      parsed = JSON.parse(last) as typeof parsed;
    } catch {
      return { startedAt, finishedAt: Date.now(), error: `unparseable python output: ${last.slice(0, 200)} ${stderr.slice(0, 300)}` };
    }
    const notes = [`python: ${py}`, ...(parsed.notes ?? [])];
    return { startedAt, finishedAt: Date.now(), notes, ...(parsed.sid ? { sessionIds: [parsed.sid] } : {}) };
  },
};
