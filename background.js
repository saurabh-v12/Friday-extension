// Friday service worker.
// Task 1.1: message router between popup / side panel / content script.
// Handler table dispatches on message.type; every handler is async and its
// return value becomes the response's `data`. Errors become `{ ok: false }`.

import {
  MESSAGE_TYPES,
  SETTING_KEYS,
  SETTING_DEFAULTS,
  sendToTab,
} from "./src/messaging.js";
import { detectDomPii } from "./src/pii.js";

// Pages the extension can't inject into (chrome://, chrome-extension://,
// edge://, view-source:, PDF viewer, etc.). Keep the check permissive: http
// and https only for now.
function isInjectableUrl(url) {
  return typeof url === "string" && /^https?:/i.test(url);
}

async function ensureContentInActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error("no active tab");
  if (!isInjectableUrl(tab.url)) {
    throw new Error(`can't inject on ${tab.url || "(unknown)"} — http(s) only`);
  }
  // Idempotent — content.js short-circuits on __fridayContentLoaded.
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["content.js"],
  });
  return tab;
}

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

  async [MESSAGE_TYPES.CONTENT_PING](payload) {
    const tab = await ensureContentInActiveTab();
    const data = await sendToTab(tab.id, MESSAGE_TYPES.CONTENT_PING, payload);
    return { tabId: tab.id, tabUrl: tab.url, ...data };
  },

  async [MESSAGE_TYPES.EXECUTE](payload) {
    const tab = await ensureContentInActiveTab();
    const data = await sendToTab(tab.id, MESSAGE_TYPES.EXECUTE, payload);
    return { tabId: tab.id, ...data };
  },

  async [MESSAGE_TYPES.RESOLVE](payload) {
    const tab = await ensureContentInActiveTab();
    const data = await sendToTab(tab.id, MESSAGE_TYPES.RESOLVE, payload);
    return { tabId: tab.id, ...data };
  },

  async [MESSAGE_TYPES.SNAPSHOT_COMPACT](payload) {
    const tab = await ensureContentInActiveTab();
    const data = await sendToTab(tab.id, MESSAGE_TYPES.SNAPSHOT_COMPACT, payload);
    return { tabId: tab.id, tabUrl: tab.url, ...data };
  },

  // Tool calls from the chat agent. Most go to the content script, but
  // `goto` needs chrome.tabs.update which is only available here.
  async [MESSAGE_TYPES.EXEC_TOOL](payload) {
    const { tool, args } = payload || {};
    if (tool === "goto") {
      const url = args && args.url;
      if (!url || typeof url !== "string") return { ok: false, error: "goto requires a url string" };
      if (!isInjectableUrl(url)) return { ok: false, error: `goto refused — http(s) only, got ${url}` };
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) return { ok: false, error: "no active tab" };
      await chrome.tabs.update(tab.id, { url });
      return { ok: true, message: `navigating to ${url}` };
    }
    const tab = await ensureContentInActiveTab();
    return sendToTab(tab.id, MESSAGE_TYPES.EXEC_TOOL, { tool, args });
  },

  async [MESSAGE_TYPES.CAPTURE_TAB](payload) {
    const tab = await ensureContentInActiveTab();
    // Run capture + snapshot in parallel — one is a Chrome API call from the
    // service worker, the other is a message to the content script.
    const tCap0 = Date.now();
    const [screenshotDataUrl, snap] = await Promise.all([
      chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" }),
      sendToTab(tab.id, MESSAGE_TYPES.SNAPSHOT, payload),
    ]);
    const captureMs = Date.now() - tCap0;
    const pii = detectDomPii(snap.elements);
    return {
      tabId: tab.id,
      screenshot: screenshotDataUrl,
      screenshotBytes: (screenshotDataUrl || "").length,
      captureMs,
      ...snap,
      pii,
    };
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

// First-install / update: seed defaults so GET_SETTINGS is stable from turn one,
// and make clicking the toolbar icon open the side panel instead of a popup.
chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(SETTING_KEYS);
  const patch = {};
  for (const k of SETTING_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(stored, k)) patch[k] = SETTING_DEFAULTS[k];
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
});

// Applied every boot (setPanelBehavior isn't persisted across service-worker restarts).
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.warn("[friday.bg] setPanelBehavior failed:", err));
