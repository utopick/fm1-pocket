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
    parts(1, 1, "vertical"); assert js("return document.querySelectorAll('#kb .krow').length") == 2
    size(390, 844, "vertical")
    # a phone held upright: the sideways view, drawn turned (one row of keys, the screen still square and inside the window)
    d.execute_cdp_cmd("Emulation.setTouchEmulationEnabled", {"enabled": True, "maxTouchPoints": 5}); time.sleep(0.4)
    parts(1, 1, "phone upright"); assert shown("#up > #rail button") == 3, "the rail is not beside the upper part"; assert js("return document.querySelectorAll('#kb .krow').length") == 1
    r = js("const r = document.querySelector('#scr').getBoundingClientRect(); return [r.width, r.height, r.right, r.bottom]")
    assert abs(r[0] - r[1]) < 1 and r[0] > 150 and r[2] <= 390 and r[3] <= 844, r
    size(390, 844, "phone-upright")
    d.execute_cdp_cmd("Emulation.setTouchEmulationEnabled", {"enabled": False}); time.sleep(0.4)
    # sideways: the one button goes round the whole FM-1, the keys, the upper part
    size(844, 390, "complete"); parts(1, 1, "complete"); assert js("return document.querySelectorAll('#kb .krow').length") == 1
    flip = lambda: js("document.querySelector('#flip').click()")
    flip(); flip(); parts(1, 0, "upper part"); size(844, 390, "switch-top")
    flip(); parts(1, 1, "complete again"); flip(); parts(0, 1, "keys"); assert shown("#fm > #rail button") == 3, "no rail over the keys"
    # LOOK: each chooser is a button that shows what it gives
    choose = lambda pane, v: js("document.querySelector(arguments[0] + ' .pick[data-v=\"' + arguments[1] + '\"]').click()", pane, v)
    choose("#pvKeys", "piano"); assert js("return document.querySelector('#kb').dataset.keys") == "piano"; parts(0, 1, "piano keys"); size(844, 390, "switch-piano")
    fx = []
    for v in ("crt", "off", "lcd"): choose("#pvFx", v); fx.append(js("return document.querySelector('#scr').dataset.fx + getComputedStyle(document.querySelector('#lcd')).filter"))
    assert len(set(fx)) == 3 and fx[-1].startswith("lcd"), "the screen filters do not change: %s" % fx
    names = js("return [...document.querySelectorAll('#pvSkin .pick')].map(b => b.dataset.v)"); skins = []
    for v in names[1:] + names[:1]: choose("#pvSkin", v); skins.append(js("return document.documentElement.dataset.skin + getComputedStyle(document.body).backgroundColor"))
    assert len(set(skins)) == 13 and skins[-1].startswith("black"), "the skins do not change: %s" % skins
    assert js("return [...document.querySelectorAll('#pvSkin .mini')].map(m => getComputedStyle(m).backgroundImage + getComputedStyle(m.querySelector('.mb')).backgroundImage).filter((x, i, a) => a.indexOf(x) === i).length") == 13, "the skin cards do not show their own colours"
    # the menu: the whole screen, four tabs, nothing wider or taller than the window (only the firmware list scrolls)
    js("document.querySelector('#logo').click()")
    for t in ("fw", "look", "conn", "info"):
        js("document.querySelector('#menu .tabs [data-tab=%s]').click()" % t); time.sleep(0.1)
        fit = js("const m = document.querySelector('#menu'), s = m.querySelector('section[data-tab=' + arguments[0] + ']'), r = m.getBoundingClientRect(); return [s.offsetParent !== null, r.width, r.height, s.scrollHeight <= s.clientHeight + 1, [...m.querySelectorAll('section')].filter(x => x.offsetParent).length]", t)
        assert fit == [True, 844, 390, True, 1], "menu tab %s: %s" % (t, fit)
        if os.environ.get("SHOT"): d.save_screenshot(os.path.join(os.environ["SHOT"], "menu-" + t + ".png"))
    for sub in ("keys", "fx", "skin"):  # each chooser fills its tab, and what is in use is marked
        js("document.querySelector('#menu .tabs [data-tab=look]').click(); document.querySelector('#' + arguments[0]).click()", sub); time.sleep(0.1)
        got = js("const p = [...document.querySelectorAll('#menu .pane')].filter(x => x.offsetParent); return [p.length, p[0].getBoundingClientRect().height > 180, p[0].querySelectorAll('.pick.on').length]")
        assert got == [1, True, 1], "look, %s: %s" % (sub, got)
        if os.environ.get("SHOT"): d.save_screenshot(os.path.join(os.environ["SHOT"], "menu-look-" + sub + ".png"))
    js("document.querySelector('#menu .tabs [data-tab=fw]').click()")
    assert js("return document.querySelectorAll('#fwList .fwc').length") > 20 and js("return document.querySelectorAll('#fwList .fwc.on').length") == 1
    tops = js("return [...document.querySelectorAll('#fwList .fwc')].slice(0, 5).map(c => Math.round(c.getBoundingClientRect().top))")
    assert len(set(tops[:4])) == 1 and tops[4] > tops[0], "not four cards to a row: %s" % tops
    # a dangerous action asks first: half a slide does nothing, CANCEL closes, the whole slide does it
    slide = lambda v: js("const s = document.querySelector('#sureSlide'); s.value = arguments[0]; s.onchange()", v)
    js("kept.add('zzz'); document.querySelector('#forget').click()"); assert not js("return document.querySelector('#sure').hidden")
    slide(60); assert js("return [document.querySelector('#sure').hidden, kept.has('zzz'), document.querySelector('#sureSlide').value]") == [False, True, "0"]
    js("document.querySelector('#sureNo').click()"); assert js("return [document.querySelector('#sure').hidden, kept.has('zzz')]") == [True, True]
    js("document.querySelector('#forget').click()"); slide(100); time.sleep(0.5); assert js("return [document.querySelector('#sure').hidden, kept.has('zzz')]") == [True, False]
    js("document.querySelector('#menuClose').click()"); assert js("return document.querySelector('#menu').hidden")
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
    # a controller: an MPK's knob 1 (CC 2) turns KNOB1, its pad 1 (note 36, channel 10) holds HOME, its keys go to MIDI IN
    js("MI.names = ['MPK mini']; window.c0 = clicks[3]; midiMsg([0xb0, 2, 10], 'MPK mini'); midiMsg([0xb0, 2, 30], 'MPK mini')")
    assert js("return clicks[3] - c0") == 5, "the knob did not turn KNOB1"
    js("midiMsg([0x99, 36, 100], 'MPK mini')"); assert js("return down[8]") == 1
    js("midiMsg([0x89, 36, 0], 'MPK mini')"); assert js("return down[8]") == 0
    js("document.querySelector('#midiDev').click()"); assert js("return document.querySelectorAll('#mdPanel svg [data-control]').length") > 30, "no drawing of the controller"
    js("document.querySelector('#mdPanel [data-do=close]').click()"); assert js("return !document.getElementById('mdPanel')")
    # the manual in two languages, and the licences
    js("document.querySelector('#manual').click(); document.querySelector('#sheet [data-lg=es]').click()"); assert "Qué es" in q("#shBody") and "<" not in js("return document.querySelector('#shBody b').innerHTML")
    js("document.querySelector('#sheet [data-lg=en]').click(); document.querySelector('#shClose').click(); document.querySelector('#licence').click()")
    assert "Joakim Eriksson" in q("#shBody") and "Permission is hereby granted" in q("#shBody"); js("document.querySelector('#shClose').click()")
    # what the firmware writes to its flash is kept, and given back to it when it starts again
    js("const f = run.base.slice(); f[8192] ^= 255; keepFlash(f)"); time.sleep(0.5)
    status = q("#status")

    # after a reload: the look, the file and its save are still there, and it boots with no network
    d.refresh(); time.sleep(1.5)
    assert js("return [document.body.dataset.view, document.querySelector('#kb').dataset.keys, document.querySelector('#fw').value]") == ["keys", "piano", "local"]
    d.execute_cdp_cmd("Network.enable", {}); d.execute_cdp_cmd("Network.emulateNetworkConditions", {"offline": True, "latency": 0, "downloadThroughput": -1, "uploadThroughput": -1})
    power_on(); assert "saves loaded" in q("#status"), q("#status")
    js("document.querySelector('#flip').click(); setKeys('fm')")
    print("status: %s -> %s | screen colours: %d | peak: %.3f | errors: %s" % (status, q("#status"), lit, loud, js("return __errs")))
    assert js("return __errs") == [], "errors on the page"
    print("OK")
finally:
    d.quit(); srv.shutdown()
