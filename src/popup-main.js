// Friday popup entry (module).
//
// Task 0.3: import Transformers.js from local vendor copy (no CDN at runtime).
// Task 0.4: WebGPU detect on Test AI click.
// Task 0.5: download + load small VLM on WebGPU with WASM fallback;
//           report backend and load time. First run downloads ~150–300 MB;
//           the browser Cache Storage keeps it after that.
// Task 0.6 (next): run the loaded model on a bundled sample screenshot.

import {
  env,
  AutoProcessor,
  AutoModelForImageTextToText,
} from "../dist/vendor/transformers/transformers.min.js";

const MODEL_ID = "HuggingFaceTB/SmolVLM-256M-Instruct";

const VENDOR_URL = new URL("../dist/vendor/transformers/", import.meta.url).href;
env.backends.onnx.wasm.wasmPaths = VENDOR_URL;
env.allowLocalModels = false;
env.useBrowserCache = true;

const $ = (id) => document.getElementById(id);

function setStatus(text) { $("status").textContent = text; }

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
    if (!adapter) return { available: false, reason: "requestAdapter returned null" };
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

// Module-scoped so 0.6 can reuse without reloading.
export const state = {
  processor: null,
  model: null,
  backend: null,     // 'webgpu' | 'wasm'
  loadMs: null,
  modelId: MODEL_ID,
};

// Track per-file downloads so the progress bar reflects overall load.
function makeProgressCallback() {
  const files = new Map(); // name -> { loaded, total }
  return function onProgress(info) {
    // Transformers.js progress events look like:
    //   { status: 'initiate' | 'download' | 'progress' | 'done' | 'ready',
    //     name, file, loaded, total, progress }
    if (!info) return;
    if (info.status === "progress" && info.file && info.total) {
      files.set(info.file, { loaded: info.loaded || 0, total: info.total });
    } else if (info.status === "done" && info.file) {
      const entry = files.get(info.file);
      if (entry) entry.loaded = entry.total;
    }
    let loaded = 0, total = 0;
    for (const v of files.values()) { loaded += v.loaded; total += v.total; }
    if (total > 0) {
      const pct = (loaded / total) * 100;
      setProgress(pct);
      const mb = (n) => (n / 1024 / 1024).toFixed(1);
      setStatus(`downloading model… ${mb(loaded)} / ${mb(total)} MB (${pct.toFixed(0)}%)`);
    } else if (info.status && info.file) {
      setStatus(`${info.status}: ${info.file}`);
    }
  };
}

async function tryLoad({ device, dtype, progress_callback }) {
  const t0 = performance.now();
  const processor = await AutoProcessor.from_pretrained(MODEL_ID, { progress_callback });
  const model = await AutoModelForImageTextToText.from_pretrained(MODEL_ID, {
    device,
    dtype,
    progress_callback,
  });
  const loadMs = performance.now() - t0;
  return { processor, model, loadMs };
}

export async function loadModel({ preferWebGPU }) {
  const cb = makeProgressCallback();
  // WebGPU first (fp16 is smaller + faster on GPU), else WASM (q8 to stay lean on CPU).
  if (preferWebGPU) {
    try {
      log(`[load] trying WebGPU (q4f16) → ${MODEL_ID}`);
      const { processor, model, loadMs } = await tryLoad({
        device: "webgpu", dtype: "q4f16", progress_callback: cb,
      });
      state.processor = processor;
      state.model = model;
      state.backend = "webgpu";
      state.loadMs = loadMs;
      return state;
    } catch (err) {
      log(`[load] WebGPU load failed: ${err && err.message ? err.message : err}`);
      log(`[load] falling back to WASM…`);
    }
  }
  log(`[load] trying WASM (q4) → ${MODEL_ID}`);
  const { processor, model, loadMs } = await tryLoad({
    device: "wasm", dtype: "q4", progress_callback: cb,
  });
  state.processor = processor;
  state.model = model;
  state.backend = "wasm";
  state.loadMs = loadMs;
  return state;
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
  } else {
    log(`[webgpu] NOT available — ${gpu.reason}`);
  }

  try {
    setStatus("loading model (first run downloads ~150–300 MB; cached after)…");
    const { backend, loadMs } = await loadModel({ preferWebGPU: gpu.available });
    log(`[load] OK backend=${backend} loadMs=${loadMs.toFixed(0)} model=${MODEL_ID}`);
    setStatus(`Model loaded on ${backend} in ${(loadMs / 1000).toFixed(1)}s. Inference lands in 0.6.`);
    setProgress(100);
  } catch (err) {
    log(`[load] FAILED — ${err && err.message ? err.message : err}`);
    if (err && err.stack) log(err.stack.split("\n").slice(0, 4).join("\n"));
    setStatus("Model load failed. See output.");
  } finally {
    setTimeout(() => setProgress(null), 800);
    $("testAiBtn").disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const ver = (env && env.version) || "unknown";
  log(`[boot] Transformers.js loaded (env.version=${ver})`);
  log(`[boot] wasmPaths=${env.backends.onnx.wasm.wasmPaths}`);
  setStatus("Ready. Click Test AI.");
  $("testAiBtn").addEventListener("click", onTestAi);
});
