// Friday side panel entry.
// Task 1.2: visual shell + empty state only. All controls are wired in 1.3.
// Right now this just proves the module loads and confirms BG messaging
// works from the side panel context (not just from the popup).

import { MESSAGE_TYPES, sendToBackground } from "./messaging.js";

document.addEventListener("DOMContentLoaded", async () => {
  try {
    const data = await sendToBackground(MESSAGE_TYPES.PING, { from: "sidepanel" });
    console.info("[friday.sidepanel] BG PING ok:", data);
  } catch (err) {
    console.warn("[friday.sidepanel] BG PING failed:", err);
  }
});
