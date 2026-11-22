"""The PEDALS and FX screens: the dock, swiping and tapping between them, the sound's wiring (a true bypass until something is on), the saved settings.

    python3 pocket/build.py && python pocket/tests/fx.py      (needs: pip install selenium, Chrome; no firmware needed: it runs Tether, which is built in)
SHOT=/some/folder saves a screenshot of the device and of each screen.
"""
import functools, http.server, os, threading, time
from selenium import webdriver

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(type("Q", (http.server.SimpleHTTPRequestHandler,), {"log_message": lambda *a: None}), directory=ROOT))
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = "http://127.0.0.1:%d/index.html" % srv.server_address[1]
o = webdriver.ChromeOptions()
for a in ("--headless=new", "--autoplay-policy=no-user-gesture-required", "--mute-audio", "--lang=en-US"): o.add_argument(a)
o.add_experimental_option("prefs", {"intl.accept_languages": "en-US"})
d = webdriver.Chrome(options=o)
# the errors, and every connection between audio nodes (so a test can see where the emulator's sound goes)
d.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {"source": """
window.__errs = []; addEventListener('error', e => __errs.push(String(e.message))); addEventListener('unhandledrejection', e => __errs.push('promise: ' + (e.reason && e.reason.message || e.reason)));
window.__links = new Set(); let n = 0; const id = x => x.__id || (x.__id = ++n), kind = x => x instanceof AudioDestinationNode ? 'dest' : x instanceof AudioNode ? x.constructor.name + id(x) : 'param';
const c = AudioNode.prototype.connect, dc = AudioNode.prototype.disconnect;
AudioNode.prototype.connect = function (to) { __links.add(id(this) + ':' + this.constructor.name + '>' + kind(to)); return c.apply(this, arguments); };
AudioNode.prototype.disconnect = function (to) { for (const l of [...__links]) if (l.startsWith(id(this) + ':') && (!to || l.endsWith('>' + kind(to)))) __links.delete(l); return dc.apply(this, arguments); };
"""})
js = d.execute_script
shot = lambda name: os.environ.get("SHOT") and d.save_screenshot(os.path.join(os.environ["SHOT"], name + ".png"))
def size(w, h):
    d.execute_cdp_cmd("Emulation.setDeviceMetricsOverride", {"width": w, "height": h, "deviceScaleFactor": 2, "mobile": w < 900}); time.sleep(0.4)
def load():
    d.get(URL); time.sleep(1.5)
def click(sel): js("document.querySelector(arguments[0]).click()", sel); time.sleep(0.4)
def tap(sel):  # the live pads answer to a touch, not to a click
    js("const e = document.querySelector(arguments[0]); e.dispatchEvent(new PointerEvent('pointerdown', {pointerId: 9, bubbles: true})); dispatchEvent(new PointerEvent('pointerup', {pointerId: 9}))", sel); time.sleep(0.3)
def swipe(sel, dx):  # a finger drawn across an element
    js("""const e = document.querySelector(arguments[0]), r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, f = (t, X) => e.dispatchEvent(new PointerEvent(t, {pointerId: 7, bubbles: true, clientX: X, clientY: y}));
      f('pointerdown', x); f('pointermove', x + arguments[1] / 2); f('pointermove', x + arguments[1]); f('pointerup', x + arguments[1]);""", sel, dx); time.sleep(0.5)
pane = lambda: js("return document.querySelector('#xp').classList.contains('open') ? +document.querySelector('#xp').dataset.pane : 0")
# the controls of a screen: every one inside the window and big enough for a finger
def fits(root, why):
    bad = js("""return [...document.querySelectorAll(arguments[0] + ' button, ' + arguments[0] + ' .kn')].filter(e => e.offsetParent && getComputedStyle(e).visibility !== 'hidden').map(e => [e, e.getBoundingClientRect()])
      .filter(([e, r]) => r.width < 30 || r.height < 30 || r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1).map(([e, r]) => (e.id || e.textContent) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height))""", root)
    assert bad == [], "%s: controls too small or outside the window: %s" % (why, bad)
    if root == "#xp": assert js("return [...document.querySelectorAll('#xp section, #xp .xpWell')].filter(x => x.offsetParent && getComputedStyle(x).visibility !== 'hidden').every(x => x.scrollHeight <= x.clientHeight + 1 && x.scrollWidth <= x.clientWidth + 1)"), why + ": something in it would scroll"
sink = lambda: sorted(l.split(">")[0].split(":")[1] for l in js("return [...__links]") if l.endswith(">dest"))  # who is wired to the speakers
emu_to = lambda: sorted(l.split(">")[1] for l in js("return [...__links]") if ":AudioWorkletNode>" in l)  # where the emulator's sound goes
try:
    size(844, 390); load()
    assert js("return __errs") == [], js("return __errs")
    assert js("return [...document.querySelectorAll('button, select')].filter(b => !b.title).map(b => b.id || b.textContent)") == []
    assert js("return document.querySelector('#xp').inert") and pane() == 0
    fits("#xpDock", "the dock"); shot("1-device")
    # tapping: the dock opens each screen, the tabs and BACK move between them
    assert js("return [...document.querySelectorAll('#xpDock button, .xpTabs button')].map(b => b.textContent).join()") == "PEDALS,LIVE FX,PEDALS,LIVE FX"
    click("#dockFx"); assert pane() == 2 and not js("return document.querySelector('#xp').inert"); fits("#xp", "FX"); shot("2-fx")
    assert js("return document.querySelectorAll('#fxPads .xpad').length") == 12
    click("#tabPed"); assert pane() == 1; fits("#xp", "PEDALS"); shot("3-pedals")
    click("#xpBack"); assert pane() == 0
    click("#dockPed"); assert pane() == 1; click("#dockPed"); assert pane() == 0
    # swiping: left from the dock opens FX, left again goes to PEDALS, right goes back and back out
    swipe("#xpDock", -120); assert pane() == 1, pane()
    swipe("#xp .xpbar", -120); assert pane() == 2
    swipe("#xp .xpbar", 120); assert pane() == 1
    swipe("#xp .xpbar", 120); assert pane() == 0
    # nothing is stored until a unit is switched on, and the power-on sound goes straight to the speakers
    assert js("return localStorage.getItem('fm1.rack')") is None
    js("document.querySelector('#power').click()")
    for _ in range(40):
        time.sleep(0.5)
        if emu_to(): break
    assert "dest" in emu_to(), emu_to()
    assert js("return fxInfo().active") is False and emu_to().count("dest") == 1 and not [t for t in emu_to() if t.startswith("GainNode")], "not a bypass: %s" % emu_to()
    # a pedal on: the sound is now wired into the chain and no longer to the speakers directly
    click("#dockPed"); click("#unitGrid .xpU.sel")  # OVERDRIVE is chosen, a second tap turns it on
    assert js("return fxInfo().chain") == ["od"] and js("return fxInfo().active") is True
    assert "dest" not in emu_to() and any(t.startswith("GainNode") for t in emu_to()), emu_to()
    assert js("return document.querySelector('#xpLed').textContent").startswith("ACTIVE") and js("return document.querySelector('#dockPed').classList.contains('lit')")
    assert js("return JSON.parse(localStorage.getItem('fm1.rack')).u.od.on") is True
    # a knob moves, a live FX pad plays (HOLD: only while held), the unit moves later in the chain
    js("""const k = document.querySelector('#unitKnobs .kn'), r = k.getBoundingClientRect(), f = (t, y) => k.dispatchEvent(new PointerEvent(t, {pointerId: 3, bubbles: true, clientX: r.left + 5, clientY: y}));
      k.setPointerCapture = () => {}; f('pointerdown', r.top + 40); f('pointermove', r.top); f('pointerup', r.top);""")
    assert js("return fxInfo().rack.u.od.level") > 0.5, js("return fxInfo().rack.u.od.level")
    click("#tabFx"); click("#fxLatch"); assert js("return fxInfo().rack.latch") is False
    js("""const p = document.querySelector('[data-live=lofi]'); p.dispatchEvent(new PointerEvent('pointerdown', {pointerId: 5, bubbles: true}));""")
    assert js("return fxInfo().chain") == ["od", "lofi"], js("return fxInfo().chain")
    js("dispatchEvent(new PointerEvent('pointerup', {pointerId: 5}))"); assert js("return fxInfo().chain") == ["od"]
    click("#fxLatch"); tap("[data-live=echo]"); assert js("return fxInfo().chain") == ["od", "echo"]; shot("4-fx-on")
    tap("[data-live=echo]"); click("#tabPed"); click("#xpKinds button:nth-child(2)"); click("#unitOn")
    assert js("return fxInfo().chain") == ["amp", "od"] or js("return fxInfo().chain") == ["od", "amp"], js("return fxInfo().chain")
    click("#unitEarlier"); click("#unitLater"); shot("5-pedals-on")
    # the audio itself: the engine, in an offline context, with OVERDRIVE on, does not return the input unchanged
    r = js("""const oc = new OfflineAudioContext(1, 8820, 44100), e = FXE.build(oc, false), s = oc.createOscillator(), g = oc.createGain();
      g.gain.value = 0.4; s.frequency.value = 220; s.connect(g); g.connect(e.in); e.out.connect(oc.destination); s.start();
      const rack = FXE.defaults(); rack.u.od.on = true; rack.u.od.drive = 1; e.sync(rack, new Set());
      const ref = oc.createGain(); const out = (await oc.startRendering()).getChannelData(0);
      let sum = 0, mx = 0; for (let i = 4410; i < 8820; i++) { sum += out[i] * out[i]; mx = Math.max(mx, Math.abs(out[i])); }
      return [Math.sqrt(sum / 4410), mx];""") if False else d.execute_async_script("""const done = arguments[arguments.length - 1];
      const oc = new OfflineAudioContext(1, 8820, 44100), e = FXE.build(oc, false), s = oc.createOscillator(), g = oc.createGain();
      g.gain.value = 0.4; s.frequency.value = 220; s.connect(g); g.connect(e.in); e.out.connect(oc.destination); s.start();
      const rack = FXE.defaults(); rack.u.od.on = true; rack.u.od.drive = 1; e.sync(rack, new Set());
      oc.startRendering().then(b => { const out = b.getChannelData(0); let sum = 0; for (let i = 4410; i < 8820; i++) sum += out[i] * out[i]; done(Math.sqrt(sum / 4410)); });""")
    assert abs(r - 0.4 / 2 ** 0.5) > 0.03, "the overdrive left the sound as it was: rms %s" % r
    # everything off again: the wiring returns to the speakers
    for id in ("od", "amp"):
        js("const r = JSON.parse(localStorage.getItem('fm1.rack')); r.u[arguments[0]].on = false; localStorage.setItem('fm1.rack', JSON.stringify(r))", id)
    d.refresh(); time.sleep(1.5)
    assert js("return fxInfo().chain") == [] and js("return __errs") == [], js("return __errs")
    # what is read back is checked: a hostile saved rack is cleaned, not trusted
    js("""localStorage.setItem('fm1.rack', JSON.stringify({order: ['od', 'od', '<img>', 5], latch: 'x', u: {od: {on: 'yes', drive: 1e9, level: -4}, '<b>': {on: true}, gate: {on: true, thr: 'NaN'}}}))""")
    d.refresh(); time.sleep(1.5)
    r = js("return fxInfo().rack")
    assert js("return __errs") == [] and r["order"][0] == "od" and len(r["order"]) == 24 and len(set(r["order"])) == 24 and "<b>" not in r["u"], r
    assert r["u"]["od"]["on"] is False and r["u"]["od"]["drive"] == 1 and r["u"]["od"]["level"] == 0 and r["u"]["gate"]["on"] is True and r["u"]["gate"]["thr"] == -60, r["u"]
    js("localStorage.setItem('fm1.rack', '{not json')"); d.refresh(); time.sleep(1.5)
    assert js("return __errs") == [] and js("return fxInfo().rack.order.length") == 24
    # the ?worker=1 trial connects its sound through another object: the same wiring there
    js("localStorage.removeItem('fm1.rack')"); d.get(URL + "?worker=1"); time.sleep(1.5)
    js("document.querySelector('#power').click()")
    for _ in range(40):
        time.sleep(0.5)
        if "dest" in [l.split(">")[1] for l in js("return [...__links]") if ":AudioWorkletNode>" in l]: break
    assert emu_to().count("dest") == 1 and js("return fxInfo().active") is False, emu_to()
    click("#dockPed"); click("#unitOn")
    assert "dest" not in emu_to() and js("return fxInfo().chain") == ["od"], emu_to()
    click("#unitOn"); assert emu_to().count("dest") == 1 and js("return fxInfo().active") is False, emu_to()
    assert js("return __errs") == [], js("return __errs")
    # Spanish, and a desktop window
    js("localStorage.setItem('fm1.lang', 'es'); localStorage.removeItem('fm1.rack')"); d.get(URL); time.sleep(1.5)
    assert "Atrás" not in js("return document.querySelector('#xpBack').title") and "Volver" in js("return document.querySelector('#xpBack').title")
    assert js("return [...document.querySelectorAll('#xp button, #xpDock button')].filter(b => !b.title).length") == 0
    click("#dockFx"); assert "pad" in js("return document.querySelector('#toast').textContent"), js("return document.querySelector('#toast').textContent")
    size(1280, 720); fits("#xp", "FX on a desktop window"); shot("6-fx-desktop"); click("#tabPed"); fits("#xp", "PEDALS on a desktop window"); shot("7-pedals-desktop")
    size(844, 360); fits("#xp", "PEDALS, a short phone"); click("#tabFx"); fits("#xp", "FX, a short phone")
    # the Android app (class native) plays the sound itself: no dock there
    js("document.documentElement.classList.add('native')"); assert js("return getComputedStyle(document.querySelector('#xpDock')).display") == "none"
    assert js("return __errs") == [], js("return __errs")
    print("fx: ok")
finally:
    d.quit()
