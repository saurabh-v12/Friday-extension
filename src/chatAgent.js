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

// Compact snapshot for the system prompt. We trim `visibleText` and the
// elements list to keep tokens reasonable — the model can call
// getSnapshot() again if it needs more.
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
  const elementLines = (snapshot.elements || []).slice(0, 80).map((e) => {
    const bits = [`selector=${e.selector}`, `<${e.tag}${e.type ? `:${e.type}` : ""}>`, `role=${e.role}`];
    if (e.name) bits.push(`name=${JSON.stringify(e.name.slice(0, 60))}`);
    if (e.text && e.text !== e.name) bits.push(`text=${JSON.stringify(e.text.slice(0, 60))}`);
    if (e.placeholder) bits.push(`placeholder=${JSON.stringify(e.placeholder.slice(0, 40))}`);
    if (e.href) bits.push(`href=${JSON.stringify(e.href.slice(0, 80))}`);
    return "  " + bits.join(" ");
  }).join("\n");
  return [
    modeHint,
    "",
    "You have access to tools to see and control the current page. The",
    "snapshot below shows the current URL, title, visible text, and every",
    "interactive element you can target. Each element has a stable `selector`",
    "— pass it to click/type/scroll/readText as the `target` argument.",
    "",
    "If a tool returns {ok:false, error:…}, don't retry the same call — pick",
    "a different target, call getSnapshot to refresh, or explain the problem.",
    "",
    `PAGE: ${snapshot.title} — ${snapshot.url}`,
    "",
    `ELEMENTS (${(snapshot.elements || []).length} total, first 80 shown):`,
    elementLines || "  (none)",
    "",
    "VISIBLE TEXT (first ~3000 chars):",
    snapshot.visibleText || "(empty)",
  ].join("\n");
}

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
    emit({ phase: "model-call", step });
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
