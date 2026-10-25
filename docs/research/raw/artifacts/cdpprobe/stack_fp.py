#!/usr/bin/env python3
"""Compare Error().stack frames when a page-defined hook is invoked from: page script,
new Function / eval / setTimeout(string) in page script, and from CDP (evaluate / callFunctionOn,
with and without sourceURL). Output is what a page-side detector would see."""
import sys, os, json, time, http.server, threading
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import probe

APP_JS = r'''
window.__calls = [];
const origQS = document.querySelector.bind(document);
document.querySelector = function hookedQuerySelector(sel) {
  window.__calls.push({sel, stack: new Error('hook').stack});
  return origQS(sel);
};
function pageCaller() { return document.querySelector('#p1'); }
window.triggerFromPage = pageCaller;
window.triggerFromNewFunction = new Function("return document.querySelector('#p2')");
window.triggerFromEval = function () { return eval("document.querySelector('#p3')"); };
window.triggerFromTimeoutString = function () { setTimeout("document.querySelector('#p4')", 0); };
window.triggerFromBlobScript = function () { const b = new Blob(["document.querySelector('#p5')"], {type: 'text/javascript'}); const s = document.createElement('script'); s.src = URL.createObjectURL(b); document.head.appendChild(s); };
window.triggerFromDataScript = function () { const s = document.createElement('script'); s.src = 'data:text/javascript,document.querySelector("%23p6")'; document.head.appendChild(s); };
'''
HTML = b'''<!doctype html><html><head><meta charset=utf-8></head><body><div id=x></div>
<script src="/app.js"></script>
<script>document.querySelector('#inline'); triggerFromPage(); triggerFromNewFunction(); triggerFromEval(); triggerFromTimeoutString(); triggerFromBlobScript(); triggerFromDataScript();</script>
</body></html>'''

class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass
    def do_GET(self):
        if self.path.startswith('/app.js'):
            body, ct = APP_JS.encode(), 'text/javascript'
        else:
            body, ct = HTML, 'text/html'
        self.send_response(200)
        self.send_header('Content-Type', ct)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
origin = 'http://127.0.0.1:%d/' % srv.server_address[1]
binary = sys.argv[1]
p, udd, dport = probe.launch(binary, [])
try:
    ver = probe.http_json('http://127.0.0.1:%d/json/version' % dport)
    cdp = probe.CDP(ver['webSocketDebuggerUrl'])
    page = [t for t in cdp.call('Target.getTargets')['targetInfos'] if t['type'] == 'page'][0]
    sid = cdp.call('Target.attachToTarget', {'targetId': page['targetId'], 'flatten': True})['sessionId']
    cdp.call('Page.enable', {}, sid)
    cdp.call('Page.navigate', {'url': origin + 'stack'}, sid)
    cdp.wait_event('Page.loadEventFired', 15)
    time.sleep(0.4)
    # CDP-driven invocations
    cdp.evaluate("document.querySelector('#cdp-evaluate')", sid)
    cdp.evaluate("document.querySelector('#cdp-evaluate-pptr')\n//# sourceURL=pptr:evaluate;Page.evaluate", sid)
    cdp.evaluate("document.querySelector('#cdp-evaluate-legacy')\n//# sourceURL=__puppeteer_evaluation_script__", sid)
    win = cdp.call('Runtime.evaluate', {'expression': 'window'}, sid)['result']['objectId']
    cdp.call('Runtime.callFunctionOn', {'functionDeclaration': "function(){ return document.querySelector('#cdp-callFunctionOn') }", 'objectId': win}, sid)
    # Playwright-like: utility-script style wrapper (anonymous arrow calling a method)
    cdp.evaluate("((utilityScript, ...args) => utilityScript.evaluate(...args))({evaluate(fn){ return fn() }}, () => document.querySelector('#cdp-utilityscript-like'))", sid)
    # isolated world: main-world hook must not see it
    fid = cdp.call('Page.getFrameTree', {}, sid)['frameTree']['frame']['id']
    ctx = cdp.call('Page.createIsolatedWorld', {'frameId': fid, 'worldName': 'iso', 'grantUniveralAccess': True}, sid).get('executionContextId')
    cdp.evaluate("document.querySelector('#from-isolated-world')", sid, contextId=ctx)
    # DOM.querySelector via CDP DOM domain (no JS at all)
    doc = cdp.call('DOM.getDocument', {}, sid)
    cdp.call('DOM.querySelector', {'nodeId': doc['root']['nodeId'], 'selector': '#x'}, sid)
    time.sleep(0.3)
    calls = cdp.evaluate("window.__calls", sid)
    print('browser', ver.get('Browser'), 'origin', origin)
    for c in calls:
        print('\n--- selector:', c['sel'])
        print(c['stack'])
    # CallSite view of a CDP-invoked frame vs page frame
    cs = cdp.evaluate(r'''(() => { const o = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace'); Error.prepareStackTrace = (e, cs) => cs.map(c => ({fn: c.getFunctionName(), file: c.getFileName(), url: c.getScriptNameOrSourceURL(), isEval: c.isEval(), evalOrigin: c.getEvalOrigin(), hash: c.getScriptHash && c.getScriptHash(), native: c.isNative()})); const out = {}; try { out.fromPage = (function(){ const prev = document.querySelector; let got; document.querySelector = function(){ got = new Error().stack; return null; }; try { triggerFromPage(); triggerFromNewFunction(); } finally { document.querySelector = prev; } return got; })(); } catch (e) { out.err = String(e); } out.fromCdp = new Error().stack; if (o) Object.defineProperty(Error, 'prepareStackTrace', o); else delete Error.prepareStackTrace; return out; })()''', sid)
    print('\n=== CallSite structured view (last page-triggered hook call, and a CDP frame):')
    print(json.dumps(cs, indent=1)[:4000])
finally:
    try:
        p.terminate(); p.wait(5)
    except Exception:
        p.kill()
    srv.shutdown()
