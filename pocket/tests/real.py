"""REAL FM-1 pane of pocket/index.html against a fake unit (no hardware, no firmware, no network).

    python3 pocket/build.py && python pocket/tests/real.py      (needs: pip install selenium, Chrome)

The fake unit has a firmware port ("FM-1 MIDI 1": answers its identity, and on the upgrade message reads the package by 0x30
as a real firmware does, then restarts) and, after that, an update port ("FM-1 Update": m-bootloader's read commands).
"""
import functools, http.server, os, shutil, tempfile, threading, time, unittest
from selenium import webdriver

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOOK = """window.__errs = []; addEventListener('error', e => __errs.push(String(e.message)));
addEventListener('unhandledrejection', e => __errs.push('promise: ' + (e.reason && e.reason.message || e.reason)));
window.__log = [];
navigator.requestMIDIAccess = (o) => { window.__sysex = !!(o && o.sysex); return Promise.resolve(window.__acc || (window.__acc = makeUnit())); };
function makeUnit() {
  const R = RealFM1, flash = window.__flashInit ? Uint8Array.from(window.__flashInit) : new Uint8Array(0x100000).map((_, i) => (i * 7 + (i >> 9)) & 255);
  const port = (name, type) => ({ id: name + type, name, type, state: 'connected', onmidimessage: null });
  const fwIn = port('FM-1 MIDI 1', 'input'), upIn = port('FM-1 Update', 'input'), ctlIn = port('MPK mini Play mk3', 'input');
  const acc = { inputs: new Map([[fwIn.id, fwIn], [ctlIn.id, ctlIn]]), outputs: new Map(), onstatechange: null, sysexEnabled: true };
  const tell = (inp, bytes) => setTimeout(() => inp.onmidimessage && inp.onmidimessage({ data: bytes }), 0);
  const le = (b, i) => (b[i] | b[i + 1] << 8 | b[i + 2] << 16 | b[i + 3] << 24) >>> 0;
  let got = 0, total = 0, head = new Uint8Array(512);
  const ask = (at) => { const n = total ? Math.min(512, total - at) : 512; tell(fwIn, R.frame(0x30, [0, at & 255, at >> 8 & 255, at >> 16 & 255, at >>> 24, n & 255, n >> 8, 0])); };
  const fwOut = { name: 'FM-1 MIDI 1', send(b) {
    window.__log.push('fw:' + Array.from(b.slice(0, 6)).map(x => x.toString(16)).join(' '));
    if (b[0] === 0xf0 && b[1] === 0x7d) { // Tether (the page asks HELLO, sends screens and LEDs); only when the test says the unit runs it
      (window.__tx = window.__tx || []).push(Array.from(b));
      if (!window.__tether) return;
      const name = Array.from('Tether').map(c => c.charCodeAt(0)); // __tetherCa set: a protocol 2 unit with that CA (1 = USB speaker)
      if (b[6] === 1) tell(fwIn, Tether.message(0x41, window.__tetherCa === undefined ? [1, 0, 27, 14, 7, ...name] : [2, 0, 27, 14, 7, window.__tetherCa, ...name]));
      if (b[6] === 3 && (b[10] & 1)) tell(fwIn, Tether.message(0x42, [b[7]]));
      return;
    }
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
    const p = R.parse(b);
    if (p && p.soft) window.__log.push('up:soft' + p.soft.toString(16));
    if (p && p.soft === 0x7e) { window.__restarted = 1; acc.inputs.delete(upIn.id); acc.inputs.set(fwIn.id, fwIn); acc.outputs.delete('FM-1 Update'); acc.outputs.set('FM-1 MIDI 1', fwOut); setTimeout(() => acc.onstatechange && acc.onstatechange({}), 50); return; }
    if (!p || !p.cmd) return;
    const a = p.body, at = le(a, 1), n = a[5] | a[6] << 8 | a[7] << 16;
    if (p.cmd === 0x12) tell(upIn, R.frame(0x12, [...Array.from('MBOOT').map(c => c.charCodeAt(0)), 1, window.__kind || 2, 1, 0x0f, 0x98, 0, 0, 0x10, 0, 0x14, 0x60, 0x85, 0, 1, 2, 3, 4, 5, 6, 7, 8, 0, 0, ...Array.from('2.4-fake\\0').map(c => c.charCodeAt(0))]));
    else if (p.cmd === 0x23) tell(upIn, R.frame(0x23, [...a.slice(0, 8), ...flash.subarray(at, at + n)]));
    else if (p.cmd === 0x24) tell(upIn, R.frame(0x24, [...a.slice(0, 8), ...new Uint8Array(new Uint32Array([R.crc32(flash.subarray(at, at + n))]).buffer)]));
  } };
  acc.outputs.set('FM-1 MIDI 1', fwOut);
  if (window.__startUpdate) { acc.inputs.delete(fwIn.id); acc.inputs.set(upIn.id, upIn); acc.outputs.delete('FM-1 MIDI 1'); acc.outputs.set('FM-1 Update', upOut); }
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
        for a in ("--headless=new", "--mute-audio", "--window-size=844,390", "--autoplay-policy=no-user-gesture-required"): o.add_argument(a)
        dl = tempfile.mkdtemp(prefix="fm1-test-dl-")  # the backups the page saves go here, not into the user's Downloads
        self.dl = dl
        self.addCleanup(shutil.rmtree, dl, True)
        o.add_experimental_option("prefs", {"download.default_directory": dl, "download.prompt_for_download": False})
        self.d = webdriver.Chrome(options=o)
        self.addCleanup(self.d.quit)
        self.d.execute_cdp_cmd("Network.enable", {})
        self.d.execute_cdp_cmd("Network.setBlockedURLs", {"urls": ["https://*", "http://*.*"]})
        self.d.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {"source": HOOK})
        self.d.get(BASE + "index.html"); time.sleep(1.5)

    def js(self, code, *a): return self.d.execute_script(code, *a)

    def click(self, sel): self.js("document.querySelector(arguments[0]).click()", sel); time.sleep(0.3)

    def dismiss(self): self.js("var s = document.querySelector('#sure'); if (!s.hidden && s.classList.contains('alarm')) { var r = document.querySelector('#sureSlide'); r.value = 100; r.dispatchEvent(new Event('change')) }"); time.sleep(0.2)  # the warning shown on entering REAL FM-1

    def open_real(self): self.click('button[data-sub=real]'); self.dismiss()

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
        self.open_real(); self.click('#realConn'); time.sleep(0.5)
        self.assertTrue(self.js("return window.__sysex"))
        self.assertIn("firmware port: FM-1 MIDI 1", self.text("#realNames"))
        # CONNECT MIDI lists the controller, not the real unit
        self.click('#midi'); time.sleep(0.3)
        self.assertIn("MPK mini", self.text("#midiNames")); self.assertNotIn("FM-1", self.text("#midiNames"))
        self.assertEqual(self.js("return window.__errs"), [])

    def test_inspect_copies_a_read_only_report(self):
        self.click('#menu [data-tab=conn]') if self.js("return !!document.querySelector('#menu [data-tab=conn]')") else None
        self.open_real(); self.click('#realConn'); time.sleep(0.5)
        self.js("window.__copied = null; Object.defineProperty(navigator, 'clipboard', {value: {writeText: t => (window.__copied = t, Promise.resolve())}, configurable: true})")
        self.click('#realInfo'); self.wait("window.__copied")
        r = self.js("return window.__copied")
        for want in ("FM-1 MIDI 1", "identity: FM-1_015", "sysex: allowed", "MIDI inputs:"): self.assertIn(want, r)
        self.assertNotIn("0x23", "\n".join(self.js("return window.__log")))  # nothing but the identity was asked

    def test_restart_takes_the_unit_out_of_the_helper(self):
        self.click('#menu [data-tab=conn]') if self.js("return !!document.querySelector('#menu [data-tab=conn]')") else None
        self.open_real(); self.click('#realConn'); time.sleep(0.5)
        self.click('#realRestart')  # no helper yet: it only says so
        self.assertFalse(self.js("return !!window.__restarted"))
        self.click('#realBackup'); self.slide(); self.wait("document.querySelector('#realMsg').textContent.includes('Backup saved')", 90)
        self.click('#realRestart'); self.slide(); self.wait("window.__restarted && document.querySelector('#realMsg').textContent.includes('back on its firmware')", 40)

    def test_sync_sends_what_you_play_to_the_unit(self):
        self.open_real(); self.click('#realConn')
        self.js("window.__sent = []; const o = window.__fwOut.send; window.__fwOut.send = (b) => { __sent.push(Array.from(b)); o(b); }")
        self.js("realThru([0x90, 60, 100])")
        self.assertEqual(self.js("return __sent.length"), 0, "sync is off: nothing goes out")
        self.click('#realSync'); self.assertIn("PLAYING TOGETHER", self.text("#realSync")); time.sleep(1)  # (it asks HELLO first: nobody answers)
        self.js("__sent.length = 0; realThru([0x90, 60, 100]); realThru([0xf0, 1, 0xf7])")
        self.assertEqual(self.js("return __sent"), [[0x90, 60, 100]], "notes go, SysEx never does")
        self.js("window.__fwIn.onmidimessage({ data: new Uint8Array([0xf8]) })")  # the unit's clock arrives with no error
        self.assertEqual(self.js("return window.__errs"), [])

    def test_tether_unit_is_the_panel_and_shows_the_screen(self):
        self.js("window.__tether = true")
        self.open_real(); self.click('#realConn'); self.click('#realSync'); time.sleep(1.2)
        self.assertIn("TETHER", self.text("#realSync"))
        down = lambda i: self.js("return holds[arguments[0]]", i)
        self.js("window.__fwIn.onmidimessage({ data: [0x90, 55, 100] }); window.__fwIn.onmidimessage({ data: [0x9f, 12, 0x7f] })")
        self.assertEqual((down(16), down(12)), (1, 1), "a key (note 55 = key 2 = matrix id 16) and PLAY are held")
        self.js("window.__fwIn.onmidimessage({ data: [0x80, 55, 0] }); window.__fwIn.onmidimessage({ data: [0x8f, 12, 0] })")
        self.assertEqual((down(16), down(12)), (0, 0))
        self.js("window.__fwIn.onmidimessage({ data: [0xbf, 22, 66] }); window.__fwIn.onmidimessage({ data: [0xbf, 27, 127] })")
        self.assertEqual(self.js("return [clicks[3], pot]"), [2, 1023], "KNOB1 +2 clicks, MASTER full")
        self.js("window.__tx.length = 0; tetherHook.frame(new Uint16Array(57600).fill(0x1234))")
        self.wait("__tx.length > 0", 5); time.sleep(0.5)
        first = self.js("return __tx.filter(m => m[6] === 3).length")
        self.assertGreater(first, 0, "the first frame goes out as SysEx")
        self.assertEqual(self.js("return REAL.tether.inflight"), False, "its ACK came back")
        self.js("__tx.length = 0; tetherHook.frame(new Uint16Array(57600).fill(0x1234))"); time.sleep(0.4)
        self.assertEqual(self.js("return __tx.filter(m => m[6] === 3).length"), 0, "the same frame again sends nothing")
        self.assertTrue(self.js("return document.querySelector('#sure').hidden"), "a protocol 1 unit: no question about the sound")
        self.js("ledNow[8] = 1; tetherHook.leds()"); time.sleep(0.2)
        self.assertEqual(self.js("return __tx.filter(m => m[6] === 2).length"), 1, "HOME's LED goes out as one LEDS message")
        self.click('#realSync'); self.assertNotIn("TETHER", self.text("#realSync"))
        self.assertEqual(self.js("return window.__errs"), [])

    # the browser's outputs, nameless until a microphone is asked for (as Chrome does), and setSinkId recorded
    OUTPUTS = """window.__sinks = []; window.__mic = 0; window.__named = false;
      window.__outs = arguments[0];
      Object.defineProperty(navigator, 'mediaDevices', {configurable: true, value: {
        enumerateDevices: () => Promise.resolve(__outs.map(d => ({...d, label: __named ? d.label : ''}))),
        getUserMedia: () => (__mic++, __named = true, Promise.resolve({getTracks: () => [{stop() {}}]})) }});
      AudioContext.prototype.setSinkId = function (id) { __sinks.push(id); return Promise.resolve(); };
      ac = { setSinkId: AudioContext.prototype.setSinkId };"""

    def test_tether_with_a_speaker_offers_the_sound_and_gives_it_back(self):
        self.js("window.__tether = true; window.__tetherCa = 1")
        self.js(self.OUTPUTS, [{"kind": "audiooutput", "deviceId": "default", "label": "Default - Felucca"}, {"kind": "audiooutput", "deviceId": "spk", "label": "MacBook Speakers"},
                               {"kind": "audiooutput", "deviceId": "fm1", "label": "Felucca (1209:0001)"}, {"kind": "audioinput", "deviceId": "m", "label": "Felucca"}])
        self.open_real(); self.click('#realConn'); self.click('#realSync'); time.sleep(1.2)
        self.assertIn("TETHER", self.text("#realSync"))
        self.assertFalse(self.js("return document.querySelector('#sure').hidden"), "a unit with a speaker: the page offers the sound")
        self.assertIn("SOUND ON THE FM-1", self.text("#sureOpt"))
        self.slide(); self.wait("__sinks.length", 5)
        self.assertEqual(self.js("return [__sinks, sink, __mic]"), [["fm1"], "fm1", 1], "names came after the microphone was asked once; the FM-1's output, not the default alias")
        self.assertIn("Felucca", self.text("#toast"))
        self.click('#realSync')  # Tether off: the page offers the sound back
        self.assertFalse(self.js("return document.querySelector('#sure').hidden"))
        self.assertIn("Tether is off", self.text("#sureText"))
        self.slide(); self.wait("__sinks.length === 2", 5)
        self.assertEqual(self.js("return [__sinks[1], sink]"), ["", ""], "back on the default output")
        self.assertEqual(self.js("return window.__errs"), [])

    def test_tether_sound_picker_and_no_setsinkid(self):
        self.js(self.OUTPUTS, [{"kind": "audiooutput", "deviceId": "a", "label": "Speakers"}, {"kind": "audiooutput", "deviceId": "b", "label": "USB Audio Device"}])
        self.js("window.__named = true; tetherSound()"); time.sleep(0.4)
        self.assertEqual(self.js("return [...document.querySelectorAll('#sureOpt button')].map(b => b.textContent)"), ["Speakers", "USB Audio Device"], "no output named like the FM-1: a list to pick from")
        self.js("document.querySelectorAll('#sureOpt button')[1].click()"); self.slide(); self.wait("__sinks.length", 5)
        self.assertEqual(self.js("return [__sinks, sink, __mic]"), [["b"], "b", 0], "names were there: no microphone asked")
        self.js("ac = null; delete AudioContext.prototype.setSinkId; tetherSound()"); time.sleep(0.4)
        self.assertIn("cannot send the sound", self.text("#toast"))
        self.js("window.__outs = []; AudioContext.prototype.setSinkId = () => Promise.reject(Error('NotFoundError')); ac = { setSinkId: AudioContext.prototype.setSinkId }; soundTo('gone', 'X')"); time.sleep(0.3)
        self.assertIn("Could not move the sound", self.text("#toast"))
        self.assertEqual(self.js("return sink"), "b", "a failed move keeps the output it had")
        self.assertEqual(self.js("return window.__errs"), [])

    def test_in_midi_mode_the_play_button_installs_tether_after_the_checks(self):
        self.js("window.__startUpdate = true; window.__kind = 2")
        self.open_real(); self.click('#realConn'); self.wait("REAL.info && REAL.info.mboot", 20)
        self.assertIn("INSTALL TETHER", self.text("#realSync"))
        self.assertFalse(self.js("return document.querySelector('#realSync').disabled"))
        self.click('#realSync'); time.sleep(0.5)
        self.assertFalse(self.js("return document.querySelector('#job').hidden"))
        self.assertIn("LOCKED", self.text("#jobTitle"))  # no backup of this unit yet: the same checks as any firmware's INSTALL
        self.assertTrue(self.js("return tetherFirmware().then(f => f.bytes.length > 100000)"), "the bundled package checks out")
        self.assertEqual(self.js("return window.__errs"), [])

    def test_tether_as_a_plain_controller_sends_no_screen_and_offers_no_sound(self):
        self.js("window.__tether = true; window.__tetherCa = 1")
        self.js("document.querySelector('#optScreen').click(); document.querySelector('#optSound').click()")
        self.assertEqual(self.js("return [document.querySelector('#optScreen i').textContent, document.querySelector('#optSound i').textContent]"), ["OFF", "OFF"])
        self.open_real(); self.click('#realConn'); self.click('#realSync'); time.sleep(1.2)
        self.assertIn("TETHER", self.text("#realSync"))
        self.assertTrue(self.js("return document.querySelector('#sure').hidden"), "sound off: no offer, even from a unit with a speaker")
        self.js("window.__tx.length = 0; tetherHook.frame(new Uint16Array(57600).fill(0x1234))"); time.sleep(0.6)
        self.assertEqual(self.js("return __tx.filter(m => m[6] === 3).length"), 0, "screen off: no frame goes out")
        self.js("ledNow[8] = 1; tetherHook.leds()"); time.sleep(0.2)
        self.assertEqual(self.js("return __tx.filter(m => m[6] === 2).length"), 1, "the lights still follow")
        self.js("window.__fwIn.onmidimessage({ data: [0x90, 55, 100] })")
        self.assertEqual(self.js("return holds[16]"), 1, "the keys still play")
        self.click('#optScreen'); self.wait("__tx.filter(m => m[6] === 3).length > 0", 5)  # back on: the screen follows at once
        self.assertEqual(self.js("return window.__errs"), [])

    def test_the_main_screen_shows_tether_s_buttons_and_offers_a_unit_that_appears(self):
        self.js("window.__tether = true; window.__tetherCa = 1")
        self.assertTrue(self.js("return document.querySelector('#railScreen').hidden"), "no Tether: no buttons")
        self.open_real(); self.click('#realConn'); self.click('#realSync'); time.sleep(1.2)
        self.assertFalse(self.js("return document.querySelector('#railScreen').hidden"), "Tether found: the screen button is on the rail")
        self.assertFalse(self.js("return document.querySelector('#railSound').hidden"), "a unit with a speaker: the sound button too")
        self.assertIn("ON", self.text("#railScreen"))
        self.js("document.querySelector('#railScreen').click()")
        self.assertEqual(self.text("#railScreen"), "SCREEN OFF")
        self.click('#realSync')
        self.assertTrue(self.js("return document.querySelector('#railScreen').hidden"), "Tether off: the buttons go")

    def test_a_unit_found_while_the_menu_is_closed_is_offered_once(self):
        self.js("window.__tether = true")
        self.open_real(); self.click('#realConn')
        self.js("document.querySelector('#menuClose').click(); offered = null; REAL.sync = false")
        self.js("realOffer()")
        self.assertFalse(self.js("return document.querySelector('#sure').hidden"), "the main screen asks")
        self.assertIn("USE THE REAL FM-1", self.text("#sureOpt"))
        self.js("document.querySelector('#sureNo') && document.querySelector('#sureNo').click()")
        self.js("realOffer()")
        self.assertTrue(self.js("return document.querySelector('#sure').hidden"), "once per unit")

    def test_backup_while_tether_runs_points_to_midi_mode(self):
        self.js("window.__tether = true")
        self.open_real(); self.click('#realConn'); self.click('#realSync'); time.sleep(1.2)
        self.click('#realBackup')
        self.assertIn("MIDI MODE", self.text("#jobTitle"))
        self.assertTrue(self.js("return document.querySelector('#sure').hidden"), "no helper is offered, nothing is sent")
        self.click('#jobOk')

    def test_a_job_that_goes_quiet_gets_a_close_button(self):
        self.open_real()
        self.js("REAL.busy = true; jobOpen('BACKUP…'); jobSeen -= 50000")
        self.wait("!document.querySelector('#jobOk').hidden", 8)
        self.assertIn("NO ANSWER", self.text("#jobTitle"))
        self.click('#jobOk')
        self.assertFalse(self.js("return REAL.busy"), "closing frees the unit for the next try")
        self.assertTrue(self.js("return document.querySelector('#job').hidden"))

    def test_backup_sends_the_helper_then_reads_the_flash(self):
        self.open_real(); self.click('#realConn')
        self.js("window.__saved = null; HTMLAnchorElement.prototype.click = function () { __saved = this.download; }")
        self.click('#realBackup'); self.assertFalse(self.js("return document.querySelector('#sure').hidden"))
        self.slide()
        self.wait("window.__saved")
        self.assertRegex(self.js("return __saved"), r"^fm1-backup-0102030405060708-\d{4}-\d\d-\d\d\.bin$")
        self.assertGreater(self.js("return __served"), 9000)  # the whole helper package was read by the unit
        self.assertIn("checked", self.text("#realMsg"))
        self.assertEqual(self.js("return REAL.saved.uid"), "0102030405060708")
        # the backup is the first firmware of the list, chosen, and kept apart from the downloads
        self.assertEqual(self.js("var o = document.querySelector('#fw').options; return [o[0].value, document.querySelector('#fw').value]"), ["backup", "backup"])
        self.assertEqual(self.js("return window.__errs"), [])

    FW = os.environ.get("FWSC")

    @unittest.skipUnless(FW, "set FWSC=path/to/firmware.fwsc: its flash stands in for the unit's, and the backup must boot in the emulator")
    def test_the_backup_of_a_unit_runs_in_the_emulator(self):
        import subprocess, json
        raw = subprocess.run(["node", "-e", """const R = require(process.argv[1] + '/vendor/real-fm1.js'), u = R.unweave(require('fs').readFileSync(process.argv[2])), f = u.files.find(f => f.type === 0);
          const flash = new Uint8Array(0x100000).fill(255); flash.set(u.image.subarray(f.offset, f.offset + f.size)); process.stdout.write(JSON.stringify(Array.from(flash)))""", ROOT, os.path.abspath(self.FW)], capture_output=True, check=True).stdout
        self.js("window.__flashInit = arguments[0]", json.loads(raw))
        self.open_real(); self.click('#realConn')
        self.js("HTMLAnchorElement.prototype.click = function () {}")
        self.click('#realBackup'); self.slide()
        self.wait("(document.querySelector('#realMsg').textContent.match(/It runs here|did not draw/) || [])[0]", 90)
        self.assertIn("It runs here", self.text("#realMsg"))
        self.assertEqual(self.js("return window.__errs"), [])

    def test_the_protector_and_the_firmware_wait_for_their_steps(self):
        self.open_real(); self.click('#realConn')
        self.click('#realProt'); self.assertTrue(self.js("return document.querySelector('#sure').hidden"), "no protector before a backup")
        self.install_card(); self.assertTrue(self.js("return document.querySelector('#sure').hidden"), "no firmware without MIDI mode")

    def test_no_protector_no_custom_firmware(self):
        self.click('#menu [data-tab=conn]') if self.js("return !!document.querySelector('#menu [data-tab=conn]')") else None
        self.open_real(); self.click('#realConn'); time.sleep(0.5)
        self.click('#realWarn'); self.assertIn("M-Flasher", self.text("#jobText")); self.click('#jobOk')  # the warnings are a dialog, the pane never scrolls
        self.click('#realBackup'); self.slide(); self.wait("document.querySelector('#realMsg').textContent.includes('Backup saved')", 90)
        self.assertIn("NOT in this flash", self.text("#realMsg"))
        self.assertEqual(self.js("return document.querySelectorAll('#realMapGrid i').length"), 256)
        self.assertFalse(self.js("return document.querySelector('#realMap').hidden"))
        self.assertIn("protector: NOT installed", self.text("#realNames"))
        self.install_card(); self.assertTrue(self.js("return document.querySelector('#sure').hidden"), "no firmware without the protector")
        self.assertFalse(self.js("return document.querySelector('#job').hidden"), "a dialog says why")
        self.assertIn("NO PROTECTOR, NO CUSTOM FIRMWARE", self.text("#jobTitle"))

    def install_card(self):  # the buttons of the cards are the way to install; a hidden one still answers a click
        self.js("document.querySelector('#fwList .inst:not([data-own=\"1\"])').click()"); time.sleep(0.3)

    def files(self): return [f for f in os.listdir(self.dl) if f.endswith(".bin")]

    def test_the_backup_is_kept_in_the_browser_and_its_file_is_saved_once(self):
        self.js("document.querySelector('#logo').click()")  # the menu is open, as for a user: a backup must leave it open
        self.click('#menu [data-tab=conn]') if self.js("return !!document.querySelector('#menu [data-tab=conn]')") else None
        self.open_real(); self.click('#realConn'); time.sleep(0.5)
        self.click('#realBackup'); self.slide(); self.wait("document.querySelector('#realMsg').textContent.includes('Backup saved')", 90)
        time.sleep(1); self.assertEqual(len(self.files()), 1)
        self.click('#realBackup'); self.wait("document.querySelector('#realMsg').textContent.includes('Backup kept in this browser')", 90)
        time.sleep(1); self.assertEqual(len(self.files()), 1, "the second backup must not pile up another file")
        time.sleep(4)  # the backup starts the emulator and the menu stays on the REAL FM-1 page
        self.assertFalse(self.js("return document.querySelector('#job').hidden"), "the finished job waits for OK"); self.click('#jobOk')
        self.assertFalse(self.js("return document.querySelector('#menu').hidden")); self.assertEqual(self.js("return document.querySelector('#menu section[data-tab=conn]').dataset.sub"), 'real')
        self.d.find_element('css selector', '#realMoreBtn').click(); time.sleep(0.4)  # SAVE BACKUP lives in MORE
        self.d.find_element('css selector', '#realSave').click(); time.sleep(2); self.assertEqual(len(self.files()), 2)  # SAVE BACKUP gives the kept one on demand

    def test_install_unlocks_only_with_the_protector_running_and_shown_in_a_backup(self):
        plain = [0] * 0x70
        for i, c in enumerate("AC79BLID"): plain[0x40 + i] = ord(c)
        for i, c in enumerate("fm1"): plain[0x48 + i] = ord(c)
        for i, c in enumerate("m-bootloader 2.4-fake"): plain[0x50 + i] = ord(c)
        src = "window.__kind = 1; window.__startUpdate = 1; Object.defineProperty(window, '__flashInit', { get() { const f = new Uint8Array(0x100000).fill(255); f.set(RealFM1.enc(0xffff, Uint8Array.from(%s)), 0xb0); return f; } });" % plain
        self.d.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {"source": src})
        self.d.get(BASE + "index.html"); time.sleep(1.5)
        self.click('#menu [data-tab=conn]') if self.js("return !!document.querySelector('#menu [data-tab=conn]')") else None
        self.open_real()
        self.js("window.__copied = null; Object.defineProperty(navigator, 'clipboard', {value: {writeText: t => (window.__copied = t, Promise.resolve())}, configurable: true})")
        self.click('#realConn'); time.sleep(1.5)
        self.click('#realInfo'); self.wait("window.__copied"); self.assertIn("install unlocked: no", self.js("return window.__copied"))
        self.install_card(); self.assertTrue(self.js("return document.querySelector('#sure').hidden"), "locked before a backup shows the protector")
        self.click('#realBackup'); self.wait("document.querySelector('#realMsg').textContent.includes('is in this flash')", 90)
        self.js("window.__copied = null"); self.click('#realInfo'); self.wait("window.__copied")
        self.assertIn("install unlocked: yes", self.js("return window.__copied"))
        got = self.js("return [document.querySelectorAll('#fwList .inst:not([hidden])').length, document.querySelectorAll('#fwList .fwc').length, document.querySelectorAll('#fwList .inst').length]")
        self.assertIn(got[0], (got[1], got[1] - 1), "every card (the backup's own excepted) offers INSTALL: %s" % got)
        self.assertGreater(got[0], 50)
        # pressing INSTALL always answers: the confirmation, then a dialog with the result (here the package cannot be downloaded: no network)
        self.js("document.querySelector('#menu').hidden = false; document.querySelector('#menu [data-tab=fw]').click()"); time.sleep(0.5)
        self.js("document.querySelector('#fwList .inst:not([hidden])').click()"); time.sleep(0.5)
        self.assertFalse(self.js("return document.querySelector('#sure').hidden"), "asks first"); self.slide()
        self.wait("!document.querySelector('#job').hidden && document.querySelector('#jobTitle').textContent.includes('FAILED')", 40)
        self.assertIn("INSTALL", self.text("#jobTitle")); self.assertFalse(self.js("return document.querySelector('#jobOk').hidden"))
        self.click('#jobOk'); self.assertTrue(self.js("return document.querySelector('#job').hidden"))
        # in the protector's MIDI mode the unit waits for the "start install" message (7F) before it asks for the package
        self.js("""const KEY = 38927, fl = new Uint8Array(0x8000).fill(255), raw = new Uint8Array(32).map((_, i) => i * 3 + 1); // a firmware this unit's key can read
          const c = RealFM1.crc16(raw.subarray(2, 32)); raw[0] = c & 255; raw[1] = c >> 8; fl.set(RealFM1.enc(KEY, raw), 0x4000);
          const dt = new DataTransfer(); dt.items.add(new File([RealFM1.wrap(fl, 'FM-1_015')], 'test.fwsc'));
          const i = document.querySelector('#file'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true }));"""); time.sleep(2)
        self.js("document.querySelector('#menu').hidden = false; document.querySelector('#menu [data-tab=fw]').click()"); time.sleep(0.5)
        self.js("document.querySelector('#job').hidden = true; [...document.querySelectorAll('#fwList .fwc')].find(c => /your file/.test(c.textContent)).querySelector('.inst').click()"); time.sleep(0.5)
        self.slide(); self.wait("window.__log.includes('up:soft7f')", 10)
        self.assertEqual(self.js("return window.__log.filter(l => l === 'up:soft7f').length"), 1)
        self.d.refresh(); time.sleep(1.5)  # leaves the unit's silence to the unit tests: a new page, the kept backup
        self.js("localStorage.clear()")
        # a reload forgets the session, not the browser: the kept backup unlocks it again
        self.d.refresh(); time.sleep(1.5)
        self.click('#menu [data-tab=conn]') if self.js("return !!document.querySelector('#menu [data-tab=conn]')") else None
        self.open_real()
        self.js("window.__copied = null; Object.defineProperty(navigator, 'clipboard', {value: {writeText: t => (window.__copied = t, Promise.resolve())}, configurable: true})")
        self.click('#realConn'); time.sleep(1.5); self.click('#realInfo'); self.wait("window.__copied")
        self.assertIn("install unlocked: yes", self.js("return window.__copied"))

    def test_a_backup_that_shows_the_protector_says_so(self):
        plain = [0] * 0x70
        for i, c in enumerate("AC79BLID"): plain[0x40 + i] = ord(c)
        for i, c in enumerate("fm1"): plain[0x48 + i] = ord(c)
        for i, c in enumerate("m-bootloader 2.4"): plain[0x50 + i] = ord(c)
        self.d.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {"source": "Object.defineProperty(window, '__flashInit', { get() { const f = new Uint8Array(0x100000).fill(255); f.set(RealFM1.enc(0xffff, Uint8Array.from(%s)), 0xb0); return f; } });" % plain})
        self.d.get(BASE + "index.html"); time.sleep(1.5)
        self.click('#menu [data-tab=conn]') if self.js("return !!document.querySelector('#menu [data-tab=conn]')") else None
        self.open_real(); self.click('#realConn'); time.sleep(0.5)
        self.click('#realBackup'); self.slide(); self.wait("document.querySelector('#realMsg').textContent.includes('Backup saved')", 90)
        self.assertIn("m-bootloader 2.4) is in this flash", self.text("#realMsg"))
        self.assertIn("protector: installed", self.text("#realNames"))
        self.click('#realProt'); self.assertTrue(self.js("return document.querySelector('#sure').hidden"), "already there: nothing to install")


if __name__ == "__main__": unittest.main(verbosity=2)
