// Friday popup entry (module).
//
// Task 0.3: import Transformers.js from local vendor copy (no CDN at runtime).
// Task 0.4: WebGPU detect on Test AI click.
// Task 0.5: download + load small VLM on WebGPU with WASM fallback,
//           aggregated progress bar, backend + load time report.
// Task 0.6: run the loaded model on assets/sample-screen.png (PNG — SVG blobs
//           fail to decode in the extension popup) with prompt
//           "Describe this screen and list buttons and input fields".
//           Streamed via TextStreamer (first-token latency + chunk counter),
//           capped at 64 new tokens, wrapped in a 60s watchdog that fires
//           InterruptableStoppingCriteria.interrupt() to really stop the loop.
//           Load path tracks downloaded bytes so cached vs first-run is
//           unambiguous. "Force WASM" checkbox skips WebGPU for a CPU-vs-GPU
//           benchmark on the same model.

import {
  env,
  AutoProcessor,
  AutoModelForImageTextToText,
  RawImage,
  TextStreamer,
  InterruptableStoppingCriteria,
} from "../dist/vendor/transformers/transformers.min.js";
import { MESSAGE_TYPES, sendToBackground } from "./messaging.js";

const MODEL_ID = "HuggingFaceTB/SmolVLM-256M-Instruct";
const SAMPLE_PATH = "assets/sample-screen.png";
const PROMPT_TEXT = "Describe this screen and list buttons and input fields";
const MAX_NEW_TOKENS = 64;
const INFER_TIMEOUT_MS = 60_000;
// Downscale before the VLM to cut vision-encoder + prefill cost. 512→384 is
// ~2.8× fewer image tokens; on Intel iGPU/CPU that's a first-token win.
const INFER_IMAGE_SIZE = 384;

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

export const state = {
  processor: null,
  model: null,
  backend: null,      // 'webgpu' | 'wasm'
  loadMs: null,
  downloadedBytes: 0, // per-load; 0 → fully served from browser Cache Storage
  lastInferMs: null,
  modelId: MODEL_ID,
  interruptor: null,  // set during generation so a watchdog can interrupt
};

function makeProgressCallback() {
  // Tracks files that emit `progress` events. Files served entirely from
  // Cache Storage skip `progress` events, so a zero counter after a
  // successful load means "fully cached".
  const files = new Map();
  let bytes = 0;
  const cb = function onProgress(info) {
    if (!info) return;
    if (info.status === "progress" && info.file && info.total) {
      files.set(info.file, { loaded: info.loaded || 0, total: info.total });
    } else if (info.status === "done" && info.file) {
      const entry = files.get(info.file);
      if (entry) entry.loaded = entry.total;
    }
    let loaded = 0, total = 0;
    for (const v of files.values()) { loaded += v.loaded; total += v.total; }
    bytes = loaded;
    if (total > 0) {
      const pct = (loaded / total) * 100;
      setProgress(pct);
      const mb = (n) => (n / 1024 / 1024).toFixed(1);
      setStatus(`downloading model… ${mb(loaded)} / ${mb(total)} MB (${pct.toFixed(0)}%)`);
    } else if (info.status && info.file) {
      setStatus(`${info.status}: ${info.file}`);
    }
  };
  cb.getBytes = () => bytes;
  return cb;
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
      state.downloadedBytes = cb.getBytes();
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
  state.downloadedBytes = cb.getBytes();
  return state;
}

// Loads the bundled PNG using Transformers.js RawImage.read(url), which
// fetches, decodes, and normalizes to the RGB tensor the processor expects.
// PNG (not SVG) because the popup's decoder rejects SVG blobs.
// Downscaled to INFER_IMAGE_SIZE before hitting the processor so the vision
// encoder does less work.
async function loadSampleImage() {
  const url = new URL("../" + SAMPLE_PATH, import.meta.url).href;
  const raw = await RawImage.read(url);
  return await raw.resize(INFER_IMAGE_SIZE, INFER_IMAGE_SIZE);
}

export async function runInference() {
  if (!state.model || !state.processor) throw new Error("model not loaded");

  // Split preprocess vs generate timing so the next report says exactly
  // where the seconds went (image decode/resize + processor tokenize vs
  // model forward passes).
  const tPre0 = performance.now();
  const image = await loadSampleImage();

  const messages = [{
    role: "user",
    content: [
      { type: "image" },
      { type: "text", text: PROMPT_TEXT },
    ],
  }];
  const text = state.processor.apply_chat_template(messages, {
    add_generation_prompt: true,
  });
  const inputs = await state.processor(text, [image]);
  const preprocessMs = performance.now() - tPre0;
  const promptTokens = inputs.input_ids.dims[1];
  log(`[infer] preprocess=${preprocessMs.toFixed(0)}ms promptTokens=${promptTokens} imageSize=${INFER_IMAGE_SIZE}`);

  // Stream tokens so the status line moves during generation — proves the
  // model is alive vs stuck, and gives us first-token latency.
  let chunkCount = 0;
  let accum = "";
  let firstTokenMs = null;
  const t0 = performance.now();
  const streamer = new TextStreamer(state.processor.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (chunk) => {
      chunkCount++;
      accum += chunk;
      if (firstTokenMs === null) {
        firstTokenMs = performance.now() - t0;
        log(`[infer] first-token in ${firstTokenMs.toFixed(0)}ms`);
      }
      if (chunkCount % 4 === 0) {
        const elapsed = performance.now() - t0;
        setStatus(`generating… ${chunkCount} chunks, ${(elapsed / 1000).toFixed(1)}s`);
      }
    },
  });

  // Real interrupt (not a Promise.race — the generation loop actually stops)
  // via InterruptableStoppingCriteria, tripped by a setTimeout watchdog.
  const interruptor = new InterruptableStoppingCriteria();
  state.interruptor = interruptor;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    interruptor.interrupt();
    log(`[infer] TIMEOUT after ${(INFER_TIMEOUT_MS / 1000).toFixed(0)}s — interrupting`);
  }, INFER_TIMEOUT_MS);

  try {
    const generated = await state.model.generate({
      ...inputs,
      max_new_tokens: MAX_NEW_TOKENS,
      do_sample: false,
      streamer,
      stopping_criteria: interruptor,
    });
    const inferMs = performance.now() - t0;
    state.lastInferMs = inferMs;

    // Prefer decoded output; on interrupt, fall back to whatever the streamer accumulated.
    let outputText = "";
    try {
      const inputLen = inputs.input_ids.dims[1];
      const trimmed = generated.slice(null, [inputLen, null]);
      const decoded = state.processor.batch_decode(trimmed, { skip_special_tokens: true });
      outputText = (decoded[0] || "").trim();
    } catch {
      outputText = accum.trim();
    }
    if (!outputText) outputText = accum.trim();

    return {
      output: outputText,
      inferMs,
      firstTokenMs,
      chunks: chunkCount,
      timedOut,
      preprocessMs,
      promptTokens,
    };
  } finally {
    clearTimeout(timer);
    state.interruptor = null;
  }
}

async function onTestAi() {
  $("testAiBtn").disabled = true;
  $("runSampleBtn").disabled = true;
  setStatus("Checking WebGPU…");
  setProgress(0);
  log("[click] Test AI " + new Date().toISOString());

  const forceWasm = !!$("forceWasm").checked;
  if (forceWasm) log(`[opt] Force WASM checked — skipping WebGPU`);

  const gpu = await detectWebGPU();
  if (gpu.available) {
    log(`[webgpu] AVAILABLE — vendor=${gpu.vendor} arch=${gpu.architecture} device=${gpu.device}`);
    if (gpu.description) log(`[webgpu] description=${gpu.description}`);
  } else {
    log(`[webgpu] NOT available — ${gpu.reason}`);
  }

  try {
    setStatus("loading model (first run downloads ~150–300 MB; cached after)…");
    const { backend, loadMs, downloadedBytes } = await loadModel({
      preferWebGPU: gpu.available && !forceWasm,
    });
    const mb = (downloadedBytes / 1024 / 1024).toFixed(1);
    const cacheState = downloadedBytes === 0 ? "cached" : "downloaded";
    log(`[load] OK backend=${backend} loadMs=${loadMs.toFixed(0)} ${cacheState}=${mb}MB model=${MODEL_ID}`);
    setStatus(`Model loaded on ${backend} in ${(loadMs / 1000).toFixed(1)}s (${cacheState}: ${mb} MB).`);
    setProgress(100);
    $("runSampleBtn").disabled = false;
  } catch (err) {
    log(`[load] FAILED — ${err && err.message ? err.message : err}`);
    if (err && err.stack) log(err.stack.split("\n").slice(0, 4).join("\n"));
    setStatus("Model load failed. See output.");
  } finally {
    setTimeout(() => setProgress(null), 800);
    $("testAiBtn").disabled = false;
  }
}

async function onRunSample() {
  if (!state.model) { log("[infer] load the model first (Test AI)"); return; }
  $("testAiBtn").disabled = true;
  $("runSampleBtn").disabled = true;
  setProgress(0);
  setStatus("running inference on sample screen…");
  log(`[infer] prompt="${PROMPT_TEXT}" image=${SAMPLE_PATH} maxNewTokens=${MAX_NEW_TOKENS} timeout=${INFER_TIMEOUT_MS / 1000}s`);

  try {
    const { output, inferMs, firstTokenMs, chunks, timedOut, preprocessMs, promptTokens } = await runInference();
    const ftt = firstTokenMs == null ? "n/a" : `${firstTokenMs.toFixed(0)}ms`;
    log(`[infer] backend=${state.backend} preprocessMs=${preprocessMs.toFixed(0)} inferMs=${inferMs.toFixed(0)} firstTokenMs=${ftt} chunks=${chunks} promptTokens=${promptTokens} timedOut=${timedOut}`);
    log(`[infer.out] ${output || "(empty)"}`);
    setStatus(timedOut
      ? `Timeout after ${(inferMs / 1000).toFixed(1)}s on ${state.backend}.`
      : `Done in ${(inferMs / 1000).toFixed(1)}s on ${state.backend}.`);
    setProgress(100);
  } catch (err) {
    log(`[infer] FAILED — ${err && err.message ? err.message : err}`);
    if (err && err.stack) log(err.stack.split("\n").slice(0, 4).join("\n"));
    setStatus("Inference failed. See output.");
  } finally {
    setTimeout(() => setProgress(null), 800);
    $("testAiBtn").disabled = false;
    $("runSampleBtn").disabled = false;
  }
}

async function onPingBg() {
  const t0 = performance.now();
  try {
    const data = await sendToBackground(MESSAGE_TYPES.PING, { from: "popup", t0 });
    const dt = performance.now() - t0;
    log(`[bg] PING → ${JSON.stringify(data)} (rtt=${dt.toFixed(1)}ms)`);
    setStatus(`BG responded in ${dt.toFixed(1)}ms`);
  } catch (err) {
    log(`[bg] PING FAILED — ${err.message}`);
    setStatus("BG ping failed");
  }
}

async function onReadSettings() {
  try {
    const data = await sendToBackground(MESSAGE_TYPES.GET_SETTINGS);
    log(`[bg] settings → ${JSON.stringify(data)}`);
    setStatus("settings loaded");
  } catch (err) {
    log(`[bg] settings FAILED — ${err.message}`);
  }
}

async function onPingContent() {
  const t0 = performance.now();
  try {
    const data = await sendToBackground(MESSAGE_TYPES.CONTENT_PING, { from: "popup", t0 });
    const dt = performance.now() - t0;
    log(`[content] ${data.tabUrl}`);
    log(`[content] title="${data.title}" nodes=${data.nodeCount} forms=${data.formCount} inputs=${data.inputCount} readyState=${data.readyState}`);
    setStatus(`content responded in ${dt.toFixed(1)}ms`);
  } catch (err) {
    log(`[content] PING FAILED — ${err.message}`);
    setStatus("content ping failed");
  }
}

async function onCapture() {
  const t0 = performance.now();
  setStatus("capturing…");
  try {
    const data = await sendToBackground(MESSAGE_TYPES.CAPTURE_TAB);
    const dt = performance.now() - t0;
    const kb = (data.screenshotBytes / 1024).toFixed(1);
    log(`[capture] ${data.page.url}`);
    log(`[capture] viewport=${data.viewport.width}x${data.viewport.height}@${data.viewport.dpr}dpr scroll=${data.viewport.scrollX},${data.viewport.scrollY}`);
    log(`[capture] elements=${data.elementCount}/${data.totalScanned} scanned; screenshot=${kb}KB; captureMs=${data.captureMs}; totalMs=${dt.toFixed(0)}`);
    // Preview: first 3 interesting elements
    for (const el of (data.elements || []).slice(0, 3)) {
      const bb = el.bbox;
      log(`[capture.el] ${el.fid} <${el.tag}${el.type ? ":" + el.type : ""}> role=${el.role} name="${(el.name || "").slice(0, 60)}" @${bb.x},${bb.y} ${bb.w}x${bb.h}`);
    }
    const img = $("captureImg");
    img.src = data.screenshot;
    img.style.display = "block";
    setStatus(`captured in ${dt.toFixed(0)}ms`);
  } catch (err) {
    log(`[capture] FAILED — ${err.message}`);
    setStatus("capture failed");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const ver = (env && env.version) || "unknown";
  log(`[boot] Transformers.js loaded (env.version=${ver})`);
  log(`[boot] wasmPaths=${env.backends.onnx.wasm.wasmPaths}`);
  setStatus("Ready. Click Test AI to load the model.");
  $("testAiBtn").addEventListener("click", onTestAi);
  $("runSampleBtn").addEventListener("click", onRunSample);
  $("pingBgBtn").addEventListener("click", onPingBg);
  $("readSettingsBtn").addEventListener("click", onReadSettings);
  $("pingContentBtn").addEventListener("click", onPingContent);
  $("captureBtn").addEventListener("click", onCapture);
});
