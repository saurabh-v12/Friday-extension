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
// Wake-word "Hey Friday": continuous SpeechRecognition scan for the phrase;
// on detect, hand off the current transcript to the task pipeline.

export function isSttSupported() {
  return typeof (window.SpeechRecognition || window.webkitSpeechRecognition) !== "undefined";
}

export function isTtsSupported() {
  return typeof window.speechSynthesis !== "undefined";
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
  rec.onresult = (evt) => {
    let interim = "";
    for (let i = evt.resultIndex; i < evt.results.length; i++) {
      const r = evt.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    if (interim && onInterim) onInterim(interim);
    if (finalText && onFinal) onFinal(finalText.trim());
  };
  rec.onerror = (evt) => { if (onError) onError(evt.error || "speech-error"); };
  rec.onend = () => { if (onEnd) onEnd(finalText.trim()); };
  try { rec.start(); } catch (err) { if (onError) onError(err.message || String(err)); }
  return {
    stop: () => { try { rec.stop(); } catch (_) {} },
    abort: () => { try { rec.abort(); } catch (_) {} },
  };
}

// ─── Wake-word listener (Task 5.2) ───────────────────────────────────
//
// Continuous SpeechRecognition scanning for the "hey friday" phrase. When
// detected, captures the rest of the utterance (or the next chunk) as the
// task and hands it back through `onTask`. Restarts itself on `onend`
// (SpeechRecognition auto-stops after some idle time in Chrome).
export function startWakeWord({
  phrase = "hey friday",
  onListening,
  onWake,
  onTask,
  onError,
  lang = "en-US",
} = {}) {
  const norm = phrase.toLowerCase().replace(/\s+/g, " ").trim();
  const rec = createRecognition({ continuous: true, interimResults: true, lang });
  let alive = true;
  let armed = false;      // heard the wake word, capturing the task now
  let taskBuffer = "";
  let armedAt = 0;

  rec.onresult = (evt) => {
    for (let i = evt.resultIndex; i < evt.results.length; i++) {
      const alt = evt.results[i][0];
      const heard = (alt.transcript || "").toLowerCase();
      const isFinal = evt.results[i].isFinal;

      if (!armed) {
        if (heard.includes(norm)) {
          armed = true;
          armedAt = performance.now();
          taskBuffer = heard.split(norm).slice(1).join(norm).trim();
          if (onWake) onWake(taskBuffer);
        }
      } else if (isFinal) {
        // Append final chunk to the task, then hand off.
        if (heard.includes(norm)) {
          taskBuffer += " " + heard.split(norm).slice(1).join(norm).trim();
        } else {
          taskBuffer += " " + heard;
        }
        taskBuffer = taskBuffer.trim();
        if (taskBuffer && onTask) onTask(taskBuffer);
        armed = false;
        taskBuffer = "";
      }
    }
  };
  rec.onerror = (evt) => { if (onError) onError(evt.error || "speech-error"); };
  rec.onend = () => {
    if (!alive) return;
    // Chrome auto-stops after silence — restart if the caller still wants
    // us live. Yield to the event loop first (browsers dislike immediate
    // re-start from onend).
    setTimeout(() => { if (alive) { try { rec.start(); } catch (_) {} } }, 100);
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
      try { rec.stop(); } catch (_) {}
    },
  };
}
