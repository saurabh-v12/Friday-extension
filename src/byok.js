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

// Default model per provider — a currently-live vision-capable option
// per family. Groq deprecated the `llama-3.2-*-vision-preview` line in
// early 2025; the Llama-4 series is the successor. Overridable via
// settings, but every value here must be a model that actually resolves
// on the provider's public API — otherwise a blank Settings input turns
// into a confusing 404.
export const DEFAULT_MODELS = Object.freeze({
  gemini: "gemini-2.0-flash",
  openai: "gpt-4o-mini",
  groq: "meta-llama/llama-4-scout-17b-16e-instruct",
});

// Suggested known-good model IDs per provider — surfaced as a <select>
// in the Settings UI so users pick from a list instead of typing "groq"
// into the model field by mistake (that was the original 404 that
// prompted this fix). Users can still supply a custom ID via the
// "Custom…" option; validation just makes the common path safe.
export const KNOWN_MODELS = Object.freeze({
  gemini: [
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-1.5-flash",
    "gemini-1.5-pro",
  ],
  openai: [
    "gpt-4o-mini",
    "gpt-4o",
    "gpt-4.1-mini",
  ],
  groq: [
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "meta-llama/llama-4-maverick-17b-128e-instruct",
    "llama-3.3-70b-versatile",
  ],
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
