import { describe, it, expect } from "vitest";
import { runOrchestrator } from "./orchestrator.js";
import type { OrchestratorMove, OrchestratorDeps, OrchestratorState } from "./orchestrator.js";
import type { RankedHypothesis } from "../types/rca-types.js";
import type { NormalizedObservation, Verdict } from "../workflows/steps/corroboration.js";

const h = (name: string): RankedHypothesis => ({
  hypothesis: name,
  prediction: { kind: "metric-threshold", metric: "mem", op: ">", value: 90 },
});

const obs: NormalizedObservation = { phase: "metrics", subject: "mem", value: 99 };

const generousGuards = {
  maxTokens: 1e9,
  maxDepth: 3,
  maxSubagents: 3,
  maxStrikes: 3,
  maxToolCalls: 100,
  wallClockMs: 1e9,
};

/** Scripted decide-fn: replay a fixed move sequence, then signal exhausted. */
function scripted(moves: Array<OrchestratorMove | null>): OrchestratorDeps["decideMove"] {
  let i = 0;
  return async () => (i < moves.length ? moves[i++] : null);
}

/** Build deps with sensible test defaults; override per case. */
function makeDeps(over: Partial<OrchestratorDeps> & Pick<OrchestratorDeps, "decideMove">): OrchestratorDeps {
  return {
    gatherEvidence: async () => [obs],
    evaluate: () => "satisfied",
    guards: generousGuards,
    ...over,
  };
}

describe("runOrchestrator — happy path", () => {
  it("hypothesize → query → test(satisfied) → conclude → confirmed", async () => {
    const result = await runOrchestrator(
      makeDeps({
        decideMove: scripted([
          { type: "hypothesize", hypothesis: h("memory exhaustion") },
          { type: "query", target: 0 },
          { type: "test", target: 0 },
          { type: "conclude", leading: 0, confidence: 0.9, rationale: "mem > 90" },
        ]),
        evaluate: () => "satisfied",
      }),
    );
    expect(result.outcome).toBe("confirmed");
    expect(result.confirmed?.hypothesis).toBe("memory exhaustion");
    expect(result.hypotheses[0].standing).toBe("confirmed");
    expect(result.stats.toolCalls).toBe(1);
    expect(result.evidence).toHaveLength(1);
  });
});

describe("runOrchestrator — DECISION 1: hybrid stop never trusts self-confidence", () => {
  it("rejects conclude when the leading hypothesis was never keystone-confirmed", async () => {
    const result = await runOrchestrator(
      makeDeps({
        // Propose conclude at confidence 0.99 on an UNTESTED hypothesis, then stop.
        decideMove: scripted([
          { type: "hypothesize", hypothesis: h("a guess") },
          { type: "conclude", leading: 0, confidence: 0.99, rationale: "I'm sure" },
          null,
        ]),
      }),
    );
    expect(result.outcome).toBe("exhausted");
    expect(result.confirmed).toBeUndefined();
    expect(result.trace.some((t) => t.move === "conclude" && t.detail.includes("rejected"))).toBe(true);
  });

  it("rejects conclude when the keystone verdict is 'contradicted' despite high confidence", async () => {
    const result = await runOrchestrator(
      makeDeps({
        decideMove: scripted([
          { type: "hypothesize", hypothesis: h("wrong cause") },
          { type: "query", target: 0 },
          { type: "test", target: 0 },
          { type: "conclude", leading: 0, confidence: 0.95, rationale: "looks right" },
          null,
        ]),
        evaluate: () => "contradicted",
      }),
    );
    expect(result.outcome).toBe("exhausted");
    expect(result.confirmed).toBeUndefined();
    expect(result.hypotheses[0].standing).toBe("ruled-out");
  });
});

describe("runOrchestrator — DECISION 2: safety harness", () => {
  it("strikes limit → operator-pause (not a silent stop)", async () => {
    const result = await runOrchestrator(
      makeDeps({
        guards: { ...generousGuards, maxStrikes: 3 },
        decideMove: scripted([
          { type: "hypothesize", hypothesis: h("c1") },
          { type: "test", target: 0 },
          { type: "hypothesize", hypothesis: h("c2") },
          { type: "test", target: 1 },
          { type: "hypothesize", hypothesis: h("c3") },
          { type: "test", target: 2 },
        ]),
        evaluate: () => "absent", // every test fails → strikes accumulate
      }),
    );
    expect(result.outcome).toBe("operator-pause");
    expect(result.stats.strikes).toBe(3);
  });

  it("a satisfied test resets the strike counter", async () => {
    const verdicts: Verdict[] = ["absent", "absent", "satisfied"];
    let i = 0;
    const result = await runOrchestrator(
      makeDeps({
        guards: { ...generousGuards, maxStrikes: 3 },
        decideMove: scripted([
          { type: "hypothesize", hypothesis: h("c1") },
          { type: "test", target: 0 },
          { type: "hypothesize", hypothesis: h("c2") },
          { type: "test", target: 1 },
          { type: "hypothesize", hypothesis: h("c3") },
          { type: "test", target: 2 },
          { type: "conclude", leading: 2, confidence: 0.8, rationale: "" },
        ]),
        evaluate: () => verdicts[i++] ?? "absent",
      }),
    );
    // 2 strikes then a satisfied (resets to 0) then confirmed conclude.
    expect(result.outcome).toBe("confirmed");
    expect(result.stats.strikes).toBe(0);
  });

  it("token budget exhaustion → budget-exhausted", async () => {
    const result = await runOrchestrator(
      makeDeps({
        guards: { ...generousGuards, maxTokens: 10 },
        estimateTokens: () => 4,
        decideMove: async () => ({ type: "hypothesize", hypothesis: h("loop") }),
      }),
    );
    expect(result.outcome).toBe("budget-exhausted");
    expect(result.stats.tokensSpent).toBeGreaterThanOrEqual(10);
  });

  it("tool-call cap → tool-cap", async () => {
    let first = true;
    const result = await runOrchestrator(
      makeDeps({
        guards: { ...generousGuards, maxToolCalls: 2 },
        decideMove: async (): Promise<OrchestratorMove> => {
          if (first) {
            first = false;
            return { type: "hypothesize", hypothesis: h("x") };
          }
          return { type: "query", target: 0 };
        },
      }),
    );
    expect(result.outcome).toBe("tool-cap");
    expect(result.stats.toolCalls).toBe(2);
  });

  it("wall-clock budget → wall-clock", async () => {
    let clock = 0;
    const result = await runOrchestrator(
      makeDeps({
        guards: { ...generousGuards, wallClockMs: 1000 },
        now: () => clock,
        decideMove: async () => {
          clock += 500; // each move advances the injected clock
          return { type: "hypothesize", hypothesis: h("tick") };
        },
      }),
    );
    expect(result.outcome).toBe("wall-clock");
  });
});

describe("runOrchestrator — robustness", () => {
  it("decideMove returning null immediately → exhausted", async () => {
    const result = await runOrchestrator(makeDeps({ decideMove: async () => null }));
    expect(result.outcome).toBe("exhausted");
    expect(result.hypotheses).toHaveLength(0);
  });

  it("out-of-range move target is traced and skipped, never throws", async () => {
    const result = await runOrchestrator(
      makeDeps({
        decideMove: scripted([
          { type: "query", target: 5 },
          { type: "test", target: 9 },
          null,
        ]),
      }),
    );
    expect(result.outcome).toBe("exhausted");
    expect(result.trace.filter((t) => t.detail.includes("no hypothesis"))).toHaveLength(2);
  });

  it("a decide-fn that only spins on rejected conclude bails to inconclusive (no infinite loop)", async () => {
    const result = await runOrchestrator(
      makeDeps({
        decideMove: async () => ({ type: "conclude", leading: 0, confidence: 1, rationale: "spin" }),
      }),
    );
    expect(result.outcome).toBe("inconclusive");
    expect(result.stats.moves).toBeLessThan(50); // stalled out well before the hard backstop
  });

  it("spawn-subagent folds findings into evidence and counts the subagent", async () => {
    const finding: NormalizedObservation = { phase: "metrics", subject: "payments_p99", value: 8 };
    const result = await runOrchestrator(
      makeDeps({
        spawnSubagent: async () => [finding],
        decideMove: scripted([
          { type: "spawn-subagent", service: "payments", question: "why slow?" },
          null,
        ]),
      }),
    );
    expect(result.outcome).toBe("exhausted");
    expect(result.stats.subagents).toBe(1);
    expect(result.evidence).toContainEqual(finding);
    expect(result.trace[0].detail).toContain("+1 findings");
  });

  it("spawn-subagent skips gracefully when no subagent dep is wired", async () => {
    const result = await runOrchestrator(
      makeDeps({
        decideMove: scripted([{ type: "spawn-subagent", service: "x", question: "q" }, null]),
      }),
    );
    expect(result.stats.subagents).toBe(0);
    expect(result.trace[0].detail).toContain("unavailable");
  });

  it("enforces the maxSubagents limit", async () => {
    let spawns = 0;
    const result = await runOrchestrator(
      makeDeps({
        guards: { ...generousGuards, maxSubagents: 2 },
        spawnSubagent: async () => {
          spawns++;
          return [{ phase: "infra", subject: "x", text: "y" }];
        },
        decideMove: scripted([
          { type: "spawn-subagent", service: "a", question: "q" },
          { type: "spawn-subagent", service: "b", question: "q" },
          { type: "spawn-subagent", service: "c", question: "q" },
          null,
        ]),
      }),
    );
    expect(spawns).toBe(2); // third refused
    expect(result.stats.subagents).toBe(2);
    expect(result.trace[2].detail).toContain("limit");
  });

  it("follow-cause still no-ops with a trace entry in v1", async () => {
    const result = await runOrchestrator(
      makeDeps({ decideMove: scripted([{ type: "follow-cause", service: "payments" }, null]) }),
    );
    expect(result.outcome).toBe("exhausted");
    expect(result.trace[0].move).toBe("follow-cause");
    expect(result.trace[0].detail).toContain("deferred");
  });

  it("onStep receives every recorded trace entry", async () => {
    const seen: string[] = [];
    await runOrchestrator(
      makeDeps({
        onStep: (e) => seen.push(e.move),
        decideMove: scripted([
          { type: "hypothesize", hypothesis: h("x") },
          { type: "query", target: 0 },
          { type: "test", target: 0 },
          { type: "conclude", leading: 0, confidence: 0.7, rationale: "" },
        ]),
      }),
    );
    expect(seen).toEqual(["hypothesize", "query", "test", "conclude"]);
  });
});

describe("runOrchestrator — integration with the real keystone", () => {
  it("uses evaluatePrediction verdicts to drive the confirm gate", async () => {
    // Wire the REAL keystone so the loop's confirm decision is deterministic
    // against actual observations, not a fake verdict.
    const { evaluatePrediction } = await import("../workflows/steps/corroboration.js");
    const result = await runOrchestrator(
      makeDeps({
        evaluate: (prediction, evidence) => evaluatePrediction(prediction, evidence),
        gatherEvidence: async () => [{ phase: "metrics", subject: "mem", value: 99 }],
        decideMove: scripted([
          { type: "hypothesize", hypothesis: h("memory exhaustion") },
          { type: "query", target: 0 },
          { type: "test", target: 0 },
          { type: "conclude", leading: 0, confidence: 0.6, rationale: "mem 99 > 90" },
        ]),
      }),
    );
    expect(result.outcome).toBe("confirmed");
  });
});
