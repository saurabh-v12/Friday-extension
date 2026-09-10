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

function renderDeviceToggle() {
  const onDevice = settings.onDeviceOnly !== false;
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
    const next = !(settings.onDeviceOnly !== false);
    await saveSetting("onDeviceOnly", next);
    renderDeviceToggle();
  });
}

// ─── Settings gear ────────────────────────────────────────────────────

function openSettings() {
  $("emptyState").hidden = true;
  $("settingsView").hidden = false;
  renderMode();
  renderDeviceToggle();
  renderVlmToggle();
}
function closeSettings() {
  $("settingsView").hidden = true;
  $("emptyState").hidden = false;
}

function wireSettings() {
  $("settingsBtn").addEventListener("click", openSettings);
  $("settingsBackBtn").addEventListener("click", closeSettings);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("settingsView").hidden) closeSettings();
  });
}

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

// ─── Boot ─────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  renderMode();
  renderDeviceToggle();
  wireModePill();
  wireDeviceToggle();
  wireSettings();
  wireVlm();
});
