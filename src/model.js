// Shared local-VLM loader + inference — used by the dev popup AND the side
// panel. Per gate 0.7 the VLM is DEFERRED as an optional fallback (too slow
// on typical Intel iGPU/CPU), so the side panel gates this behind an
// explicit `vlmEnabled` setting. Popup keeps it available for dev/testing.

import {
  env,
  AutoProcessor,
  AutoModelForImageTextToText,
  RawImage,
  TextStreamer,
  InterruptableStoppingCriteria,
} from "../dist/vendor/transformers/transformers.min.js";

export const MODEL_ID = "HuggingFaceTB/SmolVLM-256M-Instruct";
export const MAX_NEW_TOKENS = 64;
export const INFER_TIMEOUT_MS = 60_000;
export const INFER_IMAGE_SIZE = 384;

// One-time env setup. `import.meta.url` from this file resolves to
// chrome-extension://<id>/src/model.js, so ../dist/vendor/transformers/
// lands at the extension-root vendor folder either way.
const VENDOR_URL = new URL("../dist/vendor/transformers/", import.meta.url).href;
env.backends.onnx.wasm.wasmPaths = VENDOR_URL;
env.allowLocalModels = false;
env.useBrowserCache = true;

export const state = {
  processor: null,
  model: null,
  backend: null,       // 'webgpu' | 'wasm'
  loadMs: null,
  downloadedBytes: 0,  // 0 → fully served from browser Cache Storage
  lastInferMs: null,
  modelId: MODEL_ID,
  interruptor: null,
};

export async function detectWebGPU() {
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

// Callers pass an `onProgress(evt)` where evt is:
//   { loaded, total, pct, mbLoaded, mbTotal, file, status }
// Called on every Transformers.js progress event; provides an aggregate
// (loaded/total across all files) plus the raw event fields.
export function makeProgressCallback(onProgress) {
  const files = new Map();
  let bytes = 0;
  const cb = function transformersProgress(info) {
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
    if (onProgress) {
      onProgress({
        loaded, total,
        pct: total > 0 ? (loaded / total) * 100 : null,
        mbLoaded: loaded / 1024 / 1024,
        mbTotal: total / 1024 / 1024,
        file: info.file,
        status: info.status,
      });
    }
  };
  cb.getBytes = () => bytes;
  return cb;
}

async function tryLoad({ device, dtype, progress_callback }) {
  const t0 = performance.now();
  const processor = await AutoProcessor.from_pretrained(MODEL_ID, { progress_callback });
  const model = await AutoModelForImageTextToText.from_pretrained(MODEL_ID, {
    device, dtype, progress_callback,
  });
  return { processor, model, loadMs: performance.now() - t0 };
}

// Loads (or reloads) the model. On WebGPU failure, transparently falls back
// to WASM. Cached files won't re-download (browser Cache Storage handles it).
export async function loadModel({ preferWebGPU = true, onProgress } = {}) {
  const cb = makeProgressCallback(onProgress);
  if (preferWebGPU) {
    try {
      const { processor, model, loadMs } = await tryLoad({
        device: "webgpu", dtype: "q4f16", progress_callback: cb,
      });
      Object.assign(state, { processor, model, backend: "webgpu", loadMs, downloadedBytes: cb.getBytes() });
      return state;
    } catch (_err) {
      // Fall through to WASM.
    }
  }
  const { processor, model, loadMs } = await tryLoad({
    device: "wasm", dtype: "q4", progress_callback: cb,
  });
  Object.assign(state, { processor, model, backend: "wasm", loadMs, downloadedBytes: cb.getBytes() });
  return state;
}

// Rasterizes+resizes an image URL for the model.
async function readAndResize(url, size = INFER_IMAGE_SIZE) {
  const raw = await RawImage.read(url);
  return await raw.resize(size, size);
}

// Standalone inference used by the popup dev sample flow.
export async function runInferenceOnUrl(imageUrl, promptText) {
  if (!state.model || !state.processor) throw new Error("model not loaded");

  const tPre0 = performance.now();
  const image = await readAndResize(imageUrl);
  const messages = [{
    role: "user",
    content: [{ type: "image" }, { type: "text", text: promptText }],
  }];
  const text = state.processor.apply_chat_template(messages, { add_generation_prompt: true });
  const inputs = await state.processor(text, [image]);
  const preprocessMs = performance.now() - tPre0;
  const promptTokens = inputs.input_ids.dims[1];

  let chunks = 0, accum = "", firstTokenMs = null;
  const t0 = performance.now();
  const streamer = new TextStreamer(state.processor.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (chunk) => {
      chunks++;
      accum += chunk;
      if (firstTokenMs === null) firstTokenMs = performance.now() - t0;
    },
  });

  const interruptor = new InterruptableStoppingCriteria();
  state.interruptor = interruptor;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; interruptor.interrupt(); }, INFER_TIMEOUT_MS);

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

    let output = "";
    try {
      const inputLen = inputs.input_ids.dims[1];
      const trimmed = generated.slice(null, [inputLen, null]);
      output = (state.processor.batch_decode(trimmed, { skip_special_tokens: true })[0] || "").trim();
    } catch { output = accum.trim(); }
    if (!output) output = accum.trim();

    return { output, inferMs, firstTokenMs, chunks, timedOut, preprocessMs, promptTokens };
  } finally {
    clearTimeout(timer);
    state.interruptor = null;
  }
}
