import { describe, expect, it } from "vitest";
import { scoreBenchmarkRun, summarizeBenchmarkRuns } from "./discovery-benchmark.js";
import type { DiscoveryResult } from "../types/agent-interfaces.js";

const expected = ["checkout-api", "payments-worker"];

function result(services: DiscoveryResult["services"]): DiscoveryResult {
  return { services, globalProbeRules: [] };
}

describe("discovery benchmark scoring", () => {
  it("scores service recall, precision, rule coverage, confidence, and eval score", () => {
    const run = scoreBenchmarkRun({
      round: "test",
      iteration: 1,
      expectedServices: expected,
      durationMs: 1234,
      events: [],
      result: result([
        {
          name: "checkout-api",
          metrics: [{ query: 'up{app="checkout-api"}', description: "" }],
          logLabels: { namespace: "checkout", container: "api" },
          confidence: "verified",
          validationNotes: "metrics ok",
          probeRules: [
            { name: "service_availability", query: 'up{app="checkout-api"}', threshold: { op: "lt", value: 1 }, consecutiveTicks: 3, source: "metrics" },
            { name: "pod_restarts", query: 'rate(kube_pod_container_status_restarts_total{namespace="checkout",container="api"}[5m])', threshold: { op: "gt", value: 0.033 }, consecutiveTicks: 2, source: "metrics" },
            { name: "log_errors", query: 'sum(count_over_time({namespace="checkout",container="api"} |= `error` [15m]))', threshold: { op: "gt", value: 75 }, consecutiveTicks: 2, source: "logs" },
          ],
        },
        {
          name: "extra-service",
          metrics: [{ query: 'up{app="extra-service"}', description: "" }],
          logLabels: {},
          confidence: "unverified",
          validationNotes: "metrics empty",
          probeRules: [],
        },
      ]),
    });

    expect(run.success).toBe(false);
    expect(run.serviceRecall).toBe(0.5);
    expect(run.servicePrecision).toBe(0.5);
    expect(run.ruleCoverage).toBe(0.5);
    expect(run.requiredRuleCoverage).toBe(0.5);
    expect(run.verifiedRatio).toBe(0.5);
    expect(run.serviceRuleNames["checkout-api"]).toEqual(["service_availability", "pod_restarts", "log_errors"]);
    expect(run.serviceQueries["checkout-api"]).toBe('up{app="checkout-api"}');
    expect(run.evalScore).toBeGreaterThan(0);
  });

  it("marks exact complete discovery as success", () => {
    const run = scoreBenchmarkRun({
      round: "test",
      iteration: 1,
      expectedServices: ["checkout-api"],
      durationMs: 1234,
      events: [],
      result: {
        services: [{
          name: "checkout-api",
          metrics: [{ query: 'up{app="checkout-api"}', description: "" }],
          logLabels: {},
          confidence: "verified",
          validationNotes: "metrics ok",
          probeRules: [
            { name: "service_availability", query: 'up{app="checkout-api"}', threshold: { op: "lt", value: 1 }, consecutiveTicks: 3, source: "metrics" },
          ],
        }],
        globalProbeRules: [{ name: "app_availability", query: 'up{app="{service}"}', threshold: { op: "lt", value: 1 }, consecutiveTicks: 3, source: "metrics" }],
      },
    });
    expect(run.success).toBe(true);
    expect(run.globalRuleCount).toBe(1);
  });

  it("summarizes success rate and averages across runs", () => {
    const runs = [
      scoreBenchmarkRun({
        round: "test",
        iteration: 1,
        expectedServices: expected,
        durationMs: 100,
        events: [],
        result: result([]),
      }),
      scoreBenchmarkRun({
        round: "test",
        iteration: 2,
        expectedServices: expected,
        durationMs: 300,
        events: [],
        error: "timeout",
      }),
    ];

    const summary = summarizeBenchmarkRuns("test", runs);
    expect(summary.iterations).toBe(2);
    expect(summary.successRate).toBe(0);
    expect(summary.avgDurationMs).toBe(200);
    expect(summary.errorCount).toBe(1);
    expect(summary.failureCount).toBe(2);
    expect(summary.completeEmptyCount).toBe(0);
  });
});
