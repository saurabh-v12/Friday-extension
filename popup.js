// Phase 0 popup wiring.
// Task 0.2: just prove the button click reaches JS and can update status/progress/output.
// WebGPU detect (0.4) and model load/inference (0.5–0.6) are added in later tasks.

const $ = (id) => document.getElementById(id);

function setStatus(text) {
  $("status").textContent = text;
}

function setProgress(percent) {
  const bar = $("progress");
  if (percent == null) {
    bar.classList.remove("visible");
    bar.removeAttribute("value");
    return;
  }
  bar.classList.add("visible");
  bar.value = Math.max(0, Math.min(100, percent));
}

function log(line) {
  const out = $("output");
  if (out.textContent === "(output will appear here)") out.textContent = "";
  out.textContent += (out.textContent ? "\n" : "") + line;
  out.scrollTop = out.scrollHeight;
}

async function onTestAi() {
  $("testAiBtn").disabled = true;
  setStatus("clicked — scaffold only, no AI yet");
  setProgress(0);
  log("Test AI clicked at " + new Date().toISOString());
  // Placeholder progress tick so the bar is visibly wired.
  for (let p = 0; p <= 100; p += 20) {
    setProgress(p);
    await new Promise((r) => setTimeout(r, 40));
  }
  setStatus("scaffold OK (0.2). WebGPU check + model load land in 0.4–0.6.");
  setProgress(null);
  $("testAiBtn").disabled = false;
}

document.addEventListener("DOMContentLoaded", () => {
  $("testAiBtn").addEventListener("click", onTestAi);
});
