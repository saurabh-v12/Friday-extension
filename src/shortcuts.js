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
  // Navigation. Must stay LAST — the patterns above are more specific, and
  // "open new tab" has to reach the new-tab entry rather than being read as
  // a site named "new tab".
  //
  // This exists because navigation was previously unreachable on the local
  // path: "open youtube" matched no shortcut, so it fell through to
  // pickSubmitFlow, and On-Device + Chat (the DEFAULT mode) routes to plain
  // chat with no tools at all — so the model could only apologise. Agent
  // mode technically has `goto`, but relies on a 1.5B model emitting exact
  // JSON, which it often doesn't. Resolving the URL here keeps navigation
  // deterministic and mode-independent, at zero LLM cost.
  {
    name: "open-site",
    pattern: /^\s*(?:open|launch|visit|go\s+to|goto|navigate\s+to)\s+(?:the\s+)?(.+?)(?:\s+(?:on|in|using|with)\s+(?:google\s+)?(?:chrome|browser|the\s+browser|a\s+new\s+tab|new\s+tab))?\s*[.!?]*\s*$/i,
    // Only claims the command when the target resolves to a real site.
    // Anything else (e.g. "open the second video") returns null so the
    // request falls through to the agent instead of being hijacked.
    resolve: (match) => {
      const url = resolveSiteUrl(match[1]);
      return url ? { url } : null;
    },
    handler: async (match, { url }) => {
      await chrome.tabs.create({ url });
      return `Opened ${hostLabel(url)}.`;
    },
  },
];

// Sites where a bare "<word>.com" guess would be wrong.
const SITE_ALIASES = new Map([
  ["youtube", "https://www.youtube.com"],
  ["yt", "https://www.youtube.com"],
  ["gmail", "https://mail.google.com"],
  ["mail", "https://mail.google.com"],
  ["google", "https://www.google.com"],
  ["google maps", "https://maps.google.com"],
  ["maps", "https://maps.google.com"],
  ["google drive", "https://drive.google.com"],
  ["drive", "https://drive.google.com"],
  ["wikipedia", "https://www.wikipedia.org"],
  ["wiki", "https://www.wikipedia.org"],
  ["twitter", "https://x.com"],
  ["x", "https://x.com"],
  ["chatgpt", "https://chat.openai.com"],
  ["stack overflow", "https://stackoverflow.com"],
  ["stackoverflow", "https://stackoverflow.com"],
]);

// Bare words that are page furniture, not websites. Without this guard the
// "<word>.com" fallback would turn "open settings" into settings.com.
const NON_SITE_WORDS = new Set([
  "video", "videos", "button", "buttons", "link", "links", "tab", "tabs",
  "page", "pages", "screen", "window", "popup", "panel", "sidebar", "menu",
  "settings", "form", "field", "fields", "input", "inputs", "item", "items",
  "heading", "headings", "image", "images", "file", "files", "folder",
  "first", "second", "third", "fourth", "fifth", "next", "previous", "last",
  "this", "that", "it", "one", "two", "three",
]);

// Resolve a spoken/typed target to a concrete URL, or null if we can't be
// confident. Null is the safe answer — it hands the request to the agent
// rather than navigating somewhere the user didn't ask for.
function resolveSiteUrl(raw) {
  const t = String(raw || "").trim().toLowerCase().replace(/[\s.!?,]+$/, "");
  if (!t) return null;

  if (/^https?:\/\//i.test(t)) {
    try { return new URL(t).href; } catch { return null; }
  }
  if (SITE_ALIASES.has(t)) return SITE_ALIASES.get(t);

  // Already domain-shaped ("google.com", "news.ycombinator.com").
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(t) && /\.[a-z]{2,}$/.test(t)) {
    return `https://${t}`;
  }
  // Single bare word → .com. Covers "open github", "open amazon".
  if (/^[a-z0-9-]{2,}$/.test(t) && !NON_SITE_WORDS.has(t)) {
    return `https://${t}.com`;
  }
  return null;
}

function hostLabel(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

// Match a raw user message against the shortcut patterns. Returns
// {name, match, handler} or null. Case- and whitespace-insensitive by
// virtue of each pattern being written that way.
// A shortcut may also define `resolve(match)`, which returns extra fields to
// carry to the handler, or null to decline the match. Declining continues the
// loop, so a pattern can match loosely and still bow out when it can't act.
export function matchShortcut(task) {
  const t = String(task || "");
  for (const s of SHORTCUTS) {
    const m = t.match(s.pattern);
    if (!m) continue;
    let extra = {};
    if (s.resolve) {
      const resolved = s.resolve(m);
      if (!resolved) continue;
      extra = resolved;
    }
    return { name: s.name, match: m, handler: s.handler, ...extra };
  }
  return null;
}

// Execute the matched shortcut. Logs [shortcut] cmd=<name> before
// running so the DevTools console shows the LLM was bypassed.
export async function runShortcut(shortcut) {
  console.log(`[shortcut] cmd=${shortcut.name}`);
  return await shortcut.handler(shortcut.match, shortcut);
}
