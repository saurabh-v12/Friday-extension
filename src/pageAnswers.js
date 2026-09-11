// Page-answer helpers for "what's on the screen?" and "summarize this page".
//
// This path is deliberately separate from the agent/tool loop:
// - screen description should be instant and cheap;
// - page summarization should read visible page text locally, scrub obvious PII,
//   then call the user's BYOK model only when it is configured.

import { MESSAGE_TYPES, sendToBackground } from "./messaging.js";
import { chatPlain } from "./byok.js";
import { PATTERNS } from "./pii.js";
import { buildSanitizedPayload, runPrivacyPipeline } from "./pipeline.js";
import { detectWebGPU, loadModel, runInferenceOnUrl, state as vlmState } from "./model.js";

const SCREEN_DESCRIPTION = "screen-description";
const PAGE_SUMMARY = "page-summary";
const PAGE_QUESTION = "page-question";

const SCREEN_RE = /^\s*(?:(?:can\s+you\s+see\s+(?:my\s+|this\s+|the\s+)?(?:screen|page|tab|webpage))|(?:what(?:'s| is)\s+(?:on|in)\s+(?:my\s+|this\s+|the\s+)?(?:screen|page|tab|webpage))|(?:describe\s+(?:my\s+|this\s+|the\s+)?(?:screen|page|tab|webpage))|(?:what\s+am\s+i\s+(?:looking\s+at|seeing))|(?:what\s+(?:can|do)\s+you\s+see(?:\s+(?:on|in)\s+(?:my\s+|this\s+|the\s+)?(?:screen|page|tab|webpage))?)|(?:tell\s+me\s+what(?:'s| is)?\s+(?:on|in)\s+(?:my\s+|this\s+|the\s+)?(?:screen|page|tab|webpage))|(?:read\s+(?:my\s+|this\s+|the\s+)?(?:screen|page|tab|webpage)))\s*[?.!]*\s*$/i;
const SUMMARY_RE = /^\s*(?:(?:summari[sz]e|summary|tl;dr|recap)\b.*\b(?:this|the|current|page|webpage|article|screen|tab|site)\b|(?:summari[sz]e|summary|tl;dr|recap)\s*$)/i;
const PAGE_QUESTION_RE = /^\s*(?:what|what's|what is|which|who|when|where|why|how)\b.*\b(?:screen|page|webpage|tab|site|article)\b.*[?]?\s*$/i;

const PAGE_TEXT_CHARS = 5000;
const SNAPSHOT_TEXT_CHARS = 2200;
const SUMMARY_TEXT_CHARS = 4200;

export function matchPageAnswer(task) {
  const t = String(task || "").trim();
  if (!t) return null;
  if (SCREEN_RE.test(t)) return { name: SCREEN_DESCRIPTION };
  if (SUMMARY_RE.test(t)) return { name: PAGE_SUMMARY };
  if (PAGE_QUESTION_RE.test(t)) return { name: PAGE_QUESTION };
  return null;
}

export async function runPageAnswer({ task, intent, settings, onStatus }) {
  const source = settings?.reasoningSource || "local";
  const canUseCloud = source === "byok" && !!settings?.byokApiKey;

  if (intent?.name === SCREEN_DESCRIPTION) {
    onStatus?.("Reading the visible screen...");
    const snapshot = await fetchCompactSnapshot({ maxElements: 80, maxText: SNAPSHOT_TEXT_CHARS });
    const visual = await describeScreenWithLocalVision({ snapshot, settings, onStatus });
    if (visual) {
      return {
        text: visual,
        source: "local-vlm-screen",
      };
    }
    return {
      text: describeScreen(snapshot, { visualEnabled: !!settings?.vlmEnabled }),
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

  if (intent?.name === PAGE_QUESTION) {
    onStatus?.("Reading page context...");
    const [snapshot, textResult] = await Promise.all([
      fetchCompactSnapshot({ maxElements: 80, maxText: SNAPSHOT_TEXT_CHARS }),
      readVisiblePageText(),
    ]);
    const rawText = textResult?.text || snapshot?.visibleText || "";
    const safeText = sanitizeForCloud(rawText).slice(0, SUMMARY_TEXT_CHARS);
    const local = answerPageQuestionLocally(task, snapshot, safeText);
    if (local) return { text: local, source: "local-page-question" };

    if (canUseCloud && safeText.trim().length >= 80) {
      onStatus?.("Answering with page context...");
      const answer = await answerPageQuestionWithCloud({ task, snapshot, safeText, settings });
      return { text: answer || summarizeLocally(snapshot, safeText), source: "byok-page-question" };
    }

    return {
      text: summarizeLocally(snapshot, safeText || snapshot?.visibleText || ""),
      source: "local-page-question",
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

async function describeScreenWithLocalVision({ snapshot, settings, onStatus }) {
  if (!settings?.vlmEnabled) return "";
  try {
    onStatus?.("Capturing screen image locally...");
    const receipt = await runPrivacyPipeline({
      onPhase: (phase) => {
        const label =
          phase === "capturing" ? "Capturing screen image locally..." :
          phase === "detecting" ? "Detecting private visual regions locally..." :
          phase === "redacting" ? "Redacting screenshot locally..." :
          phase;
        onStatus?.(label);
      },
    });
    const payload = buildSanitizedPayload(receipt);
    if (!vlmState.model || !vlmState.processor) {
      onStatus?.("Loading local vision model...");
      const gpu = await detectWebGPU();
      await loadModel({
        preferWebGPU: gpu.available,
        onProgress: (evt) => {
          const pct = evt.pct ? ` (${evt.pct.toFixed(0)}%)` : "";
          onStatus?.(`Loading local vision model${pct}`);
        },
      });
    }
    onStatus?.("Looking at the redacted screenshot locally...");
    const prompt = [
      "You are Friday, a private local browser assistant.",
      "Describe this redacted browser screenshot in exactly two short lines.",
      "Use visual evidence from the image: layout, thumbnails, pictures, visible controls, and page structure.",
      "Do not invent details. Do not mention private text hidden by redaction except as private areas.",
      "Line 1: identify the visible page/app and what the user is looking at.",
      "Line 2: say what useful actions are visible for the agent.",
    ].join(" ");
    const result = await runInferenceOnUrl(payload.image.dataUrl, prompt);
    return normalizeVisualDescription(result.output, snapshot);
  } catch (err) {
    console.warn("[friday.pageAnswers] local visual screen description failed:", err);
    return "";
  }
}

function normalizeVisualDescription(text, snapshot) {
  const cleaned = String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*(?:assistant|answer)\s*:\s*/i, "")
    .split(/\n+|(?<=\.)\s+/)
    .map((line) => cleanText(line.replace(/^[-*\d.]+\s*/, ""), 160))
    .filter(Boolean)
    .slice(0, 2);
  if (cleaned.length >= 2) return cleaned.join("\n");
  if (cleaned.length === 1) {
    const controls = summarizeElements(snapshot?.elements || []);
    return `${cleaned[0]}\n${cleanText(controls || "I can use the visible controls on this page.", 190)}`;
  }
  return "";
}

function describeScreen(snapshot, { visualEnabled = false } = {}) {
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
  const fallbackNote = visualEnabled
    ? ""
    : " Local visual model is off, so this answer uses readable page text and controls.";
  const line2 = controls
    ? `${firstText || "The visible page has little readable text."} ${controls}`
    : `${firstText || "The visible page has little readable text."}`;
  return `${line1}\n${cleanText(`${line2}${fallbackNote}`, 190)}`;
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

async function answerPageQuestionWithCloud({ task, snapshot, safeText, settings }) {
  const title = sanitizeForCloud(snapshot?.title || "Current page");
  const url = safePageUrl(snapshot?.url || "");
  const messages = [
    {
      role: "system",
      content: [
        "You are Friday, a concise browser-side assistant.",
        "Answer only from the provided visible page text and element snapshot.",
        "Keep the answer to one or two short sentences.",
        "The text was scrubbed for private data before it reached you.",
      ].join(" "),
    },
    {
      role: "user",
      content: [
        `Question: ${task}`,
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
    temperature: 0.1,
    maxTokens: 160,
  });
}

function answerPageQuestionLocally(task, snapshot, text) {
  if (snapshot?._snapshotError) {
    return "I cannot inspect this browser page. Open a normal http(s) website tab and ask again.";
  }
  const q = String(task || "").toLowerCase();
  if (/\b(main\s+)?heading\b|\btitle\b/.test(q)) {
    const heading = findMainHeading(snapshot, text);
    if (heading) return `The main heading appears to be: "${cleanText(heading, 120)}".`;
  }
  if (/\bbutton|click\b/.test(q)) {
    const buttons = (snapshot?.elements || [])
      .filter((e) => e.role === "button")
      .map((e) => e.name || e.text || e.placeholder || "")
      .filter(Boolean)
      .slice(0, 5);
    if (buttons.length) return `I can see these buttons: ${buttons.map((b) => `"${cleanText(b, 40)}"`).join(", ")}.`;
  }
  if (/\blink\b/.test(q)) {
    const links = (snapshot?.elements || [])
      .filter((e) => e.role === "link")
      .map((e) => e.name || e.text || "")
      .filter(Boolean)
      .slice(0, 5);
    if (links.length) return `I can see these links: ${links.map((l) => `"${cleanText(l, 40)}"`).join(", ")}.`;
  }
  return "";
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

function findMainHeading(snapshot, text) {
  const elements = snapshot?.elements || [];
  const h1 = elements.find((e) => e.tag === "h1" && (e.text || e.name));
  if (h1) return h1.text || h1.name;
  const heading = elements.find((e) => e.role === "heading" && (e.text || e.name));
  if (heading) return heading.text || heading.name;
  return splitSentences(text)[0] || snapshot?.title || "";
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
