// SPDX-License-Identifier: GPL-3.0-only
// Tether on the host (tests/host.c): the panel -> exact MIDI bytes, LEDS -> the LEDs, SCREEN -> the screen equals the
// emulator's frame (a real UI, text, noise, a few tiles), and a dropped message. The frames are encoded by the page's
// own encoder (pocket/vendor/tether.js, MIT, written from PROTOCOL.md): the two sides checked against each other.
//   node --test tests/tether_test.js        (from pocket/firmware; needs cc)
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const T = require("../../vendor/tether.js"), { frames } = require("../../tests/tether-frames.js");

const ROOT = path.join(__dirname, ".."), OUT = path.join(ROOT, "build/host/tether-test");
fs.mkdirSync(OUT, { recursive: true });
const BIN = path.join(OUT, "tether");
execFileSync("cc", ["-O2", "-Wall", "-Wno-unused-function", "-DDINGHY_HOST", ...(process.platform === "darwin" ? ["-Dsection(x)=used"] : []),
  '-DAPP_VER="0.1"', "-Ifirmware/hal", "-Ifirmware/src", "-Ifirmware/gen", "-o", BIN, "firmware/src/tether.c"], { cwd: ROOT, stdio: "inherit" });

// run a script (lines "T what ..."); sysex: {T: [messages]} written to files -> stdout lines
function run(name, lines, sysex = {}) {
  for (const [t, msgs] of Object.entries(sysex)) {
    const f = path.join(OUT, `${name}-${t}.syx`);
    fs.writeFileSync(f, Buffer.concat(msgs.map((m) => Buffer.from(m))));
    lines.push(`${t} sysex ${f}`);
  }
  lines.sort((a, b) => parseInt(a) - parseInt(b));
  fs.writeFileSync(path.join(OUT, name + ".txt"), lines.join("\n") + "\n");
  return execFileSync(BIN, [path.join(OUT, name), path.join(OUT, name + ".txt")], { encoding: "utf8" }).split("\n");
}
const midi = (out) => out.filter((l) => /MIDI out|SYSEX out|LEDS/.test(l)).map((l) => l.trim().replace(/\s+/g, " "));
const hex = (m) => [...m].map((x) => x.toString(16).toUpperCase().padStart(2, "0")).join(" ");
function shot(name, t) { // host.c's PPM -> RGB565 is lossy: compare in its 8-bit form
  return fs.readFileSync(path.join(OUT, `${name}-${t}.ppm`)).subarray(15);
}
function ppm(f) {
  const o = Buffer.alloc(57600 * 3);
  for (let i = 0; i < 57600; i++) {
    const c = f[i];
    o[3 * i] = Math.floor(((c >> 11) * 255) / 31); o[3 * i + 1] = Math.floor((((c >> 5) & 63) * 255) / 63); o[3 * i + 2] = Math.floor(((c & 31) * 255) / 31);
  }
  return o;
}

test("the panel goes out as exact MIDI bytes; HELLO is answered, MASTER sent again", () => {
  const out = midi(run("panel", ["10 keys 0x1", "20 keys 0x4000001", "30 keys 0", "40 btn 12", "50 btndown 0", "60 btnup 0",
    "70 enc 2 3", "80 enc 6 -70", "90 master 515", "100 master 700", "110 master 1023", "200 end"], { 0: [T.ping()], 150: [T.hello()] }));
  assert.deepStrictEqual(out, [
    "1 ms MIDI out BF 27 64", // MASTER at power-on (512 / 8)
    "10 ms MIDI out 90 53 100", "20 ms MIDI out 90 79 100", "30 ms MIDI out 80 53 0", "30 ms MIDI out 80 79 0",
    "40 ms MIDI out 9F 12 127", "41 ms MIDI out 8F 12 0", "50 ms MIDI out 9F 0 127", "60 ms MIDI out 8F 0 0",
    "70 ms MIDI out BF 22 67", "80 ms MIDI out BF 26 1", "80 ms MIDI out BF 26 57", // -70 = -63, -7
    "100 ms MIDI out BF 27 87", "110 ms MIDI out BF 27 127", // 515: jitter, not sent
    "150 ms SYSEX out " + hex(T.message(0x41, [2, 0, 27, 14, 7, 1, ...Buffer.from("TETHER 0.1")])), "150 ms MIDI out BF 27 127"]); // protocol 2, CA 1: the USB speaker
  const h = T.parse(T.message(0x41, [2, 0, 27, 14, 7, 1, ...Buffer.from("TETHER 0.1")]));
  assert.deepStrictEqual([h.name, h.proto, h.audioOut], ["TETHER 0.1", 2, true]);
});

test("without a page the unit is a plain MIDI controller; a page takes it over, and 3 s of silence gives it back", () => {
  const out = midi(run("ctl", ["10 keys 0x1", "20 keys 0", "30 btn 1", "40 keys 0x1", "50 keys 0", "60 btn 12", "70 btn 0", "80 enc 2 3", "90 enc 5 -2",
    "100 enc 2 100", "110 master 700", "200 keys 0x1", "3400 end"], { 150: [T.ping()] }));
  assert.deepStrictEqual(out, [
    "1 ms MIDI out B0 7 64",                                   // MASTER first, as CC 7 on channel 1
    "10 ms MIDI out 90 53 100", "20 ms MIDI out 80 53 0",      // keys: channel 1, F3 = 53
    "40 ms MIDI out 90 65 100", "50 ms MIDI out 80 65 0",      // after OCT+ (30): an octave up
    "60 ms MIDI out 99 46 100", "61 ms MIDI out 89 46 0",      // PLAY (button 12) is pad 10: note 46, channel 10
    "80 ms MIDI out B0 70 70",                                 // K1 = CC 70: 64 + 3 detents x 2
    "90 ms MIDI out B0 73 60",                                 // K4 = CC 73: 64 - 2 x 2
    "100 ms MIDI out B0 70 127",                               // clamped at 127
    "110 ms MIDI out B0 7 87",                                 // MASTER
    "150 ms MIDI out BF 27 87",                                 // the page's PING: linked, MASTER sent again, now as CC 27 (channel 16)
    "200 ms MIDI out 90 53 100",                               // linked: the panel as PROTOCOL.md says (no octave shift)
    "3151 ms MIDI out 80 53 0", "3151 ms MIDI out 90 53 100", "3151 ms MIDI out B0 7 87"]);  // 3 s without the page: a controller again; the held key is let go and pressed again (OCT- at 70 ms put the octave back to 0)
});

test("LEDS sets the lit and dim LEDs by id", () => {
  const out = midi(run("leds", ["100 leds", "200 leds", "300 end"], { 0: [T.ping()], 50: [T.leds([0, 12, 14, 40])], 150: [T.leds([1], [2, 1])] }));
  assert.deepStrictEqual(out.slice(1), ["100 ms LEDS 10000005001 00000000000", "200 ms LEDS 00000000002 00000000004"]);
});

test("SCREEN: the unit's screen equals each frame; a dropped message is never shown and asks for a keyframe", () => {
  const F = frames(), enc = new T.Encoder(), sx = {}, want = {};
  let t = 100;
  const sendAt = (msgs, label) => { sx[t] = msgs; t += msgs.length + 20; want[t] = label; const at = t; t += 10; return at; };
  enc.encode(F.black, { key: true }); // the page's state starts at black; the unit's first frame must be a key
  enc.needKey();
  sendAt(enc.encode(F.ui), "ui");
  sendAt(enc.encode(F.scope), "scope");
  sendAt(enc.encode(F.text), "text");
  sendAt(enc.encode(F.dark), "dark");
  const noise = enc.encode(F.noise), dropFrom = t;
  const dropAt = sendAt(noise.filter((_, i) => i !== 3), "dark"); // message 3 lost: the screen keeps "dark"
  enc.needKey();
  sendAt(enc.encode(F.noise), "noise");
  sendAt(enc.encode(F.ui), "ui");
  const lines = Object.keys(want).map((k) => `${k} shot`);
  const out = run("screen", [...lines, `${t + 10} end`], sx);
  for (const [at, label] of Object.entries(want))
    assert.ok(shot("screen", at).equals(ppm(F[label])), `screen at ${at} ms is "${label}"`);
  const replies = midi(out).filter((l) => l.includes("SYSEX")).map((l) => ({ ms: parseInt(l), ...T.parse(Buffer.from(l.split("SYSEX out ")[1].split(" ").map((h) => parseInt(h, 16)))) }));
  assert.deepStrictEqual(replies.map((r) => r.type), ["ack", "ack", "ack", "ack", "needkey", "ack", "ack"]);
  assert.strictEqual(replies[4].ms, dropFrom + 3, "NEED KEY as soon as the message after the lost one comes");
});
