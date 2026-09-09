// Copies Transformers.js browser dist into ./dist/vendor/transformers so the
// extension can load it locally (MV3 blocks remote scripts).
// After first model download, everything runs offline from the browser cache.

import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const srcDir = join(root, "node_modules", "@huggingface", "transformers", "dist");
const outDir = join(root, "dist", "vendor", "transformers");

if (!existsSync(srcDir)) {
  console.error(`[build] not found: ${srcDir}`);
  console.error("[build] run `npm install` first.");
  process.exit(1);
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await cp(srcDir, outDir, { recursive: true });

console.log(`[build] copied Transformers.js dist -> ${outDir}`);
