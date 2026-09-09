# FRIDAY — MASTER PLAN & PROGRESS

> This file is the single source of truth. Claude Code MUST update it after
> every task: tick the checkbox, write what was done, and note what's next.
> On a new session or after running out of context, READ THIS FILE FIRST and
> resume from the first unchecked task. Never redo finished work.

---

## REPO & GIT RULES (do this on every task)
- Remote: `https://github.com/saurabh-v12/Friday-extension.git`
- First task only: `git init`, add remote, first commit + push (`-u origin master`).
- After EVERY task below: `git add -A` → `git commit -m "<task msg>"` → `git push`.
- Small, frequent commits — one per task, never batch.
- After each task: update THIS file (check the box + status), then commit it too.
- `git config user.email` must match the GitHub account or contributions won't count.

---

## WHAT WE ARE BUILDING (one line)
A Chrome extension "Friday" that reads the screen with a local in-browser AI,
redacts private data on-device, and acts on the page by voice or text — with
nothing sensitive ever leaving the machine.

## LOCKED DESIGN DECISIONS (do not change without updating this file)
- **DOM for control, vision for understanding.** Clicks/typing target real DOM +
  accessibility-tree elements (near-100% accuracy). Vision is only for screen
  understanding + PII detection.
- **Fully in-browser, zero user setup.** Models run via Transformers.js + WebGPU,
  downloaded once and cached in the browser (Cache Storage/IndexedDB). No Ollama,
  no server, no terminal for the end user.
- **Brain Router** chooses reasoning source per task: Local model → BYOK key → MCP.
- **Privacy boundary is absolute:** redaction runs on-device BEFORE any network
  or tool call.
- Chrome first. One flawless demo over many half-working features.

## STACK
Manifest V3 · JavaScript/TypeScript · Transformers.js + WebGPU · BlazeFace ·
Tesseract.js · Canvas API · content script (DOM control) · Web Speech API ·
BYOK (Gemini/OpenAI/Groq) · MCP client (stretch) · chrome.storage.local

## UNIQUE FEATURES (beyond the problem statement)
1. Voice-first agentic control ("Hey Friday").
2. Privacy receipt — shows exactly what was redacted, live.
3. Brain Router — local for speed/privacy, BYOK for hard tasks.
4. MCP connections — act across apps, PII redacted first.
5. Learns private items — mark once, always redacted.

---

## UI DESIGN SPEC (LOCKED — build the side panel to match this)
Reference mockup lives at `design/friday-ui.png` in the repo.

**Theme:** light — white / very-light (#f7f7f8) background, black text, crimson
accent `#ff2e63`. Rounded corners, generous whitespace, clean sans-serif.
Tall vertical sidebar (extension side panel / popup).

**HEADER (one row, thin bottom border):**
- Left: red Friday wing-logo + "Friday" in bold black.
- Center: a dropdown pill labelled "Chat / Agent" (switches mode).
- Right: a toggle switch showing cloud icon <-> monitor icon (Cloud vs On-Device
  mode), then a settings gear icon.

**BODY (empty state, centered vertically):**
- A crimson sparkle/spark icon.
- Heading: "Hey! I'm " in black + "Friday" in crimson, bold, large.
- Subtitle (grey, two lines): "Your private AI agent, running on your device." /
  "No data leaves your browser."
- (Later phases add command chips + the privacy-receipt card here.)

**INPUT BAR (bottom, rounded box, light border):**
- Placeholder: "Hey!, Wassup what you doing now."
- Bottom row inside the box: "+" button (left), a "Select Model" dropdown, a mic
  icon, and a black circular send button (right).

**Notes:** keep it minimal, match spacing/layout of the mockup. Privacy status
("On-device / 0 data sent") is shown via the header Cloud/On-Device toggle.

## PROGRESS LOG (newest at top — Claude Code appends here each session)
- 2026-09-10 — 0.7 hang diagnosis + fixes: user report — cache works (`loadMs=1025`, `cached=0.0 MB`), PNG decodes cleanly, but inference hangs indefinitely with no `[infer.out]`. Suspected cause: first-inference WebGPU shader compile on Intel iGPU can take 30–60s and previously we had no visibility. Fixes: (1) `MAX_NEW_TOKENS 192 → 64`, greedy already; (2) hooked `TextStreamer(processor.tokenizer, { skip_prompt, skip_special_tokens, callback_function })` — logs `[infer] first-token in Xms` on first chunk, updates the status line every 4 chunks (`generating… N chunks, Xs`), so a silent stall is now visible; (3) real interrupt via `InterruptableStoppingCriteria` — 60s `setTimeout` calls `.interrupt()`, `generate()` returns cleanly, we log `[infer] TIMEOUT after 60s` and still print whatever the streamer accumulated; (4) added "Force WASM" checkbox next to Test AI so the same inference can be benchmarked on CPU vs GPU without touching code — unchecked→WebGPU, checked→WASM. Log line expanded: `backend inferMs firstTokenMs chunks timedOut`. Awaiting user re-run for the numbers.
- 2026-09-09 — 0.7 partial (first-run numbers in): user report — WebGPU available, model loaded on `webgpu` in ~43000 ms (first-run download); inference FAILED with "The source image could not be decoded" because the popup's decoder rejects SVG blobs. **Fix committed:** replaced `assets/sample-screen.svg` with a real `assets/sample-screen.png` (512×512, rendered offline via PowerShell + System.Drawing — bundled binary, no build step). Loader simplified to `RawImage.read(url)` (Transformers.js handles PNG fetch + decode + normalization end-to-end). Added `state.downloadedBytes` tally driven by the shared progress callback — after a fully-cached load no `progress` events fire, so the counter stays 0 and the `[load]` line now prints `cached=0.0MB` vs `downloaded=<N>MB` for unambiguous first-run vs cached distinction. Awaiting user re-run for cached load time + inference numbers + generated text.
- 2026-09-09 — 0.6 code written (numbers pending 0.7): added `assets/sample-screen.svg` (mock sign-in card: title, email input + placeholder, password input + placeholder, primary "Sign in" button, "Forgot password?" link). New "Run on sample" button in `popup.html` (disabled until model loads). `runInference()` in `src/popup-main.js`: fetches the SVG → `createImageBitmap` resizes to 512×512 → `OffscreenCanvas.getImageData` → drops alpha to RGB → wraps in `RawImage`; builds `messages` with image + `"Describe this screen and list buttons and input fields"`, calls `processor.apply_chat_template`, `model.generate({ max_new_tokens: 192, do_sample: false })`, trims prompt tokens off the front of the generated ids before `batch_decode`. Logs `backend`, `loadMs`, `inferMs`, and the decoded text. Since I can't drive a Chrome extension from bash, the real numbers land in 0.7 (user runs it and reports). Next: 0.7 GATE.
- 2026-09-09 — 0.5 done: Test AI now loads `HuggingFaceTB/SmolVLM-256M-Instruct` via `AutoProcessor` + `AutoModelForImageTextToText` (verified both symbols present in vendored `transformers.min.js`; verified ONNX weight paths + sizes on the HF hub before committing dtype choice). WebGPU preferred with `dtype: 'q4f16'` (~188 MB total: vision_encoder 55 MB + embed_tokens 56 MB + decoder 77 MB); on failure falls back to WASM with `dtype: 'q4'` (~262 MB). Aggregated download progress across all model files drives the popup progress bar and status line; final line logs `backend=… loadMs=…`. Browser Cache Storage handles reuse — no re-download on second click. **Caveat for testing:** Chrome extension popups close on outside click, tearing down downloads mid-flight; keep the popup open (or right-click extension icon → "Inspect popup") for the first-run test. Inference (0.6) will consume `state.processor` + `state.model`. Next: 0.6.
- 2026-09-09 — 0.4 done: Test AI button now runs `detectWebGPU()` in `src/popup-main.js` — checks `navigator.gpu`, calls `navigator.gpu.requestAdapter()`, prints `AVAILABLE` (with vendor/architecture/device from `adapter.info`) or `NOT available` (with reason: no `gpu`, null adapter, or thrown error). Sets a matching status line so the 0.5 fallback path is prewired. Next: 0.5 (download+load small VLM on WebGPU, WASM fallback).
- 2026-09-09 — 0.3 done: added `@huggingface/transformers@^3.0.0` via `package.json` + `npm install`; wrote `scripts/build.mjs` which copies `node_modules/@huggingface/transformers/dist/*` → `dist/vendor/transformers/` (JS + ORT WASM), so no CDN at runtime; moved popup entry to `src/popup-main.js` as an ES module that imports from the local vendor path, sets `env.backends.onnx.wasm.wasmPaths` to that folder, disables `allowLocalModels`, enables `useBrowserCache`, and logs proof-of-load on popup open; `popup.html` now loads `src/popup-main.js` with `type="module"` (old flat `popup.js` deleted). Manifest CSP updated: `script-src 'self' 'wasm-unsafe-eval'` so ORT WASM can init. Dev workflow: `npm install && npm run build`; `dist/` gitignored per plan. Next: 0.4 (WebGPU detect on Test AI click).
- 2026-09-09 — 0.2 done: added `manifest.json` (MV3, name "Friday", perms `activeTab`/`scripting`/`storage`, `host_permissions: <all_urls>`, popup action), `popup.html` (Test AI button, live status, progress bar, output area — minimal light theme; the pretty side-panel UI comes in 1.2), `popup.js` (button wiring, status/progress helpers, placeholder progress tick — WebGPU + model load land in 0.4–0.6). Next: 0.3 (bundle Transformers.js offline).
- 2026-09-09 — 0.1 done: renamed plan file to `FRIDAY-PLAN.md`, `git init`, added remote `origin` → https://github.com/saurabh-v12/Friday-extension.git, wrote `.gitignore` (node_modules, dist, build, IDE junk, logs, .env), first commit + push `-u origin master`. Next: 0.2 (MV3 scaffold).

---

## TASKS

### PHASE 0 — DAY-1 PROOF (gate: must pass before Phase 1)
- [x] 0.1 Init repo: `git init`, set remote to the URL above, `.gitignore`
      (node_modules, dist), first commit + push.
- [x] 0.2 Minimal MV3 extension: manifest.json (name "Friday"; permissions
      activeTab, scripting, storage; host_permissions <all_urls>), popup.html
      with a "Test AI" button + status + progress bar + output area, popup.js.
- [x] 0.3 Add Transformers.js (@huggingface/transformers), bundled to work
      offline after first load.
- [x] 0.4 On "Test AI": check `navigator.gpu`; print WebGPU available/not.
- [x] 0.5 Download + load a SMALL vision-language model (Moondream2 or SmolVLM)
      on WebGPU; WASM fallback; show download progress bar; report backend used.
- [x] 0.6 Run the model on a bundled sample screenshot with prompt "Describe this
      screen and list buttons and input fields"; print output + load time +
      inference time.
- [ ] 0.7 GATE REVIEW: record the numbers in the progress log. If it runs at
      acceptable speed → proceed to Phase 1. If too slow → switch to a smaller
      model / lean harder on detectors before continuing.

### PHASE 1 — EXTENSION SHELL + UI
- [ ] 1.1 Background service worker + message routing (popup/content <-> worker).
- [ ] 1.2 Build the side-panel UI to match the UI DESIGN SPEC above (header,
      empty-state body, input bar). Light theme, crimson accent. Save the
      reference mockup to `design/friday-ui.png`.
- [ ] 1.3 Wire header controls: Chat/Agent dropdown, Cloud/On-Device toggle,
      settings gear (open a settings view stub).
- [ ] 1.4 Content script skeleton injected into the active tab.
- [ ] 1.5 Screen capture (chrome.tabs.captureVisibleTab) + read DOM /
      accessibility tree; return a structured snapshot.
- [ ] 1.6 First-run model download with progress bar; cache + reuse (no
      re-download on later runs).

### PHASE 2 — PRIVACY LAYER (graded core)
- [ ] 2.1 DOM PII detector: find password, email, name, ID/Aadhaar/PAN fields.
- [ ] 2.2 Face detection with BlazeFace on the captured screen.
- [ ] 2.3 OCR text-PII with Tesseract.js (emails, numbers, IDs in images).
- [ ] 2.4 Redaction engine: Canvas mask/blur over every detected region, on-device.
- [ ] 2.5 Privacy receipt UI: show exactly what was redacted before any send.
- [ ] 2.6 Build sanitized payload (redacted image + safe DOM structure).

### PHASE 3 — CONTROL LAYER (99% accuracy)
- [ ] 3.1 DOM-anchored executor: click(target), type(target,text), scroll —
      targeting real elements via the accessibility tree, not pixel guessing.
- [ ] 3.2 Element resolver: map an intent ("submit button") to the exact DOM node.
- [ ] 3.3 Verify tiny buttons/links/fields are hit reliably; log accuracy.

### PHASE 4 — BRAIN ROUTER + REASONING
- [ ] 4.1 Router interface: (task + sanitized context) -> action, behind ONE
      config value so sources swap without a rewrite.
- [ ] 4.2 Source A — local in-browser VLM (default, offline).
- [ ] 4.3 Source B — BYOK: settings page to store an API key
      (chrome.storage.local, encrypted); route hard tasks to Gemini/OpenAI/Groq.
      Wire this to the header Cloud/On-Device toggle + "Select Model" dropdown.
- [ ] 4.4 ReAct-style loop: plan → tool/action → observe → repeat, with a Stop.

### PHASE 5 — VOICE (Friday)
- [ ] 5.1 Web Speech API STT for command input (wire to the mic button).
- [ ] 5.2 Wake word "Hey Friday" (lightweight).
- [ ] 5.3 TTS responses; full hands-free flow: speak → see → redact → act → speak.

### PHASE 6 — MCP (stretch / wow)
- [ ] 6.1 MCP client; settings to enable MCP servers.
- [ ] 6.2 Agent can call an external tool (e.g. Gmail/Notion); PII redacted first.

### FINAL
- [ ] F.1 One flawless end-to-end demo task (form with face + password + email:
      capture → redact → action → execute), on a controlled test page.
- [ ] F.2 First-run UX polish (progress, clear status), error handling.
- [ ] F.3 Record demo video + write a short README.

---

## DONE WHEN
- Installing the extension works with zero manual setup (model self-downloads,
  cached after).
- A voice/text command reads the screen, visibly redacts PII, and executes the
  action accurately (including small buttons).
- Runs fully on-device by default; BYOK available for harder tasks.
- Privacy receipt proves nothing sensitive left the machine.
- The side panel matches the UI DESIGN SPEC.
- Every task committed and pushed to the repo.
