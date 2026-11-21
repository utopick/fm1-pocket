// Core 1's thread (threaded build only, see web/build-threads.sh): a second instance of the emulator module on the
// audio thread's shared memory. The audio thread's instance has set up this one's stack and thread-local block
// inside that memory and hands over their addresses (an AudioWorklet cannot start a Worker, so the page does).
// Its WebAssembly JIT is its own: a table of functions belongs to one instance, so each thread compiles for itself
// (the helper below is the one in worklet.js).
onmessage = async ({ data: d }) => {
  let x;
  try {
    let next, regions = 0, failed = 0;
    const env = {
      memory: d.memory,
      fm1_now_us: () => performance.now() * 1000,
      fm1_core1_spawn() {},               // (only the audio thread's machine asks)
      fm1_jit_compile(ptr, len, hRead, hWrite, hOp) {
        try {
          const table = x.__indirect_function_table;
          const bytes = new Uint8Array(d.memory.buffer, ptr, len).slice();
          const run = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory: d.memory, h_read: table.get(hRead), h_write: table.get(hWrite), h_op: table.get(hOp) } }).exports.run;
          if (next === undefined || next >= table.length) { next = table.length; table.grow(256); }
          table.set(next, run);
          if (++regions % 4 === 1) postMessage({ type: "jit", regions, failed });   // (this thread has no timer: it tells as it compiles)
          return next++;
        } catch { postMessage({ type: "jit", regions, failed: ++failed }); return 0; }
      },
    };
    x = (await WebAssembly.instantiate(d.wasm, { env })).instance.exports;
    x.__stack_pointer.value = d.sp;   // not the audio thread's stack
    x.__wasm_init_tls(d.tls);
    postMessage({ type: "up" });
    x.fm1_core1_run(d.ptr);           // core 1's thread: returns when the machine is dropped
  } catch (err) {
    postMessage({ type: "error", message: String(err) });
  }
};
