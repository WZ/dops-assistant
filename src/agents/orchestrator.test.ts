import { describe, it, expect } from "vitest";
import { runOrchestrator, MAX_OPERATOR_CONTINUES } from "./orchestrator.js";
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

describe("runOrchestrator — Follow a lead (initialLead seeds the run)", () => {
  it("seeds operatorContext from the launch lead, trimmed, on move 1", async () => {
    const seen: Array<string | undefined> = [];
    await runOrchestrator(
      makeDeps({
        initialLead: "  check the connection pool  ",
        decideMove: async (state) => { seen.push(state.operatorContext); return null; },
      }),
    );
    // the lead is the standing guidance on the very first decide-move call
    expect(seen[0]).toBe("check the connection pool");
  });

  it("no lead → operatorContext undefined (a blind hunt, as before)", async () => {
    const seen: Array<string | undefined> = [];
    await runOrchestrator(makeDeps({ decideMove: async (state) => { seen.push(state.operatorContext); return null; } }));
    expect(seen[0]).toBeUndefined();
  });

  it("a blank lead is treated as absent (no seeding)", async () => {
    const seen: Array<string | undefined> = [];
    await runOrchestrator(makeDeps({ initialLead: "   ", decideMove: async (state) => { seen.push(state.operatorContext); return null; } }));
    expect(seen[0]).toBeUndefined();
  });
});

describe("runOrchestrator — decide-move watchdog (inc-7 starvation)", () => {
  it("a stalled/hung decide-move times out and the run stops loudly (inconclusive), not a silent hang", async () => {
    const streamedMoves: string[] = [];
    const result = await runOrchestrator(
      makeDeps({
        // Never resolves — models a starved/hung brain under contention.
        decideMove: () => new Promise<never>(() => {}),
        guards: { ...generousGuards, opTimeoutMs: 5 },
        onStep: (entry) => { streamedMoves.push(entry.move); },
      }),
    );
    // Repeated decide timeouts increment stall → inconclusive (the loud stop),
    // instead of hanging inside an unbounded await until the client cap.
    expect(result.outcome).toBe("inconclusive");
    expect(result.trace.some((entry) => entry.move === "decide" && entry.detail.includes("timed out"))).toBe(true);
    expect(streamedMoves).toContain("decide");
  });
});

describe("runOrchestrator — fast no-evidence bail (inc-7 idle services)", () => {
  it("bails to inconclusive after a few queries gather zero evidence — doesn't burn the full run", async () => {
    const result = await runOrchestrator(
      makeDeps({
        gatherEvidence: async () => [], // quiet/idle service — nothing surfaces anywhere
        decideMove: scripted([
          { type: "hypothesize", hypothesis: h("c1") },
          { type: "query", target: 0 },
          { type: "query", target: 0 },
          { type: "query", target: 0 },
          { type: "query", target: 0 },
          { type: "query", target: 0 }, // would keep going, but the bail fires first
          { type: "query", target: 0 },
        ]),
      }),
    );
    expect(result.outcome).toBe("inconclusive");
    // Bailed at NO_EVIDENCE_BAIL_QUERIES (4), before MAX_STALL (8) or the scripted
    // queries ran out — the run stops fast instead of burning tokens.
    expect(result.stats.toolCalls).toBe(4);
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

  it("an ABSENT verdict marks the hypothesis inconclusive, NOT ruled-out (absence ≠ refutation)", async () => {
    const result = await runOrchestrator(
      makeDeps({
        decideMove: scripted([
          { type: "hypothesize", hypothesis: h("0 desired replicas") },
          { type: "query", target: 0 },
          { type: "test", target: 0 },
          null,
        ]),
        evaluate: () => "absent", // no evidence gathered either way
      }),
    );
    // The cause may still be real — it was never refuted, just unverifiable.
    expect(result.hypotheses[0].standing).toBe("inconclusive");
    expect(result.hypotheses[0].standing).not.toBe("ruled-out");
    expect(result.hypotheses[0].lastVerdict).toBe("absent");
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

describe("runOrchestrator — PR-4 continue-with-context", () => {
  type Resolution = { decision: "continue" | "escalate" | "wait"; context?: string };
  // Generative deps: emit hypothesize/test alternately; every test fails so strikes
  // accumulate to maxStrikes (3) → pause. Each decideMove records the operatorContext
  // visible on its state. onOperatorPause replays a scripted list of resolutions
  // (default escalate once the list is exhausted, ending the run).
  function genDeps(resolutions: Resolution[], seen: (string | undefined)[]) {
    let toggle = 0;
    let hi = 0;
    let p = 0;
    return makeDeps({
      guards: { ...generousGuards, maxStrikes: 3 },
      decideMove: async (state) => {
        seen.push(state.operatorContext);
        if (toggle++ % 2 === 0) return { type: "hypothesize", hypothesis: h(`c${hi}`) };
        return { type: "test", target: hi++ };
      },
      evaluate: () => "absent",
      onOperatorPause: async () => resolutions[p++] ?? { decision: "escalate" },
    });
  }

  it("a continue-with-context sets operatorContext on the resumed decide-move state", async () => {
    const seen: (string | undefined)[] = [];
    const res = await runOrchestrator(genDeps([{ decision: "continue", context: "check the DB pool" }], seen));
    expect(res.outcome).toBe("operator-pause"); // 2nd pause → default escalate
    // 6 moves (3 hypothesize + 3 failed tests) run before the first pause, all blind…
    expect(seen.slice(0, 6).every((c) => c === undefined)).toBe(true);
    // …and every move after the continue carries the operator's lead.
    expect(seen.slice(6).length).toBeGreaterThan(0);
    expect(seen.slice(6).every((c) => c === "check the DB pool")).toBe(true);
  });

  it("a continue WITHOUT a new lead keeps the prior one (standing-until-replaced)", async () => {
    const seen: (string | undefined)[] = [];
    await runOrchestrator(genDeps([{ decision: "continue", context: "lead A" }, { decision: "continue" }], seen));
    expect(seen[seen.length - 1]).toBe("lead A");
  });

  it("a later lead replaces the earlier one", async () => {
    const seen: (string | undefined)[] = [];
    await runOrchestrator(genDeps([{ decision: "continue", context: "lead A" }, { decision: "continue", context: "lead B" }], seen));
    expect(seen).toContain("lead A");
    expect(seen[seen.length - 1]).toBe("lead B");
    expect(seen.indexOf("lead B")).toBeGreaterThan(seen.lastIndexOf("lead A"));
  });

  it("REGRESSION: plain continue (no lead ever) leaves operatorContext undefined", async () => {
    const seen: (string | undefined)[] = [];
    const res = await runOrchestrator(genDeps([{ decision: "continue" }], seen));
    expect(res.outcome).toBe("operator-pause");
    expect(seen.every((c) => c === undefined)).toBe(true);
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

  it("follow-cause investigates a known dependency and folds findings in", async () => {
    const finding: NormalizedObservation = { phase: "infra", subject: "payments", text: "pg pool saturated" };
    const result = await runOrchestrator(
      makeDeps({
        dependencies: ["payments", "db"],
        spawnSubagent: async () => [finding],
        decideMove: scripted([{ type: "follow-cause", service: "payments" }, null]),
      }),
    );
    expect(result.stats.subagents).toBe(1);
    expect(result.evidence).toContainEqual(finding);
    expect(result.trace[0].detail).toContain("payments → +1 findings");
  });

  it("follow-cause rejects a service that is not a known dependency", async () => {
    const result = await runOrchestrator(
      makeDeps({
        dependencies: ["payments"],
        spawnSubagent: async () => [{ phase: "infra", subject: "x", text: "y" }],
        decideMove: scripted([{ type: "follow-cause", service: "unrelated" }, null]),
      }),
    );
    expect(result.stats.subagents).toBe(0);
    expect(result.trace[0].detail).toContain("not a known dependency");
  });

  it("follow-cause is disabled when there is no dependency graph", async () => {
    const result = await runOrchestrator(
      makeDeps({
        dependencies: [],
        spawnSubagent: async () => [{ phase: "infra", subject: "x", text: "y" }],
        decideMove: scripted([{ type: "follow-cause", service: "payments" }, null]),
      }),
    );
    expect(result.stats.subagents).toBe(0);
    expect(result.trace[0].detail).toContain("no dependency graph");
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

describe("runOrchestrator — interactive operator-pause hook", () => {
  /** A decide-fn that never stops failing: hypothesize, then test the newest
   *  hypothesis, forever. With `evaluate: absent` every test is a strike, so
   *  strikes accumulate until a guard (or the operator hook) ends the run. */
  function endlessFailing(): OrchestratorDeps["decideMove"] {
    let n = 0;
    return async (state: OrchestratorState) =>
      n++ % 2 === 0
        ? { type: "hypothesize", hypothesis: h(`c${n}`) }
        : { type: "test", target: state.hypotheses.length - 1 };
  }

  it("continue resets strikes and resumes; a later escalate/wait stops with operator-pause", async () => {
    const decisions: Array<"continue" | "escalate" | "wait"> = ["continue", "wait"];
    let calls = 0;
    const result = await runOrchestrator(
      makeDeps({
        guards: { ...generousGuards, maxStrikes: 2 },
        evaluate: () => "absent",
        decideMove: endlessFailing(),
        onOperatorPause: async () => ({ decision: decisions[calls++] ?? "wait" }),
      }),
    );
    expect(result.outcome).toBe("operator-pause");
    // First pause → continue (resumed), second pause → wait (stopped).
    expect(calls).toBe(2);
  });

  it("escalate stops immediately at the first strike limit", async () => {
    let calls = 0;
    const result = await runOrchestrator(
      makeDeps({
        guards: { ...generousGuards, maxStrikes: 2 },
        evaluate: () => "absent",
        decideMove: endlessFailing(),
        onOperatorPause: async () => { calls++; return { decision: "escalate" }; },
      }),
    );
    expect(result.outcome).toBe("operator-pause");
    expect(calls).toBe(1); // consulted once, then stopped
  });

  it("no hook → strike limit stops directly (unchanged behavior)", async () => {
    let paused = false;
    const result = await runOrchestrator(
      makeDeps({
        guards: { ...generousGuards, maxStrikes: 2 },
        evaluate: () => "absent",
        decideMove: endlessFailing(),
        // onOperatorPause intentionally omitted
      }),
    );
    expect(paused).toBe(false);
    expect(result.outcome).toBe("operator-pause");
  });

  it("caps operator continues so a perpetually-continuing operator can't spin forever", async () => {
    let calls = 0;
    const result = await runOrchestrator(
      makeDeps({
        guards: { ...generousGuards, maxStrikes: 2 },
        evaluate: () => "absent",
        decideMove: endlessFailing(),
        onOperatorPause: async () => { calls++; return { decision: "continue" }; },
      }),
    );
    expect(result.outcome).toBe("operator-pause");
    // Consulted exactly MAX_OPERATOR_CONTINUES times, then stops without asking again.
    expect(calls).toBe(MAX_OPERATOR_CONTINUES);
  });
});

describe("runOrchestrator — cross-service confirm guard", () => {
  it("rejects a confirm that blames an un-followed dependency (correlational, not established)", async () => {
    const result = await runOrchestrator(
      makeDeps({
        dependencies: ["payments"],
        incidentService: "checkout",
        evaluate: () => "satisfied",
        decideMove: scripted([
          { type: "hypothesize", hypothesis: h("checkout failing due to degraded payments service") },
          { type: "query", target: 0 },
          { type: "test", target: 0 },
          { type: "conclude", leading: 0, confidence: 0.9, rationale: "payments slow" },
          null,
        ]),
      }),
    );
    expect(result.outcome).toBe("exhausted"); // confirm was blocked → ran to null
    expect(result.confirmed).toBeUndefined();
    expect(result.trace.some((t) => t.move === "conclude" && /never followed-cause/.test(t.detail))).toBe(true);
  });

  it("rejects a confirm blaming a known service even with an EMPTY dep graph (inc-7 #3 false-confirm)", async () => {
    // The inc-7 no-go: a 0-replica service "confirmed" as caused by a degraded
    // dependency with 0 follow-cause. With no dep-graph edge, the old guard (deps
    // only) couldn't catch it. knownServices closes that gap.
    const result = await runOrchestrator(
      makeDeps({
        dependencies: [], // no dependency graph available
        incidentService: "agw-admin-ui",
        knownServices: ["agw-admin-ui", "payment-service"],
        evaluate: () => "satisfied",
        decideMove: scripted([
          { type: "hypothesize", hypothesis: h("agw-admin-ui unavailable due to degraded payment-service") },
          { type: "query", target: 0 },
          { type: "test", target: 0 },
          { type: "conclude", leading: 0, confidence: 0.95, rationale: "payment-service metric high" },
          null,
        ]),
      }),
    );
    expect(result.outcome).toBe("exhausted"); // confirm blocked — payment-service never followed
    expect(result.confirmed).toBeUndefined();
    expect(result.trace.some((t) => t.move === "conclude" && /payment-service.*never followed-cause/.test(t.detail))).toBe(true);
  });

  it("allows the confirm once the implicated dependency was followed", async () => {
    const result = await runOrchestrator(
      makeDeps({
        dependencies: ["payments"],
        incidentService: "checkout",
        spawnSubagent: async () => [{ phase: "infra", subject: "payments", text: "pool saturated" }],
        evaluate: () => "satisfied",
        decideMove: scripted([
          { type: "follow-cause", service: "payments" },
          { type: "hypothesize", hypothesis: h("checkout failing due to degraded payments service") },
          { type: "query", target: 0 },
          { type: "test", target: 0 },
          { type: "conclude", leading: 0, confidence: 0.9, rationale: "payments pool saturated" },
        ]),
      }),
    );
    expect(result.outcome).toBe("confirmed");
    expect(result.confirmed?.hypothesis).toContain("payments");
  });

  it("does not block a cause about the incident service's own behavior", async () => {
    const result = await runOrchestrator(
      makeDeps({
        dependencies: ["payments"],
        incidentService: "checkout",
        evaluate: () => "satisfied",
        decideMove: scripted([
          { type: "hypothesize", hypothesis: h("checkout pod OOMKilled under load") },
          { type: "query", target: 0 },
          { type: "test", target: 0 },
          { type: "conclude", leading: 0, confidence: 0.9, rationale: "checkout OOM" },
        ]),
      }),
    );
    expect(result.outcome).toBe("confirmed");
  });

  it("is inert when there are no dependencies", async () => {
    const result = await runOrchestrator(
      makeDeps({
        evaluate: () => "satisfied",
        decideMove: scripted([
          { type: "hypothesize", hypothesis: h("anything at all") },
          { type: "query", target: 0 },
          { type: "test", target: 0 },
          { type: "conclude", leading: 0, confidence: 0.9, rationale: "" },
        ]),
      }),
    );
    expect(result.outcome).toBe("confirmed");
  });
});

describe("runOrchestrator — abort signal + per-op watchdog", () => {
  it("returns 'aborted' immediately when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await runOrchestrator(
      makeDeps({
        signal: ac.signal,
        decideMove: scripted([{ type: "hypothesize", hypothesis: h("x") }]),
      }),
    );
    expect(result.outcome).toBe("aborted");
    expect(result.stats.moves).toBe(0); // bailed before spending a move
  });

  it("aborts cooperatively when the signal fires mid-run", async () => {
    const ac = new AbortController();
    let n = 0;
    const result = await runOrchestrator(
      makeDeps({
        signal: ac.signal,
        decideMove: async () => {
          if (n++ === 1) ac.abort(); // fire after the 2nd decision
          return { type: "hypothesize", hypothesis: h(`c${n}`) };
        },
      }),
    );
    expect(result.outcome).toBe("aborted");
  });

  it("per-op watchdog abandons a hung gather and keeps the loop alive", async () => {
    const result = await runOrchestrator(
      makeDeps({
        guards: { ...generousGuards, opTimeoutMs: 20 },
        gatherEvidence: () => new Promise(() => {}), // never resolves
        decideMove: scripted([
          { type: "hypothesize", hypothesis: h("x") },
          { type: "query", target: 0 },
          null,
        ]),
      }),
    );
    expect(result.outcome).toBe("exhausted"); // didn't hang — ran to the null
    expect(result.stats.toolCalls).toBe(1); // the attempt was counted
    expect(result.trace.find((t) => t.move === "query")?.detail).toContain("timed out");
  });

  it("per-op watchdog bounds a hung subagent too", async () => {
    const result = await runOrchestrator(
      makeDeps({
        guards: { ...generousGuards, opTimeoutMs: 20 },
        spawnSubagent: () => new Promise(() => {}), // never resolves
        decideMove: scripted([{ type: "spawn-subagent", service: "x", question: "q" }, null]),
      }),
    );
    expect(result.outcome).toBe("exhausted");
    expect(result.stats.subagents).toBe(1);
    expect(result.trace[0].detail).toContain("timed out");
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

describe("runOrchestrator — onMoveBoundary park hook (PR-2c)", () => {
  const confirmRun = (): OrchestratorMove[] => [
    { type: "hypothesize", hypothesis: h("x") },
    { type: "query", target: 0 },
    { type: "test", target: 0 },
    { type: "conclude", leading: 0, confidence: 0.7, rationale: "ok" },
  ];

  it("is awaited at every move boundary", async () => {
    let calls = 0;
    await runOrchestrator(makeDeps({
      onMoveBoundary: () => { calls++; },
      decideMove: scripted(confirmRun()),
    }));
    // one boundary per loop iteration (≥ the number of moves taken)
    expect(calls).toBeGreaterThanOrEqual(4);
  });

  it("a blocking boundary defers the run until it resolves (park → reattach)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let done = false;
    const p = runOrchestrator(makeDeps({
      onMoveBoundary: () => gate, // block at the first boundary
      decideMove: scripted(confirmRun()),
    })).then((r) => { done = true; return r; });

    // Give the loop a few ticks to reach the boundary; it must NOT have finished.
    await new Promise((r) => setTimeout(r, 5));
    expect(done).toBe(false);

    release(); // a reattach resolves the park
    const result = await p;
    expect(done).toBe(true);
    expect(result.outcome).toBe("confirmed");
  });

  it("an abort during the boundary stops the run as aborted", async () => {
    const ac = new AbortController();
    const result = await runOrchestrator(makeDeps({
      signal: ac.signal,
      onMoveBoundary: () => { ac.abort(); }, // Stop while parked
      decideMove: scripted(confirmRun()),
    }));
    expect(result.outcome).toBe("aborted");
  });
});
