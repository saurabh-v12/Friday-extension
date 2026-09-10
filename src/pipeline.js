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

export async function runPrivacyPipeline({ mode = REDACT_MODES.BLUR, onPhase } = {}) {
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
  const [faces, ocr] = await Promise.all([
    detectFacesFromDataUrl(capture.screenshot),
    runOcrOnDataUrl(capture.screenshot),
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
