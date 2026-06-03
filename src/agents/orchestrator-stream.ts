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
import type { RankedHypothesis } from "../types/rca-types.js";

/**
 * Assemble the causal chain from a finished run: the incident service, each
 * dependency the agent followed into (in order), and the confirmed root cause.
 * Ordered cause→effect with source attribution — the orchestrator's headline
 * output. Returns the links; the caller renders them with arrows. A chain of
 * length 1 (just the incident) means nothing was followed or confirmed.
 */
export function assembleCausalChain(
  trace: TraceEntry[],
  confirmed: RankedHypothesis | undefined,
  incidentService: string,
): string[] {
  const chain: string[] = [];
  if (incidentService) chain.push(incidentService);
  for (const t of trace) {
    if (t.move === "follow-cause" && / → \+\d+ findings$/.test(t.detail)) {
      chain.push(t.detail.replace(/ → \+\d+ findings$/, "").trim());
    }
  }
  if (confirmed) chain.push(`root cause: ${confirmed.hypothesis}`);
  return chain;
}

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
