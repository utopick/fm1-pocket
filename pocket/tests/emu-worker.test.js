// The ?worker=1 trial: vendor/emu-worker.js (the emulator's Worker) against the reader in vendor/worklet.js, with a machine
// that only numbers its blocks.   node --test --test-force-exit pocket/tests/emu-worker.test.js   (its ports keep node open)
const test = require("node:test"), assert = require("node:assert"), fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "../vendor", f), "utf8");
const turn = () => new Promise((ok) => setTimeout(ok, 2));   // lets the ports' messages through

test("the Worker keeps the lead, the reader plays every block once and in order, and a dry queue is one gap", async () => {
  // the reader, taken from worklet.js itself
  const classes = {}, readerEnd = new MessageChannel();
  const wl = vm.createContext({ sampleRate: 44100, performance, console, Float32Array, Uint8Array,
    AudioWorkletProcessor: class { constructor() { this.port = readerEnd.port2; } }, registerProcessor: (n, C) => (classes[n] = C) });
  vm.runInContext(read("worklet.js"), wl);
  const lead = 1024, reader = new classes["fm1-reader"]({ processorOptions: { lead } });
  // the Worker, with a machine that writes its block's number (and can be made to stall)
  let made = 0, stall = false;
  const fake = `registerProcessor("fm1", class extends AudioWorkletProcessor { process(i, o) { o[0][0].fill(tick()); return true; } });`;
  // (after worklet.js's own text, as the page puts it there: the two files must load together)
  const wk = vm.createContext({ MessageChannel, Float32Array, Promise, console, performance, tick: () => ++made });
  vm.runInContext(read("emu-worker.js").replace("/*@FM1@*/", () => read("worklet.js") + fake), wk);
  const page = new MessageChannel(), sound = new MessageChannel();
  // (a stalled machine: its blocks do not arrive)
  const real = sound.port2.postMessage.bind(sound.port2), held = [];
  sound.port2.postMessage = (m, t) => (stall ? held.push([m, t]) : real(m, t));
  wk.onmessage({ data: { page: page.port2, reader: sound.port2, lead, sampleRate: 44100 } });
  readerEnd.port1.postMessage(sound.port1, [sound.port1]);
  await turn();
  const heard = [], play = async (n) => {
    for (let k = 0; k < n; k++) {
      const l = new Float32Array(128), r = new Float32Array(128);
      reader.process([], [[l, r]]);
      heard.push(l[0]);
      await turn();
    }
  };
  await play(40);
  const first = heard.findIndex((v) => v > 0);
  assert.ok(first >= 0 && first <= 2, "the sound starts once the lead is there");
  assert.deepStrictEqual(heard.slice(first), heard.slice(first).map((_, k) => k + 1), "every block once, in order");
  assert.ok(made * 128 - reader.played <= lead + 128, `no more than the lead is made ahead (${made * 128 - reader.played})`);
  assert.ok(made * 128 - reader.played >= lead - 256, "and the lead is kept");
  assert.strictEqual(reader.dry, 0);
  // the machine stalls for longer than the lead: silence, counted once, then the sound goes on where it stopped
  stall = true;
  heard.length = 0;
  await play(20);
  assert.strictEqual(reader.dry, 1, "one gap");
  assert.strictEqual(heard[heard.length - 1], 0, "silence while dry");
  stall = false;
  for (const [m, t] of held) real(m, t);
  const before = Math.max(...heard);
  heard.length = 0;
  await play(20);
  const again = heard.filter((v) => v > 0);
  assert.strictEqual(again[0], before + 1, "it goes on with the next block");
  assert.deepStrictEqual(again, again.map((_, k) => before + 1 + k));
  assert.strictEqual(reader.dry, 1);
  for (const p of [page.port1, page.port2, sound.port1, sound.port2, readerEnd.port1, readerEnd.port2]) p.close();
});
