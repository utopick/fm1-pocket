# fm1-android

This crate is the emulator side of the FM1.Pocket Android app. In the browser the emulator runs as WebAssembly inside an AudioWorklet (`pocket/vendor/worklet.js`). In the app the same Rust core runs natively, with its AArch64 JIT, and the page talks to it through a small bridge instead of the worklet. It builds `libfm1_android.so` and sits outside the root workspace, so nothing in `crates/*` changes.

## How it maps to worklet.js

`src/host.rs` is `worklet.js` rewritten in Rust over fm1-web's `fm1_*` functions, with no JNI in it. `Host::post` and `Host::boot` take the messages the page used to send to the worklet, `Host::render` is `process` (128-frame quanta, the same 20 ms boot budget and 1.5 quanta play budget, the same `fm1_ahead`, flash-change and snapshot handling, and the same frame report with `busy`, `worst`, `emulated`, `idle`, `starved`, `quanta` and `frames`). Frames also carry `peak`, the largest absolute sample since the last frame. `Host::poll` encodes what the worklet used to post back: a little-endian `u32` message count, then for each message its JSON and its typed-array blobs (name, constructor name, bytes). Only the newest `frame` stays queued, every other message keeps its order.

`src/lib.rs` holds the one global `Mutex` that every entry point takes for its whole call, because fm1-web keeps its state in globals, and the JNI functions for class `io.github.utopick.fm1pocket.Native`: `post`, `boot`, `render`, `poll` and `version`. They only convert Java values and call the host. `src/json.rs` is a small JSON reader and writer, so the crate needs no dependency besides `jni-sys`.

The wasm-only parts of the worklet are gone: there is no module compiling and no JIT import table. `fm1_jit(1, 16)` is still called, and natively it switches on the native JIT. The `jit` field of a frame is a fixed all-zero stats object.

## Testing

`tests/host.rs` boots a firmware package, presses PLAY at 2 s of emulated time, renders 15 emulated seconds through the same `Host::render` the audio thread uses, and checks that a `booted` message arrives, that the LCD is not blank and that the sound is not silent. It prints the CPU time spent rendering. It needs a package, so it is skipped unless `FM1_FWSC` is set. Run it inside this folder with the toolchain you have (rustc 1.98 or newer):

    FM1_FWSC=/path/to/386dx.fwsc cargo test --release -- --nocapture

Set `FM1_OUT=out.raw` as well to write the audio as 16-bit stereo, which can be compared with the wasm build's output from `FM1_BENCH_KEYS="2000:PLAY" FM1_WASM=... FM1_FWSC=... node web/bench.mjs 240 15 wasm.raw`. The native file has zeros where the wasm file leaves out the unfilled part of a short quantum, but the samples are otherwise identical.

For Android, `cargo build --release --target aarch64-linux-android` with the NDK's `aarch64-linux-android24-clang` as the linker produces the library, as the CI workflow does.

## Two threads

By default both FM-1 cores run on one host thread, and the audio comes out the same byte for byte every run. With `"threads":2` in the boot JSON (the app sends it unless `FM1Native.threads(1)` was called from the page's console), core 1 gets a thread of its own once the firmware releases it, so a burst of work on both cores, such as 386DX's, uses two phone cores instead of one. The one-thread scheduler stays the reference, and the two-thread sound differs a little from run to run, because the cores meet in real locks and the host's scheduler decides who gets there first.

The code is in `crates/fm1-soc/src/mt.rs`, and its header explains how the threads share the machine. The cores may drift apart by a window of 256 slices of 1024 cycles (`FM1_MT_WINDOW` sets it, in slices, for tuning). The thread keeps running between renders. Core 1 touches nothing but RAM and the XIP image without core 0 handing the rest of the machine over, so what the host reads between renders (the LCD, the LEDs, the flash, the audio) is core 0's side, and it stops core 1 only where the host reads core 1 itself (`machine::settle`: the profile report, changing the JIT, dropping the machine). The mode refuses to turn on with the flash cache model (FM1_STRICT) and with a flaky core 1, and on wasm.

`tests/threads.rs` plays 386DX both ways and compares the level and the spectrum (`FM1_FWSC=... cargo test --release --test threads -- --nocapture`). The lock tests are in `crates/fm1-soc/src/machine.rs` (`cargo test --release -p fm1-soc mt_`).
