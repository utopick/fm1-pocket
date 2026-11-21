// Core 1's thread for FM1_MT_WASM runs of bench.mjs: the page's Worker (pocket/vendor/core1-worker.js) itself, under worker_threads.
import { parentPort } from "node:worker_threads";
import { readFileSync } from "node:fs";
globalThis.postMessage = (m) => parentPort.postMessage(m);
parentPort.once("message", (d) => {
  (0, eval)(readFileSync(new URL("../pocket/vendor/core1-worker.js", import.meta.url), "utf8"));
  globalThis.onmessage({ data: d });
});
