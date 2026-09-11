// Local text LLM adapter powered by WebLLM.
//
// The first model load downloads weights + a WebGPU wasm model library through
// WebLLM; browser cache keeps them for later offline runs. Runtime scripts are
// vendored by scripts/build.mjs so MV3 never executes remote JavaScript.

import { CreateMLCEngine, prebuiltAppConfig } from "../dist/vendor/webllm/index.js";

export const DEFAULT_LOCAL_LLM_MODEL = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";

export const LOCAL_LLM_MODELS = Object.freeze([
  { id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC", label: "Qwen 0.5B - fastest", hint: "Lowest latency, weaker reasoning." },
  { id: "Llama-3.2-1B-Instruct-q4f16_1-MLC", label: "Llama 1B - fast", hint: "Good demo fallback on smaller GPUs." },
  { id: DEFAULT_LOCAL_LLM_MODEL, label: "Qwen 1.5B - recommended", hint: "Best speed/quality balance for RTX 4050 6GB." },
  { id: "Qwen2.5-3B-Instruct-q4f16_1-MLC", label: "Qwen 3B - stronger", hint: "Better reasoning, slower and more VRAM hungry." },
  { id: "Phi-3.5-mini-instruct-q4f16_1-MLC", label: "Phi 3.5 mini - strong", hint: "Try if 3B fits your GPU comfortably." },
]);

export const localLlmState = {
  engine: null,
  modelId: "",
  loading: false,
  loadMs: 0,
  progress: 0,
  progressText: "",
};

export function normalizeLocalModel(modelId) {
  const id = String(modelId || "").trim();
  if (!id) return DEFAULT_LOCAL_LLM_MODEL;
  const exists = prebuiltAppConfig.model_list.some((m) => m.model_id === id);
  return exists ? id : DEFAULT_LOCAL_LLM_MODEL;
}

export async function detectLocalLlmSupport() {
  if (!navigator.gpu) return { available: false, reason: "WebGPU is not available in this browser." };
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) return { available: false, reason: "No WebGPU adapter found." };
    const info = adapter.info || {};
    return {
      available: true,
      vendor: info.vendor || "gpu",
      architecture: info.architecture || "",
      device: info.device || "",
    };
  } catch (err) {
    return { available: false, reason: err?.message || String(err) };
  }
}

export async function ensureLocalLlm({ modelId, onProgress } = {}) {
  const id = normalizeLocalModel(modelId);
  if (localLlmState.engine && localLlmState.modelId === id) return localLlmState.engine;
  if (localLlmState.loading) {
    while (localLlmState.loading) await new Promise((r) => setTimeout(r, 250));
    if (localLlmState.engine && localLlmState.modelId === id) return localLlmState.engine;
  }

  localLlmState.loading = true;
  localLlmState.progress = 0;
  localLlmState.progressText = "Starting local LLM...";
  const t0 = performance.now();
  try {
    const engine = await CreateMLCEngine(
      id,
      {
        initProgressCallback: (report) => {
          localLlmState.progress = Math.max(0, Math.min(100, (report.progress || 0) * 100));
          localLlmState.progressText = report.text || "Loading local LLM...";
          onProgress?.({
            pct: localLlmState.progress,
            text: localLlmState.progressText,
            timeElapsed: report.timeElapsed || 0,
          });
        },
        logLevel: "INFO",
      },
      { context_window_size: 2048 },
    );
    localLlmState.engine = engine;
    localLlmState.modelId = id;
    localLlmState.loadMs = performance.now() - t0;
    localLlmState.progress = 100;
    localLlmState.progressText = "Loaded.";
    return engine;
  } finally {
    localLlmState.loading = false;
  }
}

export async function chatLocal({
  messages,
  modelId,
  temperature = 0.3,
  maxTokens = 512,
  json = false,
  onProgress,
} = {}) {
  if (!Array.isArray(messages) || !messages.length) {
    throw new Error("chatLocal: messages required");
  }
  const engine = await ensureLocalLlm({ modelId, onProgress });
  // NOTE: response_format:{type:"json_object"} needs XGrammar compiled into
  // the model wasm; the Qwen2.5 / Llama-3.2 prebuilts in WebLLM 0.2.85 fail
  // with "Failed to initialize the grammar matcher... Cannot pass non-string
  // to std::string". The `json` flag is kept as a soft hint (caller already
  // asks for JSON in the system prompt; agent parser is tolerant of fences
  // and stray prose). If a future model ships grammar support, gate the
  // response_format on a model-capability check instead of a blanket flag.
  const out = await engine.chat.completions.create({
    messages,
    temperature,
    max_tokens: maxTokens,
  });
  return (out?.choices?.[0]?.message?.content || "").trim();
}

export async function chatLocalPlain(args) {
  return chatLocal({ ...args, json: false, temperature: args?.temperature ?? 0.4, maxTokens: args?.maxTokens ?? 768 });
}
