"""The PEDALS and FX screens: the dock, swiping and tapping between them, the sound's wiring (a true bypass until something is on), the saved settings.

    python3 pocket/build.py && python pocket/tests/fx.py      (needs: pip install selenium, Chrome; no firmware needed: it runs Tether, which is built in)
SHOT=/some/folder saves a screenshot of the device and of each screen.
"""
import functools, http.server, json, os, threading, time
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
    bad = js("""return [...document.querySelectorAll(arguments[0] + ' button, ' + arguments[0] + ' .kn, ' + arguments[0] + ' .knob')].filter(e => e.offsetParent && getComputedStyle(e).visibility !== 'hidden').map(e => [e, e.getBoundingClientRect()])
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
    live = js("return [...document.querySelectorAll('#fxPads .xpad')].map(p => p.dataset.live)")
    assert len(live) == 24 and len(set(live)) == 24 and {"o1", "o2", "uni", "fif", "choir", "alien", "mega", "flo", "fhi", "drv", "fln", "g8"} <= set(live), live
    assert js("return document.querySelector('#fxPads').getBoundingClientRect().height") < 330
    click("#tabPed"); assert pane() == 1; fits("#xp", "PEDALS"); shot("3-pedals")
    # the unit is drawn (PLAY's pedal with its knobs and footswitch), an amp and a cab too
    assert js("return document.querySelector('#unitDraw').classList.contains('pedal') && !!document.querySelector('#unitDraw .fs') && !!document.querySelector('#unitDraw .jack') && document.querySelectorAll('#unitDraw .knob svg').length") == 3
    assert js("return document.querySelector('#unitDraw .plate').textContent") == "OVERDRIVE"
    click("#xpKinds button:nth-child(2)"); assert js("return document.querySelector('#unitDraw').classList.contains('amp') && !!document.querySelector('#unitDraw .grill') && document.querySelectorAll('#unitDraw .knob').length") == 5; fits("#xp", "an amp")
    click("#xpKinds button:nth-child(3)"); assert js("return document.querySelector('#unitDraw').classList.contains('cab') && !!document.querySelector('#unitDraw .spk')"); fits("#xp", "a cab")
    click("#xpKinds button:nth-child(1)"); click("#unitGrid .xpU:nth-child(8)")  # EQ-5: a wide pedal with five knobs
    assert js("return document.querySelectorAll('#unitDraw .knob').length") == 5; fits("#xp", "a five-knob pedal")
    click("#unitGrid .xpU:nth-child(4)"); assert js("return document.querySelector('#unitDraw .plate').textContent") == "OVERDRIVE"
    # the pedal board: BOARD is the last button of the kinds row; tap turns a unit on, a drag moves it in the order
    assert js("return document.querySelector('#xpKinds button:last-child').textContent") == "BOARD" and js("return document.querySelector('#xpBoard').hidden")
    click("#bdOpen"); assert not js("return document.querySelector('#xpBoard').hidden") and js("return document.querySelectorAll('#bdGrid .sq').length") == 24; fits("#xp", "the board"); shot("3b-board")
    before = js("return fxInfo().rack.order")
    def drag(i, j, steps=4):
        js("""const g = document.querySelector('#bdGrid'), a = g.querySelector('.sq[data-i="' + arguments[0] + '"]').getBoundingClientRect(), b = g.querySelector('.sq[data-i="' + arguments[1] + '"]').getBoundingClientRect(),
          x0 = a.left + a.width / 2, y0 = a.top + a.height / 2, x1 = b.left + b.width / 2, y1 = b.top + b.height / 2, f = (t, x, y) => g.dispatchEvent(new PointerEvent(t, {pointerId: 11, bubbles: true, clientX: x, clientY: y}));
          const down = new PointerEvent('pointerdown', {pointerId: 11, bubbles: true, clientX: x0, clientY: y0}); g.querySelector('.sq[data-i="' + arguments[0] + '"]').dispatchEvent(down);
          for (let k = 1; k <= arguments[2]; k++) g.dispatchEvent(new PointerEvent('pointermove', {pointerId: 11, bubbles: true, clientX: x0 + (x1 - x0) * k / arguments[2], clientY: y0 + (y1 - y0) * k / arguments[2]}));
          f('pointerup', x1, y1);""", i, j, steps); time.sleep(0.3)
    def sqtap(i):  # a finger: down, up, and the click that follows
        js("""const q = document.querySelector('#bdGrid .sq[data-i="' + arguments[0] + '"]'), r = q.getBoundingClientRect(), o = {pointerId: 12, bubbles: true, clientX: r.left + 5, clientY: r.top + 5};
          q.dispatchEvent(new PointerEvent('pointerdown', o)); q.dispatchEvent(new PointerEvent('pointerup', o)); q.click();""", i); time.sleep(0.3)
    drag(3, 12)  # OVERDRIVE (4th) to the 13th place
    after = js("return fxInfo().rack.order")
    assert after[12] == before[3] and after[:3] == before[:3] and sorted(after) == sorted(before) and after != before, (before, after)
    assert json.loads(js("return localStorage.getItem('fm1.rack')"))["order"] == after
    drag(12, 3); assert js("return fxInfo().rack.order") == before  # and back
    sqtap(3)  # a tap turns it on or off
    assert js("return fxInfo().rack.u.od.on") is True
    sqtap(3); assert js("return fxInfo().rack.u.od.on") is False
    drag(1, 1); assert js("return fxInfo().rack.order") == before  # a drop on itself changes nothing
    click("#bdBack"); assert js("return document.querySelector('#xpBoard').hidden")
    js("localStorage.removeItem('fm1.rack')"); d.refresh(); time.sleep(1.5); click("#dockPed")
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
    js("""const k = document.querySelector('#unitDraw .knob'), r = k.getBoundingClientRect(), f = (t, y) => k.dispatchEvent(new PointerEvent(t, {pointerId: 3, bubbles: true, clientX: r.left + 5, clientY: y}));
      k.setPointerCapture = () => {}; f('pointerdown', r.top + 40); f('pointermove', r.top); f('pointerup', r.top);""")
    assert js("return fxInfo().rack.u.od.level") > 0.5, js("return fxInfo().rack.u.od.level")
    click("#tabFx"); click("#fxLatch"); assert js("return fxInfo().rack.latch") is False
    js("""const p = document.querySelector('[data-live=lofi]'); p.dispatchEvent(new PointerEvent('pointerdown', {pointerId: 5, bubbles: true}));""")
    assert js("return fxInfo().chain") == ["od", "lofi"], js("return fxInfo().chain")
    js("dispatchEvent(new PointerEvent('pointerup', {pointerId: 5}))"); assert js("return fxInfo().chain") == ["od"]
    click("#fxLatch"); tap("[data-live=echo]"); assert js("return fxInfo().chain") == ["od", "echo"]; shot("4-fx-on")
    tap("[data-live=echo]")
    for id in ("o1", "o2", "uni", "choir", "drv", "g8"): tap("[data-live=%s]" % id); assert id in js("return fxInfo().chain"), id; tap("[data-live=%s]" % id)
    assert js("return fxInfo().chain") == ["od"]
    # the octave pads change the sound (worklet, offline): a 440 Hz tone has 220 rising zero crossings in half a second, an octave up about 440, down about 110
    def crossings(id):
        return d.execute_async_script("""const done = arguments[arguments.length - 1], id = arguments[0], oc = new OfflineAudioContext(1, 44100, 44100);
          FXE.load(oc).then(ok => { const e = FXE.build(oc, ok), s = oc.createOscillator(); s.frequency.value = 440; s.connect(e.in); e.out.connect(oc.destination); s.start();
            e.sync(FXE.defaults(), new Set(id ? [id] : [])); oc.startRendering().then(b => { const o = b.getChannelData(0); let n = 0; for (let i = 22051; i < 44100; i++) if (o[i - 1] < 0 && o[i] >= 0) n++; done([ok, n]); }); });""", id)
    ok, up = crossings("o1"); _, down = crossings("o2")
    assert ok and 380 < up < 500 and 80 < down < 140, (ok, up, down)
    click("#tabPed"); click("#xpKinds button:nth-child(2)"); click("#unitOn")
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
