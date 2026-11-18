// TETHER: a real FM-1 running the Tether firmware as the panel of the emulator. Pure protocol, no page code, so Node can
// test it (tests/tether.test.js). Written from pocket/firmware/PROTOCOL.md (version 1); none of the firmware's code is in it.
// What it does: the HELLO query, the LEDS message, the unit's MIDI read as {type, id, value}, and the screen as SysEx
// (tiles of 16 x 16, each as one colour, runs, a small palette or raw; only the tiles that changed since the last frame).
const Tether = (() => {
  const TAG = [0x7d, 0x46, 0x50, 0x54], VER = 1;
  const CMD = { HELLO: 0x01, LEDS: 0x02, SCREEN: 0x03, HELLO_REPLY: 0x41, ACK: 0x42, NEED_KEY: 0x43 };
  const SIDE = 240, TILE = 16, ROW = SIDE / TILE, TILES = ROW * ROW, BODY_MAX = 640;
  const PAYLOAD_MAX = Math.floor(((BODY_MAX - TAG.length - 7) * 7) / 8); // tag, VV CC FF SL SH FL, SS: 550 bytes
  const OP = { SOLID: 0, RLE: 1, PALETTE: 2, RAW: 3 };

  function message(cmd, data = []) {
    let sum = VER + cmd;
    for (const x of data) sum += x;
    return Uint8Array.from([0xf0, ...TAG, VER, cmd, ...data, sum & 127, 0xf7]);
  }
  function pack7(b) {
    const out = [];
    let acc = 0, bits = 0;
    for (const x of b) {
      acc |= x << bits; bits += 8;
      while (bits >= 7) { out.push(acc & 127); acc >>= 7; bits -= 7; }
    }
    if (bits) out.push(acc & 127);
    return out;
  }
  function unpack7(m) {
    const out = [];
    let acc = 0, bits = 0;
    for (const x of m) { acc |= (x & 127) << bits; bits += 7; if (bits >= 8) { out.push(acc & 255); acc >>= 8; bits -= 8; } }
    return out;
  }

  const hello = () => message(CMD.HELLO);
  // lit, dim: arrays of LED ids (FM-1: 0..13 the buttons, 14 + key the keys); no dim: every dim LED off
  function leds(lit, dim) {
    const mask = (ids) => {
      const m = [0, 0, 0, 0, 0, 0];
      for (const i of ids) if (i >= 0 && i < 42) m[(i / 7) | 0] |= 1 << i % 7;
      return m;
    };
    return message(CMD.LEDS, dim ? [...mask(lit), ...mask(dim)] : mask(lit));
  }

  // the emulator's frame: Uint16Array of 57600 RGB565, or anything with RGBA .data (ImageData) of 240 x 240
  function to565(f) {
    if (f instanceof Uint16Array) return f;
    const d = f.data, o = new Uint16Array(SIDE * SIDE);
    for (let i = 0; i < o.length; i++) o[i] = ((d[4 * i] >> 3) << 11) | ((d[4 * i + 1] >> 2) << 5) | (d[4 * i + 2] >> 3);
    return o;
  }
  function tilePixels(px, t) {
    const o = new Uint16Array(TILE * TILE), x0 = (t % ROW) * TILE, y0 = ((t / ROW) | 0) * TILE;
    for (let y = 0; y < TILE; y++) o.set(px.subarray((y0 + y) * SIDE + x0, (y0 + y) * SIDE + x0 + TILE), y * TILE);
    return o;
  }
  // one tile -> its shortest record (TT OP ...), 8-bit bytes
  function tileRecord(t, p) {
    const c2 = (c) => [c >> 8, c & 255];
    const cols = [...new Set(p)];
    if (cols.length === 1) return [t, OP.SOLID, ...c2(p[0])];
    const rle = [t, OP.RLE];
    for (let i = 0; i < 256; ) {
      let n = 1;
      while (i + n < 256 && n < 256 && p[i + n] === p[i]) n++;
      rle.push(n - 1, ...c2(p[i]));
      i += n;
    }
    let best = rle;
    if (cols.length <= 16) {
      const bpp = cols.length === 2 ? 1 : cols.length <= 4 ? 2 : 4, idx = new Map(cols.map((c, i) => [c, i]));
      const pal = [t, OP.PALETTE, cols.length, ...cols.flatMap(c2)], bits = new Array((256 * bpp) / 8).fill(0);
      for (let i = 0; i < 256; i++) {
        const at = i * bpp;
        bits[at >> 3] |= idx.get(p[i]) << (8 - bpp - (at & 7));
      }
      pal.push(...bits);
      if (pal.length < best.length) best = pal;
    }
    if (best.length > 2 + 512) best = [t, OP.RAW, ...Array.from(p).flatMap(c2)];
    return best;
  }

  // the screen, as SysEx: keeps the last frame it encoded and sends only the tiles that differ from it
  class Encoder {
    constructor() { this.last = null; this.id = 127; this.key = true; }
    needKey() { this.key = true; } // after NEED KEY, a lost ACK, or a new HELLO
    // -> array of SysEx messages (Uint8Array), [] when nothing changed. opts.key forces a keyframe
    encode(frame, opts = {}) {
      const px = to565(frame), key = this.key || !!opts.key || !this.last, recs = [];
      for (let t = 0; t < TILES; t++) {
        const p = tilePixels(px, t);
        if (!key && p.every((v, i) => v === this.last[t][i])) continue;
        recs.push(tileRecord(t, p));
      }
      this.last = Array.from({ length: TILES }, (_, t) => tilePixels(px, t));
      if (!recs.length) return [];
      this.key = false;
      this.id = (this.id + 1) & 127;
      const bodies = [[]];
      for (const r of recs) {
        if (bodies[bodies.length - 1].length + r.length > PAYLOAD_MAX) bodies.push([]);
        bodies[bodies.length - 1].push(...r);
      }
      return bodies.map((b, seq) => {
        const fl = (seq === bodies.length - 1 ? 1 : 0) | (key && seq === 0 ? 2 : 0);
        return message(CMD.SCREEN, [this.id, seq & 127, seq >> 7, fl, ...pack7(b)]);
      });
    }
  }

  // one MIDI message from the unit -> {type, id, value} (or a HELLO / ACK / NEED KEY object), null when it is not ours
  function parse(m) {
    const st = m[0], ty = st & 0xf0, ch = st & 15;
    if (st === 0xf0) {
      if (m.length < 9 || m[m.length - 1] !== 0xf7 || TAG.some((x, i) => m[1 + i] !== x)) return null;
      const d = Array.from(m.slice(5, -2));
      if (d.reduce((a, x) => a + x, 0) % 128 !== m[m.length - 2]) return null;
      const [ver, cmd] = d, a = d.slice(2);
      if (cmd === CMD.HELLO_REPLY && a.length >= 5)
        return { type: "hello", proto: a[0], board: a[1] ? "SMK-37" : "FM-1", keys: a[2], buttons: a[3], encoders: a[4], name: String.fromCharCode(...a.slice(5)), version: ver };
      if (ver !== VER) return null;
      if (cmd === CMD.ACK) return { type: "ack", id: a[0], value: a[0] };
      if (cmd === CMD.NEED_KEY) return { type: "needkey", id: a[0], value: a[0] };
      return null;
    }
    if (m.length < 3) return null;
    if ((ty === 0x90 || ty === 0x80) && ch === 0 && m[1] >= 53 && m[1] <= 79)
      return { type: "key", id: m[1] - 53, value: ty === 0x90 ? m[2] : 0 };
    if ((ty === 0x90 || ty === 0x80) && ch === 15) return { type: "button", id: m[1], value: ty === 0x90 && m[2] ? 1 : 0 };
    if (ty === 0xb0 && ch === 15 && m[1] >= 20 && m[1] <= 26) return { type: "encoder", id: m[1] - 20, value: m[2] - 64 };
    if (ty === 0xb0 && ch === 15 && m[1] === 27) return { type: "master", id: 0, value: m[2] };
    return null;
  }

  return { CMD, OP, TILE, TILES, PAYLOAD_MAX, BODY_MAX, message, pack7, unpack7, hello, leds, to565, tileRecord, Encoder, parse };
})();
if (typeof module !== "undefined") module.exports = Tether;
