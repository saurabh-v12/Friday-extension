# Friday

A private, on-device AI agent for Chrome. Friday reads the screen, redacts
private data on-device, and acts on the page by voice or text — with
nothing sensitive leaving the machine.

**Status:** Phases 0–6 complete. Every task from `FRIDAY-PLAN.md` is
implemented and committed. See the progress log in that file for the
day-by-day story.

---

## What it does

- **Sees.** Screenshot of the active tab + a structured DOM/accessibility
  snapshot (roles, names, bboxes) — one call, in parallel.
- **Redacts.** Three detectors run on-device: DOM PII (regex over element
  values + `autocomplete` tokens + labels), face detection (BlazeFace via
  TensorFlow.js), and OCR text-PII (Tesseract.js). A canvas engine blurs
  each region on the screenshot before anything else touches it.
- **Reasons.** A brain router picks between two sources behind one config
  value: local in-browser VLM (SmolVLM via Transformers.js, opt-in — gate
  0.7 verdict: correct but slow on typical hardware) or a cloud model
  through your own API key (Gemini / OpenAI / Groq).
- **Acts.** DOM-anchored executor clicks, types, and scrolls the exact
  live element the snapshot surfaced — no pixel guessing. React-controlled
  inputs work because we set values through the prototype setter and fire
  `input`/`change` events. Small buttons hit as reliably as big ones.
- **Talks.** Web Speech STT (one-shot on mic click, wake-word "Hey Friday"
  on long-press) and OS TTS for replies.
- **Extends.** MCP client (HTTP transport) lets the agent call external
  tools like Gmail/Notion — with args PII-scrubbed on the client before
  they cross the wire.

The privacy boundary is absolute: redaction runs BEFORE the network. If
you switch the header toggle to Cloud, the request payload is the
redacted screenshot + a masked-DOM element list — never raw values.

---

## Install (dev)

```bash
git clone https://github.com/saurabh-v12/Friday-extension.git
cd Friday-extension
npm install
npm run build       # copies TFJS + BlazeFace + Tesseract + Transformers.js into dist/vendor/
```

Load in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and pick the repo root
4. Pin the Friday toolbar icon; click it to open the side panel

For BYOK cloud usage: open the side panel → gear icon → paste an API key
under **Cloud API key (BYOK)**, pick your provider, save. Flip the
header toggle to Cloud.

---

## Demo flow

1. Open `test/demo-signin.html` in a normal browser tab (either via a
   local server, or `file://` with "Allow access to file URLs" enabled in
   the extension's permissions page).
2. Click the Friday toolbar icon to open the side panel.
3. Click **Run privacy scan**. The receipt shows how many items were
   redacted (avatar face, email, password, phone number) with a redacted
   preview of the screenshot.
4. Type in the composer:
   `Sign in with jane.doe@acme.example.com and password Sup3rSecret`
5. Friday captures + redacts + routes to the reasoner + types both fields
   + clicks Sign in. The demo page flips to "Signed in — Friday demo
   complete."

For executor accuracy, open `test/executor-test.html` and click **Verify
executor** in the dev popup — it iterates 18 preset intents against
tiny/full-sized buttons + inputs + links and prints resolve/exec
accuracy percentages.

---

## Architecture

```
┌────────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│  Side panel UI     │◄───►│  Service worker  │◄──►│  Content script  │
│  (composer, mic,   │    │  (message router,│    │  (snapshot, exec,│
│   receipt, trace)  │    │   CAPTURE_TAB)   │    │   resolver)      │
└────────┬───────────┘    └──────────────────┘    └──────────────────┘
         │
         ├─► pipeline.js: capture → BlazeFace + Tesseract (parallel) → redact
         ├─► pii.js: PATTERNS (email/aadhaar/pan/ssn/cc/phone), detectDomPii
         ├─► redact.js: canvas mask/blur/mosaic, region collector
         ├─► router.js: SOURCES.LOCAL | SOURCES.BYOK, buildPrompt, parseAction
         ├─► byok.js: Gemini + OpenAI + Groq adapters
         ├─► agent.js: ReAct loop (observe → reason → act → repeat)
         ├─► voice.js: SpeechRecognition wrapper (one-shot + wake word) + TTS
         └─► mcp.js: MCP JSON-RPC client + PII-scrubbed args
```

Runtime dependencies bundled offline via `scripts/build.mjs` into
`dist/vendor/`:

- Transformers.js (`@huggingface/transformers` — optional local VLM)
- TensorFlow.js UMD + WASM backend + WASM binaries
- BlazeFace UMD (~10 KB, plus ~200 KB model weights fetched to Cache
  Storage on first use)
- Tesseract.js UMD + worker + core WASM (language data fetched to
  Cache Storage on first use)

CSP: `script-src 'self' 'wasm-unsafe-eval'; object-src 'self';` — MV3
allows `wasm-unsafe-eval` but forbids `unsafe-eval`, so the TFJS WASM
backend is used as fallback for CSP safety.

---

## Locked design decisions

Recorded in `FRIDAY-PLAN.md` and worth restating:

- DOM + accessibility tree drive control; vision only for understanding
  and PII detection. Gate 0.7 measured SmolVLM at ~100 s first-token on
  Intel iGPU — too slow for the critical path.
- On-device detectors (BlazeFace + Tesseract + DOM regex) are fast enough
  to run on every observation without user setup.
- Cloud reasoning is opt-in via the header toggle. Redaction always runs
  first.
- No CDN scripts at runtime; everything under `dist/vendor/` after the
  build step.

---

## Known caveats

- **Voice input isn't strictly on-device.** Web Speech Recognition in
  Chrome routes audio through Google's speech service. Reasoning still
  is (the toggle correctly gates that boundary), but voice-to-text
  goes through a network hop. Called out in `src/voice.js`.
- **Local VLM is off by default.** Enable it in Settings only if you
  have a strong GPU; SmolVLM is functional but ~100× too slow on
  Intel iGPU for interactive use.
- **MCP HTTP transport only.** Chrome extensions can't spawn stdio
  subprocesses — MCP servers you configure must expose an HTTP endpoint.
- **Demo video not yet recorded** (Task F.3, second half). The plan
  asked for a demo video; that step needs a human. Everything else in
  F.3 (this README) is done.

---

## Repo layout

```
background.js          MV3 service worker (message router)
content.js             Injected content script (snapshot + executor + resolver)
manifest.json          MV3 manifest (permissions, side panel, CSP)
popup.html + src/popup-main.js    Dev popup (smoke tests for every module)
sidepanel.html + .css + src/sidepanel-main.js   Primary UX (per UI DESIGN SPEC)
src/
  messaging.js         Shared message-type constants + sendToBackground/Tab
  pipeline.js          runPrivacyPipeline + buildSanitizedPayload
  pii.js               DOM PII detector (PATTERNS + rules)
  faces.js             BlazeFace lazy loader + detectFaces
  ocr.js               Tesseract.js + text-PII detector
  redact.js            Canvas mask/blur/mosaic + region collector
  router.js            Brain Router: route(), buildPrompt(), parseAction()
  byok.js              Gemini / OpenAI / Groq adapters
  agent.js             ReAct loop
  voice.js             STT (one-shot + wake word) + TTS
  mcp.js               MCP client (HTTP JSON-RPC + PII scrub on args)
  model.js             Optional local VLM loader (SmolVLM via Transformers.js)
scripts/build.mjs      Vendor-copy script (npm run build)
test/
  executor-test.html   18-target accuracy harness (Task 3.3)
  demo-signin.html     End-to-end demo page (Task F.1)
FRIDAY-PLAN.md         Master plan + progress log
```
