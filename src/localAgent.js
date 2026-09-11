// Local agent loop.
//
// WebLLM function-calling currently favors large Hermes models, so this file
// uses a manual JSON planning loop for laptop-friendly models. One model call
// chooses exactly one action; Friday executes the same generic browser tools
// used by the cloud agent, feeds back a compact observation, and repeats.

import { MESSAGE_TYPES, sendToBackground } from "./messaging.js";
import { chatLocal } from "./localLlm.js";
import { estimatePromptTokens } from "./chatAgent.js";

export const MAX_LOCAL_TOOL_STEPS = 6;

const MAX_ELEMENTS = 24;
const MAX_FIELD_CHARS = 32;
const MAX_HISTORY_MESSAGES = 6;
const MAX_HISTORY_CHARS = 240;
const MAX_PROMPT_TOKENS = 1500;
const ACTIONS = new Set(["say", "done", "stop", "click", "type", "scroll", "goto", "clickOrdinal", "readText", "getSnapshot"]);
const TOOL_ACTIONS = new Set(["click", "type", "scroll", "goto", "clickOrdinal", "readText", "getSnapshot"]);
const ORDINAL_WORDS = new Map([
  ["first", 1],
  ["1st", 1],
  ["one", 1],
  ["second", 2],
  ["2nd", 2],
  ["two", 2],
  ["third", 3],
  ["3rd", 3],
  ["three", 3],
  ["fourth", 4],
  ["4th", 4],
  ["four", 4],
  ["fifth", 5],
  ["5th", 5],
  ["five", 5],
]);
const KIND_ALIASES = new Map([
  ["video", "video"],
  ["videos", "video"],
  ["button", "button"],
  ["buttons", "button"],
  ["link", "link"],
  ["links", "link"],
  ["field", "field"],
  ["fields", "field"],
  ["input", "field"],
  ["inputs", "field"],
  ["heading", "heading"],
  ["headings", "heading"],
  ["item", "item"],
  ["items", "item"],
]);

function trunc(s, n = MAX_FIELD_CHARS) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "..." : s;
}

function safePageUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname && u.pathname !== "/" ? u.pathname : "";
    const out = `${u.hostname}${path}`;
    return out.length > 120 ? out.slice(0, 119) + "..." : out;
  } catch {
    return "";
  }
}

async function fetchSnapshot() {
  try {
    return await sendToBackground(MESSAGE_TYPES.SNAPSHOT_COMPACT);
  } catch (err) {
    return { _snapshotError: err?.message || String(err) };
  }
}

function snapshotLines(snapshot) {
  if (!snapshot || snapshot._snapshotError) return "No page context.";
  return (snapshot.elements || []).slice(0, MAX_ELEMENTS).map((e) => {
    const pos = e.bbox ? `pos=${e.bbox.x},${e.bbox.y},${e.bbox.w}x${e.bbox.h}` : "";
    const bits = [
      `#${e.screenIndex || "?"}`,
      `kind=${e.kind || "item"}`,
      `selector=${e.selector}`,
      `<${e.tag || "el"}${e.type ? `:${e.type}` : ""}>`,
      `role=${e.role || ""}`,
    ];
    if (pos) bits.push(pos);
    if (e.name) bits.push(`name=${JSON.stringify(trunc(e.name))}`);
    if (e.text && e.text !== e.name) bits.push(`text=${JSON.stringify(trunc(e.text))}`);
    if (e.placeholder) bits.push(`placeholder=${JSON.stringify(trunc(e.placeholder))}`);
    if (e.href) bits.push(`href=${JSON.stringify(trunc(safePageUrl(e.href)))}`);
    return bits.join(" ");
  }).join("\n") || "(no visible interactive elements)";
}

function systemPrompt(snapshot, mode) {
  const total = snapshot && !snapshot._snapshotError ? (snapshot.elements || []).length : 0;
  const page = snapshot && !snapshot._snapshotError
    ? `${trunc(snapshot.title, 80)} - ${safePageUrl(snapshot.url)}`
    : "unavailable";
  return [
    "You are Friday, a local offline browser agent running on the user's laptop.",
    mode === "agent"
      ? "When the user's request touches the webpage, choose a tool action instead of explaining."
      : "In chat mode, answer normally unless a page action or page read is clearly needed.",
    "",
    "Return ONLY one JSON object. No markdown. No prose outside JSON.",
    'Schema: {"action":"say|done|stop|click|type|scroll|goto|clickOrdinal|readText|getSnapshot","args":{},"final":"short user-facing reply"}',
    "",
    "Tool args:",
    '- click: {"target":"CSS selector from snapshot"}',
    '- type: {"target":"CSS selector from snapshot","text":"text to enter"}',
    '- scroll: {"direction":"up|down|top|bottom","amount":600}',
    '- goto: {"url":"https://..."}',
    '- clickOrdinal: {"kind":"video|button|link|field|heading|item","index":2}',
    '- readText: {"target":"optional selector"}',
    "- getSnapshot: {}",
    "",
    "Rules:",
    "- For '2nd video', use clickOrdinal with kind video and index 2.",
    "- For buttons/links/fields named on screen, use their selector from the snapshot.",
    "- After a successful final action, return done with a short final reply.",
    "- If a tool fails, try a different visible selector or getSnapshot once.",
    "",
    `PAGE: ${page}`,
    `ELEMENTS (${total} total, first ${Math.min(total, MAX_ELEMENTS)} shown):`,
    snapshotLines(snapshot),
  ].join("\n");
}

function compactHistory(history) {
  return (Array.isArray(history) ? history : [])
    .filter((m) => ["user", "assistant"].includes(m?.role) && typeof m.content === "string" && m.content.trim())
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({
      role: m.role,
      content: m.content.length > MAX_HISTORY_CHARS ? m.content.slice(0, MAX_HISTORY_CHARS).trim() + "..." : m.content,
    }));
}

function extractJson(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : raw).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalizePlan(text) {
  const obj = extractJson(text);
  if (!obj) return { action: "say", args: {}, final: String(text || "").trim() || "I could not parse the local model response." };
  const action = String(obj.action || obj.type || "say").trim();
  const safeAction = ACTIONS.has(action) ? action : "say";
  return {
    action: safeAction,
    args: obj.args && typeof obj.args === "object" ? obj.args : {},
    final: typeof obj.final === "string" ? obj.final.trim() : "",
  };
}

function compactToolResult(result) {
  if (!result || typeof result !== "object") return result;
  if (typeof result.text === "string" && result.text.length > 1200) {
    return { ...result, text: result.text.slice(0, 1200) + "\n...(truncated)" };
  }
  if (result.snapshot && typeof result.snapshot === "object") {
    const snap = result.snapshot;
    return {
      ...result,
      snapshot: {
        url: safePageUrl(snap.url),
        title: snap.title || "",
        visibleText: typeof snap.visibleText === "string" ? snap.visibleText.slice(0, 400) : "",
        elementCount: snap.elementCount || (snap.elements || []).length || 0,
        elements: (snap.elements || []).slice(0, MAX_ELEMENTS).map((e) => ({
          screenIndex: e.screenIndex,
          kind: e.kind,
          selector: e.selector,
          tag: e.tag,
          role: e.role,
          name: e.name,
          text: e.text,
          type: e.type,
          bbox: e.bbox,
        })),
      },
    };
  }
  return result;
}

function parseOrdinalToken(token) {
  const t = String(token || "").toLowerCase();
  if (ORDINAL_WORDS.has(t)) return ORDINAL_WORDS.get(t);
  const m = t.match(/^(\d+)(?:st|nd|rd|th)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function ordinalLabel(n) {
  if (n === 1) return "first";
  if (n === 2) return "second";
  if (n === 3) return "third";
  return `${n}th`;
}

function norm(s) {
  return String(s || "").toLowerCase().replace(/[^\w@.\s+-]/g, " ").replace(/\s+/g, " ").trim();
}

function elementLabel(e) {
  return norm([e?.name, e?.text, e?.placeholder, e?.type, e?.role, e?.tag].filter(Boolean).join(" "));
}

function taskWords(s) {
  return norm(s).split(/\s+/).filter((w) => w.length > 1 && !["the", "that", "this", "button", "field", "section", "box", "input", "textbox", "click", "press", "tap", "select", "choose", "on", "in", "into", "to"].includes(w));
}

function isFieldElement(e) {
  const tag = String(e?.tag || "").toLowerCase();
  const kind = String(e?.kind || "").toLowerCase();
  const type = String(e?.type || "").toLowerCase();
  return kind === "field" || tag === "input" || tag === "textarea" || tag === "select" || type === "text" || type === "email" || type === "search";
}

function isClickableElement(e) {
  const tag = String(e?.tag || "").toLowerCase();
  const kind = String(e?.kind || "").toLowerCase();
  const role = String(e?.role || "").toLowerCase();
  const type = String(e?.type || "").toLowerCase();
  return kind === "button" || kind === "link" || tag === "button" || tag === "a" || role === "button" || role === "link" || ["button", "submit", "reset"].includes(type);
}

function extractTextEntryIntent(task) {
  const raw = String(task || "").trim();
  if (!/\b(?:type|enter|fill|input|write)\b/i.test(raw)) return null;
  const email = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  const quoted = raw.match(/["']([^"']{1,200})["']/)?.[1];
  const structured = raw.match(/\b(?:type|enter|fill|input|write)\s+(.+?)\s+(?:in|into|to)\s+(?:the\s+)?(.+?)\s*$/i);
  const text = email || quoted || (structured ? structured[1].trim() : "");
  if (!text) return null;
  let hint = structured ? structured[2] : "";
  if (email) {
    const tail = raw.slice(raw.toLowerCase().indexOf(email.toLowerCase()) + email.length);
    hint = tail.match(/\b(?:in|into|to)\s+(?:the\s+)?(.+?)\s*$/i)?.[1] || hint;
  }
  hint = hint.replace(/\b(?:field|section|box|input|textbox)\b/gi, " ").trim();
  return { text, hint };
}

function scoreField(e, intent, index) {
  if (!isFieldElement(e)) return -Infinity;
  const type = String(e?.type || "").toLowerCase();
  if (type === "password" || type === "hidden") return -Infinity;
  const label = elementLabel(e);
  const hint = norm(intent.hint);
  let score = Math.max(0, 8 - index * 0.1);
  if (/@/.test(intent.text)) {
    if (type === "email") score += 12;
    if (label.includes("email")) score += 14;
    if (label.includes("username")) score += 6;
    if (label.includes("phone")) score -= 3;
  }
  for (const w of taskWords(hint)) {
    if (label.includes(w)) score += 5;
  }
  return score;
}

function matchTextEntryTool(task, snapshot) {
  const intent = extractTextEntryIntent(task);
  if (!intent || !snapshot || snapshot._snapshotError) return null;
  const elements = Array.isArray(snapshot.elements) ? snapshot.elements : [];
  const ranked = elements
    .map((e, i) => ({ e, score: scoreField(e, intent, i) }))
    .filter((x) => x.e?.selector && x.score >= 8)
    .sort((a, b) => b.score - a.score);
  const best = ranked[0]?.e;
  if (!best) return null;
  return {
    name: "type",
    args: { target: best.selector, text: intent.text },
    successText: `Entered ${intent.text} into the field.`,
  };
}

function extractClickHint(task) {
  const raw = String(task || "").trim();
  if (!/\b(?:click|press|tap|select|choose)\b/i.test(raw)) return "";
  let hint = raw;
  const leading = hint.match(/^\s*(?:click|press|tap|select|choose)\s+(?:on\s+)?(?:the\s+)?(.+?)\s*$/i);
  if (leading) hint = leading[1];
  else hint = hint.replace(/\b(?:click|press|tap|select|choose)\b.*$/i, "");
  return hint
    .replace(/\b(?:on|the|that|this|button|link|option|please)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreClickable(e, hint, index) {
  if (!isClickableElement(e)) return -Infinity;
  const label = elementLabel(e);
  const cleanHint = norm(hint);
  if (!cleanHint) return -Infinity;
  let score = Math.max(0, 4 - index * 0.05);
  if (label === cleanHint) score += 30;
  if (label.includes(cleanHint)) score += 24;
  const words = taskWords(cleanHint);
  if (words.length && words.every((w) => label.includes(w))) score += 16;
  for (const w of words) if (label.includes(w)) score += 3;
  return score;
}

function matchClickByLabelTool(task, snapshot) {
  const hint = extractClickHint(task);
  if (!hint || !snapshot || snapshot._snapshotError) return null;
  const elements = Array.isArray(snapshot.elements) ? snapshot.elements : [];
  const ranked = elements
    .map((e, i) => ({ e, score: scoreClickable(e, hint, i) }))
    .filter((x) => x.e?.selector && x.score >= 12)
    .sort((a, b) => b.score - a.score);
  const best = ranked[0]?.e;
  if (!best) return null;
  return {
    name: "click",
    args: { target: best.selector },
    successText: `Clicked ${best.name || best.text || hint}.`,
  };
}

function matchDeterministicTool(task, snapshot = null) {
  const text = String(task || "").toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;

  const textEntry = matchTextEntryTool(task, snapshot);
  if (textEntry) return textEntry;

  const clickByLabel = matchClickByLabelTool(task, snapshot);
  if (clickByLabel) return clickByLabel;

  const ordinalKind = text.match(
    /\b(?:play|open|watch|start|click|press|select)\s+(?:the\s+)?(\d+(?:st|nd|rd|th)?|first|second|third|fourth|fifth|one|two|three|four|five)\s+(video|videos|button|buttons|link|links|field|fields|input|inputs|heading|headings|item|items)\b/
  ) || text.match(
    /\b(?:the\s+)?(\d+(?:st|nd|rd|th)?|first|second|third|fourth|fifth|one|two|three|four|five)\s+(video|videos|button|buttons|link|links|field|fields|input|inputs|heading|headings|item|items)\b/
  );
  if (ordinalKind) {
    const index = parseOrdinalToken(ordinalKind[1]);
    const kind = KIND_ALIASES.get(ordinalKind[2]);
    if (index && kind) {
      return {
        name: "clickOrdinal",
        args: { kind, index },
        successText: `Clicked the ${ordinalLabel(index)} ${kind}.`,
      };
    }
  }

  return null;
}

async function runDeterministicTool({ tool, emit }) {
  emit({ phase: "tool-call", step: 0, name: tool.name, args: tool.args, deterministic: true });
  let result;
  try {
    result = await sendToBackground(MESSAGE_TYPES.EXEC_TOOL, { tool: tool.name, args: tool.args });
  } catch (err) {
    result = { ok: false, error: err?.message || String(err) };
  }
  emit({ phase: "tool-result", step: 0, name: tool.name, args: tool.args, result, deterministic: true });
  const toolTrace = [{ step: 0, name: tool.name, args: tool.args, result }];
  const ok = !(result && result.ok === false);
  const text = ok
    ? (result?.message || tool.successText || "Done.")
    : `Local action failed: ${result?.error || "tool failed"}`;
  emit({ phase: "done", text, toolTrace, local: true, deterministic: true });
  return {
    text,
    toolTrace,
    assistantMessage: { role: "assistant", content: text },
  };
}

function looksLikePageAction(text) {
  return /\b(click|press|select|play|open|watch|start|type|enter|scroll|go back|go forward|reload|refresh)\b/i.test(String(text || ""));
}

export async function runLocalAgentTurn({ userMessage, history = [], mode = "chat", modelId, onEvent }) {
  const emit = (evt) => { if (onEvent) onEvent(evt); };
  const snapshot = await fetchSnapshot();
  const snapOk = snapshot && !snapshot._snapshotError;
  emit({
    phase: "snapshot",
    ok: !!snapOk,
    error: snapshot?._snapshotError,
    elementCount: snapOk ? (snapshot.elements || []).length : 0,
    url: snapOk ? snapshot.url : null,
  });

  const deterministicTool = matchDeterministicTool(userMessage, snapOk ? snapshot : null);
  if (deterministicTool) {
    return await runDeterministicTool({ tool: deterministicTool, emit });
  }

  const messages = [
    { role: "system", content: systemPrompt(snapOk ? snapshot : null, mode) },
    ...compactHistory(history),
    { role: "user", content: userMessage },
  ];
  const toolTrace = [];

  for (let step = 1; step <= MAX_LOCAL_TOOL_STEPS; step++) {
    const promptTokens = estimatePromptTokens(messages);
    if (promptTokens > MAX_PROMPT_TOKENS) {
      throw new Error(`Local prompt is ${promptTokens} tokens (over ${MAX_PROMPT_TOKENS} cap). Start a new chat or refresh the tab.`);
    }
    emit({ phase: "model-call", step, promptTokens, local: true });
    const raw = await chatLocal({
      modelId,
      messages,
      json: true,
      temperature: 0,
      maxTokens: 260,
      onProgress: (p) => emit({ phase: "local-load", ...p }),
    });
    const plan = normalizePlan(raw);
    emit({ phase: "model-reply", step, local: true, textPreview: raw.slice(0, 160) });

    if (plan.action === "say" || plan.action === "done" || plan.action === "stop") {
      if (mode === "agent" && plan.action === "say" && looksLikePageAction(userMessage)) {
        const text = "Local mode could not choose a safe page action. Try a simpler command like \"click the second video\", or switch to Cloud for this task.";
        emit({ phase: "done", text, toolTrace, local: true, noToolAction: true });
        return {
          text,
          toolTrace,
          assistantMessage: { role: "assistant", content: text },
        };
      }
      const text = plan.final || (plan.action === "done" ? "Done." : "I cannot proceed from the current page.");
      emit({ phase: "done", text, toolTrace, local: true });
      return {
        text,
        toolTrace,
        assistantMessage: { role: "assistant", content: text },
      };
    }

    if (!TOOL_ACTIONS.has(plan.action)) {
      const text = plan.final || "I could not choose a safe local action.";
      return { text, toolTrace, assistantMessage: { role: "assistant", content: text } };
    }

    emit({ phase: "tool-call", step, name: plan.action, args: plan.args });
    let result;
    try {
      result = await sendToBackground(MESSAGE_TYPES.EXEC_TOOL, { tool: plan.action, args: plan.args });
    } catch (err) {
      result = { ok: false, error: err?.message || String(err) };
    }
    emit({ phase: "tool-result", step, name: plan.action, args: plan.args, result });
    toolTrace.push({ step, name: plan.action, args: plan.args, result });
    messages.push({ role: "assistant", content: JSON.stringify(plan) });
    messages.push({
      role: "user",
      content: `OBSERVATION for ${plan.action}: ${JSON.stringify(compactToolResult(result))}`,
    });
  }

  const text = "I reached the local tool step limit. The last action ran, but I stopped to avoid looping.";
  emit({ phase: "done", text, toolTrace, local: true, hitLimit: true });
  return { text, toolTrace, hitLimit: true, assistantMessage: { role: "assistant", content: text } };
}
