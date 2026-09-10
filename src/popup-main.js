// Friday dev popup entry (module).
//
// This surface is the developer scaffold — real users see the side panel.
// Phase 0/1 debug affordances live here: BG ping, settings read, content
// ping, screen capture with preview, and the on-device VLM load/inference
// pinned in place from gate 0.7 (Test AI + Run on sample + Force WASM).
// Model code lives in ./model.js (shared with the side panel).

import { detectWebGPU, loadModel, runInferenceOnUrl, state, MAX_NEW_TOKENS } from "./model.js";
import { MESSAGE_TYPES, sendToBackground } from "./messaging.js";

const SAMPLE_PATH = "assets/sample-screen.png";
const PROMPT_TEXT = "Describe this screen and list buttons and input fields";
const MODEL_ID = state.modelId;

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
    await loadModel({
      preferWebGPU: gpu.available && !forceWasm,
      onProgress: (evt) => {
        if (evt.total > 0) {
          setProgress(evt.pct);
          setStatus(`downloading model… ${evt.mbLoaded.toFixed(1)} / ${evt.mbTotal.toFixed(1)} MB (${evt.pct.toFixed(0)}%)`);
        }
      },
    });
    const mb = (state.downloadedBytes / 1024 / 1024).toFixed(1);
    const cacheState = state.downloadedBytes === 0 ? "cached" : "downloaded";
    log(`[load] OK backend=${state.backend} loadMs=${state.loadMs.toFixed(0)} ${cacheState}=${mb}MB model=${MODEL_ID}`);
    setStatus(`Model loaded on ${state.backend} in ${(state.loadMs / 1000).toFixed(1)}s (${cacheState}: ${mb} MB).`);
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
  log(`[infer] prompt="${PROMPT_TEXT}" image=${SAMPLE_PATH} maxNewTokens=${MAX_NEW_TOKENS}`);

  try {
    const url = new URL("../" + SAMPLE_PATH, import.meta.url).href;
    const { output, inferMs, firstTokenMs, chunks, timedOut, preprocessMs, promptTokens } =
      await runInferenceOnUrl(url, PROMPT_TEXT);
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
    for (const el of (data.elements || []).slice(0, 3)) {
      const bb = el.bbox;
      log(`[capture.el] ${el.fid} <${el.tag}${el.type ? ":" + el.type : ""}> role=${el.role} name="${(el.name || "").slice(0, 60)}" @${bb.x},${bb.y} ${bb.w}x${bb.h}`);
    }
    if (data.pii) {
      const summary = Object.entries(data.pii.counts).map(([k, n]) => `${k}=${n}`).join(" ") || "(none)";
      log(`[pii] total=${data.pii.total} ${summary}`);
      for (const hit of (data.pii.hits || []).slice(0, 5)) {
        const ks = hit.kinds.map((h) => `${h.kind}<${h.source}>`).join(",");
        log(`[pii.hit] ${hit.fid} <${hit.tag}${hit.type ? ":" + hit.type : ""}> name="${(hit.name || "").slice(0, 40)}" → ${ks}`);
      }
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
  log(`[boot] dev popup — VLM opt-in lives in the side panel now`);
  setStatus("Ready.");
  $("testAiBtn").addEventListener("click", onTestAi);
  $("runSampleBtn").addEventListener("click", onRunSample);
  $("pingBgBtn").addEventListener("click", onPingBg);
  $("readSettingsBtn").addEventListener("click", onReadSettings);
  $("pingContentBtn").addEventListener("click", onPingContent);
  $("captureBtn").addEventListener("click", onCapture);
});
