"""MIDI checks of pocket/index.html with a fake controller and no firmware: the device panel, MAP, the starting assignment.

    python3 pocket/build.py && python pocket/tests/midi.py      (needs: pip install selenium, Chrome; no firmware, no network)
"""
import functools, http.server, json, os, threading, time, unittest
from selenium import webdriver

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOOK = """window.__errs = []; addEventListener('error', e => __errs.push(String(e.message)));
addEventListener('unhandledrejection', e => __errs.push('promise: ' + (e.reason && e.reason.message || e.reason)));
(() => { const inp = { id: 'm', name: 'MPK mini Play mk3', manufacturer: 'AKAI', state: 'connected', type: 'input', onmidimessage: null }; window.__inp = inp;
  navigator.requestMIDIAccess = () => Promise.resolve({ inputs: new Map([['m', inp]]), outputs: new Map(), onstatechange: null, sysexEnabled: false }); })();"""
# the standard MPK layout, as MAP or the profile would give it: knobs CC 70 to 77, pads 36 to 43 on channel 10
STD = {"MPK mini Play mk3": {"keys": 25, "pads": 8, "padCh": 9, "padNotes": [[36, 37, 38, 39, 40, 41, 42, 43]], "ccs": [70, 71, 72, 73, 74, 75, 76, 77], "knobs": 8, "cc0": 0}}


def setUpModule():
    global SRV, BASE
    SRV = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(type("Q", (http.server.SimpleHTTPRequestHandler,), {"log_message": lambda *a: None}), directory=ROOT))
    threading.Thread(target=SRV.serve_forever, daemon=True).start()
    BASE = "http://127.0.0.1:%d/" % SRV.server_address[1]


def tearDownModule(): SRV.shutdown()


class Midi(unittest.TestCase):
    def setUp(self):
        o = webdriver.ChromeOptions()
        for a in ("--headless=new", "--mute-audio", "--window-size=844,390"): o.add_argument(a)
        self.d = webdriver.Chrome(options=o)
        self.addCleanup(self.d.quit)
        self.d.execute_cdp_cmd("Network.enable", {})
        self.d.execute_cdp_cmd("Network.setBlockedURLs", {"urls": ["https://*", "http://*.*"]})  # no firmware list, no package: offline
        self.d.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {"source": HOOK})

    def js(self, code, *a): return self.d.execute_script(code, *a)

    def open(self, hw=None):
        self.d.get(BASE + "index.html"); time.sleep(1.5)
        if hw: self.js("localStorage.setItem('pocket.midi.hw.v1', arguments[0])", json.dumps(hw)); self.d.refresh(); time.sleep(1.5)
        self.js("document.querySelector('#midi').click()"); time.sleep(0.5)

    def midi(self, *d): self.js("window.__inp.onmidimessage({ data: new Uint8Array(arguments[0]) })", list(d))

    def errors(self): return self.js("return window.__errs")

    def test_the_panel_opens_and_draws_the_defaults_without_a_firmware(self):
        self.open(STD)
        self.assertIn("MPK mini Play mk3", self.js("return document.querySelector('#midiNames').textContent"))
        self.js("document.querySelector('#midiDev').click()"); time.sleep(0.4)
        self.assertTrue(self.js("return !!document.querySelector('#mdPanel svg')"))
        tags = self.js("return [...document.querySelectorAll('#mdPanel .tg:not(.info) text')].map(t => t.textContent)")
        for want in ("MASTER", "SELECT", "PRESETS", "ALGORITHM", "KNOB1", "KNOB4", "HOME", "SAVE", "ARP", "SEQ", "FX", "SEL", "ENV", "LFO"):
            self.assertIn(want, tags)
        self.js("document.querySelector('[data-do=close]').click()")
        self.assertEqual(self.errors(), [])

    def test_the_firmware_search_filters_the_cards(self):
        self.open()
        self.js("document.querySelector('#menu').hidden = false; document.querySelector('#menu [data-tab=fw]').click()")
        n = lambda: self.js("return document.querySelectorAll('#fwList .fwc').length")
        all_ = n(); self.assertGreater(all_, 50)
        self.js("document.querySelector('#fwFind').click()"); time.sleep(0.3)  # the search is a dialog
        box = self.d.find_element("css selector", "#fwSearch"); box.send_keys("felucca"); time.sleep(0.4)
        self.assertTrue(0 < n() < all_)
        box.send_keys("zzzz"); time.sleep(0.4); self.assertEqual(n(), 0); self.assertIn("No firmware matches", self.js("return document.querySelector('#fwList').textContent"))
        for _ in range(11): box.send_keys("\ue003")  # backspace: what a user does
        time.sleep(0.4); self.assertEqual(n(), all_)
        self.assertEqual(self.errors(), [])

    def test_a_firmware_card_shows_the_readme_of_its_repository_as_its_manual(self):
        self.open()
        self.js("""window.__urls = []; window.fetch = (u) => { window.__urls.push(String(u)); return /raw\\.githubusercontent\\.com/.test(u) ? Promise.resolve(new Response('# Ghoul manual\\n\\nPress **PLAY** and see [the page](https://example.com/x).\\n\\n- one\\n- two\\n\\n<img src=x onerror=alert(1)>\\n', {status: 200})) : Promise.reject(new Error('blocked')); };
          document.querySelector('#menu').hidden = false; document.querySelector('#menu [data-tab=fw]').click();""")
        time.sleep(0.5)
        self.js("document.querySelector('#fwList .fwc .man:not([hidden])').click()"); time.sleep(1.2)
        body = self.js("return document.querySelector('#shBody').innerHTML")
        self.assertIn("<h3>Ghoul manual</h3>", body); self.assertIn("<b>PLAY</b>", body); self.assertIn('href="https://example.com/x"', body); self.assertIn("<li>two</li>", body)
        self.assertNotIn("onerror", body); self.assertNotIn("<img", body)
        self.assertTrue(any("raw.githubusercontent.com" in u for u in self.js("return window.__urls")))
        self.js("document.querySelector('#shClose').click()")
        # kept on the device: the second time it does not ask the network
        n = len(self.js("return window.__urls"))
        self.js("document.querySelector('#fwList .fwc .man:not([hidden])').click()"); time.sleep(0.8)
        self.assertEqual(len(self.js("return window.__urls")), n)
        self.assertEqual(self.errors(), [])

    def test_the_fm1_has_its_own_drawing_of_27_keys(self):
        self.open()  # no saved map: the model's own profile
        self.js("document.querySelector('#midiDev').click()"); time.sleep(0.4)
        self.js("const s = document.querySelector('#mdProfile'); s.value = 'fm1'; s.dispatchEvent(new Event('change', {bubbles: true}))"); time.sleep(0.4)
        self.assertEqual(self.js("return document.querySelectorAll('#mdPanel .mdKey').length"), 27)
        self.assertEqual(self.js("return document.querySelector('#mdPanel .mdKey').dataset.note"), "53")
        self.assertEqual(self.errors(), [])
        if os.environ.get("SHOT"): self.d.save_screenshot(os.environ["SHOT"])

    def test_defaults_are_the_fm1_knobs_and_its_16_buttons(self):
        self.open(STD)
        got = self.js("return MI.defaults()")
        self.assertEqual([k[1] for k in got["knobs"]], ["MASTER", "SELECT", "PRESETS", "ALGORITHM", "KNOB1", "KNOB2", "KNOB3", "KNOB4"])
        self.assertEqual([p and p[1] for p in got["pads"]], ["HOME", "SAVE", "ARP", "SEQ", "FX", "SEL", "ENV", "LFO", "PLAY", "REC", "KEYS VIEW", "POWER (ON)", "EDIT", "GLO", None, "FM-1 MENU"])
        # pads 9 to 16 through the MOD pedal: pad 3 with the pedal held is the KEYS VIEW button of the app
        view = self.js("return document.body.dataset.view")
        self.midi(0xb0, 64, 127); self.midi(0x99, 38, 100); self.midi(0x89, 38, 0); self.midi(0xb0, 64, 0); time.sleep(0.2)
        self.assertNotEqual(self.js("return document.body.dataset.view"), view, "MOD + pad 3 did not press KEYS VIEW")
        # FM-1 MENU (pad 16 = pad 8 with the pedal) opens the menu, and pressed again goes back to the FM-1
        for want in (False, True):
            self.midi(0xb0, 64, 127); self.midi(0x99, 43, 100); self.midi(0x89, 43, 0); self.midi(0xb0, 64, 0); time.sleep(0.2)
            self.assertEqual(self.js("return document.querySelector('#menu').hidden"), want, "FM-1 MENU pad")
        self.midi(0xb0, 70, 64); self.midi(0xb0, 71, 10); self.midi(0xb0, 71, 90)  # knobs with no firmware running: nothing breaks
        self.assertEqual(self.errors(), [])

    def test_map_wizard_learns_and_goes_back(self):
        self.open()
        self.js("document.querySelector('#midiMap').click()"); time.sleep(0.4)
        step = lambda: self.js("var h = document.querySelector('#mdWiz:not([hidden]) h3'); return h ? h.textContent : ''")
        self.midi(0x90, 60, 9); self.assertIn("LEFTMOST", step())
        self.midi(0x90, 48, 90); self.midi(0x90, 72, 90); self.assertIn("MOD KEY", step())
        self.js("document.querySelector('[data-do=wizBack]').click()"); self.assertIn("RIGHTMOST", step())
        self.midi(0x90, 72, 90); self.midi(0xb0, 64, 127); self.assertIn("PADS", step())
        for n in range(36, 44): self.midi(0x99, n, 100)
        self.js("document.querySelector('[data-do=wizNext]').click()"); self.assertIn("KNOBS", step())
        for cc in range(70, 78): self.midi(0xb0, cc, 50)
        while step(): self.js("document.querySelector('[data-do=wizNext]').click()")
        m = json.loads(self.js("return localStorage.getItem('pocket.midi.hw.v1')"))["MPK mini Play mk3"]
        self.assertEqual((m["keys"], m["ccs"], m["modKey"], m["padNotes"]), (25, list(range(70, 78)), "c0:64", [list(range(36, 44))]))
        self.assertEqual(self.errors(), [])

    def test_odd_messages_with_no_firmware(self):
        self.open(STD)
        for d in ([0x90, 60, 100], [0x80, 60, 0], [0x90, 61, 0], [0xf0, 0x7e, 0x7f, 0xf7], [0xf8], [0xfe], [0xff], [60], [0x9f, 1, 1], [0xbf, 120, 0], [0xb0, 99, 0], [0xb0, 98, 1], [0xb0, 6, 64], [0xe0, 0, 64], [0xd0, 3], [0xc0, 1]):
            self.midi(*d)
        self.assertEqual(self.errors(), [])

    # (was a bug, fixed) (shared panel): MOD + pad holds an FM-1 button; MOD let go before the pad sends the release to the first-set button
    def test_a_pad_let_go_after_mod_lets_its_button_go(self):
        self.open(STD)
        self.midi(0xb0, 64, 127); self.midi(0x99, 36, 100)  # MOD + pad 1: the FM-1's PLAY (btn12), held
        self.assertEqual(self.js("return holds[12]"), 1)
        self.midi(0xb0, 64, 0); self.midi(0x89, 36, 0)  # MOD up first, then the pad
        self.assertEqual(self.js("return holds[12]"), 0, "the FM-1's PLAY button stays held")


if __name__ == "__main__":
    unittest.main(verbosity=2)
