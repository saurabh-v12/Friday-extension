// Friday dev popup entry (module).
//
// This surface is the developer scaffold — real users see the side panel.
// Phase 0/1 debug affordances live here: BG ping, settings read, content
// ping, screen capture with preview, and the on-device VLM load/inference
// pinned in place from gate 0.7 (Test AI + Run on sample + Force WASM).
// Model code lives in ./model.js (shared with the side panel).

import { detectWebGPU, loadModel, runInferenceOnUrl, state, MAX_NEW_TOKENS } from "./model.js";
import { MESSAGE_TYPES, sendToBackground } from "./messaging.js";
import { loadBlazeFace, detectFacesFromDataUrl } from "./faces.js";
import { runOcrOnDataUrl } from "./ocr.js";
import { redactImage, collectRegions, REDACT_MODES } from "./redact.js";
import { runPrivacyPipeline, buildSanitizedPayload } from "./pipeline.js";

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
    lastScreenshotDataUrl = data.screenshot;
    lastCapture = data;
    setStatus(`captured in ${dt.toFixed(0)}ms`);
  } catch (err) {
    log(`[capture] FAILED — ${err.message}`);
    setStatus("capture failed");
  }
}

let lastScreenshotDataUrl = null;
let lastCapture = null;

async function onDetectFaces() {
  if (!lastScreenshotDataUrl) {
    log("[faces] capture the screen first (Capture button)");
    return;
  }
  setStatus("loading BlazeFace…");
  const t0 = performance.now();
  try {
    const info = await loadBlazeFace({
      onProgress: (evt) => setStatus(`BlazeFace ${evt.phase}…`),
    });
    log(`[faces] runtime=${info.backend} loadMs=${info.loadMs.toFixed(0)}`);
    setStatus("running face detection…");
    const detT0 = performance.now();
    const faces = await detectFacesFromDataUrl(lastScreenshotDataUrl);
    const detMs = performance.now() - detT0;
    log(`[faces] detected=${faces.length} detectMs=${detMs.toFixed(0)} totalMs=${(performance.now() - t0).toFixed(0)}`);
    for (const [i, f] of faces.entries()) {
      log(`[faces.${i}] box=${f.box.x},${f.box.y} ${f.box.w}x${f.box.h} prob=${f.prob != null ? f.prob.toFixed(2) : "n/a"} landmarks=${f.landmarks.length}`);
    }
    setStatus(`faces detected: ${faces.length}`);
  } catch (err) {
    log(`[faces] FAILED — ${err && err.message ? err.message : err}`);
    setStatus("face detection failed");
  }
}

async function onRedact() {
  if (!lastCapture) { log("[redact] capture the screen first"); return; }
  setStatus("running detectors + redaction…");
  const t0 = performance.now();
  try {
    // Decode the screenshot once, then read its true pixel dimensions so
    // we can scale DOM bboxes (CSS px) to image space accurately.
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = lastScreenshotDataUrl; });
    const imageWidth = img.naturalWidth;
    const imageHeight = img.naturalHeight;

    log("[redact] loading BlazeFace + Tesseract…");
    const [faceInfo, ocrOut] = await Promise.all([
      loadBlazeFace().then((info) => detectFacesFromDataUrl(lastScreenshotDataUrl).then((faces) => ({ ...info, faces }))),
      runOcrOnDataUrl(lastScreenshotDataUrl),
    ]);
    log(`[redact] faces=${faceInfo.faces.length} ocr.words=${ocrOut.words.length} ocr.pii=${ocrOut.textPii.length}`);

    const regions = collectRegions({
      dom: lastCapture.pii,
      faces: faceInfo.faces,
      ocr: ocrOut,
      viewport: lastCapture.viewport,
      imageWidth,
      imageHeight,
    });
    log(`[redact] regions=${regions.length} (dom=${(lastCapture.pii && lastCapture.pii.total) || 0} faces=${faceInfo.faces.length} ocr=${ocrOut.textPii.filter(h => h.bbox).length})`);

    const result = await redactImage({
      imageSource: img,
      regions,
      mode: REDACT_MODES.BLUR,
      blurPx: 22,
    });
    log(`[redact] applied=${result.regionsApplied}/${result.regionsGiven} redactMs=${result.redactMs.toFixed(0)} totalMs=${(performance.now() - t0).toFixed(0)}`);

    $("captureImg").src = result.dataUrl;
    setStatus(`redacted ${result.regionsApplied} region(s)`);
  } catch (err) {
    log(`[redact] FAILED — ${err && err.message ? err.message : err}`);
    setStatus("redact failed");
  }
}

async function ensureSnapshot() {
  // Executor needs a fresh fidMap in content.js — trigger a CAPTURE_TAB
  // which populates it as a side-effect.
  await sendToBackground(MESSAGE_TYPES.CAPTURE_TAB);
}

async function onResolve() {
  const intent = $("intentInput").value.trim();
  if (!intent) { log("[resolve] enter an intent"); return; }
  await ensureSnapshot();
  try {
    const { matches, best } = await sendToBackground(MESSAGE_TYPES.RESOLVE, { intent });
    log(`[resolve] intent="${intent}" matches=${matches.length}`);
    for (const m of matches) log(`[resolve.match] ${m.fid} role=${m.role} score=${m.score} name="${m.name.slice(0, 60)}"`);
    setStatus(best ? `best: ${best.fid} ${best.role}` : "no match");
  } catch (err) {
    log(`[resolve] FAILED — ${err.message}`);
  }
}

async function resolveAndAct(action, extra) {
  const intent = $("intentInput").value.trim();
  if (!intent) { log(`[${action}] enter an intent`); return; }
  await ensureSnapshot();
  try {
    const { best } = await sendToBackground(MESSAGE_TYPES.RESOLVE, { intent });
    if (!best) { log(`[${action}] no match for "${intent}"`); return; }
    const result = await sendToBackground(MESSAGE_TYPES.EXECUTE, { action, fid: best.fid, ...extra });
    log(`[${action}] ${result.fid} <${result.tag}> ms=${result.ms.toFixed(1)}${result.chars != null ? ` chars=${result.chars}` : ""}`);
    setStatus(`${action} → ${best.fid} (${best.role})`);
  } catch (err) {
    log(`[${action}] FAILED — ${err.message}`);
  }
}

// Task 3.3 verification set — each entry: {intent, expectedName, action, text?}.
// The intent is what a user might type; expectedName is the exact
// accessible-name string the resolver should land on.
const VERIFY_SET = [
  { intent: "submit order", expectedName: "Submit Order", action: "click" },
  { intent: "continue", expectedName: "Continue", action: "click" },
  { intent: "delete account", expectedName: "Delete Account", action: "click" },
  { intent: "cancel", expectedName: "Cancel", action: "click" },
  { intent: "×", expectedName: "×", action: "click" },       // tiny X
  { intent: "close", expectedName: "Close", action: "click" }, // tiny
  { intent: "edit", expectedName: "Edit", action: "click" },   // tiny
  { intent: "save", expectedName: "Save", action: "click" },   // tiny (ambiguous vs Save Draft — hardest case)
  { intent: "email", expectedName: "Email address", action: "type", text: "user@example.com" },
  { intent: "password", expectedName: "Password", action: "type", text: "supersecret" },
  { intent: "full name", expectedName: "Full name", action: "type", text: "Jane Doe" },
  { intent: "learn more", expectedName: "Learn more", action: "click" },
  { intent: "privacy policy", expectedName: "Privacy policy", action: "click" },
  { intent: "terms of service", expectedName: "Terms of service", action: "click" },
  { intent: "next", expectedName: "Next", action: "click" },
  { intent: "previous", expectedName: "Previous", action: "click" },
  { intent: "save draft", expectedName: "Save Draft", action: "click" },
  { intent: "publish", expectedName: "Publish", action: "click" },
];

async function onVerifyExecutor() {
  setStatus("running verification…");
  log(`[verify] running ${VERIFY_SET.length} intents against the test page`);
  try {
    await ensureSnapshot();
    let resolveHits = 0, clickHits = 0;
    for (const { intent, expectedName, action, text } of VERIFY_SET) {
      const { best } = await sendToBackground(MESSAGE_TYPES.RESOLVE, { intent });
      const resolveOk = best && best.name.toLowerCase() === expectedName.toLowerCase();
      if (resolveOk) resolveHits++;
      let execOk = false, execErr = null;
      if (best) {
        try {
          const extra = action === "type" ? { text } : {};
          await sendToBackground(MESSAGE_TYPES.EXECUTE, { action, fid: best.fid, ...extra });
          execOk = true;
        } catch (err) { execErr = err.message; }
      }
      if (execOk) clickHits++;
      const marker = resolveOk ? "✓" : "✗";
      log(`[verify] ${marker} "${intent}" → ${best ? `"${best.name}"` : "(no match)"} action=${action} exec=${execOk ? "OK" : (execErr || "skip")}`);
    }
    const rPct = ((resolveHits / VERIFY_SET.length) * 100).toFixed(1);
    const cPct = ((clickHits / VERIFY_SET.length) * 100).toFixed(1);
    log(`[verify] resolve accuracy: ${resolveHits}/${VERIFY_SET.length} = ${rPct}%`);
    log(`[verify] exec accuracy: ${clickHits}/${VERIFY_SET.length} = ${cPct}%`);
    setStatus(`verify: resolve ${rPct}% · exec ${cPct}%`);
  } catch (err) {
    log(`[verify] FAILED — ${err.message}`);
    setStatus("verify failed");
  }
}

async function onSafePayload() {
  setStatus("running full pipeline…");
  try {
    const receipt = await runPrivacyPipeline({ onPhase: (p) => setStatus(`pipeline: ${p}…`) });
    const payload = buildSanitizedPayload(receipt);
    log(`[payload] regions=${payload.meta.regionCount} redacted=${payload.image.redacted} elements=${payload.elementCount}`);
    log(`[payload] page=${payload.page.host}${payload.page.path} title="${(payload.page.title || "").slice(0, 40)}"`);
    log(`[payload] image=${payload.image.width}x${payload.image.height} dataUrlBytes=${payload.image.dataUrl.length}`);
    log(`[payload] receipt.perKind=${JSON.stringify(payload.receipt.perKind)}`);
    // Verify no raw PII leaked into element values.
    const stillRaw = payload.elements.filter((e) => typeof e.value === "string" && /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(e.value));
    if (stillRaw.length) log(`[payload.CHECK] LEAKED: ${stillRaw.length} element values still contain email-like strings`);
    else log(`[payload.CHECK] no raw PII leaked into element values`);
    $("captureImg").src = payload.image.dataUrl;
    $("captureImg").style.display = "block";
    setStatus(`payload built (${payload.receipt.total} redactions)`);
  } catch (err) {
    log(`[payload] FAILED — ${err && err.message ? err.message : err}`);
    setStatus("safe payload failed");
  }
}

async function onRunOcr() {
  if (!lastScreenshotDataUrl) {
    log("[ocr] capture the screen first (Capture button)");
    return;
  }
  setStatus("loading Tesseract…");
  const t0 = performance.now();
  try {
    const { text, words, textPii, ocrMs } = await runOcrOnDataUrl(lastScreenshotDataUrl, {
      onProgress: (evt) => {
        if (evt.pct != null) setStatus(`OCR ${evt.phase}… ${evt.pct.toFixed(0)}%`);
        else setStatus(`OCR ${evt.phase}…`);
      },
    });
    log(`[ocr] words=${words.length} chars=${text.length} ocrMs=${ocrMs.toFixed(0)} totalMs=${(performance.now() - t0).toFixed(0)}`);
    log(`[ocr.pii] found=${textPii.length}`);
    for (const hit of textPii.slice(0, 6)) {
      const bb = hit.bbox ? `@${hit.bbox.x},${hit.bbox.y} ${hit.bbox.w}x${hit.bbox.h}` : "(fulltext)";
      log(`[ocr.pii.hit] ${hit.kind} ${bb} evidence="${hit.evidence}" src=${hit.source}`);
    }
    setStatus(`OCR done: ${words.length} words, ${textPii.length} PII hit(s)`);
  } catch (err) {
    log(`[ocr] FAILED — ${err && err.message ? err.message : err}`);
    setStatus("OCR failed");
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
  $("facesBtn").addEventListener("click", onDetectFaces);
  $("ocrBtn").addEventListener("click", onRunOcr);
  $("redactBtn").addEventListener("click", onRedact);
  $("payloadBtn").addEventListener("click", onSafePayload);
  $("resolveBtn").addEventListener("click", onResolve);
  $("clickBtn").addEventListener("click", () => resolveAndAct("click"));
  $("typeBtn").addEventListener("click", () => resolveAndAct("type", { text: $("typeInput").value }));
  $("verifyBtn").addEventListener("click", onVerifyExecutor);
});
