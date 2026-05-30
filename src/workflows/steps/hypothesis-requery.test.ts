import { describe, it, expect, vi } from "vitest";
import {
  planPredictionQuery,
  createGatherEvidence,
  type PredictionQueryPlan,
} from "./hypothesis-requery.js";
import type { RankedHypothesis, NormalizedObservation } from "./corroboration.js";

const hyp = (prediction: RankedHypothesis["prediction"]): RankedHypothesis => ({
  hypothesis: "test hypothesis",
  prediction,
});

describe("planPredictionQuery", () => {
  it("maps metric-threshold to the metrics role and names the metric + threshold", () => {
    const plan = planPredictionQuery(
      hyp({ kind: "metric-threshold", metric: "http_p99", op: ">", value: 5 }),
      { from: "T1", to: "T2" },
    );
    expect(plan).not.toBeNull();
    expect(plan!.role).toBe("metrics");
    expect(plan!.phase).toBe("metrics");
    expect(plan!.prompt).toContain("http_p99");
    expect(plan!.prompt).toContain("> 5");
    expect(plan!.prompt).toContain("T1");
    expect(plan!.prompt).toContain("T2");
  });

  it("maps log-pattern to the logs role and reflects present/absent", () => {
    const present = planPredictionQuery(hyp({ kind: "log-pattern", pattern: "OOMKilled" }));
    expect(present!.role).toBe("logs");
    expect(present!.phase).toBe("logs");
    expect(present!.prompt).toContain("OOMKilled");
    expect(present!.prompt).toContain("PRESENT");

    const absent = planPredictionQuery(hyp({ kind: "log-pattern", pattern: "OOMKilled", present: false }));
    expect(absent!.prompt).toContain("ABSENT");
  });

  it("maps infra-status to the infrastructure role", () => {
    const plan = planPredictionQuery(hyp({ kind: "infra-status", resource: "checkout-api", status: "CrashLoopBackOff" }));
    expect(plan!.role).toBe("infrastructure");
    expect(plan!.phase).toBe("infra");
    expect(plan!.prompt).toContain("checkout-api");
    expect(plan!.prompt).toContain("CrashLoopBackOff");
  });

  it("maps change-in-window to the changes role and includes incident onset", () => {
    const plan = planPredictionQuery(
      hyp({ kind: "change-in-window", withinMinutesBefore: 30 }),
      undefined,
      { incidentTime: "2026-05-30T10:00:00Z" },
    );
    expect(plan!.role).toBe("changes");
    expect(plan!.phase).toBe("changes");
    expect(plan!.prompt).toContain("30 minutes");
    expect(plan!.prompt).toContain("2026-05-30T10:00:00Z");
  });

  it("omits the window line when no time range is given", () => {
    const plan = planPredictionQuery(hyp({ kind: "metric-threshold", metric: "m", op: "<", value: 1 }));
    expect(plan!.prompt).not.toContain("Incident window:");
  });

  it("returns null for an unrecognized prediction kind", () => {
    const plan = planPredictionQuery(hyp({ kind: "bogus" } as any));
    expect(plan).toBeNull();
  });
});

describe("createGatherEvidence", () => {
  const baseOpts = { providers: [], model: {} as any };

  it("routes the planned query through runRoleQuery and returns its observations", async () => {
    const observations: NormalizedObservation[] = [
      { phase: "metrics", subject: "http_p99", value: 8 },
    ];
    const runRoleQuery = vi.fn(async (plan: PredictionQueryPlan) => {
      expect(plan.role).toBe("metrics");
      return observations;
    });
    const gather = createGatherEvidence({ ...baseOpts, runRoleQuery });
    const out = await gather(hyp({ kind: "metric-threshold", metric: "http_p99", op: ">", value: 5 }), 1);
    expect(out).toEqual(observations);
    expect(runRoleQuery).toHaveBeenCalledOnce();
  });

  it("returns [] without calling runRoleQuery when the prediction has no plan", async () => {
    const runRoleQuery = vi.fn(async () => []);
    const gather = createGatherEvidence({ ...baseOpts, runRoleQuery });
    const out = await gather(hyp({ kind: "bogus" } as any), 1);
    expect(out).toEqual([]);
    expect(runRoleQuery).not.toHaveBeenCalled();
  });

  it("degrades gracefully to [] when the query throws", async () => {
    const runRoleQuery = vi.fn(async () => { throw new Error("MCP down"); });
    const gather = createGatherEvidence({ ...baseOpts, runRoleQuery });
    const out = await gather(hyp({ kind: "log-pattern", pattern: "x" }), 2);
    expect(out).toEqual([]);
  });
});
