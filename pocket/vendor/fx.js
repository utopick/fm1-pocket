// FX engine for FM1.Pocket: the pedals, amps and cabs and the live FX pads of PLAY.Pocket (utopick/play-pocket, MIT), copied and
// adapted, not imported. Where each design comes from: PLAY.Pocket's docs/UNITS.md (written from published circuit and
// algorithm descriptions, no code taken from other effect projects). What changed here: the units are built the first time they
// are switched on (an emulator is already heavy), only the units that are on are wired in, and when none is on the page does not
// use this at all (a true bypass). pocket/src/app.html holds the screens; this file has no page code. Tested by pocket/tests/fx.py.
window.FXE = (() => {
  "use strict";
  const OPT = { os: "none" }; // PLAY's oversampling option, off (it adds delay)
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ten = (v, k) => ((10 * (v - k[2])) / (k[3] - k[2])).toFixed(1);
  const hz = (v) => v.toFixed(1) + " Hz";
  const db = (v) => (v > 0 ? "+" : "") + v.toFixed(0) + " dB";
  const msf = (v) => Math.round(v * 1000) + " ms";
  const K = {
    level: ["level", "LEVEL", 0, 1, 0.5, ten],
    tone: ["tone", "TONE", 0, 1, 0.5, ten],
    mix: (v) => ["mix", "MIX", 0, 1, v, ten],
    rate: (lo, hi, v, lab = "RATE") => ["rate", lab, lo, hi, v, hz],
    depth: (v) => ["depth", "DEPTH", 0, 1, v, ten],
  };
  // a WaveShaper curve from a function over -1..1
  function curveOf(f) {
    const n = 2048,
      c = new Float32Array(n);
    for (let i = 0; i < n; i++) c[i] = f((i * 2 - n + 1) / (n - 1));
    return c;
  }
  const softClip = (k) => curveOf((x) => Math.tanh(k * x) / Math.tanh(k));
  // shared by every shaper with a gain knob: the curve is rebuilt only when that knob moves
  const shaped = (n, s, knob, key, make) => {
    if (!knob || knob === key) n.shaper.curve = make(s[key]);
    n.shaper.oversample = OPT.os;
  };
  function reverbIR(ctx, decay) {
    const len = Math.max(1, Math.floor(ctx.sampleRate * decay)),
      b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    return b;
  }
  // ---- the units: pedals, amps and cabs. Knobs are [id, label, min, max, start, how to show the value].
  // mode "insert" replaces the sound when on; "send" adds its effect to the dry sound (at the MIX knob, or at wet if it has none).
  // build(h) makes its nodes inside a box (in, dry, wet, out); set(n, s, knob, h) puts the knobs into them.
  const PEDALS = [
    {
      id: "gate", kind: "pedal", mode: "insert", name: "NOISE GATE", col: "#5c6b73", wl: true,
      knobs: [["thr", "THRESHOLD", -80, -20, -60, db], ["rel", "RELEASE", 0.02, 0.5, 0.12, msf]],
      build: (h) => h.worklet("pp-gate"),
      set: (n, s) => n.fx?.port.postMessage({ thr: s.thr, rel: s.rel }),
    },
    {
      id: "comp", kind: "pedal", mode: "insert", name: "COMPRESSOR", col: "#c9c3b5", wl: true,
      knobs: [["sus", "SUSTAIN", 0, 1, 0.5, ten], ["att", "ATTACK", 0.001, 0.05, 0.01, msf], ["level", "LEVEL", 0, 1, 0.5, ten]],
      build: (h) => h.worklet("pp-comp"),
      set: (n, s) => n.fx?.port.postMessage({ thr: -10 - s.sus * 40, att: s.att, makeup: s.sus * 18 + (s.level - 0.5) * 24 }),
    },
    {
      id: "boost", kind: "pedal", mode: "insert", name: "BOOST", col: "#e0e0e0",
      knobs: [["gain", "GAIN", 0, 20, 8, db], ["bright", "BRIGHT", 0, 9, 3, db]],
      build: (h) => {
        const n = h.box();
        n.sh = h.bq("highshelf", 2000, null, 0);
        n.g = h.g();
        h.chain(n.in, n.sh, n.g, n.wet);
        return n;
      },
      set: (n, s, k, h) => {
        h.ramp(n.g.gain, Math.pow(10, s.gain / 20));
        h.ramp(n.sh.gain, s.bright);
      },
    },
    {
      id: "od", kind: "pedal", mode: "insert", name: "OVERDRIVE", col: "#2fb36b",
      knobs: [K.level, ["drive", "DRIVE", 0, 1, 0.5, ten], K.tone],
      // a mid-hump overdrive: lows turned down before the clipping (they would turn to mud), soft clipping, a tone control after
      build: (h) => {
        const n = h.box();
        n.hp = h.bq("lowshelf", 720, null, -12);
        n.shaper = h.ctx.createWaveShaper();
        n.tone = h.bq("lowpass", 3000);
        n.level = h.g();
        h.chain(n.in, n.hp, n.shaper, n.tone, n.level, n.wet);
        return n;
      },
      set: (n, s, k, h) => {
        shaped(n, s, k, "drive", (d) => softClip(1 + d * 40));
        h.ramp(n.tone.frequency, 800 * Math.pow(2, s.tone * 4));
        h.ramp(n.level.gain, s.level * 1.5);
      },
    },
    {
      id: "dist", kind: "pedal", mode: "insert", name: "DISTORTION", col: "#222222",
      knobs: [["dist", "DISTORTION", 0, 1, 0.6, ten], ["filter", "FILTER", 0, 1, 0.5, ten], K.level],
      // a hard-clipping distortion: big gain, clipped flat, then a lowpass FILTER (turning it up makes it darker)
      build: (h) => {
        const n = h.box();
        n.hp = h.bq("highpass", 60, 0.7);
        n.pre = h.g();
        n.shaper = h.ctx.createWaveShaper();
        n.filter = h.bq("lowpass", 5000, 0.7);
        n.level = h.g();
        n.shaper.curve = curveOf((x) => Math.max(-1, Math.min(1, x * 1.1)) * 0.8);
        h.chain(n.in, n.hp, n.pre, n.shaper, n.filter, n.level, n.wet);
        return n;
      },
      set: (n, s, k, h) => {
        n.shaper.oversample = OPT.os;
        h.ramp(n.pre.gain, 2 + Math.pow(s.dist, 2) * 200);
        h.ramp(n.filter.frequency, 12000 * Math.pow(2, -s.filter * 4.6));
        h.ramp(n.level.gain, s.level * 0.9);
      },
    },
    {
      id: "fuzz", kind: "pedal", mode: "insert", name: "FUZZ", col: "#b83a3a",
      knobs: [["fuzz", "FUZZ", 0, 1, 0.7, ten], ["vol", "VOLUME", 0, 1, 0.5, ten]],
      // a two-transistor style fuzz: very high gain, the two halves of the wave clip differently (that unevenness is its sound)
      build: (h) => {
        const n = h.box();
        n.pre = h.g();
        n.shaper = h.ctx.createWaveShaper();
        n.shaper.curve = curveOf((x) => (x > 0 ? Math.tanh(3 * x) : Math.max(-0.6, Math.tanh(5 * x))) * 0.9);
        n.lp = h.bq("lowpass", 6000, 0.7);
        n.vol = h.g();
        h.chain(n.in, n.pre, n.shaper, n.lp, n.vol, n.wet);
        return n;
      },
      set: (n, s, k, h) => {
        n.shaper.oversample = OPT.os;
        h.ramp(n.pre.gain, 3 + Math.pow(s.fuzz, 2) * 120);
        h.ramp(n.vol.gain, s.vol * 1.2);
      },
    },
    {
      id: "wah", kind: "pedal", mode: "insert", name: "AUTO-WAH", col: "#e07a1f",
      knobs: [["sens", "SENS", 0, 1, 0.6, ten], ["peak", "PEAK", 1, 12, 5, (v) => "Q " + v.toFixed(1)], K.level],
      // an envelope follower opens a bandpass: the harder you pick, the higher it sweeps
      build: (h) => {
        const n = h.box();
        n.rect = h.ctx.createWaveShaper();
        n.rect.curve = curveOf((x) => Math.abs(x));
        n.smooth = h.bq("lowpass", 8, 0.5);
        n.depth = h.g(0);
        n.bp = h.bq("bandpass", 350, 5);
        n.level = h.g();
        h.chain(n.in, n.rect, n.smooth, n.depth, n.bp.frequency);
        h.chain(n.in, n.bp, n.level, n.wet);
        return n;
      },
      set: (n, s, k, h) => {
        h.ramp(n.depth.gain, s.sens * 6000);
        h.ramp(n.bp.Q, s.peak);
        h.ramp(n.level.gain, s.level * 3);
      },
    },
    {
      id: "eq", kind: "pedal", mode: "insert", name: "EQ-5", col: "#7a8c99",
      knobs: [100, 250, 800, 2000, 5000].map((f, i) => ["b" + i, f < 1000 ? f + "" : f / 1000 + "k", -12, 12, 0, db]),
      build: (h) => {
        const n = h.box();
        n.b = [100, 250, 800, 2000, 5000].map((f) => h.bq("peaking", f, 1.1, 0));
        h.chain(n.in, ...n.b, n.wet);
        return n;
      },
      set: (n, s, k, h) => n.b.forEach((b, i) => h.ramp(b.gain, s["b" + i])),
    },
    {
      id: "cho", kind: "pedal", mode: "send", name: "CHORUS", col: "#2aa6c4",
      knobs: [K.mix(0.5), K.depth(0.5), K.rate(0.1, 5, 0.8)],
      build: (h) => {
        const n = h.box();
        n.d = h.ctx.createDelay(0.05);
        n.d.delayTime.value = 0.015;
        n.lfo = h.lfo(0.8);
        n.amt = h.g(0);
        h.chain(n.lfo, n.amt, n.d.delayTime);
        h.chain(n.in, n.d, n.wet);
        return n;
      },
      set: (n, s, k, h) => {
        h.ramp(n.lfo.frequency, s.rate);
        h.ramp(n.amt.gain, s.depth * 0.006);
      },
    },
    {
      id: "fla", kind: "pedal", mode: "send", name: "FLANGER", col: "#4f9e8f", wet: 0.7,
      knobs: [K.rate(0.05, 2, 0.25), K.depth(0.6), ["regen", "REGEN", 0, 0.9, 0.5, ten]],
      // a very short delay (1–6 ms) swept slowly, fed back into itself
      build: (h) => {
        const n = h.box();
        n.d = h.ctx.createDelay(0.02);
        n.d.delayTime.value = 0.0035;
        n.lfo = h.lfo(0.25);
        n.amt = h.g(0);
        n.fb = h.g(0);
        h.chain(n.lfo, n.amt, n.d.delayTime);
        h.chain(n.in, n.d, n.wet);
        h.chain(n.d, n.fb, n.d);
        return n;
      },
      set: (n, s, k, h) => {
        h.ramp(n.lfo.frequency, s.rate);
        h.ramp(n.amt.gain, s.depth * 0.0025);
        h.ramp(n.fb.gain, s.regen);
      },
    },
    {
      id: "pha", kind: "pedal", mode: "send", name: "PHASER", col: "#d4572a", wet: 1,
      knobs: [K.rate(0.05, 4, 0.5), K.depth(0.7)],
      // four allpass stages whose turning point is swept: mixed with the dry sound they cut moving notches
      build: (h) => {
        const n = h.box();
        n.ap = [0, 1, 2, 3].map(() => h.bq("allpass", 700, 0.7));
        n.lfo = h.lfo(0.5);
        n.amt = h.g(0);
        n.lfo.connect(n.amt);
        n.ap.forEach((a) => n.amt.connect(a.frequency));
        h.chain(n.in, ...n.ap, n.wet);
        return n;
      },
      set: (n, s, k, h) => {
        h.ramp(n.lfo.frequency, s.rate);
        h.ramp(n.amt.gain, s.depth * 600);
      },
    },
    {
      id: "trem", kind: "pedal", mode: "insert", name: "TREMOLO", col: "#d8a31a",
      knobs: [K.depth(0.6), K.rate(1, 12, 5, "SPEED")],
      build: (h) => {
        const n = h.box();
        n.vca = h.g(1);
        n.lfo = h.lfo(5);
        n.amt = h.g(0);
        h.chain(n.lfo, n.amt, n.vca.gain);
        h.chain(n.in, n.vca, n.wet);
        return n;
      },
      set: (n, s, k, h) => {
        // the volume swings between 1 and 1 - depth
        h.ramp(n.vca.gain, 1 - s.depth / 2);
        h.ramp(n.amt.gain, s.on ? s.depth / 2 : 0);
        h.ramp(n.lfo.frequency, s.rate);
      },
    },
    {
      id: "vib", kind: "pedal", mode: "insert", name: "VIBRATO", col: "#7d5fb2",
      knobs: [K.rate(1, 10, 5, "SPEED"), K.depth(0.4)],
      // the pitch wobble of a moving delay, with no dry sound
      build: (h) => {
        const n = h.box();
        n.d = h.ctx.createDelay(0.02);
        n.d.delayTime.value = 0.006;
        n.lfo = h.lfo(5);
        n.amt = h.g(0);
        h.chain(n.lfo, n.amt, n.d.delayTime);
        h.chain(n.in, n.d, n.wet);
        return n;
      },
      set: (n, s, k, h) => {
        h.ramp(n.lfo.frequency, s.rate);
        h.ramp(n.amt.gain, s.depth * 0.004);
      },
    },
    {
      id: "dly", kind: "pedal", mode: "send", name: "DELAY", col: "#3a7bd5",
      knobs: [K.mix(0.35), ["fb", "REPEATS", 0, 0.9, 0.35, ten], ["time", "TIME", 0.05, 0.9, 0.35, msf]],
      build: (h) => {
        const n = h.box();
        n.d = h.ctx.createDelay(1);
        n.fb = h.g();
        h.chain(n.in, n.d, n.wet);
        h.chain(n.d, n.fb, n.d);
        return n;
      },
      set: (n, s, k, h) => {
        h.ramp(n.d.delayTime, s.time);
        h.ramp(n.fb.gain, s.fb);
      },
    },
    {
      id: "rev", kind: "pedal", mode: "send", name: "PLATE REVERB", col: "#8e5bd6",
      knobs: [K.mix(0.3), ["decay", "DECAY", 0.3, 5, 1.8, (v) => v.toFixed(1) + " s"], K.tone],
      // a convolution with a decaying noise burst, darkened by its tone
      build: (h) => {
        const n = h.box();
        n.conv = h.ctx.createConvolver();
        n.tone = h.bq("lowpass", 4000);
        h.chain(n.in, n.conv, n.tone, n.wet);
        return n;
      },
      set: (n, s, k, h) => {
        if (!k) n.conv.buffer = reverbIR(h.ctx, s.decay); // DECAY rebuilds it when the knob is let go
        h.ramp(n.tone.frequency, 1500 * Math.pow(2, s.tone * 3));
      },
    },
    {
      id: "room", kind: "pedal", mode: "send", name: "ROOM REVERB", col: "#5b6fd6", wl: true,
      knobs: [K.mix(0.3), ["size", "SIZE", 0, 1, 0.6, ten], ["damp", "DAMP", 0, 1, 0.5, ten]],
      build: (h) => h.worklet("pp-room"),
      set: (n, s) => n.fx?.port.postMessage({ size: s.size, damp: s.damp }),
    },
  ];
  // amps: one recipe, four voicings. pre: gain range; hp: low cut before the clipping; curve: the clipping (stages > 1
  // clips twice, with a low cut between, for high gain); the tone stack: bass shelf, a mid band at mid Hz, treble shelf.
  const AMPK = [["gain", "GAIN", 0, 1, 0.45, ten], ["bass", "BASS", -12, 12, 2, db], ["mid", "MID", -12, 12, 0, db], ["treble", "TREBLE", -12, 12, 3, db], ["master", "MASTER", 0, 1, 0.5, ten]];
  const ampDef = (id, name, v) => ({
    id, kind: "amp", mode: "insert", name, knobs: AMPK.map((k) => (v.start?.[k[0]] != null ? [...k.slice(0, 4), v.start[k[0]], k[5]] : k)),
    build: (h) => {
      const n = h.box();
      n.pre = h.g();
      n.hp = h.bq("highpass", v.hp, 0.7);
      n.shaper = h.ctx.createWaveShaper();
      n.shaper.curve = v.curve;
      const parts = [n.in, n.pre, n.hp, n.shaper];
      if (v.stages > 1) {
        n.g2 = h.g(v.g2);
        n.hp2 = h.bq("highpass", 400, 0.7);
        n.sh2 = h.ctx.createWaveShaper();
        n.sh2.curve = v.curve;
        parts.push(n.hp2, n.g2, n.sh2);
      }
      n.bass = h.bq("lowshelf", v.bass || 120);
      n.mid = h.bq("peaking", v.mid, v.midQ || 0.8, v.midCut || 0);
      n.midK = h.bq("peaking", v.mid, v.midQ || 0.8);
      n.treble = h.bq("highshelf", v.treble || 3000);
      n.master = h.g();
      h.chain(...parts, n.bass, n.mid, n.midK, n.treble, n.master, n.wet);
      return n;
    },
    set: (n, s, k, h) => {
      n.shaper.oversample = OPT.os;
      if (n.sh2) n.sh2.oversample = OPT.os;
      h.ramp(n.pre.gain, v.pre[0] + Math.pow(s.gain, 2) * v.pre[1]);
      h.ramp(n.bass.gain, s.bass);
      h.ramp(n.midK.gain, s.mid);
      h.ramp(n.treble.gain, s.treble);
      h.ramp(n.master.gain, s.master * v.out);
    },
  });
  const AMPS = [
    // ids kept from the first prototype ("amp", "cab") so saved boards keep loading
    ampDef("amp", "CRUNCH 50", { pre: [0.6, 30], hp: 90, mid: 700, curve: curveOf((x) => (x >= 0 ? Math.tanh(2.2 * x) : Math.tanh(1.6 * x) / 0.92) / Math.tanh(2.2)), out: 0.9 }),
    ampDef("clean", "CLEAN 65", { pre: [0.5, 6], hp: 70, mid: 450, midQ: 0.7, midCut: -5, treble: 2500, curve: softClip(1.2), out: 1.5, start: { gain: 0.3, bass: 3, treble: 4 } }),
    ampDef("chime", "CHIME 30", { pre: [0.7, 20], hp: 110, mid: 1200, midQ: 0.9, treble: 3500, curve: curveOf((x) => Math.tanh(1.8 * x + 0.15) - Math.tanh(0.15)), out: 1, start: { gain: 0.5, bass: 0, mid: 3, treble: 2 } }),
    ampDef("lead", "HIGH GAIN 100", { pre: [2, 60], hp: 150, mid: 500, midQ: 0.7, midCut: -4, stages: 2, g2: 6, curve: softClip(3), out: 0.6, start: { gain: 0.6, bass: 3, mid: -2, treble: 4, master: 0.4 } }),
  ];
  // cabs: filters, not recorded impulses (so no extra delay): the speaker's low cut, the box's low resonance, its
  // presence bump, and two lowpasses for where the speaker stops (BRIGHT moves them)
  const CABK = [["low", "LOW", -6, 9, 3, db], ["bright", "BRIGHT", 0, 1, 0.5, ten], ["level", "LEVEL", 0, 1, 0.7, ten]];
  const cabDef = (id, name, v) => ({
    id, kind: "cab", mode: "insert", name, knobs: CABK,
    build: (h) => {
      const n = h.box();
      n.hp = h.bq("highpass", v.hp, 0.8);
      n.low = h.bq("peaking", v.res, 1.2);
      n.pres = h.bq("peaking", v.pres[0], 1.4, v.pres[1]);
      n.notch = h.bq("peaking", v.notch || 1500, 2, v.notch ? -3 : 0);
      n.lp1 = h.bq("lowpass", 5000, 0.7);
      n.lp2 = h.bq("lowpass", 5000, 0.9);
      n.level = h.g();
      h.chain(n.in, n.hp, n.low, n.pres, n.notch, n.lp1, n.lp2, n.level, n.wet);
      return n;
    },
    set: (n, s, k, h) => {
      h.ramp(n.low.gain, s.low);
      const f = v.top * Math.pow(2, (s.bright - 0.5) * 1.5);
      h.ramp(n.lp1.frequency, f);
      h.ramp(n.lp2.frequency, f);
      h.ramp(n.level.gain, s.level * 1.6);
    },
  });
  const CABS = [
    cabDef("cab", "1×12 OPEN BACK", { hp: 75, res: 110, pres: [2500, 3], top: 5000 }),
    cabDef("c210", "1×10 TWEED", { hp: 110, res: 140, pres: [2000, 4], top: 4500 }),
    cabDef("c212", "2×12 CLOSED", { hp: 70, res: 100, pres: [2200, 2], notch: 1200, top: 4800 }),
    cabDef("c412", "4×12 BRITISH", { hp: 65, res: 90, pres: [2800, 5], notch: 1500, top: 4200 }),
  ];

  const FX = [...PEDALS, ...AMPS, ...CABS];
  const FXI = Object.fromEntries(FX.map((p) => [p.id, p]));
  // the signal order the units start in: dynamics, drive, EQ, amp, cab, then modulation, delay and reverb (PLAY's own default board was shorter)
  const ORDER0 = [...PEDALS.slice(0, 8), ...AMPS, ...CABS, ...PEDALS.slice(8)].map((p) => p.id);
  // the live FX pads: effects on the whole sound, to latch or hold (PLAY.Pocket's mixer FX PADS)
  const LIVE = [
    ["lofi", "LO-FI", "crushed"], ["tape", "TAPE", "wobble"], ["radio", "RADIO", "AM band"], ["tele", "PHONE", "narrow"],
    ["water", "UNDERWATER", "muffled"], ["stut", "STUTTER", "16th chop"], ["lp", "LOW PASS", "dark"], ["hp", "HIGH PASS", "thin"],
    ["echo", "ECHO", "throw"], ["verb", "REVERB", "wash"], ["robot", "ROBOT", "ring mod"], ["crunch", "CRUNCH", "whole mix"],
  ];
  const SENDS = new Set(["echo", "verb"]); // these add to the dry sound; the others replace it
  const defaults = () => ({ order: ORDER0.slice(), latch: true, u: Object.fromEntries(FX.map((p) => [p.id, Object.fromEntries([["on", false], ...p.knobs.map((k) => [k[0], k[4]])])])) });
  // saved and imported settings are untrusted: keep only known units and knobs, clamp every value
  function vet(o) {
    const d = defaults();
    if (!o || typeof o !== "object") return d;
    if (Array.isArray(o.order)) {
      const seen = new Set(),
        got = o.order.filter((id) => typeof id === "string" && FXI[id] && !seen.has(id) && seen.add(id));
      d.order = [...got, ...ORDER0.filter((id) => !seen.has(id))];
    }
    d.latch = o.latch !== false;
    for (const p of FX) {
      const s = o.u && typeof o.u === "object" ? o.u[p.id] : null;
      if (!s || typeof s !== "object") continue;
      d.u[p.id].on = s.on === true;
      for (const k of p.knobs) if (typeof s[k[0]] !== "boolean" && Number.isFinite(+s[k[0]])) d.u[p.id][k[0]] = clamp(+s[k[0]], k[2], k[3]);
    }
    return d;
  }
  // the worklets: the units that need sample-by-sample code
  const WORKLET_JS = `
  // a parameter holder: knob values arrive as messages
  class Unit extends AudioWorkletProcessor {
    constructor() { super(); this.p = {}; this.port.onmessage = (e) => Object.assign(this.p, e.data); }
  }
  // noise gate: opens fast above the threshold, closes over RELEASE below it (6 dB lower, so it does not chatter)
  class Gate extends Unit {
    constructor() { super(); this.env = 0; this.g = 0; this.p = { thr: -60, rel: 0.12 }; }
    process(ins, outs) {
      const x = ins[0][0], y = outs[0][0];
      if (!x) return true;
      const open = Math.pow(10, this.p.thr / 20), close = open / 2, rel = Math.exp(-1 / (this.p.rel * sampleRate)), att = Math.exp(-1 / (0.001 * sampleRate));
      for (let i = 0; i < x.length; i++) {
        const a = Math.abs(x[i]);
        this.env = Math.max(a, this.env * 0.9995);
        const target = this.env > open ? 1 : this.env < close ? 0 : this.g > 0.5 ? 1 : 0;
        this.g = target > this.g ? target + (this.g - target) * att : target + (this.g - target) * rel;
        y[i] = x[i] * this.g;
      }
      return true;
    }
  }
  registerProcessor("pp-gate", Gate);
  // compressor: feed-forward, level detected in dB with attack and release, ratio 4:1, soft knee, no look-ahead
  class Comp extends Unit {
    constructor() { super(); this.y = 0; this.p = { thr: -30, att: 0.01, makeup: 9 }; }
    process(ins, outs) {
      const x = ins[0][0], o = outs[0][0];
      if (!x) return true;
      const T = this.p.thr, R = 4, W = 6, a = Math.exp(-1 / (this.p.att * sampleRate)), r = Math.exp(-1 / (0.15 * sampleRate)), mk = this.p.makeup;
      for (let i = 0; i < x.length; i++) {
        const xd = 20 * Math.log10(Math.abs(x[i]) + 1e-9);
        let yd = xd;
        if (2 * (xd - T) > W) yd = T + (xd - T) / R;
        else if (2 * Math.abs(xd - T) <= W) yd = xd + ((1 / R - 1) * (xd - T + W / 2) ** 2) / (2 * W);
        const cut = xd - yd;
        this.y = cut > this.y ? a * this.y + (1 - a) * cut : r * this.y + (1 - r) * cut;
        o[i] = x[i] * Math.pow(10, (mk - this.y) / 20);
      }
      return true;
    }
  }
  registerProcessor("pp-comp", Comp);
  // room reverb: Freeverb (Jezar at Dreampoint, public domain): 8 damped feedback combs in parallel, then 4 allpasses
  class Room extends Unit {
    constructor() {
      super();
      const s = sampleRate / 44100;
      this.c = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((n) => ({ b: new Float32Array(Math.round(n * s)), i: 0, f: 0 }));
      this.a = [556, 441, 341, 225].map((n) => ({ b: new Float32Array(Math.round(n * s)), i: 0 }));
      this.p = { size: 0.6, damp: 0.5 };
    }
    process(ins, outs) {
      const x = ins[0][0], o = outs[0][0];
      if (!x) return true;
      const fb = 0.7 + this.p.size * 0.28, d = this.p.damp * 0.4;
      for (let i = 0; i < x.length; i++) {
        const inp = x[i] * 0.015;
        let out = 0;
        for (const c of this.c) {
          const y = c.b[c.i];
          c.f = y * (1 - d) + c.f * d;
          c.b[c.i] = inp + c.f * fb;
          if (++c.i >= c.b.length) c.i = 0;
          out += y;
        }
        for (const a of this.a) {
          const y = a.b[a.i];
          a.b[a.i] = out + y * 0.5;
          out = y - out;
          if (++a.i >= a.b.length) a.i = 0;
        }
        o[i] = out;
      }
      return true;
    }
  }
  registerProcessor("pp-room", Room);`;
  async function load(ctx) {
    if (!ctx.audioWorklet) return false;
    const url = URL.createObjectURL(new Blob([WORKLET_JS], { type: "text/javascript" }));
    try {
      await ctx.audioWorklet.addModule(url);
      return true;
    } catch {
      return false;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  // the helpers the units build with
  function helpers(ctx, wl) {
    const h = { ctx, ramp: (p, v) => p.setTargetAtTime(v, ctx.currentTime, 0.02) };
    h.g = (v = 1) => {
      const n = ctx.createGain();
      n.gain.value = v;
      return n;
    };
    h.bq = (type, f, q, gain) => {
      const n = ctx.createBiquadFilter();
      n.type = type;
      n.frequency.value = f;
      if (q != null) n.Q.value = q;
      if (gain != null) n.gain.value = gain;
      return n;
    };
    h.lfo = (rate) => {
      const o = ctx.createOscillator();
      o.frequency.value = rate;
      o.start();
      return o;
    };
    h.chain = (...ns) => ns.reduce((a, b) => (a.connect(b), b));
    // a unit: in -> dry -> out, and in -> (its effect) -> wet -> out
    h.box = () => {
      const x = { in: h.g(), out: h.g(), dry: h.g(), wet: h.g(0) };
      h.chain(x.in, x.dry, x.out);
      x.wet.connect(x.out);
      return x;
    };
    // a unit made of one worklet; without worklets (very old browsers) it just passes the sound
    h.worklet = (name) => {
      const n = h.box();
      if (wl) {
        n.fx = new AudioWorkletNode(ctx, name, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: "explicit" });
        h.chain(n.in, n.fx, n.wet);
      }
      return n;
    };
    return h;
  }
  // the live FX, one box each (PLAY.Pocket's mfxBuild, one at a time)
  function liveBox(h, id) {
    const c = h.ctx,
      x = h.box(),
      shape = (f) => {
        const w = c.createWaveShaper();
        w.curve = curveOf(f);
        return w;
      };
    switch (id) {
      case "lofi": h.chain(x.in, shape((v) => Math.round(v * 14) / 14), h.bq("lowpass", 3200, 0.7), h.bq("highpass", 120, 0.7), x.wet); break;
      case "tape": {
        const d = c.createDelay(0.1),
          l1 = h.lfo(0.7),
          l2 = h.lfo(6.5);
        d.delayTime.value = 0.015;
        l1.connect(h.g(0.004)).connect(d.delayTime); // wow: a slow wobble of the pitch
        l2.connect(h.g(0.0007)).connect(d.delayTime); // flutter: a fast, small one
        h.chain(x.in, d, h.bq("lowpass", 5200, 0.7), shape((v) => Math.tanh(1.6 * v)), x.wet);
        break;
      }
      case "radio": h.chain(x.in, h.bq("highpass", 450, 0.8), h.bq("lowpass", 3400, 0.8), shape((v) => Math.tanh(3 * v) * 0.8), x.wet); break;
      case "tele": h.chain(x.in, h.bq("highpass", 400, 1), h.bq("highpass", 400, 1), h.bq("lowpass", 2800, 1), h.bq("lowpass", 2800, 1), x.wet); break;
      case "water": {
        const f = h.bq("lowpass", 350, 7),
          l = h.lfo(0.35);
        l.connect(h.g(170)).connect(f.frequency);
        h.chain(x.in, f, x.wet);
        break;
      }
      case "stut": {
        const gate = h.g(0.5),
          o = c.createOscillator();
        o.type = "square";
        o.frequency.value = 8; // sixteenth notes at 120 BPM
        o.start();
        o.connect(h.g(0.5)).connect(gate.gain);
        h.chain(x.in, gate, x.wet);
        break;
      }
      case "lp": h.chain(x.in, h.bq("lowpass", 500, 1), x.wet); break;
      case "hp": h.chain(x.in, h.bq("highpass", 1200, 0.8), x.wet); break;
      case "echo": {
        const d = c.createDelay(2),
          fb = h.g(0.45);
        d.delayTime.value = 0.375;
        x.in.connect(d);
        d.connect(x.wet);
        h.chain(d, h.bq("lowpass", 3000, 0.7), fb).connect(d);
        break;
      }
      case "verb": {
        const cv = c.createConvolver(),
          n = Math.round(c.sampleRate * 1.8),
          ir = c.createBuffer(2, n, c.sampleRate);
        for (let ch = 0; ch < 2; ch++) {
          const d = ir.getChannelData(ch);
          for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2.6);
        }
        cv.buffer = ir;
        h.chain(x.in, cv, h.g(0.5), x.wet);
        break;
      }
      case "robot": {
        const g = h.g(0),
          o = h.lfo(70);
        o.connect(g.gain);
        h.chain(x.in, g, h.g(1.6), x.wet);
        break;
      }
      case "crunch": h.chain(x.in, h.g(3), shape((v) => Math.tanh(6 * v) * 0.7), h.bq("lowpass", 5000, 0.7), x.wet); break;
    }
    return x;
  }
  // The engine: in -> the units that are on, in order -> the live FX that are on -> a soft limiter (a curve, not a compressor: no
  // look-ahead delay) -> out. Units are built when first switched on, and only the ones that are on are wired in.
  function build(ctx, wl) {
    const h = helpers(ctx, wl),
      E = { h, in: h.g(), out: h.g(), u: {}, live: {}, key: "", linked: [], chain: [] },
      half = h.g(0.5),
      safe = ctx.createWaveShaper();
    safe.curve = curveOf((x) => Math.tanh(2 * x));
    h.chain(half, safe, E.out);
    // sets a unit's switch and knobs into its nodes; knob: the one being turned (the reverb's tail is rebuilt only when it is let go)
    E.apply = (rack, id, knob) => {
      const p = FXI[id],
        s = rack.u[id],
        n = E.u[id];
      if (!n) return;
      const g = (param, v) => (n.fresh ? (param.value = v) : h.ramp(param, v));
      if (p.mode === "insert") (g(n.dry.gain, s.on ? 0 : 1), g(n.wet.gain, s.on ? 1 : 0));
      else g(n.wet.gain, s.on ? (s.mix ?? p.wet ?? 1) : 0);
      p.set(n, s, knob, h);
    };
    // makes the graph match the rack's units and the live pads that are on; returns true when anything is on (false: the page bypasses it all)
    E.sync = (rack, live) => {
      const ids = rack.order.filter((id) => rack.u[id].on),
        lv = LIVE.map((l) => l[0]).filter((id) => live.has(id)),
        key = ids.join() + "|" + lv.join();
      for (const id of ids) E.u[id] ||= Object.assign(FXI[id].build(h), { fresh: true });
      for (const id of lv) E.live[id] ||= Object.assign(liveBox(h, id), { fresh: true });
      if (key !== E.key) {
        E.in.disconnect();
        E.linked.forEach((n) => n.disconnect());
        let prev = E.in;
        E.linked = [];
        const boxes = [...ids.map((id) => E.u[id]), ...lv.map((id) => E.live[id])];
        for (const b of boxes) (prev.connect(b.in), (prev = b.out), E.linked.push(b.out));
        prev.connect(half);
        E.key = key;
        E.chain = [...ids, ...lv];
      }
      for (const id of ids) E.apply(rack, id);
      for (const id of lv) E.applyLive(id, true);
      for (const id of [...ids, ...lv]) (E.u[id] || E.live[id]).fresh = false;
      for (const id of Object.keys(E.live)) if (!live.has(id)) E.applyLive(id, false);
      return ids.length + lv.length > 0;
    };
    E.applyLive = (id, on) => {
      const x = E.live[id];
      if (!x) return;
      const g = (param, v) => (x.fresh ? (param.value = v) : h.ramp(param, v));
      if (SENDS.has(id)) g(x.wet.gain, on ? 0.8 : 0);
      else (g(x.dry.gain, on ? 0 : 1), g(x.wet.gain, on ? 1 : 0));
    };
    return E;
  }
  return { FX, FXI, PEDALS, AMPS, CABS, LIVE, ORDER0, defaults, vet, load, build };
})();
