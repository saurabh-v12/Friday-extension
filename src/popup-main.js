// Friday popup entry (module).
//
// Task 0.3: import Transformers.js from the locally bundled vendor copy so
// the extension doesn't hit any CDN. Log the version so we can see it loaded.
// Point ORT WASM paths at the same local folder so no runtime CDN fetch.
// Task 0.4: WebGPU detect (adds env info on button click).
// Task 0.5+ will use pipeline() to load a small VLM.

import {
  env,
  // pipeline is unused until 0.5 — imported here so the tree-shaker keeps it
  // and the module graph is complete.
  pipeline,
} from "../dist/vendor/transformers/transformers.min.js";

const VENDOR_URL = new URL("../dist/vendor/transformers/", import.meta.url).href;

// Force local WASM + disable local model dir (models still come from HF hub +
// browser Cache Storage, which is the intended offline-after-first-load flow).
env.backends.onnx.wasm.wasmPaths = VENDOR_URL;
env.allowLocalModels = false;
env.useBrowserCache = true;

const $ = (id) => document.getElementById(id);

function setStatus(text) {
  $("status").textContent = text;
}

function setProgress(percent) {
  const bar = $("progress");
  if (percent == null) {
    bar.classList.remove("visible");
    bar.removeAttribute("value");
    return;
  }
  bar.classList.add("visible");
  bar.value = Math.max(0, Math.min(100, percent));
}

function log(line) {
  const out = $("output");
  if (out.textContent === "(output will appear here)") out.textContent = "";
  out.textContent += (out.textContent ? "\n" : "") + line;
  out.scrollTop = out.scrollHeight;
}

async function onTestAi() {
  $("testAiBtn").disabled = true;
  setStatus("Test AI clicked — WebGPU check + model load land in 0.4–0.6.");
  setProgress(0);
  log("[click] " + new Date().toISOString());
  // Placeholder progress tick so the bar is visibly wired.
  for (let p = 0; p <= 100; p += 20) {
    setProgress(p);
    await new Promise((r) => setTimeout(r, 40));
  }
  setStatus("scaffold OK.");
  setProgress(null);
  $("testAiBtn").disabled = false;
}

document.addEventListener("DOMContentLoaded", () => {
  // Proof-of-load for 0.3: Transformers.js `env` object exists → import worked.
  const ver = (env && env.version) || "unknown";
  log(`[boot] Transformers.js loaded (env.version=${ver})`);
  log(`[boot] pipeline symbol=${typeof pipeline}`);
  log(`[boot] wasmPaths=${env.backends.onnx.wasm.wasmPaths}`);
  setStatus("Transformers.js bundled locally.");

  $("testAiBtn").addEventListener("click", onTestAi);
});
