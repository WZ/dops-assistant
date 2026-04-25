import { describe, it, expect } from "vitest";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  parsesAsPromQL,
  parsesAsLogQL,
  scoreGlobalsPresent,
  scorePerServicePresent,
  scorePromQLParses,
  scoreLogQLParses,
  evalDiscoverOutput,
  loadInput,
  detectAvailabilityAntipattern,
} from "./discover-eval.js";

// __dirname is stable enough under vitest; resolve relative to this test file.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, "fixtures/discover-k8s-fixture.yaml");

describe("discover-eval / parsesAsPromQL", () => {
  it("accepts a well-formed instant query", () => {
    expect(parsesAsPromQL('up{app="checkout"}').ok).toBe(true);
  });

  it("accepts a rate over a range", () => {
    expect(parsesAsPromQL('rate(kube_pod_container_status_restarts_total{namespace="checkout"}[5m])').ok).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(parsesAsPromQL("").ok).toBe(false);
  });

  it("rejects a query with placeholder tokens", () => {
    expect(parsesAsPromQL('up{namespace="YOUR_NAMESPACE"}').ok).toBe(false);
    expect(parsesAsPromQL('up{namespace="<namespace>"}').ok).toBe(false);
  });

  it("rejects unbalanced braces", () => {
    expect(parsesAsPromQL('rate(kube_pod_container_status_restarts_total{namespace="checkout"[5m])').ok).toBe(false);
  });

  it("rejects unbalanced parens", () => {
    expect(parsesAsPromQL('rate(up{app="x"}').ok).toBe(false);
  });
});

describe("discover-eval / parsesAsLogQL", () => {
  it("accepts a well-formed count_over_time", () => {
    const q = 'sum(count_over_time({namespace="checkout",container="api"} |= `error` or `fatal` [15m]))';
    expect(parsesAsLogQL(q).ok).toBe(true);
  });

  it("rejects a string with no stream selector", () => {
    expect(parsesAsLogQL("this is not a logql query").ok).toBe(false);
  });

  it("rejects placeholder tokens", () => {
    expect(parsesAsLogQL('{namespace="YOUR_NAMESPACE"} |= `error`').ok).toBe(false);
  });
});

describe("discover-eval / dimension scoring", () => {
  it("scoreGlobalsPresent: 25 when non-empty, 0 when empty", () => {
    expect(scoreGlobalsPresent({ services: [], globalProbeRules: [] }).score).toBe(0);
    expect(
      scoreGlobalsPresent({
        services: [],
        globalProbeRules: [
          { name: "a", query: 'up{app="{service}"}', threshold: { op: "lt", value: 1 }, consecutiveTicks: 3, source: "metrics" },
        ],
      }).score,
    ).toBe(25);
  });

  it("scorePerServicePresent: 25 when majority have rules, 15 when minority, 0 when none", () => {
    const empty = scorePerServicePresent({ services: [{ name: "a", metrics: [], logLabels: {}, probeRules: [] }], globalProbeRules: [] });
    expect(empty.score).toBe(0);

    const minority = scorePerServicePresent({
      services: [
        { name: "a", metrics: [], logLabels: {}, probeRules: [{ name: "x", query: "up{}", threshold: { op: "gt", value: 0 }, consecutiveTicks: 1, source: "metrics" }] },
        { name: "b", metrics: [], logLabels: {}, probeRules: [] },
        { name: "c", metrics: [], logLabels: {}, probeRules: [] },
      ],
      globalProbeRules: [],
    });
    expect(minority.score).toBe(15);

    const majority = scorePerServicePresent({
      services: [
        { name: "a", metrics: [], logLabels: {}, probeRules: [{ name: "x", query: "up{}", threshold: { op: "gt", value: 0 }, consecutiveTicks: 1, source: "metrics" }] },
        { name: "b", metrics: [], logLabels: {}, probeRules: [{ name: "y", query: "up{}", threshold: { op: "gt", value: 0 }, consecutiveTicks: 1, source: "metrics" }] },
        { name: "c", metrics: [], logLabels: {}, probeRules: [] },
      ],
      globalProbeRules: [],
    });
    expect(majority.score).toBe(25);
  });

  it("scorePromQLParses: full credit when no metric rules (nothing to grade)", () => {
    // No rules present — don't penalize; globalsPresent / perServicePresent already covered "empty".
    expect(scorePromQLParses({ services: [], globalProbeRules: [] }).score).toBe(25);
  });

  it("scorePromQLParses: partial credit proportional to failures", () => {
    const result = scorePromQLParses({
      services: [
        {
          name: "a",
          metrics: [],
          logLabels: {},
          probeRules: [
            { name: "good", query: 'up{app="a"}', threshold: { op: "lt", value: 1 }, consecutiveTicks: 1, source: "metrics" },
            { name: "bad", query: 'up{namespace="YOUR_NAMESPACE"}', threshold: { op: "lt", value: 1 }, consecutiveTicks: 1, source: "metrics" },
          ],
        },
      ],
      globalProbeRules: [],
    });
    // 1/2 fails → 25 * 0.5 = 12.5 → rounded to 13
    expect(result.score).toBe(13);
  });

  it("scoreLogQLParses: full credit on well-formed logs rules", () => {
    const result = scoreLogQLParses({
      services: [
        {
          name: "a",
          metrics: [],
          logLabels: {},
          probeRules: [
            {
              name: "log_errors",
              query: 'sum(count_over_time({namespace="checkout"} |= `error` [15m]))',
              threshold: { op: "gt", value: 75 },
              consecutiveTicks: 2,
              source: "logs",
            },
          ],
        },
      ],
      globalProbeRules: [],
    });
    expect(result.score).toBe(25);
  });
});

describe("discover-eval / detectAvailabilityAntipattern", () => {
  it("flags kube_deployment_status_replicas (desired count, not readiness)", () => {
    expect(detectAvailabilityAntipattern('kube_deployment_status_replicas{deployment="x"}')).toBe(
      "kube_deployment_status_replicas",
    );
  });

  it("flags kube_statefulset_status_replicas", () => {
    expect(detectAvailabilityAntipattern('kube_statefulset_status_replicas{statefulset="x"}')).toBe(
      "kube_statefulset_status_replicas",
    );
  });

  it("flags kube_daemonset_status_desired_number_scheduled", () => {
    expect(detectAvailabilityAntipattern('kube_daemonset_status_desired_number_scheduled{daemonset="x"}')).toBe(
      "kube_daemonset_status_desired_number_scheduled",
    );
  });

  it("accepts kube_deployment_status_replicas_available", () => {
    expect(detectAvailabilityAntipattern('kube_deployment_status_replicas_available{deployment="x"}')).toBeNull();
  });

  it("accepts kube_statefulset_status_replicas_ready", () => {
    expect(detectAvailabilityAntipattern('kube_statefulset_status_replicas_ready{statefulset="x"}')).toBeNull();
  });

  it("accepts kube_daemonset_status_number_ready", () => {
    expect(detectAvailabilityAntipattern('kube_daemonset_status_number_ready{daemonset="x"}')).toBeNull();
  });

  it("accepts up{} and other non-kube metrics", () => {
    expect(detectAvailabilityAntipattern('up{app="x"}')).toBeNull();
    expect(detectAvailabilityAntipattern('consul_catalog_service_node_healthy{service="x"}')).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(detectAvailabilityAntipattern("")).toBeNull();
  });
});

describe("discover-eval / scorePromQLParses flags availability antipatterns", () => {
  it("penalizes a service_availability rule that uses kube_deployment_status_replicas", () => {
    const result = scorePromQLParses({
      services: [
        {
          name: "checkout-api",
          metrics: [],
          logLabels: {},
          probeRules: [
            {
              name: "service_availability",
              query: 'kube_deployment_status_replicas{deployment="checkout-api"}',
              threshold: { op: "lt", value: 1 },
              consecutiveTicks: 3,
              source: "metrics",
            },
          ],
        },
      ],
      globalProbeRules: [],
    });
    expect(result.score).toBeLessThan(25);
    expect(result.notes.join(" ")).toMatch(/desired-count|readiness|_available|_ready/);
  });

  it("does NOT penalize pod_restarts using kube_deployment_status_replicas (rule name doesn't suggest availability)", () => {
    // pod_restarts and other non-availability rules are allowed to mention
    // any kube-state-metric — only rules whose name suggests availability are
    // checked. This test pins the scope so the antipattern check doesn't drift
    // into false-positive territory.
    const result = scorePromQLParses({
      services: [
        {
          name: "x",
          metrics: [],
          logLabels: {},
          probeRules: [
            {
              name: "pod_restarts",
              query: 'rate(kube_pod_container_status_restarts_total{namespace="x"}[5m])',
              threshold: { op: "gt", value: 0.033 },
              consecutiveTicks: 2,
              source: "metrics",
            },
          ],
        },
      ],
      globalProbeRules: [],
    });
    expect(result.score).toBe(25);
  });

  it("accepts a service_availability rule that uses _available variant", () => {
    const result = scorePromQLParses({
      services: [
        {
          name: "x",
          metrics: [],
          logLabels: {},
          probeRules: [
            {
              name: "service_availability",
              query: 'kube_deployment_status_replicas_available{deployment="x"}',
              threshold: { op: "lt", value: 1 },
              consecutiveTicks: 3,
              source: "metrics",
            },
          ],
        },
      ],
      globalProbeRules: [],
    });
    expect(result.score).toBe(25);
  });
});

describe("discover-eval / top-level evalDiscoverOutput", () => {
  it("scores the k8s fixture at 100/100", () => {
    // The fixture represents a well-formed discovery output. Any drift here
    // (someone edits the fixture with a broken query, or the scoring gets
    // more strict) surfaces as a score < 100 and the test fails — signal
    // that the eval's calibration matches the fixture's intent.
    const input = loadInput(FIXTURE);
    const result = evalDiscoverOutput(input);
    expect(result.total).toBe(100);
    for (const dim of result.dimensions) {
      expect(dim.score).toBe(dim.max);
    }
  });

  it("scores an empty services.yaml below the min-score gate of 75", () => {
    const input = { services: [], globalProbeRules: [] };
    const result = evalDiscoverOutput(input);
    // globals=0 (0/25), per-service=0 (0/25), promql=25 (nothing to grade),
    // logql=25 (nothing to grade). Total = 50.
    expect(result.total).toBe(50);
    expect(result.total).toBeLessThan(75);
  });

  it("scores a legacy flat-array services.yaml path (forward-compat) below gate", () => {
    // loadInput normalizes legacy shape to {services, globalProbeRules:[]}.
    // A file with services but no globals and no probeRules scores 50 (no
    // globals, no per-service, full credit on nothing-to-grade dims).
    const input = {
      services: [{ name: "legacy", metrics: [], logLabels: {}, probeRules: [] }],
      globalProbeRules: [],
    };
    const result = evalDiscoverOutput(input);
    expect(result.total).toBe(50);
  });

  it("detects the real-world regression mode: total passes --min-score but per_service_present is 0", () => {
    // This is the exact shape we caught in the wild on 2026-04-23:
    // globalProbeRules present + parses + logs fine, but every service has
    // probeRules: []. Total scored 75/100 (pass under default min-score 75)
    // even though the per_service_present dimension was 0/25. The fix is the
    // --require-per-service gate below — this test pins the regression mode.
    const input = {
      services: Array.from({ length: 10 }, (_, i) => ({
        name: `svc-${i}`,
        metrics: [{ query: `up{deployment="svc-${i}"}`, description: "" }],
        logLabels: { namespace: "default", container: `svc-${i}` },
        probeRules: [],
      })),
      globalProbeRules: [{
        name: "container_availability",
        query: 'up{container="{service}"}',
        threshold: { op: "lt" as const, value: 1 },
        consecutiveTicks: 3,
        source: "metrics" as const,
      }],
    };
    const result = evalDiscoverOutput(input);
    const perService = result.dimensions.find((d) => d.name === "per_service_present")!;
    // Total stays above the default gate...
    expect(result.total).toBeGreaterThanOrEqual(75);
    // ...but the per-service dimension is 0. --require-per-service is the
    // CLI flag that turns this into a test failure.
    expect(perService.score).toBe(0);
    expect(perService.notes[0]).toContain("no service has non-empty probeRules");
  });
});
