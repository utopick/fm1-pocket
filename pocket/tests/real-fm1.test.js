// Run: node --test pocket/tests/real-fm1.test.js   (a simulated unit that answers like m-bootloader's MIDI mode; no hardware)
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), path = require("path");
const R = require("../vendor/real-fm1.js");

// the unit's own packing, written the way the C code does it (streaming accumulator), to check frame() against a second version
function unitSend(cmd, body) {
  const head = [0, 0x59, cmd, body.length & 255, body.length >> 8];
  const total = body.length + 7, wire = [0xf0];
  let sum = 0, bits = 0, at = 0, acc = 0;
  while (at < total || bits) {
    if (bits < 7 && at < total) {
      let b;
      if (at < 6) b = head[at] || 0; else if (at - 6 < body.length) { b = body[at - 6]; sum += b; } else b = ~sum & 255;
      at++; acc |= b << bits; bits += 8;
    }
    wire.push(acc & 127); acc >>= 7; bits = bits > 7 ? bits - 7 : 0;
  }
  wire.push(0xf7);
  return Uint8Array.from(wire);
}
// a unit: 1 MiB flash; answers 0x12, 0x23, 0x24
function makeUnit(flash, { drop = 0 } = {}) {
  const u = { sent: [], input: {}, reads: 0 };
  const reply = (cmd, body) => setTimeout(() => u.input.onmidimessage({ data: unitSend(cmd, body) }), 0);
  u.output = { send(bytes) {
    const p = R.parse(bytes);
    u.sent.push(p);
    if (!p || !p.cmd) return;
    const b = p.body, addr = (b[1] | b[2] << 8 | b[3] << 16 | b[4] << 24) >>> 0, n = b[5] | b[6] << 8 | b[7] << 16;
    if (p.cmd === 0x12) reply(0x12, [...Buffer.from("MBOOT"), 1, 1, 1, 0x0f, 0x98, 0, 0, 0x10, 0, 0x14, 0x60, 0x85, 0, 1, 2, 3, 4, 5, 6, 7, 8, 0, 0, ...Buffer.from("2.4-test\0")]);
    else if (p.cmd === 0x23) { if (drop && ++u.reads % drop === 0) return; reply(0x23, [...b.slice(0, 8), ...flash.subarray(addr, addr + n)]); }
    else if (p.cmd === 0x24) reply(0x24, [...b.slice(0, 8), ...new Uint8Array(new Uint32Array([R.crc32(flash.subarray(addr, addr + n))]).buffer)]);
    else reply(0, [1]);
  } };
  return u;
}

test("framing matches the unit's own packing, and refuses damage", () => {
  for (const body of [[], [1], [0xff, 0x80, 0, 0x7f], Array.from({ length: 520 }, (_, i) => (i * 37) & 255)]) {
    const f = R.frame(0x23, body);
    assert.deepStrictEqual(Array.from(f), Array.from(unitSend(0x23, body)));
    assert.ok(f.slice(1, -1).every((x) => x < 128));
    assert.deepStrictEqual(Array.from(R.parse(f).body), body);
  }
  const f = R.frame(0x11, [1, 2, 3]); f[5] ^= 1;
  assert.strictEqual(R.parse(f), null);
  assert.deepStrictEqual(R.parse(Uint8Array.of(0xf0, 0x22, 0x24, 0x35, 0x7d, 0xf7)), { soft: 0x7d });
});
test("checksums: the spec's check values and ENC vector", () => {
  const d = Buffer.from("123456789");
  assert.strictEqual(R.crc16(d), 0x31c3);
  assert.strictEqual(R.crc32(d), 0xcbf43926);
  assert.strictEqual(Buffer.from(R.enc(0xffff, new Uint8Array(32))).toString("hex"), "ffdf9f1f1f3e7cf8f0c1a367cebd5b970f1e3c78d183274e9c1913264c983060");
});
test("probe and backup, with lost answers", async () => {
  const flash = new Uint8Array(0x100000).map((_, i) => (i * 7 + (i >> 9)) & 255);
  const u = makeUnit(flash, { drop: 50 }), link = new R.Link(u.input, u.output); link.ms = 30;
  const info = await R.probe(link);
  assert.strictEqual(info.mboot, true); assert.strictEqual(info.capacity, 0x100000); assert.strictEqual(info.kind, "bootloader"); assert.strictEqual(info.version, "2.4-test");
  const got = await R.backup(link, info);
  assert.ok(Buffer.from(got).equals(Buffer.from(flash)));
  // only reads were ever sent: 0x12, 0x23, 0x24
  assert.ok(u.sent.every((p) => [0x12, 0x23, 0x24].includes(p.cmd)));
});
test("a unit that is not m-bootloader is not mistaken for one", async () => {
  const u = { input: {}, output: { send() { setTimeout(() => u.input.onmidimessage({ data: unitSend(0, [1]) }), 0); } } };
  const l = new R.Link(u.input, u.output); l.ms = 30;
  assert.deepStrictEqual(await R.probe(l), { mboot: false });
});
test("a wrong copy is caught by the chip's checksum", async () => {
  const flash = new Uint8Array(0x100000).fill(5), u = makeUnit(flash), link = new R.Link(u.input, u.output); link.ms = 30;
  const info = await R.probe(link), send = u.output.send;
  u.output.send = (b) => { const p = R.parse(b); if (p && p.cmd === 0x23 && p.body[1] === 0 && p.body[2] === 2) flash[0x200] ^= 1; send(b); }; // a bit flips after the chip's CRC is not yet asked
  u.output.send = (b) => { const p = R.parse(b); if (p && p.cmd === 0x24) flash[0x400] ^= 1; send(b); };
  await assert.rejects(R.backup(link, info), /checksum/);
});
const pkg = (n) => fs.readFileSync(path.join(__dirname, "../vendor/mboot", n));
test("the real m-bootloader packages unweave and serve", async () => {
  for (const n of ["fm1-stage.fwsc", "fm1-uboot.fwsc"]) {
    const { identity, image, files } = R.unweave(pkg(n));
    assert.strictEqual(identity, "FM-1_099");
    assert.ok(files.length >= 1 && files.every((f) => f.offset + f.size <= image.length));
    // the unit side: ask for the header, then everything, then the finish address
    const u = { input: {}, got: new Uint8Array(image.length), done: false };
    const link = new R.Link(u.input, { send(b) { const p = R.parse(b); if (!p) return;
      const a = (p.body[1] | p.body[2] << 8 | p.body[3] << 16 | p.body[4] << 24) >>> 0, n2 = p.body[5] | p.body[6] << 8;
      if (a === 0xf0000000) u.done = true; else u.got.set(p.body.subarray(8), a); next(); } });
    let at = 0, last = false;
    const ask = (a, k) => setTimeout(() => u.input.onmidimessage({ data: unitSend(0x30, [0, a & 255, a >> 8 & 255, a >> 16 & 255, a >>> 24, k & 255, k >> 8, 0]) }), 0);
    const next = () => { if (at < image.length) { const k = Math.min(512, image.length - at); ask(at, k); at += k; } else if (!last) { last = true; ask(0xf0000000, 8); } };
    const sent = []; const real = link.send.bind(link);
    next();
    const served = await R.servePackage(link, image, { start: false });
    assert.ok(u.done); assert.ok(Buffer.from(u.got).equals(Buffer.from(image)));
  }
});
test("a damaged package is refused", () => {
  const raw = Buffer.from(pkg("fm1-stage.fwsc")); raw[0x2000] ^= 1;
  assert.doesNotThrow(() => R.unweave(raw)); // a flipped data byte is the unit's to catch (it checks every CRC before erasing)
  raw[5] ^= 1; // header
  assert.throws(() => R.unweave(raw));
  assert.throws(() => R.unweave(Buffer.alloc(100)));
});
test("through a running firmware the install ends when the unit stops asking", async () => {
  const { image } = R.unweave(pkg("fm1-uboot.fwsc"));
  const u = { input: {} }, got = [];
  const link = new R.Link(u.input, { send(b) { const p = R.parse(b); if (p) got.push(p); else got.push("soft" + b[4].toString(16)); } });
  setTimeout(() => u.input.onmidimessage({ data: unitSend(0x30, [0, 0, 0, 0, 0, 0, 2, 0]) }), 10);
  const served = await R.servePackage(link, image, { start: true, doneMs: 100 });
  assert.strictEqual(served, 512); assert.strictEqual(got[0].soft, 0x7f);
  await assert.rejects(R.servePackage(new R.Link({}, { send() {} }), image, { start: false, idleMs: 50 }), /stopped asking/);
});
test("a flash copy wrapped as a package unweaves back to the same flash", () => {
  const flash = new Uint8Array(0x100000).map((_, i) => (i * 13 + (i >> 11)) & 255);
  const u = R.unweave(R.wrap(flash, "FM-1_015")), f = u.files[0];
  assert.strictEqual(u.identity, "FM-1_015"); assert.strictEqual(f.type, 0);
  assert.ok(Buffer.from(u.image.subarray(f.offset, f.offset + f.size)).equals(Buffer.from(flash)));
  assert.throws(() => R.wrap(new Uint8Array(100)));
});
test("the protector is found by its identity in the boot container, and a stock flash has none", () => {
  const stock = new Uint8Array(0x100000).map((_, i) => (i * 5 + (i >> 8)) & 255);
  assert.deepStrictEqual(R.protector(stock), { installed: false });
  const plain = new Uint8Array(0x70); // the payload as the bootloader holds it: identity at 0x40
  plain.set(Buffer.from("AC79BLID"), 0x40); plain.set(Buffer.from("fm1"), 0x48); plain.set(Buffer.from("m-bootloader 2.4"), 0x50);
  const flash = new Uint8Array(0x100000).fill(0xff);
  flash.set(R.enc(0xffff, plain), 0xb0); // ENC is its own inverse: this is how it sits in the chip
  assert.deepStrictEqual(R.protector(flash), { installed: true, board: "fm1", version: "m-bootloader 2.4" });
  assert.deepStrictEqual(R.protector(new Uint8Array(10)), { installed: false });
});
test("the flash map lists the directory and which sectors hold data", () => {
  const flash = new Uint8Array(0x100000).fill(0xff);
  const rec = new Uint8Array(32).fill(0xff); // a record as the chip holds it: CRC16 of bytes 2..31 first, then ENC 0xFFFF
  rec.set([0, 0, 0xa0, 0, 0, 0], 2); rec.fill(0, 6, 16); rec.set([0x30, 0x38, 0, 0, 0], 8); rec.fill(0, 13, 16); rec.fill(0, 16, 32); rec.set(Buffer.from("uboot.boot"), 16);
  const c = R.crc16(rec.subarray(2, 32)); rec[0] = c & 255; rec[1] = c >> 8;
  flash.set(R.enc(0xffff, rec), 0x20); flash[0x5000] = 1;
  const m = R.flashMap(flash);
  assert.deepStrictEqual(m.records.map((r) => [r.name, r.addr, r.len]), [["uboot.boot", 0xa0, 0x3830]]);
  assert.strictEqual(m.sectors.length, 256); assert.strictEqual(m.sectors[0], 1); assert.strictEqual(m.sectors[5], 1); assert.strictEqual(m.sectors[1], 0);
  assert.strictEqual(m.used, 2); assert.strictEqual(m.protector.installed, false);
  assert.deepStrictEqual(R.flashMap(new Uint8Array(0x100000).fill(0xff)).records, []);
});
test("in the protector's MIDI mode the install starts with the soft message and a silent unit is never done", async () => {
  const image = new Uint8Array(1024).map((_, i) => i & 255);
  const sent = [];
  const link = new R.Link({}, { send: (b) => sent.push(Array.from(b)) });
  const t = Date.now();
  await assert.rejects(R.servePackage(link, image, { start: true, untilFinish: true, doneMs: 50, idleMs: 400 }), /stopped asking/);
  assert.deepStrictEqual(sent[0], Array.from(R.soft(R.SOFT.UPGRADE)));
  assert.ok(Date.now() - t >= 350);
});
test("a package is checked against the chip key the way the unit does, before anything is sent", () => {
  const KEY = 38927, flash = new Uint8Array(0x8000).fill(0xff);
  const raw = new Uint8Array(32).map((_, i) => i * 3 + 1); // the block at 0x4000 as the unit sees it after decrypting with the key
  const c = R.crc16(raw.subarray(2, 32)); raw[0] = c & 255; raw[1] = c >> 8;
  flash.set(R.enc(KEY, raw), 0x4000);
  const pkg = (fl) => R.unweave(R.wrap(fl, "FM-1_015"));
  assert.deepStrictEqual(R.checkPackage(pkg(flash), KEY), { size: 0x8000 });
  assert.throws(() => R.checkPackage(pkg(flash), KEY + 1), /another chip key/);
  assert.throws(() => R.checkPackage(pkg(new Uint8Array(0x4000).fill(1)), KEY), /refuses/);
  const bad = Uint8Array.from(R.wrap(flash, "FM-1_015")); const u = R.unweave(bad); bad[1024 + 0x100 + 48 * 20 + 1000] ^= 1;
  assert.throws(() => R.checkPackage(R.unweave(bad), KEY), /damaged|another chip key/);
  const stage = R.unweave(require("fs").readFileSync(__dirname + "/../vendor/mboot/fm1-stage.fwsc"));
  assert.throws(() => R.checkPackage(stage, KEY), /no flash image/);
});
