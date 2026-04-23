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
});
