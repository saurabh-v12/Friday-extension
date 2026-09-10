// Brain Router (Task 4.1 + 4.2).
//
// route({task, payload, source, config}) is the single entry point every
// reasoning caller uses. Sources plug in behind ONE config value so we
// can swap on-device VLM ↔ cloud BYOK without touching the executor or
// the loop. Both sources produce a normalized action shape:
//
//   { type: 'click' | 'type' | 'scroll' | 'stop' | 'say',
//     fid?: string,             // for click / type / scroll
//     text?: string,            // for type / say
//     reasoning?: string,
//     confidence?: number,
//   }
//
// If a source returns free-form text (SmolVLM), parseAction() falls back to
// wrapping it as {type:'say'} so the loop can decide whether to stop.

import { runInferenceOnUrl, loadModel, state as modelState } from "./model.js";

export const SOURCES = Object.freeze({ LOCAL: "local", BYOK: "byok" });

// Public dispatch. `source` is one of SOURCES; `config` is source-specific:
//   local: {}
//   byok:  {provider, apiKey, model}
export async function route({ task, payload, source, config, mcpTools }) {
  if (source === SOURCES.LOCAL) return routeLocal({ task, payload, config, mcpTools });
  if (source === SOURCES.BYOK) return routeByok({ task, payload, config, mcpTools });
  throw new Error(`route: unknown source "${source}"`);
}

// ─── Local VLM (SmolVLM via Transformers.js) ─────────────────────────
//
// The gate-0.7 verdict stands: this path is functionally correct but slow
// on typical hardware. Kept behind the vlmEnabled opt-in. When it does run
// we ask for a short structured answer, then try to parse a JSON action;
// on parse failure we return `{type:'say'}` with the raw text.

async function routeLocal({ task, payload, mcpTools }) {
  if (!modelState.model) {
    await loadModel({ preferWebGPU: true });
  }
  const prompt = buildPrompt(task, payload, { mcpTools });
  const t0 = performance.now();
  const { output, inferMs } = await runInferenceOnUrl(payload.image.dataUrl, prompt);
  const totalMs = performance.now() - t0;
  const action = parseAction(output);
  return {
    source: SOURCES.LOCAL,
    raw: output,
    action,
    meta: { inferMs, totalMs, backend: modelState.backend },
  };
}

// ─── BYOK cloud (Task 4.3 wires the settings/UI; router just calls it) ─

async function routeByok({ task, payload, config, mcpTools }) {
  if (!config || !config.apiKey) {
    throw new Error("BYOK: no API key set (open Settings → Cloud API key)");
  }
  const { callByok } = await import("./byok.js");
  const t0 = performance.now();
  const output = await callByok({
    provider: config.provider,
    apiKey: config.apiKey,
    model: config.model,
    prompt: buildPrompt(task, payload, { mcpTools }),
    imageDataUrl: payload.image.dataUrl,
  });
  const latencyMs = performance.now() - t0;
  const action = parseAction(output);
  return {
    source: SOURCES.BYOK,
    raw: output,
    action,
    meta: { latencyMs, provider: config.provider, model: config.model },
  };
}

// ─── Prompt + parser ─────────────────────────────────────────────────

// Small, structured prompt. Even a weak model tends to output the JSON
// block when we show the exact schema and give it a concrete example.
export function buildPrompt(task, payload, opts = {}) {
  const elements = (payload.elements || [])
    .filter((e) => e.visible !== false)
    .slice(0, 60)
    .map((e) => {
      const val = summarizeValue(e.value);
      const name = (e.name || "").slice(0, 60).replace(/\s+/g, " ");
      const typeStr = e.type ? `:${e.type}` : "";
      return `- fid=${e.fid} <${e.tag}${typeStr}> role=${e.role} name="${name}"${val ? ` value=${val}` : ""}`;
    })
    .join("\n");

  const page = payload.page || {};
  const mcpTools = opts.mcpTools || [];
  const hasMcp = mcpTools.length > 0;
  const mcpBlock = hasMcp
    ? [
        "",
        "External tools you may call (MCP). Prefer DOM actions when possible;",
        'use tools only for off-page work. For a tool action, reply with',
        '{"action":"mcp","server":"...","tool":"...","args":{...},"reasoning":"..."}.',
        'Args are ALWAYS PII-scrubbed on the client before send.',
        "",
        "Tools:",
        mcpTools.slice(0, 20).map((t) => {
          const schema = t.tool.inputSchema ? JSON.stringify(t.tool.inputSchema).slice(0, 120) : "{}";
          return `- server=${t.server} tool=${t.tool.name} desc="${(t.tool.description || "").slice(0, 80)}" schema=${schema}`;
        }).join("\n"),
      ].join("\n")
    : "";

  const schema = hasMcp
    ? '  {"action":"click|type|scroll|mcp|stop|say", "fid":"f-N", "text":"...", "server":"...", "tool":"...", "args":{...}, "reasoning":"..."}'
    : '  {"action":"click|type|scroll|stop|say", "fid":"f-N", "text":"...", "reasoning":"..."}';

  return [
    "You are Friday, an on-device web agent. Given a redacted screenshot and",
    "a list of interactive DOM elements (with stable fids), decide the SINGLE",
    "next action to move toward the user's goal. Reply ONLY with a JSON",
    "object matching this schema:",
    "",
    schema,
    "",
    'Use "stop" when the task is complete or you cannot proceed.',
    'Use "say" only when you need to speak to the user without touching the page.',
    mcpBlock,
    "",
    `Page: ${page.host || ""}${page.path || ""}  —  ${page.title || ""}`,
    "",
    "Elements:",
    elements,
    "",
    `User task: ${task}`,
    "",
    "Respond with the JSON only.",
  ].join("\n");
}

function summarizeValue(v) {
  if (v == null) return null;
  if (typeof v === "string") return `"${v.slice(0, 40).replace(/"/g, '\\"')}"`;
  if (typeof v === "object" && v.masked) return `{masked:${v.kind || "?"}}`;
  if (typeof v === "object" && v.truncated) return `{truncated:${v.length}}`;
  return null;
}

// Best-effort JSON extraction. LLMs love to wrap JSON in ```json fences or
// leading prose; we grep for the first `{...}` block that parses.
export function parseAction(text) {
  if (!text || typeof text !== "string") return sayFallback(text);
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced ? fenced[1] : text).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return sayFallback(text);
  let obj;
  try { obj = JSON.parse(raw.slice(start, end + 1)); }
  catch { return sayFallback(text); }

  const type = String(obj.action || obj.type || "").toLowerCase();
  if (!["click", "type", "scroll", "mcp", "stop", "say"].includes(type)) return sayFallback(text);

  const out = { type };
  if (obj.fid) out.fid = String(obj.fid);
  if (obj.text) out.text = String(obj.text);
  if (obj.reasoning) out.reasoning = String(obj.reasoning);
  if (typeof obj.confidence === "number") out.confidence = obj.confidence;
  if (type === "mcp") {
    out.server = obj.server ? String(obj.server) : "";
    out.tool = obj.tool ? String(obj.tool) : "";
    out.args = obj.args && typeof obj.args === "object" ? obj.args : {};
  }
  return out;
}

function sayFallback(text) {
  return { type: "say", text: String(text || "").trim(), reasoning: "unparseable — treated as free-form response" };
}
