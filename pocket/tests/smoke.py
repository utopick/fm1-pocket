"""Smoke test of pocket/index.html: the three views, the keys, the skins, a firmware that boots, sounds and is kept.

    python3 pocket/build.py && python pocket/tests/smoke.py path/to/firmware.fwsc    (needs: pip install selenium, Chrome)

The packages with an open licence are mirrored in the fm1-firmwares repo (update-firmwares.py), such as ../fm1-firmwares/386dx/<version>.fwsc.
Pick one that makes a sound (386DX does): Tether is a MIDI controller and stays silent, so the sound check fails with it.
A second argument, a fast build (.rfm1) of a firmware on the list, such as ../fm1-firmwares/nachtfahrt/nachtfahrt-1.0.2.rfm1, also
checks FAST BUILDS: it boots instead of the emulator, sounds, saves, and the emulator takes over when it is switched off.
SHOT=/some/folder saves a screenshot of each view there.
"""
import base64, functools, http.server, os, re, sys, threading, time
from selenium import webdriver
from selenium.webdriver.common.by import By

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
fwsc = os.path.abspath(sys.argv[1])
rfm1 = os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 else None
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(type("Q", (http.server.SimpleHTTPRequestHandler,), {"log_message": lambda *a: None}), directory=ROOT))
threading.Thread(target=srv.serve_forever, daemon=True).start()
o = webdriver.ChromeOptions()
for a in ("--headless=new", "--autoplay-policy=no-user-gesture-required", "--lang=en-US"): o.add_argument(a)
o.add_experimental_option("prefs", {"intl.accept_languages": "en-US"})  # the page speaks the browser's language: these tests read its English
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
    assert js("return FIRMWARES.length") > 20 and js("return vetCatalog([{id: 'x', name: '<b>', package: 'javascript:1'}, {id: 'ok', name: 'n', package: 'https://a.b/c', about: 7}])") == [{"id": "ok", "name": "n", "version": "", "author": "", "license": "", "about": "", "package": "https://a.b/c", "chip": "", "date": "", "repo": "", "extra": False, "rfm1": "", "rfm1sha": ""}]
    assert js("return FIRMWARES.some(f => f.id === 'shrub' && f.extra)"), "SHRUB (update-firmwares.py's EXTRA) is in the list"

    # vertical: the whole FM-1 rearranged, the keys in two rows
    parts(1, 1, "vertical"); assert js("return document.querySelectorAll('#kb .krow').length") == 2
    size(390, 844, "vertical")
    # a phone held upright: the sideways view, drawn turned (one row of keys, the screen still square and inside the window)
    d.execute_cdp_cmd("Emulation.setTouchEmulationEnabled", {"enabled": True, "maxTouchPoints": 5}); time.sleep(0.4)
    parts(1, 1, "phone upright"); assert shown("#Ltop > #rail button") == 4, "the rail is not beside the knobs"; assert js("return document.querySelectorAll('#kb .krow').length") == 1
    r = js("const r = document.querySelector('#scr').getBoundingClientRect(); return [r.width, r.height, r.right, r.bottom]")
    assert abs(r[0] - r[1]) < 1 and r[0] > 150 and r[2] <= 390 and r[3] <= 844, r
    size(390, 844, "phone-upright")
    d.execute_cdp_cmd("Emulation.setTouchEmulationEnabled", {"enabled": False}); time.sleep(0.4)
    # sideways: the one button goes round the whole FM-1, the keys, the upper part
    size(844, 390, "complete"); parts(1, 1, "complete"); assert js("return document.querySelectorAll('#kb .krow').length") == 1
    m = js("const r = s => document.querySelector(s).getBoundingClientRect(), f = r('#fm'), a = r('#knL'), b = r('#knR'), t = r('#rail'); return [t.left, a.left - t.right, t.top - a.top, t.bottom - a.bottom, r('#scr').left - a.right]")
    assert abs(m[0] - m[1]) < 2 and abs(m[4] - m[1]) < 2 and m[1] > 12 and abs(m[2]) < 1 and abs(m[3]) < 1, "edge, rail, knobs, screen: the same space between them: %s" % m
    flip = lambda: js("document.querySelector('#flip').click()")
    flip(); flip(); parts(1, 0, "upper part"); size(844, 390, "switch-top")
    flip(); parts(1, 1, "complete again"); flip(); parts(1, 1, "keys"); assert shown("#fm > #rail button") == 4, "no rail over the keys"
    # LOOK: each chooser is a button that shows what it gives
    choose = lambda pane, v: js("document.querySelector(arguments[0] + ' .pick[data-v=\"' + arguments[1] + '\"]').click()", pane, v)
    choose("#pvKeys", "piano"); assert js("return document.querySelector('#kb').dataset.keys") == "piano"; parts(1, 1, "piano keys"); size(844, 390, "switch-piano")
    fx = []
    for v in ("crt", "off", "lcd"): choose("#pvFx", v); fx.append(js("return document.querySelector('#scr').dataset.fx + getComputedStyle(document.querySelector('#lcd')).filter"))
    assert len(set(fx)) == 3 and fx[-1].startswith("lcd"), "the screen filters do not change: %s" % fx
    names = js("return [...document.querySelectorAll('#pvSkin .pick')].map(b => b.dataset.v)"); skins = []
    for v in names[1:] + names[:1]: choose("#pvSkin", v); skins.append(js("return document.documentElement.dataset.skin + getComputedStyle(document.body).backgroundColor"))
    assert js("return SKINS.length") == 17 and len(set(skins)) == 17 and skins[-1].startswith("black"), "the skins do not change: %s" % skins
    assert js("return [...document.querySelectorAll('#pvSkin .mini')].map(m => getComputedStyle(m).backgroundImage + getComputedStyle(m.querySelector('.mb')).backgroundImage).filter((x, i, a) => a.indexOf(x) === i).length") == 17, "the skin cards do not show their own colours"
    # the menu: the whole screen, four tabs, nothing wider or taller than the window (only the firmware list scrolls)
    js("document.querySelector('#logo').click()")
    for t in ("fw", "look", "conn", "man", "info"):
        js("document.querySelector('#menu .tabs [data-tab=%s]').click()" % t); time.sleep(0.1)
        fit = js("const m = document.querySelector('#menu'), s = m.querySelector('section[data-tab=' + arguments[0] + ']'), r = m.getBoundingClientRect(); return [s.offsetParent !== null, r.width, r.height, s.scrollHeight <= s.clientHeight + 1, [...m.querySelectorAll('section')].filter(x => x.offsetParent).length]", t)
        assert fit == [True, 844, 390, True, 1], "menu tab %s: %s" % (t, fit)
        if os.environ.get("SHOT"): d.save_screenshot(os.path.join(os.environ["SHOT"], "menu-" + t + ".png"))
    for sub in ("keys", "fx", "skin"):  # each chooser fills its tab, and what is in use is marked
        js("document.querySelector('#menu .tabs [data-tab=look]').click(); document.querySelector('#' + arguments[0]).click()", sub); time.sleep(0.1)
        got = js("const p = [...document.querySelectorAll('#menu .pane')].filter(x => x.offsetParent); return [p.length, p[0].getBoundingClientRect().height > 180, p[0].querySelectorAll('.pick.on').length]")
        assert got == [1, True, 1], "look, %s: %s" % (sub, got)
        if os.environ.get("SHOT"): d.save_screenshot(os.path.join(os.environ["SHOT"], "menu-look-" + sub + ".png"))
    # on a big window the skin cards keep their shape (wider than tall) and their knobs stay round
    size(1500, 700, "x"); time.sleep(0.2)
    sh = js("const c = document.querySelector('#pvSkin .mini').getBoundingClientRect(), k = document.querySelector('#pvSkin .mk').getBoundingClientRect(); return [c.width / c.height, k.width / k.height, k.right <= c.right]")
    assert 1.5 < sh[0] < 2 and abs(sh[1] - 1) < 0.05 and sh[2], "skin card out of shape on a big window: %s" % sh
    if os.environ.get("SHOT"): d.save_screenshot(os.path.join(os.environ["SHOT"], "menu-skin-desktop.png"))
    size(844, 390, "x")
    js("document.querySelector('#menu .tabs [data-tab=fw]').click()")
    assert js("return document.querySelectorAll('#fwList .fwc').length") > 20 and js("return document.querySelectorAll('#fwList .fwc.on').length") == 1
    lefts = js("return [...document.querySelectorAll('#fwList .fwc')].slice(0, 3).map(c => [Math.round(c.getBoundingClientRect().left), Math.round(c.getBoundingClientRect().top)])")
    assert len({l[0] for l in lefts}) == 1 and lefts[1][1] > lefts[0][1], "the banners are not one to a row: %s" % lefts
    # a card whose picture does not load shows the "no image" fellow
    js("const i = document.querySelector('#fwList .fwc.on img'); if (!i.src.startsWith('data:image/svg')) i.src = 'http://127.0.0.1:9/x.webp'"); d.get_screenshot_as_png(); time.sleep(1)  # the card in view (pictures out of view wait), and a frame drawn
    assert "FREE" in q("#stor span") and js("return document.querySelector('#stor').offsetHeight") == 26, "no storage bar"
    assert js("return document.querySelector('#fwList .fwc.on img').src.startsWith('data:image/svg+xml') && document.querySelector('#fwList .fwc.on img').naturalWidth > 0"), "no placeholder picture"
    if os.environ.get("SHOT"): d.save_screenshot(os.path.join(os.environ["SHOT"], "noimg.png"))
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
    # the carousel: a press on the screen opens it on the running firmware, a slide goes to the next card, up without a unit asks to connect, a tap outside closes
    carOn = "return !document.querySelector('#car').hidden"
    js("document.querySelector('#scr').click()"); time.sleep(0.4)
    assert js(carOn) and js("return car.list[car.at].id") == "local" and js("return car.list.length") > 20 and js("return document.querySelectorAll('#carStrip .cc').length") == 9
    assert js("return document.querySelector('#carStrip .cc.on img').src").startswith("data:image/png"), "the running firmware's card does not show its screen"
    car_el = d.find_element(By.ID, "car")
    webdriver.ActionChains(d).move_to_element(car_el).click_and_hold().move_by_offset(-60, 0).move_by_offset(-90, 0).release().perform(); time.sleep(0.4)
    assert js("return car.at") == 1, "a slide did not go to the next card"
    # the ring has no end: two left arrows from the second card come to the last one; the arrows do not play the FM-1's keys meanwhile
    for _ in range(2): js("dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }))"); time.sleep(0.2)
    assert js("return car.at === car.list.length - 1"), "the ring does not go round: %s" % js("return car.at")
    # DOWNLOADED: only what is on this device; the search: only what matches; both undone
    js("document.querySelector('#carOnly').click()")
    assert js("return car.list.length < car.all.length && car.list.every(carHave) && document.querySelector('#carOnly').textContent") == "DOWNLOADED"
    js("document.querySelector('#carOnly').click(); document.querySelector('#carFind').click(); const q = document.querySelector('#carQ'); q.value = '386'; q.dispatchEvent(new Event('input'))")
    assert js("return car.list.length >= 1 && car.list.every(f => (f.name + ' ' + f.author + ' ' + f.about).includes('386'))"), "the search"
    js("const q = document.querySelector('#carQ'); q.value = ''; q.dispatchEvent(new Event('input')); q.blur()"); assert js("return car.list.length === car.all.length")
    js("car.at = car.list.findIndex(f => f.id === 'local'); carDraw()")
    webdriver.ActionChains(d).move_to_element(car_el).click_and_hold().move_by_offset(0, -50).move_by_offset(0, -60).release().perform(); time.sleep(0.4)
    assert not js(carOn) and q("#jobTitle") == "CONNECT YOUR FM-1 FIRST", "a swipe up without a unit: %s" % q("#jobTitle")
    js("document.querySelector('#jobOk').click()")
    js("document.querySelector('#scr').click()"); time.sleep(0.4)
    webdriver.ActionChains(d).move_to_element_with_offset(car_el, 0, -js("return innerHeight") // 2 + 8).click().perform(); time.sleep(0.5)
    assert not js(carOn) and js("return run.f.id") == "local", "a tap outside did not just close the carousel"
    # a dimmed light wavers a little from frame to frame (386DX dims every button): it is drawn steady
    seen = js("""const out = new Set(), l = new Float32Array(41);
      for (let i = 0; i < 40; i++) { l[3] = i % 9 ? 0.022 : 0.02; showFrame({ lcd: null, leds: l }); i > 20 && out.add(lights[3].style.getPropertyValue('--led')); }
      return [...out]""")
    assert len(seen) == 1 and abs(float(seen[0]) - (0.022 / 0.08) ** 0.5) < 0.02, "a dim light shimmers: %s" % seen
    # a controller: an MPK's knob 5 (CC 73 in its internal layout; knobs 1 to 4 are MASTER, SELECT, PRESETS and ALGORITHM) turns KNOB1, its pad 1 (note 36, channel 10) holds HOME, its keys go to MIDI IN
    js("MI.names = ['MPK mini']; window.c0 = clicks[3]; midiMsg([0xb0, 73, 10], 'MPK mini'); midiMsg([0xb0, 73, 30], 'MPK mini')")
    assert js("return clicks[3] - c0") == 5, "the knob did not turn KNOB1"
    js("midiMsg([0x99, 36, 100], 'MPK mini')"); assert js("return down[8]") == 1
    js("midiMsg([0x89, 36, 0], 'MPK mini')"); assert js("return down[8]") == 0
    js("document.querySelector('#midiDev').click()"); assert js("return document.querySelectorAll('#mdPanel svg [data-control]').length") > 30, "no drawing of the controller"
    js("document.querySelector('#mdPanel [data-do=close]').click()"); assert js("return !document.getElementById('mdPanel')")
    # the manual in two languages, and the licences
    js("lang = 'en'; document.querySelector('#manFm').click()"); assert "ALGORITHM" in q("#manBody") and "32 algorithms" in q("#manBody")
    js("document.querySelector('#langBtn').click()"); assert "32 algoritmos" in q("#manBody") and "<" not in js("return document.querySelector('#manBody b').innerHTML")
    js("document.querySelector('#manApp').click()"); assert "Qué es" in q("#manBody")
    js("document.querySelector('#langBtn').click()")
    assert "Joakim Eriksson" in q("#licBody") and "Permission is hereby granted" in q("#licBody"), "the licences are not in the About card"
    # what the firmware writes to its flash is kept, and given back to it when it starts again
    js("const f = run.base.slice(); f[8192] ^= 255; keepFlash(f)"); time.sleep(0.5)
    status = q("#status")

    # after a reload: the look, the file and its save are still there, and it boots with no network
    d.refresh(); time.sleep(1.5)
    assert js("return [document.body.dataset.view, document.querySelector('#kb').dataset.keys, document.querySelector('#fw').value]") == ["keys", "piano", "local"]
    d.execute_cdp_cmd("Network.enable", {}); d.execute_cdp_cmd("Network.emulateNetworkConditions", {"offline": True, "latency": 0, "downloadThroughput": -1, "uploadThroughput": -1})
    power_on(); assert "saves loaded" in q("#status"), q("#status")
    js("document.querySelector('#flip').click(); setKeys('fm')")
    # a device that cannot keep up: a lower clock where one helps (a firmware that mostly idles costs the same at any clock)
    assert js("return [lowerClock(1.2, 0, 100), lowerClock(1.2, 0.8, 100), lowerClock(1.2, 0, 60)]") == [60, None, None]
    js("Object.assign(perf, { busy: 0, span: 0, emu: 0, idle: 0, t: 0, secs: 9, bad: 2, asked: false }); keepUp({ busy: 30, quanta: 10, frames: 128, emulated: 29, idle: 0 })")
    assert "60 MHz" in q("#sureText") and not js("return document.querySelector('#sure').hidden"), "no offer of a lower clock"
    js("document.querySelector('#sureNo').click()"); assert js("return mhz") == 100
    # a DX7 bank: its shape is checked, it goes with the next start once, and a refusal by the emulator leaves the machine running
    assert js("const b = new Uint8Array(4104); b.set([0xf0, 0x43, 0, 9, 0x20, 0]); b[4103] = 0xf7; window.b0 = b; return [vetBank(b), vetBank(b.slice(1)), vetBank(new Uint8Array(4104))]") == [True, False, False]
    js("bank = b0; boot()"); time.sleep(4)
    took = q("#status"); assert js("return bank") is None and ("saves loaded" in took or "DX7 bank" in took), took
    js("boot()"); time.sleep(4); assert "saves loaded" in q("#status"), q("#status")
    fast = "skipped (no .rfm1 given)"
    if rfm1:  # FAST BUILDS: the build is put where a download keeps it (we are offline here), and runs instead of the emulator
        fid = js("const f = FIRMWARES.find(f => f.rfm1 === arguments[0]); return f && f.id", os.path.basename(rfm1))
        assert fid, "no firmware on the list has " + os.path.basename(rfm1)
        js("const b = Uint8Array.from(atob(arguments[1]), c => c.charCodeAt(0)); kvPut('rfm1:' + arguments[0], { file: arguments[2], bytes: b })", fid, base64.b64encode(open(rfm1, "rb").read()).decode(), os.path.basename(rfm1))
        assert "fwc" in js("return document.querySelector('#fwList').innerHTML") and js("return document.querySelectorAll('#fwList em.fast').length") > 50, "no FAST tags on the cards"
        n = js("return document.querySelectorAll('#fwList .fwc').length")  # the filter: with, without, every one
        got = []
        for _ in range(3): js("document.querySelector('#fastOnly').click()"); got.append(js("return [document.querySelectorAll('#fwList .fwc').length, document.querySelectorAll('#fwList .fwc em.fast').length]"))
        assert 0 <= got[0][0] - got[0][1] <= 2 and got[0][1] > 50 and got[1][1] == 0 and got[0][0] + got[1][0] <= n + 2 and got[2][0] == n, "the fast-build filter: %s of %d" % (got, n)
        js("use(arguments[0])", fid)
        for _ in range(40):
            time.sleep(0.5)
            if "fast build" in q("#status"): break
        assert "fast build" in q("#status") and js("return run.rfm1"), q("#status")
        time.sleep(2); js("peak = 0; setKey(26, true); turn(3, 2); setPot(1000)"); time.sleep(2); js("setKey(26, false)")
        fpeak = js("return peak")
        assert fpeak > 0.005, "no sound from the fast build"
        js("flush()"); time.sleep(1)
        assert js("return kvGet('rsave:' + arguments[0]).then(v => v instanceof Uint8Array && v.length)", fid), "the fast build's save was not kept"
        fast = "%s %.3f" % (q("#status"), fpeak)
        js("document.querySelector('#fast').click()"); time.sleep(3)  # off: the same firmware on the emulator (its package is not here offline: it says so)
        assert q("#fast i") == "OFF" and "not kept on this device" in q("#status"), q("#status")  # the emulator was asked for it
        js("document.querySelector('#fast').click()"); time.sleep(3)
        assert q("#fast i") == "ON" and "fast build" in q("#status") and js("return run.rfm1"), q("#status")
    print("status: %s -> %s | screen colours: %d | peak: %.3f | bank: %s | fast: %s | errors: %s" % (status, q("#status"), lit, loud, took, fast, js("return __errs")))
    assert js("return __errs") == [], "errors on the page"
    print("OK")
finally:
    d.quit(); srv.shutdown()
