// BYOK — Bring Your Own Key cloud adapters (Task 4.3).
//
// Uniform surface for three families: Google Gemini, OpenAI GPT-4/4o, and
// Groq (uses OpenAI-compatible API). Every provider takes:
//   {apiKey, model, prompt, imageDataUrl}
// and returns a plain string — the model's raw text output. Parsing into
// an action shape lives in router.js so this file stays a thin adapter.
//
// Keys live in chrome.storage.local (device-scoped, encrypted at rest by
// the OS keychain that backs it). No further encryption is applied — a
// passphrase-per-session would trade too much UX for a marginal gain
// against a local-machine threat model.

export const BYOK_PROVIDERS = Object.freeze({
  GEMINI: "gemini",
  OPENAI: "openai",
  GROQ: "groq",
});

// Fallback defaults — used only when the live /models fetch can't run
// (no key yet) or fails and the user hasn't picked something explicit.
// The live-model dropdown in Settings is the authoritative source; these
// values keep going stale on their own (Groq deprecated the entire
// llama-3.2-vision-preview line in early 2025, and llama-4-scout on
// 2026-07-17), so we do NOT rely on them at request time when a key is
// available.
export const DEFAULT_MODELS = Object.freeze({
  gemini: "gemini-2.0-flash",
  openai: "gpt-4o-mini",
  groq: "llama-3.3-70b-versatile", // text; vision users should pick a
                                    // llama-4 variant from the live list.
});

// Pre-fetch suggestions surfaced in the Settings dropdown BEFORE the user
// enters a key (so the picker isn't empty). Once a key is present we
// fetch the live list and this array is ignored. Deliberately short —
// keeping it small reduces the chance of a stale entry misleading users.
export const KNOWN_MODELS = Object.freeze({
  gemini: ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-pro"],
  openai: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
  groq: ["llama-3.3-70b-versatile", "meta-llama/llama-4-maverick-17b-128e-instruct"],
});

// True if `model` looks like the user typed the provider name into the
// model field ("groq", "openai", "gemini"). We treat those as unset and
// fall back to the default. This is the exact class of mistake that
// caused the reported `The model "groq" does not exist` 404.
function looksLikeProviderName(model, provider) {
  if (!model) return false;
  const m = String(model).trim().toLowerCase();
  if (m === provider) return true;
  return Object.values(BYOK_PROVIDERS).includes(m);
}

export async function callByok({ provider, apiKey, model, prompt, imageDataUrl }) {
  const p = provider || BYOK_PROVIDERS.GEMINI;
  let m = model;
  if (!m || looksLikeProviderName(m, p)) {
    if (m) console.warn(`[friday.byok] model "${m}" looks like a provider name, not a model id — falling back to default for ${p}`);
    m = DEFAULT_MODELS[p];
  }
  if (!apiKey) throw new Error("BYOK: missing API key");
  const impl = IMPLS[p];
  if (!impl) throw new Error(`BYOK: unknown provider "${p}"`);
  return impl({ apiKey, model: m, prompt, imageDataUrl });
}

// ─── Live model listing ─────────────────────────────────────────────
//
// Root cause of the recurring Groq 404s: hardcoded model IDs go stale
// on their own schedule (Groq deprecated llama-3.2-*-vision-preview in
// early 2025 and llama-4-scout-17b-16e-instruct on 2026-07-17). The
// only fix that doesn't require a code change every few months is to
// ask the provider what it currently serves.
//
// listModels({provider, apiKey}) → [{id, meta}]
//   • Rejects if the key is missing or the API returns non-2xx — callers
//     surface the error to the user instead of quietly falling back to
//     a hardcoded default that may itself be dead.
//   • Returns a flat array of {id, ...} sorted alphabetically. Extra
//     provider-specific fields (context window, owned_by, description)
//     ride along so the UI can group / filter later without another
//     fetch.

const REQ_TIMEOUT_MS = 15_000;

async function fetchJson(url, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) {
      // Try to pull the provider's error message out; fall back to raw.
      let detail = text;
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.error?.message || parsed?.message || text;
      } catch (_) { /* keep raw */ }
      const err = new Error(`${res.status}: ${String(detail).slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    try { return JSON.parse(text); } catch (e) {
      throw new Error(`invalid JSON from ${url}: ${e.message}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function listGeminiModels(apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  const data = await fetchJson(url);
  const raw = Array.isArray(data.models) ? data.models : [];
  return raw
    // Keep only models the /generateContent endpoint accepts — otherwise
    // users could pick an embedding model and get confusing errors.
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => ({
      id: String(m.name || "").replace(/^models\//, ""),
      description: m.description || m.displayName || "",
      contextTokens: m.inputTokenLimit || null,
    }))
    .filter((m) => m.id);
}

async function listOpenAIModels(apiKey) {
  const data = await fetchJson("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const raw = Array.isArray(data.data) ? data.data : [];
  return raw
    .map((m) => ({
      id: String(m.id || ""),
      ownedBy: m.owned_by || "",
      created: m.created || 0,
    }))
    .filter((m) => m.id);
}

async function listGroqModels(apiKey) {
  const data = await fetchJson("https://api.groq.com/openai/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const raw = Array.isArray(data.data) ? data.data : [];
  return raw
    // Groq's /models includes deactivated entries; skip them so users
    // never see a listed-but-dead model.
    .filter((m) => m.active !== false)
    .map((m) => ({
      id: String(m.id || ""),
      contextWindow: m.context_window || null,
      ownedBy: m.owned_by || "",
    }))
    .filter((m) => m.id);
}

const MODEL_LISTERS = {
  [BYOK_PROVIDERS.GEMINI]: listGeminiModels,
  [BYOK_PROVIDERS.OPENAI]: listOpenAIModels,
  [BYOK_PROVIDERS.GROQ]:   listGroqModels,
};

export async function listModels({ provider, apiKey } = {}) {
  if (!provider) throw new Error("listModels: provider required");
  if (!apiKey) throw new Error("listModels: API key required");
  const impl = MODEL_LISTERS[provider];
  if (!impl) throw new Error(`listModels: unknown provider "${provider}"`);
  const list = await impl(apiKey);
  list.sort((a, b) => a.id.localeCompare(b.id));
  return list;
}

// Split a data URL "data:image/png;base64,AAAA…" into {mime, base64}.
function splitDataUrl(dataUrl) {
  const m = /^data:([^;,]+)(?:;base64)?,(.*)$/.exec(dataUrl || "");
  if (!m) throw new Error("BYOK: not a data URL image");
  return { mime: m[1], base64: m[2] };
}

// ─── Google Gemini (v1beta generateContent) ─────────────────────────
async function callGemini({ apiKey, model, prompt, imageDataUrl }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  // Text-only path: skip the inline_data image part entirely.
  const parts = [];
  if (imageDataUrl) {
    const { mime, base64 } = splitDataUrl(imageDataUrl);
    parts.push({ inline_data: { mime_type: mime, data: base64 } });
  }
  parts.push({ text: prompt });
  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: { temperature: 0, maxOutputTokens: 512 },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  const respParts = data?.candidates?.[0]?.content?.parts || [];
  return respParts.map((p) => p.text || "").join("").trim();
}

// ─── OpenAI (Chat Completions with image content parts) ─────────────
async function callOpenAI({ apiKey, model, prompt, imageDataUrl }) {
  const url = "https://api.openai.com/v1/chat/completions";
  const content = [{ type: "text", text: prompt }];
  if (imageDataUrl) {
    content.push({ type: "image_url", image_url: { url: imageDataUrl } });
  }
  const body = {
    model,
    temperature: 0,
    max_tokens: 512,
    messages: [{ role: "user", content }],
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data?.choices?.[0]?.message?.content || "").trim();
}

// ─── Groq (OpenAI-compatible API) ───────────────────────────────────
async function callGroq({ apiKey, model, prompt, imageDataUrl }) {
  const url = "https://api.groq.com/openai/v1/chat/completions";
  const content = [{ type: "text", text: prompt }];
  if (imageDataUrl) {
    content.push({ type: "image_url", image_url: { url: imageDataUrl } });
  }
  const body = {
    model,
    temperature: 0,
    max_tokens: 512,
    messages: [{ role: "user", content }],
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data?.choices?.[0]?.message?.content || "").trim();
}

const IMPLS = {
  [BYOK_PROVIDERS.GEMINI]: callGemini,
  [BYOK_PROVIDERS.OPENAI]: callOpenAI,
  [BYOK_PROVIDERS.GROQ]: callGroq,
};

// ─── Tool-calling multi-turn chat (Task: CONTROLLING) ────────────────
//
// A different entry point from callByok() because the shape is very
// different: we pass a full `messages` array (system + user + assistant
// + tool results) and a `tools` schema, and we get back the whole
// assistant message including any `tool_calls`. Callers loop:
//   1. chatWithTools(messages, tools) → assistant msg
//   2. if msg.tool_calls: run each, append role:"tool" replies, GOTO 1
//   3. else: msg.content is the final answer
//
// OpenAI and Groq speak the same OpenAI-compatible shape. Gemini uses
// a different tool format (functionDeclarations / functionResponse); we
// throw a clear error for now so the caller can fall back.
export async function chatWithTools({ provider, apiKey, model, messages, tools, temperature = 0, maxTokens = 1024 }) {
  if (!apiKey) throw new Error("chatWithTools: missing API key");
  if (!Array.isArray(messages) || !messages.length) throw new Error("chatWithTools: messages required");
  let m = model;
  if (!m || looksLikeProviderName(m, provider)) m = DEFAULT_MODELS[provider];
  const impl = TOOL_IMPLS[provider];
  if (!impl) throw new Error(`chatWithTools: provider "${provider}" doesn't support tool calling yet — switch to OpenAI or Groq`);
  return impl({ apiKey, model: m, messages, tools, temperature, maxTokens });
}

async function chatOpenAICompatible(endpoint, providerLabel, { apiKey, model, messages, tools, temperature, maxTokens }) {
  const body = {
    model,
    temperature,
    max_tokens: maxTokens,
    messages,
  };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    let msg = txt;
    try { msg = JSON.parse(txt)?.error?.message || txt; } catch (_) { /* keep raw */ }
    const err = new Error(`${providerLabel} ${res.status}: ${String(msg).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const choice = data?.choices?.[0] || {};
  return {
    message: choice.message || { role: "assistant", content: "" },
    finishReason: choice.finish_reason || "stop",
    usage: data.usage || null,
    model: data.model || model,
  };
}

const TOOL_IMPLS = {
  [BYOK_PROVIDERS.OPENAI]: (args) => chatOpenAICompatible("https://api.openai.com/v1/chat/completions", "OpenAI", args),
  [BYOK_PROVIDERS.GROQ]:   (args) => chatOpenAICompatible("https://api.groq.com/openai/v1/chat/completions", "Groq", args),
};

// True if the provider supports tool-calling through our wrapper. UI
// uses this to decide whether to route through chatWithTools or fall
// back to the plain callByok text path.
export function supportsToolCalling(provider) {
  return provider === BYOK_PROVIDERS.OPENAI || provider === BYOK_PROVIDERS.GROQ;
}
