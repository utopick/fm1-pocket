"""Smoke test of pocket/index.html: the three views, the keys, the skins, a firmware that boots, sounds and is kept.

    python3 pocket/build.py && python pocket/tests/smoke.py path/to/firmware.fwsc    (needs: pip install selenium, Chrome)

The package is not in the repo (firmwares belong to their authors): download one from thefirmwarehub.com.
SHOT=/some/folder saves a screenshot of each view there.
"""
import functools, http.server, os, sys, threading, time
from selenium import webdriver
from selenium.webdriver.common.by import By

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
fwsc = os.path.abspath(sys.argv[1])
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(type("Q", (http.server.SimpleHTTPRequestHandler,), {"log_message": lambda *a: None}), directory=ROOT))
threading.Thread(target=srv.serve_forever, daemon=True).start()
o = webdriver.ChromeOptions()
for a in ("--headless=new", "--autoplay-policy=no-user-gesture-required"): o.add_argument(a)
d = webdriver.Chrome(options=o)
d.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {"source": "window.__errs = []; addEventListener('error', e => __errs.push(String(e.message))); addEventListener('unhandledrejection', e => __errs.push('promise: ' + (e.reason && e.reason.message || e.reason)));"})
js = d.execute_script
q = lambda s: js("return document.querySelector(arguments[0]).textContent", s)
def size(w, h, name):
    d.execute_cdp_cmd("Emulation.setDeviceMetricsOverride", {"width": w, "height": h, "deviceScaleFactor": 2, "mobile": True}); time.sleep(0.4)
    if os.environ.get("SHOT"): d.save_screenshot(os.path.join(os.environ["SHOT"], name + ".png"))
# every control of the device that is shown: inside the window, and big enough for a finger (the keys may be narrow)
def shown(sel):
    return js("""return [...document.querySelectorAll(arguments[0])].filter(e => e.offsetParent).map(e => e.getBoundingClientRect())
      .filter(r => r.width >= 14 && r.height >= 14 && r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1).length""", sel)
def parts(up, keys, why):
    got = [shown("#up .kn"), shown("#up .pb"), shown("#kb .k")]
    assert got == [8 * up, 14 * up, 27 * keys], "%s: knobs, buttons, keys shown = %s" % (why, got)
colours = "return new Set(new Uint32Array(document.querySelector('#lcd').getContext('2d').getImageData(0, 0, 240, 240).data.buffer)).size"
def power_on():
    js("document.querySelector('#power').click()")
    for _ in range(60):  # the firmware draws its screen
        time.sleep(0.5)
        if js(colours) > 2: return
    raise AssertionError("the screen stayed blank: " + q("#status"))
try:
    size(390, 844, "0")
    d.get("http://127.0.0.1:%d/index.html" % srv.server_address[1]); time.sleep(1.5)
    bare = js("return [...document.querySelectorAll('button, select')].filter(b => !b.title).map(b => b.id || b.textContent)")
    assert bare == [], "controls without a title: %s" % bare
    assert js("return FIRMWARES.length") > 20 and js("return vetCatalog([{id: 'x', name: '<b>', package: 'javascript:1'}, {id: 'ok', name: 'n', package: 'https://a.b/c', about: 7}])") == [{"id": "ok", "name": "n", "version": "", "author": "", "license": "", "about": "", "package": "https://a.b/c"}]

    # vertical: the whole FM-1 rearranged, the keys in two rows
    parts(1, 1, "vertical"); assert js("return document.querySelectorAll('.krow').length") == 2
    size(390, 844, "vertical")
    # a phone held upright: the sideways view, drawn turned (one row of keys, the screen still square and inside the window)
    d.execute_cdp_cmd("Emulation.setTouchEmulationEnabled", {"enabled": True, "maxTouchPoints": 5}); time.sleep(0.4)
    parts(1, 1, "phone upright"); assert shown("#R #rail button") == 3, "the rail is not above the knobs"; assert js("return document.querySelectorAll('.krow').length") == 1
    r = js("const r = document.querySelector('#scr').getBoundingClientRect(); return [r.width, r.height, r.right, r.bottom]")
    assert abs(r[0] - r[1]) < 1 and r[0] > 150 and r[2] <= 390 and r[3] <= 844, r
    size(390, 844, "phone-upright")
    d.execute_cdp_cmd("Emulation.setTouchEmulationEnabled", {"enabled": False}); time.sleep(0.4)
    # sideways, complete, then switchable: the upper part or the keys
    size(844, 390, "complete"); parts(1, 1, "complete"); assert js("return document.querySelectorAll('.krow').length") == 1
    js("document.querySelector('#view').click()"); parts(1, 0, "switchable, upper part"); size(844, 390, "switch-top")
    js("document.querySelector('#flip').click()"); parts(0, 1, "switchable, keys"); assert shown("#fm > #rail button") == 4, "no rail over the keys"
    js("document.querySelector('#keys').click()"); assert js("return document.body.dataset.keys") == "piano"; parts(0, 1, "piano keys"); size(844, 390, "switch-piano")
    fx = []
    for _ in range(3): js("document.querySelector('#fx').click()"); fx.append(js("return document.body.dataset.fx + getComputedStyle(document.querySelector('#lcd')).filter"))
    assert len(set(fx)) == 3 and fx[-1].startswith("lcd"), "the screen filters do not cycle: %s" % fx
    skins = []
    for _ in range(13): js("document.querySelector('#skin').click()"); skins.append(js("return document.documentElement.dataset.skin + getComputedStyle(document.body).backgroundColor"))
    assert len(set(skins)) == 13 and skins[-1].startswith("black"), "the skins do not cycle: %s" % skins

    # a firmware from a file: it boots, shows its screen, and sounds from the keys and from MIDI IN
    d.find_element(By.ID, "file").send_keys(fwsc); time.sleep(0.5)
    assert js("return document.querySelector('#fw').value") == "local"
    power_on(); lit = js(colours)
    loud = 0
    for how in ("setKey(21, true); setKey(25, true)", "midiIn([0x90, 60, 110]); midiIn([0x90, 67, 110])"):
        js("peak = 0; " + how); time.sleep(2.5); loud = max(loud, js("return peak"))
        js("setKey(21, false); setKey(25, false); midiIn([0x80, 60, 0]); midiIn([0x80, 67, 0])")
    assert loud > 0.005, "no sound from the keys or from MIDI IN"
    # a finger on a key holds it, and lets go
    k = d.find_element(By.CSS_SELECTOR, '.k[data-k="30"]')
    webdriver.ActionChains(d).move_to_element(k).click_and_hold().perform(); assert js("return down[30]") == 1
    webdriver.ActionChains(d).release().perform(); assert js("return down[30]") == 0
    js("turn(0, 3); setPot(900)")
    # what the firmware writes to its flash is kept, and given back to it when it starts again
    js("const f = run.base.slice(); f[8192] ^= 255; keepFlash(f)"); time.sleep(0.5)
    status = q("#status")

    # after a reload: the look, the file and its save are still there, and it boots with no network
    d.refresh(); time.sleep(1.5)
    assert js("return [document.body.dataset.view, document.body.dataset.keys, document.querySelector('#fw').value]") == ["switchable", "piano", "local"]
    d.execute_cdp_cmd("Network.enable", {}); d.execute_cdp_cmd("Network.emulateNetworkConditions", {"offline": True, "latency": 0, "downloadThroughput": -1, "uploadThroughput": -1})
    power_on(); assert "saves loaded" in q("#status"), q("#status")
    js("document.querySelector('#view').click(); document.querySelector('#keys').click()")
    print("status: %s -> %s | screen colours: %d | peak: %.3f | errors: %s" % (status, q("#status"), lit, loud, js("return __errs")))
    assert js("return __errs") == [], "errors on the page"
    print("OK")
finally:
    d.quit(); srv.shutdown()
