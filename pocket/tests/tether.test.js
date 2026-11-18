// Run: node --test pocket/tests/tether.test.js   (a unit written from pocket/firmware/PROTOCOL.md decodes what tether.js sends; no hardware)
const test = require("node:test"), assert = require("node:assert");
const T = require("../vendor/tether.js"), { frames } = require("./tether-frames.js");

// ---- the reference unit, from PROTOCOL.md sections 2 to 4 (not from tether.js, not from the firmware)
function unpack(m) { // LSB-first bit stream, 7 bits a byte
  const o = [];
  let acc = 0, n = 0;
  for (const x of m) { acc |= x << n; n += 7; if (n >= 8) { o.push(acc & 255); acc >>= 8; n -= 8; } }
  return o;
}
class Unit {
  constructor() { this.back = new Uint16Array(57600); this.shown = new Uint16Array(57600); this.lost = true; this.open = false; this.frame = -1; this.next = 0; this.lostFor = -1; this.out = []; this.leds = null; }
  say(type, id) { this.out.push({ type, id }); }
  loseTrack(f) { this.lost = true; this.open = false; if (f !== this.lostFor) { this.lostFor = f; this.say("needkey", f); } }
  receive(m) {
    if (m[0] !== 0xf0 || m[m.length - 1] !== 0xf7 || m.length > 642 || m[1] !== 0x7d || m[2] !== 0x46 || m[3] !== 0x50 || m[4] !== 0x54) return;
    const d = [...m.slice(5, m.length - 2)];
    if (d.some((x) => x > 127)) return;
    const good = d.reduce((a, x) => a + x, 0) % 128 === m[m.length - 2], [vv, cc] = d, a = d.slice(2);
    if (good && cc === 1) { this.say("hello"); this.lost = true; this.open = false; this.lostFor = -1; return; }
    if (vv !== 1) return;
    if (cc === 2 && good && (a.length === 6 || a.length === 12)) { this.leds = a; return; }
    if (cc !== 3 || a.length < 4) return;
    const [f, sl, sh, fl] = a, seq = sl + 128 * sh;
    if (!good) return this.loseTrack(f);
    if (seq === 0) {
      if (this.lost && !(fl & 2)) return this.loseTrack(f);
      if (this.open && !(fl & 2)) return this.loseTrack(f);
      this.lost = false; this.open = true; this.frame = f; this.next = 0; this.lostFor = -1;
    } else if (this.lost) return this.loseTrack(f);
    if (f !== this.frame || seq !== this.next) return this.loseTrack(f);
    this.next++;
    if (!this.records(unpack(a.slice(4)))) return this.loseTrack(f);
    if (fl & 1) { this.shown.set(this.back); this.open = false; this.say("ack", f); }
  }
  records(p) {
    let i = 0;
    const col = () => (p[i++] << 8) | p[i++];
    while (i < p.length) {
      if (i + 2 > p.length) return false;
      const t = p[i++], op = p[i++], px = [];
      if (t > 224) return false;
      if (op === 0) { if (i + 2 > p.length) return false; px.push(...new Array(256).fill(col())); }
      else if (op === 1) { while (px.length < 256) { if (i + 3 > p.length) return false; const n = p[i++] + 1, c = col(); if (px.length + n > 256) return false; for (let k = 0; k < n; k++) px.push(c); } }
      else if (op === 2) {
        const k = p[i++], bpp = k === 2 ? 1 : k <= 4 ? 2 : 4;
        if (k < 2 || k > 16 || i + 2 * k + 32 * bpp > p.length) return false;
        const pal = []; for (let j = 0; j < k; j++) pal.push(col());
        for (let j = 0; j < 256; j++) { const at = j * bpp, v = (p[i + (at >> 3)] >> (8 - bpp - (at & 7))) & ((1 << bpp) - 1); if (v >= k) return false; px.push(pal[v]); }
        i += 32 * bpp;
      } else if (op === 3) { if (i + 512 > p.length) return false; for (let j = 0; j < 256; j++) px.push(col()); }
      else return false;
      const x0 = (t % 15) * 16, y0 = Math.floor(t / 15) * 16;
      for (let j = 0; j < 256; j++) this.back[(y0 + (j >> 4)) * 240 + x0 + (j & 15)] = px[j];
    }
    return true;
  }
}
const send = (u, msgs) => { for (const m of msgs) u.receive(m); };
const F = frames();

test("every message is valid SysEx within the unit's 640 bytes, and the unit shows each frame exactly", () => {
  const enc = new T.Encoder(), u = new Unit();
  for (const name of ["ui", "scope", "text", "black", "dark", "noise", "ui"]) {
    const msgs = enc.encode(F[name]);
    for (const m of msgs) {
      assert.ok(m.length - 2 <= T.BODY_MAX, `${name}: ${m.length} bytes`);
      assert.ok(m.slice(1, -1).every((x) => x < 128), `${name}: 7-bit`);
    }
    u.out = [];
    send(u, msgs);
    assert.deepStrictEqual(u.shown, F[name], name);
    assert.deepStrictEqual(u.out, [{ type: "ack", id: enc.id }], name);
  }
  assert.deepStrictEqual(enc.encode(F.ui), [], "nothing changed: nothing sent");
});

test("a frame is shown whole or not at all; a lost message asks for a keyframe, which mends it", () => {
  const enc = new T.Encoder(), u = new Unit();
  send(u, enc.encode(F.ui));
  const msgs = enc.encode(F.noise); // many messages
  assert.ok(msgs.length > 3);
  send(u, msgs.filter((_, i) => i !== 2));
  assert.deepStrictEqual(u.shown, F.ui, "the broken frame is never shown");
  assert.deepStrictEqual(u.out.map((o) => o.type), ["ack", "needkey"]);
  send(u, enc.encode(F.dark)); // the page has not seen NEED KEY yet: ignored, NEED KEY again
  assert.deepStrictEqual(u.out.map((o) => o.type), ["ack", "needkey", "needkey"]);
  enc.needKey();
  const key = enc.encode(F.dark);
  send(u, key);
  assert.deepStrictEqual(u.shown, F.dark);
  assert.strictEqual(u.out[u.out.length - 1].type, "ack");
  // a damaged byte (checksum) and a lost PRESENT both count as lost
  const d1 = enc.encode(F.ui);
  d1[0][20] ^= 1;
  u.out = [];
  send(u, d1);
  assert.deepStrictEqual(u.out.map((o) => o.type), ["needkey"]);
  enc.needKey(); send(u, enc.encode(F.text));
  const d2 = enc.encode(F.scope);
  send(u, d2.slice(0, -1));
  send(u, enc.encode(F.ui));
  assert.deepStrictEqual(u.shown, F.text);
  assert.strictEqual(u.out[u.out.length - 1].type, "needkey");
});

test("HELLO, LEDS, and the unit's MIDI read back", () => {
  assert.deepStrictEqual([...T.hello()], [0xf0, 0x7d, 0x46, 0x50, 0x54, 1, 1, 2, 0xf7]);
  assert.deepStrictEqual([...T.leds([0, 12, 14, 40])], [0xf0, 0x7d, 0x46, 0x50, 0x54, 1, 2, 1, 0x20, 1, 0, 0, 0x20, 0x45, 0xf7]);
  const u = new Unit();
  u.receive(T.leds([1], [2]));
  assert.deepStrictEqual(u.leds, [2, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0]);
  const reply = T.message(0x41, [1, 0, 27, 14, 7, ...Buffer.from("TETHER 0.1")]);
  assert.deepStrictEqual(T.parse(reply), { type: "hello", proto: 1, board: "FM-1", keys: 27, buttons: 14, encoders: 7, audioOut: false, name: "TETHER 0.1", version: 1 }, "a protocol 1 unit: no CA, no speaker");
  const r2 = T.parse(T.message(0x41, [2, 0, 27, 14, 7, 1, ...Buffer.from("TETHER 0.2")]));
  assert.deepStrictEqual([r2.proto, r2.audioOut, r2.name], [2, true, "TETHER 0.2"], "protocol 2: CA bit 0 = the USB speaker, then the name");
  assert.strictEqual(T.parse(T.message(0x41, [2, 0, 27, 14, 7, 0, ...Buffer.from("T")])).audioOut, false, "a protocol 2 build without the speaker");
  assert.deepStrictEqual(T.parse(T.message(0x42, [5])), { type: "ack", id: 5, value: 5 });
  assert.deepStrictEqual(T.parse(T.message(0x43, [9])), { type: "needkey", id: 9, value: 9 });
  const bad = T.message(0x42, [5]); bad[7] ^= 1;
  assert.strictEqual(T.parse(bad), null);
  assert.strictEqual(T.parse(Uint8Array.of(0xf0, 0x00, 0x13, 0x2c, 0xf7)), null, "an M-UPGRADE frame is not ours");
  assert.deepStrictEqual(T.parse([0x90, 53, 100]), { type: "key", id: 0, value: 100 });
  assert.deepStrictEqual(T.parse([0x80, 79, 0]), { type: "key", id: 26, value: 0 });
  assert.deepStrictEqual(T.parse([0x9f, 12, 127]), { type: "button", id: 12, value: 1 });
  assert.deepStrictEqual(T.parse([0x8f, 12, 0]), { type: "button", id: 12, value: 0 });
  assert.deepStrictEqual(T.parse([0xbf, 22, 61]), { type: "encoder", id: 2, value: -3 });
  assert.deepStrictEqual(T.parse([0xbf, 27, 99]), { type: "master", id: 0, value: 99 });
  assert.strictEqual(T.parse([0x91, 60, 100]), null);
});

test("an ImageData-like frame encodes as its RGB565", () => {
  const d = new Uint8ClampedArray(240 * 240 * 4);
  for (let i = 0; i < 57600; i++) d.set([255, 128, 8, 255], i * 4);
  const u = new Unit();
  send(u, new T.Encoder().encode({ data: d, width: 240, height: 240 }));
  assert.ok(u.shown.every((v) => v === ((31 << 11) | (32 << 5) | 1)));
});

test("sizes and timing (figures for STATUS.md)", (t) => {
  const link = [96000, 48000]; // SysEx bytes a second: the unit's ceiling (one 64-byte packet per 0.5 ms), and half of it
  const rows = [["keyframe, real UI (Felucca)", null, "ui"], ["delta: its oscilloscope moves", "ui", "scope"], ["keyframe, text in 4 colours", null, "text"],
    ["delta: a few tiles on black", "black", "dark"], ["keyframe, black", null, "black"], ["keyframe, full noise (worst)", null, "noise"]];
  for (const [what, from, to] of rows) {
    const enc = new T.Encoder();
    if (from) enc.encode(F[from]);
    const t0 = process.hrtime.bigint(), msgs = enc.encode(F[to], { key: !from }), ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const bytes = msgs.reduce((a, m) => a + m.length, 0), tiles = new Set(), bands = new Set();
    for (let tt = 0; tt < 225; tt++) {
      let diff = !from;
      for (let j = 0; j < 256 && !diff; j++) { const i = (Math.floor(tt / 15) * 16 + (j >> 4)) * 240 + (tt % 15) * 16 + (j & 15); diff = F[from][i] !== F[to][i]; }
      if (diff) { tiles.add(tt); bands.add(Math.floor(tt / 15)); }
    }
    const usb = link.map((r) => (bytes / r) * 1000), spi = bands.size * 5.12; // a 240 x 16 band at 12 MHz SPI
    t.diagnostic(`${what}: ${tiles.size} tiles, ${msgs.length} msgs, ${bytes} B; USB ${usb[0].toFixed(1)}-${usb[1].toFixed(1)} ms, SPI ${spi.toFixed(0)} ms -> ` +
      `${(1000 / Math.max(usb[0], spi)).toFixed(0)}-${(1000 / Math.max(usb[1], spi)).toFixed(0)} fps; encode ${ms.toFixed(1)} ms`);
    if (to === "noise") assert.ok(bytes < 140000);
    if (from === "black") assert.ok(bytes < 300, "a few tiles cost little");
  }
});

// the package built by firmware/autobuild.sh is what the page installs: it must be a good FM-1 package for the chip key of a real unit
test("vendor/tether.fwsc is a package the unit's own checks accept", () => {
  const R = require("../vendor/real-fm1.js"), fs = require("fs"), path = require("path");
  const raw = fs.readFileSync(path.join(__dirname, "../vendor/tether.fwsc")), pkg = R.unweave(new Uint8Array(raw));
  assert.match(pkg.identity, /FM-1/);
  assert.ok(R.checkPackage(pkg, 0x980f).size > 0x4000);
});
