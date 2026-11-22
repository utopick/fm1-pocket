"""The Android app's path in the page: a fake window.FM1Native and a fake /native/poll, no emulator.

    python3 pocket/build.py && python pocket/tests/native.py      (needs: pip install selenium, Chrome; no firmware needed)

Checks that powering on sends "boot" to FM1Native.boot (JSON without the binaries, then the package as base64), that other messages go
through FM1Native.post, that a polled "booted" and a polled frame (in the poll's binary format) reach the page, and that powering off stops the poll.
"""
import base64, functools, http.server, os, threading, time
from selenium import webdriver

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(type("Q", (http.server.SimpleHTTPRequestHandler,), {"log_message": lambda *a: None}), directory=ROOT))
threading.Thread(target=srv.serve_forever, daemon=True).start()
o = webdriver.ChromeOptions()
for a in ("--headless=new", "--mute-audio", "--lang=en-US"): o.add_argument(a)
d = webdriver.Chrome(options=o)
js = d.execute_script
FAKE = """
window.__calls = []; window.__queue = []; window.__polls = 0; window.__errs = [];
addEventListener('error', e => __errs.push(String(e.message)));
window.FM1Native = { post: j => __calls.push(['post', j]), boot: (j, p, s, x) => __calls.push(['boot', j, p.length, s, x]), version: () => 'fake', page: () => __calls.push(['page']), fx: on => __calls.push(['fx', on]) };
// the poll's answer: u32 count, then per message u32 jsonLen, json, u32 blobs, each u32 nameLen, name, u32 typeLen, type, u32 byteLen, bytes
window.pack = (msgs) => {
  const parts = [], enc = new TextEncoder(), u32 = n => new Uint8Array(new Uint32Array([n]).buffer), str = s => [u32(enc.encode(s).length), enc.encode(s)];
  parts.push(u32(msgs.length));
  for (const [m, blobs] of msgs) {
    parts.push(...str(JSON.stringify(m)), u32(Object.keys(blobs).length));
    for (const [name, [type, arr]] of Object.entries(blobs)) parts.push(...str(name), ...str(type), u32(arr.byteLength), new Uint8Array(arr.buffer));
  }
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0;
  for (const p of parts) (out.set(p, o), o += p.length);
  return out.buffer;
};
const realFetch = fetch;
window.__pcm = 0;  // /native/pcm: 1024 frames of a sine each time, as the app's muted sound
window.fetch = (u, ...r) => String(u).endsWith('/native/poll') ? (__polls++, Promise.resolve(new Response(__queue.length ? __queue.shift() : pack([]))))
  : String(u).endsWith('/native/pcm') ? (__pcm++, Promise.resolve(new Response(new Float32Array(2048).map((_, i) => 0.5 * Math.sin(i / 20)).buffer))) : realFetch(u, ...r);
"""
try:
    d.execute_cdp_cmd("Emulation.setDeviceMetricsOverride", {"width": 844, "height": 390, "deviceScaleFactor": 1, "mobile": True})
    d.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {"source": FAKE})
    d.get("http://127.0.0.1:%d/index.html" % srv.server_address[1]); time.sleep(1.5)
    assert js("return document.documentElement.classList.contains('native')"), "the page does not know it is in the app"
    assert js("return ['inst', 'optSound', 'railSound'].every(i => getComputedStyle(document.getElementById(i)).display === 'none')"), "browser-only options are still shown"
    pkg = open(os.path.join(ROOT, "vendor", "tether.fwsc"), "rb").read()
    js("FIRMWARES[0].bytes = Uint8Array.from(atob(arguments[0]), c => c.charCodeAt(0)); document.querySelector('#fw').value = FIRMWARES[0].id", base64.b64encode(pkg).decode())
    js("document.querySelector('#power').click()")
    for _ in range(40):
        time.sleep(0.25)
        boots = js("return __calls.filter(c => c[0] === 'boot')")
        if boots: break
    assert boots, "no boot reached FM1Native: %s %s" % (js("return __calls"), js("return __errs"))
    _, j, plen, sectors, syx = boots[0]
    meta = js("return JSON.parse(arguments[0])", j)
    assert meta["type"] == "boot" and meta["mhz"] > 0 and meta["seq"] > 0 and not ({"wasm", "package", "sectors", "syx"} & set(meta)), meta
    assert plen == len(base64.b64encode(pkg)) and sectors == "" and syx == "", (plen, sectors, syx)
    assert any(c[0] == "post" and '"pot"' in c[1] for c in js("return __calls")), "the MASTER knob value was not sent"
    assert js("return __polls") > 0, "no poll"
    seq = meta["seq"]
    # the native core answers: booted (flash as Uint8Array), then a frame with an LCD in colours and a peak
    js("""const seq = arguments[0], lcd = new Uint16Array(240 * 240).map((_, i) => (i * 37) & 0xffff), leds = new Float32Array(41), flash = new Uint8Array(16);
      __queue.push(pack([[{type: 'booted', seq, board: 0, revision: 1}, {base: ['Uint8Array', flash], flash: ['Uint8Array', flash]}]]));
      __queue.push(pack([[{type: 'frame', seq, ms: 10, short: 0, halted: false, jit: null, playing: true, busy: 1, worst: 1, emulated: 33, idle: 0, starved: 0, quanta: 10, frames: 128, peak: 0.5},
        {lcd: ['Uint16Array', lcd], leds: ['Float32Array', leds]}]]));""", seq)
    for _ in range(40):
        time.sleep(0.25)
        if js("return document.querySelector('#lcd').getContext('2d').getImageData(0, 0, 240, 240).data.some((v, i) => i % 4 === 0 && v > 0)") and js("return peak") > 0: break
    else: raise AssertionError("the polled frame did not reach the screen: " + js("return document.querySelector('#status').textContent"))
    js("setKey(0, true)")
    time.sleep(0.3)
    assert any(c[0] == "post" and '"key"' in c[1] for c in js("return __calls")), "a key did not go through FM1Native.post: %s" % js("return __calls.map(c => c[1])")
    # PEDALS in the app: a pedal on tells the app to hand its sound over, the page fetches it and plays it through the chain; all off gives it back
    assert js("return getComputedStyle(document.getElementById('xpDock')).display") != "none", "the PEDALS and LIVE FX tabs are hidden in the app"
    assert js("return __pcm") == 0, "the sound is fetched while nothing is on"
    js("rack.u.od.on = true; fxSync()"); time.sleep(1.5)
    assert ["fx", True] in js("return __calls") and js("return __pcm") > 10 and js("return fxInfo().active"), (js("return __calls.filter(c => c[0] === 'fx')"), js("return __pcm"))
    js("rack.u.od.on = false; fxSync()"); time.sleep(0.3); n = js("return __pcm"); time.sleep(0.5)
    assert js("return __calls.filter(c => c[0] === 'fx').pop()") == ["fx", False] and js("return __pcm") == n, "the sound is still taken after all is off"
    # an error shows the page over the app's native play screen
    js("__queue.push(pack([[{type: 'error', seq: arguments[0], message: 'test error'}, {}]]))", seq); time.sleep(0.5)
    assert ["page"] in js("return __calls"), "an error did not bring the page forward"
    # the app's native play screen covers the page: it polls about 4 times a second, then as often as before
    js("nativeSlow(true)"); time.sleep(0.3); n = js("return __polls"); time.sleep(1)
    slow = js("return __polls") - n
    js("nativeSlow(false)"); n = js("return __polls"); time.sleep(1)
    fast = js("return __polls") - n
    assert 2 <= slow <= 6 and fast > 20, (slow, fast)
    js("document.querySelector('#power').click()")
    time.sleep(0.3); n = js("return __polls"); time.sleep(0.5)
    assert js("return __polls") == n, "the poll goes on after power off"
    assert js("return __calls.filter(c => c[0] === 'fx').pop()") == ["fx", False]
    assert any(c[0] == "post" and "cancel-boot" in c[1] for c in js("return __calls")), "power off did not stop the native core"
    assert js("return __errs") == [], js("return __errs")
    print("native bridge ok")
finally:
    d.quit()
