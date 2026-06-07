import { describe, it, expect, vi } from "vitest";
import {
  planPredictionQuery,
  createGatherEvidence,
  firstQueryProvenance,
  type PredictionQueryPlan,
  type CapturedToolCall,
} from "./hypothesis-requery.js";
import type { RankedHypothesis, NormalizedObservation } from "./corroboration.js";

describe("firstQueryProvenance (PR-3 deep-link provenance)", () => {
  it("returns the query call, stamped with the incident window", () => {
    const calls: CapturedToolCall[] = [
      { tool: "query_prometheus", args: { expr: "http_p99", datasource: "prom" }, ok: true },
    ];
    const p = firstQueryProvenance(calls, { from: "T1", to: "T2" });
    expect(p).toEqual({
      tool: "query_prometheus",
      args: JSON.stringify({ expr: "http_p99", datasource: "prom" }),
      from: "T1",
      to: "T2",
    });
  });

  it("skips zero-arg discovery calls (e.g. list_datasources) and picks the real query", () => {
    const calls: CapturedToolCall[] = [
      { tool: "list_datasources", args: {} },
      { tool: "query_loki_logs", args: { logql: '{app="x"}' } },
    ];
    const p = firstQueryProvenance(calls, { from: "T1", to: "T2" });
    expect(p?.tool).toBe("query_loki_logs");
    expect(p?.args).toContain("logql");
  });

  it("skips non-query helper calls that carry args (e.g. list_loki_label_names)", () => {
    const calls: CapturedToolCall[] = [
      { tool: "list_loki_label_names", args: { datasourceUid: "loki-uid" } },
      { tool: "query_loki_logs", args: { logql: '{app="x"}' } },
    ];
    const p = firstQueryProvenance(calls);
    expect(p?.tool).toBe("query_loki_logs");
  });

  it("prefers the last SUCCESSFUL query over an earlier failed attempt", () => {
    const calls: CapturedToolCall[] = [
      { tool: "query_prometheus", args: { expr: "bad((" }, ok: false }, // failed
      { tool: "query_prometheus", args: { expr: "rate(http_total[5m])" }, ok: true }, // succeeded
    ];
    const p = firstQueryProvenance(calls);
    expect(p?.args).toContain("rate(http_total[5m])");
  });

  it("last query wins among multiple successful queries (the confirming one runs last)", () => {
    const calls: CapturedToolCall[] = [
      { tool: "query_prometheus", args: { expr: "first" }, ok: true },
      { tool: "query_prometheus", args: { expr: "second" }, ok: true },
    ];
    expect(firstQueryProvenance(calls)?.args).toContain("second");
  });

  it("falls back to a query-bearing call even if all errored (error flag may be absent upstream)", () => {
    const calls: CapturedToolCall[] = [{ tool: "query_prometheus", args: { expr: "up" }, ok: false }];
    expect(firstQueryProvenance(calls)?.args).toContain("up");
  });

  it("returns undefined when no call carried a query", () => {
    expect(firstQueryProvenance([{ tool: "list_datasources", args: {} }], { from: "T1", to: "T2" })).toBeUndefined();
    expect(firstQueryProvenance([{ tool: "list_loki_label_names", args: { datasourceUid: "x" } }])).toBeUndefined();
    expect(firstQueryProvenance([])).toBeUndefined();
  });

  it("omits from/to when no time range is given (link build degrades gracefully)", () => {
    const p = firstQueryProvenance([{ tool: "query_prometheus", args: { expr: "up" }, ok: true }]);
    expect(p).toMatchObject({ tool: "query_prometheus" });
    expect(p?.from).toBeUndefined();
    expect(p?.to).toBeUndefined();
  });
});

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
