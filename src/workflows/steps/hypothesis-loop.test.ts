import { describe, it, expect, vi } from "vitest";
import { runHypothesisLoop } from "./hypothesis-loop.js";
import type { RankedHypothesis, NormalizedObservation } from "./corroboration.js";

const backpressure: RankedHypothesis = {
  hypothesis: "payments backpressure",
  prediction: { kind: "metric-threshold", metric: "payments p99", op: ">", value: 5 },
};
const leak: RankedHypothesis = {
  hypothesis: "memory leak",
  prediction: { kind: "log-pattern", pattern: "leak", present: true },
};
const trafficSpike: RankedHypothesis = {
  hypothesis: "traffic spike",
  prediction: { kind: "metric-threshold", metric: "request rate", op: ">", value: 500 },
};

describe("runHypothesisLoop", () => {
  it("confirms the leader on round 1 when evidence discriminates", async () => {
    const initial: NormalizedObservation[] = [
      { phase: "metrics", subject: "payments p99 latency", value: 8 },
      { phase: "metrics", subject: "request rate", value: 100 },
    ];
    const gather = vi.fn().mockResolvedValue([]);
    const r = await runHypothesisLoop({
      hypotheses: [backpressure, trafficSpike],
      maxRounds: 3,
      initialObservations: initial,
      gatherEvidence: gather,
    });
    expect(r.outcome).toBe("confirmed");
    expect(r.confirmedHypothesis?.hypothesis).toBe("payments backpressure");
    expect(r.rounds).toHaveLength(1);
    expect(gather).toHaveBeenCalledTimes(1);
  });

  it("rules out a weak leader, then confirms the next hypothesis", async () => {
    // Leader = leak (no leak logs → weakened); runner-up = backpressure (confirmed).
    const initial: NormalizedObservation[] = [
      { phase: "logs", subject: "request ok", text: "200" },
      { phase: "metrics", subject: "payments p99 latency", value: 8 },
      { phase: "metrics", subject: "request rate", value: 100 },
    ];
    const gather = vi.fn().mockResolvedValue([]);
    const r = await runHypothesisLoop({
      hypotheses: [leak, backpressure, trafficSpike],
      maxRounds: 3,
      initialObservations: initial,
      gatherEvidence: gather,
    });
    expect(r.outcome).toBe("confirmed");
    expect(r.confirmedHypothesis?.hypothesis).toBe("payments backpressure");
    expect(r.ruledOut.map((x) => x.hypothesis)).toEqual(["memory leak"]);
    expect(r.rounds).toHaveLength(2);
  });

  it("stops at 'undetermined' on a correlational tie (never false-confirms)", async () => {
    const initial: NormalizedObservation[] = [
      { phase: "metrics", subject: "payments p99 latency", value: 8 },
      { phase: "changes", subject: "deploy v2.3.1", timestamp: "2026-04-02T13:58:00Z" },
    ];
    const deploy: RankedHypothesis = {
      hypothesis: "the deploy caused it",
      prediction: { kind: "change-in-window", withinMinutesBefore: 30 },
    };
    const r = await runHypothesisLoop({
      hypotheses: [backpressure, deploy],
      maxRounds: 3,
      initialObservations: initial,
      gatherEvidence: vi.fn().mockResolvedValue([]),
      ctx: { incidentTime: "2026-04-02T14:00:00Z" },
    });
    expect(r.outcome).toBe("undetermined");
    expect(r.confirmedHypothesis).toBeUndefined();
  });

  it("incorporates evidence gathered mid-loop (the re-query test step)", async () => {
    // Initial evidence doesn't confirm; the round-1 re-query supplies the
    // discriminating metric.
    const gather = vi.fn().mockResolvedValue([
      { phase: "metrics", subject: "payments p99 latency", value: 8 } as NormalizedObservation,
    ]);
    const r = await runHypothesisLoop({
      hypotheses: [backpressure],
      maxRounds: 3,
      initialObservations: [],
      gatherEvidence: gather,
    });
    expect(r.outcome).toBe("confirmed");
    expect(r.observations.some((o) => o.subject.includes("payments"))).toBe(true);
  });

  it("returns 'exhausted' when no hypothesis is confirmed within the round budget", async () => {
    const initial: NormalizedObservation[] = [{ phase: "metrics", subject: "cpu", value: 10 }];
    const r = await runHypothesisLoop({
      hypotheses: [leak, backpressure, trafficSpike],
      maxRounds: 3,
      initialObservations: initial,
      gatherEvidence: vi.fn().mockResolvedValue([]),
    });
    expect(r.outcome).toBe("exhausted");
    expect(r.confirmedHypothesis).toBeUndefined();
    // leak weakened (no logs → absent → weakened); the metric hypotheses are
    // absent too. All ruled out or untested within budget.
    expect(r.rounds.length).toBeLessThanOrEqual(3);
  });

  it("maxRounds<=1 still runs exactly one assessment (single-pass)", async () => {
    const gather = vi.fn().mockResolvedValue([]);
    const r = await runHypothesisLoop({
      hypotheses: [backpressure],
      maxRounds: 1,
      initialObservations: [{ phase: "metrics", subject: "payments p99", value: 8 }],
      gatherEvidence: gather,
    });
    expect(r.rounds).toHaveLength(1);
    expect(gather).toHaveBeenCalledTimes(1);
    expect(r.outcome).toBe("confirmed");
  });
});
