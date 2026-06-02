/**
 * Orchestrator increment 2b — map the core's lossy TraceEntry into the shared
 * AgentStreamEvent the UI renders (the same event type the deep-mode stream
 * uses, so one AgentStream component serves both).
 *
 * Wording is plain and lead-with-takeaway (matching the deep-mode copy): the
 * operator should be able to read the move log without decoding jargon.
 */
import type { TraceEntry } from "./orchestrator.js";
import type { AgentStreamEvent } from "../types/ws-types.js";

/** Pure, presentation-only mapping. The orchestrator core stays UI-agnostic. */
export function traceEntryToStreamEvent(e: TraceEntry): Omit<AgentStreamEvent, "seq"> {
  switch (e.move) {
    case "hypothesize":
      return { verb: "proposed a cause:", target: e.detail, status: "running" };

    case "query":
      // detail is "<hypothesis> → +N observations"
      return { verb: "gathered evidence", detail: e.detail, status: "done" };

    case "test": {
      if (e.verdict === "satisfied") {
        return { verb: "evidence backs", target: e.detail, status: "strong" };
      }
      return {
        verb: "ruled out",
        target: e.detail,
        detail: e.verdict ? `(${e.verdict === "absent" ? "no supporting evidence" : "evidence contradicts it"})` : undefined,
        status: "rejected",
      };
    }

    case "conclude": {
      // Core sets detail to "confirmed: <hypothesis>" on accept, or a
      // "rejected — …" explanation when self-confidence wasn't keystone-backed.
      if (e.detail.startsWith("confirmed:")) {
        return { verb: "root cause:", target: e.detail.replace(/^confirmed:\s*/, ""), status: "strong" };
      }
      return { verb: "not confirmed yet — kept looking", detail: e.detail, status: "running" };
    }

    case "spawn-subagent":
      return { verb: "spun up a subagent", target: e.detail, status: "done", indent: 1 };

    case "follow-cause":
      return { verb: "followed the trail to", target: e.detail, status: "done" };
  }
}
