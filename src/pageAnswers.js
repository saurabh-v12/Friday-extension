// Page-answer helpers for "what's on the screen?" and "summarize this page".
//
// This path is deliberately separate from the agent/tool loop:
// - screen description should be instant and cheap;
// - page summarization should read visible page text locally, scrub obvious PII,
//   then call the user's BYOK model only when it is configured.

import { MESSAGE_TYPES, sendToBackground } from "./messaging.js";
import { chatPlain } from "./byok.js";
import { PATTERNS } from "./pii.js";

const SCREEN_DESCRIPTION = "screen-description";
const PAGE_SUMMARY = "page-summary";

const SCREEN_RE = /^\s*(?:(?:what(?:'s| is)\s+(?:on|in)\s+(?:my\s+|this\s+|the\s+)?(?:screen|page|tab|webpage))|(?:describe\s+(?:my\s+|this\s+|the\s+)?(?:screen|page|tab|webpage))|(?:what\s+am\s+i\s+(?:looking\s+at|seeing)))\s*[?.!]*\s*$/i;
const SUMMARY_RE = /^\s*(?:(?:summari[sz]e|summary|tl;dr|recap)\b.*\b(?:this|the|current|page|webpage|article|screen|tab|site)\b|(?:summari[sz]e|summary|tl;dr|recap)\s*$)/i;

const PAGE_TEXT_CHARS = 5000;
const SNAPSHOT_TEXT_CHARS = 2200;
const SUMMARY_TEXT_CHARS = 4200;

export function matchPageAnswer(task) {
  const t = String(task || "").trim();
  if (!t) return null;
  if (SCREEN_RE.test(t)) return { name: SCREEN_DESCRIPTION };
  if (SUMMARY_RE.test(t)) return { name: PAGE_SUMMARY };
  return null;
}

export async function runPageAnswer({ task, intent, settings, onStatus }) {
  const source = settings?.reasoningSource || "local";
  const canUseCloud = source === "byok" && !!settings?.byokApiKey;

  if (intent?.name === SCREEN_DESCRIPTION) {
    onStatus?.("Reading the visible screen...");
    const snapshot = await fetchCompactSnapshot({ maxElements: 80, maxText: SNAPSHOT_TEXT_CHARS });
    return {
      text: describeScreen(snapshot),
      source: "local-snapshot",
    };
  }

  if (intent?.name === PAGE_SUMMARY) {
    onStatus?.("Reading visible page text...");
    const [snapshot, textResult] = await Promise.all([
      fetchCompactSnapshot({ maxElements: 40, maxText: SNAPSHOT_TEXT_CHARS }),
      readVisiblePageText(),
    ]);
    const rawText = textResult?.text || snapshot?.visibleText || "";
    const safeText = sanitizeForCloud(rawText).slice(0, SUMMARY_TEXT_CHARS);

    if (canUseCloud && safeText.trim().length >= 80) {
      onStatus?.("Summarizing with page context...");
      const summary = await summarizeWithCloud({ task, snapshot, safeText, settings });
      return { text: summary || summarizeLocally(snapshot, safeText), source: "byok-summary" };
    }

    onStatus?.("Summarizing locally...");
    return {
      text: summarizeLocally(snapshot, sanitizeForCloud(rawText || snapshot?.visibleText || "")),
      source: "local-summary",
    };
  }

  throw new Error(`unknown page answer intent: ${intent?.name || "(none)"}`);
}

async function fetchCompactSnapshot(opts) {
  try {
    return await sendToBackground(MESSAGE_TYPES.SNAPSHOT_COMPACT, opts || {});
  } catch (err) {
    return { _snapshotError: err.message || String(err), elements: [], visibleText: "" };
  }
}

async function readVisiblePageText() {
  try {
    return await sendToBackground(MESSAGE_TYPES.EXEC_TOOL, {
      tool: "readText",
      args: { maxChars: PAGE_TEXT_CHARS },
    });
  } catch (err) {
    return { ok: false, error: err.message || String(err), text: "" };
  }
}

function describeScreen(snapshot) {
  if (!snapshot || snapshot._snapshotError) {
    return "I cannot inspect this browser page.\nOpen a normal http(s) website tab and ask again.";
  }

  const title = cleanText(snapshot.title || "Untitled page", 80);
  const host = hostFromUrl(snapshot.url);
  const firstText = firstReadableSentence(snapshot.visibleText, 120);
  const controls = summarizeElements(snapshot.elements || []);

  const line1 = host
    ? `You're on "${title}" at ${host}.`
    : `You're on "${title}".`;
  const line2 = controls
    ? `${firstText || "The visible page has little readable text."} ${controls}`
    : `${firstText || "The visible page has little readable text."}`;
  return `${line1}\n${cleanText(line2, 190)}`;
}

async function summarizeWithCloud({ task, snapshot, safeText, settings }) {
  const title = sanitizeForCloud(snapshot?.title || "Current page");
  const url = safePageUrl(snapshot?.url || "");
  const messages = [
    {
      role: "system",
      content: [
        "You are Friday, a concise browser-side assistant.",
        "Summarize only from the provided visible page text.",
        "Keep it short: 3 bullets or fewer, no extra preface.",
        "The text was scrubbed for private data before it reached you.",
      ].join(" "),
    },
    {
      role: "user",
      content: [
        `User request: ${task}`,
        `Page title: ${title}`,
        `URL: ${url}`,
        "",
        "Visible page text:",
        safeText || "(no readable text)",
      ].join("\n"),
    },
  ];
  return chatPlain({
    provider: settings.byokProvider,
    apiKey: settings.byokApiKey,
    model: settings.byokModel,
    messages,
    temperature: 0.2,
    maxTokens: 260,
  });
}

function summarizeLocally(snapshot, text) {
  if (snapshot?._snapshotError) {
    return "I cannot inspect this browser page. Open a normal http(s) website tab and ask again.";
  }
  const title = cleanText(snapshot?.title || "Current page", 100);
  const sentences = splitSentences(text).slice(0, 3);
  if (!sentences.length) {
    const controls = summarizeElements(snapshot?.elements || []);
    return controls
      ? `"${title}" has very little readable page text. ${controls}`
      : `"${title}" has very little readable page text.`;
  }
  return [`${title}:`, ...sentences.map((s) => `- ${cleanText(s, 180)}`)].join("\n");
}

export function sanitizeForCloud(text) {
  let out = String(text || "");
  const replacements = [
    [PATTERNS.email, "[email]"],
    [PATTERNS.aadhaar, "[aadhaar]"],
    [PATTERNS.pan, "[pan]"],
    [PATTERNS.ssn, "[ssn]"],
    [PATTERNS.cc, "[card-number]"],
    [PATTERNS.phoneIn, "[phone]"],
    [PATTERNS.phoneUs, "[phone]"],
  ];
  for (const [rx, label] of replacements) {
    out = out.replace(toGlobal(rx), label);
  }
  out = out.replace(/\+\s*\[phone\]/g, "[phone]");
  return out.replace(/\s+/g, " ").trim();
}

function toGlobal(rx) {
  const flags = rx.flags.includes("g") ? rx.flags : `${rx.flags}g`;
  return new RegExp(rx.source, flags);
}

function summarizeElements(elements) {
  const visible = Array.isArray(elements) ? elements : [];
  const buttons = visible.filter((e) => e.role === "button").length;
  const links = visible.filter((e) => e.role === "link").length;
  const fields = visible.filter((e) => ["textbox", "searchbox", "combobox"].includes(e.role)).length;
  const names = visible
    .map((e) => e.name || e.text || e.placeholder || "")
    .filter(Boolean)
    .slice(0, 3)
    .map((s) => `"${cleanText(s, 28)}"`);
  const counts = [];
  if (buttons) counts.push(`${buttons} button${buttons === 1 ? "" : "s"}`);
  if (links) counts.push(`${links} link${links === 1 ? "" : "s"}`);
  if (fields) counts.push(`${fields} field${fields === 1 ? "" : "s"}`);
  if (!counts.length) return "";
  return `I can interact with ${counts.join(", ")}${names.length ? `, including ${names.join(", ")}.` : "."}`;
}

function firstReadableSentence(text, maxLen) {
  const sentence = splitSentences(text)[0] || "";
  return cleanText(sentence, maxLen);
}

function splitSentences(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20);
}

function cleanText(text, maxLen) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!maxLen || s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(0, maxLen - 1)).trim()}...`;
}

function hostFromUrl(url) {
  try { return new URL(url).hostname; }
  catch { return ""; }
}

function safePageUrl(url) {
  try {
    const u = new URL(url);
    return sanitizeForCloud(`${u.origin}${u.pathname}`);
  } catch {
    return "";
  }
}
