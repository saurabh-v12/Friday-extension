// Canvas-based redaction engine (Task 2.4).
//
// Takes a screenshot (data URL / Image / Canvas) plus the union of PII
// regions from DOM detection (pii.js) + BlazeFace faces (faces.js) + OCR
// text-PII (ocr.js), and paints over each region with either a solid mask,
// gaussian blur, or mosaic. Everything happens locally in an offscreen
// canvas — no bytes leave the page.
//
// Coordinate spaces:
//   • DOM bboxes are CSS-pixel viewport-relative. The screenshot from
//     chrome.tabs.captureVisibleTab is in *device* pixels, so DOM bboxes
//     get scaled by (screenshotWidth / viewport.width). We compute the
//     factor once per collectRegions() call.
//   • Face + OCR bboxes are already in image pixels (they were computed
//     from the image itself), so they're passed through as-is.

export const REDACT_MODES = Object.freeze({
  DELETE: "delete",
  MASK: "mask",
  BLUR: "blur",
  MOSAIC: "mosaic",
});

// Normalize hits from every detector into `[{bbox, kind, source}]` in image
// pixels, ready to feed into redactImage(). Regions get a small pad so the
// mask covers ~4px around the actual glyph/box.
export function collectRegions({ dom, faces, ocr, viewport, imageWidth, imageHeight, pad = 4 } = {}) {
  const out = [];
  const sx = viewport && viewport.width ? imageWidth / viewport.width : 1;
  const sy = viewport && viewport.height ? imageHeight / viewport.height : 1;

  // DOM: scale from CSS px → image px.
  for (const h of (dom && dom.hits) || []) {
    if (!h.bbox) continue;
    if (!shouldUseDomRegion(h, viewport)) continue;
    const scaled = {
      x: h.bbox.x * sx,
      y: h.bbox.y * sy,
      w: h.bbox.w * sx,
      h: h.bbox.h * sy,
    };
    out.push({ bbox: expand(scaled, pad), kind: firstKind(h.kinds), source: "dom" });
  }
  // OCR: already image px.
  for (const h of (ocr && ocr.textPii) || []) {
    if (!h.bbox) continue;
    out.push({ bbox: expand(h.bbox, pad), kind: h.kind, source: "ocr" });
  }
  // Faces: already image px. Pad more because BlazeFace's tight box crops
  // ears/hair and we want the whole head covered.
  for (const f of faces || []) {
    if (!f.box) continue;
    out.push({ bbox: expand(f.box, pad + 12), kind: "face", source: "blazeface" });
  }
  return out;
}

function shouldUseDomRegion(hit, viewport) {
  const tag = String(hit.tag || "").toLowerCase();
  const type = String(hit.type || "").toLowerCase();
  const b = hit.bbox || {};
  const vw = viewport && viewport.width ? viewport.width : 0;
  const vh = viewport && viewport.height ? viewport.height : 0;
  const area = Math.max(0, Number(b.w) || 0) * Math.max(0, Number(b.h) || 0);
  const viewportArea = vw * vh;

  // DOM labels in rich apps can map to a whole viewer/card/panel. That is
  // useful as a PII signal, but too coarse for destructive pixel deletion.
  // Keep DOM deletion for tight form fields; visual PII is handled by OCR
  // word/phrase boxes and face boxes.
  if (!["input", "textarea", "select"].includes(tag)) return false;
  if (["button", "submit", "reset", "image", "hidden"].includes(type)) return false;
  if (viewportArea && area / viewportArea > 0.08) return false;
  if (vw && b.w > vw * 0.9) return false;
  if (vh && b.h > vh * 0.25) return false;
  return true;
}

function firstKind(kinds) {
  if (!kinds || !kinds.length) return "unknown";
  return kinds[0].kind || kinds[0];
}

function expand(b, px) {
  return {
    x: Math.max(0, Math.floor(b.x - px)),
    y: Math.max(0, Math.floor(b.y - px)),
    w: Math.ceil(b.w + px * 2),
    h: Math.ceil(b.h + px * 2),
  };
}

// Loads an image source into a decoded HTMLImageElement.
function loadImage(source) {
  if (source instanceof HTMLImageElement) {
    if (source.complete && source.naturalWidth > 0) return Promise.resolve(source);
    return new Promise((res, rej) => {
      source.addEventListener("load", () => res(source), { once: true });
      source.addEventListener("error", () => rej(new Error("image load failed")), { once: true });
    });
  }
  if (source instanceof HTMLCanvasElement || (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap)) {
    return Promise.resolve(source);
  }
  if (typeof source === "string") {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error("image load failed"));
      img.src = source;
    });
  }
  throw new Error(`redact: unsupported image source (${typeof source})`);
}

function drawableSize(d) {
  return {
    w: d.naturalWidth || d.width || 0,
    h: d.naturalHeight || d.height || 0,
  };
}

// Main entry.
//
//   redactImage({ imageSource, regions, mode, blurPx })
//     → { dataUrl, width, height, regionsApplied, redactMs }
//
// `regions` is the normalized list from collectRegions(); bboxes are
// interpreted in image pixel space.
export async function redactImage({
  imageSource,
  regions,
  mode = REDACT_MODES.DELETE,
  blurPx = 18,
  format = "image/png",
} = {}) {
  const t0 = performance.now();
  const drawable = await loadImage(imageSource);
  const { w, h } = drawableSize(drawable);
  if (!w || !h) throw new Error("redact: image has zero dimensions");

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(drawable, 0, 0);

  let applied = 0;
  for (const r of regions || []) {
    const b = r.bbox;
    if (!b) continue;
    const x = clamp(b.x, 0, w);
    const y = clamp(b.y, 0, h);
    const rw = clamp(b.w, 0, w - x);
    const rh = clamp(b.h, 0, h - y);
    if (rw <= 0 || rh <= 0) continue;
    applyMask(ctx, canvas, mode, blurPx, x, y, rw, rh);
    applied++;
  }

  const dataUrl = canvas.toDataURL(format);
  return {
    dataUrl,
    width: w,
    height: h,
    regionsApplied: applied,
    regionsGiven: (regions || []).length,
    redactMs: performance.now() - t0,
  };
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function applyMask(ctx, canvas, mode, blurPx, x, y, w, h) {
  if (mode === REDACT_MODES.DELETE) {
    // Clear the actual RGBA pixels so the output image no longer contains
    // the detected content. This is destructive, unlike blur or mosaic.
    ctx.clearRect(x, y, w, h);
    return;
  }
  if (mode === REDACT_MODES.MASK) {
    ctx.fillStyle = "#000";
    ctx.fillRect(x, y, w, h);
    return;
  }
  if (mode === REDACT_MODES.MOSAIC) {
    const step = Math.max(6, Math.min(w, h) / 6);
    const tmp = document.createElement("canvas");
    tmp.width = Math.max(1, Math.floor(w / step));
    tmp.height = Math.max(1, Math.floor(h / step));
    const tctx = tmp.getContext("2d");
    tctx.imageSmoothingEnabled = true;
    tctx.drawImage(canvas, x, y, w, h, 0, 0, tmp.width, tmp.height);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, x, y, w, h);
    ctx.restore();
    return;
  }
  // BLUR: clip to the region, then re-draw the source with a blur filter.
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.filter = `blur(${blurPx}px)`;
  ctx.drawImage(canvas, 0, 0);
  ctx.filter = "none";
  ctx.restore();
}
