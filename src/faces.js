// Face detection with BlazeFace (Task 2.2).
//
// Loads TFJS + BlazeFace on demand (lazy) via <script> injection so the
// runtime cost only lands when the user actually invokes face detection.
// Everything comes from bundled files under dist/vendor/ — no CDN scripts,
// which MV3 wouldn't allow anyway. Model weights (blazeface_v1) fetch to
// browser Cache Storage on first use; subsequent calls read from cache.
//
// Backend: WebGL first (fast on any machine with a GPU), WASM fallback
// (still fine — BlazeFace on WASM is ~30-80 ms per frame). Kept out of the
// service worker on purpose: WebGL isn't available there.

let _loadPromise = null;

const scriptUrl = (rel) => new URL(rel, import.meta.url).href;

function injectScript(url) {
  return new Promise((resolve, reject) => {
    // De-dup: if this exact URL is already in the DOM we assume the exports
    // are on `window` and just resolve.
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

// Callers pass `onProgress({phase, status})` where phase ∈
//   'tfjs' | 'wasm-backend' | 'backend-init' | 'blazeface' | 'model'
export async function loadBlazeFace({ onProgress } = {}) {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("faces.js requires a page context (window/document)");
  }
  if (window.__fridayBlazeface && window.__fridayBlazeface.model) {
    return window.__fridayBlazeface;
  }
  if (_loadPromise) return _loadPromise;

  _loadPromise = (async () => {
    const t0 = performance.now();

    // 1) TFJS core (UMD → sets window.tf).
    if (!window.tf) {
      onProgress && onProgress({ phase: "tfjs", status: "loading" });
      await injectScript(scriptUrl("../dist/vendor/tfjs/tf.min.js"));
    }

    // 2) Pick a backend. Try WebGL first, fall back to WASM.
    onProgress && onProgress({ phase: "backend-init", status: "loading" });
    let backend = null;
    try {
      await window.tf.setBackend("webgl");
      await window.tf.ready();
      backend = "webgl";
    } catch (_webglErr) {
      onProgress && onProgress({ phase: "wasm-backend", status: "loading" });
      await injectScript(scriptUrl("../dist/vendor/tfjs/tf-backend-wasm.min.js"));
      if (window.tf.wasm && window.tf.wasm.setWasmPaths) {
        window.tf.wasm.setWasmPaths(scriptUrl("../dist/vendor/tfjs/"));
      }
      await window.tf.setBackend("wasm");
      await window.tf.ready();
      backend = "wasm";
    }

    // 3) BlazeFace UMD (sets window.blazeface).
    if (!window.blazeface) {
      onProgress && onProgress({ phase: "blazeface", status: "loading" });
      await injectScript(scriptUrl("../dist/vendor/blazeface/blazeface.min.js"));
    }

    // 4) Load the model weights (default hub URL — Cache Storage caches).
    onProgress && onProgress({ phase: "model", status: "loading" });
    const model = await window.blazeface.load();

    const loadMs = performance.now() - t0;
    const state = { model, backend, loadMs };
    window.__fridayBlazeface = state;
    return state;
  })();

  try {
    return await _loadPromise;
  } catch (err) {
    _loadPromise = null; // let the caller retry
    throw err;
  }
}

// `imageSource` may be HTMLImageElement, HTMLCanvasElement, ImageBitmap,
// HTMLVideoElement, or ImageData — anything BlazeFace's estimateFaces accepts.
// Returns an array of { box:{x,y,w,h}, prob, landmarks: [{x,y}, …] }.
export async function detectFaces(imageSource) {
  const { model } = await loadBlazeFace();
  const returnTensors = false;
  const preds = await model.estimateFaces(imageSource, returnTensors);
  return preds.map((p) => ({
    box: {
      x: Math.round(p.topLeft[0]),
      y: Math.round(p.topLeft[1]),
      w: Math.round(p.bottomRight[0] - p.topLeft[0]),
      h: Math.round(p.bottomRight[1] - p.topLeft[1]),
    },
    prob: Array.isArray(p.probability) ? p.probability[0] : (p.probability ?? null),
    landmarks: (p.landmarks || []).map(([x, y]) => ({ x: Math.round(x), y: Math.round(y) })),
  }));
}

// Load a data-URL screenshot into an <img>, then detect. Used by the
// popup smoke button on top of the CAPTURE_TAB screenshot dataURL.
export async function detectFacesFromDataUrl(dataUrl) {
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = dataUrl;
  });
  return detectFaces(img);
}
