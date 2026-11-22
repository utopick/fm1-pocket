// A trial (the page's ?worker=1): the emulator in a Worker instead of the audio thread. The audio thread has 2.9 ms for each
// block of 128 frames, and Chrome on Android answers every late block by calling faster than real time, so a firmware that
// needs most of a phone's core, or a stretch of JIT compiling, breaks the sound up there. Here the machine may be late for a
// while: it keeps `lead` frames queued ahead of what the reader (Fm1Reader, in worklet.js) has played, the reader only copies,
// and its count of played frames is the clock. The price is that the sound comes `lead` frames later.
// It runs worklet.js as it is (the page puts its text where the mark below is), so the page talks to this Worker through a
// port with the same messages as to the worklet's node.
var sampleRate = 44100, Machine;   // (worklet.js names its own class Fm1)
class AudioWorkletProcessor {
  constructor() {
    this.port = AudioWorkletProcessor.port;
  }
}
const registerProcessor = (name, C) => name === "fm1" && (Machine = C);
/*@FM1@*/
onmessage = ({ data: d }) => {   // once, from the page: its port for the worklet's messages, the reader's port, the lead in frames
  sampleRate = d.sampleRate;
  AudioWorkletProcessor.port = d.page;
  const proc = new Machine(), wake = new MessageChannel();
  let sent = 0, played = 0, pumping = false;
  // a turn of the event loop without a timer's wait, so that keys and the reader's count get in while it is behind
  const breathe = () => new Promise((ok) => ((wake.port1.onmessage = ok), wake.port2.postMessage(0)));
  async function pump() {
    if (pumping) return;
    pumping = true;
    for (let k = 1; sent - played < d.lead; k++) {
      const l = new Float32Array(128), r = new Float32Array(128);
      proc.process([], [[l, r]]);
      d.reader.postMessage({ l, r }, [l.buffer, r.buffer]);
      sent += 128;
      if (k % 4 === 0) await breathe();
    }
    pumping = false;
  }
  d.reader.onmessage = (e) => {   // the reader, at every block of the sound card: what it has played, and how often it ran dry
    played = e.data.played;
    proc.held = e.data.dry;       // (the frame message's `held`: here the times the queue ran dry, which are heard)
    pump();
  };
};
