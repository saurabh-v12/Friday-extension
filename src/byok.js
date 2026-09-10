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

// Default model per provider — the fastest cheap vision-capable option
// per family as of late 2025. Overridable via settings.
export const DEFAULT_MODELS = Object.freeze({
  gemini: "gemini-2.0-flash",
  openai: "gpt-4o-mini",
  groq: "llama-3.2-11b-vision-preview",
});

export async function callByok({ provider, apiKey, model, prompt, imageDataUrl }) {
  const p = provider || BYOK_PROVIDERS.GEMINI;
  const m = model || DEFAULT_MODELS[p];
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
  const { mime, base64 } = splitDataUrl(imageDataUrl);
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { inline_data: { mime_type: mime, data: base64 } },
          { text: prompt },
        ],
      },
    ],
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
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || "").join("").trim();
}

// ─── OpenAI (Chat Completions with image content parts) ─────────────
async function callOpenAI({ apiKey, model, prompt, imageDataUrl }) {
  const url = "https://api.openai.com/v1/chat/completions";
  const body = {
    model,
    temperature: 0,
    max_tokens: 512,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      },
    ],
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
  const body = {
    model,
    temperature: 0,
    max_tokens: 512,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      },
    ],
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
