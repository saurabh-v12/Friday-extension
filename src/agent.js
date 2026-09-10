// ReAct-style agent loop (Task 4.4).
//
// One iteration = OBSERVE (capture + redact + safe payload) → REASON
// (route to local or BYOK) → ACT (execute click/type/scroll on the DOM).
// Repeats until the reasoner emits `stop`, hits `maxSteps`, or errors out.
//
// The loop is the SINGLE place that knows about ordering. Callers hand it
// {task, source, config, onStep} and get back {steps, final} — everything
// visible in the trace comes through `onStep(evt)`.

import { MESSAGE_TYPES, sendToBackground } from "./messaging.js";
import { runPrivacyPipeline, buildSanitizedPayload } from "./pipeline.js";
import { route, SOURCES } from "./router.js";
import { MCPManager } from "./mcp.js";

export const DEFAULT_MAX_STEPS = 5;
export const OBSERVE_DELAY_MS = 700; // give the page a moment after an action

// Intent gate — sits UPSTREAM of the local/cloud split so both backends
// stop capturing on plain chat ("Hi", "Hello Friday", "What is 2+2?").
//
// Rules:
//   • Agent mode always needs the page — that's the whole point.
//   • Chat mode only needs the page when the task references it explicitly:
//     - page-action verb (click / type / fill / submit / …) OR
//     - page reference noun ("this/the page|form|screen|site|tab", "here").
//   • Everything else routes as text-only chat.
export function needsPage(task, mode = "chat") {
  if (mode === "agent") return true;
  if (!task || typeof task !== "string") return false;
  const t = task.toLowerCase();

  // Page-reference nouns — "sign in on this page", "read the form", "here".
  const pageRef = /\b(?:this|the|current)\s+(?:page|form|screen|site|tab|window|url|input|field|button)\b|\bhere\b/;
  if (pageRef.test(t)) return true;

  // Page-action verbs. Word-boundaries so "clicked yesterday" doesn't fire
  // and "type of tea" doesn't fire either (type→typing/type into ok, but
  // bare "type" without object is rare in normal chat).
  const verbs = new RegExp(
    "\\b(?:" +
      "click|tap|press|" +
      "type\\s+(?:in|into)|fill(?:\\s+in|\\s+out)?|" +
      "submit|select|scroll|" +
      "open|navigate|go\\s?to|goto|" +
      "read|summar[iy][sz]e|extract|" +
      "screenshot|capture|scan|redact|" +
      "sign\\s?in|log\\s?in|log\\s?on|" +
      "check\\s?out|checkout|purchase|order|" +
      "search\\s+for|find\\s+(?:on|in)" +
    ")\\b"
  );
  return verbs.test(t);
}

// evt shapes emitted to onStep:
//   { phase: 'observe', step }
//   { phase: 'reason', step, latencyMs, source, model? }
//   { phase: 'act', step, action, execResult, execError? }
//   { phase: 'stop', step, reason, output }
//   { phase: 'error', step, message }
export async function runAgent({
  task,
  mode = "chat",
  source = SOURCES.LOCAL,
  config = {},
  maxSteps = DEFAULT_MAX_STEPS,
  onStep,
  mcpServers,
} = {}) {
  if (!task || typeof task !== "string") throw new Error("runAgent: task is required");
  const emit = (evt) => { if (onStep) onStep(evt); };

  const trace = [];
  let final = null;
  const pageNeeded = needsPage(task, mode);

  // Bring up MCP once — subsequent iterations reuse the same manager.
  // Skipped in chat-only path (no MCP tools without page context).
  let mcpManager = null;
  let mcpTools = [];
  if (pageNeeded && Array.isArray(mcpServers) && mcpServers.length > 0) {
    mcpManager = new MCPManager(mcpServers);
    const initReport = await mcpManager.initAll();
    emit({ phase: "mcp-init", report: initReport });
    mcpTools = mcpManager.allTools();
  }

  // ── Chat-only fast path (Fix 1): no capture, no PII, no OCR, no redact.
  // One REASON step, treat the raw reply as a `say` action, stop.
  if (!pageNeeded) {
    emit({ phase: "chat-only", task });
    const t0 = performance.now();
    let result;
    try {
      result = await route({ task, payload: null, source, config, mcpTools: [], chatOnly: true });
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      emit({ phase: "error", step: 1, message: msg });
      return { steps: [{ step: 1, error: msg }], final: { type: "error", message: msg } };
    }
    const reasonMs = performance.now() - t0;
    emit({
      phase: "reason",
      step: 1,
      latencyMs: reasonMs,
      source: result.source,
      model: result.meta && result.meta.model,
      action: result.action,
      raw: result.raw,
      chatOnly: true,
    });
    const text = (result.action && result.action.text) || result.raw || "";
    emit({ phase: "stop", step: 1, reason: "chat reply", output: text });
    return {
      steps: [{ step: 1, action: result.action, reasonMs }],
      final: { type: "say", text },
    };
  }

  for (let step = 1; step <= maxSteps; step++) {
    // ── OBSERVE
    emit({ phase: "observe", step });
    const receipt = await runPrivacyPipeline();
    const payload = buildSanitizedPayload(receipt);

    // ── REASON
    const t0 = performance.now();
    let result;
    try {
      result = await route({ task, payload, source, config, mcpTools });
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      emit({ phase: "error", step, message: msg });
      trace.push({ step, error: msg });
      return { steps: trace, final: { type: "error", message: msg } };
    }
    const reasonMs = performance.now() - t0;
    emit({
      phase: "reason",
      step,
      latencyMs: reasonMs,
      source: result.source,
      model: result.meta && result.meta.model,
      action: result.action,
      raw: result.raw,
    });

    // ── ACT (or STOP / SAY)
    const action = result.action;
    if (action.type === "stop") {
      final = { type: "stop", reason: action.reasoning || "", text: action.text || "" };
      emit({ phase: "stop", step, reason: final.reason, output: final.text });
      trace.push({ step, action, reasonMs });
      break;
    }
    if (action.type === "say") {
      final = { type: "say", text: action.text || "" };
      emit({ phase: "stop", step, reason: "assistant reply (no action taken)", output: final.text });
      trace.push({ step, action, reasonMs });
      break;
    }

    // click / type / scroll → EXECUTE via BG router.
    // mcp → route to MCPManager (args scrubbed on call).
    let execResult = null, execError = null;
    if (["click", "type", "scroll", "focus"].includes(action.type)) {
      try {
        execResult = await sendToBackground(MESSAGE_TYPES.EXECUTE, {
          action: action.type,
          fid: action.fid,
          text: action.text,
        });
      } catch (err) {
        execError = err.message || String(err);
      }
    } else if (action.type === "mcp") {
      if (!mcpManager) {
        execError = "mcp action requested but no MCP servers configured";
      } else {
        try {
          const mcpRes = await mcpManager.callTool(action.server, action.tool, action.args || {});
          execResult = {
            mcp: true,
            server: action.server,
            tool: action.tool,
            sentArgs: mcpRes.sentArgs,
            content: mcpRes.content,
            isError: mcpRes.isError,
          };
        } catch (err) {
          execError = err.message || String(err);
        }
      }
    } else {
      execError = `unknown action type: ${action.type}`;
    }
    emit({ phase: "act", step, action, execResult, execError });
    trace.push({ step, action, reasonMs, execResult, execError });

    if (execError) {
      // Don't spin on the same error — surface it and stop.
      final = { type: "error", message: `exec failed at step ${step}: ${execError}` };
      break;
    }

    // Small delay so the next observation catches the post-action DOM.
    await new Promise((r) => setTimeout(r, OBSERVE_DELAY_MS));
  }

  if (!final) {
    final = { type: "max-steps", message: `hit maxSteps=${maxSteps} without stop` };
    emit({ phase: "stop", step: maxSteps, reason: final.message, output: "" });
  }

  return { steps: trace, final };
}
