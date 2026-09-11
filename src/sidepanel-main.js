// Friday side panel entry.
// Task 1.3: wire header controls to settings + persistence via BG messaging.
// Task 1.6: optional local-VLM opt-in inside settings, with first-run
//           download + progress bar and cache-reuse on subsequent loads.
//
// - Chat/Agent pill        → dropdown menu, updates label, persists `mode`.
// - Cloud/On-Device toggle → flips `data-on-device`, persists `onDeviceOnly`.
// - Settings gear          → toggles the body between settings and the
//                            previous view (home / run / receipt).
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
import {
  ensureMicrophonePermission,
  isSttSupported,
  startDictation,
  speak,
  isTtsSupported,
  startWakeWord,
} from "./voice.js";
import { runChatTurn } from "./chatAgent.js";
import { supportsToolCalling, chatPlain } from "./byok.js";
import { matchShortcut, runShortcut } from "./shortcuts.js";
import { matchPageAnswer, runPageAnswer } from "./pageAnswers.js";
import {
  DEFAULT_LOCAL_LLM_MODEL,
  LOCAL_LLM_MODELS,
  chatLocalPlain,
  detectLocalLlmSupport,
  ensureLocalLlm,
  localLlmState,
  normalizeLocalModel,
} from "./localLlm.js";
import { runLocalAgentTurn } from "./localAgent.js";

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
  renderModelLabel();
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
  renderLocalLlm();
  renderVlmToggle();
  renderByok();
  renderMcp();
}
function closeSettings() {
  setView(VIEWS.HOME);
}

function wireSettings() {
  $("settingsBtn").addEventListener("click", openSettings);
  $("settingsBackBtn")?.addEventListener("click", closeSettings);
  $("settingsCloseBtn")?.addEventListener("click", closeSettings);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && getView() === VIEWS.SETTINGS) closeSettings();
  });
}

// ─── Agent run + chat (Task 4.4 + SEEING/CONTROLLING) ────────────────

let agentInFlight = false;

// In-memory chat history — mirrors settings.chatHistory (persisted).
// Each entry is an OpenAI-shape message: {role, content, tool_calls?,
// tool_call_id?}. Trimmed to MAX_HISTORY entries at save time so
// chrome.storage.local doesn't slowly bloat.
let chatHistory = [];
const MAX_HISTORY = 40;

function loadChatHistory() {
  try {
    const raw = settings.chatHistory || "[]";
    const parsed = JSON.parse(raw);
    chatHistory = Array.isArray(parsed) ? parsed : [];
  } catch { chatHistory = []; }
}

async function persistChatHistory() {
  const trimmed = chatHistory.slice(-MAX_HISTORY);
  chatHistory = trimmed;
  await saveSetting("chatHistory", JSON.stringify(trimmed));
}

async function newChat() {
  chatHistory = [];
  await persistChatHistory();
  $("runTrace").innerHTML = "";
  $("runTask").textContent = "";
  $("runStatus").textContent = "Chat";
  const finalEl = $("runFinal");
  if (finalEl) finalEl.hidden = true;
  setView(VIEWS.HOME);
}

// Reserved: displayed only when there's no chat history (fresh boot).
function openRunView(task) {
  const trace = $("runTrace");
  const hadHistory = chatHistory.length > 0 || trace.childElementCount > 0;
  if (!hadHistory) trace.innerHTML = "";
  $("runTask").textContent = task || "";
  $("runStatus").textContent = task ? "Task" : "Chat";
  const finalEl = $("runFinal");
  finalEl.hidden = true;
  finalEl.classList.remove("run-final--error");
  setView(VIEWS.RUN);
}

function closeRunView() {
  setView(VIEWS.HOME);
}

// Re-render the trace from chatHistory. Used on boot to restore state.
function renderChatHistory() {
  const trace = $("runTrace");
  trace.innerHTML = "";
  for (const msg of chatHistory) {
    if (msg.role === "user") appendUserBubble(msg.content);
    else if (msg.role === "assistant") {
      if (msg.content) appendAssistantBubble(msg.content);
      // Tool calls from history aren't re-rendered as chips — the
      // final answer bubble is enough context. This keeps the scroll
      // clean when a long conversation is restored on reboot.
    }
  }
  if (chatHistory.length) {
    $("runStatus").textContent = "Chat";
  }
}

function appendUserBubble(text) {
  const trace = $("runTrace");
  const wrap = document.createElement("div");
  wrap.className = "chat-msg chat-msg--user";
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";
  bubble.textContent = text;
  wrap.appendChild(bubble);
  trace.appendChild(wrap);
  wrap.scrollIntoView({ behavior: "smooth", block: "end" });
}

function appendAssistantBubble(text) {
  const trace = $("runTrace");
  const wrap = document.createElement("div");
  wrap.className = "chat-msg chat-msg--assistant";
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";
  bubble.textContent = text || "(no reply)";
  wrap.appendChild(bubble);
  trace.appendChild(wrap);
  wrap.scrollIntoView({ behavior: "smooth", block: "end" });
}

function appendStatusRow(text) {
  const trace = $("runTrace");
  const row = document.createElement("div");
  row.className = "chat-status";
  row.textContent = text;
  trace.appendChild(row);
  row.scrollIntoView({ behavior: "smooth", block: "end" });
  return row;
}

function appendToolChip(name, args, result) {
  const trace = $("runTrace");
  const row = document.createElement("div");
  const isErr = result && result.ok === false;
  row.className = `chat-tool ${isErr ? "chat-tool--error" : ""}`;
  const summary = summarizeToolCall(name, args, result);
  row.innerHTML = `<span class="chat-tool-name">${escapeHtml(name)}</span> <span>${escapeHtml(summary)}</span>`;
  trace.appendChild(row);
  row.scrollIntoView({ behavior: "smooth", block: "end" });
}

function summarizeToolCall(name, args, result) {
  const shorten = (s) => (String(s || "").length > 60 ? String(s).slice(0, 60) + "…" : String(s || ""));
  if (result && result.ok === false) return `→ error: ${shorten(result.error)}`;
  if (name === "click") return `→ ${shorten(result?.message || args.target || "")}`;
  if (name === "type") return `${shorten(JSON.stringify(args.text || ""))} → ${shorten(args.target || "")}`;
  if (name === "scroll") return `${args.direction}${args.amount ? ` ${args.amount}px` : ""}`;
  if (name === "goto") return shorten(args.url || "");
  if (name === "clickOrdinal") return `${args.kind || "item"} #${args.index || "?"}${result?.title ? ` "${shorten(result.title)}"` : ""}`;
  if (name === "readText") return result?.text ? `${result.text.length} chars` : (args.target || "(page)");
  if (name === "getSnapshot") return result?.snapshot ? `${result.snapshot.elementCount} elements` : "";
  return "";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// Which submit flow to use:
//   • tool-calling chat (chatAgent.js) — the SEEING + CONTROLLING path.
//     Requires source=byok and a provider that supports OpenAI-style
//     tools (OpenAI, Groq). This is the default for cloud reasoning.
//   • legacy runAgent (agent.js + router.js) — the older vision+ReAct
//     path. Kept as fallback for Gemini or local reasoning; the composer
//     bounces through it so users still get *something* even when
//     tool-calling isn't wired up for their provider.
function pickSubmitFlow(source, provider, mode) {
  // Chat mode → plain provider chat completion (no snapshot, no tools).
  // Agent mode + tool-capable provider → the SEEING/CONTROLLING tool loop.
  // Local or anything else → legacy vision+ReAct agent path.
  if (source === "local" && mode === "chat") return "local-chat";
  if (source === "local") return "local-tools";
  if (source === "byok" && mode === "chat") return "chat-plain";
  if (source === "byok" && mode === "agent" && supportsToolCalling(provider)) return "chat-tools";
  return "legacy-agent";
}

async function onSubmitComposer(e) {
  e && e.preventDefault && e.preventDefault();
  if (agentInFlight) return;
  const input = $("composerInput");
  const task = (input.value || "").trim();
  if (!task) return;
  input.value = "";

  // Intent shortcuts — trivial commands (scroll/reload/back/forward/
  // new-tab/close-tab) execute directly without an LLM call. Cheapest
  // win against Groq's free-tier rate limit — the scroll demo alone
  // was burning 2–3 API calls per invocation via the tool loop.
  const shortcut = matchShortcut(task);
  if (shortcut) {
    agentInFlight = true;
    setComposerBusy(true);
    openRunView(task);
    appendUserBubble(task);
    try {
      const message = await runShortcut(shortcut);
      appendAssistantBubble(message);
    } catch (err) {
      const raw = err && err.message ? err.message : String(err);
      appendAssistantBubble(`Error: ${friendlyError(raw)}`);
    } finally {
      agentInFlight = false;
      setComposerBusy(false);
      $("runStatus").textContent = "Chat";
    }
    return;
  }

  const source = settings.reasoningSource || "local";
  const mode = settings.mode || "chat";
  const provider = settings.byokProvider || "gemini";
  const pageAnswer = matchPageAnswer(task);
  if (pageAnswer) {
    agentInFlight = true;
    setComposerBusy(true);
    openRunView(task);
    appendUserBubble(task);
    try {
      await runPageAnswerFlow({ task, intent: pageAnswer });
    } catch (err) {
      const raw = err && err.message ? err.message : String(err);
      appendAssistantBubble(`Error: ${friendlyError(raw)}`);
    } finally {
      agentInFlight = false;
      setComposerBusy(false);
      $("runStatus").textContent = "Chat";
    }
    return;
  }

  const flow = pickSubmitFlow(source, provider, mode);

  const cloudUnusable = source === "byok" && !settings.byokApiKey;
  if (cloudUnusable) {
    agentInFlight = true;
    setComposerBusy(true);
    openRunView(task);
    appendUserBubble(task);
    try {
      await runLocalFallbackFlow({ task, mode, reason: "Cloud has no API key, so I switched to the local LLM." });
    } catch (err) {
      const raw = err && err.message ? err.message : String(err);
      appendAssistantBubble(`Error: ${friendlyError(raw)}`);
    } finally {
      agentInFlight = false;
      setComposerBusy(false);
      $("runStatus").textContent = "Chat";
    }
    return;
  }

  agentInFlight = true;
  setComposerBusy(true);
  openRunView(task);
  appendUserBubble(task);

  try {
    if (flow === "local-chat") {
      await runLocalPlainFlow({ task });
    } else if (flow === "local-tools") {
      await runLocalToolsFlow({ task, mode });
    } else if (flow === "chat-plain") {
      await runChatPlainFlow({ task, provider });
    } else if (flow === "chat-tools") {
      await runChatToolsFlow({ task, mode, provider });
    } else {
      await runLegacyAgentFlow({ task, mode, source });
    }
  } catch (err) {
    const raw = err && err.message ? err.message : String(err);
    if (source === "byok" && isCloudLimitError(raw)) {
      await runLocalFallbackFlow({ task, mode, reason: "Cloud rate limit hit, so I switched to the local LLM." });
    } else {
      appendAssistantBubble(`Error: ${friendlyError(raw)}`);
    }
  } finally {
    // Fixes stuck-spinner from earlier build — we ALWAYS unwind here,
    // even if the flow threw or was cancelled.
    agentInFlight = false;
    setComposerBusy(false);
    $("runStatus").textContent = "Chat";
  }
}

// Page-aware answers for "what's on the screen?" and "summarize this page".
// Runs before generic chat so Chat mode can still see the active tab.
async function runPageAnswerFlow({ task, intent }) {
  const statusRow = appendStatusRow("Reading page...");
  const setStatus = (text) => { if (statusRow) statusRow.textContent = text; };
  let answer;
  try {
    answer = await runPageAnswer({
      task,
      intent,
      settings,
      onStatus: setStatus,
    });
  } finally {
    if (statusRow) statusRow.remove();
  }
  const text = answer?.text || "(no readable page content)";
  appendAssistantBubble(text);
  chatHistory.push({ role: "user", content: task });
  chatHistory.push({ role: "assistant", content: text });
  await persistChatHistory();
  if ((settings.mode || "chat") === "agent") speakIfEnabled(text);
}

// Plain chat: no snapshot, no tools. The demo happy path — Chat mode +
// BYOK → provider chat completion → answer. SEEING/CONTROLLING (the
// tool-calling loop) is reserved for Agent mode.
function localLlmIsEnabled() {
  return settings.localLlmEnabled !== false;
}

function selectedLocalLlmModel() {
  return normalizeLocalModel(settings.localLlmModel || DEFAULT_LOCAL_LLM_MODEL);
}

async function runLocalFallbackFlow({ task, mode, reason }) {
  const statusRow = appendStatusRow(reason || "Switching to local LLM...");
  try {
    await saveSetting("reasoningSource", "local");
    await saveSetting("onDeviceOnly", true);
    renderDeviceToggle();
    renderModelLabel();
    if (mode === "chat") {
      await runLocalPlainFlow({ task });
    } else {
      await runLocalToolsFlow({ task, mode });
    }
  } finally {
    if (statusRow) statusRow.remove();
  }
}

async function runLocalPlainFlow({ task }) {
  if (!localLlmIsEnabled()) {
    appendAssistantBubble("Local LLM is disabled. Open Settings and enable Local LLM to keep working offline.");
    return;
  }
  const statusRow = appendStatusRow("Loading local LLM...");
  const setStatus = (text) => { if (statusRow) statusRow.textContent = text; };
  const messages = [
    { role: "system", content: "You are Friday, a concise local browser assistant running fully on this laptop." },
    ...chatHistory.slice(-8).filter((m) => ["user", "assistant"].includes(m.role) && typeof m.content === "string"),
    { role: "user", content: task },
  ];
  let text = "";
  try {
    text = await chatLocalPlain({
      modelId: selectedLocalLlmModel(),
      messages,
      onProgress: (p) => setStatus(`${p.text || "Loading local LLM"} ${p.pct ? `(${p.pct.toFixed(0)}%)` : ""}`.trim()),
    });
  } finally {
    if (statusRow) statusRow.remove();
  }
  appendAssistantBubble(text || "(empty local reply)");
  chatHistory.push({ role: "user", content: task });
  chatHistory.push({ role: "assistant", content: text || "" });
  await persistChatHistory();
}

async function runLocalToolsFlow({ task, mode }) {
  if (!localLlmIsEnabled()) {
    appendAssistantBubble("Local LLM is disabled. Open Settings and enable Local LLM to keep working offline.");
    return;
  }
  const statusRow = appendStatusRow("Loading local agent...");
  const setStatus = (text) => { if (statusRow) statusRow.textContent = text; };

  const { text, assistantMessage } = await runLocalAgentTurn({
    userMessage: task,
    history: chatHistory,
    mode,
    modelId: selectedLocalLlmModel(),
    onEvent: (evt) => {
      if (evt.phase === "local-load") {
        setStatus(`${evt.text || "Loading local LLM"} ${evt.pct ? `(${evt.pct.toFixed(0)}%)` : ""}`.trim());
      } else if (evt.phase === "snapshot") {
        if (evt.ok) setStatus(`Local agent sees ${evt.elementCount} elements`);
        else setStatus("Local agent has no page context");
      } else if (evt.phase === "model-call") {
        setStatus(`Local reasoning (step ${evt.step})...`);
      } else if (evt.phase === "tool-call") {
        setStatus(`Running local tool: ${evt.name}`);
      } else if (evt.phase === "tool-result") {
        appendToolChip(evt.name, evt.args || {}, evt.result || {});
      }
    },
  });

  if (statusRow) statusRow.remove();
  appendAssistantBubble(text || "(empty local reply)");
  chatHistory.push({ role: "user", content: task });
  chatHistory.push({
    role: "assistant",
    content: assistantMessage && assistantMessage.content ? assistantMessage.content : text || "",
  });
  await persistChatHistory();
  if (mode === "agent") speakIfEnabled(text);
}

async function runChatPlainFlow({ task, provider }) {
  const statusRow = appendStatusRow("Thinking…");
  const messages = [
    { role: "system", content: "You are Friday, a concise and helpful browser-side assistant." },
    ...chatHistory,
    { role: "user", content: task },
  ];
  let text = "";
  try {
    text = await chatPlain({
      provider,
      apiKey: settings.byokApiKey,
      model: settings.byokModel,
      messages,
    });
  } finally {
    if (statusRow) statusRow.remove();
  }
  appendAssistantBubble(text || "(empty reply)");
  chatHistory.push({ role: "user", content: task });
  chatHistory.push({ role: "assistant", content: text || "" });
  await persistChatHistory();
}

async function runChatToolsFlow({ task, mode, provider }) {
  let statusRow = appendStatusRow("Thinking…");
  const setStatus = (text) => { if (statusRow) statusRow.textContent = text; };

  const { text, toolTrace, assistantMessage } = await runChatTurn({
    userMessage: task,
    history: chatHistory,
    mode,
    provider,
    apiKey: settings.byokApiKey,
    model: settings.byokModel,
    onEvent: (evt) => {
      if (evt.phase === "snapshot") {
        if (evt.ok) setStatus(`Answering (with page context: ${evt.elementCount} elements)`);
        else setStatus("Answering (no page context on this tab)");
      } else if (evt.phase === "model-call") {
        setStatus(`Calling model (step ${evt.step})…`);
      } else if (evt.phase === "backoff") {
        const secs = Math.max(1, Math.round((evt.waitMs || 0) / 1000));
        setStatus(`Rate limited — retrying in ${secs}s…`);
      } else if (evt.phase === "tool-call") {
        setStatus(`Running tool: ${evt.name}`);
      } else if (evt.phase === "tool-result") {
        appendToolChip(evt.name, evt.args || {}, evt.result || {});
      }
    },
  });

  if (statusRow) statusRow.remove();
  appendAssistantBubble(text);

  // Persist the turn — user message + assistant message. Tool messages
  // are omitted from the history we send back next turn because the
  // OpenAI API requires them to be preceded by the exact assistant
  // message that triggered them (with the same tool_call_ids). Since we
  // rebuild the system prompt every turn with a fresh snapshot anyway,
  // dropping stale tool results is fine — the model has the answer
  // bubble as summary.
  chatHistory.push({ role: "user", content: task });
  chatHistory.push({
    role: "assistant",
    content: assistantMessage && assistantMessage.content ? assistantMessage.content : text,
  });
  await persistChatHistory();

  if (mode === "agent") speakIfEnabled(text);
}

async function runLegacyAgentFlow({ task, mode, source }) {
  const willNeedPage = needsPage(task, mode);
  if (willNeedPage && source === "local" && !settings.vlmEnabled) {
    appendAssistantBubble("On-Device mode without VLM. Enable 'Local VLM' in Settings, or switch the header toggle to Cloud (BYOK).");
    return;
  }
  const statusRow = appendStatusRow("Thinking (legacy path)…");
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
      if (evt.phase === "reason") {
        const a = evt.action || {};
        if (a.type === "click" || a.type === "type" || a.type === "scroll") {
          appendToolChip(a.type, { target: a.fid, text: a.text }, { ok: true, message: a.reasoning || "" });
        }
      }
    },
  });
  if (statusRow) statusRow.remove();
  const finalText = result.final && result.final.text
    ? result.final.text
    : (result.final && result.final.message) || "(no reply)";
  appendAssistantBubble(finalText);
  chatHistory.push({ role: "user", content: task });
  chatHistory.push({ role: "assistant", content: finalText });
  await persistChatHistory();
  if (mode === "agent") speakIfEnabled(finalText);
}

function speakIfEnabled(text) {
  if (isTtsSupported && isTtsSupported() && text) speak(text);
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
  if (/tool[-_ ]?call(ing|s)?\b/i.test(msg) && /not support/i.test(msg)) {
    return "This model doesn't support tool calling. Pick a tool-capable model in Settings (e.g. Groq: openai/gpt-oss-20b, OpenAI: gpt-4o-mini).";
  }
  if (/MCP/i.test(msg)) {
    return `${msg} — check Settings → MCP servers.`;
  }
  return msg;
}

function isCloudLimitError(msg) {
  return /\b429\b|rate limit|rate_limit|quota|tokens per minute|tpm|too many requests/i.test(String(msg || ""));
}

function wireComposer() {
  const composer = $("composer");
  if (composer) composer.addEventListener("submit", onSubmitComposer);
  const plusBtn = $("plusBtn");
  if (plusBtn) plusBtn.addEventListener("click", newChat);
  const closeBtn = $("runCloseBtn");
  if (closeBtn) closeBtn.addEventListener("click", closeRunView);
  const newBtn = $("newChatBtn");
  if (newBtn) newBtn.addEventListener("click", newChat);
  const modelPill = $("modelPill");
  if (modelPill) modelPill.addEventListener("click", openSettings);
}

// ─── Voice: STT (5.1) + wake word (5.2) + TTS (5.3) ──────────────────

let dictationSession = null;
let wakeSession = null;
let voiceStarting = false;

function setVoiceStatus(text, kind = "info") {
  const el = $("voiceStatus");
  if (!el) return;
  el.textContent = text || "";
  el.hidden = !text;
  el.dataset.kind = kind;
}

function friendlyVoiceError(err) {
  const msg = String(err?.message || err || "");
  if (/not-allowed|permission|denied/i.test(msg)) return "Microphone permission is blocked. Allow mic access for Friday, then try again.";
  if (/no-speech/i.test(msg)) return "I didn't hear anything. Click the mic and speak again.";
  if (/network/i.test(msg)) return "Speech recognition needs Chrome's speech service. Check internet, or type this one.";
  if (/not supported/i.test(msg)) return "Voice input is not supported in this browser.";
  return msg || "Voice input failed.";
}

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

async function onMicClick() {
  if (dictationSession) {
    dictationSession.abort ? dictationSession.abort() : dictationSession.stop();
    dictationSession = null;
    setVoiceStatus("Stopped listening.");
    setMicState(wakeSession ? "wake" : "idle");
    return;
  }
  if (voiceStarting) return;
  if (!isSttSupported()) {
    // No STT — give the composer focus as a fallback.
    setVoiceStatus("Voice input is not supported in this browser.", "error");
    const inp = $("composerInput");
    if (inp) inp.focus();
    return;
  }
  const input = $("composerInput");
  voiceStarting = true;
  setMicState("listening");
  setVoiceStatus("Allow microphone access, then speak...");
  try {
    await ensureMicrophonePermission();
    setVoiceStatus("Listening...");
  } catch (err) {
    console.warn("[friday.voice] mic permission failed:", err);
    voiceStarting = false;
    setMicState(wakeSession ? "wake" : "idle");
    setVoiceStatus(friendlyVoiceError(err), "error");
    return;
  }
  voiceStarting = false;
  let submitted = false;
  dictationSession = startDictation({
    onInterim: (text) => {
      if (input) input.value = text;
      if (text) setVoiceStatus(`Heard: ${text}`, "ok");
    },
    onFinal: (text) => {
      const finalText = String(text || "").trim();
      if (!finalText || submitted) return;
      submitted = true;
      if (input) input.value = finalText;
      dictationSession = null;
      setMicState(wakeSession ? "wake" : "idle");
      setVoiceStatus("Submitting voice command...", "ok");
      // Auto-submit like the send button — the user's finger is off the mic
      // by the time this fires, so a quiet auto-submit is the whole point.
      onSubmitComposer({ preventDefault() {} });
    },
    onError: (err) => {
      console.warn("[friday.voice] STT error:", err);
      dictationSession = null;
      setMicState(wakeSession ? "wake" : "idle");
      setVoiceStatus(friendlyVoiceError(err), "error");
    },
    onEnd: (text) => {
      dictationSession = null;
      if (!wakeSession) setMicState("idle");
      if (!submitted && !String(text || "").trim()) {
        setVoiceStatus("No speech detected. Click the mic and try again.", "error");
      }
    },
  });
}

function onMicLongPress() {
  if (wakeSession) {
    wakeSession.stop();
    wakeSession = null;
    setVoiceStatus("Wake word stopped.");
    setMicState("idle");
    return;
  }
  if (!isSttSupported()) {
    setVoiceStatus("Voice input is not supported in this browser.", "error");
    return;
  }
  wakeSession = startWakeWord({
    phrase: "hey friday",
    onWake: () => {
      setVoiceStatus("Wake word heard. Speak your command...", "ok");
      // Give the user a subtle audio ack; TTS is quicker than a beep here.
      speak("Yes?");
    },
    onTask: (task) => {
      if (!task) return;
      const input = $("composerInput");
      if (input) input.value = task;
      setVoiceStatus("Submitting voice command...", "ok");
      onSubmitComposer({ preventDefault() {} });
    },
    onError: (err) => {
      console.warn("[friday.voice] wake-word error:", err);
      setVoiceStatus(friendlyVoiceError(err), "error");
    },
  });
  setVoiceStatus("Wake word active.");
  setMicState("wake");
}

function wireVoice() {
  const micBtn = $("micBtn");
  if (!micBtn) return;
  setMicState("idle");
  micBtn.title = isSttSupported() ? "Click and speak" : "Voice input is not supported";
  // Click: one-shot dictation. Long-press / right-click: wake word.
  let pressTimer = null;
  let suppressClick = false;
  micBtn.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    suppressClick = false;
    pressTimer = setTimeout(() => {
      suppressClick = true;
      onMicLongPress();
    }, 650);
  });
  micBtn.addEventListener("pointerup", () => {
    if (pressTimer) clearTimeout(pressTimer);
  });
  micBtn.addEventListener("pointerleave", () => { if (pressTimer) clearTimeout(pressTimer); });
  micBtn.addEventListener("click", () => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    onMicClick();
  });
  micBtn.addEventListener("contextmenu", (e) => { e.preventDefault(); onMicLongPress(); });
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
  const headerScanBtn = $("headerScanBtn");
  if (headerScanBtn) headerScanBtn.addEventListener("click", runScan);
  $("receiptCloseBtn").addEventListener("click", closeReceiptView);
  $("receiptRescanBtn").addEventListener("click", runScan);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && getView() === VIEWS.RECEIPT) closeReceiptView();
  });
}

// Re-add "Run privacy scan" button after we replaced emptyState innerHTML —
// safe because sidepanel.html now declares #scanBtn directly.

// ─── VLM opt-in + first-run download ─────────────────────────────────

function renderModelLabel() {
  const label = $("modelLabel");
  if (!label) return;
  const source = settings.reasoningSource || "local";
  if (source === "local") {
    const id = selectedLocalLlmModel();
    const model = LOCAL_LLM_MODELS.find((m) => m.id === id);
    label.textContent = model ? model.label.replace(" - recommended", "") : "Local LLM";
  } else {
    const provider = settings.byokProvider || "Cloud";
    label.textContent = settings.byokModel || provider[0].toUpperCase() + provider.slice(1);
  }
}

function renderLocalLlm() {
  const enabled = localLlmIsEnabled();
  const cb = $("localLlmToggle");
  const body = $("localLlmBody");
  const sel = $("localLlmModelSel");
  if (cb) cb.checked = enabled;
  if (body) body.hidden = !enabled;
  if (sel) {
    sel.innerHTML = "";
    for (const model of LOCAL_LLM_MODELS) {
      const opt = document.createElement("option");
      opt.value = model.id;
      opt.textContent = model.id === DEFAULT_LOCAL_LLM_MODEL ? `${model.label} (default)` : model.label;
      opt.title = model.hint;
      sel.appendChild(opt);
    }
    sel.value = selectedLocalLlmModel();
  }
  updateLocalLlmStatusLine();
  renderModelLabel();
}

function updateLocalLlmStatusLine() {
  const status = $("localLlmStatus");
  const btn = $("localLlmLoadBtn");
  if (!status) return;
  if (!localLlmIsEnabled()) {
    status.textContent = "Disabled.";
  } else if (localLlmState.engine) {
    status.textContent = `Loaded ${localLlmState.modelId} in ${(localLlmState.loadMs / 1000).toFixed(1)}s.`;
    if (btn) btn.textContent = "Reload local LLM";
  } else {
    status.textContent = "Not loaded yet. First load downloads once, then browser cache keeps it.";
    if (btn) btn.textContent = "Load local LLM";
  }
}

async function onLocalLlmToggleChange(e) {
  await saveSetting("localLlmEnabled", !!e.target.checked);
  renderLocalLlm();
}

async function onLocalLlmModelChange(e) {
  await saveSetting("localLlmModel", normalizeLocalModel(e.target.value));
  updateLocalLlmStatusLine();
  renderModelLabel();
}

async function onLocalLlmLoad() {
  const btn = $("localLlmLoadBtn");
  const bar = $("localLlmProgress");
  const status = $("localLlmStatus");
  if (!localLlmIsEnabled()) return;
  if (btn) btn.disabled = true;
  if (bar) { bar.hidden = false; bar.value = 0; }
  if (status) status.textContent = "Checking WebGPU...";

  const gpu = await detectLocalLlmSupport();
  if (status) {
    status.textContent = gpu.available
      ? `WebGPU ready (${gpu.vendor}${gpu.architecture ? `/${gpu.architecture}` : ""}). Loading local LLM...`
      : `WebGPU unavailable (${gpu.reason}).`;
  }
  if (!gpu.available) {
    if (btn) btn.disabled = false;
    if (bar) bar.hidden = true;
    return;
  }

  try {
    await ensureLocalLlm({
      modelId: selectedLocalLlmModel(),
      onProgress: (evt) => {
        if (bar) bar.value = evt.pct || 0;
        if (status) status.textContent = `${evt.text || "Loading local LLM"} ${evt.pct ? `(${evt.pct.toFixed(0)}%)` : ""}`.trim();
      },
    });
    if (bar) bar.value = 100;
    updateLocalLlmStatusLine();
  } catch (err) {
    if (status) status.textContent = `Load failed - ${err?.message || err}`;
  } finally {
    if (btn) btn.disabled = false;
    if (bar) setTimeout(() => { bar.hidden = true; }, 800);
  }
}

function wireLocalLlm() {
  $("localLlmToggle")?.addEventListener("change", onLocalLlmToggleChange);
  $("localLlmModelSel")?.addEventListener("change", onLocalLlmModelChange);
  $("localLlmLoadBtn")?.addEventListener("click", onLocalLlmLoad);
}

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
// Model picker offers a curated list of TOOL-CALLING-CAPABLE models per
// provider (BYOK_KNOWN_MODELS in byok.js). We don't live-fetch anymore:
// no provider's public /models endpoint advertises tool-calling
// capability, so a live list would keep including models that reject
// `tools` (Groq: whisper-*, *-guard-*, gemma-*).
//
// A "Custom…" option lets the user type any model id — the escape hatch
// for new releases we haven't added yet, or for text-only calls where a
// non-tool model is fine.

import { DEFAULT_MODELS as BYOK_DEFAULT_MODELS, KNOWN_MODELS as BYOK_KNOWN_MODELS } from "./byok.js";

const CUSTOM_MODEL_VALUE = "__custom__";

function setByokStatus(text, kind /* "info" | "ok" | "error" */) {
  const el = $("byokStatus");
  if (!el) return;
  el.textContent = text;
  el.classList.remove("byok-status--set", "byok-status--error");
  if (kind === "ok") el.classList.add("byok-status--set");
  if (kind === "error") el.classList.add("byok-status--error");
}

function populateByokModels(provider) {
  const sel = $("byokModelSel");
  if (!sel) return;
  sel.innerHTML = "";
  const ids = BYOK_KNOWN_MODELS[provider] || [];
  const defaultId = BYOK_DEFAULT_MODELS[provider] || ids[0] || "";
  for (const id of ids) {
    const el = document.createElement("option");
    el.value = id;
    el.textContent = id === defaultId ? `${id}  (default)` : id;
    sel.appendChild(el);
  }
  const customOpt = document.createElement("option");
  customOpt.value = CUSTOM_MODEL_VALUE;
  customOpt.textContent = "Custom…";
  sel.appendChild(customOpt);

  const saved = (settings.byokModel || "").trim();
  if (saved && ids.includes(saved)) {
    sel.value = saved;
  } else if (saved) {
    // User previously saved a custom id — keep it editable via Custom
    // instead of silently swapping to the default.
    sel.value = CUSTOM_MODEL_VALUE;
  } else {
    sel.value = defaultId;
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

function renderByok() {
  const providerSel = $("byokProviderSel");
  const keyInput = $("byokApiKeyInput");
  if (!providerSel) return;
  const provider = settings.byokProvider || "gemini";
  providerSel.value = provider;
  keyInput.value = settings.byokApiKey || "";
  populateByokModels(provider);
  setByokStatus(settings.byokApiKey ? `Key set for ${provider}.` : "No key set.", settings.byokApiKey ? "ok" : "info");
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
  await saveSetting("byokProvider", provider);
  await saveSetting("byokApiKey", apiKey);
  await saveSetting("byokModel", model);
  renderModelLabel();
  setByokStatus(model ? `Saved. Using ${model}.` : `Saved. Using ${BYOK_DEFAULT_MODELS[provider]} (default).`, "ok");
}

function wireByok() {
  const providerSel = $("byokProviderSel");
  if (!providerSel) return;
  providerSel.addEventListener("change", () => {
    // Repopulate the model list for the newly-selected provider so the
    // user immediately sees that provider's tool-capable options.
    populateByokModels(providerSel.value);
  });
  const sel = $("byokModelSel");
  if (sel) sel.addEventListener("change", updateByokCustomVisibility);
  $("byokSaveBtn").addEventListener("click", onByokSave);
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
  loadChatHistory();
  renderChatHistory();
  // If there's a saved conversation, restore into the chat view on boot.
  if (chatHistory.length > 0) setView(VIEWS.RUN);
  renderMode();
  renderDeviceToggle();
  wireModePill();
  wireDeviceToggle();
  wireSettings();
  wireLocalLlm();
  wireVlm();
  wireByok();
  wireMcp();
  wireReceipt();
  wireComposer();
  wireVoice();
});
