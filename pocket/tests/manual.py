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
        if (lang == "es") != js("return document.querySelector('#manLang').textContent.includes('ESPAÑOL')"): js("document.querySelector('#manLang').click()")
        time.sleep(0.3)
        assert js("return document.querySelector('#manFig').offsetParent !== null"), "no miniature beside the FM-1 manual"
        assert js("return document.querySelectorAll('#manFig [data-c]').length") == 3 + 8 + 14, "controls of the miniature"
        assert js("return document.querySelectorAll('#manBody b.ctl').length") > 15, "chips in the text"
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
    assert js("return window.__errs || []") == []
    print("manual: ok")
finally:
    d.quit()
