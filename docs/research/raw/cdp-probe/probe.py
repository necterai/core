#!/usr/bin/env python3
"""Stdlib-only CDP probe harness: launches a Chromium binary headless, attaches over
the DevTools protocol and measures page-visible automation tells.

Usage: probe.py <binary> [--extra ARG ...] [--label NAME] [--out FILE]
"""
import argparse, base64, http.server, json, os, socket, struct, subprocess, sys, tempfile, threading, time, urllib.request, shutil, traceback

SCRATCH = os.path.dirname(os.path.abspath(__file__))

# ----------------------------------------------------------------------------- websocket
class WS:
    def __init__(self, url):
        assert url.startswith('ws://'), url
        rest = url[5:]
        hostport, _, path = rest.partition('/')
        host, _, port = hostport.partition(':')
        self.sock = socket.create_connection((host, int(port)))
        key = base64.b64encode(os.urandom(16)).decode()
        req = ("GET /%s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
               "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n" % (path, hostport, key))
        self.sock.sendall(req.encode())
        buf = b''
        while b'\r\n\r\n' not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError('handshake failed')
            buf += chunk
        head, _, extra = buf.partition(b'\r\n\r\n')
        if b' 101 ' not in head.split(b'\r\n')[0]:
            raise RuntimeError(head)
        self.buf = extra

    def _read_exact(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(1 << 20)
            if not chunk:
                raise RuntimeError('socket closed')
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _send_frame(self, op, data):
        header = bytearray([0x80 | op])
        n = len(data)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack('>H', n)
        else:
            header.append(0x80 | 127)
            header += struct.pack('>Q', n)
        mask = os.urandom(4)
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        self.sock.sendall(bytes(header) + masked)

    def send(self, text):
        self._send_frame(0x1, text.encode())

    def recv(self):
        msg = b''
        while True:
            b1, b2 = self._read_exact(2)
            fin, op = b1 & 0x80, b1 & 0x0f
            n = b2 & 0x7f
            if n == 126:
                n = struct.unpack('>H', self._read_exact(2))[0]
            elif n == 127:
                n = struct.unpack('>Q', self._read_exact(8))[0]
            mk = self._read_exact(4) if (b2 & 0x80) else None
            payload = self._read_exact(n)
            if mk:
                payload = bytes(b ^ mk[i % 4] for i, b in enumerate(payload))
            if op == 0x8:
                raise RuntimeError('ws closed by peer')
            if op == 0x9:
                self._send_frame(0xA, payload)
                continue
            if op == 0xA:
                continue
            msg += payload
            if fin:
                return msg.decode('utf-8', 'replace')

# ----------------------------------------------------------------------------- cdp
class CDP:
    def __init__(self, ws_url):
        self.ws = WS(ws_url)
        self.id = 0
        self.events = []
        self.pending = {}

    def send(self, method, params=None, sessionId=None):
        self.id += 1
        m = {'id': self.id, 'method': method, 'params': params or {}}
        if sessionId:
            m['sessionId'] = sessionId
        self.ws.send(json.dumps(m))
        return self.id

    def pump(self, timeout=30):
        self.ws.sock.settimeout(timeout)
        m = json.loads(self.ws.recv())
        if 'id' in m:
            self.pending[m['id']] = m
        else:
            self.events.append(m)
        return m

    def wait(self, mid, timeout=30):
        t0 = time.time()
        while mid not in self.pending:
            if time.time() - t0 > timeout:
                raise TimeoutError('cdp id %s' % mid)
            self.pump(timeout)
        return self.pending.pop(mid)

    def call(self, method, params=None, sessionId=None, timeout=30):
        r = self.wait(self.send(method, params, sessionId), timeout)
        if 'error' in r:
            return {'__error': r['error']}
        return r.get('result', {})

    def wait_event(self, name, timeout=10, pred=None):
        t0 = time.time()
        while True:
            for i, e in enumerate(self.events):
                if e.get('method') == name and (pred is None or pred(e)):
                    return self.events.pop(i)
            left = timeout - (time.time() - t0)
            if left <= 0:
                return None
            try:
                self.pump(max(0.05, left))
            except socket.timeout:
                return None

    def drain(self, t=0.4):
        end = time.time() + t
        while time.time() < end:
            try:
                self.pump(max(0.05, end - time.time()))
            except socket.timeout:
                break

    def take_events(self, name):
        out = [e for e in self.events if e.get('method') == name]
        self.events = [e for e in self.events if e.get('method') != name]
        return out

    def evaluate(self, expr, sessionId=None, awaitPromise=True, timeout=40, contextId=None):
        params = {'expression': expr, 'awaitPromise': awaitPromise, 'returnByValue': True}
        if contextId:
            params['contextId'] = contextId
        r = self.call('Runtime.evaluate', params, sessionId, timeout)
        if '__error' in r:
            return r
        if 'exceptionDetails' in r:
            ed = r['exceptionDetails']
            return {'__exception': (ed.get('exception') or {}).get('description') or ed.get('text')}
        return r.get('result', {}).get('value')

# ----------------------------------------------------------------------------- http origin
PAGE = (b'<!doctype html><html><head><meta charset=utf-8><title>probe</title></head>'
        b'<body><div id=x>hi</div><script>window.__pageScriptRan=1;</script></body></html>')

class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass
    def do_GET(self):
        body = PAGE
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

def start_http():
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]

# ----------------------------------------------------------------------------- launcher
def launch(binary, extra_args):
    udd = tempfile.mkdtemp(prefix='udd-', dir=SCRATCH)
    args = [binary, '--user-data-dir=' + udd, '--remote-debugging-port=0', '--no-first-run',
            '--no-default-browser-check', '--headless'] + extra_args + ['about:blank']
    p = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    port_file = os.path.join(udd, 'DevToolsActivePort')
    port = None
    for _ in range(400):
        if os.path.exists(port_file):
            lines = open(port_file).read().split('\n')
            if len(lines) >= 2 and lines[0].strip():
                port = int(lines[0].strip())
                break
        if p.poll() is not None:
            break
        time.sleep(0.05)
    if port is None:
        err = p.stderr.read().decode('utf-8', 'replace')[-3000:]
        raise RuntimeError('browser did not expose DevTools port: ' + err)
    return p, udd, port

def http_json(url, method='GET'):
    req = urllib.request.Request(url, method=method)
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode())

# ----------------------------------------------------------------------------- JS probes
JS_ENV = r'''
(() => {
  const r = {};
  const g = (f, d) => { try { return f(); } catch (e) { return 'ERR:' + e; } };
  r.ua = navigator.userAgent; r.appVersion = navigator.appVersion; r.webdriver = navigator.webdriver;
  r.webdriverIn = 'webdriver' in navigator;
  r.webdriverDesc = g(() => { const d = Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver'); return d ? {getter: Function.prototype.toString.call(d.get), enumerable: d.enumerable, configurable: d.configurable} : 'not-on-prototype:' + JSON.stringify(Object.getOwnPropertyDescriptor(navigator, 'webdriver')); });
  r.platform = navigator.platform; r.vendor = navigator.vendor; r.productSub = navigator.productSub;
  r.languages = navigator.languages; r.language = navigator.language;
  r.hardwareConcurrency = navigator.hardwareConcurrency; r.deviceMemory = navigator.deviceMemory; r.maxTouchPoints = navigator.maxTouchPoints;
  r.connection = navigator.connection ? {rtt: navigator.connection.rtt, downlink: navigator.connection.downlink, effectiveType: navigator.connection.effectiveType, saveData: navigator.connection.saveData, type: navigator.connection.type} : null;
  r.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone; r.tzOffset = new Date().getTimezoneOffset();
  r.inner = [innerWidth, innerHeight]; r.outer = [outerWidth, outerHeight]; r.screenXY = [screenX, screenY, screenLeft, screenTop];
  r.screen = {w: screen.width, h: screen.height, aw: screen.availWidth, ah: screen.availHeight, at: screen.availTop, al: screen.availLeft, cd: screen.colorDepth, pd: screen.pixelDepth, isExtended: screen.isExtended, orientation: screen.orientation && screen.orientation.type};
  r.dpr = devicePixelRatio; r.hasFocus = document.hasFocus(); r.visibilityState = document.visibilityState;
  r.chromeKeys = window.chrome ? Object.keys(window.chrome) : null;
  r.chromeRuntime = typeof (window.chrome && window.chrome.runtime); r.chromeCsi = typeof (window.chrome && window.chrome.csi); r.chromeLoadTimes = typeof (window.chrome && window.chrome.loadTimes); r.chromeApp = typeof (window.chrome && window.chrome.app);
  r.csiToString = g(() => Function.prototype.toString.call(chrome.csi)); r.loadTimesToString = g(() => Function.prototype.toString.call(chrome.loadTimes));
  r.notificationPermission = typeof Notification !== 'undefined' ? Notification.permission : 'no-Notification';
  r.plugins = navigator.plugins.length; r.pluginNames = [...navigator.plugins].map(p => p.name); r.mimeTypes = navigator.mimeTypes.length; r.pluginsIsPluginArray = navigator.plugins instanceof PluginArray;
  r.pdfViewerEnabled = navigator.pdfViewerEnabled;
  r.anyPointer = ['fine', 'coarse', 'none'].filter(v => matchMedia(`(any-pointer:${v})`).matches); r.anyHover = ['hover', 'none'].filter(v => matchMedia(`(any-hover:${v})`).matches);
  r.pointer = ['fine', 'coarse', 'none'].filter(v => matchMedia(`(pointer:${v})`).matches);
  r.prefersDark = matchMedia('(prefers-color-scheme: dark)').matches; r.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches; r.colorGamut = ['srgb','p3','rec2020'].filter(v => matchMedia(`(color-gamut:${v})`).matches);
  r.webgl = g(() => { const c = document.createElement('canvas'); const gl = c.getContext('webgl'); if (!gl) return 'no-webgl'; const d = gl.getExtension('WEBGL_debug_renderer_info'); return {vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER), unmaskedVendor: d ? gl.getParameter(d.UNMASKED_VENDOR_WEBGL) : null, unmaskedRenderer: d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : null, version: gl.getParameter(gl.VERSION), glsl: gl.getParameter(gl.SHADING_LANGUAGE_VERSION), maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE), exts: gl.getSupportedExtensions().length}; });
  r.webgl2 = g(() => !!document.createElement('canvas').getContext('webgl2'));
  r.audio = g(() => { const ac = new AudioContext(); const o = {state: ac.state, sampleRate: ac.sampleRate, baseLatency: ac.baseLatency, outputLatency: ac.outputLatency, maxChannelCount: ac.destination.maxChannelCount}; ac.close(); return o; });
  r.voicesSync = g(() => speechSynthesis.getVoices().length);
  r.uaData = navigator.userAgentData ? {brands: navigator.userAgentData.brands, mobile: navigator.userAgentData.mobile, platform: navigator.userAgentData.platform} : null;
  r.docAttrs = document.documentElement.getAttributeNames();
  r.suspiciousGlobals = Object.getOwnPropertyNames(window).filter(k => /cdc_|playwright|__pw|puppeteer|pptr|selenium|webdriver|__driver|nightmare|domAutomation|__fxdriver|calledSelenium|_Selenium/i.test(k));
  r.emptyNameNativeFns = Object.getOwnPropertyNames(window).filter(k => { try { const v = window[k]; return typeof v === 'function' && v.name === '' && /\[native code\]/.test(Function.prototype.toString.call(v)); } catch (e) { return false; } });
  r.perfNowMinDelta = g(() => { let min = Infinity, a = performance.now(); for (let i = 0; i < 5000; i++) { const b = performance.now(); if (b > a) { if (b - a < min) min = b - a; a = b; } } return min; });
  r.getBattery = typeof navigator.getBattery;
  r.codecs = g(() => { const v = document.createElement('video'), a = document.createElement('audio'); return {h264: v.canPlayType('video/mp4; codecs="avc1.42E01E"'), hevc: v.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"'), aac: a.canPlayType('audio/mp4; codecs="mp4a.40.2"'), mp3: a.canPlayType('audio/mpeg'), webm: v.canPlayType('video/webm; codecs="vp9"'), mseH264: MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"')}; });
  r.fonts = g(() => { const c = document.createElement('canvas').getContext('2d'); const s = 'mmmmmmmmmmlli'; const base = {}; for (const b of ['monospace', 'sans-serif', 'serif']) { c.font = `72px ${b}`; base[b] = c.measureText(s).width; } const out = []; for (const f of ['Arial', 'Helvetica Neue', 'Menlo', 'Monaco', 'Segoe UI', 'Calibri', 'Tahoma', 'Times New Roman', 'DejaVu Sans', 'Liberation Sans', 'Noto Sans', 'Roboto', 'Ubuntu', 'Cantarell', 'PingFang SC', 'Hiragino Sans', 'Microsoft YaHei', 'Courier New', 'Verdana', 'Georgia']) { let present = false; for (const b of ['monospace', 'sans-serif', 'serif']) { c.font = `72px "${f}", ${b}`; if (c.measureText(s).width !== base[b]) present = true; } if (present) out.push(f); } return out; });
  r.canvasHash = g(() => { const c = document.createElement('canvas'); c.width = 240; c.height = 60; const x = c.getContext('2d'); x.textBaseline = 'alphabetic'; x.fillStyle = '#f60'; x.fillRect(100, 1, 62, 20); x.fillStyle = '#069'; x.font = '14px Arial'; x.fillText('Cwm fjordbank glyphs vext quiz, 😃', 2, 15); x.fillStyle = 'rgba(102,204,0,0.7)'; x.font = '18px Times New Roman'; x.fillText('Cwm fjordbank glyphs vext quiz, 😃', 4, 45); const d = c.toDataURL(); let h = 0; for (let i = 0; i < d.length; i++) h = (h * 31 + d.charCodeAt(i)) | 0; return h >>> 0; });
  r.errorStackFromPage = (function pageFn() { return new Error('x').stack; })();
  r.permissionsQueryToString = g(() => Function.prototype.toString.call(Permissions.prototype.query));
  r.userAgentGetterToString = g(() => Function.prototype.toString.call(Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent').get));
  r.sharedArrayBuffer = typeof SharedArrayBuffer; r.crossOriginIsolated = self.crossOriginIsolated;
  r.history = history.length;
  return r;
})()
'''

JS_ASYNC = r'''
(async () => {
  const r = {};
  const T = (p, ms, tag) => Promise.race([p, new Promise(res => setTimeout(() => res('TIMEOUT:' + tag), ms))]);
  const q = n => navigator.permissions.query({name: n}).then(p => p.state).catch(e => 'ERR:' + e.name);
  r.permNotifications = await T(q('notifications'), 2000, 'notif');
  r.permGeolocation = await T(q('geolocation'), 2000, 'geo');
  r.permCamera = await T(q('camera'), 2000, 'cam');
  r.permMicrophone = await T(q('microphone'), 2000, 'mic');
  r.permClipboardRead = await T(q('clipboard-read'), 2000, 'clip');
  r.permPush = await T(navigator.permissions.query({name: 'push', userVisibleOnly: true}).then(p => p.state).catch(e => 'ERR:' + e.name), 2000, 'push');
  r.mediaDevices = await T(navigator.mediaDevices.enumerateDevices().then(ds => ds.map(d => d.kind + ':' + (d.label ? 'label' : 'nolabel') + ':' + (d.deviceId ? 'id' : 'noid'))).catch(e => 'ERR:' + e), 3000, 'devices');
  r.voices = await T(new Promise(res => { let v = speechSynthesis.getVoices(); if (v.length) return res({count: v.length, sample: v.slice(0, 3).map(x => x.name + '|' + x.lang + '|' + x.localService), googleVoices: v.filter(x => /Google/.test(x.name)).length}); speechSynthesis.onvoiceschanged = () => { v = speechSynthesis.getVoices(); res({count: v.length, sample: v.slice(0, 3).map(x => x.name + '|' + x.lang + '|' + x.localService), googleVoices: v.filter(x => /Google/.test(x.name)).length, viaEvent: true}); }; }), 2500, 'voices');
  r.battery = navigator.getBattery ? await T(navigator.getBattery().then(b => ({charging: b.charging, level: b.level, chargingTime: b.chargingTime, dischargingTime: b.dischargingTime})).catch(e => 'ERR:' + e), 2000, 'battery') : 'no-getBattery';
  r.uaHigh = navigator.userAgentData ? await T(navigator.userAgentData.getHighEntropyValues(['architecture', 'bitness', 'model', 'platformVersion', 'uaFullVersion', 'fullVersionList', 'formFactors', 'wow64']).catch(e => 'ERR:' + e), 2000, 'uah') : null;
  r.raf = await T(new Promise(res => { const ts = []; function step(t) { ts.push(t); if (ts.length < 41) requestAnimationFrame(step); else { const d = []; for (let i = 1; i < ts.length; i++) d.push(+(ts[i] - ts[i - 1]).toFixed(3)); d.sort((a, b) => a - b); res({n: d.length, min: d[0], median: d[d.length >> 1], max: d[d.length - 1], mean: +(d.reduce((a, b) => a + b, 0) / d.length).toFixed(3), first10: d.slice(0, 10)}); } } requestAnimationFrame(step); }), 6000, 'raf');
  r.rafVsWallclock = await T(new Promise(res => { const w0 = performance.now(); let n = 0; function step() { if (++n < 30) requestAnimationFrame(step); else res(+(performance.now() - w0).toFixed(1)); } requestAnimationFrame(step); }), 6000, 'rafwall');
  r.setTimeout0 = await new Promise(res => { const t0 = performance.now(); setTimeout(() => res(+(performance.now() - t0).toFixed(3)), 0); });
  r.gpu = navigator.gpu ? await T(navigator.gpu.requestAdapter().then(a => a ? {vendor: a.info && a.info.vendor, architecture: a.info && a.info.architecture, device: a.info && a.info.device, description: a.info && a.info.description, isFallback: a.isFallbackAdapter} : 'null-adapter').catch(e => 'ERR:' + e), 4000, 'gpu') : 'no-navigator.gpu';
  r.hasFocusAfterAwait = document.hasFocus();
  r.idleDetector = typeof IdleDetector;
  r.storageEstimate = await T(navigator.storage.estimate().then(e => e.quota).catch(e => 'ERR:' + e), 2000, 'storage');
  return r;
})()
'''

JS_CONSOLE_PROBES = r'''
(() => {
  const out = {};
  // A: own stack getter (DataDome 2024 probe)
  let stackHits = 0; const eA = new Error('probeA');
  Object.defineProperty(eA, 'stack', {get() { stackHits++; return 'fake-stack'; }, configurable: true});
  console.debug(eA);
  // B: Error.prepareStackTrace probe (V8 lazy formatting)
  let pst = 0; const orig = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace'); const eB = new Error('probeB');
  Error.prepareStackTrace = (err, frames) => { if (err === eB) pst++; return 'pst-formatted'; };
  console.debug(eB);
  if (orig) Object.defineProperty(Error, 'prepareStackTrace', orig); else delete Error.prepareStackTrace;
  // C: inherited name getter on an Error subclass
  let nameHits = 0; class LeakErr extends Error { get name() { nameHits++; return 'LeakErr'; } }
  console.debug(new LeakErr('probeC'));
  // D: inherited message getter
  let msgHits = 0; class LeakErr2 extends Error { get message() { msgHits++; return 'probeD'; } }
  console.debug(new LeakErr2());
  // E: Proxy in prototype chain, ownKeys trap, console.groupEnd (svebaa 2026)
  let ownKeysHits = 0; const trap = new Proxy({}, {ownKeys(t) { ownKeysHits++; return Reflect.ownKeys(t); }});
  const obj = Object.create(trap); obj.a = 1; console.groupEnd(obj);
  // F: same proxy-prototype object via console.debug
  let ownKeysHits2 = 0; const trap2 = new Proxy({}, {ownKeys(t) { ownKeysHits2++; return Reflect.ownKeys(t); }});
  const obj2 = Object.create(trap2); obj2.b = 2; console.debug(obj2);
  // F2: proxy with get trap as prototype, console.debug
  let getTrapHits = 0; const trap3 = new Proxy({}, {get(t, p, rcv) { getTrapHits++; return Reflect.get(t, p, rcv); }, has(t, p) { getTrapHits++; return Reflect.has(t, p); }});
  console.debug(Object.create(trap3));
  // G: plain own getter on plain object
  let plainGetter = 0; const po = {}; Object.defineProperty(po, 'x', {get() { plainGetter++; return 1; }, enumerable: true}); console.debug(po);
  // H: Symbol.toStringTag getter
  let tagHits = 0; const to = {}; Object.defineProperty(to, Symbol.toStringTag, {get() { tagHits++; return 'Tag'; }}); console.debug(to);
  // I: Map subclass size getter / entries
  let mapHits = 0; class M extends Map { get size() { mapHits++; return 0; } } console.debug(new M([[1, 2]]));
  // J: custom toString / valueOf
  let tsHits = 0; const tso = {toString() { tsHits++; return 'x'; }, valueOf() { tsHits++; return 1; }}; console.debug(tso);
  // K: getter on array index
  let arrHits = 0; const arr = [1, 2, 3]; Object.defineProperty(arr, 1, {get() { arrHits++; return 2; }}); console.debug(arr);
  // L: Date with overridden getTime / toString
  let dateHits = 0; const dt = new Date(0); dt.toString = () => { dateHits++; return 'd'; }; dt.toISOString = () => { dateHits++; return 'iso'; }; console.debug(dt);
  // M: object with many props (preview length limits) and a getter on the 101st
  let lateHits = 0; const big = {}; for (let i = 0; i < 100; i++) big['k' + i] = i; Object.defineProperty(big, 'z', {get() { lateHits++; return 0; }, enumerable: true}); console.debug(big);
  // N: error whose cause is an object with getter
  let causeHits = 0; const causeObj = {}; Object.defineProperty(causeObj, 'q', {get() { causeHits++; return 1; }, enumerable: true}); console.debug(new Error('withcause', {cause: causeObj}));
  // O: console.table / dir / log with getter object
  let dirHits = 0; const dob = {}; Object.defineProperty(dob, 'y', {get() { dirHits++; return 1; }, enumerable: true}); console.dir(dob); console.log(dob); console.table([dob]);
  return {stackHits, prepareStackTraceHits: pst, nameHits, msgHits, ownKeysHits_groupEnd: ownKeysHits, ownKeysHits_debug: ownKeysHits2, getTrapHits, plainGetter, tagHits, mapHits, tsHits, arrHits, dateHits, lateHits, causeHits, dirHits};
})()
'''

JS_WORKER_PROBE = r'''
(() => new Promise(res => {
  const src = `
    const out = {};
    out.ua = navigator.userAgent; out.platform = navigator.platform; out.languages = navigator.languages; out.hc = navigator.hardwareConcurrency; out.dm = navigator.deviceMemory;
    out.webdriver = navigator.webdriver; out.uaBrands = navigator.userAgentData ? navigator.userAgentData.brands : null;
    let stackHits = 0; const e = new Error('w'); Object.defineProperty(e, 'stack', {get() { stackHits++; return 's'; }}); console.debug(e);
    let pst = 0; const e2 = new Error('w2'); Error.prepareStackTrace = (err) => { if (err === e2) pst++; return 'f'; }; console.debug(e2); delete Error.prepareStackTrace;
    let nameHits = 0; class LE extends Error { get name() { nameHits++; return 'LE'; } } console.debug(new LE('n'));
    setTimeout(() => { out.stackHits = stackHits; out.prepareStackTraceHits = pst; out.nameHits = nameHits; postMessage(out); }, 50);
  `;
  const w = new Worker(URL.createObjectURL(new Blob([src], {type: 'text/javascript'})));
  w.onmessage = ev => { res(ev.data); w.terminate(); };
  w.onerror = ev => res('worker-error:' + ev.message);
  setTimeout(() => res('worker-timeout'), 8000);
}))()
'''

JS_INPUT_SETUP = r'''
(() => { window.__ev = []; for (const t of ['mousemove', 'mousedown', 'mouseup', 'click', 'pointermove', 'pointerdown']) document.addEventListener(t, e => window.__ev.push({type: e.type, isTrusted: e.isTrusted, clientX: e.clientX, clientY: e.clientY, pageX: e.pageX, pageY: e.pageY, screenX: e.screenX, screenY: e.screenY, movementX: e.movementX, movementY: e.movementY, buttons: e.buttons, detail: e.detail, pointerType: e.pointerType, pressure: e.pressure, width: e.width, height: e.height, isPrimary: e.isPrimary, coalesced: e.getCoalescedEvents ? e.getCoalescedEvents().length : undefined, sourceCapabilities: e.sourceCapabilities ? e.sourceCapabilities.firesTouchEvents : 'none', timeStamp: e.timeStamp}), true); return 'ok'; })()
'''

JS_CALLSITES = r'''
(() => { const o = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace'); Error.prepareStackTrace = (e, cs) => cs.map(c => ({fn: c.getFunctionName(), file: c.getFileName(), url: c.getScriptNameOrSourceURL(), isEval: c.isEval(), evalOrigin: c.getEvalOrigin(), line: c.getLineNumber(), col: c.getColumnNumber(), isNative: c.isNative(), isToplevel: c.isToplevel(), scriptHash: typeof c.getScriptHash === 'function' ? c.getScriptHash() : undefined, typeName: c.getTypeName()})); const s = (function inner() { return new Error('cs').stack; })(); if (o) Object.defineProperty(Error, 'prepareStackTrace', o); else delete Error.prepareStackTrace; return s; })()
'''

JS_HISTORY_FLOOD = r'''
(() => { let ok = 0, err = null; for (let i = 1; i <= 300; i++) { try { history.replaceState(null, '', '#f' + i); ok++; } catch (e) { err = e.name + ':' + e.message; break; } } return {attempted: 300, noThrow: ok, finalHash: location.hash, err}; })()
'''

JS_POPUP = r'''
(() => { try { const w = window.open('about:blank', '_blank'); const opened = !!w; if (w) { try { w.close(); } catch (e) {} } return {opened}; } catch (e) { return {err: String(e)}; } })()
'''

# ----------------------------------------------------------------------------- run
def run(binary, extra, label):
    res = {'label': label, 'binary': binary, 'extra_args': extra, 'date': time.strftime('%Y-%m-%dT%H:%M:%S%z')}
    srv, hport = start_http()
    origin = 'http://127.0.0.1:%d/' % hport
    p, udd, dport = launch(binary, extra)
    cdp = None
    try:
        ver = http_json('http://127.0.0.1:%d/json/version' % dport)
        res['version'] = {k: ver.get(k) for k in ('Browser', 'Protocol-Version', 'User-Agent', 'V8-Version', 'WebKit-Version')}
        cdp = CDP(ver['webSocketDebuggerUrl'])
        targets = cdp.call('Target.getTargets')['targetInfos']
        page = [t for t in targets if t['type'] == 'page'][0]
        sid = cdp.call('Target.attachToTarget', {'targetId': page['targetId'], 'flatten': True})['sessionId']
        cdp.call('Page.enable', {}, sid)
        frame_tree = cdp.call('Page.getFrameTree', {}, sid)
        frame_id = frame_tree['frameTree']['frame']['id']

        def goto(url):
            cdp.call('Page.navigate', {'url': url}, sid)
            cdp.wait_event('Page.loadEventFired', 15)
            cdp.drain(0.2)

        goto(origin)
        # ---- 1. environment (Runtime domain NOT enabled)
        res['env'] = cdp.evaluate(JS_ENV, sid)
        res['env_async'] = cdp.evaluate(JS_ASYNC, sid, timeout=60)
        # ---- 2. console probes before Runtime.enable (baseline), then enabled, then disabled
        res['console_probe_runtime_disabled'] = cdp.evaluate(JS_CONSOLE_PROBES, sid)
        cdp.call('Runtime.enable', {}, sid)
        cdp.drain(0.5)
        cdp.take_events('Runtime.consoleAPICalled')
        res['console_probe_runtime_enabled'] = cdp.evaluate(JS_CONSOLE_PROBES, sid)
        cdp.drain(0.5)
        evs = cdp.take_events('Runtime.consoleAPICalled')
        res['consoleAPICalled_count_during_enabled_probe'] = len(evs)
        # what does the Error preview carry?
        sample = []
        for e in evs[:4]:
            args = e['params'].get('args', [])
            sample.append({'type': e['params']['type'], 'args': [{'type': a.get('type'), 'subtype': a.get('subtype'), 'className': a.get('className'), 'description': (a.get('description') or '')[:160], 'previewKeys': [pp.get('name') for pp in (a.get('preview') or {}).get('properties', [])][:12]} for a in args]})
        res['consoleAPICalled_samples'] = sample
        cdp.call('Runtime.disable', {}, sid)
        cdp.drain(0.3)
        res['console_probe_after_runtime_disable'] = cdp.evaluate(JS_CONSOLE_PROBES, sid)
        # ---- 3. stack traces from CDP-evaluated code
        res['stack_evaluate_plain'] = cdp.evaluate("(function probeFrames(){ return new Error('t').stack })()", sid)
        res['stack_evaluate_sourceURL_pptr'] = cdp.evaluate("(function probeFrames(){ return new Error('t').stack })()\n//# sourceURL=pptr:internal", sid)
        res['stack_evaluate_sourceURL_legacy'] = cdp.evaluate("(function probeFrames(){ return new Error('t').stack })()\n//# sourceURL=__puppeteer_evaluation_script__", sid)
        res['stack_evaluate_sourceURL_bare_filename'] = cdp.evaluate("(function probeFrames(){ return new Error('t').stack })()\n//# sourceURL=app.js", sid)
        win = cdp.call('Runtime.evaluate', {'expression': 'window'}, sid)
        if 'result' in win and 'objectId' in win['result']:
            r = cdp.call('Runtime.callFunctionOn', {'functionDeclaration': "function cfoFn(){ return new Error('cfo').stack }", 'objectId': win['result']['objectId'], 'returnByValue': True}, sid)
            res['stack_callFunctionOn'] = (r.get('result') or {}).get('value')
            r = cdp.call('Runtime.callFunctionOn', {'functionDeclaration': "function cfoFn(){ return new Error('cfo').stack }\n//# sourceURL=pptr:evaluate;x", 'objectId': win['result']['objectId'], 'returnByValue': True}, sid)
            res['stack_callFunctionOn_sourceURL'] = (r.get('result') or {}).get('value')
        res['callsites_evaluate'] = cdp.evaluate(JS_CALLSITES, sid)
        # ---- 4. addScriptToEvaluateOnNewDocument artifacts: main world + isolated world
        cdp.call('Page.addScriptToEvaluateOnNewDocument', {'source': "window.__necter_injected = function injectedFn(){ return new Error('inj').stack }; window.__necter_cs = " + JS_CALLSITES.strip().replace("(function inner() { return new Error('cs').stack; })()", "(function injectedInner() { return new Error('cs').stack; })()")[:-2] + ";"}, sid)
        cdp.call('Page.addScriptToEvaluateOnNewDocument', {'source': "window.__necter_iso = 1; (function mark(){ if (document.documentElement) { document.documentElement.setAttribute('data-necter-iso', 'set-from-isolated-world/' + document.readyState + '/pageScriptRan=' + typeof window.__pageScriptRan); } else { const mo = new MutationObserver(() => { if (document.documentElement) { mo.disconnect(); mark(); } }); mo.observe(document, {childList: true}); } })();", 'worldName': 'necter_util_world'}, sid)
        goto(origin)
        res['injected_main_world'] = cdp.evaluate("({typeofInjected: typeof window.__necter_injected, stack: window.__necter_injected && window.__necter_injected(), typeofIso: typeof window.__necter_iso, isoAttr: document.documentElement.getAttribute('data-necter-iso'), currentScriptAtInject: 'n/a'})", sid)
        # isolated world execution is invisible to main-world hooks
        cdp.evaluate("window.__qsCalls = 0; const _qs = document.querySelector.bind(document); document.querySelector = function(s){ window.__qsCalls++; return _qs(s); }; 'hooked'", sid)
        iso = cdp.call('Page.createIsolatedWorld', {'frameId': frame_id, 'worldName': 'necter_iso2', 'grantUniveralAccess': True}, sid)
        ctx = iso.get('executionContextId')
        res['isolated_world_eval'] = cdp.evaluate("({qsResult: !!document.querySelector('#x'), seesPageGlobal: typeof window.__qsCalls, seesInjectedMain: typeof window.__necter_injected, stack: (function isoFn(){ return new Error('iso').stack })(), uaSame: navigator.userAgent === self.navigator.userAgent, webdriver: navigator.webdriver})", sid, contextId=ctx) if ctx else iso
        res['main_world_hook_count_after_isolated_call'] = cdp.evaluate("window.__qsCalls", sid)
        res['main_world_hook_count_after_main_call'] = cdp.evaluate("document.querySelector('#x'); window.__qsCalls", sid)
        # ---- 5. Runtime.addBinding artifacts
        b = cdp.call('Runtime.addBinding', {'name': '__necter_binding'}, sid)
        res['addBinding_result'] = b
        res['addBinding_visible'] = cdp.evaluate("({t: typeof window.__necter_binding, name: window.__necter_binding && window.__necter_binding.name, src: window.__necter_binding && Function.prototype.toString.call(window.__necter_binding), desc: JSON.stringify(Object.getOwnPropertyDescriptor(window, '__necter_binding') || null, (k,v)=> typeof v === 'function' ? 'fn' : v), emptyNameNatives: Object.getOwnPropertyNames(window).filter(k => { try { const v = window[k]; return typeof v === 'function' && v.name === '' && /native code/.test(Function.prototype.toString.call(v)); } catch(e) { return false; } })})", sid)
        # ---- 6. Input.dispatchMouseEvent coordinates
        cdp.evaluate(JS_INPUT_SETUP, sid)
        for ev in [{'type': 'mouseMoved', 'x': 120, 'y': 80}, {'type': 'mouseMoved', 'x': 135, 'y': 90}, {'type': 'mousePressed', 'x': 135, 'y': 90, 'button': 'left', 'clickCount': 1}, {'type': 'mouseReleased', 'x': 135, 'y': 90, 'button': 'left', 'clickCount': 1}]:
            cdp.call('Input.dispatchMouseEvent', ev, sid)
        time.sleep(0.2)
        res['input_events'] = cdp.evaluate("({events: window.__ev, windowScreenXY: [screenX, screenY], outerMinusInner: [outerWidth - innerWidth, outerHeight - innerHeight]})", sid)
        # ---- 7. debugger statement timing: no Debugger domain vs Debugger.enable + pause
        res['debugger_stmt_ms_no_debugger_domain'] = cdp.evaluate("(() => { const t = performance.now(); debugger; return +(performance.now() - t).toFixed(3); })()", sid)
        cdp.call('Debugger.enable', {}, sid)
        mid = cdp.send('Runtime.evaluate', {'expression': "(() => { const t = performance.now(); debugger; return +(performance.now() - t).toFixed(3); })()", 'returnByValue': True}, sid)
        paused = cdp.wait_event('Debugger.paused', 5)
        if paused:
            time.sleep(0.5)
            cdp.call('Debugger.resume', {}, sid)
        r = cdp.wait(mid, 10)
        res['debugger_stmt_ms_with_Debugger_enabled_paused'] = {'paused': bool(paused), 'reason': paused and paused['params'].get('reason'), 'elapsed_ms': ((r.get('result') or {}).get('result') or {}).get('value')}
        cdp.call('Debugger.disable', {}, sid)
        # ---- 8. Emulation side effects
        res['hasFocus_before_focus_emulation'] = cdp.evaluate("document.hasFocus()", sid)
        cdp.call('Emulation.setFocusEmulationEnabled', {'enabled': True}, sid)
        res['hasFocus_after_focus_emulation'] = cdp.evaluate("document.hasFocus()", sid)
        cdp.call('Emulation.setFocusEmulationEnabled', {'enabled': False}, sid)
        res['webdriver_before_automationOverride'] = cdp.evaluate("navigator.webdriver", sid)
        cdp.call('Emulation.setAutomationOverride', {'enabled': True}, sid)
        res['webdriver_after_automationOverride'] = cdp.evaluate("navigator.webdriver", sid)
        cdp.call('Emulation.setAutomationOverride', {'enabled': False}, sid)
        res['webdriver_after_automationOverride_off'] = cdp.evaluate("navigator.webdriver", sid)
        cdp.call('Emulation.setDeviceMetricsOverride', {'width': 1280, 'height': 720, 'deviceScaleFactor': 1, 'mobile': False}, sid)
        time.sleep(0.2)
        res['metrics_after_setDeviceMetricsOverride_1280x720'] = cdp.evaluate("({inner: [innerWidth, innerHeight], outer: [outerWidth, outerHeight], screen: [screen.width, screen.height, screen.availWidth, screen.availHeight, screen.availTop, screen.availLeft], dpr: devicePixelRatio, screenXY: [screenX, screenY]})", sid)
        cdp.call('Emulation.setDeviceMetricsOverride', {'width': 1280, 'height': 720, 'deviceScaleFactor': 1, 'mobile': False, 'screenWidth': 1920, 'screenHeight': 1080}, sid)
        time.sleep(0.2)
        res['metrics_after_setDeviceMetricsOverride_with_screen_1920x1080'] = cdp.evaluate("({inner: [innerWidth, innerHeight], outer: [outerWidth, outerHeight], screen: [screen.width, screen.height, screen.availWidth, screen.availHeight, screen.availTop, screen.availLeft], dpr: devicePixelRatio, screenXY: [screenX, screenY]})", sid)
        cdp.call('Emulation.clearDeviceMetricsOverride', {}, sid)
        # user agent override without metadata
        cdp.call('Emulation.setUserAgentOverride', {'userAgent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'}, sid)
        goto(origin)
        res['ua_override_no_metadata'] = cdp.evaluate("({ua: navigator.userAgent, platform: navigator.platform, brands: navigator.userAgentData && navigator.userAgentData.brands, uaDataPlatform: navigator.userAgentData && navigator.userAgentData.platform, appVersion: navigator.appVersion})", sid)
        res['ua_override_no_metadata_high'] = cdp.evaluate("navigator.userAgentData ? navigator.userAgentData.getHighEntropyValues(['platformVersion','fullVersionList','architecture']).catch(e=>'ERR:'+e) : null", sid)
        cdp.call('Emulation.setUserAgentOverride', {'userAgent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36', 'userAgentMetadata': {'brands': [{'brand': 'Chromium', 'version': '155'}, {'brand': 'Google Chrome', 'version': '155'}, {'brand': 'Not=A?Brand', 'version': '24'}], 'fullVersionList': [], 'platform': 'Windows', 'platformVersion': '15.0.0', 'architecture': 'x86', 'model': '', 'mobile': False, 'bitness': '64', 'wow64': False}}, sid)
        goto(origin)
        res['ua_override_with_metadata'] = cdp.evaluate("({ua: navigator.userAgent, platform: navigator.platform, brands: navigator.userAgentData && navigator.userAgentData.brands, uaDataPlatform: navigator.userAgentData && navigator.userAgentData.platform, webglRenderer: (()=>{const gl=document.createElement('canvas').getContext('webgl'); const d=gl&&gl.getExtension('WEBGL_debug_renderer_info'); return d? gl.getParameter(d.UNMASKED_RENDERER_WEBGL): null})(), fontsSampleWindows: (()=>{const c=document.createElement('canvas').getContext('2d'); c.font='72px monospace'; const b=c.measureText('mmmmmmmmmmlli').width; c.font='72px \"Segoe UI\", monospace'; return c.measureText('mmmmmmmmmmlli').width!==b})()})", sid)
        cdp.call('Emulation.setUserAgentOverride', {'userAgent': ''}, sid)
        # ---- 9. Fetch.fulfillRequest document interception -> navigation timing
        goto(origin)
        res['nav_timing_normal'] = cdp.evaluate("(()=>{const e=performance.getEntriesByType('navigation')[0]; return {nextHopProtocol: e.nextHopProtocol, transferSize: e.transferSize, encodedBodySize: e.encodedBodySize, decodedBodySize: e.decodedBodySize, deliveryType: e.deliveryType, workerStart: e.workerStart, responseStatus: e.responseStatus, type: e.type, serverTiming: e.serverTiming.length, rt: e.responseEnd - e.requestStart}})()", sid)
        cdp.call('Fetch.enable', {'patterns': [{'urlPattern': '*', 'resourceType': 'Document', 'requestStage': 'Request'}]}, sid)
        mid = cdp.send('Page.navigate', {'url': origin + 'fulfilled'}, sid)
        rp = cdp.wait_event('Fetch.requestPaused', 10)
        if rp:
            body = base64.b64encode(b'<!doctype html><html><body><div id=x>fulfilled</div></body></html>').decode()
            cdp.call('Fetch.fulfillRequest', {'requestId': rp['params']['requestId'], 'responseCode': 200, 'responseHeaders': [{'name': 'Content-Type', 'value': 'text/html'}], 'body': body}, sid)
        cdp.wait(mid, 10)
        cdp.wait_event('Page.loadEventFired', 10)
        res['nav_timing_fulfilled_by_Fetch'] = cdp.evaluate("(()=>{const e=performance.getEntriesByType('navigation')[0]; return {nextHopProtocol: e.nextHopProtocol, transferSize: e.transferSize, encodedBodySize: e.encodedBodySize, decodedBodySize: e.decodedBodySize, deliveryType: e.deliveryType, workerStart: e.workerStart, responseStatus: e.responseStatus, type: e.type, serverTiming: e.serverTiming.length, rt: e.responseEnd - e.requestStart, protocolViaResource: null}})()", sid)
        cdp.call('Fetch.disable', {}, sid)
        goto(origin)
        # ---- 10. popup blocking / IPC flooding
        res['popup_without_gesture'] = cdp.evaluate(JS_POPUP, sid)
        res['history_flood'] = cdp.evaluate(JS_HISTORY_FLOOD, sid)
        # ---- 11. workers: with auto-attach + Runtime.enable in the worker session (Puppeteer/Playwright style)
        cdp.call('Target.setAutoAttach', {'autoAttach': True, 'waitForDebuggerOnStart': True, 'flatten': True}, sid)
        mid = cdp.send('Runtime.evaluate', {'expression': JS_WORKER_PROBE, 'awaitPromise': True, 'returnByValue': True}, sid)
        worker_sessions = []
        t0 = time.time()
        while mid not in cdp.pending and time.time() - t0 < 15:
            try:
                cdp.pump(5)
            except socket.timeout:
                continue
            for e in cdp.take_events('Target.attachedToTarget'):
                ti = e['params'].get('targetInfo', {})
                if ti.get('type') in ('worker', 'service_worker', 'shared_worker'):
                    wsid = e['params']['sessionId']
                    worker_sessions.append(ti.get('type'))
                    cdp.send('Runtime.enable', {}, wsid)
                    cdp.send('Runtime.runIfWaitingForDebugger', {}, wsid)
        r = cdp.pending.pop(mid, {})
        res['worker_probe_with_worker_Runtime_enabled'] = {'attached_worker_sessions': worker_sessions, 'result': ((r.get('result') or {}).get('result') or {}).get('value')}
        cdp.call('Target.setAutoAttach', {'autoAttach': False, 'waitForDebuggerOnStart': False, 'flatten': True}, sid)
        res['worker_probe_without_worker_session'] = cdp.evaluate(JS_WORKER_PROBE, sid, timeout=20)
        # ---- 12. command line as seen by chrome://version is not reachable; record argv
        res['argv'] = p.args
    except Exception as ex:
        res['__error'] = traceback.format_exc()
    finally:
        try:
            if cdp:
                cdp.call('Browser.close', {})
        except Exception:
            pass
        try:
            p.terminate(); p.wait(5)
        except Exception:
            try:
                p.kill()
            except Exception:
                pass
        srv.shutdown()
        shutil.rmtree(udd, ignore_errors=True)
    return res

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('binary')
    ap.add_argument('--extra', default='')
    ap.add_argument('--label', default='run')
    ap.add_argument('--out', default=None)
    a = ap.parse_args()
    import shlex
    out = run(a.binary, shlex.split(a.extra), a.label)
    txt = json.dumps(out, indent=1, default=str)
    if a.out:
        open(a.out, 'w').write(txt)
    print(txt)
