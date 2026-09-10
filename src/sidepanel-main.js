// Friday side panel entry.
// Task 1.3: wire header controls to settings + persistence via BG messaging.
// Task 1.6: optional local-VLM opt-in inside settings, with first-run
//           download + progress bar and cache-reuse on subsequent loads.
//
// - Chat/Agent pill        → dropdown menu, updates label, persists `mode`.
// - Cloud/On-Device toggle → flips `data-on-device`, persists `onDeviceOnly`.
// - Settings gear          → swaps the body from empty-state → settings view.
// - VLM opt-in (settings)  → persists `vlmEnabled`; reveals a Download button
//                            that runs the shared loader (src/model.js) and
//                            shows real progress; second click reports cached.

import {
  MESSAGE_TYPES,
  SETTING_DEFAULTS,
  sendToBackground,
} from "./messaging.js";
import { loadModel, detectWebGPU, state as modelState } from "./model.js";
import { runPrivacyPipeline, KIND_LABEL } from "./pipeline.js";

const $ = (id) => document.getElementById(id);

const MODE_LABELS = { chat: "Chat", agent: "Agent" };

let settings = { ...SETTING_DEFAULTS };

// ─── Persistence helpers ──────────────────────────────────────────────

async function loadSettings() {
  try {
    settings = await sendToBackground(MESSAGE_TYPES.GET_SETTINGS);
  } catch (err) {
    console.warn("[friday.sidepanel] GET_SETTINGS failed, using defaults:", err);
    settings = { ...SETTING_DEFAULTS };
  }
}

async function saveSetting(key, value) {
  settings[key] = value;
  try {
    await sendToBackground(MESSAGE_TYPES.SET_SETTING, { key, value });
  } catch (err) {
    console.warn(`[friday.sidepanel] SET_SETTING ${key} failed:`, err);
  }
}

// ─── Mode pill + dropdown ─────────────────────────────────────────────

function renderMode() {
  const mode = settings.mode || "chat";
  $("modeLabel").textContent = MODE_LABELS[mode] || MODE_LABELS.chat;
  for (const item of document.querySelectorAll("#modeMenu .menu-item")) {
    item.setAttribute("aria-checked", item.dataset.mode === mode ? "true" : "false");
  }
  const smv = $("settingsModeValue");
  if (smv) smv.textContent = MODE_LABELS[mode] || MODE_LABELS.chat;
}

function openModeMenu() {
  $("modeMenu").hidden = false;
  $("modePill").setAttribute("aria-expanded", "true");
}
function closeModeMenu() {
  $("modeMenu").hidden = true;
  $("modePill").setAttribute("aria-expanded", "false");
}
function toggleModeMenu() {
  if ($("modeMenu").hidden) openModeMenu(); else closeModeMenu();
}

function wireModePill() {
  $("modePill").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleModeMenu();
  });
  $("modeMenu").addEventListener("click", async (e) => {
    const btn = e.target.closest(".menu-item");
    if (!btn) return;
    const mode = btn.dataset.mode;
    closeModeMenu();
    if (mode === settings.mode) return;
    await saveSetting("mode", mode);
    renderMode();
  });
  // Outside click + Escape close the menu.
  document.addEventListener("click", (e) => {
    if (!$("modeMenu").hidden && !e.target.closest(".mode-pill-wrap")) closeModeMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModeMenu();
  });
}

// ─── Cloud / On-Device toggle ─────────────────────────────────────────
//
// This toggle is the user-facing surface for `reasoningSource`. On-device
// = local (Transformers.js VLM if vlmEnabled, otherwise the router refuses
// cloud). Cloud = byok (Gemini/OpenAI/Groq with the stored API key).
// `onDeviceOnly` mirrors the state for anything that still reads the
// legacy boolean.

function renderDeviceToggle() {
  const onDevice = settings.reasoningSource
    ? settings.reasoningSource === "local"
    : settings.onDeviceOnly !== false;
  $("deviceToggle").setAttribute("data-on-device", onDevice ? "true" : "false");
  $("deviceToggle").setAttribute(
    "aria-label",
    onDevice ? "On-Device (click to switch to Cloud)" : "Cloud (click to switch to On-Device)"
  );
  const sdv = $("settingsDeviceValue");
  if (sdv) sdv.textContent = onDevice ? "On-Device" : "Cloud";
}

function wireDeviceToggle() {
  $("deviceToggle").addEventListener("click", async () => {
    const currentlyOnDevice = settings.reasoningSource
      ? settings.reasoningSource === "local"
      : settings.onDeviceOnly !== false;
    const nextSource = currentlyOnDevice ? "byok" : "local";
    await saveSetting("reasoningSource", nextSource);
    await saveSetting("onDeviceOnly", nextSource === "local");
    renderDeviceToggle();
  });
}

// ─── Settings gear ────────────────────────────────────────────────────

function openSettings() {
  $("emptyState").hidden = true;
  $("receiptView").hidden = true;
  $("settingsView").hidden = false;
  renderMode();
  renderDeviceToggle();
  renderVlmToggle();
  renderByok();
}
function closeSettings() {
  $("settingsView").hidden = true;
  // Return to whichever body view was showing before settings opened.
  if (lastReceipt) {
    $("receiptView").hidden = false;
  } else {
    $("emptyState").hidden = false;
  }
}

function wireSettings() {
  $("settingsBtn").addEventListener("click", openSettings);
  $("settingsBackBtn").addEventListener("click", closeSettings);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("settingsView").hidden) closeSettings();
  });
}

// ─── Privacy scan + receipt ──────────────────────────────────────────

let scanInFlight = false;
let lastReceipt = null;

function openReceiptView() {
  $("emptyState").hidden = true;
  $("settingsView").hidden = true;
  $("receiptView").hidden = false;
}
function closeReceiptView() {
  $("receiptView").hidden = true;
  $("emptyState").hidden = false;
}

function renderReceipt(result) {
  const { counts, redaction, totalMs, capture } = result;
  $("receiptTotal").textContent = String(counts.total);

  const list = $("receiptList");
  list.innerHTML = "";
  const kinds = Object.keys(counts.perKind).sort((a, b) => counts.perKind[b] - counts.perKind[a]);
  if (kinds.length === 0) {
    const li = document.createElement("li");
    li.className = "receipt-list-empty";
    li.textContent = "No PII detected on this page.";
    list.appendChild(li);
  } else {
    for (const k of kinds) {
      const li = document.createElement("li");
      li.className = "receipt-item";
      li.innerHTML =
        `<span class="receipt-item-dot" aria-hidden="true"></span>` +
        `<span class="receipt-item-label">${KIND_LABEL[k] || k}</span>` +
        `<span class="receipt-item-count">${counts.perKind[k]}</span>`;
      list.appendChild(li);
    }
  }

  const previewWrap = $("receiptPreviewWrap");
  const preview = $("receiptPreview");
  if (redaction && redaction.dataUrl) {
    preview.src = redaction.dataUrl;
    previewWrap.hidden = false;
  } else {
    previewWrap.hidden = true;
  }

  const meta = [];
  meta.push(`DOM: ${counts.perSource.dom}`);
  meta.push(`Faces: ${counts.perSource.blazeface}`);
  meta.push(`OCR: ${counts.perSource.ocr}`);
  meta.push(`Total: ${totalMs.toFixed(0)} ms`);
  if (capture && capture.page) meta.push(new URL(capture.page.url).hostname);
  $("receiptMeta").textContent = meta.join(" • ");
}

async function runScan() {
  if (scanInFlight) return;
  scanInFlight = true;
  const scanBtn = $("scanBtn");
  const rescanBtn = $("receiptRescanBtn");
  if (scanBtn) { scanBtn.disabled = true; scanBtn.textContent = "Scanning…"; }
  if (rescanBtn) { rescanBtn.disabled = true; rescanBtn.textContent = "Scanning…"; }
  try {
    const result = await runPrivacyPipeline({
      onPhase: (phase) => {
        const label =
          phase === "capturing" ? "Capturing screen…" :
          phase === "detecting" ? "Detecting PII (faces + OCR)…" :
          phase === "redacting" ? "Redacting…" : phase;
        if (scanBtn) scanBtn.textContent = label;
        if (rescanBtn) rescanBtn.textContent = label;
      },
    });
    lastReceipt = result;
    renderReceipt(result);
    openReceiptView();
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error("[friday.sidepanel] scan failed:", err);
    // Show error inline on the empty-state so the user isn't lost.
    if (scanBtn) scanBtn.textContent = `Scan failed — ${msg.slice(0, 40)}`;
    setTimeout(() => { if (scanBtn) scanBtn.textContent = "Run privacy scan"; }, 4000);
  } finally {
    scanInFlight = false;
    if (scanBtn) { scanBtn.disabled = false; if (!scanBtn.textContent.startsWith("Scan failed")) scanBtn.textContent = "Run privacy scan"; }
    if (rescanBtn) { rescanBtn.disabled = false; rescanBtn.textContent = "Scan again"; }
  }
}

function wireReceipt() {
  const scanBtn = $("scanBtn");
  if (scanBtn) scanBtn.addEventListener("click", runScan);
  $("receiptCloseBtn").addEventListener("click", closeReceiptView);
  $("receiptRescanBtn").addEventListener("click", runScan);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("receiptView").hidden) closeReceiptView();
  });
}

// Re-add "Run privacy scan" button after we replaced emptyState innerHTML —
// safe because sidepanel.html now declares #scanBtn directly.

// ─── VLM opt-in + first-run download ─────────────────────────────────

function renderVlmToggle() {
  const enabled = !!settings.vlmEnabled;
  const cb = $("vlmToggle");
  if (cb) cb.checked = enabled;
  const body = $("vlmBody");
  if (body) body.hidden = !enabled;
  updateVlmStatusLine();
}

function updateVlmStatusLine() {
  const status = $("vlmStatus");
  if (!status) return;
  if (modelState.model) {
    const mb = (modelState.downloadedBytes / 1024 / 1024).toFixed(1);
    const cacheState = modelState.downloadedBytes === 0 ? "cached (no download)" : `downloaded ${mb} MB`;
    status.textContent = `Loaded on ${modelState.backend} in ${(modelState.loadMs / 1000).toFixed(1)}s (${cacheState}).`;
    $("vlmDownloadBtn").textContent = "Reload";
  } else if (!settings.vlmEnabled) {
    status.textContent = "Disabled.";
  } else {
    status.textContent = "Not downloaded yet.";
  }
}

async function onVlmToggleChange(e) {
  const enabled = !!e.target.checked;
  await saveSetting("vlmEnabled", enabled);
  renderVlmToggle();
}

async function onVlmDownload() {
  const btn = $("vlmDownloadBtn");
  const bar = $("vlmProgress");
  const status = $("vlmStatus");
  btn.disabled = true;
  bar.hidden = false;
  bar.value = 0;
  status.textContent = "Checking WebGPU…";

  const gpu = await detectWebGPU();
  status.textContent = gpu.available
    ? `WebGPU ready (${gpu.vendor}/${gpu.architecture}). Loading model…`
    : `WebGPU unavailable — using WASM. Loading model…`;

  try {
    await loadModel({
      preferWebGPU: gpu.available,
      onProgress: (evt) => {
        if (evt.total > 0) {
          bar.value = evt.pct;
          status.textContent = `Downloading… ${evt.mbLoaded.toFixed(1)} / ${evt.mbTotal.toFixed(1)} MB (${evt.pct.toFixed(0)}%)`;
        }
      },
    });
    bar.value = 100;
    updateVlmStatusLine();
  } catch (err) {
    status.textContent = `Load failed — ${err && err.message ? err.message : err}`;
  } finally {
    btn.disabled = false;
    setTimeout(() => { bar.hidden = true; }, 800);
  }
}

function wireVlm() {
  $("vlmToggle").addEventListener("change", onVlmToggleChange);
  $("vlmDownloadBtn").addEventListener("click", onVlmDownload);
}

// ─── BYOK (Cloud API key) ─────────────────────────────────────────────

const BYOK_DEFAULT_MODEL = { gemini: "gemini-2.0-flash", openai: "gpt-4o-mini", groq: "llama-3.2-11b-vision-preview" };

function renderByok() {
  const providerSel = $("byokProviderSel");
  const keyInput = $("byokApiKeyInput");
  const modelInput = $("byokModelInput");
  const status = $("byokStatus");
  if (!providerSel) return;
  providerSel.value = settings.byokProvider || "gemini";
  keyInput.value = settings.byokApiKey || "";
  modelInput.value = settings.byokModel || "";
  modelInput.placeholder = `Model (default: ${BYOK_DEFAULT_MODEL[providerSel.value]})`;
  if (settings.byokApiKey) {
    status.textContent = `Key set for ${providerSel.value}.`;
    status.classList.add("byok-status--set");
  } else {
    status.textContent = "No key set.";
    status.classList.remove("byok-status--set");
  }
}

async function onByokSave() {
  const provider = $("byokProviderSel").value;
  const apiKey = $("byokApiKeyInput").value.trim();
  const model = $("byokModelInput").value.trim();
  await saveSetting("byokProvider", provider);
  await saveSetting("byokApiKey", apiKey);
  await saveSetting("byokModel", model);
  renderByok();
}

function wireByok() {
  const providerSel = $("byokProviderSel");
  if (!providerSel) return;
  providerSel.addEventListener("change", () => {
    // Update placeholder when provider changes so the user sees the right default.
    const modelInput = $("byokModelInput");
    modelInput.placeholder = `Model (default: ${BYOK_DEFAULT_MODEL[providerSel.value]})`;
  });
  $("byokSaveBtn").addEventListener("click", onByokSave);
}

// ─── Boot ─────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  renderMode();
  renderDeviceToggle();
  wireModePill();
  wireDeviceToggle();
  wireSettings();
  wireVlm();
  wireByok();
  wireReceipt();
});
