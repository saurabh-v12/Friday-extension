// Shared messaging surface for popup / side panel / content script ↔ service
// worker. Every message carries a requestId so callers can correlate an async
// response back to their request without extra bookkeeping.
//
// Envelope:
//   { type: string, payload?: any, requestId: string }
// Reply envelope:
//   { ok: true, data?: any, requestId }   |   { ok: false, error: string, requestId }

export const MESSAGE_TYPES = Object.freeze({
  PING: "PING",
  GET_SETTINGS: "GET_SETTINGS",
  SET_SETTING: "SET_SETTING",
  // BG-side: inject the content script into the active tab if needed, then
  // ping it and return its response. Also the type the content script
  // itself responds to.
  CONTENT_PING: "CONTENT_PING",
  // BG-side: chrome.tabs.captureVisibleTab + content-side DOM/a11y snapshot,
  // combined into one structured payload. Content-side type is SNAPSHOT.
  CAPTURE_TAB: "CAPTURE_TAB",
  SNAPSHOT: "SNAPSHOT",
  // BG-side: forward an executor action (click / type / scroll / focus) to
  // the content script. Content-side type is EXECUTE.
  EXECUTE: "EXECUTE",
  // Content-side: resolve an intent string to a specific element fid.
  // (Executor + resolver bridge — used by Phase 4 for LLM tool-calls.)
  RESOLVE: "RESOLVE",
});

// Persisted user preferences. Keep this list authoritative — new UI state
// that needs to survive a restart should be added here, not scattered.
export const SETTING_KEYS = Object.freeze([
  "mode",             // 'chat' | 'agent'
  "onDeviceOnly",     // boolean — Cloud vs On-Device toggle (derived from reasoningSource)
  "vlmEnabled",       // boolean — opt-in local VLM (deferred per gate 0.7)
  "reasoningSource",  // 'local' | 'byok' — SOURCES from src/router.js
  "byokProvider",     // 'gemini' | 'openai' | 'groq'
  "byokApiKey",       // string — stored in chrome.storage.local (device-scoped)
  "byokModel",        // string — provider-specific model id
]);

export const SETTING_DEFAULTS = Object.freeze({
  mode: "chat",
  onDeviceOnly: true,
  vlmEnabled: false,
  reasoningSource: "local",
  byokProvider: "gemini",
  byokApiKey: "",
  byokModel: "",
});

function newRequestId() {
  // crypto.randomUUID is available in service workers, extension pages,
  // and content scripts in modern Chrome.
  return crypto.randomUUID();
}

function unwrap(resp) {
  if (chrome.runtime.lastError) {
    throw new Error(chrome.runtime.lastError.message);
  }
  if (!resp) throw new Error("no response from receiver");
  if (!resp.ok) throw new Error(resp.error || "unknown error");
  return resp.data;
}

// Caller ↔ background service worker.
export function sendToBackground(type, payload) {
  const requestId = newRequestId();
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload, requestId }, (resp) => {
      try { resolve(unwrap(resp)); } catch (err) { reject(err); }
    });
  });
}

// Background ↔ a specific tab's content script.
export function sendToTab(tabId, type, payload) {
  const requestId = newRequestId();
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type, payload, requestId }, (resp) => {
      try { resolve(unwrap(resp)); } catch (err) { reject(err); }
    });
  });
}
