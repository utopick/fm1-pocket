"""Two threads in the page: cross-origin isolation from the service worker, the Worker that runs core 1, the fallbacks.

    python3 pocket/build.py && FM1_MT_WASM=path/to/fm1_web_mt.wasm python pocket/tests/threads.py path/to/firmware.fwsc

FM1_MT_WASM is web/build-threads.sh's output (the test serves it as vendor/fm1_web_mt.wasm without putting it in the repo).
Needs selenium and Chrome. The first visit is not isolated (the service worker has not taken the page yet) and must play on
one thread; the second is isolated and runs core 1 on its Worker; ?threads=0 and a missing SharedArrayBuffer fall back.
"""
import functools, http.server, os, sys, threading, time
from selenium import webdriver
from selenium.webdriver.common.by import By

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
fwsc, mt = os.path.abspath(sys.argv[1]), os.path.abspath(os.environ["FM1_MT_WASM"])

class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path.split("?")[0].endswith("/vendor/fm1_web_mt.wasm"):
            b = open(mt, "rb").read()
            self.send_response(200); self.send_header("Content-Type", "application/wasm"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
        else: super().do_GET()

srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(H, directory=ROOT))
threading.Thread(target=srv.serve_forever, daemon=True).start()
url = "http://127.0.0.1:%d/index.html" % srv.server_address[1]

def browser():
    o = webdriver.ChromeOptions()
    for a in ("--headless=new", "--autoplay-policy=no-user-gesture-required", "--lang=en-US", "--mute-audio"): o.add_argument(a)
    d = webdriver.Chrome(options=o)
    d.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {"source": "window.__errs = []; addEventListener('error', e => __errs.push(String(e.message)));"})
    return d

def play(d, want, why):
    js = d.execute_script
    d.find_element(By.ID, "file").send_keys(fwsc); time.sleep(0.5)
    js("document.querySelector('#power').click()")
    for _ in range(60):
        time.sleep(0.5)
        if js("return new Set(new Uint32Array(document.querySelector('#lcd').getContext('2d').getImageData(0, 0, 240, 240).data.buffer)).size") > 2: break
    else: raise AssertionError(why + ": the screen stayed blank")
    mode = js("return FM1Threads.mode")
    assert mode == want, "%s: mode %s, wanted %s (%s)" % (why, mode, want, js("return FM1Threads.why"))
    js("setKey(12, true)"); time.sleep(0.3); js("setKey(12, false)")  # PLAY: 386DX's song, which is what keeps its core 1 busy
    if want == "threads":
        time.sleep(3); a = js("return FM1Threads.insns"); time.sleep(3); b = js("return FM1Threads.insns")
        assert js("return FM1Threads.started") == 2 and b - a > 20e6, "%s: core 1 does not do its share in the Worker (386DX's runs about 40 million instructions a second) (started %s, instructions %s -> %s, %s)" % (why, js("return FM1Threads.started"), a, b, js("return FM1Threads.why"))
    j = js("return FM1Threads.jit")
    assert j["regions"] > 0 and j["failed"] == 0, "%s: the wasm JIT does not work here: %s" % (why, j)
    print(why, "core 1 insns in the Worker", js("return FM1Threads.insns"), "jit regions", j["regions"])
    if want == "threads":
        j1 = js("return FM1Threads.jit1")
        assert j1 and j1["regions"] > 0 and j1["failed"] == 0, "%s: the wasm JIT does not work on core 1's side: %s" % (why, j1)
        print("  core 1's JIT:", j1)
    js("peak = 0; midiIn([0x90, 60, 110])"); time.sleep(2); pk = js("return peak"); assert pk > 0.005, why + ": no sound"; print("  peak", round(pk, 3))
    assert js("return __errs") == [], js("return __errs")

d = browser()
try:
    d.get(url); time.sleep(1)
    d.execute_async_script("navigator.serviceWorker.ready.then(() => arguments[0]())")
    time.sleep(1)
    assert not d.execute_script("return crossOriginIsolated"), "the first visit should not be isolated"
    play(d, "single", "first visit")
    d.get(url); time.sleep(1.5)
    assert d.execute_script("return crossOriginIsolated && typeof SharedArrayBuffer"), "the second visit is not isolated"
    play(d, "threads", "second visit")
    # firmware catalogue and pictures still load when isolated
    assert d.execute_script("return FIRMWARES.length") > 20
    d.get(url + "?threads=0"); time.sleep(1.5); play(d, "single", "?threads=0")
    d.get(url); d.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {"source": "delete window.SharedArrayBuffer"})
    d.get(url); time.sleep(1.5); play(d, "single", "no SharedArrayBuffer")
    print("threads: ok")
finally:
    d.quit()
