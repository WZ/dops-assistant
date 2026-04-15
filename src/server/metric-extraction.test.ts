import { describe, it, expect } from "vitest";
import { parseMetricHints, extractMetricExpression } from "./metric-extraction.js";

describe("parseMetricHints", () => {
  it("extracts cpu keyword", () => {
    const hints = parseMetricHints("CPU usage spiked to 94% at 14:32");
    expect(hints.keywords).toContain("cpu");
  });

  it("extracts memory keyword", () => {
    const hints = parseMetricHints("Memory consumption reached 512Mi");
    expect(hints.keywords).toContain("memory");
  });

  it("extracts multiple keywords", () => {
    const hints = parseMetricHints("Latency increased and error rate spiked");
    expect(hints.keywords).toContain("latency");
    expect(hints.keywords).toContain("error");
  });

  it("extracts time reference", () => {
    const hints = parseMetricHints("CPU spiked at 14:32");
    expect(hints.timeRef).toBe("14:32");
  });

  it("extracts time range", () => {
    const hints = parseMetricHints("Between 14:00 and 15:30 error rate was elevated");
    expect(hints.timeRef).toBe("14:00");
    expect(hints.timeRefEnd).toBe("15:30");
  });

  it("matches plurals and underscore-embedded keywords (regression)", () => {
    // The earlier \b-based matcher missed these because underscores are word
    // chars and plurals don't cross word boundaries. Substring match is the fix.
    const h1 = parseMetricHints("kube_deployment_status_replicas was 13");
    expect(h1.keywords).toContain("replica");
    const h2 = parseMetricHints("The service was restarted at 08:55");
    expect(h2.keywords).toContain("restart");
  });

  it("handles empty string gracefully", () => {
    const hints = parseMetricHints("");
    expect(hints.keywords).toEqual([]);
    expect(hints.timeRef).toBeUndefined();
  });
});

describe("extractMetricExpression", () => {
  it("pulls metric+selector from an LLM observation string", () => {
    const expr = extractMetricExpression(
      'kube_deployment_status_replicas{deployment="ingestion-server"} was 13 (baseline: 13) at 2026-04-15T08:55:55.952Z',
    );
    expect(expr).toBe('kube_deployment_status_replicas{deployment="ingestion-server"}');
  });

  it("handles metric names without selectors", () => {
    const expr = extractMetricExpression("kube_pod_status_phase was 0 (baseline: 13)");
    expect(expr).toBe("kube_pod_status_phase");
  });

  it("extracts the inner metric from a simple aggregation", () => {
    // Not required for the fix, just documenting current behavior — returns
    // the inner metric, not the whole sum(...) expression. Good enough for
    // chart backfill since the raw metric produces comparable data.
    const expr = extractMetricExpression('sum(http_requests_total{code="500"}) was high');
    expect(expr).toBe('http_requests_total{code="500"}');
  });

  it("rejects plain English that happens to match the pattern", () => {
    expect(extractMetricExpression("The service was down")).toBeUndefined();
    expect(extractMetricExpression("")).toBeUndefined();
  });

  it("accepts bare metric names containing an underscore", () => {
    expect(extractMetricExpression("up was 0 across 3 pods")).toBeUndefined();
    expect(extractMetricExpression("http_requests_total was elevated")).toBe("http_requests_total");
  });
});
