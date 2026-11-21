#!/usr/bin/env bash
# The threaded wasm for the browser: the same fm1-web, built with shared memory (nightly and a rebuilt
# std, because the prebuilt wasm32 std has no atomics). Writes fm1_web_mt.wasm into $1 (default web/dist-mt).
# The page runs core 1 in a Worker on the worklet's memory when the page is cross-origin isolated.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/web/dist-mt}"
cd "$ROOT"
export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1
# 512 MiB at most: the memory is shared, so it must declare a maximum
LINK="-Clink-arg=--export-table -Clink-arg=--growable-table -Clink-arg=--shared-memory -Clink-arg=--import-memory -Clink-arg=--initial-memory=16777216 -Clink-arg=--max-memory=536870912"
# the thread-local block a Worker sets up for itself (std's thread_local! and the panic count use it)
LINK="$LINK -Clink-arg=--export=__wasm_init_tls -Clink-arg=--export=__tls_size -Clink-arg=--export=__tls_align -Clink-arg=--export=__tls_base -Clink-arg=--export=__stack_pointer"
export RUSTFLAGS="${RUSTFLAGS:-} -Cllvm-args=-inline-threshold=2000 -Ctarget-feature=+atomics,+bulk-memory,+mutable-globals $LINK"
TC="${RUSTUP_TC:-$HOME/.rustup/toolchains/nightly-aarch64-apple-darwin}"
if [ -d "$TC" ]; then
  DYLD_FALLBACK_LIBRARY_PATH="$TC/lib" RUSTC="$TC/bin/rustc" "$TC/bin/cargo" build --release -p fm1-web \
    --target wasm32-unknown-unknown --target-dir target/wasm-mt -Zbuild-std=std,panic_abort
else
  cargo +nightly build --release -p fm1-web --target wasm32-unknown-unknown --target-dir target/wasm-mt -Zbuild-std=std,panic_abort
fi
mkdir -p "$OUT"
cp target/wasm-mt/wasm32-unknown-unknown/release/fm1_web.wasm "$OUT/fm1_web_mt.wasm"
ls -la "$OUT/fm1_web_mt.wasm"
