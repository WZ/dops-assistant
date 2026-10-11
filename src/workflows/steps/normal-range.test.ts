import { describe, it, expect, vi } from "vitest";
import { checkSymptomsAgainstNormalRange, normalRangeNote, symptomDirection, executedPromQl } from "./normal-range.js";

const LATENCY = "histogram_quantile(0.99, sum by (le)(rate(vllm:e2e_request_latency_seconds_bucket[5m])))";
const TOOL_CALLS = 'sum(rate(vllm:tool_call_parser_invocations_total{model_name="m"}[5m]))';
const AVAILABLE = 'kube_deployment_status_replicas_available{deployment="api"}';
const WINDOW = { from: "2026-10-11T07:50:43.000Z", to: "2026-10-11T08:50:43.000Z" };
const NOW = Date.parse("2026-10-11T09:00:43.000Z");

/** Answers "worst in window" and "24h band" queries for the expression they wrap. */
function prom(values: Record<string, { worst: number; band: number }>) {
  return vi.fn(async (expr: string) => {
    for (const [metric, v] of Object.entries(values)) {
      if (!expr.includes(metric)) continue;
      return /quantile_over_time/.test(expr) ? v.band : v.worst;
    }
    return null;
  });
}

describe("checkSymptomsAgainstNormalRange", () => {
  it("treats a latency spike inside the service's 24h p95 as normal, ignoring unusual load metrics", async () => {
    // The overcalled run: p99 193s vs 24h p95 284s; tool-call rate far above its p95 but it is load, not damage.
    const query = prom({ [LATENCY]: { worst: 193.2, band: 283.7 }, [TOOL_CALLS]: { worst: 4.58, band: 0.25 } });
    const result = await checkSymptomsAgainstNormalRange([
      { metric: LATENCY, severity: "medium" },
      { metric: TOOL_CALLS, severity: "medium" },
      { metric: 'sum(rate(vllm:prompt_tokens_total{model_name="m"}[5m]))', severity: "low" },
    ], WINDOW, query, NOW);

    expect(result).toEqual({ allWithin: true, checks: [{ metric: LATENCY, direction: "higher-is-worse", worst: 193.2, band: 283.7, within: true }] });
    expect(query).toHaveBeenCalledWith(`max(max_over_time((${LATENCY})[3600s:1m] offset 600s))`);
    expect(query).toHaveBeenCalledWith(`max(quantile_over_time(0.95, (${LATENCY})[24h:5m] offset 4200s))`);
    expect(query.mock.calls.some(([e]) => e.includes("tool_call_parser"))).toBe(false);
  });

  it("is not within range when the window's worst exceeds the 24h p95", async () => {
    const query = prom({ [LATENCY]: { worst: 620, band: 283.7 } });
    const result = await checkSymptomsAgainstNormalRange([{ metric: LATENCY, severity: "high" }], WINDOW, query, NOW);
    expect(result?.allWithin).toBe(false);
  });

  it("checks availability against the 24h p5 (lower is worse)", async () => {
    const query = prom({ [AVAILABLE]: { worst: 0, band: 1 } });
    const result = await checkSymptomsAgainstNormalRange([{ metric: AVAILABLE, severity: "warning" }], WINDOW, query, NOW);
    expect(result?.allWithin).toBe(false);
    expect(query).toHaveBeenCalledWith(`min(quantile_over_time(0.05, (${AVAILABLE})[24h:5m] offset 4200s))`);
  });

  it("concludes nothing when only load metrics are elevated", async () => {
    const query = prom({ [TOOL_CALLS]: { worst: 4.58, band: 0.25 } });
    expect(await checkSymptomsAgainstNormalRange([{ metric: TOOL_CALLS, severity: "medium" }], WINDOW, query, NOW)).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it("concludes nothing when a symptom query returns no value", async () => {
    const query = vi.fn(async () => null);
    expect(await checkSymptomsAgainstNormalRange([{ metric: LATENCY, severity: "medium" }], WINDOW, query, NOW)).toBeNull();
  });

  it("concludes nothing without an absolute investigation window", async () => {
    const query = prom({ [LATENCY]: { worst: 1, band: 2 } });
    expect(await checkSymptomsAgainstNormalRange([{ metric: LATENCY, severity: "medium" }], { from: "now-1h", to: "now" }, query, NOW)).toBeNull();
  });

  it("skips normal-severity observations and LogQL recorded as a metric", async () => {
    const query = prom({});
    const result = await checkSymptomsAgainstNormalRange([
      { metric: LATENCY, severity: "info" },
      { metric: 'Loki logs {pod="api-1"} |= "error"', severity: "medium" },
    ], WINDOW, query, NOW);
    expect(result).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
});

describe("executed queries", () => {
  it("checks symptom queries the phase ran even when its observations carry only names", async () => {
    const query = prom({ [LATENCY]: { worst: 193.2, band: 283.7 } });
    const result = await checkSymptomsAgainstNormalRange(
      [{ metric: "e2e_request_latency_p99", severity: "warning" }],
      WINDOW, query, NOW, [LATENCY, TOOL_CALLS, 'kube_pod_info{pod="x"}'],
    );
    expect(result?.allWithin).toBe(true);
    expect(result?.checks.map((c) => c.metric)).toEqual([LATENCY]);
  });

  it("is not within range when a query the phase ran exceeded its 24h band", async () => {
    const query = prom({ [LATENCY]: { worst: 193.2, band: 283.7 }, 'rate(http_errors_total[5m])': { worst: 9, band: 0.1 } });
    const result = await checkSymptomsAgainstNormalRange([], WINDOW, query, NOW, [LATENCY, "rate(http_errors_total[5m])"]);
    expect(result?.allWithin).toBe(false);
  });

  it("skips an executed query that has no data but still judges the rest", async () => {
    const query = prom({ [LATENCY]: { worst: 193.2, band: 283.7 } });
    const result = await checkSymptomsAgainstNormalRange([], WINDOW, query, NOW, ['rate(http_errors_total{pod="gone"}[5m])', LATENCY]);
    expect(result?.allWithin).toBe(true);
    expect(result?.checks.map((c) => c.metric)).toEqual([LATENCY]);
  });

  it("concludes nothing when every executed query has no data", async () => {
    expect(await checkSymptomsAgainstNormalRange([], WINDOW, async () => null, NOW, [LATENCY])).toBeNull();
  });

  it("deduplicates and caps the number of symptom queries", async () => {
    const queries = Array.from({ length: 10 }, (_, i) => `rate(http_errors_total{pod="p${i}"}[5m])`);
    const query = vi.fn(async () => 1);
    const result = await checkSymptomsAgainstNormalRange([{ metric: queries[0]!, severity: "warning" }], WINDOW, query, NOW, queries);
    expect(result?.checks).toHaveLength(6);
    expect(query).toHaveBeenCalledTimes(12);
  });
});

describe("executedPromQl", () => {
  it("extracts expr from query_prometheus tool calls only", () => {
    expect(executedPromQl([
      { tool: "grafana-mcp_query_prometheus", args: JSON.stringify({ expr: ` ${LATENCY} `, queryType: "range" }) },
      { tool: "grafana-mcp_query_loki_logs", args: JSON.stringify({ logql: '{app="x"}' }) },
      { tool: "query_prometheus", args: "not json" },
      { tool: "query_prometheus", args: JSON.stringify({ expr: "" }) },
      { tool: "query_prometheus" },
    ])).toEqual([LATENCY]);
    expect(executedPromQl(undefined)).toEqual([]);
  });
});

describe("symptomDirection", () => {
  it("classifies symptoms and ignores load", () => {
    expect(symptomDirection(LATENCY)).toBe("higher-is-worse");
    expect(symptomDirection('sum(rate(http_requests_total{code=~"5.."}[5m]))')).toBe("higher-is-worse");
    expect(symptomDirection("rate(kube_pod_container_status_restarts_total[5m])")).toBe("higher-is-worse");
    expect(symptomDirection(AVAILABLE)).toBe("lower-is-worse");
    expect(symptomDirection('up{job="api"}')).toBe("lower-is-worse");
    expect(symptomDirection(TOOL_CALLS)).toBeNull();
    expect(symptomDirection('sum(rate(vllm:request_success_total{model_name="m"}[5m]))')).toBeNull();
    expect(symptomDirection("sum(rate(ok[5m])) / sum(rate(req[5m])) # success_ratio")).toBe("lower-is-worse");
  });
});

describe("normalRangeNote", () => {
  it("states the comparison for each symptom", () => {
    expect(normalRangeNote({ allWithin: true, checks: [{ metric: "p99_latency", direction: "higher-is-worse", worst: 193.2, band: 283.7, within: true }] }))
      .toBe("Note: every elevated symptom stayed within this service's normal range over the previous 24h (p99_latency peaked at 193, 24h p95 284).");
  });
});
