"""The FM-1 manual's miniature panel: chips in the text, the controls lit by the text, tap a control to go to its entry.

    python3 pocket/build.py && python pocket/tests/manual.py      (needs: pip install selenium, Chrome; no firmware needed)
"""
import functools, http.server, os, threading, time
from selenium import webdriver

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(type("Q", (http.server.SimpleHTTPRequestHandler,), {"log_message": lambda *a: None}), directory=ROOT))
threading.Thread(target=srv.serve_forever, daemon=True).start()
o = webdriver.ChromeOptions()
for a in ("--headless=new", "--mute-audio"): o.add_argument(a)
d = webdriver.Chrome(options=o)
js = d.execute_script
lit = lambda cls="lit": js("return [...document.querySelectorAll('#manFig .' + arguments[0])].map(e => e.dataset.c)", cls)
def until(check, what, seconds=4):  # a headless page only fires scroll events when it draws a frame: ask for one now and then
    end = time.time() + seconds
    while time.time() < end:
        js("return new Promise(r => requestAnimationFrame(() => r(1)))")
        if check(): return
        time.sleep(0.1)
    raise AssertionError(what)
try:
    d.execute_cdp_cmd("Emulation.setDeviceMetricsOverride", {"width": 844, "height": 390, "deviceScaleFactor": 1, "mobile": True})
    d.get("http://127.0.0.1:%d/index.html" % srv.server_address[1]); time.sleep(1.5)
    for lang in ("en", "es"):
        js("document.querySelector('#logo').click(); document.querySelector('#menu .tabs [data-tab=man]').click(); document.querySelector('#manFm').click()")
        if (lang == "es") != js("return document.querySelector('#langBtn').textContent.includes('ESPAÑOL')"): js("document.querySelector('#langBtn').click()")
        time.sleep(0.3)
        assert js("return document.querySelector('#manFig').offsetParent !== null"), "no miniature beside the FM-1 manual"
        assert js("return document.querySelectorAll('#manFig [data-c]').length") == 3 + 8 + 14, "controls of the miniature"
        assert js("return document.querySelectorAll('#manBody b.ctl').length") > 15, "chips in the text"
        # every chip is a visible little box in the line (a class of the keys once made the knob chips vanish)
        bad = js("return [...document.querySelectorAll('#manBody b.ctl')].filter(b => getComputedStyle(b).display !== 'inline-block' || b.getBoundingClientRect().width < 10).map(b => b.textContent)")
        assert bad == [], "chips that do not show: %s" % bad
        # the line at the top decides what is lit: FX is about FX, with SELECT and the knobs only mentioned
        js("const b = document.querySelector('#manBody'), x = [...b.querySelectorAll('[data-p]')].find(e => e.dataset.p === 'FX'); b.scrollTop = x.offsetTop - b.offsetTop - 4")
        until(lambda: lit() == ["FX"], "FX is not lit at the FX entry (%s: %s)" % (lang, lit()))
        assert "SELECT" in lit("lit2") and "KNOB4" in lit("lit2"), (lang, lit("lit2"))
        # a chip lights its own control; a control of the miniature scrolls to its entry
        js("document.querySelector('#manBody [data-p=\"HOME\"] b.ctl').click()"); assert lit() == ["HOME"], lit()
        js("document.querySelector('#manBody').scrollTop = 0"); time.sleep(0.3)
        js("document.querySelector('#manFig [data-c=REC]').click()")
        until(lambda: js("const e = document.querySelector('#manBody [data-p*=\"REC\"]'), b = document.querySelector('#manBody'); return Math.abs(e.getBoundingClientRect().top - b.getBoundingClientRect().top) < 40"), "REC did not scroll to its entry")
    # the manual of this app has no miniature
    js("document.querySelector('#manApp').click()"); assert not js("return document.querySelector('#manFig').offsetParent !== null")
    # the app in Spanish: no text or title outside the FM-1, the manuals, the licences and the MIDI panel is still an English text of ES;
    # ENGLISH puts every one back; the FM-1's own control names stay English in both
    LEFT = """const key = arguments[0] ? new Set(Object.keys(ES)) : new Set(Object.entries(ES).filter(([k, v]) => !(v in ES)).map(([k, v]) => v)), out = [];
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n; (n = w.nextNode()); ) if (!trOut(n.parentElement) && key.has(n.data.trim())) out.push(n.data.trim());
      for (const e of document.querySelectorAll('*')) if (!trOut(e)) for (const a of TR_ATTRS) if (key.has(e.getAttribute(a))) out.push(a + ': ' + e.getAttribute(a));
      return out;"""
    fmNames = "return [...document.querySelectorAll('#fm .pb, #fm .kn label')].map((e) => e.textContent).join(' ')"
    FM = "MASTER SELECT PRESETS ALGORITHM KNOB1 KNOB2 KNOB3 KNOB4 OCT- OCT+ FX SEL ENV LFO EDIT GLO HOME SAVE ARP SEQ PLAYSTOP REC"
    def tour():  # every tab and pane, so what is built on the way is there to check too
        for t in ("fw", "look", "conn", "man", "info"):
            js("document.querySelector('#menu .tabs [data-tab=%s]').click()" % t)
            for sub in {"look": ("keys", "fx", "skin"), "conn": ("real", "inst", "midi")}.get(t, ()):
                js("document.querySelector('section[data-tab=%s] button[data-sub=%s]').click()" % (t, sub))
                if sub == "real": js("document.querySelector('#sureNo').click()")
        js("document.querySelector('#realHow').click()"); time.sleep(0.2)
    for lang in ("es", "en"):
        js("document.querySelector('#jobOk').click(); document.querySelector('#menuBack').click()")
        if (lang == "es") != js("return document.querySelector('#langBtn').textContent.includes('ESPAÑOL')"): js("document.querySelector('#langBtn').click()")
        tour()
        left = js(LEFT, lang == "es")
        assert left == [], "%s: still in the other language: %s" % (lang, left[:20])
        assert sorted(js(fmNames).split()) == sorted(FM.split()), (lang, js(fmNames))
        assert js("return document.documentElement.lang") == lang
    assert "SEARCH FIRMWARE" in js("return document.querySelector('#fwFind').textContent") and "Plug in" in js("return document.querySelector('#midiAbout').textContent")
    # what the code writes later is Spanish too: a toast
    js("document.querySelector('#jobOk').click(); document.querySelector('#menuClose').click(); document.querySelector('#langBtn').click()")
    js("document.querySelector('#flip').click()"); time.sleep(0.1)
    assert js("return document.querySelector('#toast').textContent") in ("Las teclas", "Potes, pantalla y botones", "El FM-1 entero"), js("return document.querySelector('#toast').textContent")
    js("document.querySelector('#flip').click(); document.querySelector('#flip').click(); document.querySelector('#logo').click(); document.querySelector('#langBtn').click()")
    # Tether is built in: the first card, chosen at first, kept with no download; UPDATE FIRMWARES says how the update went
    js("document.querySelector('#menu .tabs [data-tab=fw]').click()"); time.sleep(0.2)
    assert js("return document.querySelector('#fwList .fwc b').textContent").startswith("Tether"), "Tether is not the first card"
    assert js("return document.querySelector('#fw').value") == "tether" and js("return document.querySelector('#fwList .fwc button').textContent") in ("USE", "IN USE")
    js("document.querySelector('#fwUpdate').click()")
    until(lambda: "list" in js("return document.querySelector('#toast').textContent") and "Updating" not in js("return document.querySelector('#toast').textContent"), "no toast after UPDATE FIRMWARES", 20)
    assert js("return window.__errs || []") == []
    print("manual: ok")
finally:
    d.quit()
