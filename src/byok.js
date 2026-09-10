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

// Default model per provider — the top entry of KNOWN_MODELS[provider].
// Applied when no explicit model is saved, when the saved model looks like
// a provider name, or as the picker's initial selection.
export const DEFAULT_MODELS = Object.freeze({
  gemini: "gemini-2.0-flash",
  openai: "gpt-4o-mini",
  groq: "openai/gpt-oss-20b",
});

// Curated list of TOOL-CALLING-CAPABLE models per provider, top = default.
//
// Not a fallback anymore — this is what the Settings dropdown offers.
// Reason: the tool-calling chat loop (`chatWithTools`) 400s when the user
// picks a model without tool support, and no provider's public /models
// endpoint advertises tool-calling capability (Groq's is the worst
// offender — `whisper-*`, `*-guard-*`, `gemma-*` all appear active but
// reject `tools`). Live-fetching couldn't filter these out, so we curate.
//
// A "Custom…" option in the picker lets users type any model id when new
// ones ship or they want to try a non-tool model for text-only calls.
export const KNOWN_MODELS = Object.freeze({
  gemini: ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-1.5-flash"],
  openai: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
  groq: ["openai/gpt-oss-20b", "openai/gpt-oss-120b", "groq/compound-mini", "groq/compound"],
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

// ─── Plain multi-turn chat (no tools, no page snapshot) ─────────────
//
// Used by Chat mode. Takes a `messages` array in OpenAI shape
// ([{role:"system"|"user"|"assistant", content}]) and returns the
// assistant's text as a string. All three providers supported —
// OpenAI/Groq via chatOpenAICompatible without a `tools` payload,
// Gemini via v1beta generateContent (system → systemInstruction,
// assistant → role:"model").
export async function chatPlain({ provider, apiKey, model, messages, temperature = 0.4, maxTokens = 1024 }) {
  if (!apiKey) throw new Error("chatPlain: missing API key");
  if (!Array.isArray(messages) || !messages.length) throw new Error("chatPlain: messages required");
  let m = model;
  if (!m || looksLikeProviderName(m, provider)) m = DEFAULT_MODELS[provider];

  if (provider === BYOK_PROVIDERS.OPENAI) {
    const res = await chatOpenAICompatible("https://api.openai.com/v1/chat/completions", "OpenAI",
      { apiKey, model: m, messages, tools: null, temperature, maxTokens });
    return (res.message?.content || "").trim();
  }
  if (provider === BYOK_PROVIDERS.GROQ) {
    const res = await chatOpenAICompatible("https://api.groq.com/openai/v1/chat/completions", "Groq",
      { apiKey, model: m, messages, tools: null, temperature, maxTokens });
    return (res.message?.content || "").trim();
  }
  if (provider === BYOK_PROVIDERS.GEMINI) {
    return chatGeminiPlain({ apiKey, model: m, messages, temperature, maxTokens });
  }
  throw new Error(`chatPlain: unknown provider "${provider}"`);
}

async function chatGeminiPlain({ apiKey, model, messages, temperature, maxTokens }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const systemParts = [];
  const contents = [];
  for (const msg of messages) {
    const text = typeof msg.content === "string" ? msg.content : "";
    if (msg.role === "system") systemParts.push({ text });
    else if (msg.role === "user") contents.push({ role: "user", parts: [{ text }] });
    else if (msg.role === "assistant") contents.push({ role: "model", parts: [{ text }] });
    // Ignore role:"tool" — plain chat doesn't include tool results.
  }
  const body = {
    contents,
    generationConfig: { temperature, maxOutputTokens: maxTokens },
  };
  if (systemParts.length) body.systemInstruction = { parts: systemParts };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    let msg = txt;
    try { msg = JSON.parse(txt)?.error?.message || txt; } catch (_) { /* keep raw */ }
    const err = new Error(`Gemini ${res.status}: ${String(msg).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || "").join("").trim();
}
