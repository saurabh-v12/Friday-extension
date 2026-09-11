// Client-side intent shortcuts — direct execution, no LLM call.
//
// Trivial commands ("scroll down", "reload", "back") were burning 2–3
// Groq API calls per invocation via the tool-calling loop, which chewed
// through the free-tier rate limit almost immediately. This module
// intercepts those in the side panel BEFORE the composer hands off to
// chatAgent, so the cost is zero.
//
// Match order matters — more specific patterns first.

import { MESSAGE_TYPES, sendToBackground } from "./messaging.js";

// Query the currently-active tab. Available with `activeTab` permission
// after any user gesture (which the composer submit is). tab.url/title
// won't be present without the `tabs` permission — we only need id.
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab.");
  return tab;
}

// Inject a tiny history call into the content tab. Uses `scripting` +
// `activeTab` which the manifest already has — avoids needing the
// heavier `tabs` permission for goBack/goForward (which require it).
async function runInTab(func) {
  const tab = await activeTab();
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, func });
}

const SHORTCUTS = [
  {
    name: "scroll",
    pattern: /^\s*scroll\s+(up|down|top|bottom)\b\s*$/i,
    handler: async (match) => {
      const direction = match[1].toLowerCase();
      const result = await sendToBackground(MESSAGE_TYPES.EXEC_TOOL, {
        tool: "scroll",
        args: { direction },
      });
      if (result && result.ok === false) throw new Error(result.error || "scroll failed");
      return `Scrolled ${direction}.`;
    },
  },
  {
    name: "reload",
    pattern: /^\s*(reload|refresh)(\s+(this\s+)?(page|tab))?\s*[.!]?\s*$/i,
    handler: async () => {
      const tab = await activeTab();
      await chrome.tabs.reload(tab.id);
      return "Page reloaded.";
    },
  },
  {
    name: "back",
    pattern: /^\s*(go\s+)?back\s*[.!]?\s*$/i,
    handler: async () => {
      await runInTab(() => history.back());
      return "Went back.";
    },
  },
  {
    name: "forward",
    pattern: /^\s*(go\s+)?forward\s*[.!]?\s*$/i,
    handler: async () => {
      await runInTab(() => history.forward());
      return "Went forward.";
    },
  },
  {
    name: "new-tab",
    pattern: /^\s*(open\s+(a\s+)?)?new\s+tab\s*[.!]?\s*$/i,
    handler: async () => {
      await chrome.tabs.create({});
      return "New tab opened.";
    },
  },
  {
    name: "close-tab",
    pattern: /^\s*close\s+(this\s+)?tab\s*[.!]?\s*$/i,
    handler: async () => {
      const tab = await activeTab();
      await chrome.tabs.remove(tab.id);
      return "Tab closed.";
    },
  },
];

// Match a raw user message against the shortcut patterns. Returns
// {name, match, handler} or null. Case- and whitespace-insensitive by
// virtue of each pattern being written that way.
export function matchShortcut(task) {
  const t = String(task || "");
  for (const s of SHORTCUTS) {
    const m = t.match(s.pattern);
    if (m) return { name: s.name, match: m, handler: s.handler };
  }
  return null;
}

// Execute the matched shortcut. Logs [shortcut] cmd=<name> before
// running so the DevTools console shows the LLM was bypassed.
export async function runShortcut(shortcut) {
  console.log(`[shortcut] cmd=${shortcut.name}`);
  return await shortcut.handler(shortcut.match);
}
