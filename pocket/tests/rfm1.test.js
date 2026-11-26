// The fast builds: worklet.js's Rfm1Proc with vendor/rfm1.js, run as the audio thread runs them, on real .rfm1 files.
//   node --test pocket/tests/rfm1.test.js                  (the files of ../fm1-firmwares, next to this repo)
//   RFM1="a.rfm1 b.rfm1" node --test pocket/tests/rfm1.test.js
// It boots each one, plays two seconds, presses a key and checks that there is a screen and a running clock (and, for the default three, sound), then turns a knob,
// sends MIDI and asks for a save. Skipped when there are no files.
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), path = require("path"), vm = require("vm");
const here = __dirname, mirror = path.join(here, "..", "..", "..", "fm1-firmwares");
const files = process.env.RFM1 ? process.env.RFM1.split(/\s+/).filter(Boolean)
  : ["nachtfahrt", "melodee", "felucca"].map((id) => path.join(mirror, id)).filter((d) => fs.existsSync(d))
      .flatMap((d) => fs.readdirSync(d).filter((n) => n.endsWith(".rfm1")).map((n) => path.join(d, n)));

// the AudioWorkletGlobalScope, as far as worklet.js uses it (no TextDecoder there, as in Chrome's)
function scope() {
  const procs = {};
  const ctx = { console, WebAssembly, BigInt, Math, Date, performance, sampleRate: 44100,
    AudioWorkletProcessor: class { constructor() { this.port = { posted: [], postMessage(m) { this.posted.push(m); } }; } },
    registerProcessor: (name, C) => (procs[name] = C) };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(here, "..", "vendor", "rfm1.js"), "utf8") + fs.readFileSync(path.join(here, "..", "vendor", "worklet.js"), "utf8"), ctx);
  return procs;
}
const quanta = (p, n) => {
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const out = [[new Float32Array(128), new Float32Array(128)]];
    p.process([], out);
    for (const v of out[0][0]) peak = Math.max(peak, Math.abs(v));
  }
  return peak;
};

test("the fast builds' processor", { skip: files.length ? false : "no .rfm1 files (put fm1-firmwares next to this repo, or set RFM1)" }, async (t) => {
  for (const file of files) {
    await t.test(path.basename(file), async () => {
      const P = scope().rfm1, p = new P(), msgs = p.port.posted;
      const bytes = fs.readFileSync(file);
      await p.message({ type: "boot", seq: 7, rfm1: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), flash: null });
      const booted = msgs.find((m) => m.type === "booted");
      assert.ok(booted, "booted: " + JSON.stringify(msgs.filter((m) => m.type === "error")));
      assert.equal(booted.seq, 7);
      await p.message({ type: "pot", value: 1023 });
      const t0 = performance.now();
      quanta(p, 690); // two seconds: the boot screen
      const took = performance.now() - t0;
      await p.message({ type: "key", id: 14 + 12, down: true }); // F4
      const peak = quanta(p, 345);
      await p.message({ type: "key", id: 14 + 12, down: false });
      const frames = msgs.filter((m) => m.type === "frame");
      assert.ok(frames.length >= 80, "about 30 frames a second: " + frames.length);
      assert.ok(frames.some((m) => m.lcd && m.lcd.length === 57600 && m.lcd.some((v) => v !== 0)), "it drew on the screen");
      assert.ok(frames[frames.length - 1].ms >= 2900, "its clock ran: " + frames[frames.length - 1].ms);
      assert.ok(!msgs.some((m) => m.type === "error"), "no error");
      // the other controls go in without trouble; MIDI as bytes, with running status
      await p.message({ type: "enc", enc: 2, clicks: 3 });
      await p.message({ type: "key", id: 8, down: true }); // HOME
      await p.message({ type: "key", id: 8, down: false });
      await p.message({ type: "midi", bytes: [0x90, 60, 100, 64, 100, 0x80, 60, 0, 64, 0] });
      quanta(p, 100);
      await p.message({ type: "snapshot", seq: 7, request: 3 });
      const snap = msgs.find((m) => m.type === "snapshot" && m.request === 3);
      assert.ok(snap && (snap.flash || snap.unavailable), "it answers a save request");
      console.log("  %s: %s, 2 s of device time in %d ms, peak %s after a key, flash %s bytes", path.basename(file), booted.rfm1.name + " " + booted.rfm1.version,
        Math.round(took), peak.toFixed(3), snap.flash ? snap.flash.length : "none");
      if (snap.flash) { // the save boots again
        const q = new P();
        await q.message({ type: "boot", seq: 8, rfm1: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), flash: snap.flash.buffer });
        assert.ok(q.port.posted.find((m) => m.type === "booted"), "it boots from its save");
      }
      // (only for the default three, synths: with RFM1, a drum machine or sequencer may well stay silent for one key)
      if (!process.env.RFM1) assert.ok(peak > 0.001, "a key makes sound: " + peak);
    });
  }
});
