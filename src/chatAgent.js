// Chat agent — tool-calling loop that SEES the page (via compact
// snapshot) and CONTROLS it (via EXEC_TOOL tool calls).
//
// One turn = one user message → possibly many tool calls → one assistant
// text reply. This is the replacement for the old vision+ReAct path
// when Chat/Agent mode uses Cloud reasoning. The heavy screenshot
// pipeline (BlazeFace + Tesseract + redact) is unrelated to this file —
// it still runs when the user explicitly hits "Run privacy scan".

import { MESSAGE_TYPES, sendToBackground } from "./messaging.js";
import { chatWithTools, supportsToolCalling } from "./byok.js";

export const MAX_TOOL_STEPS = 8;

// OpenAI-compatible tool schema. Groq accepts the same shape. Only the
// fields listed here are surfaced to the model — keeps args unambiguous.
export const TOOLS = [
  {
    type: "function",
    function: {
      name: "click",
      description: "Click an element on the current page. `target` must be a CSS selector from the page snapshot's `selector` field (either #id or [data-friday-id=…]).",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "CSS selector for the element to click." },
        },
        required: ["target"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "type",
      description: "Type text into an input, textarea, or contenteditable. Replaces existing content.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "CSS selector for the input." },
          text:   { type: "string", description: "Text to type." },
        },
        required: ["target", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "scroll",
      description: "Scroll the current page.",
      parameters: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["up", "down", "top", "bottom"] },
          amount:    { type: "integer", description: "Pixels for up/down. Defaults to 80% of viewport." },
        },
        required: ["direction"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "goto",
      description: "Navigate the current tab to a URL. http(s) only. Only use when the user explicitly asks to open or navigate to a page.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "readText",
      description: "Read text from an element, or the full visible page text if no target is given. Use when the snapshot's element list doesn't include the info you need.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "Optional CSS selector. Omit to read the whole page." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getSnapshot",
      description: "Fetch a fresh page snapshot. Call after any action that likely changed the DOM (click that opens a dialog, navigation, form submit).",
      parameters: { type: "object", properties: {} },
    },
  },
];

// Cap on the interactive-elements list sent to the model. Kept tight
// on purpose — dropped from 80 → 30 after a 4200-token first turn for
// "scroll down" 429'd on Groq free-tier. If the model needs more it
// can call getSnapshot() to refresh.
const MAX_PROMPT_ELEMENTS = 30;
// Per-field truncation for each element line. 40 chars is enough to
// disambiguate typical labels/placeholders without paying for prose.
const MAX_FIELD_CHARS = 40;

// Sanitized DOM summary: url, title, and up to 30 visible interactive
// elements. No visibleText, no raw HTML, no screenshot — those are the
// three fat things we WERE sending. Model can still call readText/
// getSnapshot when it needs more.
function systemPrompt(snapshot, mode) {
  const modeHint = mode === "agent"
    ? "You are Friday in Agent mode. When the user asks for something that touches the page, prefer to DO it via the tools rather than just describing what to do."
    : "You are Friday in Chat mode. Answer from the page snapshot when possible; only call tools when you must act on the page or read text not in the snapshot.";
  if (!snapshot || !snapshot.url) {
    return [
      modeHint,
      "",
      "You currently have no page context (couldn't inject into this tab — likely a chrome:// or extension page). Answer conversationally.",
    ].join("\n");
  }
  const trunc = (s) => (s && s.length > MAX_FIELD_CHARS ? s.slice(0, MAX_FIELD_CHARS) : s || "");
  const elementLines = (snapshot.elements || []).slice(0, MAX_PROMPT_ELEMENTS).map((e) => {
    const bits = [`selector=${e.selector}`, `<${e.tag}${e.type ? `:${e.type}` : ""}>`, `role=${e.role}`];
    if (e.name) bits.push(`name=${JSON.stringify(trunc(e.name))}`);
    if (e.text && e.text !== e.name) bits.push(`text=${JSON.stringify(trunc(e.text))}`);
    if (e.placeholder) bits.push(`placeholder=${JSON.stringify(trunc(e.placeholder))}`);
    if (e.href) bits.push(`href=${JSON.stringify(trunc(e.href))}`);
    return "  " + bits.join(" ");
  }).join("\n");
  const totalEls = (snapshot.elements || []).length;
  const shown = Math.min(totalEls, MAX_PROMPT_ELEMENTS);
  return [
    modeHint,
    "",
    "You have tools to see and control the current page. Each element has",
    "a stable `selector` — pass it to click/type/scroll/readText as `target`.",
    "If a tool returns {ok:false, error:…}, pick a different target or call",
    "getSnapshot to refresh — don't retry the same call.",
    "",
    `PAGE: ${snapshot.title} — ${snapshot.url}`,
    "",
    `ELEMENTS (${totalEls} total, first ${shown} shown):`,
    elementLines || "  (none)",
  ].join("\n");
}

// Rough token count — ~4 chars per token for OpenAI/Groq tokenizers.
// This is inflight instrumentation, not authoritative — but it's close
// enough to catch runaway prompts before they hit the wire.
export function estimatePromptTokens(messages) {
  let chars = 0;
  for (const m of messages || []) {
    if (typeof m.content === "string") chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (typeof p === "string") chars += p.length;
        else if (p && typeof p.text === "string") chars += p.text.length;
      }
    }
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        chars += (tc.function?.name || "").length;
        chars += (tc.function?.arguments || "").length;
      }
    }
    if (m.tool_call_id) chars += m.tool_call_id.length;
  }
  return Math.ceil(chars / 4);
}

// Hard cap. We aim for ≤ 800; 1200 is the loud-fail line.
const MAX_PROMPT_TOKENS = 1200;

// Fetch the page snapshot. Falls back to null on any error (chrome://
// pages, no active tab, etc.) — the caller can still do a text-only chat.
async function fetchSnapshot() {
  try {
    return await sendToBackground(MESSAGE_TYPES.SNAPSHOT_COMPACT);
  } catch (err) {
    return { _snapshotError: err.message || String(err) };
  }
}

// runChatTurn: one user message in → final assistant text out.
//
// history is the running conversation (excluding the new user message).
// It's used as-is in the messages array so the model gets the ongoing
// context. The system message is REBUILT each turn from a fresh snapshot
// — the page changes between turns, and hoarding an old snapshot would
// give the model a stale worldview.
//
// onEvent(evt) is fired throughout so the UI can show progress:
//   {phase:'snapshot', info?}
//   {phase:'model-call', step}
//   {phase:'model-reply', step, latencyMs, textPreview}
//   {phase:'tool-call', step, name, args}
//   {phase:'tool-result', step, name, result}
//   {phase:'done', text, hitLimit?}
//   {phase:'error', message}
// Set window.__fridayVerbose = true in the DevTools console to log the
// full round trip (system prompt, tool calls, results, final answer).
// Off by default so a busy conversation doesn't spam the console.
function verbose() {
  return typeof window !== "undefined" && window.__fridayVerbose === true;
}
function vlog(...args) {
  if (verbose()) console.log("[friday.chat]", ...args);
}

export async function runChatTurn({ userMessage, history = [], mode = "chat", provider, apiKey, model, onEvent }) {
  const emit = (evt) => { if (onEvent) onEvent(evt); };
  if (!provider || !apiKey) throw new Error("runChatTurn: provider + apiKey required");
  if (!supportsToolCalling(provider)) {
    throw new Error(`Tool calling isn't wired up for ${provider} yet. Switch to OpenAI or Groq for chat with page context.`);
  }

  const turnT0 = performance.now();
  vlog("── turn start ──");
  vlog("user:", userMessage);
  vlog("provider:", provider, "model:", model || "(default)");

  const snapshot = await fetchSnapshot();
  const snapOk = snapshot && !snapshot._snapshotError;
  emit({
    phase: "snapshot",
    ok: !!snapOk,
    error: snapshot && snapshot._snapshotError,
    elementCount: snapOk ? (snapshot.elements || []).length : 0,
    url: snapOk ? snapshot.url : null,
  });
  if (snapOk) {
    vlog(`snapshot: ${snapshot.url} — ${snapshot.elements.length} elements, ${snapshot.visibleText.length} chars text`);
  } else {
    vlog("snapshot: unavailable —", snapshot && snapshot._snapshotError);
  }

  // Build the messages array. System message reflects THIS turn's
  // snapshot; history is passed through untouched.
  const messages = [
    { role: "system", content: systemPrompt(snapOk ? snapshot : null, mode) },
    ...history,
    { role: "user", content: userMessage },
  ];
  vlog("system prompt (first 400 chars):", messages[0].content.slice(0, 400) + "…");

  const toolTrace = [];
  for (let step = 1; step <= MAX_TOOL_STEPS; step++) {
    // Instrument every outbound call. Cheap, catches prompt bloat
    // before it burns tokens on the wire.
    const promptTokens = estimatePromptTokens(messages);
    console.log(`[ctx] promptTokens=${promptTokens}`);
    if (promptTokens > MAX_PROMPT_TOKENS) {
      const msg = `Prompt is ${promptTokens} tokens (over ${MAX_PROMPT_TOKENS} cap). Start a new chat or refresh the tab.`;
      emit({ phase: "error", message: msg });
      throw new Error(msg);
    }
    emit({ phase: "model-call", step, promptTokens });
    const t0 = performance.now();
    let out;
    try {
      out = await chatWithTools({ provider, apiKey, model, messages, tools: TOOLS });
    } catch (err) {
      emit({ phase: "error", message: err.message || String(err) });
      throw err;
    }
    const latencyMs = performance.now() - t0;
    const asstMsg = out.message || { role: "assistant", content: "" };
    // Ensure the message we push is in the exact shape the API expects
    // for the NEXT turn. Include tool_calls verbatim when present.
    const historyMsg = {
      role: "assistant",
      content: asstMsg.content || null,
    };
    if (asstMsg.tool_calls && asstMsg.tool_calls.length) historyMsg.tool_calls = asstMsg.tool_calls;
    messages.push(historyMsg);
    emit({
      phase: "model-reply",
      step,
      latencyMs,
      hasToolCalls: !!(asstMsg.tool_calls && asstMsg.tool_calls.length),
      textPreview: (asstMsg.content || "").slice(0, 160),
    });
    vlog(`step ${step} · reply in ${latencyMs.toFixed(0)} ms · finish=${out.finishReason || "?"} · tool_calls=${(asstMsg.tool_calls || []).length}`);
    if (asstMsg.content) vlog(`  content: ${asstMsg.content.slice(0, 200)}${asstMsg.content.length > 200 ? "…" : ""}`);

    // No tool calls → we have the final answer.
    if (!asstMsg.tool_calls || asstMsg.tool_calls.length === 0) {
      const totalMs = performance.now() - turnT0;
      emit({ phase: "done", text: asstMsg.content || "", toolTrace });
      vlog(`── turn done in ${totalMs.toFixed(0)} ms · ${toolTrace.length} tool call(s) ──`);
      return {
        text: asstMsg.content || "",
        toolTrace,
        assistantMessage: historyMsg,
        turnMessages: messages.slice(-(toolTrace.length * 2 + 2)), // everything added this turn
      };
    }

    // Run each tool call. Feed results back as role:"tool" messages.
    for (const call of asstMsg.tool_calls) {
      const name = call.function?.name;
      let args = {};
      try { args = JSON.parse(call.function?.arguments || "{}"); }
      catch { args = { _parseError: call.function?.arguments || "" }; }
      emit({ phase: "tool-call", step, name, args });
      vlog(`  → tool: ${name}(${JSON.stringify(args)})`);
      let result;
      try {
        result = await sendToBackground(MESSAGE_TYPES.EXEC_TOOL, { tool: name, args });
      } catch (err) {
        result = { ok: false, error: err.message || String(err) };
      }
      emit({ phase: "tool-result", step, name, result });
      vlog(`  ← result: ${JSON.stringify(result).slice(0, 200)}`);
      toolTrace.push({ step, name, args, result });
      // Truncate huge results so we don't blow the context window.
      let content = result;
      if (result && typeof result === "object" && typeof result.text === "string" && result.text.length > 4000) {
        content = { ...result, text: result.text.slice(0, 4000) + "\n…(truncated)" };
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(content),
      });
    }
  }

  const totalMs = performance.now() - turnT0;
  emit({ phase: "done", text: "(reached tool step limit — try 'New chat' or refine the question.)", toolTrace, hitLimit: true });
  vlog(`── turn HIT LIMIT after ${totalMs.toFixed(0)} ms · ${toolTrace.length} tool calls ──`);
  return {
    text: "(Reached the tool step limit — try 'New chat' or refine the question.)",
    toolTrace,
    hitLimit: true,
  };
}
