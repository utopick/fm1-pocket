// REAL FM-1: talking to a real M-VAVE FM-1 over USB MIDI (SysEx). Pure protocol, no page code, so Node can test it
// (tests/real-fm1.test.js). Written from docs/SPEC.md of jvitkauskas/m-bootloader (MIT) sections 4.2, 5.1, 5.6, 11.6, 11.7.
// What it can do: frame and read messages, ask what is answering (0x12), back up the whole flash (0x23, checked with 0x24),
// and serve a firmware package to the unit, which reads it by itself (0x30). It never builds a command from data: every
// command byte below is a constant. 0x21 (erase on stock firmware) differs from 0x23 (read) by one bit and is never sent.
const RealFM1 = (() => {
  const CMD = { IDENT: 0x11, INFO: 0x12, READ: 0x23, CRC: 0x24, PKG: 0x30 };
  const SOFT = { UPGRADE: 0x7f, DOWNLOAD: 0x7d, RESTART: 0x7e }; // F0 22 24 35 <n> F7
  const PACKET = 512, FINISH = 0xf0000000;

  const crc16 = (b, c = 0) => { // CRC16/XMODEM
    for (const x of b) { c ^= x << 8; for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff; }
    return c;
  };
  let T32;
  const crc32 = (b, c = 0xffffffff) => {
    if (!T32) { T32 = new Uint32Array(256); for (let n = 0; n < 256; n++) { let v = n; for (let k = 0; k < 8; k++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1; T32[n] = v >>> 0; } }
    for (const x of b) c = T32[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  // the ENC transform (its own inverse): one state step per byte
  const enc = (key, b) => {
    const o = new Uint8Array(b.length);
    let s = key;
    for (let i = 0; i < b.length; i++) { o[i] = b[i] ^ (s & 255); s = ((s << 1) & 0xffff) ^ (s & 0x8000 ? 0x1021 : 0); }
    return o;
  };
  const le32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

  // ---- frames: F0, the bytes 8-to-7 packed, F7. Unpacked: 00 59 cmd len16 00 body checksum (complement of the body's sum)
  function frame(cmd, body = []) {
    const raw = [0, 0x59, cmd, body.length & 255, (body.length >> 8) & 255, 0, ...body];
    let sum = 0;
    for (const x of body) sum += x;
    raw.push(~sum & 255);
    const out = [0xf0];
    let acc = 0, bits = 0;
    for (const x of raw) {
      acc |= x << bits; bits += 8;
      while (bits >= 7) { out.push(acc & 127); acc >>= 7; bits -= 7; }
    }
    if (bits) out.push(acc & 127);
    out.push(0xf7);
    return Uint8Array.from(out);
  }
  // a whole SysEx message (F0 ... F7) -> {cmd, body}, {soft: 0x7d...}, or null when it is not one of ours or fails its checks
  function parse(msg) {
    if (msg[0] !== 0xf0 || msg[msg.length - 1] !== 0xf7) return null;
    const m = msg.slice(1, -1);
    if (m.length === 4 && m[0] === 0x22 && m[1] === 0x24 && m[2] === 0x35) return { soft: m[3] };
    const d = [];
    let acc = 0, bits = 0;
    for (const x of m) { acc |= (x & 127) << bits; bits += 7; if (bits >= 8) { d.push(acc & 255); acc >>= 8; bits -= 8; } }
    if (d.length < 7 || d[0] || d[1] !== 0x59 || d[5] || (d[3] | (d[4] << 8)) !== d.length - 7) return null;
    let sum = 0;
    for (let i = 6; i < d.length; i++) sum += d[i];
    if ((sum & 255) !== 255) return null;
    return { cmd: d[2], body: Uint8Array.from(d.slice(6, d.length - 1)) };
  }
  const soft = (n) => Uint8Array.of(0xf0, 0x22, 0x24, 0x35, n, 0xf7);
  const readBody = (addr, n) => [0, addr & 255, (addr >> 8) & 255, (addr >> 16) & 255, (addr >>> 24) & 255, n & 255, (n >> 8) & 255, (n >> 16) & 255];

  // ---- a link: one MIDI input and one output (or anything with onmessage / send), answers matched by command
  class Link {
    constructor(input, output) {
      this.out = output; this.ms = 1500; this.q = []; this.wait = null; this.buf = [];
      input.onmidimessage = (e) => this.feed(e.data);
    }
    feed(data) { // Web MIDI hands whole SysEx messages; collect anyway if one comes in pieces
      for (const x of data) {
        if (x === 0xf0) this.buf = [x];
        else if (this.buf.length) { this.buf.push(x); if (x === 0xf7) { const p = parse(this.buf); this.buf = []; if (p) this.got(p); } }
      }
    }
    got(p) { if (this.wait && this.wait.test(p)) { const w = this.wait; this.wait = null; clearTimeout(w.t); w.ok(p); } else this.q.push(p); }
    send(bytes) { this.out.send(bytes); }
    // wait for a message that passes test(), up to ms; resolves null on timeout. Messages that arrived early are used first.
    next(test, ms) {
      const i = this.q.findIndex(test);
      if (i >= 0) return Promise.resolve(this.q.splice(i, 1)[0]);
      return new Promise((ok) => { this.wait = { test, ok, t: setTimeout(() => { this.wait = null; ok(null); }, ms) }; });
    }
    async ask(cmd, body, test, ms = this.ms, tries = 3) {
      for (let t = 0; t < tries; t++) {
        this.q.length = 0;
        this.send(frame(cmd, body));
        const r = await this.next(test, ms);
        if (r) return r;
      }
      return null;
    }
  }

  // ---- what is answering: m-bootloader's MIDI mode or its RAM stage, and nothing else. Sent only to a port called "... Update".
  async function probe(link) {
    const r = await link.ask(CMD.INFO, [], (p) => p.cmd === CMD.INFO || p.cmd === 0, undefined, 2);
    if (!r) return null;
    const b = r.body, text = String.fromCharCode(...b.slice(0, 5));
    if (r.cmd !== CMD.INFO || text !== "MBOOT" || b.length < 28) return { mboot: false };
    let v = "";
    for (let i = 28; i < b.length && b[i]; i++) v += String.fromCharCode(b[i]);
    return {
      mboot: true, protocol: b[5], kind: b[6] === 1 ? "bootloader" : b[6] === 2 ? "RAM stage" : "unknown", reads: !!(b[7] & 1),
      key: b[8] | (b[9] << 8), capacity: le32(b, 10), jedec: le32(b, 14), uid: Array.from(b.slice(18, 26), (x) => x.toString(16).padStart(2, "0")).join(""), version: v,
    };
  }

  // ---- backup: the whole flash in 512-byte reads, each checked against the address it came back for, then the whole checked
  // against the chip's own CRC-32 (0x24). Resolves the bytes; throws on a failure.
  async function backup(link, info, onProgress = () => {}, stop = () => false) {
    if (!info || !info.mboot || !info.capacity || info.capacity > 0x1000000) throw new Error("This unit did not say what its flash is");
    const out = new Uint8Array(info.capacity);
    for (let at = 0; at < out.length; at += PACKET) {
      if (stop()) throw new Error("Stopped");
      const n = Math.min(PACKET, out.length - at);
      const r = await link.ask(CMD.READ, readBody(at, n), (p) => p.cmd === CMD.READ || p.cmd === 0, undefined, 4);
      if (!r || r.cmd !== CMD.READ || r.body.length !== 8 + n || le32(r.body, 1) !== at) throw new Error("The unit stopped answering at " + at.toString(16));
      out.set(r.body.subarray(8), at);
      if (!((at / PACKET) & 31)) onProgress(at / out.length);
    }
    const r = await link.ask(CMD.CRC, readBody(0, out.length), (p) => p.cmd === CMD.CRC || p.cmd === 0, 8000, 2);
    if (!r || r.cmd !== CMD.CRC || r.body.length !== 12) throw new Error("The unit did not give its checksum");
    if (le32(r.body, 8) !== crc32(out)) throw new Error("The copy does not match the chip's checksum. Try again.");
    onProgress(1);
    return out;
  }

  // ---- is m-bootloader in this flash? Its boot container (physical 0xA0, ENC 0xFFFF over the whole payload) holds a 48-byte identity at
  // payload offset 0x40: "AC79BLID", the board tag ("fm1"), a version text (m-bootloader's specification, 8.1). The stock bootloader has none.
  function protector(flash) {
    if (!flash || flash.length < 0xb0 + 0x70) return { installed: false };
    const d = enc(0xffff, flash.subarray(0xb0, 0xb0 + 0x70)), text = (from, to) => String.fromCharCode(...Array.from(d.subarray(from, to)).filter(Boolean).filter((c) => c >= 32 && c < 127));
    if (text(0x40, 0x48) !== "AC79BLID") return { installed: false };
    return { installed: true, board: text(0x48, 0x50), version: text(0x50, 0x70) };
  }

  // ---- what is in the flash: the top-level directory (32-byte records from 0x20, each ENC 0xFFFF with its own CRC16: name, address, length)
  // and which 4 KiB sectors hold anything (a sector that is all 0xFF is blank). Reading only: nothing here is trusted for a write.
  function flashMap(flash) {
    const records = [];
    for (let o = 0x20; o + 32 <= Math.min(flash.length, 0x400) && records.length < 32; o += 32) {
      const r = enc(0xffff, flash.subarray(o, o + 32));
      if ((r[0] | (r[1] << 8)) !== crc16(r.subarray(2, 32))) break;
      let name = "";
      for (let i = 16; i < 32 && r[i]; i++) name += r[i] >= 32 && r[i] < 127 ? String.fromCharCode(r[i]) : "?";
      records.push({ name, addr: le32(r, 4), len: le32(r, 8), attr: r[12] });
    }
    const sectors = new Uint8Array(flash.length >> 12);
    for (let i = 0; i < sectors.length; i++) {
      const end = (i + 1) << 12;
      for (let j = i << 12; j < end; j++) if (flash[j] !== 0xff) { sectors[i] = 1; break; }
    }
    return { records, sectors, used: sectors.reduce((a, b) => a + b, 0), protector: protector(flash) };
  }

  // ---- a package (.fwsc): identity bytes sit in the 48th byte of the first blocks; the unit reads the image without them
  function unweave(raw) {
    const B = 48, K = 47, MIN = 20, S = 0x7d;
    if (raw.length < 0x1000) throw new Error("This is not a firmware package");
    let prefix = 0;
    while (prefix < MIN || raw[prefix * B + K] === S) { prefix++; if ((prefix + 1) * B > raw.length) throw new Error("This is not a firmware package"); }
    let id = "";
    for (let i = 0; i < prefix && raw[i * B + K] !== S; i++) id += String.fromCharCode((raw[i * B + K] - i - 1) & 255);
    const image = new Uint8Array(raw.length - prefix);
    for (let i = 0; i < prefix; i++) image.set(raw.subarray(i * B, i * B + K), i * K);
    image.set(raw.subarray(prefix * B), prefix * K);
    // the header must check out before anything is offered to a unit
    const head = enc(0xffff, image.subarray(0, 64));
    const total = le32(head, 4), count = head[8] | (head[9] << 8);
    if (crc16(head.subarray(2)) !== (head[0] | (head[1] << 8)) || total !== image.length || !count || count > 16) throw new Error("This package's header is damaged");
    if (crc16(image.subarray(64, 64 + 80 * count)) !== (head[2] | (head[3] << 8))) throw new Error("This package's file list is damaged");
    const files = [];
    for (let i = 0; i < count; i++) {
      const e = enc(0xffff, image.subarray(64 + 80 * i, 64 + 80 * (i + 1)));
      files.push({ type: e[0] | (e[1] << 8), crc: e[4] | (e[5] << 8), offset: le32(e, 8), size: le32(e, 12) });
    }
    return { identity: id, image, files };
  }

  // ---- a raw flash (a backup) wrapped as a one-file package, the form the emulator and the firmware list take. flash.bin is the
  // raw flash from address 0 as stored, so the backup goes in unchanged; the identity is woven in as in M-VAVE's packages.
  function wrap(flash, identity = "FM-1_000") {
    const B = 48, K = 47, PREFIX = 20, S = 0x7d, HEAD = 64, ENTRY = 80, FIRST = 0x400;
    if (flash.length % 4096 || flash.length > 0x100000) throw new Error("A flash copy is whole 4 KiB sectors");
    const total = FIRST + flash.length, image = new Uint8Array(total).fill(0);
    const w16 = (b, i, v) => { b[i] = v & 255; b[i + 1] = v >> 8; }, w32 = (b, i, v) => { w16(b, i, v & 0xffff); w16(b, i + 2, v >>> 16); };
    const entry = new Uint8Array(ENTRY);
    w16(entry, 4, crc16(flash)); w32(entry, 8, FIRST); w32(entry, 12, flash.length);
    entry.set(new TextEncoder().encode("flash.bin"), 64);
    image.set(enc(0xffff, entry), HEAD);
    const head = new Uint8Array(HEAD);
    w16(head, 2, crc16(image.subarray(HEAD, HEAD + ENTRY))); w32(head, 4, total); w16(head, 8, 1); w16(head, 10, 4); w16(head, 12, 0x200);
    head.set(new TextEncoder().encode("AC791N"), 16);
    w16(head, 0, crc16(head.subarray(2)));
    image.set(enc(0xffff, head), 0);
    image.set(flash, FIRST);
    const markers = Array.from({ length: PREFIX }, (_, i) => (i < identity.length ? (identity.charCodeAt(i) + i + 1) & 255 : S));
    const out = new Uint8Array(total + PREFIX);
    for (let i = 0; i < PREFIX; i++) { out.set(image.subarray(i * K, (i + 1) * K), i * B); out[i * B + K] = markers[i]; }
    out.set(image.subarray(PREFIX * K), PREFIX * B);
    if (out[PREFIX * B + K] === S) throw new Error("The copy cannot be wrapped (a byte after the prefix reads as a sentinel)");
    return out;
  }

  // ---- install: the unit asks for the package a piece at a time (0x30, "flag, address, length") and we answer from the image.
  // The unit checks everything (header, chip key, CRCs, each sector) before it erases, so a wrong package is refused there.
  // `start` sends the message that begins it (F0 22 24 35 7F F7 to a running firmware; nothing to a unit already in MIDI mode).
  async function servePackage(link, image, { start = true, onProgress = () => {}, stop = () => false, idleMs = 20000, doneMs = 5000 } = {}) {
    if (start) link.send(soft(SOFT.UPGRADE));
    let served = 0, last = Date.now();
    for (;;) {
      if (stop()) throw new Error("Stopped");
      const p = await link.next((m) => m.cmd === CMD.PKG, 500);
      if (!p) {
        const idle = Date.now() - last;
        // through a running firmware's update route the unit takes the package, restarts and installs on its own: it just stops asking
        if (start && served && idle > doneMs) return served;
        if (idle > idleMs) throw new Error("The unit stopped asking for the package");
        continue;
      }
      last = Date.now();
      if (p.body.length !== 8) continue;
      const addr = le32(p.body, 1), n = p.body[5] | (p.body[6] << 8) | (p.body[7] << 16);
      if (n > PACKET) continue;
      if (addr === FINISH) { link.send(frame(CMD.PKG, [...p.body, ...new Array(n).fill(0)])); return served; } // the unit has written everything
      if (addr + n > image.length) continue; // outside the package: say nothing, the unit asks again then gives up
      link.send(frame(CMD.PKG, [...p.body, ...image.subarray(addr, addr + n)]));
      served += n;
      onProgress(Math.min(1, (addr + n) / image.length));
    }
  }

  return { CMD, SOFT, frame, parse, soft, Link, probe, backup, protector, flashMap, unweave, wrap, servePackage, crc16, crc32, enc };
})();
if (typeof module !== "undefined") module.exports = RealFM1;
