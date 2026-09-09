// Friday service worker.
// Task 1.1: message router between popup / side panel / content script.
// Handler table dispatches on message.type; every handler is async and its
// return value becomes the response's `data`. Errors become `{ ok: false }`.

import {
  MESSAGE_TYPES,
  SETTING_KEYS,
  SETTING_DEFAULTS,
} from "./src/messaging.js";

const handlers = {
  async [MESSAGE_TYPES.PING](payload) {
    return { pong: true, receivedAt: Date.now(), echo: payload ?? null };
  },

  async [MESSAGE_TYPES.GET_SETTINGS]() {
    const stored = await chrome.storage.local.get(SETTING_KEYS);
    const out = {};
    for (const k of SETTING_KEYS) {
      out[k] = Object.prototype.hasOwnProperty.call(stored, k)
        ? stored[k]
        : SETTING_DEFAULTS[k];
    }
    return out;
  },

  async [MESSAGE_TYPES.SET_SETTING](payload) {
    if (!payload || typeof payload.key !== "string") {
      throw new Error("SET_SETTING requires { key, value }");
    }
    if (!SETTING_KEYS.includes(payload.key)) {
      throw new Error(`unknown setting: ${payload.key}`);
    }
    await chrome.storage.local.set({ [payload.key]: payload.value });
    return { key: payload.key, value: payload.value };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const requestId = msg && msg.requestId;
  const type = msg && msg.type;
  const handler = handlers[type];
  if (!handler) {
    sendResponse({ ok: false, error: `unknown message type: ${type}`, requestId });
    return false;
  }
  (async () => {
    try {
      const data = await handler(msg.payload, { sender });
      sendResponse({ ok: true, data, requestId });
    } catch (err) {
      sendResponse({ ok: false, error: String(err && err.message ? err.message : err), requestId });
    }
  })();
  return true; // keep the port open for the async sendResponse
});

// First-install / update: seed defaults so GET_SETTINGS is stable from turn one.
chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(SETTING_KEYS);
  const patch = {};
  for (const k of SETTING_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(stored, k)) patch[k] = SETTING_DEFAULTS[k];
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
});
