// The emulator in the audio thread: each 128-frame quantum runs the machine until its I2S
// DMA has produced 128 frames, so the audio device paces the emulation; and also, for an even
// amount of work per quantum, its share of emulated time while the queue holds less than one
// DMA half buffer beyond them (fm1_ahead: half the firmwares hand out 256 or 512 frames at
// once). The page gets the LCD and the LEDs about 30 times a second; keys, knobs and the pot
// come back as messages.
// The WebAssembly JIT's host side, as web/jit.js (a copy: an AudioWorklet does not import
// modules everywhere): compile a hot block's module, install its `run` in the function table.
function jitImports(exports, stats) {
  let next;
  return {
    fm1_jit_compile(ptr, len, hRead, hWrite, hOp) {
      const start = now();
      try {
        const x = exports();
        const bytes = new Uint8Array(x.memory.buffer, ptr, len).slice();
        const table = x.__indirect_function_table;
        // the helpers as function imports, from the table (a module importing the table itself
        // gets a copy of it, grown and updated with every region: 40% of a two-core firmware's
        // time); the table grows by a chunk, the emulator's own instance being its only user
        const env = { memory: x.memory, h_read: table.get(hRead), h_write: table.get(hWrite), h_op: table.get(hOp) };
        const run = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env }).exports.run;
        if (next === undefined || next >= table.length) { next = table.length; table.grow(256); }
        const slot = next++;
        table.set(slot, run);
        stats.regions++;
        stats.bytes += len;
        stats.tableSlots = table.length;
        return slot;
      } catch (e) {
        stats.failed++;
        // with what it was called: a report then tells a stale module (helpers undefined, #142)
        // from a table that is too short
        let size = "?";
        try { size = exports().__indirect_function_table.length; } catch {}
        stats.error = `${e} (helpers ${hRead}, ${hWrite}, ${hOp}; table ${size})`;
        return 0;
      } finally {
        const elapsed = now() - start;
        stats.compileMs += elapsed;
        stats.compileMaxMs = Math.max(stats.compileMaxMs, elapsed);
      }
    },
  };
}

// How much a quantum may emulate, in the emulator's run budget (cpu0's instructions, at most
// one per cycle): while the firmware boots, 20 ms of emulated time, so a boot is quick (there is
// no audio to keep yet); once audio plays, 1.5 quanta, so a firmware that stalls or falls silent
// does not hold the audio thread for 20 ms each quantum. The pace (fm1_ahead) needs one quantum
// when it may run a whole DMA half buffer ahead; fm1_render raises the cap by the rest of the half
// buffer when ahead is less (?ahead=256 with 512-frame halves). Without the pace (?ahead=0) a
// quantum may have to run a whole half buffer's time, so it keeps 20 ms.
const AHEAD_FRAMES = 1024;
// Chrome on Android, after a late quantum, calls process() faster than real time to refill its buffer and drops what
// it gets; an emulator that followed it would race (its screen too) and need more time than it has, so it falls
// further behind. So it runs at most WALL_SLACK frames ahead of the wall clock (silence past that), and time lost in a
// stall of more than WALL_DEBT frames is forgotten instead of caught up (?wallpace=0: off).
const WALL_SLACK = 2048, WALL_DEBT = 4410;
function budgets(mhz, frames) {
  return { boot: mhz * 1e6 * 0.02, play: mhz * 1e6 * 1.5 * frames / sampleRate };
}

// the wall clock, for how long each quantum's emulation takes (where an AudioWorklet has no
// performance.now(), Date.now(): whole milliseconds, which still average out over a second)
const now = globalThis.performance?.now ? () => performance.now() : () => Date.now();

class Fm1 extends AudioWorkletProcessor {
  constructor() {
    super();
    this.x = null;
    this.calls = 0;
    this.bootToken = 0;
    this.snapshots = [];
    this.port.onmessageerror = () => this.port.postMessage({ type: "error", message: "a message could not be read" });
    this.port.onmessage = async (e) => {
      const m = e.data;
      if (m.type === "boot") {
        const token = ++this.bootToken;
        // Keep the previous (paused) instance until the replacement boots successfully.
        try {
          await this.boot(m, token);
        } catch (err) {
          if (token !== this.bootToken) return;
          this.paused = false;
          this.port.postMessage({ type: "error", seq: m.seq, message: `boot: ${err}` });
        }
      } else if (m.type === "cancel-boot") {
        ++this.bootToken;
        this.x = null;
        this.snapshots = [];
      } else if (m.type === "snapshot" && !this.x) {
        this.port.postMessage({ type: "snapshot", seq: m.seq, request: m.request, unavailable: true });
      } else if (this.x) {
        if (m.type === "snapshot") {
          if (m.seq !== this.seq) return;
          this.snapshots.push({ ...m, started: now() });
          this.flushSnapshots();
        } else if (m.type === "cancel-snapshot") this.snapshots = this.snapshots.filter(r => r.request !== m.request);
        else if (m.type === "resume") this.paused = false;
        else if (m.type === "core1-up") this.waitCore1 = false;
        else if (m.type === "key") this.x.fm1_key(m.id, m.down ? 1 : 0);
        else if (m.type === "enc") this.x.fm1_enc(m.enc, m.clicks);
        else if (m.type === "pot") this.x.fm1_pot(m.value);
        else if (m.type === "midi") for (const b of m.bytes) this.x.fm1_midi(b);
        else if (m.type === "analog") this.x.fm1_analog(m.idx, m.value);   // SMK-37: pads, faders, wheels
        else if (m.type === "vel") this.x.fm1_velocity(m.us);             // SMK-37: the next keys' velocity
      }
    };
  }

  async boot(m, token) {
    // the module arrives as bytes: a compiled WebAssembly.Module does not cross into the
    // AudioWorklet's scope (Chrome delivers it as a messageerror). Compiled once, here: on a
    // phone compiling it again on every firmware change takes a noticeable while
    let x, threaded = false;
    this.jit = { regions: 0, failed: 0, error: "", bytes: 0, tableSlots: 0, compileMs: 0, compileMaxMs: 0 };
    if (m.mt) {
      // the threaded build, on a shared memory the page made: core 1 runs in a Worker on the same memory (core1-worker.js).
      // Any failure here falls back to the one-thread module below.
      try {
        this.mtModule ??= await WebAssembly.compile(m.mt.wasm);
        const memory = m.mt.memory;
        x = { ...(await WebAssembly.instantiate(this.mtModule, { env: { memory, ...jitImports(() => x, this.jit),
          fm1_now_us: () => Date.now() * 1000,   // (this scope has no performance.now)
          fm1_core1_spawn: (ptr) => this.port.postMessage({ type: "core1", seq: m.seq, ptr, ...this.core1 }) } })).exports, memory };
        // this thread's thread-local block, and the Worker's with its own stack (a stack pointer is per instance)
        const block = () => { const n = x.__tls_size.value + x.__tls_align.value, p = x.fm1_alloc(n); return (p + x.__tls_align.value - 1) & -x.__tls_align.value; };
        x.__wasm_init_tls(block());
        const STACK = 1 << 20;
        this.core1 = { sp: x.fm1_alloc(STACK) + STACK, tls: block() };
        threaded = x.fm1_threads(2) === 2;   // core 1 on the Worker the page starts, once the firmware releases it
        if (!threaded) throw new Error("this build has no two-thread mode");
      } catch (err) {
        x = null;
        this.port.postMessage({ type: "note", seq: m.seq, message: `threaded core unavailable: ${err}` });
      }
    }
    if (!x) {
      if (!this.module) this.module = await WebAssembly.compile(m.wasm);
      x = (await WebAssembly.instantiate(this.module, { env: jitImports(() => x, this.jit) })).exports;
    }
    if (token !== this.bootToken) return;
    // hot code compiled to WebAssembly, a few blocks per quantum at most (?jit=0: interpreter only)
    x.fm1_jit(m.jit === false ? 0 : 1, 16);
    x.fm1_usb?.(m.usb ? 1 : 0);          // a USB cable to a host, for a firmware that stalls without one (the page's USB_CABLE)
    x.fm1_flash_part?.(m.chip === "uc25hq80" ? 1 : 0);   // ?chip=uc25hq80: the newer units' flash part
    const ahead = x.fm1_ahead ? m.ahead ?? AHEAD_FRAMES : 0;
    x.fm1_ahead?.(ahead);               // (?ahead=0: each quantum runs for its own frames only)
    // the whole update package (.fwsc): the machine unpacks it, gets the flash chip and the
    // boot parameters from it (what M-VAVE's own firmware needs; the others boot the same)
    const copy = (buf) => {
      const p = x.fm1_alloc(buf.byteLength);
      new Uint8Array(x.memory.buffer, p, buf.byteLength).set(new Uint8Array(buf));
      return p;
    };
    const pkg = copy(m.package);
    if (x.fm1_boot_fwsc(pkg, m.package.byteLength, 0, 0, m.mhz) !== 0) {
      throw new Error("not an FM-1 update package (or a DX7 bank it cannot use)");
    }
    if (m.sectors?.byteLength && x.fm1_flash_restore(copy(m.sectors), m.sectors.byteLength) !== 0) {
      throw new Error("invalid saved flash sectors");
    }
    if (m.syx && x.fm1_load_syx(copy(m.syx), m.syx.byteLength) === 1) {
      throw new Error("this firmware cannot load that DX7 bank");
    }
    // a try-out's input script (web/tryout.js): UTF-8 bytes, played on the emulated clock from now
    if (m.script?.byteLength && (!x.fm1_bench_script || x.fm1_bench_script(copy(m.script), m.script.byteLength) !== 0)) {
      throw new Error("the input script did not load");
    }
    this.waitCore1 = threaded;          // no emulating until the page says core 1's Worker is up
    this.x = x;                         // (a reboot replaces the whole instance)
    this.mhz = m.mhz;
    this.ahead = ahead;
    this.budget = budgets(m.mhz, 128).boot;
    this.playing = false;               // the firmware's audio has started (the budget is capped)
    this.lastTiming = null;
    this.views = null;
    this.lcdRevision = null;
    this.reportFrames = 0;
    this.reportCalls = 0;
    this.short = 0;
    this.wallPace = m.wallPace !== false;
    this.wall0 = undefined;             // the wall clock (ms) at which `ran` frames would be due
    this.ran = 0;
    this.held = 0;                      // quanta held back (silence) because the emulator was ahead of the wall clock
    this.calls = 0;
    this.busy = 0;                      // ms spent emulating since the last frame message
    this.worst = 0;                     // the longest quantum among them (once audio plays)
    this.timedMs = 0;                   // the emulated ms when the timed interval began
    this.timedIdle = 0;                 // and the idle ms skipped by then
    this.timedStarved = 0;              // and the audio blocks the firmware left unfilled by then
    this.board = x.fm1_board();         // 0 the FM-1, 1 the SMK-37 (the package says which)
    this.seq = m.seq;
    this.paused = false;
    this.snapshots = [];
    this.flashRevision = x.fm1_flash_revision();
    this.observedRevision = this.flashRevision;
    this.flashChangedAt = this.lastSnapshot = now();
    const base = new Uint8Array(x.memory.buffer, x.fm1_flash_base(), x.fm1_flash_len()).slice();
    const flash = new Uint8Array(x.memory.buffer, x.fm1_flash(), x.fm1_flash_len()).slice();
    this.port.postMessage({ type: "booted", seq: m.seq, threaded, board: this.board, revision: this.flashRevision, base, flash }, [base.buffer, flash.buffer]);
  }

  observeFlash() {
    const revision = this.x.fm1_flash_revision();
    if (revision !== this.observedRevision) {
      this.observedRevision = revision;
      this.flashChangedAt = now();
      this.port.postMessage({ type: "flash-changed", seq: this.seq, revision });
    }
    return revision;
  }

  flushSnapshots() {
    const x = this.x;
    if (!x) return;
    this.observeFlash();
    const quiet = now() - this.flashChangedAt >= 250 || x.fm1_halted();
    const busy = x.fm1_flash_busy();
    for (const request of this.snapshots.splice(0)) {
      if (busy || !quiet) {
        if (request.request !== undefined && now() - request.started >= 1500) {
          // A constantly writing firmware must not prevent switching away. Keep its
          // last stable save instead of persisting a possibly half-written sector.
          if (request.pause) this.paused = true;
          this.port.postMessage({ type: "snapshot", seq: this.seq, request: request.request,
            unavailable: true, error: request.pause ? null : "flash did not become quiet; try saving again" });
        } else this.snapshots.push(request);
        continue;
      }
      const flash = new Uint8Array(x.memory.buffer, x.fm1_flash(), x.fm1_flash_len()).slice();
      this.flashRevision = x.fm1_flash_revision();
      this.observedRevision = this.flashRevision;
      this.lastSnapshot = now();
      if (request.pause) this.paused = true;
      this.port.postMessage({ type: "snapshot", seq: this.seq, request: request.request,
        revision: this.flashRevision, flash }, [flash.buffer]);
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const x = this.x;
    if (!x || this.paused || this.waitCore1) return true;
    const n = out[0].length;
    if (this.wallPace) {
      const wall = Date.now();
      if (this.wall0 === undefined) this.wall0 = wall;
      const due = (wall - this.wall0) * sampleRate / 1000;
      if (this.ran > due + WALL_SLACK) {
        this.held++;
        return true;                    // (the outputs stay silent)
      }
      if (due - this.ran > WALL_DEBT) this.wall0 = wall - this.ran * 1000 / sampleRate;
      this.ran += n;
    }
    const playing = this.playing;       // (the worst quantum: of those once audio played)
    const t0 = now();
    let have;
    try {
      have = x.fm1_render(n, this.budget);
    } catch (err) {                       // a trap in the emulator: stop and say so
      this.x = null;
      for (const request of this.snapshots.splice(0)) {
        this.port.postMessage({ type: "snapshot", seq: this.seq, request: request.request, unavailable: true });
      }
      this.port.postMessage({ type: "error", seq: this.seq, fatal: true, message: `render: ${err}` });
      return true;
    }
    const buffer = x.memory.buffer, lp = x.fm1_out_l(), rp = x.fm1_out_r();
    if (!this.views || this.views.l.buffer !== buffer || this.views.l.length !== n ||
        this.views.l.byteOffset !== lp || this.views.r.byteOffset !== rp) {
      this.views = { l: new Float32Array(buffer, lp, n), r: new Float32Array(buffer, rp, n) };
    }
    const { l, r } = this.views;
    out[0].set(l);
    if (out[1]) out[1].set(r);
    if (have > 0 && !this.playing) {
      this.playing = true;
      if (this.ahead > 0) this.budget = budgets(this.mhz, n).play;
    }
    this.short = (this.short || 0) + (have < n ? 1 : 0);
    this.reportFrames += n;
    this.reportCalls++;
    if (this.reportFrames >= sampleRate / 30) {
      const flashRevision = this.observeFlash();
      if (flashRevision !== this.flashRevision && now() - this.lastSnapshot >= 1000 &&
          now() - this.flashChangedAt >= 250 && !this.snapshots.length) {
        this.snapshots.push({});
      }
      this.flushSnapshots();
      const revision = x.fm1_lcd_revision();
      const lcd = revision !== this.lcdRevision ? new Uint16Array(x.memory.buffer, x.fm1_lcd(), 240 * 240).slice() : null;
      this.lcdRevision = revision;
      const leds = new Float32Array(x.memory.buffer, x.fm1_leds(), 41).slice();
      const pads = this.board ? new Uint32Array(x.memory.buffer, x.fm1_pads(), 16).slice() : null;
      const transfer = [leds.buffer];
      if (lcd) transfer.push(lcd.buffer);
      if (pads) transfer.push(pads.buffer);
      // Report the preceding interval: its final postMessage is included in its timing.
      const ms = x.fm1_ms(), idle = x.fm1_idle_ms?.() ?? 0, starved = x.fm1_starved?.() ?? 0;
      this.port.postMessage({ type: "frame", seq: this.seq, lcd, leds, ms,
        short: this.short, held: this.held, halted: x.fm1_halted(), jit: this.jit, pads, playing: this.playing,
        busy: this.lastTiming?.busy ?? 0, worst: this.lastTiming?.worst ?? 0,
        emulated: this.lastTiming?.emulated ?? 0, idle: this.lastTiming?.idle ?? 0, starved: this.lastTiming?.starved ?? 0,
        core1: Number(x.fm1_mt_stats?.(3) ?? -1), started: x.fm1_core1_thread?.() ?? 1, quanta: this.lastTiming?.quanta ?? 0, frames: this.lastTiming?.frames ?? n }, transfer);
      const took = now() - t0;
      // busy: ms of wall clock the interval's quanta took; emulated: ms of emulated time they ran,
      // idle: of which idle skipping jumped over (cost nothing); starved: audio blocks the firmware
      // left unfilled (fm1_starved)
      this.lastTiming = { busy: this.busy + took, worst: playing ? Math.max(this.worst, took) : this.worst,
        emulated: ms - this.timedMs, idle: idle - this.timedIdle, starved: starved - this.timedStarved,
        quanta: this.reportCalls, frames: this.reportFrames / this.reportCalls };
      this.timedMs = ms;
      this.timedIdle = idle;
      this.timedStarved = starved;
      this.busy = 0;
      this.worst = 0;
      this.reportFrames = 0;
      this.reportCalls = 0;
    } else {
      const took = now() - t0;
      this.busy += took;
      if (playing) this.worst = Math.max(this.worst, took);
    }
    return true;
  }
}
registerProcessor("fm1", Fm1);

// The reader of the page's ?worker=1 trial (emu-worker.js): the emulator runs in a Worker and sends its sound here in blocks of
// 128 frames. This only copies them out. It starts once the lead is nearly there, and after running dry it waits for the lead
// again, so one slow stretch is one gap. Every call tells the Worker how many frames were played, which is the Worker's clock.
class Fm1Reader extends AudioWorkletProcessor {
  constructor(o) {
    super();
    Object.assign(this, { q: [], lead: o.processorOptions.lead, played: 0, dry: 0, on: false });
    this.port.onmessage = ({ data: src }) => {   // the Worker's port, handed on by the page
      this.src = src;
      src.onmessage = (e) => this.q.push(e.data);
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    if (!this.src) return true;
    // shortcut: whole blocks of 128, the size of every browser's render quantum today; split them if that ever changes
    if (!this.on && this.q.length * 128 >= this.lead - 256) this.on = true;
    if (this.on && !this.q.length) (this.on = false), this.dry++;
    if (this.on) {
      const b = this.q.shift();
      out[0].set(b.l);
      if (out[1]) out[1].set(b.r);
      this.played += 128;
    }
    this.src.postMessage({ played: this.played, dry: this.dry });
    return true;
  }
}
registerProcessor("fm1-reader", Fm1Reader);

// A fast build, an .rfm1: the firmware's own code compiled to WebAssembly for a computer (vendor/rfm1.js, which build.py puts
// before this file). There is no chip to emulate, so it runs at full speed. It takes the same messages as Fm1 and sends the
// same ones back: each quantum pulls 128 frames, and the device's clock (one millisecond at a time) runs as far as they need.
// Saves are the whole flash image, sent when the firmware's dirty counter moves (at most once a second) and when asked.
// An AudioWorkletGlobalScope may have no TextDecoder, and rfm1.js's fallback decodes a whole text in one call, which overflows the
// stack on a long licence (the M-VAVE SDK builds': dx747, vesper). This one decodes UTF-8 in pieces.
if (typeof TextDecoder === "undefined") globalThis.TextDecoder = class {
  decode(b) {
    let s = "";
    for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192));
    try { return decodeURIComponent(escape(s)); } catch { return s; }
  }
};
const R_LABEL = [12, 13, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]; // the page's button ids (OCT- OCT+ FX ... REC) to rfm1's labels (FX ... REC OCT- OCT+)
const R_ROLE = [0, 1, 3, 4, 5, 6, 2]; // the page's encoders (the matrix's: SELECT ALGORITHM KNOB1-4 PRESETS) to rfm1's roles (SELECT ALGORITHM PRESETS KNOB1-4)
class Rfm1Proc extends AudioWorkletProcessor {
  constructor() {
    super();
    Object.assign(this, { core: null, token: 0, st: 0, data: [] });
    this.port.onmessage = (e) => this.message(e.data);
  }

  async message(m) {
    const core = this.core;
    if (m.type === "boot") {
      const token = ++this.token;
      this.core = null;
      try {
        const c = await Rfm1.Core.create(Rfm1.parse(new Uint8Array(m.rfm1)));
        if (token !== this.token) return;
        c.boot(m.flash ? new Uint8Array(m.flash) : null);
        c.onhalt = (code, err) => this.port.postMessage({ type: "error", seq: this.seq, fatal: true, message: "the firmware stopped (" + (err && err.message ? err.message : "exit " + (code & 0xff)) + ")" });
        Object.assign(this, { core: c, seq: m.seq, paused: false, lcdW: -1, saved: c.flashDirty(), savedAt: now(), busy: 0, worst: 0, quanta: 0, frames: 0, ms0: 0 });
        this.port.postMessage({ type: "booted", seq: m.seq, rfm1: c.info, board: 0, threaded: false, base: null, flash: null });
      } catch (err) {
        if (token === this.token) this.port.postMessage({ type: "error", seq: m.seq, rfm1: true, message: "boot: " + (err && err.message ? err.message : err) });
      }
    } else if (m.type === "cancel-boot") (++this.token, (this.core = null));
    else if (m.type === "snapshot") {
      if (!core || m.seq !== this.seq) return this.port.postMessage({ type: "snapshot", seq: m.seq, request: m.request, unavailable: true });
      this.save(m.request);
      if (m.pause) this.paused = true;
    } else if (!core) return;
    else if (m.type === "resume") this.paused = false;
    else if (m.type === "key") m.id < 14 ? core.button(R_LABEL[m.id], m.down) : core.key(m.id - 14, m.down, 100);
    else if (m.type === "enc") core.turn(R_ROLE[m.enc], m.clicks);
    else if (m.type === "pot") core.master(m.value);
    else if (m.type === "midi") {
      // bytes into whole messages (running status kept; system and SysEx messages dropped: rfm1_midi_in takes channel messages here)
      for (const b of m.bytes) {
        if (b >= 0xf8) continue;
        if (b & 0x80) ((this.st = b < 0xf0 ? b : 0), (this.data = []));
        else if (this.st && this.data.push(b) === ((this.st & 0xe0) === 0xc0 ? 1 : 2)) (core.midi(this.st, this.data[0], this.data[1] || 0), (this.data = []));
      }
    }
  }

  save(request) {
    const flash = this.core.flashImage(true);
    this.saved = this.core.flashDirty();
    this.savedAt = now();
    if (flash) this.port.postMessage({ type: "snapshot", seq: this.seq, request, flash }, [flash.buffer]);
    else this.port.postMessage({ type: "snapshot", seq: this.seq, request, unavailable: true });
  }

  process(_inputs, outputs) {
    const core = this.core, out = outputs[0];
    if (!core || this.paused || core.halted) return true;
    const n = out[0].length, t0 = now();
    if (!this.buf || this.buf.length !== 2 * n) this.buf = new Float32Array(2 * n);
    const b = core.pull(n, this.buf);
    for (let i = 0; i < n; i++) (out[0][i] = b[2 * i]), out[1] && (out[1][i] = b[2 * i + 1]);
    const took = now() - t0;
    this.busy += took;
    this.worst = Math.max(this.worst, took);
    this.quanta++;
    this.frames += n;
    if (this.frames >= sampleRate / 30) this.report();
    return true;
  }

  report() {
    const core = this.core, w = core.lcdWrites();
    let lcd = null;
    if (w !== this.lcdW) { // RGB565, high byte first, into the page's 16-bit pixels
      this.lcdW = w;
      const s = core.lcdBytes();
      lcd = new Uint16Array(57600);
      for (let i = 0; i < 57600; i++) lcd[i] = (s[2 * i] << 8) | s[2 * i + 1];
    }
    // the lights: rfm1 gives 0..255; the page reads 0.08 as fully lit (the emulator's LEDs are driven about 1 tick in 11)
    const l = core.leds(), leds = new Float32Array(41);
    l.buttons.forEach((v, label) => (leds[label < 12 ? label + 2 : label - 12] = (v / 255) * 0.08));
    l.keys.forEach((v, k) => (leds[14 + k] = (v / 255) * 0.08));
    leds[12] = Math.max(leds[12], (l.playGreen / 255) * 0.08);
    if (core.flashDirty() !== this.saved && now() - this.savedAt >= 1000) this.save(undefined);
    const transfer = [leds.buffer];
    if (lcd) transfer.push(lcd.buffer);
    this.port.postMessage({ type: "frame", seq: this.seq, lcd, leds, ms: core.ms, short: 0, held: 0, halted: core.halted, pads: null, playing: true,
      jit: { regions: 0, failed: 0, error: "", bytes: 0, tableSlots: 0, compileMs: 0, compileMaxMs: 0 },
      busy: this.busy, worst: this.worst, emulated: core.ms - this.ms0, idle: 0, starved: 0, core1: -1, started: 1, quanta: this.quanta, frames: this.frames / this.quanta, rfm1: true }, transfer);
    Object.assign(this, { busy: 0, worst: 0, quanta: 0, frames: 0, ms0: core.ms });
  }
}
registerProcessor("rfm1", Rfm1Proc);
