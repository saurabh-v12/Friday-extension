// OCR + text-PII scan with Tesseract.js (Task 2.3).
//
// Runs Tesseract.js in a worker on top of a screenshot dataURL. Reuses the
// regex patterns from src/pii.js — same shape/redaction rules the DOM
// detector uses, applied per OCR word (fast, low false-positive on invoice
// numbers etc. because we check whole-word tokens rather than substrings).
//
// Lazy-loaded like faces.js: the ~4 MB Tesseract worker + WASM only loads
// on first call. Language data ("eng.traineddata", ~10 MB) fetches from
// tessdata CDN on first use and browser Cache Storage caches it.

import { PATTERNS, PII_KIND } from "./pii.js";

// Prefer chrome.runtime.getURL() in the extension — it's the idiomatic MV3
// way to build extension URLs and avoids any relative-path ambiguity.
// Fallback to import.meta.url for the popup dev harness or any non-extension
// test surface that may load this module.
const extUrl = (rel) => {
  const hasRuntime = typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL;
  return hasRuntime ? chrome.runtime.getURL(rel) : new URL("../" + rel, import.meta.url).href;
};
const scriptUrl = (rel) => new URL(rel, import.meta.url).href;

let _workerPromise = null;

function injectScript(url) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-friday-vendor="${url}"]`)) {
      resolve();
      return;
    }
    const s = document.createElement("script");
    s.src = url;
    s.async = false;
    s.dataset.fridayVendor = url;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load vendor script: ${url}`));
    document.head.appendChild(s);
  });
}

export async function loadTesseract({ onProgress } = {}) {
  if (typeof window === "undefined") throw new Error("ocr.js requires a page context");
  if (window.__fridayTesseractWorker) return window.__fridayTesseractWorker;
  if (_workerPromise) return _workerPromise;

  _workerPromise = (async () => {
    const t0 = performance.now();
    onProgress && onProgress({ phase: "runtime", status: "loading" });
    if (!window.Tesseract) {
      await injectScript(extUrl("dist/vendor/tesseract/tesseract.min.js"));
    }

    onProgress && onProgress({ phase: "worker", status: "loading" });
    // createWorker(lang, oem, opts). oem=1 → LSTM only (faster & smaller
    // than legacy+LSTM). Paths point at bundled files via
    // chrome.runtime.getURL — safer than relative resolution and matches
    // the URL scheme the runtime expects.
    //
    // **workerBlobURL: false** is the fix for the actual bug: Tesseract's
    // default wraps the worker in a blob: URL and does
    //   importScripts("chrome-extension://.../worker.min.js")
    // inside that blob. Under MV3, blob-URL workers created from an
    // extension page have origin "null" and can't importScripts a
    // chrome-extension:// URL — that's the "failed to execute
    // 'importScripts' on 'WorkerGlobalScope'" NetworkError. Setting this
    // to false makes Tesseract call `new Worker(workerPath)` directly,
    // which is same-origin and works.
    //
    // gzip: true matches how tessdata CDN serves eng.traineddata (as .gz).
    const worker = await window.Tesseract.createWorker("eng", 1, {
      workerPath: extUrl("dist/vendor/tesseract/worker.min.js"),
      corePath: extUrl("dist/vendor/tesseract/core/"),
      langPath: "https://tessdata.projectnaptha.com/4.0.0",
      workerBlobURL: false,
      gzip: true,
      logger: (m) => {
        if (onProgress && m && typeof m.progress === "number") {
          onProgress({ phase: m.status || "ocr", pct: m.progress * 100 });
        }
      },
    });
    const loadMs = performance.now() - t0;
    const state = { worker, loadMs };
    window.__fridayTesseractWorker = state;
    return state;
  })();

  try {
    return await _workerPromise;
  } catch (err) {
    _workerPromise = null;
    throw err;
  }
}

// Runs OCR on any image source Tesseract.recognize() accepts (data URL,
// blob, canvas, ImageData). Returns:
//   { text, words: [{text, confidence, bbox}], textPii: [{kind, evidence, bbox, text, source:"ocr"}], ocrMs }
export async function runOcr(imageSource, opts = {}) {
  const { worker } = await loadTesseract(opts);
  const t0 = performance.now();
  const { data } = await worker.recognize(imageSource);
  const ocrMs = performance.now() - t0;

  const words = (data.words || []).map((w) => ({
    text: w.text,
    confidence: w.confidence,
    bbox: {
      x: w.bbox.x0,
      y: w.bbox.y0,
      w: w.bbox.x1 - w.bbox.x0,
      h: w.bbox.y1 - w.bbox.y0,
    },
  }));

  const textPii = detectTextPii(words, data.text || "");
  return { text: data.text || "", words, textPii, ocrMs };
}

// Terminate the worker & free memory. Optional — Tesseract workers survive
// idle just fine; callers who care about cleanup can invoke this.
export async function terminateTesseract() {
  const state = window.__fridayTesseractWorker;
  if (!state) return;
  window.__fridayTesseractWorker = null;
  _workerPromise = null;
  try { await state.worker.terminate(); } catch (_) { /* ignore */ }
}

// ─── PII regex over OCR output ────────────────────────────────────────

const WORD_TESTS = [
  { rx: PATTERNS.email, kind: PII_KIND.EMAIL },
  { rx: PATTERNS.aadhaar, kind: PII_KIND.AADHAAR },
  { rx: PATTERNS.pan, kind: PII_KIND.PAN },
  { rx: PATTERNS.ssn, kind: PII_KIND.SSN },
  { rx: PATTERNS.cc, kind: PII_KIND.CC },
  { rx: PATTERNS.phoneIn, kind: PII_KIND.PHONE },
  { rx: PATTERNS.phoneUs, kind: PII_KIND.PHONE },
];

function redactShort(kind, val) {
  if (kind === PII_KIND.EMAIL) {
    const m = val.match(PATTERNS.email);
    if (!m) return "***@***";
    const [local, domain] = m[0].split("@");
    return `${local[0] || "*"}***@${domain}`;
  }
  if (kind === PII_KIND.AADHAAR) return "****-****-****";
  if (kind === PII_KIND.PAN) return "*****####*";
  if (kind === PII_KIND.SSN) return "***-**-****";
  if (kind === PII_KIND.CC) return "**** **** **** ####";
  if (kind === PII_KIND.PHONE) return "*** *** ****";
  return "***";
}

// Per-word scan first — catches most single-token PII (email, aadhaar 12-run,
// PAN, SSN). Then a full-text sweep for patterns that Tesseract may split
// across words (phone numbers with spaces).
function detectTextPiiLegacy(words, fullText) {
  const hits = [];
  for (const w of words) {
    if (!w.text || w.text.length < 4) continue;
    for (const { rx, kind } of WORD_TESTS) {
      const m = w.text.match(rx);
      if (m) {
        hits.push({
          kind,
          evidence: redactShort(kind, m[0]),
          bbox: w.bbox,
          text: w.text,
          source: "ocr",
          confidence: w.confidence,
        });
      }
    }
  }
  // Full-text sweep — no bbox, useful signal for the receipt even if we
  // can't blur it precisely. Only reports kinds not already found per-word.
  const kindsSeen = new Set(hits.map((h) => h.kind));
  const fullTests = WORD_TESTS.filter((t) => !kindsSeen.has(t.kind));
  for (const { rx, kind } of fullTests) {
    const m = fullText.match(rx);
    if (m) {
      hits.push({
        kind,
        evidence: redactShort(kind, m[0]),
        bbox: null,
        text: m[0].slice(0, 60),
        source: "ocr-fulltext",
      });
    }
  }
  return hits;
}

function detectTextPii(words, fullText) {
  const hits = [];
  const seen = new Set();
  const addHit = (hit) => {
    const b = hit.bbox;
    const key = `${hit.kind}:${hit.evidence}:${b ? `${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.w)},${Math.round(b.h)}` : "full"}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push(hit);
  };

  for (const w of words || []) {
    if (!w.text || w.text.length < 4) continue;
    for (const { rx, kind } of WORD_TESTS) {
      const m = w.text.match(rx);
      if (m) {
        addHit({
          kind,
          evidence: redactShort(kind, m[0]),
          bbox: w.bbox,
          text: w.text,
          source: "ocr",
          confidence: w.confidence,
        });
      }
    }
  }

  for (const hit of detectPhrasePii(words)) addHit(hit);

  const kindsSeen = new Set(hits.map((h) => h.kind));
  const fullTests = WORD_TESTS.filter((t) => !kindsSeen.has(t.kind));
  for (const { rx, kind } of fullTests) {
    const m = String(fullText || "").match(rx);
    if (m) {
      addHit({
        kind,
        evidence: redactShort(kind, m[0]),
        bbox: null,
        text: m[0].slice(0, 60),
        source: "ocr-fulltext",
      });
    }
  }
  return hits;
}

function detectPhrasePii(words) {
  const hits = [];
  const cleanWords = (words || [])
    .filter((w) => w && w.bbox && w.text && /[A-Za-z0-9]/.test(w.text))
    .sort((a, b) => {
      const dy = a.bbox.y - b.bbox.y;
      if (Math.abs(dy) > 16) return dy;
      return a.bbox.x - b.bbox.x;
    });

  for (let i = 0; i < cleanWords.length; i++) {
    for (let len = 2; len <= 5 && i + len <= cleanWords.length; len++) {
      const slice = cleanWords.slice(i, i + len);
      if (!sameTextLine(slice)) break;
      const joined = slice.map((w) => w.text).join(" ");
      const compact = slice.map((w) => w.text).join("");
      for (const { rx, kind } of WORD_TESTS) {
        const m = joined.match(rx) || compact.match(rx);
        if (!m) continue;
        hits.push({
          kind,
          evidence: redactShort(kind, m[0]),
          bbox: unionBbox(slice.map((w) => w.bbox)),
          text: joined.slice(0, 80),
          source: "ocr-phrase",
          confidence: Math.min(...slice.map((w) => Number(w.confidence) || 0)),
        });
      }
    }
  }
  return hits;
}

function sameTextLine(words) {
  if (!words.length) return false;
  const first = words[0].bbox;
  const baseY = first.y + first.h / 2;
  return words.every((w) => {
    const b = w.bbox;
    const y = b.y + b.h / 2;
    return Math.abs(y - baseY) <= Math.max(10, Math.max(first.h, b.h) * 0.75);
  });
}

function unionBbox(boxes) {
  const xs = boxes.map((b) => b.x);
  const ys = boxes.map((b) => b.y);
  const rs = boxes.map((b) => b.x + b.w);
  const bs = boxes.map((b) => b.y + b.h);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x,
    y,
    w: Math.max(...rs) - x,
    h: Math.max(...bs) - y,
  };
}

export async function runOcrOnDataUrl(dataUrl, opts) {
  return runOcr(dataUrl, opts);
}
