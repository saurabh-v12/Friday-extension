// Voice I/O helpers (Tasks 5.1 + 5.2 + 5.3).
//
// STT uses the Web Speech Recognition API (SpeechRecognition /
// webkitSpeechRecognition). **Caveat**: on desktop Chrome this routes
// audio through Google's speech service — it's not strictly on-device.
// This is a documented tradeoff of the plan's "Web Speech API STT"
// choice; when the header toggle says "On-Device" for reasoning that
// still holds — reasoning never leaves the machine — but voice
// transcription does use Google's service. Called out in the mic tooltip.
//
// TTS (`speechSynthesis`) uses the local OS voice engine and IS on-device.
//
// Wake-word "Friday": continuous SpeechRecognition scan for the phrase;
// on detect, hand off the current transcript to the task pipeline.

export function isSttSupported() {
  return typeof (window.SpeechRecognition || window.webkitSpeechRecognition) !== "undefined";
}

export function isTtsSupported() {
  return typeof window.speechSynthesis !== "undefined";
}

export async function ensureMicrophonePermission() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return { ok: true, skipped: true };
  }
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return { ok: true };
  } finally {
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
    }
  }
}

export function createRecognition({ continuous = false, interimResults = true, lang = "en-US" } = {}) {
  const RC = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!RC) throw new Error("Web Speech Recognition is not supported in this browser");
  const rec = new RC();
  rec.continuous = continuous;
  rec.interimResults = interimResults;
  rec.lang = lang;
  return rec;
}

// Speak `text` via the OS TTS engine. Cancels anything in-flight so the
// user doesn't get overlapping utterances when the agent produces two
// speak-worthy events back-to-back.
export function speak(text, opts = {}) {
  if (!isTtsSupported() || !text) return;
  const utter = new SpeechSynthesisUtterance(String(text));
  utter.rate = opts.rate != null ? opts.rate : 1.05;
  utter.pitch = opts.pitch != null ? opts.pitch : 1;
  utter.lang = opts.lang || "en-US";
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utter);
}

export function stopSpeaking() {
  if (isTtsSupported()) window.speechSynthesis.cancel();
}

// ─── Simple one-shot STT session ─────────────────────────────────────
//
// startDictation({ onInterim, onFinal, onEnd, onError }) → { stop }
// Ends automatically on the first `final` result OR when the API decides
// the user paused long enough. `stop()` aborts early.
export function startDictation({ onInterim, onFinal, onEnd, onError, lang = "en-US" } = {}) {
  const rec = createRecognition({ continuous: false, interimResults: true, lang });
  let finalText = "";
  let finalDelivered = false;
  rec.onresult = (evt) => {
    let interim = "";
    for (let i = evt.resultIndex; i < evt.results.length; i++) {
      const r = evt.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    const visible = [finalText, interim].filter(Boolean).join(" ").trim();
    if (visible && onInterim) onInterim(visible);
    if (finalText && onFinal && !finalDelivered) {
      finalDelivered = true;
      onFinal(finalText.trim());
      try { rec.stop(); } catch (_) {}
    }
  };
  rec.onerror = (evt) => {
    const error = evt.error || "speech-error";
    if (onError) onError(error);
  };
  rec.onend = () => { if (onEnd) onEnd(finalText.trim()); };
  try { rec.start(); } catch (err) { if (onError) onError(err.message || String(err)); }
  return {
    stop: () => { try { rec.stop(); } catch (_) {} },
    abort: () => { try { rec.abort(); } catch (_) {} },
  };
}

// ─── Wake-word listener (Task 5.2) ───────────────────────────────────
//
// Continuous SpeechRecognition scanning for the "friday" phrase. When
// detected, captures the rest of the utterance (or the next chunk) as the
// task and hands it back through `onTask`. Restarts itself on `onend`
// (SpeechRecognition auto-stops after some idle time in Chrome).
export function startWakeWord({
  phrase = ["friday", "hey friday", "fri day", "free day", "fry day", "freddy", "hey freddy"],
  onListening,
  onWake,
  onTask,
  onHeard,
  onIdle,
  onRestart,
  onError,
  lang = "en-US",
  submitDelayMs = 900,
  wakeTimeoutMs = 6500,
} = {}) {
  const phrases = Array.isArray(phrase) ? phrase : [phrase];
  const norms = phrases
    .map((p) => String(p || "").toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const rec = createRecognition({ continuous: true, interimResults: true, lang });
  let alive = true;
  let armed = false;      // heard the wake word, capturing the task now
  let taskBuffer = "";
  let interimTaskBuffer = "";
  let armedAt = 0;
  let submitTimer = null;
  let wakeTimer = null;

  const clean = (text) => String(text || "").toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
  const clearTimers = () => {
    if (submitTimer) clearTimeout(submitTimer);
    if (wakeTimer) clearTimeout(wakeTimer);
    submitTimer = null;
    wakeTimer = null;
  };
  const findPhrase = (text) => {
    const heard = clean(text);
    for (const norm of norms) {
      const idx = heard.indexOf(norm);
      if (idx !== -1) return { norm, before: heard.slice(0, idx).trim(), after: heard.slice(idx + norm.length).trim() };
    }
    return null;
  };
  const escapeRegExp = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stripLeadingWakePhrases = (text) => {
    let rest = clean(text);
    let changed = true;
    while (changed) {
      changed = false;
      for (const norm of norms) {
        if (rest === norm) return "";
        if (rest.startsWith(`${norm} `)) {
          rest = rest.slice(norm.length).trim();
          changed = true;
        }
      }
    }
    return rest;
  };
  const isWakeOnly = (text) => {
    let rest = clean(text);
    for (const norm of norms) {
      rest = rest.replace(new RegExp(`\\b${escapeRegExp(norm)}\\b`, "g"), " ");
    }
    return !clean(rest);
  };
  const disarm = ({ notify = true } = {}) => {
    armed = false;
    taskBuffer = "";
    interimTaskBuffer = "";
    clearTimers();
    if (notify && onIdle) onIdle();
  };
  const currentTask = () => clean([taskBuffer, interimTaskBuffer].filter(Boolean).join(" "));
  const submitTask = () => {
    const rawTask = currentTask();
    if (!rawTask) return;
    if (isWakeOnly(rawTask)) {
      disarm();
      return;
    }
    const task = stripLeadingWakePhrases(rawTask);
    if (!task) {
      disarm();
      return;
    }
    if (onTask) onTask(task);
    disarm({ notify: false });
  };
  const scheduleSubmit = () => {
    if (!currentTask()) return;
    if (submitTimer) clearTimeout(submitTimer);
    submitTimer = setTimeout(submitTask, submitDelayMs);
  };
  const scheduleWakeTimeout = () => {
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeTimer = setTimeout(disarm, wakeTimeoutMs);
  };

  rec.onresult = (evt) => {
    for (let i = evt.resultIndex; i < evt.results.length; i++) {
      const alt = evt.results[i][0];
      const heard = alt.transcript || "";
      const cleanedHeard = clean(heard);
      const isFinal = evt.results[i].isFinal;
      if (cleanedHeard && onHeard) onHeard(cleanedHeard, { armed, isFinal });

      if (!armed) {
        const match = findPhrase(heard);
        if (match) {
          clearTimers();
          armed = true;
          armedAt = performance.now();
          taskBuffer = isFinal ? match.after : "";
          interimTaskBuffer = isFinal ? "" : match.after;
          if (onWake) onWake(match.after);
          if (currentTask()) {
            if (isFinal) submitTask();
            else scheduleSubmit();
          } else {
            scheduleWakeTimeout();
          }
        }
      } else {
        // Append final chunk to the task, then hand off.
        const match = findPhrase(heard);
        const nextTaskText = match ? match.after : cleanedHeard;
        if (match) {
          if (isFinal) {
            taskBuffer = [taskBuffer, nextTaskText].filter(Boolean).join(" ");
            interimTaskBuffer = "";
          } else {
            interimTaskBuffer = nextTaskText;
          }
        } else {
          if (isFinal) {
            taskBuffer = [taskBuffer, nextTaskText].filter(Boolean).join(" ");
            interimTaskBuffer = "";
          } else {
            interimTaskBuffer = nextTaskText;
          }
        }
        taskBuffer = taskBuffer.trim();
        interimTaskBuffer = interimTaskBuffer.trim();
        if (currentTask()) {
          if (isFinal) submitTask();
          else scheduleSubmit();
        } else {
          scheduleWakeTimeout();
        }
      }
    }
  };
  rec.onerror = (evt) => {
    const error = evt.error || "speech-error";
    if (/not-allowed|service-not-allowed|audio-capture/i.test(error)) alive = false;
    if (onError) onError(error);
  };
  rec.onend = () => {
    if (armed && currentTask()) {
      submitTask();
    } else {
      clearTimers();
    }
    if (!alive) return;
    // Chrome auto-stops after silence — restart if the caller still wants
    // us live. Yield to the event loop first (browsers dislike immediate
    // re-start from onend).
    setTimeout(() => {
      if (!alive) return;
      try {
        rec.start();
        if (armed) scheduleWakeTimeout();
        if (onRestart) onRestart();
      } catch (_) {}
    }, 250);
  };

  try {
    rec.start();
    if (onListening) onListening();
  } catch (err) {
    if (onError) onError(err.message || String(err));
  }

  return {
    stop: () => {
      alive = false;
      clearTimers();
      try { rec.stop(); } catch (_) {}
    },
  };
}
