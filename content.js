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
    SNAPSHOT: "SNAPSHOT",
  };

  // ─── Snapshot helpers ─────────────────────────────────────────────

  // Implicit ARIA role for common tags — enough for buttons/inputs/links.
  // Not a full mapping (that's a large table); we fall back to tag name.
  function implicitRole(el) {
    const t = el.tagName.toLowerCase();
    if (t === "a" && el.hasAttribute("href")) return "link";
    if (t === "button") return "button";
    if (t === "select") return "combobox";
    if (t === "textarea") return "textbox";
    if (t === "img") return el.getAttribute("alt") ? "img" : "presentation";
    if (t === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (["submit", "button", "reset"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "search") return "searchbox";
      // password/email/tel/text/number/url/etc.
      return "textbox";
    }
    if (/^h[1-6]$/.test(t)) return "heading";
    if (t === "label") return "label";
    return null;
  }

  function computedRole(el) {
    return el.getAttribute("role") || implicitRole(el);
  }

  // Simplified accessible-name computation (ARIA-ish, not spec-complete).
  function accessibleName(el) {
    // 1) aria-labelledby → concat text of referenced ids
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const parts = [];
      for (const id of labelledBy.split(/\s+/)) {
        const ref = document.getElementById(id);
        if (ref) parts.push((ref.textContent || "").trim());
      }
      const joined = parts.filter(Boolean).join(" ").trim();
      if (joined) return joined;
    }
    // 2) aria-label
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    // 3) input with associated <label>
    const t = el.tagName.toLowerCase();
    if (t === "input" || t === "textarea" || t === "select") {
      const id = el.id;
      if (id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (lbl) return (lbl.textContent || "").trim();
      }
      const wrap = el.closest("label");
      if (wrap) return (wrap.textContent || "").trim();
      const ph = el.getAttribute("placeholder");
      if (ph) return ph.trim();
    }
    // 4) button / anchor: text content
    if (t === "button" || t === "a") {
      const txt = (el.textContent || "").trim();
      if (txt) return txt.slice(0, 200);
    }
    // 5) img alt
    if (t === "img") {
      const alt = el.getAttribute("alt");
      if (alt) return alt.trim();
    }
    // 6) input value for submit/button/reset
    if (t === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (["submit", "button", "reset"].includes(type)) {
        return (el.value || "").trim();
      }
    }
    // 7) title as last resort
    const title = el.getAttribute("title");
    if (title) return title.trim();
    return "";
  }

  function isVisible(el, rect) {
    if (!rect || rect.width < 1 || rect.height < 1) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (parseFloat(style.opacity || "1") === 0) return false;
    const vw = window.innerWidth, vh = window.innerHeight;
    if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) return false;
    return true;
  }

  // Elements worth reporting. Interactive first-class; then structural
  // things a router or agent might reference (headings, labels, images
  // with alt). Everything else is noise.
  const CAPTURE_SELECTOR = [
    "a[href]",
    "button",
    "input",
    "textarea",
    "select",
    "label",
    "img[alt]",
    "h1,h2,h3,h4,h5,h6",
    "[role]",
    "[tabindex]",
    "[contenteditable=''],[contenteditable='true']",
  ].join(",");

  // Hard-line privacy — never emit the actual value of a password field or
  // any input the page has marked as sensitive via autocomplete. Return a
  // masked shape descriptor instead.
  function safeValueDescriptor(el) {
    const t = el.tagName.toLowerCase();
    if (t !== "input" && t !== "textarea") return undefined;
    const type = (el.getAttribute("type") || "text").toLowerCase();
    const auto = (el.getAttribute("autocomplete") || "").toLowerCase();
    const sensitiveAuto = /(current-password|new-password|cc-number|cc-csc|one-time-code)/;
    if (type === "password" || sensitiveAuto.test(auto)) {
      return { masked: true, length: (el.value || "").length };
    }
    const v = el.value || "";
    // Cap value length to avoid ballooning payloads.
    return v.length > 200 ? { truncated: true, length: v.length, sample: v.slice(0, 200) }
                          : v;
  }

  function snapshotElement(el, i) {
    const rect = el.getBoundingClientRect();
    const visible = isVisible(el, rect);
    const role = computedRole(el);
    const name = accessibleName(el);
    const tag = el.tagName.toLowerCase();
    const type = tag === "input" ? (el.getAttribute("type") || "text").toLowerCase() : undefined;

    // Keep the shape lean — only include fields that add signal.
    const out = {
      fid: `f-${i}`,
      tag,
      role,
      name,
      bbox: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
      visible,
    };
    if (type) out.type = type;
    if (el.id) out.id = el.id;
    if (tag === "a" && el.hasAttribute("href")) out.href = el.getAttribute("href");
    const value = safeValueDescriptor(el);
    if (value !== undefined) out.value = value;
    if (el.hasAttribute("disabled")) out.disabled = true;
    return out;
  }

  function collectSnapshot(opts) {
    const includeInvisible = !!(opts && opts.includeInvisible);
    const all = document.querySelectorAll(CAPTURE_SELECTOR);
    const elements = [];
    for (let i = 0; i < all.length; i++) {
      const snap = snapshotElement(all[i], i);
      if (!includeInvisible && !snap.visible) continue;
      elements.push(snap);
    }
    return {
      page: { url: location.href, title: document.title, readyState: document.readyState },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY),
      },
      elements,
      elementCount: elements.length,
      totalScanned: all.length,
      capturedAt: Date.now(),
    };
  }

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
    [MSG.SNAPSHOT](payload) {
      return collectSnapshot(payload);
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
