import { describe, it, expect } from "vitest";
import {
  parseMetricValue,
  evaluatePrediction,
  assessDiscrimination,
  type NormalizedObservation,
  type RankedHypothesis,
} from "./corroboration.js";

describe("parseMetricValue", () => {
  it("parses plain numbers, units, and percentages", () => {
    expect(parseMetricValue("8.0s")).toBe(8);
    expect(parseMetricValue("503")).toBe(503);
    expect(parseMetricValue("95%")).toBe(95);
    expect(parseMetricValue("1.2k")).toBe(1200);
    expect(parseMetricValue(42)).toBe(42);
    expect(parseMetricValue("n/a")).toBeUndefined();
    expect(parseMetricValue(undefined)).toBeUndefined();
  });
});

describe("evaluatePrediction", () => {
  it("metric-threshold: satisfied when a matching metric crosses the threshold", () => {
    const obs: NormalizedObservation[] = [
      { phase: "metrics", subject: "payments p99 latency", value: 8.0 },
    ];
    expect(evaluatePrediction({ kind: "metric-threshold", metric: "payments p99", op: ">", value: 5 }, obs)).toBe("satisfied");
  });

  it("metric-threshold: contradicted when the metric exists but doesn't cross", () => {
    const obs: NormalizedObservation[] = [
      { phase: "metrics", subject: "payments p99 latency", value: 0.2 },
    ];
    expect(evaluatePrediction({ kind: "metric-threshold", metric: "payments p99", op: ">", value: 5 }, obs)).toBe("contradicted");
  });

  it("metric-threshold: absent when no matching metric was observed", () => {
    const obs: NormalizedObservation[] = [
      { phase: "metrics", subject: "cpu usage", value: 30 },
    ];
    expect(evaluatePrediction({ kind: "metric-threshold", metric: "payments p99", op: ">", value: 5 }, obs)).toBe("absent");
  });

  it("log-pattern present: satisfied when the pattern appears in subject or sample text", () => {
    const obs: NormalizedObservation[] = [
      { phase: "logs", subject: "connection pool exhausted", text: "FATAL: connection pool exhausted" },
    ];
    expect(evaluatePrediction({ kind: "log-pattern", pattern: "pool exhausted" }, obs)).toBe("satisfied");
  });

  it("log-pattern present:false: satisfied when logs exist but pattern absent, contradicted when present", () => {
    const withOther: NormalizedObservation[] = [{ phase: "logs", subject: "request ok", text: "200 ok" }];
    expect(evaluatePrediction({ kind: "log-pattern", pattern: "leak", present: false }, withOther)).toBe("satisfied");
    const withPattern: NormalizedObservation[] = [{ phase: "logs", subject: "memory leak detected" }];
    expect(evaluatePrediction({ kind: "log-pattern", pattern: "leak", present: false }, withPattern)).toBe("contradicted");
    // No logs at all → can't judge absence.
    expect(evaluatePrediction({ kind: "log-pattern", pattern: "leak", present: false }, [])).toBe("absent");
  });

  it("infra-status: satisfied when resource shows the status", () => {
    const obs: NormalizedObservation[] = [
      { phase: "infra", subject: "checkout-api pod", text: "OOMKilled, restarted 3x" },
    ];
    expect(evaluatePrediction({ kind: "infra-status", resource: "checkout-api", status: "OOMKilled" }, obs)).toBe("satisfied");
    expect(evaluatePrediction({ kind: "infra-status", resource: "payments", status: "OOMKilled" }, obs)).toBe("absent");
  });

  it("change-in-window: satisfied when a change lands within the window before the incident", () => {
    const obs: NormalizedObservation[] = [
      { phase: "changes", subject: "MR #4412 shrink db pool", timestamp: "2026-04-02T13:55:00Z" },
    ];
    const ctx = { incidentTime: "2026-04-02T14:00:00Z" };
    expect(evaluatePrediction({ kind: "change-in-window", withinMinutesBefore: 30 }, obs, ctx)).toBe("satisfied");
    // Same change, tighter window → falls outside → contradicted (a change exists, just not in window).
    expect(evaluatePrediction({ kind: "change-in-window", withinMinutesBefore: 2 }, obs, ctx)).toBe("contradicted");
    // No incident time → can't judge.
    expect(evaluatePrediction({ kind: "change-in-window", withinMinutesBefore: 30 }, obs, {})).toBe("absent");
  });
});

describe("assessDiscrimination — the loop stop signal", () => {
  // Canonical incident: checkout-api OOMKills, real cause is payments backpressure.
  const obs: NormalizedObservation[] = [
    { phase: "metrics", subject: "payments p99 latency", value: 8.0 },
    { phase: "metrics", subject: "checkout-api request rate", value: 100 }, // flat — not a traffic spike
    { phase: "infra", subject: "checkout-api pod", text: "OOMKilled" },
  ];

  const leak: RankedHypothesis = {
    hypothesis: "memory leak in checkout-api",
    prediction: { kind: "log-pattern", pattern: "leak", present: true },
  };
  const backpressure: RankedHypothesis = {
    hypothesis: "payments backpressure → checkout pileup → OOM",
    prediction: { kind: "metric-threshold", metric: "payments p99", op: ">", value: 5 },
  };
  const trafficSpike: RankedHypothesis = {
    hypothesis: "traffic spike",
    prediction: { kind: "metric-threshold", metric: "checkout-api request rate", op: ">", value: 500 },
  };

  it("confirms + discriminates the leader when the runner-up's prediction is NOT satisfied", () => {
    const r = assessDiscrimination(backpressure, trafficSpike, obs);
    expect(r.confirmed).toBe(true);          // payments p99 = 8 > 5
    expect(r.discriminating).toBe(true);     // request rate 100, not > 500
    expect(r.outcome).toBe("confirmed");
  });

  it("weakens the leader when its own prediction isn't satisfied", () => {
    const r = assessDiscrimination(leak, backpressure, obs);
    expect(r.confirmed).toBe(false);         // no "leak" log pattern present
    expect(r.outcome).toBe("weakened");
  });

  it("reports 'undetermined' when leader AND runner-up are both satisfied (correlational tie)", () => {
    // Two hypotheses that the same evidence both confirm — the keystone failure
    // mode. Build evidence where both a deploy-in-window AND payments-latency hold.
    const tie: NormalizedObservation[] = [
      { phase: "metrics", subject: "payments p99 latency", value: 8.0 },
      { phase: "changes", subject: "deploy v2.3.1", timestamp: "2026-04-02T13:58:00Z" },
    ];
    const deploy: RankedHypothesis = {
      hypothesis: "the 13:58 deploy caused it",
      prediction: { kind: "change-in-window", withinMinutesBefore: 30 },
    };
    const r = assessDiscrimination(backpressure, deploy, tie, { incidentTime: "2026-04-02T14:00:00Z" });
    expect(r.confirmed).toBe(true);          // payments p99 satisfied
    expect(r.discriminating).toBe(false);    // deploy ALSO satisfied → not distinguished
    expect(r.outcome).toBe("undetermined");  // → report both, surface deep CTA
  });

  it("a confirmed sole hypothesis (no runner-up) is decisive", () => {
    const r = assessDiscrimination(backpressure, undefined, obs);
    expect(r.outcome).toBe("confirmed");
    expect(r.discriminating).toBe(true);
  });
});
