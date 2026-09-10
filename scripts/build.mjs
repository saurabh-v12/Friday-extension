// Vendor-copy step. MV3 blocks remote scripts, so every runtime dependency
// has to live under dist/vendor/ inside the extension. This script:
//   1. Copies Transformers.js dist (optional local VLM, gate 0.7).
//   2. Copies TensorFlow.js UMD + WASM backend UMD + the .wasm binaries.
//   3. Copies BlazeFace UMD.
//
// After first run the on-device detectors (BlazeFace weights, Transformers.js
// weights) fetch to Cache Storage on first use; nothing needs re-downloading
// on subsequent loads.

import { cp, mkdir, rm, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const NM = join(root, "node_modules");
const OUT = join(root, "dist", "vendor");

async function copyDir(src, dst, label) {
  if (!existsSync(src)) {
    console.error(`[build] not found: ${src}`);
    console.error("[build] run `npm install` first.");
    process.exit(1);
  }
  await rm(dst, { recursive: true, force: true });
  await mkdir(dst, { recursive: true });
  await cp(src, dst, { recursive: true });
  console.log(`[build] ${label} -> ${dst}`);
}

async function copyOne(src, dst, label) {
  if (!existsSync(src)) {
    console.error(`[build] not found: ${src}`);
    process.exit(1);
  }
  await mkdir(dirname(dst), { recursive: true });
  await copyFile(src, dst);
  console.log(`[build] ${label} -> ${dst}`);
}

// 1) Transformers.js (whole dist — includes ORT WASM + wrappers).
await copyDir(
  join(NM, "@huggingface", "transformers", "dist"),
  join(OUT, "transformers"),
  "Transformers.js dist",
);

// 2) TensorFlow.js core UMD + WASM backend UMD + WASM binaries.
await mkdir(join(OUT, "tfjs"), { recursive: true });
await copyOne(
  join(NM, "@tensorflow", "tfjs", "dist", "tf.min.js"),
  join(OUT, "tfjs", "tf.min.js"),
  "TFJS UMD",
);
await copyOne(
  join(NM, "@tensorflow", "tfjs-backend-wasm", "dist", "tf-backend-wasm.min.js"),
  join(OUT, "tfjs", "tf-backend-wasm.min.js"),
  "TFJS WASM backend UMD",
);
for (const wasm of [
  "tfjs-backend-wasm.wasm",
  "tfjs-backend-wasm-simd.wasm",
  "tfjs-backend-wasm-threaded-simd.wasm",
]) {
  await copyOne(
    join(NM, "@tensorflow", "tfjs-backend-wasm", "dist", wasm),
    join(OUT, "tfjs", wasm),
    `TFJS ${wasm}`,
  );
}

// 3) BlazeFace UMD (relies on window.tf being present before this loads).
await copyOne(
  join(NM, "@tensorflow-models", "blazeface", "dist", "blazeface.min.umd.js"),
  join(OUT, "blazeface", "blazeface.min.js"),
  "BlazeFace UMD",
);

console.log("[build] done.");
