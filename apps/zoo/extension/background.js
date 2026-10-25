// Zoo Agent service worker: drives a tab the way Claude in Chrome (mcpPermissions-*.js) and the Playwright Extension do,
// i.e. chrome.debugger.attach(tab, "1.3") + Page.enable + Emulation.setFocusEmulationEnabled, then
// Input.dispatchMouseEvent (one mouseMoved, mousePressed/mouseReleased with force 0.5), Input.dispatchKeyEvent per
// character ~3 ms apart, Runtime.evaluate in the main world for reads, and chrome.scripting for form_input-style
// untrusted value setting. Every tool step is followed by a "screenshot + model" pause.

const status = { state: 'idle', step: 0, steps: [], error: null, tabId: null, sid: null, startedAt: null, finishedAt: null };
let running = false;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'status') {
    sendResponse(status);
    return false;
  }
  if (msg && msg.type === 'run') {
    if (!running) {
      running = true;
      runTask(msg.base, msg.task || 'shop').catch((e) => {
        status.state = 'error';
        status.error = String(e && e.message ? e.message : e);
      });
    }
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const think = () => sleep(1500 + Math.random() * 2000); // screenshot round trip + model latency (real: 2-5 s)

function note(s) {
  status.step++;
  status.steps.push(`[${Date.now() - status.startedAt}ms] ${s}`);
}

function cdp(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (res) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(method + ': ' + err.message));
      else resolve(res);
    });
  });
}

function attach(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error('debugger_attach_error: ' + err.message));
      else resolve();
    });
  });
}

function waitForComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('navigation timeout'));
    }, timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(t);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (tab) => {
      if (tab && tab.status === 'complete') {
        clearTimeout(t);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}

async function navigate(tabId, url) {
  const nav = waitForComplete(tabId);
  await chrome.tabs.update(tabId, { url });
  await nav;
  await sleep(300);
}

async function evaluate(tabId, expression) {
  const r = await cdp(tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, replMode: true });
  if (r.exceptionDetails) throw new Error('evaluate: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description));
  return r.result ? r.result.value : undefined;
}

/** read_page / get_page_text: accessibility-ish walk in the main world; nothing is mutated. */
async function readPage(tabId) {
  const n = await evaluate(
    tabId,
    `(() => { const out = []; let i = 0; for (const el of document.querySelectorAll('a,button,input,textarea,select,h1,h2,h3,p,[role]')) { const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) continue; out.push({ ref: 'ref_' + (++i), tag: el.tagName, name: (el.innerText || el.value || el.getAttribute('aria-label') || '').slice(0, 80), rect: [r.x, r.y, r.width, r.height] }); } return out.length; })()`,
  );
  note(`read_page: ${n} nodes`);
}

async function centerOf(tabId, selector) {
  const c = await evaluate(tabId, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center', inline: 'nearest' }); const r = el.getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()`);
  if (!c) throw new Error('no element for ' + selector);
  return c;
}

/** computer left_click: hide indicator, 50 ms, one mouseMoved, mousePressed(force 0.5) -> ~5 ms -> mouseReleased. */
async function click(tabId, selector) {
  const [x, y] = await centerOf(tabId, selector);
  await sleep(50); // hideIndicatorForToolUse + dt(50)
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await sleep(9);
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, force: 0.5 });
  await sleep(5);
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  note(`left_click ${selector} @ ${x},${y}`);
}

const KEY_CODES = { ' ': ['Space', 32], '.': ['Period', 190], ',': ['Comma', 188], '@': ['Digit2', 50], '?': ['Slash', 191], '-': ['Minus', 189], "'": ['Quote', 222] };
function keyInfo(ch) {
  if (/[a-z]/i.test(ch)) return { key: ch, code: 'Key' + ch.toUpperCase(), vk: ch.toUpperCase().charCodeAt(0) };
  if (/[0-9]/.test(ch)) return { key: ch, code: 'Digit' + ch, vk: ch.charCodeAt(0) };
  const k = KEY_CODES[ch] || ['Unidentified', 0];
  return { key: ch, code: k[0], vk: k[1] };
}

/** computer type: per character keyDown(text) + keyUp, successive characters ~3 ms apart. */
async function type(tabId, text) {
  for (const ch of text) {
    const k = keyInfo(ch);
    await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 0, key: k.key, code: k.code, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk });
    await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 0, key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk });
    await sleep(3);
  }
  note(`type ${JSON.stringify(text)}`);
}

async function pressKey(tabId, key, code, vk) {
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 0, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 0, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  note(`key ${key}`);
}

/** computer scroll: trusted wheel at the coordinates, no preceding movement. */
async function scroll(tabId, x, y, amount) {
  for (let i = 0; i < amount; i++) {
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: 100, button: 'none', buttons: 0 });
    await sleep(20);
  }
  note(`scroll ${amount} @ ${x},${y}`);
}

/** form_input: value replaced wholesale from the isolated world; the page sees untrusted input/change after a trusted focusin. */
async function formInput(tabId, selector, value) {
  await cdp(tabId, 'Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)}).focus()`, returnByValue: true });
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel, val) => {
      const el = document.querySelector(sel);
      if (!el) return;
      el.value = val;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    args: [selector, value],
  });
  note(`form_input ${selector}`);
}

async function runTask(base, task) {
  status.state = 'running';
  status.startedAt = Date.now();
  const tab = await chrome.tabs.create({ url: base + '/', active: true });
  status.tabId = tab.id;
  await waitForComplete(tab.id);
  await attach(tab.id);
  await cdp(tab.id, 'Page.enable');
  await cdp(tab.id, 'Emulation.setFocusEmulationEnabled', { enabled: true });
  note('attached chrome.debugger 1.3; Page.enable; focus emulation on');
  try {
    if (task === 'shop') {
      await think();
      await readPage(tab.id);
      await think();
      await click(tab.id, 'a.card');
      await waitForComplete(tab.id);
      await think();
      await readPage(tab.id);
      await click(tab.id, 'button[data-add]');
      await think();
      await navigate(tab.id, base + '/article');
      await think();
      await readPage(tab.id);
      await scroll(tab.id, 640, 400, 3);
      await think();
      await scroll(tab.id, 640, 400, 3);
      await think();
      await navigate(tab.id, base + '/contact');
      await think();
      await readPage(tab.id);
      await click(tab.id, 'input[name=name]');
      await type(tab.id, 'Agent Smith');
      await think();
      await pressKey(tab.id, 'Tab', 'Tab', 9);
      await type(tab.id, 'agent@example.com');
      await think();
      await formInput(tab.id, 'textarea[name=message]', 'Please send me your full catalogue with prices.');
      await think();
      await click(tab.id, 'button[type=submit]');
      await waitForComplete(tab.id);
      await think();
      await evaluate(tab.id, `(async () => (await fetch('/api/products')).status)()`);
      note('javascript_tool fetch /api/products');
      await sleep(6500); // let beacons flush before the harness reads sessions
    }
    status.sid = await evaluate(tab.id, `(document.cookie.match(/__necter_sid=([^;]+)/) || [])[1] || null`);
  } finally {
    try {
      await new Promise((r) => chrome.debugger.detach({ tabId: tab.id }, () => r()));
    } catch (e) {
      /* already detached */
    }
    status.finishedAt = Date.now();
    status.state = status.state === 'error' ? 'error' : 'done';
    running = false;
  }
}
