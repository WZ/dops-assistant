/**
 * Orchestrator increment 2b — map the core's lossy TraceEntry into the shared
 * AgentStreamEvent the UI renders (the same event type the deep-mode stream
 * uses, so one AgentStream component serves both).
 *
 * Wording is plain and lead-with-takeaway (matching the deep-mode copy): the
 * operator should be able to read the move log without decoding jargon.
 */
import type { TraceEntry, OrchestratorResult } from "./orchestrator.js";
import type { AgentStreamEvent, CausalChainLink, EvidenceProvenance } from "../types/ws-types.js";
import type { RankedHypothesis } from "../types/rca-types.js";
import type { NormalizedObservation } from "../workflows/steps/corroboration.js";

/** Trim a finding/observation string to a compact, one-line attribution. */
function attributionFromText(text: string): string {
  const stripped = text.replace(/^subagent:\s*/i, "").trim();
  return stripped.length > 90 ? `${stripped.slice(0, 87)}…` : stripped;
}

/** One-line, human-readable summary of the prediction a confirmed hypothesis
 *  was checked against — the evidence standard the keystone held it to. */
function predictionSummary(prediction: Record<string, unknown> | undefined): string | undefined {
  if (!prediction || typeof prediction !== "object") return undefined;
  const p = prediction as Record<string, unknown>;
  switch (p.kind) {
    case "metric-threshold":
      return `confirmed by ${p.metric} ${p.op} ${p.value}`;
    case "log-pattern":
      return `confirmed by log ${p.present === false ? "absence of" : "pattern"} "${p.pattern}"`;
    case "infra-status":
      return `confirmed by ${p.resource} ${p.status}`;
    case "change-in-window":
      return `confirmed by a change within ${p.withinMinutesBefore}m`;
    default:
      return undefined;
  }
}

/** Map a prediction kind to the evidence phase its discriminating re-query ran in
 *  (PR-3). Used to find the confirming query's provenance for a deep-link. */
function predictionPhase(kind: unknown): NormalizedObservation["phase"] | undefined {
  switch (kind) {
    case "metric-threshold": return "metrics";
    case "log-pattern": return "logs";
    case "infra-status": return "infra";
    case "change-in-window": return "changes";
    default: return undefined;
  }
}

/**
 * Find the deep-link provenance for a confirmed root cause (PR-3, locked decision D3):
 * subject-first, phase-fallback, LATEST-wins. The confirming re-query stamped its
 * tool call onto every observation it produced; we first try the observation whose
 * subject matches the prediction's target (metric / pattern / resource), then fall
 * back to the prediction's phase. In both cases we take the LATEST matching
 * observation: evidence accumulates in move order, so the confirming hypothesis's
 * re-query is appended after any earlier ruled-out hypothesis's — taking the first
 * would risk linking to a stale, ruled-out query in a multi-hypothesis run. The
 * fallback also lands the right query when the LLM's reported name isn't
 * byte-identical to the structured prediction. Returns undefined → text-only link.
 */
function provenanceForPrediction(
  prediction: Record<string, unknown> | undefined,
  evidence: NormalizedObservation[],
): EvidenceProvenance | undefined {
  if (!prediction) return undefined;
  const phase = predictionPhase(prediction.kind);
  if (!phase) return undefined;
  // Latest-match: scan newest → oldest so the confirming re-query wins.
  const latest = [...evidence].reverse();
  const target = (prediction.metric ?? prediction.pattern ?? prediction.resource) as string | undefined;
  if (target) {
    const exact = latest.find((o) => o.subject === target && o.provenance);
    if (exact?.provenance) return exact.provenance;
  }
  return latest.find((o) => o.phase === phase && o.provenance)?.provenance;
}

/**
 * Assemble the causal chain from a finished run: the incident service, each
 * dependency the agent followed into (in order), and the confirmed root cause.
 * Ordered cause→effect with SOURCE ATTRIBUTION (increment 6) — each followed
 * link carries the finding that pointed there, and the root cause carries the
 * prediction the keystone confirmed it against. A chain of length 1 (just the
 * incident) means nothing was followed or confirmed.
 */
export function assembleCausalChain(
  trace: TraceEntry[],
  confirmed: RankedHypothesis | undefined,
  incidentService: string,
  evidence: NormalizedObservation[] = [],
): CausalChainLink[] {
  const chain: CausalChainLink[] = [];
  const seen = new Set<string>();
  if (incidentService) { chain.push({ label: incidentService, kind: "incident" }); seen.add(incidentService); }
  for (const t of trace) {
    if (t.move === "follow-cause" && / → \+\d+ findings$/.test(t.detail)) {
      const service = t.detail.replace(/ → \+\d+ findings$/, "").trim();
      // A service followed more than once is one link, not a repeated hop — the
      // chain is the distinct cause path, not the move log.
      if (seen.has(service)) continue;
      seen.add(service);
      // The follow-cause subagent folds its conclusion back as a `subagent:`-
      // prefixed observation keyed by the followed service; prefer it for the
      // attribution, falling back to any other observation on that service.
      const finding =
        evidence.find((o) => o.subject === service && typeof o.text === "string" && /^subagent:/i.test(o.text)) ??
        evidence.find((o) => o.subject === service && !!o.text);
      chain.push({
        label: service,
        kind: "followed",
        evidence: finding?.text ? attributionFromText(finding.text) : undefined,
        // D4: copy provenance uniformly from the matched observation. Inert for
        // followed links today (subagent fold-backs carry none) — lights up for
        // free if they ever do, with no special-casing.
        provenance: finding?.provenance,
      });
    }
  }
  if (confirmed) {
    chain.push({
      label: `root cause: ${confirmed.hypothesis}`,
      kind: "root-cause",
      evidence: predictionSummary(confirmed.prediction),
      // D3: deep-link the confirmed root cause to the query that confirmed it.
      provenance: provenanceForPrediction(confirmed.prediction, evidence),
    });
  }
  return chain;
}

/**
 * One-line run trace for the footer/report (increment 6, spec §8): e.g.
 * "12 moves · 5 queries · 2 subagents · confirmed at depth 1". Lead with the
 * work done, end with how it stopped.
 */
export function traceSummary(stats: OrchestratorResult["stats"], outcome: OrchestratorResult["outcome"]): string {
  const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
  const parts = [plural(stats.moves, "move", "moves"), plural(stats.toolCalls, "query", "queries")];
  if (stats.subagents > 0) parts.push(plural(stats.subagents, "subagent", "subagents"));
  const ending = outcome === "confirmed" ? `confirmed at depth ${stats.depth}` : `${outcome} at depth ${stats.depth}`;
  return `${parts.join(" · ")} · ${ending}`;
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
      // `absent` is NOT a rule-out — it means no evidence was gathered either way
      // (data source unavailable / nothing matched). Surface it as "couldn't
      // verify" so a true cause isn't falsely reported as refuted.
      if (e.verdict === "absent") {
        return { verb: "couldn't verify", target: e.detail, detail: "(no evidence gathered)", status: "inconclusive" };
      }
      return {
        verb: "ruled out",
        target: e.detail,
        detail: "(evidence contradicts it)",
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

    case "decide":
      // The decide-move watchdog tripped (a starved/hung brain) — surface it so the
      // stall is visible rather than a silent gap, then the loop re-checks guards.
      return { verb: "thinking timed out", detail: "(starved — re-checking limits)", status: "inconclusive" };
  }
}
