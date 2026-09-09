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

async function detectWebGPU() {
  if (!("gpu" in navigator)) {
    return { available: false, reason: "navigator.gpu is undefined" };
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      return { available: false, reason: "requestAdapter returned null" };
    }
    const info = adapter.info || {};
    return {
      available: true,
      vendor: info.vendor || "(unknown)",
      architecture: info.architecture || "(unknown)",
      device: info.device || "(unknown)",
      description: info.description || "",
    };
  } catch (err) {
    return { available: false, reason: String(err) };
  }
}

async function onTestAi() {
  $("testAiBtn").disabled = true;
  setStatus("Checking WebGPU…");
  setProgress(0);
  log("[click] " + new Date().toISOString());

  const gpu = await detectWebGPU();
  if (gpu.available) {
    log(`[webgpu] AVAILABLE — vendor=${gpu.vendor} arch=${gpu.architecture} device=${gpu.device}`);
    if (gpu.description) log(`[webgpu] description=${gpu.description}`);
    setStatus("WebGPU available. Model load lands in 0.5.");
  } else {
    log(`[webgpu] NOT available — ${gpu.reason}`);
    setStatus("WebGPU unavailable — will fall back to WASM in 0.5.");
  }

  setProgress(100);
  setTimeout(() => setProgress(null), 400);
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
