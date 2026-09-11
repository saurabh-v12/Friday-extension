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
    EXECUTE: "EXECUTE",
    RESOLVE: "RESOLVE",
    SNAPSHOT_COMPACT: "SNAPSHOT_COMPACT",
    EXEC_TOOL: "EXEC_TOOL",
  };

  // Map fid → live element, rebuilt on every collectSnapshot() call. Used by
  // EXECUTE so click/type/scroll targets the SAME element the snapshot
  // surfaced — no stale coordinates, no pixel guessing.
  let currentFidMap = new Map();
  let lastSnapshotAt = 0;

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
    if (tag === "input" || tag === "textarea") {
      const ac = el.getAttribute("autocomplete");
      if (ac) out.autocomplete = ac.toLowerCase();
    }
    const value = safeValueDescriptor(el);
    if (value !== undefined) out.value = value;
    if (el.hasAttribute("disabled")) out.disabled = true;
    return out;
  }

  function collectSnapshot(opts) {
    const includeInvisible = !!(opts && opts.includeInvisible);
    const all = document.querySelectorAll(CAPTURE_SELECTOR);
    const elements = [];
    const nextMap = new Map();
    for (let i = 0; i < all.length; i++) {
      const snap = snapshotElement(all[i], i);
      if (!includeInvisible && !snap.visible) continue;
      elements.push(snap);
      nextMap.set(snap.fid, all[i]);
    }
    currentFidMap = nextMap;
    lastSnapshotAt = Date.now();
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
      capturedAt: lastSnapshotAt,
    };
  }

  // ─── Executor + resolver (Tasks 3.1 + 3.2) ────────────────────────

  function assertReady(fid) {
    if (currentFidMap.size === 0) {
      throw new Error("no snapshot yet — call SNAPSHOT/CAPTURE_TAB before EXECUTE");
    }
    const el = currentFidMap.get(fid);
    if (!el) throw new Error(`fid not found: ${fid}`);
    if (!el.isConnected) throw new Error(`element ${fid} was detached — re-snapshot the page`);
    return el;
  }

  function isDisabled(el) {
    if (el.disabled) return true;
    if (el.getAttribute("aria-disabled") === "true") return true;
    return false;
  }

  function scrollElementIntoView(el, opts = {}) {
    try {
      el.scrollIntoView({ behavior: opts.smooth ? "smooth" : "auto", block: "center", inline: "center" });
    } catch { el.scrollIntoView(); }
  }

  function fireInputEvents(el) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setInputValue(el, text) {
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") {
      // React and other libs listen for the native setter — invoke it via
      // the prototype so their internal state updates too.
      const proto = tag === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value");
      if (setter && setter.set) setter.set.call(el, text);
      else el.value = text;
      fireInputEvents(el);
      return;
    }
    if (el.isContentEditable) {
      el.focus();
      // Select all then insert — the standard "replace" flow.
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand("insertText", false, text);
      return;
    }
    throw new Error("target is not a text field or contenteditable");
  }

  function typeIntoInput(el, text, opts = {}) {
    if (isDisabled(el)) throw new Error("target is disabled");
    scrollElementIntoView(el, opts);
    el.focus();
    if (opts.append) {
      const current = "value" in el ? (el.value || "") : (el.textContent || "");
      setInputValue(el, current + text);
    } else {
      setInputValue(el, text);
    }
  }

  function clickElement(el) {
    if (isDisabled(el)) throw new Error("target is disabled");
    scrollElementIntoView(el);
    // el.click() dispatches a synthetic MouseEvent — this fires bubbling
    // click listeners AND triggers <label for> → input activation, which
    // hand-rolled MouseEvent dispatches sometimes miss.
    el.click();
  }

  function isInViewport(el) {
    const rect = el.getBoundingClientRect();
    if (!isVisible(el, rect)) return false;
    const vw = window.innerWidth, vh = window.innerHeight;
    return rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;
  }

  function getVideoCandidates() {
    const anchors = Array.from(document.querySelectorAll('a[href*="/watch"]'))
      .filter((a) => {
        try {
          const u = new URL(a.href, location.href);
          return u.pathname === "/watch" && !!u.searchParams.get("v") && isInViewport(a);
        } catch {
          return false;
        }
      });
    const seen = new Set();
    const out = [];
    for (const a of anchors) {
      const href = a.href.split("&list=")[0];
      if (seen.has(href)) continue;
      const card = a.closest("ytd-rich-item-renderer,ytd-video-renderer,ytd-grid-video-renderer,ytd-compact-video-renderer") || a;
      const titleEl = card.querySelector("#video-title, #video-title-link, h3 a, a[title]") || a;
      const title = (titleEl.getAttribute("title") || titleEl.textContent || a.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ");
      const rect = (card.getBoundingClientRect && card.getBoundingClientRect()) || a.getBoundingClientRect();
      if (!rect || rect.width < 80 || rect.height < 40) continue;
      seen.add(href);
      out.push({ anchor: a, title, rect });
    }
    out.sort((a, b) => {
      const dy = a.rect.top - b.rect.top;
      if (Math.abs(dy) > 24) return dy;
      return a.rect.left - b.rect.left;
    });
    return out;
  }

  // Very small resolver: finds a snapshot element whose accessible name
  // (or role+name combo, or href) matches an intent string. Intended for
  // quick text-to-fid mapping; the Phase-4 LLM will do the heavier lifting.
  function resolveIntent(intent, options = {}) {
    if (!intent || typeof intent !== "string") throw new Error("intent required");
    const q = intent.trim().toLowerCase();
    const wantsRole = options.role ? options.role.toLowerCase() : null;

    const candidates = [];
    for (const [fid, el] of currentFidMap.entries()) {
      const name = accessibleName(el).toLowerCase();
      const role = (computedRole(el) || "").toLowerCase();
      if (wantsRole && role !== wantsRole) continue;
      if (!name) continue;
      let score = 0;
      if (name === q) score = 100;
      else if (name.includes(q)) score = 60 - Math.abs(name.length - q.length);
      else if (q.includes(name) && name.length > 2) score = 40;
      // Bonus for interactive roles when the intent looks like an action.
      if (["button", "link", "textbox"].includes(role)) score += 5;
      if (score > 0) candidates.push({ fid, score, role, name });
    }
    candidates.sort((a, b) => b.score - a.score);
    return { matches: candidates.slice(0, 5), best: candidates[0] || null };
  }

  // ─── Compact snapshot for chat / tool-calling (Task: SEEING) ──────
  //
  // Different shape from collectSnapshot() above:
  //   • No bboxes, no image — this is JSON to hand an LLM.
  //   • Each interactive element gets a `selector` you can pass right
  //     back to click()/type() via EXEC_TOOL. If the element has a
  //     unique real id we use it; otherwise we stamp a `data-friday-id`
  //     during snapshot so a later selector query stays anchored to the
  //     exact node the LLM saw.
  //   • Visibility: offsetParent !== null (skips display:none / detached
  //     subtrees) + non-zero size. Cheap and matches what a user sees.
  //   • Elements capped at maxElements to keep tokens low; text fields
  //     truncated so we don't paste a novel into the LLM's context.

  const COMPACT_SELECTOR = [
    "button",
    "a[href]",
    "input:not([type=hidden])",
    "textarea",
    "select",
    "h1,h2,h3,h4,h5,h6",
    "[role=button]",
    "[role=link]",
    "[role=heading]",
    "[role=textbox]",
    "[contenteditable='']",
    "[contenteditable=true]",
  ].join(",");

  function isCompactVisible(el) {
    // offsetParent is null when: parent has display:none, position:fixed
    // rules aside, and detached subtrees. Cheap enough to run 200×.
    if (el.offsetParent === null && getComputedStyle(el).position !== "fixed") return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || parseFloat(style.opacity || "1") === 0) return false;
    return true;
  }

  function stableSelector(el, counter) {
    // Prefer a real id when it's unique on the page — a lot of pages use
    // ids that survive re-renders, which is exactly what a tool-call
    // target needs. Fall back to a stamped data-friday-id otherwise.
    if (el.id) {
      try {
        if (document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) {
          return `#${CSS.escape(el.id)}`;
        }
      } catch { /* CSS.escape can throw on some weird ids — fall through */ }
    }
    let fid = el.getAttribute("data-friday-id");
    if (!fid) {
      fid = `fri-${counter.n++}`;
      el.setAttribute("data-friday-id", fid);
    }
    return `[data-friday-id="${fid}"]`;
  }

  function safeCompactText(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") {
      // Never leak password/OTP/cc-* values into the LLM prompt.
      const type = (el.getAttribute("type") || "text").toLowerCase();
      const auto = (el.getAttribute("autocomplete") || "").toLowerCase();
      if (type === "password" || /(current-password|new-password|cc-number|cc-csc|one-time-code)/.test(auto)) {
        return el.value ? "(hidden)" : "";
      }
      const v = (el.value || "").trim();
      return v.length > 80 ? v.slice(0, 80) + "…" : v;
    }
    const txt = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
    return txt.length > 80 ? txt.slice(0, 80) + "…" : txt;
  }

  function collectCompactSnapshot({ maxElements = 150, maxText = 3000 } = {}) {
    // Clear old data-friday-id stamps so a re-snapshot doesn't accumulate.
    // Cheap: one attribute-selector sweep.
    for (const stale of document.querySelectorAll("[data-friday-id]")) {
      stale.removeAttribute("data-friday-id");
    }

    const counter = { n: 0 };
    const nodes = document.querySelectorAll(COMPACT_SELECTOR);
    const elements = [];
    for (const el of nodes) {
      if (elements.length >= maxElements) break;
      if (!isCompactVisible(el)) continue;
      const tag = el.tagName.toLowerCase();
      const role = computedRole(el) || tag;
      const name = accessibleName(el);
      const text = safeCompactText(el);
      const selector = stableSelector(el, counter);
      const out = { id: selector, tag, role, name, text, selector };
      const type = tag === "input" ? (el.getAttribute("type") || "text").toLowerCase() : null;
      if (type) out.type = type;
      if (tag === "a" && el.hasAttribute("href")) out.href = el.getAttribute("href");
      const ph = el.getAttribute && el.getAttribute("placeholder");
      if (ph) out.placeholder = ph;
      elements.push(out);
    }

    // document.body.innerText already respects display:none and skips
    // <script>/<style> content — exactly what we want. Cheaper + more
    // accurate than a manual TreeWalker.
    const visibleText = ((document.body && document.body.innerText) || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxText);

    return {
      url: location.href,
      title: document.title,
      visibleText,
      elements,
      elementCount: elements.length,
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
    [MSG.EXECUTE](payload) {
      const { action, fid, text, options } = payload || {};
      if (!action) throw new Error("EXECUTE requires action");
      const el = assertReady(fid);
      const t0 = performance.now();
      switch (action) {
        case "click": {
          clickElement(el);
          return { ok: true, action, fid, tag: el.tagName.toLowerCase(), ms: performance.now() - t0 };
        }
        case "type": {
          if (typeof text !== "string") throw new Error("type action requires text");
          typeIntoInput(el, text, options || {});
          return { ok: true, action, fid, tag: el.tagName.toLowerCase(), chars: text.length, ms: performance.now() - t0 };
        }
        case "focus": {
          scrollElementIntoView(el);
          el.focus();
          return { ok: true, action, fid, ms: performance.now() - t0 };
        }
        case "scroll": {
          scrollElementIntoView(el, options || {});
          return { ok: true, action, fid, ms: performance.now() - t0 };
        }
        default:
          throw new Error(`unknown EXECUTE action: ${action}`);
      }
    },
    [MSG.RESOLVE](payload) {
      const { intent, role } = payload || {};
      return resolveIntent(intent, { role });
    },
    [MSG.SNAPSHOT_COMPACT](payload) {
      return collectCompactSnapshot(payload || {});
    },
    [MSG.EXEC_TOOL](payload) {
      const { tool, args } = payload || {};
      return execTool(tool, args || {});
    },
  };

  // ─── Tool executor for chat/agent tool-calling ──────────────────────
  //
  // Each tool returns a plain-object result that gets JSON-stringified
  // and fed back to the LLM as a role:"tool" message. Errors surface via
  // {ok:false, error} — never throw across the message boundary, so the
  // model can recover (pick a different target, retry, etc.).
  function execTool(tool, args) {
    try {
      switch (tool) {
        case "click": {
          const el = document.querySelector(String(args.target || ""));
          if (!el) return { ok: false, error: `element not found: ${args.target}` };
          if (isDisabled(el)) return { ok: false, error: `element is disabled: ${args.target}` };
          scrollElementIntoView(el);
          el.click();
          return { ok: true, message: `clicked ${describeEl(el)}` };
        }
        case "type": {
          const el = document.querySelector(String(args.target || ""));
          if (!el) return { ok: false, error: `element not found: ${args.target}` };
          if (typeof args.text !== "string") return { ok: false, error: "type requires text" };
          typeIntoInput(el, args.text, {});
          return { ok: true, message: `typed ${JSON.stringify(args.text.slice(0, 60))} into ${describeEl(el)}` };
        }
        case "scroll": {
          const dir = String(args.direction || "down").toLowerCase();
          const amount = Number.isFinite(args.amount) ? args.amount : Math.round(window.innerHeight * 0.8);
          if (dir === "top") window.scrollTo({ top: 0, behavior: "smooth" });
          else if (dir === "bottom") window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
          else if (dir === "up") window.scrollBy({ top: -amount, behavior: "smooth" });
          else window.scrollBy({ top: amount, behavior: "smooth" });
          return { ok: true, message: `scrolled ${dir}${dir === "up" || dir === "down" ? ` by ${amount}px` : ""}` };
        }
        case "readText": {
          const maxChars = Math.max(500, Math.min(10000, Number(args.maxChars) || 5000));
          if (!args.target) {
            const text = ((document.body && document.body.innerText) || "").slice(0, maxChars);
            return { ok: true, text };
          }
          const el = document.querySelector(String(args.target));
          if (!el) return { ok: false, error: `element not found: ${args.target}` };
          const raw = (el.innerText || el.value || el.textContent || "").trim();
          return { ok: true, text: raw.slice(0, maxChars) };
        }
        case "clickNthVideo": {
          const index = Math.max(1, Math.floor(Number(args.index) || 1));
          const videos = getVideoCandidates();
          const item = videos[index - 1];
          if (!item) return { ok: false, error: `found ${videos.length} visible video(s), cannot click #${index}` };
          item.anchor.click();
          return { ok: true, index, title: item.title || "", count: videos.length, message: `clicked video #${index}` };
        }
        case "getSnapshot": {
          return { ok: true, snapshot: collectCompactSnapshot() };
        }
        default:
          return { ok: false, error: `unknown tool: ${tool}` };
      }
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  }

  function describeEl(el) {
    const tag = el.tagName.toLowerCase();
    const name = accessibleName(el);
    if (name) return `<${tag}> "${name.slice(0, 40)}"`;
    if (el.id) return `<${tag}#${el.id}>`;
    return `<${tag}>`;
  }

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
