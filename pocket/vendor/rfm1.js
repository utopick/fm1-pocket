// vendor/rfm1.js: src/rfm1.js of Jake Handy's FM-1 Browser Simulator (https://github.com/jakehandy/fm1-browser-simulator, commit 47d66a8a533c),
// MIT licence (vendor/LICENSE-fm1-browser-simulator), unchanged. It runs .rfm1 firmwares; worklet.js's Rfm1Proc drives it.
/* rfm1.js: a host for .rfm1 firmware files, with no DOM in it (the page and the tests share it).
 *
 * An .rfm1 is an FM-1 firmware built for a host app instead of the device: a WebAssembly module behind
 * the fm1core ABI (version 6), with its manifest in a custom section. The format is RemoteFM1IOS's
 * docs/RFM1-FORMAT.md; this file is written from that description. See docs/FIRMWARE-INTERFACE.md for
 * how this simulator drives a module and for the optional "sim1" extension.
 *
 *   const fw = Rfm1.parse(bytes);            // manifest, credits, licences, skin; throws if not an .rfm1
 *   const core = await Rfm1.Core.create(fw); // instantiated, checked, not yet powered on
 *   core.boot(savedFlashOrNull);
 *   core.runMs(n);  core.pull(frames) -> Float32Array stereo   // the device clock and its sound
 *   core.lcdBytes() / core.leds() / core.key() / core.button() / core.turn() / core.master()
 */
(function (root) {
  "use strict";

  var FS = 44100, BLOCK = 128, NKEY = 27, NB = 14, NE = 7, NCOL = 11, NLINE = 4, W = 240, H = 240;
  var ABI = 6, ABI_MIN = 5, FLASH_STAGED = "fm1core:staged";
  var LABELS = ["FX", "SEL", "ENV", "LFO", "EDIT", "GLO", "HOME", "SAVE", "ARP", "SEQ", "PLAY", "REC", "OCT-", "OCT+"];
  var ROLES = ["SELECT", "ALGORITHM", "PRESETS", "KNOB 1", "KNOB 2", "KNOB 3", "KNOB 4"];
  var REQUIRED = ["memory", "rfm1_version", "rfm1_get", "rfm1_layout", "rfm1_alloc", "rfm1_options", "rfm1_init",
    "rfm1_tick", "rfm1_frame", "rfm1_idle", "rfm1_audio", "rfm1_flash_stage", "rfm1_flash", "rfm1_flash_dirty"];

  /* the offsets a wasm32 build of fm1core.h gives (rfm1_layout indexes 0..33); checked, not assumed */
  var LAYOUT = [115384, 0, 4, 8, 12, 16, 44, 48, 75, 102, 146, 148, 115348, 115352, 115366, 115373, 115380,
    192, 0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 92, 96, 100, 104, 108, 188];
  var P = { keys: 1, buttons: 2, keys_tap: 3, buttons_tap: 4, enc: 5, master: 6, key_vel: 7, key_lean: 8, led: 9,
    led_play_green: 10, lcd: 11, lcd_writes: 12, btn_id: 13, enc_id: 14, enc_dir: 15, ready: 16 };
  var C = { abi_version: 18, id: 19, name: 20, version: 21, source_url: 22, family: 23, license: 24, gated: 25,
    flash_size: 26, button_names: 27, params: 28, nparams: 29, panel: 30, keymap: 31, options: 32, credits: 33 };

  function utf8(bytes) {
    if (typeof TextDecoder !== "undefined") return new TextDecoder("utf-8").decode(bytes);
    return decodeURIComponent(escape(String.fromCharCode.apply(null, bytes)));
  }

  /* ---- the file: wasm sections, the manifest and the other custom sections ---- */
  function leb(b, i) {
    var v = 0, s = 0, c;
    do { c = b[i++]; v += (c & 0x7f) * Math.pow(2, s); s += 7; } while (c & 0x80);
    return [v, i];
  }
  function sections(b) {
    if (b.length < 8 || b[0] !== 0 || b[1] !== 0x61 || b[2] !== 0x73 || b[3] !== 0x6d || b[4] !== 1)
      throw new Error("This is not a WebAssembly module, so it is not an .rfm1 file.");
    var i = 8, out = { custom: {}, memory: null }, r, id, size, end, n, k, f;
    while (i < b.length) {
      id = b[i++];
      r = leb(b, i); size = r[0]; i = r[1]; end = i + size;
      if (id === 0) {
        r = leb(b, i); n = r[0]; k = r[1];
        out.custom[utf8(b.subarray(k, k + n))] = b.subarray(k + n, end);
      } else if (id === 5) {
        r = leb(b, i); k = r[1];
        f = b[k++];
        r = leb(b, k); out.memory = { min: r[0] }; k = r[1];
        if (f & 1) out.memory.max = leb(b, k)[0];
      }
      i = end;
    }
    return out;
  }
  function parse(bytes) {
    var b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), s = sections(b), m, j, licenses = [], skin = null;
    if (!s.custom.rfm1) throw new Error("This WebAssembly module has no rfm1 manifest, so it is not an .rfm1 file.");
    try { m = JSON.parse(utf8(s.custom.rfm1)); } catch (e) { throw new Error("The file's rfm1 manifest is not valid JSON."); }
    ["rfm1", "abi", "id", "name", "version", "license", "source_url"].forEach(function (k) {
      if (m[k] === undefined || m[k] === null || m[k] === "") throw new Error("The manifest has no " + k + ".");
    });
    if (m.rfm1 !== 1) throw new Error("This file is .rfm1 version " + m.rfm1 + "; this simulator reads version 1.");
    for (j = 0; s.custom["rfm1.license." + j]; j++) {
      var t = utf8(s.custom["rfm1.license." + j]), nl = t.indexOf("\n");
      licenses.push({ name: nl < 0 ? t : t.slice(0, nl), text: nl < 0 ? "" : t.slice(nl + 1) });
    }
    if (s.custom["rfm1.skin"]) {
      try { skin = JSON.parse(utf8(s.custom["rfm1.skin"])); } catch (e) { skin = null; }
    }
    return {
      bytes: b,
      manifest: m,
      credits: s.custom["rfm1.credits"] ? utf8(s.custom["rfm1.credits"]) : "",
      licenses: licenses,
      skin: skin,
      skinImage: s.custom["rfm1.skin.background"] || null,
      memory: s.memory
    };
  }

  /* SHA-256 of the file, for telling two builds with the same id apart */
  function sha256(bytes) {
    var c = root.crypto && root.crypto.subtle;
    if (!c) return Promise.resolve("");
    return c.digest("SHA-256", bytes).then(function (h) {
      return Array.prototype.map.call(new Uint8Array(h), function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
    });
  }

  /* ---- WASI: the only imports a module may have. stdout and stderr go to log; the rest do nothing ---- */
  function Halt(code) { this.code = code; }
  function wasi(core) {
    var mem = function () { return core.mem; };
    var known = {
      fd_write: function (fd, iovs, n, nwritten) {
        var dv = new DataView(mem().buffer), total = 0, text = "", i, p, l;
        for (i = 0; i < n; i++) {
          p = dv.getUint32(iovs + i * 8, true); l = dv.getUint32(iovs + i * 8 + 4, true);
          if (fd === 1 || fd === 2) text += utf8(new Uint8Array(mem().buffer, p, l));
          total += l;
        }
        dv.setUint32(nwritten, total, true);
        if (fd !== 1 && fd !== 2) return 8;
        core._log(text);
        return 0;
      },
      fd_read: function () { return 8; },
      fd_close: function () { return 8; },
      fd_seek: function () { return 8; },
      fd_fdstat_get: function () { return 8; },
      clock_time_get: function (id, prec, out) {
        var ns = BigInt(Math.floor((root.performance ? root.performance.now() : Date.now()) * 1e6));
        new DataView(mem().buffer).setBigUint64(out, ns, true);
        return 0;
      },
      proc_exit: function (code) { throw new Halt(code); }
    };
    return function (name) {
      return known[name] || function () { return 52; };   /* ENOSYS: not in the format */
    };
  }

  /* ---- a running firmware ---- */
  function Core(fw, instance) {
    this.fw = fw;
    this.x = instance.exports;
    this.mem = this.x.memory;
    this.logLines = [];
    this.halted = 0;
    this.ms = 0;
    this.blocks = 0;
    this.ring = new Float32Array(16384 * 2);
    this.rw = 0;
    this.rr = 0;
    this.lastWrites = -1;
    this.sim1 = typeof this.x.rfm1_sim1_version === "function" ? this.x.rfm1_sim1_version() : 0;
  }
  Core.create = function (fw) {
    var core = { mem: null, _log: function () {} }, imports = { wasi_snapshot_preview1: {} };
    return WebAssembly.compile(fw.bytes).then(function (mod) {
      var bad = [], exp = {}, lookup = wasi(core);
      WebAssembly.Module.imports(mod).forEach(function (im) {
        if (im.module !== "wasi_snapshot_preview1") bad.push(im.module + "." + im.name);
        else imports.wasi_snapshot_preview1[im.name] = lookup(im.name);
      });
      if (bad.length) throw new Error("The module imports " + bad.join(", ") + ", which the .rfm1 format does not allow.");
      WebAssembly.Module.exports(mod).forEach(function (e) { exp[e.name] = 1; });
      var missing = REQUIRED.filter(function (n) { return !exp[n]; });
      if (missing.length) throw new Error("The module is missing " + missing.join(", ") + ".");
      return WebAssembly.instantiate(mod, imports);
    }).then(function (inst) {
      var c = new Core(fw, inst);
      core.mem = c.mem;
      core._log = function (t) { c._log(t); };
      c._wasiShim = core;
      c._check();
      return c;
    });
  };

  Core.prototype._log = function (t) {
    var lines = t.split("\n"), self = this;
    lines.forEach(function (l) { if (l) self.logLines.push(l); });
    if (this.logLines.length > 200) this.logLines.splice(0, this.logLines.length - 200);
    if (this.onlog) this.onlog(t);
  };
  Core.prototype._call = function (name) {
    var f = this.x[name];
    if (typeof f !== "function" || this.halted) return 0;
    try {
      return f.apply(null, Array.prototype.slice.call(arguments, 1));
    } catch (e) {
      if (e instanceof Halt) this.halted = 0x100 | (e.code & 0xff);
      else { this.halted = 0x1ff; this.error = e; }
      if (this.onhalt) this.onhalt(this.halted, e);
      return 0;
    }
  };
  Core.prototype.dv = function () {
    if (!this._dv || this._dv.buffer !== this.mem.buffer) this._dv = new DataView(this.mem.buffer);
    return this._dv;
  };
  Core.prototype.u8 = function () {
    if (!this._u8 || this._u8.buffer !== this.mem.buffer) this._u8 = new Uint8Array(this.mem.buffer);
    return this._u8;
  };
  Core.prototype.cstr = function (p, max) {
    if (!p) return "";
    var m = this.u8(), e = p, lim = p + (max || 4096);
    while (e < lim && e < m.length && m[e]) e++;
    return utf8(m.subarray(p, e));
  };
  Core.prototype._check = function () {
    var x = this.x, i, v, self = this, dv;
    if (typeof x._initialize === "function") x._initialize();
    if (x.rfm1_version() !== 1) throw new Error("The module says it is .rfm1 version " + x.rfm1_version() + "; this simulator reads version 1.");
    this.d = x.rfm1_get(ABI) || x.rfm1_get(ABI_MIN);
    if (!this.d) throw new Error("The module does not speak fm1core ABI 6 (or 5).");
    for (i = 0; i < LAYOUT.length; i++) {
      v = x.rfm1_layout(i);
      if (i === 17 && v === 188 && this.dv().getUint32(this.d, true) === 5) continue;   /* ABI 5: no credits */
      if (i === 33 && this.dv().getUint32(this.d, true) === 5) continue;
      if (v !== LAYOUT[i]) throw new Error("The module's fm1core layout differs from ABI 6 at entry " + i + " (" + v + ", expected " + LAYOUT[i] + ").");
    }
    dv = this.dv();
    var ptr = function (k) { return dv.getUint32(self.d + LAYOUT[C[k]], true); };
    this.abi = dv.getUint32(this.d, true);
    this.panel = ptr("panel");
    this.keymapPtr = ptr("keymap");
    this.flashSize = ptr("flash_size");
    this.info = {
      id: this.cstr(ptr("id")), name: this.cstr(ptr("name")), version: this.cstr(ptr("version")),
      source_url: this.cstr(ptr("source_url")), family: this.cstr(ptr("family")), license: this.cstr(ptr("license")),
      credits: this.abi >= 6 ? this.cstr(ptr("credits"), 65536) : ""
    };
    this.buttonNames = [];
    for (i = 0; i < NB; i++) this.buttonNames.push(this.cstr(dv.getUint32(this.d + LAYOUT[C.button_names] + 4 * i, true)) || LABELS[i]);
    if (!this.panel) throw new Error("The module has no panel.");
  };
  Core.prototype.p = function (k) { return this.panel + LAYOUT[P[k]]; };

  /* power on, from a saved flash image or a fresh one */
  Core.prototype.boot = function (flash) {
    var x = this.x, dv = this.dv(), n, ptr, path;
    if (flash && flash.length) {
      n = Math.min(flash.length, this.flashSize || flash.length);
      ptr = x.rfm1_alloc(n);
      if (ptr) { this.u8().set(flash.subarray(0, n), ptr); x.rfm1_flash_stage(ptr, n); }
      else x.rfm1_flash_stage(0, 0);
    } else x.rfm1_flash_stage(0, 0);
    path = x.rfm1_alloc(FLASH_STAGED.length + 1);
    this.u8().set(Array.prototype.map.call(FLASH_STAGED, function (c) { return c.charCodeAt(0); }).concat([0]), path);
    this._call("rfm1_options", path, 0, 0, 1);
    if (typeof x.rfm1_boot_options === "function") this._call("rfm1_boot_options", -1, 0, -1);
    dv.setUint8(this.p("ready"), 2);
    this._call("rfm1_init", 0);
    this._readMap();
    this.ms = 0;
    this.blocks = 0;
    this.rw = this.rr = 0;
  };
  /* where each labelled button, each encoder role and each key sits on the matrix, and its light */
  Core.prototype._readMap = function () {
    var dv = this.dv(), u = this.u8(), i, r, c, id, km = this.keymapPtr, pos = {};
    this.btnId = []; this.encId = []; this.encDir = [];
    for (i = 0; i < NB; i++) this.btnId.push(u[this.p("btn_id") + i]);
    for (i = 0; i < NE; i++) { this.encId.push(u[this.p("enc_id") + i]); this.encDir.push(dv.getInt8(this.p("enc_dir") + i) || 1); }
    if (km) for (r = 1; r <= NLINE; r++) for (c = 0; c < NCOL; c++) {
      id = dv.getInt8(km + r * NCOL + c);
      if (id >= 0) pos[id] = c * NLINE + (r - 1);
    }
    this.btnLed = this.btnId.map(function (b) { return pos[b] === undefined ? -1 : pos[b]; });
    this.keyLed = [];
    for (i = 0; i < NKEY; i++) this.keyLed.push(pos[14 + i] === undefined ? -1 : pos[14 + i]);
  };

  /* ---- the clock: one device millisecond at a time, as the ABI wants ---- */
  Core.prototype.runMs = function (n) {
    var x = this.x, due, out, f, i, k, w;
    for (k = 0; k < n && !this.halted; k++) {
      this._call("rfm1_tick", this.ms);
      if (this.ms % 15 === 0) this._call("rfm1_frame"); else this._call("rfm1_idle");
      due = Math.floor((this.ms + 1) * FS / (1000 * BLOCK));
      while (this.blocks < due && !this.halted) {
        if (!this.abuf) this.abuf = x.rfm1_alloc(BLOCK * 4) || 0;
        if (!this.abuf) { this.halted = 0x1fe; break; }
        this._call("rfm1_audio", this.abuf, BLOCK);
        out = new Int16Array(this.mem.buffer, this.abuf, BLOCK * 2);
        for (i = 0; i < BLOCK * 2; i++) {
          w = (this.rw++ % (this.ring.length)) | 0;
          this.ring[w] = out[i] / 32768;
        }
        if (this.rw - this.rr > this.ring.length) this.rr = this.rw - this.ring.length;
        this.blocks++;
      }
      this.ms++;
    }
  };
  Core.prototype.buffered = function () { return (this.rw - this.rr) >> 1; };
  /* n stereo frames at 44.1 kHz, running the device as long as it takes (at most ~250 ms of it) */
  Core.prototype.pull = function (n, into) {
    var out = into || new Float32Array(n * 2), guard = 0, i, len = this.ring.length;
    while (this.buffered() < n && !this.halted && guard++ < 250) this.runMs(1);
    for (i = 0; i < n * 2; i++) out[i] = this.rw > this.rr ? this.ring[(this.rr++) % len] : 0;
    return out;
  };
  Core.prototype.drop = function () { this.rr = this.rw; };

  /* ---- the panel ---- */
  Core.prototype.key = function (k, down, vel) {
    var dv = this.dv(), m = dv.getUint32(this.p("keys"), true);
    if (down) {
      dv.setUint8(this.p("key_vel") + k, vel ? Math.max(1, Math.min(127, vel | 0)) : 0);
      m |= 1 << k;
    } else m &= ~(1 << k);
    dv.setUint32(this.p("keys"), m >>> 0, true);
  };
  Core.prototype.pressure = function (k, pct) { this.dv().setUint8(this.p("key_lean") + k, Math.max(0, Math.min(100, pct | 0))); };
  Core.prototype.button = function (label, down) {
    var dv = this.dv(), bit = this.btnId[label], m = dv.getUint32(this.p("buttons"), true);
    if (bit === undefined) return;
    m = down ? m | (1 << bit) : m & ~(1 << bit);
    dv.setUint32(this.p("buttons"), m >>> 0, true);
  };
  Core.prototype.tapButton = function (label) {
    var dv = this.dv(), bit = this.btnId[label];
    dv.setUint32(this.p("buttons_tap"), (dv.getUint32(this.p("buttons_tap"), true) | (1 << bit)) >>> 0, true);
  };
  Core.prototype.turn = function (role, detents) {
    var dv = this.dv(), e = this.encId[role], a = this.p("enc") + 4 * e;
    if (e === undefined || !detents) return;
    dv.setInt32(a, dv.getInt32(a, true) + detents * this.encDir[role], true);
  };
  Core.prototype.master = function (v) {
    if (v === undefined) return this.dv().getInt32(this.p("master"), true);
    this.dv().setInt32(this.p("master"), Math.max(0, Math.min(1023, v | 0)), true);
  };
  Core.prototype.lcdWrites = function () { return this.dv().getUint32(this.p("lcd_writes"), true); };
  /* the screen: 240 x 240 RGB565, high byte first */
  Core.prototype.lcdBytes = function () { return new Uint8Array(this.mem.buffer, this.p("lcd"), W * H * 2); };
  /* the lights as brightness 0..255: { buttons: [14 by label], keys: [27], playGreen } */
  Core.prototype.leds = function () {
    var u = this.u8(), base = this.p("led"), self = this;
    return {
      buttons: this.btnLed.map(function (q) { return q < 0 ? 0 : u[base + q]; }),
      keys: this.keyLed.map(function (q) { return q < 0 ? 0 : u[base + q]; }),
      playGreen: u[self.p("led_play_green")]
    };
  };
  /* MIDI in as a USB-MIDI packet (cable 0): 1 taken, 0 no room */
  Core.prototype.midi = function (status, d1, d2) {
    if (typeof this.x.rfm1_midi_in !== "function") return 0;
    var pkt = ((status >> 4) & 0xf) | (status << 8) | (d1 << 16) | (d2 << 24);
    return this._call("rfm1_midi_in", pkt >>> 0);
  };
  Core.prototype.uiInfo = function () {
    if (typeof this.x.rfm1_ui_info !== "function") return "";
    if (!this.infoBuf) this.infoBuf = this.x.rfm1_alloc(128);
    if (!this.infoBuf) return "";
    this.u8()[this.infoBuf] = 0;
    this._call("rfm1_ui_info", this.infoBuf, 128);
    return this.cstr(this.infoBuf, 128);
  };
  Core.prototype.stats = function () {
    if (typeof this.x.rfm1_stats !== "function") return null;
    if (!this.statBuf) this.statBuf = this.x.rfm1_alloc(8);
    if (!this.statBuf) return null;
    this._call("rfm1_stats", this.statBuf, this.statBuf + 4);
    return { shed: this.dv().getUint32(this.statBuf, true), cpu: this.dv().getUint32(this.statBuf + 4, true) };
  };

  /* ---- the flash image: the host keeps it (here, the page's storage) ---- */
  Core.prototype.flashDirty = function () { return typeof this.x.rfm1_flash_dirty === "function" ? this.x.rfm1_flash_dirty() >>> 0 : 0; };
  Core.prototype.flashImage = function (sync) {
    if (sync && typeof this.x.rfm1_flash_sync === "function") this._call("rfm1_flash_sync");
    var p = this.x.rfm1_flash();
    if (!p || !this.flashSize) return null;
    return new Uint8Array(this.mem.buffer, p, this.flashSize).slice();
  };
  Core.prototype.shutdown = function () { if (typeof this.x.rfm1_shutdown === "function") this._call("rfm1_shutdown"); };

  /* ---- live labels (FM1VST's DYNAMIC-LABELS, optional): what every control does right now. 49 slots:
   * 0..7 the knob roles and MASTER, 8..21 the buttons, 22..37 the white keys, 38..48 the black keys.
   * A string is the label ("" = no job here), null = not given. Returns null while there are none. ---- */
  Core.prototype.labels = function () {
    if (typeof this.x.rfm1_labels_epoch !== "function" || typeof this.x.rfm1_label !== "function") return null;
    var ep = this._call("rfm1_labels_epoch") >>> 0, i, p, list;
    if (!ep) return null;
    if (ep === this._lblEpoch && this._lbl) return this._lbl;
    list = [];
    for (i = 0; i < 49; i++) {
      p = this._call("rfm1_label", i) >>> 0;
      list.push(p && p < this.mem.buffer.byteLength ? this.cstr(p, 16) : null);
    }
    this._lblEpoch = ep;
    this._lbl = list;
    return list;
  };

  /* ---- sim1, the optional extension: controls as values, and an accent colour ---- */
  Core.prototype.ctl = function (role) {
    if (!this.sim1 || typeof this.x.rfm1_sim1_ctl !== "function") return null;
    if (!this.ctlBuf) this.ctlBuf = this.x.rfm1_alloc(76);
    if (!this.ctlBuf) return null;
    var abs = this._call("rfm1_sim1_ctl", role, this.ctlBuf), dv = this.dv(), b = this.ctlBuf;
    return {
      absolute: !!abs, value: dv.getInt32(b, true), lo: dv.getInt32(b + 4, true), hi: dv.getInt32(b + 8, true),
      name: this.cstr(b + 12, 32), text: this.cstr(b + 44, 32)
    };
  };
  Core.prototype.ctlSet = function (role, v) { if (this.sim1) this._call("rfm1_sim1_ctl_set", role, v | 0); };
  Core.prototype.accent = function () {
    if (!this.sim1 || typeof this.x.rfm1_sim1_accent !== "function") return -1;
    return this._call("rfm1_sim1_accent");
  };
  Core.prototype.linkBytes = function () {
    return this.sim1 && typeof this.x.rfm1_sim1_link_bytes === "function" ? this._call("rfm1_sim1_link_bytes") : -1;
  };

  var api = { parse: parse, sha256: sha256, Core: Core, LABELS: LABELS, ROLES: ROLES, FS: FS, W: W, H: H, NKEY: NKEY };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Rfm1 = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
