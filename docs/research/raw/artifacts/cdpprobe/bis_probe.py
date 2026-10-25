#!/usr/bin/env python3
"""Find which sub-expression of the env probe hangs on a given binary."""
import sys, time, json, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import probe

binary = sys.argv[1]
srv, hport = probe.start_http()
origin = 'http://127.0.0.1:%d/' % hport
p, udd, dport = probe.launch(binary, [])
try:
    ver = probe.http_json('http://127.0.0.1:%d/json/version' % dport)
    print('browser', ver.get('Browser'))
    cdp = probe.CDP(ver['webSocketDebuggerUrl'])
    targets = cdp.call('Target.getTargets')['targetInfos']
    page = [t for t in targets if t['type'] == 'page'][0]
    sid = cdp.call('Target.attachToTarget', {'targetId': page['targetId'], 'flatten': True})['sessionId']
    cdp.call('Page.enable', {}, sid)
    cdp.call('Page.navigate', {'url': origin}, sid)
    cdp.wait_event('Page.loadEventFired', 15)
    tests = [
        ('ua', 'navigator.userAgent'),
        ('webdriver', 'navigator.webdriver'),
        ('languages', 'JSON.stringify(navigator.languages)'),
        ('connection', 'JSON.stringify(navigator.connection && {rtt: navigator.connection.rtt})'),
        ('tz', 'Intl.DateTimeFormat().resolvedOptions().timeZone'),
        ('dims', 'JSON.stringify([innerWidth, innerHeight, outerWidth, outerHeight, screenX, screenY, screen.width, screen.height, screen.availTop, screen.isExtended])'),
        ('hasFocus', 'document.hasFocus()'),
        ('chrome', 'JSON.stringify(window.chrome && Object.keys(window.chrome))'),
        ('notification', 'Notification.permission'),
        ('plugins', 'navigator.plugins.length'),
        ('matchMedia', "JSON.stringify(['fine','coarse','none'].filter(v => matchMedia(`(any-pointer:${v})`).matches))"),
        ('webgl', "(()=>{const gl=document.createElement('canvas').getContext('webgl'); const d=gl&&gl.getExtension('WEBGL_debug_renderer_info'); return d? gl.getParameter(d.UNMASKED_RENDERER_WEBGL): String(gl)})()"),
        ('webgl2', "!!document.createElement('canvas').getContext('webgl2')"),
        ('audio', "(()=>{const ac=new AudioContext(); const o=JSON.stringify({s:ac.state, sr:ac.sampleRate, bl:ac.baseLatency, ol:ac.outputLatency}); ac.close(); return o})()"),
        ('voicesSync', 'speechSynthesis.getVoices().length'),
        ('uaData', 'JSON.stringify(navigator.userAgentData && navigator.userAgentData.brands)'),
        ('globals', "Object.getOwnPropertyNames(window).length"),
        ('perfNow', "(()=>{let min=Infinity,a=performance.now(); for(let i=0;i<5000;i++){const b=performance.now(); if(b>a){if(b-a<min)min=b-a; a=b;}} return min})()"),
        ('codecs', "document.createElement('video').canPlayType('video/mp4; codecs=\"avc1.42E01E\"')"),
        ('fonts', "(()=>{const c=document.createElement('canvas').getContext('2d'); c.font='72px monospace'; return c.measureText('mmmmmmmmmmlli').width})()"),
        ('canvas', "(()=>{const c=document.createElement('canvas'); c.width=240; c.height=60; const x=c.getContext('2d'); x.fillText('abc',2,15); return c.toDataURL().length})()"),
        ('battery', 'typeof navigator.getBattery'),
        ('permissionsToString', 'Function.prototype.toString.call(Permissions.prototype.query)'),
        ('sab', 'typeof SharedArrayBuffer'),
    ]
    for name, expr in tests:
        t0 = time.time()
        try:
            r = cdp.call('Runtime.evaluate', {'expression': expr, 'returnByValue': True, 'timeout': 5000}, sid, timeout=8)
            val = (r.get('result') or {}).get('value') if 'result' in r else r
            print('%-20s %6.0fms %s' % (name, (time.time() - t0) * 1000, json.dumps(val, default=str)[:200]))
        except Exception as ex:
            print('%-20s HUNG/ERR after %.0fms: %s' % (name, (time.time() - t0) * 1000, ex))
            break
finally:
    try:
        p.terminate(); p.wait(5)
    except Exception:
        p.kill()
    srv.shutdown()
