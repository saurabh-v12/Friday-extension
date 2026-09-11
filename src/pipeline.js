// Privacy pipeline (Task 2.5).
//
// Chains capture → detect (DOM already in the capture, plus BlazeFace faces
// and Tesseract OCR PII in parallel) → redact → receipt. Any surface can
// call `runPrivacyPipeline()` and get back a single receipt object suitable
// for both rendering and (later, Phase 4) attaching to an outbound request.

import { MESSAGE_TYPES, sendToBackground } from "./messaging.js";
import { detectFacesFromDataUrl } from "./faces.js";
import { runOcrOnDataUrl } from "./ocr.js";
import { redactImage, collectRegions, REDACT_MODES } from "./redact.js";

// Human labels for receipt rendering. Keys must match src/pii.js PII_KIND.
export const KIND_LABEL = Object.freeze({
  password: "Passwords",
  email: "Emails",
  name: "Names",
  phone: "Phone numbers",
  cc: "Card numbers",
  aadhaar: "Aadhaar numbers",
  pan: "PAN numbers",
  ssn: "SSNs",
  otp: "One-time codes",
  dob: "Dates of birth",
  face: "Faces",
  unknown: "Other",
});

export async function runPrivacyPipeline({ mode = REDACT_MODES.DELETE, onPhase } = {}) {
  const t0 = performance.now();

  onPhase && onPhase("capturing");
  const capture = await sendToBackground(MESSAGE_TYPES.CAPTURE_TAB);

  // Decode the screenshot once — we need its true pixel dimensions to scale
  // DOM bboxes and we'll re-use the decoded image for redactImage().
  const img = new Image();
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = () => rej(new Error("screenshot decode failed"));
    img.src = capture.screenshot;
  });

  onPhase && onPhase("detecting");
  // OCR is best-effort — a worker/init failure must not sink the whole
  // scan. If it fails we log once, degrade gracefully to an empty result,
  // and still deliver DOM PII + face detection + the receipt.
  const emptyOcr = { text: "", words: [], textPii: [], ocrMs: 0, failed: true };
  const [faces, ocr] = await Promise.all([
    detectFacesFromDataUrl(capture.screenshot).catch((err) => {
      console.warn("[friday.pipeline] face detection failed, continuing:", err);
      return [];
    }),
    runOcrOnDataUrl(capture.screenshot).catch((err) => {
      console.warn("[friday.pipeline] OCR failed, continuing without it:", err);
      return { ...emptyOcr, error: err && err.message ? err.message : String(err) };
    }),
  ]);

  const regions = collectRegions({
    dom: capture.pii,
    faces,
    ocr,
    viewport: capture.viewport,
    imageWidth: img.naturalWidth,
    imageHeight: img.naturalHeight,
  });

  onPhase && onPhase("redacting");
  const redaction = await redactImage({ imageSource: img, regions, mode });

  const counts = summarize(regions, { dom: capture.pii, faces, ocr });
  return {
    capture,
    faces,
    ocr,
    regions,
    redaction,
    counts,
    totalMs: performance.now() - t0,
  };
}

// Assemble the exact payload a Phase-4 cloud call would send. Redacted
// screenshot + "safe DOM": each element's `value` is stripped or replaced
// with a `{masked:true, kind}` shape descriptor for any element that was
// flagged as PII. Nothing raw ever crosses the wire — the privacy boundary
// is right here, before we hand anything to the Brain Router.
//
// `receipt` is the output of `runPrivacyPipeline()`.
//
// Options:
//   `keepUrl` (default false) — if false, `page.url` is reduced to
//     `{host, path}` without query string/hash (which frequently carry
//     session tokens, tracking IDs, etc.). Set true only if the caller
//     really needs the full URL for the task.
export function buildSanitizedPayload(receipt, { keepUrl = false } = {}) {
  if (!receipt) throw new Error("buildSanitizedPayload: receipt is required");
  const { capture, redaction, counts, regions, totalMs } = receipt;

  // Elements marked as PII in capture.pii get their `value` stripped and
  // replaced with a `{masked:true, kind}` shape descriptor.
  const domHitByFid = new Map();
  for (const h of ((capture.pii && capture.pii.hits) || [])) {
    const primary = h.kinds && h.kinds[0] ? h.kinds[0].kind : "unknown";
    domHitByFid.set(h.fid, primary);
  }
  const safeElements = (capture.elements || []).map((el) => {
    const kind = domHitByFid.get(el.fid);
    if (!kind) return el;
    // Already a mask descriptor from content.js (password/sensitive
    // autocomplete) — keep it, just annotate the kind.
    if (el.value && typeof el.value === "object" && el.value.masked) {
      return { ...el, value: { ...el.value, kind } };
    }
    // Regular value that our detector flagged — replace it.
    if (el.value !== undefined) {
      const length = typeof el.value === "string" ? el.value.length : undefined;
      return { ...el, value: { masked: true, kind, length } };
    }
    return { ...el, piiKind: kind };
  });

  const url = capture.page && capture.page.url ? new URL(capture.page.url) : null;
  const safePage = keepUrl
    ? capture.page
    : {
        host: url ? url.host : "",
        path: url ? url.pathname : "",
        title: capture.page ? capture.page.title : "",
        readyState: capture.page ? capture.page.readyState : "",
      };

  return {
    image: {
      dataUrl: redaction ? redaction.dataUrl : capture.screenshot,
      width: redaction ? redaction.width : null,
      height: redaction ? redaction.height : null,
      redacted: !!redaction,
    },
    page: safePage,
    viewport: capture.viewport,
    elements: safeElements,
    elementCount: safeElements.length,
    receipt: {
      total: counts.total,
      perKind: counts.perKind,
      perSource: counts.perSource,
      regionsApplied: redaction ? redaction.regionsApplied : 0,
    },
    meta: {
      capturedAt: capture.capturedAt,
      totalMs,
      redactMs: redaction ? redaction.redactMs : null,
      regionCount: (regions || []).length,
    },
  };
}

function summarize(regions, sources) {
  const perKind = {};
  const perSource = { dom: 0, ocr: 0, blazeface: 0 };
  for (const r of regions) {
    perKind[r.kind] = (perKind[r.kind] || 0) + 1;
    perSource[r.source] = (perSource[r.source] || 0) + 1;
  }
  return {
    total: regions.length,
    perKind,
    perSource,
    domHits: (sources.dom && sources.dom.total) || 0,
    faceCount: (sources.faces || []).length,
    ocrHits: ((sources.ocr && sources.ocr.textPii) || []).filter((h) => h.bbox).length,
  };
}
