// Friday content script skeleton (Task 1.4).
//
// Loaded on-demand into the active tab by the service worker via
// chrome.scripting.executeScript. Runs in the isolated world so it can use
// chrome.runtime.* while touching the page's DOM safely.
//
// Injection is idempotent: subsequent injections short-circuit before
// re-registering the message listener (double registration would cause
// duplicate sendResponse calls and Chrome "message channel closed" warnings).
//
// Message types are duplicated here (rather than imported from
// src/messaging.js) because files passed to chrome.scripting.executeScript
// are loaded as classic scripts and cannot use ES module imports. Keep in
// sync with src/messaging.js MESSAGE_TYPES.

(function fridayContentBoot() {
  if (window.__fridayContentLoaded) {
    console.info("[friday.content] re-inject skipped");
    return;
  }
  window.__fridayContentLoaded = true;

  const MSG = {
    CONTENT_PING: "CONTENT_PING",
  };

  const handlers = {
    [MSG.CONTENT_PING](payload) {
      const doc = document;
      return {
        pong: true,
        url: location.href,
        title: doc.title,
        readyState: doc.readyState,
        nodeCount: doc.querySelectorAll("*").length,
        formCount: doc.forms.length,
        inputCount: doc.querySelectorAll("input, textarea, select").length,
        echo: payload ?? null,
        receivedAt: Date.now(),
      };
    },
  };

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const type = msg && msg.type;
    const handler = handlers[type];
    if (!handler) return false; // let other listeners (if any) handle it
    (async () => {
      try {
        const data = await handler(msg.payload);
        sendResponse({ ok: true, data, requestId: msg.requestId });
      } catch (err) {
        sendResponse({
          ok: false,
          error: String(err && err.message ? err.message : err),
          requestId: msg.requestId,
        });
      }
    })();
    return true; // keep the port open for the async sendResponse
  });

  console.info("[friday.content] loaded on", location.href);
})();
