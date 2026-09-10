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
import { runAgent, needsPage, DEFAULT_MAX_STEPS } from "./agent.js";
import { SOURCES } from "./router.js";
import { isSttSupported, startDictation, speak, isTtsSupported, startWakeWord } from "./voice.js";

const $ = (id) => document.getElementById(id);

const MODE_LABELS = { chat: "Chat", agent: "Agent" };

let settings = { ...SETTING_DEFAULTS };

// ─── View state machine (FIX 3) ──────────────────────────────────────
//
// Exactly one of: 'home' | 'run' | 'receipt' | 'settings'. Everything
// else is derived from this — CSS shows one section, hides the others.
// Replaces the old per-section `.hidden = true` toggles, which lost a
// specificity race with `.run-view { display: flex; }` and let the run
// card ghost through as an empty "TASK ✕" bar on the home screen.
const VIEWS = Object.freeze({ HOME: "home", RUN: "run", RECEIPT: "receipt", SETTINGS: "settings" });

function setView(name) {
  document.body.dataset.view = name;
}
function getView() { return document.body.dataset.view || VIEWS.HOME; }

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
  setView(VIEWS.SETTINGS);
  renderMode();
  renderDeviceToggle();
  renderVlmToggle();
  renderByok();
  renderMcp();
}
function closeSettings() {
  // The X (and Escape) always returns to home. Simpler mental model than
  // remembering the previous view — receipt and run are one click away.
  setView(VIEWS.HOME);
}

function wireSettings() {
  $("settingsBtn").addEventListener("click", openSettings);
  $("settingsBackBtn").addEventListener("click", closeSettings);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && getView() === VIEWS.SETTINGS) closeSettings();
  });
}

// ─── Agent run (Task 4.4) ─────────────────────────────────────────────

let agentInFlight = false;

function openRunView(task) {
  $("runTask").textContent = task;
  $("runTrace").innerHTML = "";
  const finalEl = $("runFinal");
  finalEl.hidden = true;
  finalEl.classList.remove("run-final--error");
  setView(VIEWS.RUN);
}

function closeRunView() {
  setView(VIEWS.HOME);
}

function appendTraceRow(html, cls = "") {
  const div = document.createElement("div");
  div.className = `trace-step ${cls}`.trim();
  div.innerHTML = html;
  $("runTrace").appendChild(div);
  div.scrollIntoView({ behavior: "smooth", block: "nearest" });
  return div;
}

function renderStopFinal(evt) {
  const finalEl = $("runFinal");
  const isError = evt.reason && evt.reason.startsWith("exec failed");
  finalEl.hidden = false;
  finalEl.classList.toggle("run-final--error", isError);
  const label = isError ? "Stopped" : "Done";
  const body = evt.output || evt.reason || "";
  finalEl.innerHTML = `<strong>${label}.</strong>${body ? " " + escapeHtml(body) : ""}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

async function onSubmitComposer(e) {
  e && e.preventDefault && e.preventDefault();
  if (agentInFlight) return;
  const input = $("composerInput");
  const task = (input.value || "").trim();
  if (!task) return;
  input.value = "";

  const source = settings.reasoningSource || "local";
  const mode = settings.mode || "chat";
  const willNeedPage = needsPage(task, mode);

  const cloudUnusable = source === "byok" && !settings.byokApiKey;
  if (cloudUnusable) {
    openRunView(task);
    appendTraceRow(
      `<div class="trace-step-body"><div class="trace-step-title">Cloud selected but no API key.</div><div class="trace-step-meta">Open Settings → Cloud API key to paste one, or switch the header toggle back to On-Device.</div></div>`,
      "trace-step--error",
    );
    return;
  }
  // Warn only for page tasks — chat-only won't try to load the VLM at all
  // (router surfaces a friendly `say` telling the user to switch to Cloud).
  if (willNeedPage && source === "local" && !settings.vlmEnabled) {
    openRunView(task);
    appendTraceRow(
      `<div class="trace-step-body"><div class="trace-step-title">On-Device mode without VLM.</div><div class="trace-step-meta">Enable "Local VLM (optional)" in Settings, or switch the header toggle to Cloud (BYOK) — otherwise the router has no reasoning source.</div></div>`,
      "trace-step--error",
    );
    return;
  }

  agentInFlight = true;
  setComposerBusy(true);
  openRunView(task);
  let currentObserveDiv = null;
  try {
    const result = await runAgent({
      task,
      mode,
      source,
      config: source === "byok" ? {
        provider: settings.byokProvider,
        apiKey: settings.byokApiKey,
        model: settings.byokModel,
      } : {},
      mcpServers: parseMcpServers(),
      maxSteps: DEFAULT_MAX_STEPS,
      onStep: (evt) => {
        if (evt.phase === "chat-only") {
          appendTraceRow(
            `<div class="trace-step-body">Answering (no page context)…</div>`,
            "trace-step--observing",
          );
        } else if (evt.phase === "observe") {
          currentObserveDiv = appendTraceRow(
            `<div class="trace-step-body">Step ${evt.step} — capturing + detecting…</div>`,
            "trace-step--observing",
          );
        } else if (evt.phase === "reason") {
          if (currentObserveDiv) currentObserveDiv.remove();
          currentObserveDiv = null;
          const a = evt.action || {};
          const title =
            a.type === "click" ? `Click <code>${escapeHtml(a.fid || "?")}</code>` :
            a.type === "type" ? `Type into <code>${escapeHtml(a.fid || "?")}</code>` :
            a.type === "scroll" ? `Scroll to <code>${escapeHtml(a.fid || "?")}</code>` :
            a.type === "mcp" ? `Call MCP <code>${escapeHtml(a.server || "?")}.${escapeHtml(a.tool || "?")}</code>` :
            a.type === "say" ? "Reply" :
            a.type === "stop" ? "Task complete" : (a.type || "?");
          const meta = [
            `${evt.latencyMs.toFixed(0)} ms`,
            evt.source,
            evt.model || "",
          ].filter(Boolean).join(" · ");
          const reasoning = a.reasoning ? `<div class="trace-step-reasoning">${escapeHtml(a.reasoning)}</div>` : "";
          appendTraceRow(
            `<div class="trace-step-num">${evt.step}</div>` +
            `<div class="trace-step-body">` +
              `<div class="trace-step-title">${title}</div>` +
              `<div class="trace-step-meta">${meta}</div>` +
              reasoning +
            `</div>`,
          );
        } else if (evt.phase === "act" && evt.execError) {
          appendTraceRow(
            `<div class="trace-step-body"><div class="trace-step-title">Execution failed</div><div class="trace-step-meta">${escapeHtml(evt.execError)}</div></div>`,
            "trace-step--error",
          );
        } else if (evt.phase === "stop") {
          renderStopFinal(evt);
          maybeSpeakFinal(evt);
        } else if (evt.phase === "error") {
          const finalEl = $("runFinal");
          finalEl.hidden = false;
          finalEl.classList.add("run-final--error");
          finalEl.textContent = evt.message;
        }
      },
    });
    if (result.final && result.final.type === "error" && !$("runFinal").textContent) {
      const finalEl = $("runFinal");
      finalEl.hidden = false;
      finalEl.classList.add("run-final--error");
      finalEl.textContent = result.final.message;
    }
  } catch (err) {
    const finalEl = $("runFinal");
    finalEl.hidden = false;
    finalEl.classList.add("run-final--error");
    const raw = err && err.message ? err.message : String(err);
    finalEl.textContent = friendlyError(raw);
  } finally {
    agentInFlight = false;
    setComposerBusy(false);
  }
}

function setComposerBusy(busy) {
  const sendBtn = $("sendBtn");
  const input = $("composerInput");
  if (sendBtn) sendBtn.disabled = busy;
  if (input) input.disabled = busy;
}

// Turn low-level errors into something a user can act on.
function friendlyError(msg) {
  if (!msg) return "Unknown error.";
  if (/http\(s\) only/i.test(msg)) {
    return "This page can't be inspected (chrome:// or extension pages are locked out by the browser). Open a normal website tab and try again.";
  }
  if (/no active tab/i.test(msg)) {
    return "No active browser tab. Click into a website tab, then re-run the task.";
  }
  if (/api key/i.test(msg)) {
    return "Cloud API key issue. Open Settings and paste a valid key for your chosen provider.";
  }
  if (/MCP/i.test(msg)) {
    return `${msg} — check Settings → MCP servers.`;
  }
  return msg;
}

function wireComposer() {
  const composer = $("composer");
  if (composer) composer.addEventListener("submit", onSubmitComposer);
  const closeBtn = $("runCloseBtn");
  if (closeBtn) closeBtn.addEventListener("click", closeRunView);
}

// ─── Voice: STT (5.1) + wake word (5.2) + TTS (5.3) ──────────────────

let dictationSession = null;
let wakeSession = null;

function setMicState(state) {
  const micBtn = $("micBtn");
  if (!micBtn) return;
  micBtn.dataset.state = state; // 'idle' | 'listening' | 'wake'
  micBtn.setAttribute(
    "aria-pressed",
    state === "listening" || state === "wake" ? "true" : "false"
  );
  micBtn.setAttribute(
    "aria-label",
    state === "listening" ? "Listening — click to stop"
      : state === "wake" ? "Wake word active — click for one-shot"
      : "Voice input",
  );
}

function onMicClick() {
  if (dictationSession) {
    dictationSession.stop();
    dictationSession = null;
    setMicState(wakeSession ? "wake" : "idle");
    return;
  }
  if (!isSttSupported()) {
    // No STT — give the composer focus as a fallback.
    const inp = $("composerInput");
    if (inp) inp.focus();
    return;
  }
  const input = $("composerInput");
  setMicState("listening");
  dictationSession = startDictation({
    onInterim: (text) => { if (input) input.value = text; },
    onFinal: (text) => {
      if (input) input.value = text;
      dictationSession = null;
      setMicState(wakeSession ? "wake" : "idle");
      // Auto-submit like the send button — the user's finger is off the mic
      // by the time this fires, so a quiet auto-submit is the whole point.
      onSubmitComposer({ preventDefault() {} });
    },
    onError: (err) => {
      console.warn("[friday.voice] STT error:", err);
      dictationSession = null;
      setMicState(wakeSession ? "wake" : "idle");
    },
    onEnd: () => {
      dictationSession = null;
      if (!wakeSession) setMicState("idle");
    },
  });
}

function onMicLongPress() {
  if (wakeSession) {
    wakeSession.stop();
    wakeSession = null;
    setMicState("idle");
    return;
  }
  if (!isSttSupported()) return;
  wakeSession = startWakeWord({
    phrase: "hey friday",
    onWake: () => {
      // Give the user a subtle audio ack; TTS is quicker than a beep here.
      speak("Yes?");
    },
    onTask: (task) => {
      if (!task) return;
      const input = $("composerInput");
      if (input) input.value = task;
      onSubmitComposer({ preventDefault() {} });
    },
    onError: (err) => console.warn("[friday.voice] wake-word error:", err),
  });
  setMicState("wake");
}

function wireVoice() {
  const micBtn = $("micBtn");
  if (!micBtn) return;
  setMicState("idle");
  // Left-click: one-shot dictation. Long-press / right-click: wake word.
  let pressTimer = null;
  let longPressed = false;
  micBtn.addEventListener("mousedown", () => {
    longPressed = false;
    pressTimer = setTimeout(() => { longPressed = true; onMicLongPress(); }, 600);
  });
  micBtn.addEventListener("mouseup", () => {
    if (pressTimer) clearTimeout(pressTimer);
    if (longPressed) return;
    onMicClick();
  });
  micBtn.addEventListener("mouseleave", () => { if (pressTimer) clearTimeout(pressTimer); });
  micBtn.addEventListener("contextmenu", (e) => { e.preventDefault(); onMicLongPress(); });
}

// After each agent run's final message, speak it via OS TTS.
function maybeSpeakFinal(evt) {
  if (!isTtsSupported()) return;
  if (!settings || settings.mode === "chat") return; // opinion: speak in agent mode only
  const text = evt.output || evt.reason || "";
  if (text) speak(text);
}

// ─── Privacy scan + receipt ──────────────────────────────────────────

let scanInFlight = false;
let lastReceipt = null;

function openReceiptView() {
  setView(VIEWS.RECEIPT);
}
function closeReceiptView() {
  setView(VIEWS.HOME);
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
    const short = friendlyError(msg).slice(0, 80);
    if (scanBtn) scanBtn.textContent = `Scan failed — ${short}`;
    setTimeout(() => { if (scanBtn) scanBtn.textContent = "Run privacy scan"; }, 5000);
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
    if (e.key === "Escape" && getView() === VIEWS.RECEIPT) closeReceiptView();
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
//
// Model picker fetches the LIVE model list from each provider's /models
// endpoint whenever a key is present. Hardcoded fallbacks (KNOWN_MODELS)
// only show up before the user pastes a key. This eliminates the whole
// class of "Friday sent a model id the provider retired last quarter"
// bugs — the dropdown is always what the account actually has access to.
//
// A "Custom…" option preserves the escape hatch for pre-release model
// ids that aren't in the public list yet.

import { DEFAULT_MODELS as BYOK_DEFAULT_MODELS, KNOWN_MODELS as BYOK_KNOWN_MODELS, listModels as byokListModels } from "./byok.js";

const CUSTOM_MODEL_VALUE = "__custom__";
// Cache the last live fetch per (provider, apiKey) so opening + closing
// Settings doesn't re-hit the provider every time. Cleared on Refresh.
const liveModelsCache = new Map();
function cacheKey(provider, apiKey) { return `${provider}:${apiKey || ""}`; }

function setByokStatus(text, kind /* "info" | "ok" | "error" */) {
  const el = $("byokStatus");
  if (!el) return;
  el.textContent = text;
  el.classList.remove("byok-status--set", "byok-status--error");
  if (kind === "ok") el.classList.add("byok-status--set");
  if (kind === "error") el.classList.add("byok-status--error");
}

function fillByokSelect(provider, options, { live } = { live: false }) {
  const sel = $("byokModelSel");
  if (!sel) return;
  sel.innerHTML = "";
  const currentSaved = (settings.byokModel || "").trim();
  const ids = options.map((o) => (typeof o === "string" ? o : o.id));
  for (const opt of options) {
    const id = typeof opt === "string" ? opt : opt.id;
    const el = document.createElement("option");
    el.value = id;
    const isDefault = !live && id === BYOK_DEFAULT_MODELS[provider];
    el.textContent = isDefault ? `${id}  (default)` : id;
    sel.appendChild(el);
  }
  const customOpt = document.createElement("option");
  customOpt.value = CUSTOM_MODEL_VALUE;
  customOpt.textContent = "Custom…";
  sel.appendChild(customOpt);

  if (currentSaved && ids.includes(currentSaved)) {
    sel.value = currentSaved;
  } else if (currentSaved && !ids.includes(currentSaved)) {
    // User has a saved id the live list doesn't include — keep it usable
    // via Custom so we don't silently drop it.
    sel.value = CUSTOM_MODEL_VALUE;
  } else if (live && options.length) {
    sel.value = ids[0]; // first live model, alphabetical
  } else {
    sel.value = BYOK_DEFAULT_MODELS[provider] || ids[0] || "";
  }
  updateByokCustomVisibility();
}

function updateByokCustomVisibility() {
  const sel = $("byokModelSel");
  const custom = $("byokModelCustom");
  if (!sel || !custom) return;
  const isCustom = sel.value === CUSTOM_MODEL_VALUE;
  custom.hidden = !isCustom;
  if (isCustom && !custom.value) custom.value = (settings.byokModel || "").trim();
}

async function fetchByokModels(provider, apiKey, { force = false } = {}) {
  const sel = $("byokModelSel");
  const refreshBtn = $("byokRefreshBtn");
  if (!provider || !apiKey) {
    fillByokSelect(provider, BYOK_KNOWN_MODELS[provider] || [], { live: false });
    setByokStatus("Enter a key to load the live model list.", "info");
    return;
  }
  const key = cacheKey(provider, apiKey);
  if (!force && liveModelsCache.has(key)) {
    fillByokSelect(provider, liveModelsCache.get(key), { live: true });
    setByokStatus(`${liveModelsCache.get(key).length} model(s) available (cached).`, "ok");
    return;
  }
  if (sel) sel.disabled = true;
  if (refreshBtn) refreshBtn.disabled = true;
  setByokStatus(`Fetching ${provider} models…`, "info");
  try {
    const list = await byokListModels({ provider, apiKey });
    if (!list.length) throw new Error("provider returned an empty model list");
    liveModelsCache.set(key, list);
    fillByokSelect(provider, list, { live: true });
    setByokStatus(`${list.length} model(s) available.`, "ok");
  } catch (err) {
    // Don't silently fall back to a hardcoded default — that's how we got
    // into this mess. Surface the error so the user sees "bad key" vs
    // "network" vs "provider outage" and fixes the root cause.
    const msg = err && err.message ? err.message : String(err);
    setByokStatus(`Fetch failed — ${msg.slice(0, 140)}`, "error");
    // Keep the Custom option available so the user can still type a model
    // id manually while they debug the key. Do NOT auto-populate stale
    // ids: an empty dropdown + Custom is honest about what we know.
    fillByokSelect(provider, [], { live: true });
  } finally {
    if (sel) sel.disabled = false;
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

function renderByok() {
  const providerSel = $("byokProviderSel");
  const keyInput = $("byokApiKeyInput");
  if (!providerSel) return;
  const provider = settings.byokProvider || "gemini";
  providerSel.value = provider;
  keyInput.value = settings.byokApiKey || "";
  // Fire and forget — the async fetch updates status + dropdown when it
  // resolves; the UI stays responsive in the meantime.
  fetchByokModels(provider, settings.byokApiKey);
}

async function onByokSave() {
  const provider = $("byokProviderSel").value;
  const apiKey = $("byokApiKeyInput").value.trim();
  const sel = $("byokModelSel");
  const custom = $("byokModelCustom");
  let model = "";
  if (sel.value === CUSTOM_MODEL_VALUE) {
    model = (custom.value || "").trim();
  } else if (sel.value) {
    model = sel.value;
  }
  // Belt-and-braces — byok.js's callByok also rejects this, but catching
  // it at save time gives the user immediate feedback.
  if (model && ["gemini", "openai", "groq"].includes(model.toLowerCase())) {
    setByokStatus(`"${model}" is a provider name, not a model id — clearing so the default applies.`, "error");
    model = "";
  }
  const providerChanged = provider !== settings.byokProvider;
  const keyChanged = apiKey !== settings.byokApiKey;
  await saveSetting("byokProvider", provider);
  await saveSetting("byokApiKey", apiKey);
  await saveSetting("byokModel", model);
  // If the provider or key changed, refresh the live list so the dropdown
  // reflects the new account. If only the model changed, no refresh
  // needed.
  if (providerChanged || keyChanged) {
    await fetchByokModels(provider, apiKey, { force: true });
  } else {
    setByokStatus(model ? `Saved. Using ${model}.` : "Saved.", "ok");
  }
}

function wireByok() {
  const providerSel = $("byokProviderSel");
  if (!providerSel) return;
  providerSel.addEventListener("change", () => {
    // Fetch immediately on provider change if we already have a key —
    // the user shouldn't have to click Save just to see the model list.
    const apiKey = $("byokApiKeyInput").value.trim();
    fetchByokModels(providerSel.value, apiKey);
  });
  const sel = $("byokModelSel");
  if (sel) sel.addEventListener("change", updateByokCustomVisibility);
  $("byokSaveBtn").addEventListener("click", onByokSave);
  const refresh = $("byokRefreshBtn");
  if (refresh) {
    refresh.addEventListener("click", () => {
      const provider = $("byokProviderSel").value;
      const apiKey = $("byokApiKeyInput").value.trim();
      fetchByokModels(provider, apiKey, { force: true });
    });
  }
}

// ─── MCP servers ─────────────────────────────────────────────────────

function parseMcpServers() {
  try {
    const arr = JSON.parse(settings.mcpServers || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function renderMcp() {
  const input = $("mcpServersInput");
  const status = $("mcpStatus");
  if (!input) return;
  input.value = settings.mcpServers || "[]";
  const arr = parseMcpServers();
  if (arr.length === 0) {
    status.textContent = "No servers configured.";
    status.classList.remove("byok-status--set");
  } else {
    status.textContent = `${arr.length} server(s) configured.`;
    status.classList.add("byok-status--set");
  }
}

async function onMcpSave() {
  const input = $("mcpServersInput");
  const status = $("mcpStatus");
  let value = (input.value || "[]").trim();
  try {
    const arr = JSON.parse(value);
    if (!Array.isArray(arr)) throw new Error("must be a JSON array");
    // Normalise — ensure required fields.
    for (const s of arr) {
      if (!s.url) throw new Error("each server needs a url");
    }
    value = JSON.stringify(arr, null, 2);
    await saveSetting("mcpServers", value);
    input.value = value;
    renderMcp();
  } catch (err) {
    status.textContent = `Parse error: ${err.message}`;
    status.classList.remove("byok-status--set");
  }
}

function wireMcp() {
  const btn = $("mcpSaveBtn");
  if (btn) btn.addEventListener("click", onMcpSave);
}

// ─── Boot ─────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  setView(VIEWS.HOME);
  await loadSettings();
  renderMode();
  renderDeviceToggle();
  wireModePill();
  wireDeviceToggle();
  wireSettings();
  wireVlm();
  wireByok();
  wireMcp();
  wireReceipt();
  wireComposer();
  wireVoice();
});
