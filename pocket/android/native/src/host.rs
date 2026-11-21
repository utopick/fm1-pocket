//! The port of pocket/vendor/worklet.js: the emulator's host logic, with no JNI in it.
//! `Host::post` and `Host::boot` take the page's messages, `Host::render` is the audio
//! thread's `process`, and `Host::poll` encodes what the worklet would have posted back.
//! Every fm1-web function works on globals, so the whole `Host` lives behind one Mutex (lib.rs).

use crate::json::{self, Json};
use fm1_web as w;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::time::Instant;

pub const SAMPLE_RATE: f64 = 44100.0;
const AHEAD_FRAMES: f64 = 1024.0;
const QUANTUM: usize = 128; // frames per emulation step, as an AudioWorklet's
const LCD_PIXELS: usize = 240 * 240;

struct Blob { name: &'static str, ty: &'static str, bytes: Vec<u8> }
struct Msg { json: String, blobs: Vec<Blob> }

fn u16s(v: &[u16]) -> Vec<u8> { v.iter().flat_map(|x| x.to_le_bytes()).collect() }
fn u32s(v: &[u32]) -> Vec<u8> { v.iter().flat_map(|x| x.to_le_bytes()).collect() }
fn f32s(v: &[f32]) -> Vec<u8> { v.iter().flat_map(|x| x.to_le_bytes()).collect() }

/// How much a quantum may emulate (worklet.js `budgets`): 20 ms while booting, 1.5 quanta once audio plays.
fn budgets(mhz: f64, frames: usize) -> (f64, f64) { (mhz * 1e6 * 0.02, mhz * 1e6 * 1.5 * frames as f64 / SAMPLE_RATE) }

#[derive(Default, Clone, Copy)]
struct Timing { busy: f64, worst: f64, emulated: f64, idle: f64, starved: f64, quanta: f64, frames: f64 }

struct Snap { request: Option<f64>, pause: bool, started: f64 }

pub struct Host {
    t0: Instant,
    active: bool, // worklet's `this.x`
    queue: Vec<Msg>,
    snapshots: Vec<Snap>,
    seq: Option<f64>,
    mhz: f64,
    ahead: f64,
    budget: f64,
    playing: bool,
    paused: bool,
    board: u32,
    last_timing: Option<Timing>,
    lcd_revision: Option<u32>,
    face_revision: Option<u32>, // the native screen's own: it reads the LCD apart from the page's frames
    report_frames: usize,
    report_calls: usize,
    short: u32,
    busy: f64,
    worst: f64,
    timed_ms: f64,
    timed_idle: f64,
    timed_starved: f64,
    flash_revision: u32,
    observed_revision: u32,
    flash_changed_at: f64,
    last_snapshot: f64,
    peak: f32, // the largest absolute sample since the last frame
    load: f64, // emulation time over sound time, smoothed over about a second (1 = just real time)
}

impl Host {
    pub fn new() -> Host {
        Host { t0: Instant::now(), active: false, queue: vec![], snapshots: vec![], seq: None, mhz: 0.0, ahead: 0.0, budget: 0.0,
            playing: false, paused: false, board: 0, last_timing: None, lcd_revision: None, face_revision: None, report_frames: 0, report_calls: 0,
            short: 0, busy: 0.0, worst: 0.0, timed_ms: 0.0, timed_idle: 0.0, timed_starved: 0.0, flash_revision: 0,
            observed_revision: 0, flash_changed_at: 0.0, last_snapshot: 0.0, peak: 0.0, load: 0.0 }
    }

    fn now(&self) -> f64 { self.t0.elapsed().as_secs_f64() * 1000.0 }

    fn push(&mut self, json: String, blobs: Vec<Blob>) { self.queue.push(Msg { json, blobs }); }

    fn seq_field(&self) -> String { self.seq.map_or(String::new(), |s| format!(",\"seq\":{}", json::num(s))) }

    fn error(&mut self, seq: Option<f64>, fatal: bool, message: &str) {
        let s = seq.map_or(String::new(), |s| format!(",\"seq\":{}", json::num(s)));
        let f = if fatal { ",\"fatal\":true" } else { "" };
        self.push(format!("{{\"type\":\"error\"{s}{f},\"message\":{}}}", json::quote(message)), vec![]);
    }

    fn unavailable(&mut self, seq: Option<f64>, request: Option<f64>, error: Option<&str>) {
        let s = seq.map_or(String::new(), |s| format!(",\"seq\":{}", json::num(s)));
        let r = request.map_or(String::new(), |r| format!(",\"request\":{}", json::num(r)));
        let e = error.map_or(String::new(), |e| format!(",\"error\":{}", json::quote(e)));
        self.push(format!("{{\"type\":\"snapshot\"{s}{r},\"unavailable\":true{e}}}"), vec![]);
    }

    /// Every message the page sends except "boot" (as JSON).
    pub fn post(&mut self, text: &str) {
        let Some(m) = json::parse(text) else { return self.error(None, false, "a message could not be read") };
        let ty = m.str("type").unwrap_or("");
        let seq = m.num("seq");
        if ty == "cancel-boot" {
            self.active = false;
            self.snapshots.clear();
            self.queue.clear(); // power off: nothing stale reaches the next boot
        } else if ty == "snapshot" && !self.active {
            self.unavailable(seq, m.num("request"), None);
        } else if self.active {
            let n = |k: &str| m.num(k).unwrap_or(0.0);
            match ty {
                "snapshot" => {
                    if seq != self.seq { return; }
                    let started = self.now();
                    self.snapshots.push(Snap { request: m.num("request"), pause: m.truthy("pause"), started });
                    self.flush_snapshots();
                }
                "cancel-snapshot" => { let r = m.num("request"); self.snapshots.retain(|s| s.request != r); }
                "resume" => self.paused = false,
                "key" => w::fm1_key(n("id") as u32, m.truthy("down") as u32),
                "enc" => w::fm1_enc(n("enc") as u32, n("clicks") as i32),
                "pot" => w::fm1_pot(n("value") as u32),
                "midi" => if let Some(Json::Arr(a)) = m.get("bytes") {
                    for b in a { if let Json::Num(b) = b { w::fm1_midi(*b as u32); } }
                },
                "analog" => w::fm1_analog(n("idx") as u32, n("value") as u32),
                "vel" => w::fm1_velocity(n("us") as u32),
                _ => {}
            }
        }
    }

    /// The "boot" message: `meta` is its JSON without the binaries; empty slices mean none.
    pub fn boot(&mut self, meta: &str, package: &[u8], sectors: &[u8], syx: &[u8]) {
        let m = json::parse(meta).unwrap_or(Json::Null);
        let seq = m.num("seq");
        let mut replaced = false; // fm1_boot_fwsc swapped the machine: the old one is gone
        match self.try_boot(&m, package, sectors, syx, &mut replaced) {
            Ok(()) => {}
            Err(e) => {
                if replaced { self.active = false; }
                self.paused = false;
                self.error(seq, false, &format!("boot: {e}"));
            }
        }
    }

    fn try_boot(&mut self, m: &Json, package: &[u8], sectors: &[u8], syx: &[u8], replaced: &mut bool) -> Result<(), String> {
        let mhz = m.num("mhz").unwrap_or(240.0);
        // fm1_alloc gives a buffer the machine takes over; the bytes are copied in as the worklet does
        let copy = |b: &[u8]| { let p = w::fm1_alloc(b.len() as u32); unsafe { std::ptr::copy_nonoverlapping(b.as_ptr(), p, b.len()) }; p };
        // native: switches on the native JIT (the wasm JIT's per-quantum limit means nothing here)
        w::fm1_jit(!matches!(m.get("jit"), Some(Json::Bool(false))) as u32, 16);
        w::fm1_flash_part((m.str("chip") == Some("uc25hq80")) as u32);
        let ahead = m.num("ahead").unwrap_or(AHEAD_FRAMES);
        w::fm1_ahead(ahead as u32);
        if w::fm1_boot_fwsc(copy(package), package.len() as u32, std::ptr::null_mut(), 0, mhz as u32) != 0 {
            return Err("not an FM-1 update package (or a DX7 bank it cannot use)".into());
        }
        *replaced = true;
        if !sectors.is_empty() && w::fm1_flash_restore(copy(sectors), sectors.len() as u32) != 0 {
            return Err("invalid saved flash sectors".into());
        }
        if !syx.is_empty() && w::fm1_load_syx(copy(syx), syx.len() as u32) == 1 {
            return Err("this firmware cannot load that DX7 bank".into());
        }
        let now = self.now();
        self.active = true;
        self.mhz = mhz;
        self.ahead = ahead;
        self.budget = budgets(mhz, QUANTUM).0;
        self.playing = false;
        self.last_timing = None;
        self.lcd_revision = None;
        self.face_revision = None;
        self.report_frames = 0;
        self.report_calls = 0;
        self.short = 0;
        self.busy = 0.0;
        self.worst = 0.0;
        self.timed_ms = 0.0;
        self.timed_idle = 0.0;
        self.timed_starved = 0.0;
        self.board = w::fm1_board();
        self.seq = m.num("seq");
        self.paused = false;
        self.snapshots.clear();
        self.flash_revision = w::fm1_flash_revision();
        self.observed_revision = self.flash_revision;
        self.flash_changed_at = now;
        self.last_snapshot = now;
        let len = w::fm1_flash_len() as usize;
        let base = unsafe { std::slice::from_raw_parts(w::fm1_flash_base(), len) }.to_vec();
        let flash = unsafe { std::slice::from_raw_parts(w::fm1_flash(), len) }.to_vec();
        self.push(format!("{{\"type\":\"booted\"{},\"board\":{},\"revision\":{}}}", self.seq_field(), self.board, self.flash_revision),
            vec![Blob { name: "base", ty: "Uint8Array", bytes: base }, Blob { name: "flash", ty: "Uint8Array", bytes: flash }]);
        Ok(())
    }

    fn observe_flash(&mut self) -> u32 {
        let revision = w::fm1_flash_revision();
        if revision != self.observed_revision {
            self.observed_revision = revision;
            self.flash_changed_at = self.now();
            self.push(format!("{{\"type\":\"flash-changed\"{},\"revision\":{revision}}}", self.seq_field()), vec![]);
        }
        revision
    }

    fn flush_snapshots(&mut self) {
        if !self.active { return; }
        self.observe_flash();
        let quiet = self.now() - self.flash_changed_at >= 250.0 || w::fm1_halted() != 0;
        let busy = w::fm1_flash_busy() != 0;
        for req in std::mem::take(&mut self.snapshots) {
            if busy || !quiet {
                if req.request.is_some() && self.now() - req.started >= 1500.0 {
                    // a constantly writing firmware must not prevent switching away: keep its last stable save
                    if req.pause { self.paused = true; }
                    let err = (!req.pause).then_some("flash did not become quiet; try saving again");
                    self.unavailable(self.seq, req.request, err);
                } else { self.snapshots.push(req); }
                continue;
            }
            let flash = unsafe { std::slice::from_raw_parts(w::fm1_flash(), w::fm1_flash_len() as usize) }.to_vec();
            self.flash_revision = w::fm1_flash_revision();
            self.observed_revision = self.flash_revision;
            self.last_snapshot = self.now();
            if req.pause { self.paused = true; }
            let r = req.request.map_or(String::new(), |r| format!(",\"request\":{}", json::num(r)));
            self.push(format!("{{\"type\":\"snapshot\"{}{r},\"revision\":{}}}", self.seq_field(), self.flash_revision),
                vec![Blob { name: "flash", ty: "Uint8Array", bytes: flash }]);
        }
    }

    /// The audio thread: fills `out` (interleaved stereo) and returns the frames written (always all
    /// of them; silence where the machine is not running or has nothing yet).
    pub fn render(&mut self, out: &mut [f32]) -> usize {
        out.fill(0.0);
        let frames = out.len() / 2;
        if !self.active || self.paused { return frames; }
        for chunk in out.chunks_exact_mut(QUANTUM * 2) {
            if !self.process(chunk) || !self.active || self.paused { break; }
        }
        // a tail shorter than a quantum is left silent (the Java side asks for a multiple of 128)
        frames
    }

    /// worklet.js `process` for one quantum; false after a fatal error.
    fn process(&mut self, out: &mut [f32]) -> bool {
        let n = out.len() / 2;
        let playing = self.playing;
        let t0 = self.now();
        let budget = self.budget as u32;
        let have = match catch_unwind(AssertUnwindSafe(|| w::fm1_render(n as u32, budget))) {
            Ok(h) => h as usize,
            Err(e) => { // a trap in the emulator: stop and say so
                self.active = false;
                let (seq, reqs) = (self.seq, std::mem::take(&mut self.snapshots));
                for r in reqs { self.unavailable(seq, r.request, None); }
                let what = e.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| e.downcast_ref::<String>().cloned()).unwrap_or_default();
                self.error(seq, true, &format!("render: {what}"));
                return false;
            }
        };
        let (l, r) = unsafe { (std::slice::from_raw_parts(w::fm1_out_l(), n), std::slice::from_raw_parts(w::fm1_out_r(), n)) };
        for i in 0..n { out[2 * i] = l[i]; out[2 * i + 1] = r[i]; self.peak = self.peak.max(l[i].abs()).max(r[i].abs()); }
        if have > 0 && !self.playing {
            self.playing = true;
            if self.ahead > 0.0 { self.budget = budgets(self.mhz, n).1; }
        }
        if have < n { self.short += 1; }
        self.report_frames += n;
        self.report_calls += 1;
        if self.report_frames as f64 >= SAMPLE_RATE / 30.0 {
            self.report(n, playing, t0);
        } else {
            let took = self.now() - t0;
            self.busy += took;
            if playing { self.worst = self.worst.max(took); }
        }
        true
    }

    fn report(&mut self, n: usize, playing: bool, t0: f64) {
        let flash_revision = self.observe_flash();
        if flash_revision != self.flash_revision && self.now() - self.last_snapshot >= 1000.0
            && self.now() - self.flash_changed_at >= 250.0 && self.snapshots.is_empty() {
            self.snapshots.push(Snap { request: None, pause: false, started: 0.0 });
        }
        self.flush_snapshots();
        let revision = w::fm1_lcd_revision();
        // the frame this one replaces may have carried a new LCD the page never fetched: send it again
        let dropped_lcd = self.queue.iter().any(|m| m.json.starts_with("{\"type\":\"frame\"") && m.blobs.iter().any(|b| b.name == "lcd"));
        let lcd = (Some(revision) != self.lcd_revision || dropped_lcd)
            .then(|| u16s(unsafe { std::slice::from_raw_parts(w::fm1_lcd(), LCD_PIXELS) }));
        self.lcd_revision = Some(revision);
        let leds = f32s(unsafe { std::slice::from_raw_parts(w::fm1_leds(), 41) });
        let pads = (self.board != 0).then(|| u32s(unsafe { std::slice::from_raw_parts(w::fm1_pads(), 16) }));
        let (ms, idle, starved) = (w::fm1_ms() as f64, w::fm1_idle_ms() as f64, w::fm1_starved() as f64);
        let t = self.last_timing.unwrap_or(Timing { frames: n as f64, ..Timing::default() });
        let mut blobs = vec![];
        if let Some(b) = lcd { blobs.push(Blob { name: "lcd", ty: "Uint16Array", bytes: b }); }
        blobs.push(Blob { name: "leds", ty: "Float32Array", bytes: leds });
        if let Some(b) = pads { blobs.push(Blob { name: "pads", ty: "Uint32Array", bytes: b }); }
        let peak = std::mem::take(&mut self.peak);
        let has = |k: &str| blobs.iter().any(|b| b.name == k);
        let nul = |k: &str| if has(k) { String::new() } else { format!(",\"{k}\":null") };
        let jit = "{\"regions\":0,\"failed\":0,\"error\":\"\",\"bytes\":0,\"tableSlots\":0,\"compileMs\":0,\"compileMaxMs\":0}";
        let text = format!(
            "{{\"type\":\"frame\"{}{}{},\"ms\":{},\"short\":{},\"halted\":{},\"jit\":{jit},\"playing\":{},\"peak\":{},\
             \"busy\":{},\"worst\":{},\"emulated\":{},\"idle\":{},\"starved\":{},\"quanta\":{},\"frames\":{}}}",
            self.seq_field(), nul("lcd"), nul("pads"), json::num(ms), self.short, w::fm1_halted(), self.playing,
            json::num(peak as f64), json::num(t.busy), json::num(t.worst), json::num(t.emulated), json::num(t.idle),
            json::num(t.starved), json::num(t.quanta), json::num(t.frames));
        // only the latest frame stays queued
        self.queue.retain(|m| !m.json.starts_with("{\"type\":\"frame\""));
        self.push(text, blobs);
        let took = self.now() - t0;
        let sound_ms = self.report_frames as f64 * 1000.0 / SAMPLE_RATE;
        if playing && sound_ms > 0.0 { self.load += ((self.busy + took) / sound_ms - self.load) * 0.1; }
        self.last_timing = Some(Timing { busy: self.busy + took, worst: if playing { self.worst.max(took) } else { self.worst },
            emulated: ms - self.timed_ms, idle: idle - self.timed_idle, starved: starved - self.timed_starved,
            quanta: self.report_calls as f64, frames: self.report_frames as f64 / self.report_calls as f64 });
        self.timed_ms = ms;
        self.timed_idle = idle;
        self.timed_starved = starved;
        self.busy = 0.0;
        self.worst = 0.0;
        self.report_frames = 0;
        self.report_calls = 0;
    }

    /// The native screen (FaceView): the 41 LED levels always, the LCD only when it changed since
    /// its last call. -1 while no firmware runs, else 1 when `lcd` was filled, 0 when not.
    pub fn face(&mut self, lcd: &mut [u16], leds: &mut [f32]) -> i32 {
        if !self.active { return -1; }
        leds.copy_from_slice(unsafe { std::slice::from_raw_parts(w::fm1_leds(), 41) });
        let revision = w::fm1_lcd_revision();
        if Some(revision) == self.face_revision { return 0; }
        self.face_revision = Some(revision);
        lcd.copy_from_slice(unsafe { std::slice::from_raw_parts(w::fm1_lcd(), LCD_PIXELS) });
        1
    }

    /// For the native screen: the load in percent, -1 while nothing plays.
    pub fn load(&self) -> i32 { if self.active && self.playing { (self.load * 100.0).round() as i32 } else { -1 } }

    /// The `/native/poll` response body: see the bridge in the spec (little-endian).
    pub fn poll(&mut self) -> Vec<u8> {
        let mut o = Vec::new();
        let u = |o: &mut Vec<u8>, v: usize| o.extend_from_slice(&(v as u32).to_le_bytes());
        u(&mut o, self.queue.len());
        for m in self.queue.drain(..) {
            u(&mut o, m.json.len());
            o.extend_from_slice(m.json.as_bytes());
            u(&mut o, m.blobs.len());
            for b in &m.blobs {
                u(&mut o, b.name.len());
                o.extend_from_slice(b.name.as_bytes());
                u(&mut o, b.ty.len());
                o.extend_from_slice(b.ty.as_bytes());
                u(&mut o, b.bytes.len());
                o.extend_from_slice(&b.bytes);
            }
        }
        o
    }
}
