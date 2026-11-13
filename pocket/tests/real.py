"""REAL FM-1 pane of pocket/index.html against a fake unit (no hardware, no firmware, no network).

    python3 pocket/build.py && python pocket/tests/real.py      (needs: pip install selenium, Chrome)

The fake unit has a firmware port ("FM-1 MIDI 1": answers its identity, and on the upgrade message reads the package by 0x30
as a real firmware does, then restarts) and, after that, an update port ("FM-1 Update": m-bootloader's read commands).
"""
import functools, http.server, os, threading, time, unittest
from selenium import webdriver

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOOK = """window.__errs = []; addEventListener('error', e => __errs.push(String(e.message)));
addEventListener('unhandledrejection', e => __errs.push('promise: ' + (e.reason && e.reason.message || e.reason)));
window.__log = [];
navigator.requestMIDIAccess = (o) => { window.__sysex = !!(o && o.sysex); return Promise.resolve(window.__acc || (window.__acc = makeUnit())); };
function makeUnit() {
  const R = RealFM1, flash = new Uint8Array(0x100000).map((_, i) => (i * 7 + (i >> 9)) & 255);
  const port = (name, type) => ({ id: name + type, name, type, state: 'connected', onmidimessage: null });
  const fwIn = port('FM-1 MIDI 1', 'input'), upIn = port('FM-1 Update', 'input'), ctlIn = port('MPK mini Play mk3', 'input');
  const acc = { inputs: new Map([[fwIn.id, fwIn], [ctlIn.id, ctlIn]]), outputs: new Map(), onstatechange: null, sysexEnabled: true };
  const tell = (inp, bytes) => setTimeout(() => inp.onmidimessage && inp.onmidimessage({ data: bytes }), 0);
  const le = (b, i) => (b[i] | b[i + 1] << 8 | b[i + 2] << 16 | b[i + 3] << 24) >>> 0;
  let got = 0, total = 0, head = new Uint8Array(512);
  const ask = (at) => { const n = total ? Math.min(512, total - at) : 512; tell(fwIn, R.frame(0x30, [0, at & 255, at >> 8 & 255, at >> 16 & 255, at >>> 24, n & 255, n >> 8, 0])); };
  const fwOut = { name: 'FM-1 MIDI 1', send(b) {
    window.__log.push('fw:' + Array.from(b.slice(0, 6)).map(x => x.toString(16)).join(' '));
    const p = R.parse(b);
    if (!p) return;
    if (p.soft === 0x7f) { got = 0; total = 0; return ask(0); }
    if (p.cmd === 0x11) return tell(fwIn, R.frame(0x11, Array.from('FM-1_015' + ' '.repeat(19)).map(c => c.charCodeAt(0))));
    if (p.cmd === 0x30) {
      const at = le(p.body, 1);
      if (at === 0) { head.set(p.body.subarray(8, 8 + 64)); total = le(R.enc(0xffff, head.subarray(0, 64)), 4); }
      got = at + (total ? Math.min(512, total - at) : 512);
      if (got < total) return ask(got);
      // the whole package is read: the unit restarts into the helper, its firmware port goes, the update port comes
      window.__served = total;
      acc.inputs.delete(fwIn.id); acc.inputs.set(upIn.id, upIn); acc.outputs.delete('FM-1 MIDI 1'); acc.outputs.set('FM-1 Update', upOut);
      setTimeout(() => acc.onstatechange && acc.onstatechange({}), 50);
    }
  } };
  const upOut = { name: 'FM-1 Update', send(b) {
    const p = R.parse(b); if (!p || !p.cmd) return;
    const a = p.body, at = le(a, 1), n = a[5] | a[6] << 8 | a[7] << 16;
    if (p.cmd === 0x12) tell(upIn, R.frame(0x12, [...Array.from('MBOOT').map(c => c.charCodeAt(0)), 1, 2, 1, 0x0f, 0x98, 0, 0, 0x10, 0, 0x14, 0x60, 0x85, 0, 1, 2, 3, 4, 5, 6, 7, 8, 0, 0, ...Array.from('2.4-fake\\0').map(c => c.charCodeAt(0))]));
    else if (p.cmd === 0x23) tell(upIn, R.frame(0x23, [...a.slice(0, 8), ...flash.subarray(at, at + n)]));
    else if (p.cmd === 0x24) tell(upIn, R.frame(0x24, [...a.slice(0, 8), ...new Uint8Array(new Uint32Array([R.crc32(flash.subarray(at, at + n))]).buffer)]));
  } };
  acc.outputs.set('FM-1 MIDI 1', fwOut);
  window.__fwOut = fwOut; window.__fwIn = fwIn; window.__ctlIn = ctlIn; window.__flash = flash;
  return acc;
}"""


def setUpModule():
    global SRV, BASE
    SRV = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(type("Q", (http.server.SimpleHTTPRequestHandler,), {"log_message": lambda *a: None}), directory=ROOT))
    threading.Thread(target=SRV.serve_forever, daemon=True).start()
    BASE = "http://127.0.0.1:%d/" % SRV.server_address[1]


def tearDownModule(): SRV.shutdown()


class Real(unittest.TestCase):
    def setUp(self):
        o = webdriver.ChromeOptions()
        for a in ("--headless=new", "--mute-audio", "--window-size=844,390"): o.add_argument(a)
        self.d = webdriver.Chrome(options=o)
        self.addCleanup(self.d.quit)
        self.d.execute_cdp_cmd("Network.enable", {})
        self.d.execute_cdp_cmd("Network.setBlockedURLs", {"urls": ["https://*", "http://*.*"]})
        self.d.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {"source": HOOK})
        self.d.get(BASE + "index.html"); time.sleep(1.5)

    def js(self, code, *a): return self.d.execute_script(code, *a)

    def click(self, sel): self.js("document.querySelector(arguments[0]).click()", sel); time.sleep(0.3)

    def slide(self):
        self.js("var s = document.querySelector('#sureSlide'); s.value = 100; s.dispatchEvent(new Event('change'))")

    def text(self, sel): return self.js("return document.querySelector(arguments[0]).textContent", sel)

    def wait(self, test, secs=40):
        t = time.time()
        while time.time() - t < secs:
            if self.js("return " + test): return
            time.sleep(0.3)
        self.fail("timed out: " + test + " | " + self.text("#realMsg"))

    def test_connect_asks_for_sysex_and_names_the_ports_and_leaves_the_controller_alone(self):
        self.click('#menu [data-tab=conn]') if self.js("return !!document.querySelector('#menu [data-tab=conn]')") else None
        self.click('button[data-sub=real]'); self.click('#realConn'); time.sleep(0.5)
        self.assertTrue(self.js("return window.__sysex"))
        self.assertIn("firmware port: FM-1 MIDI 1", self.text("#realNames"))
        # CONNECT MIDI lists the controller, not the real unit
        self.click('#midi'); time.sleep(0.3)
        self.assertIn("MPK mini", self.text("#midiNames")); self.assertNotIn("FM-1", self.text("#midiNames"))
        self.assertEqual(self.js("return window.__errs"), [])

    def test_sync_sends_what_you_play_to_the_unit(self):
        self.click('button[data-sub=real]'); self.click('#realConn')
        self.js("window.__sent = []; const o = window.__fwOut.send; window.__fwOut.send = (b) => { __sent.push(Array.from(b)); o(b); }")
        self.js("realThru([0x90, 60, 100])")
        self.assertEqual(self.js("return __sent.length"), 0, "sync is off: nothing goes out")
        self.click('#realSync'); self.assertIn("SYNC ON", self.text("#realSync"))
        self.js("realThru([0x90, 60, 100]); realThru([0xf0, 1, 0xf7])")
        self.assertEqual(self.js("return __sent"), [[0x90, 60, 100]], "notes go, SysEx never does")
        self.js("window.__fwIn.onmidimessage({ data: new Uint8Array([0xf8]) })")  # the unit's clock arrives with no error
        self.assertEqual(self.js("return window.__errs"), [])

    def test_backup_sends_the_helper_then_reads_the_flash(self):
        self.click('button[data-sub=real]'); self.click('#realConn')
        self.js("window.__saved = null; HTMLAnchorElement.prototype.click = function () { __saved = this.download; }")
        self.click('#realBackup'); self.assertFalse(self.js("return document.querySelector('#sure').hidden"))
        self.slide()
        self.wait("window.__saved")
        self.assertRegex(self.js("return __saved"), r"^fm1-backup-0102030405060708-\d{4}-\d\d-\d\d\.bin$")
        self.assertGreater(self.js("return __served"), 9000)  # the whole helper package was read by the unit
        self.assertIn("checked", self.text("#realMsg"))
        self.assertEqual(self.js("return REAL.saved.uid"), "0102030405060708")
        self.assertEqual(self.js("return window.__errs"), [])

    def test_the_protector_and_the_firmware_wait_for_their_steps(self):
        self.click('button[data-sub=real]'); self.click('#realConn')
        self.click('#realProt'); self.assertTrue(self.js("return document.querySelector('#sure').hidden"), "no protector before a backup")
        self.click('#realFw'); self.assertTrue(self.js("return document.querySelector('#sure').hidden"), "no firmware without MIDI mode")


if __name__ == "__main__": unittest.main(verbosity=2)
