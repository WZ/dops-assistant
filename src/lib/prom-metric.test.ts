import { describe, it, expect } from "vitest";
import { extractMetricExpression } from "./prom-metric.js";

describe("extractMetricExpression", () => {
  describe("aggregation where the metric is NOT the leading token (regression)", () => {
    // Before the fix these were the source of "metric truncated, showing no
    // data" cards: the extractor returned the bare function name (or undefined),
    // so the chart title looked clipped and the backfill query returned nothing.
    it("keeps the full histogram_quantile(scalar, ...) expression", () => {
      const expr =
        'histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket{service="payments"}[5m])) by (le))';
      expect(extractMetricExpression(`${expr} P99 latency was 2.3s`)).toBe(expr);
    });

    it("keeps the full histogram_quantile expression without a by-clause", () => {
      const expr = "histogram_quantile(0.95, rate(foo_bucket[5m]))";
      expect(extractMetricExpression(expr)).toBe(expr);
    });

    it("keeps the full sum(rate(...)) nested-function expression", () => {
      const expr = 'sum(rate(http_requests_total{code="500"}[5m]))';
      expect(extractMetricExpression(expr)).toBe(expr);
    });
  });

  describe("existing behavior is preserved", () => {
    it("aggregation with a leading bare metric", () => {
      expect(extractMetricExpression('sum(http_requests_total{code="500"}) was high')).toBe(
        'sum(http_requests_total{code="500"})',
      );
    });

    it("rate with range", () => {
      const expr = 'rate(container_cpu_usage_seconds_total{pod=~".*api.*"}[5m])';
      expect(extractMetricExpression(`${expr} spiked`)).toBe(expr);
    });

    it("bare metric with selector", () => {
      expect(extractMetricExpression('kube_deployment_status_replicas{deployment="x"} was 13')).toBe(
        'kube_deployment_status_replicas{deployment="x"}',
      );
    });

    it("bare metric name", () => {
      expect(extractMetricExpression("http_requests_total was elevated")).toBe("http_requests_total");
    });

    it("returns undefined for plain English", () => {
      expect(extractMetricExpression("the service was down")).toBeUndefined();
      expect(extractMetricExpression("up was 0")).toBeUndefined();
    });

    it("returns undefined for an aggregation with no real metric inside", () => {
      // `up` has no `_`/`:` and no selector, so it isn't a metric — the whole
      // call should be rejected rather than returning bare `count`.
      expect(extractMetricExpression("count(up == 1)")).toBeUndefined();
    });
  });
});
