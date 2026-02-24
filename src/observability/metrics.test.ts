import { describe, it, expect, beforeEach } from "vitest";
import { registry, agentRunsTotal, toolCallsTotal, llmCallsTotal } from "./metrics.js";

beforeEach(() => {
  registry.resetMetrics();
});

describe("metrics", () => {
  it("agentRunsTotal increments by status", async () => {
    agentRunsTotal.inc({ status: "success" });
    agentRunsTotal.inc({ status: "success" });
    agentRunsTotal.inc({ status: "error" });
    const metrics = await registry.getMetricsAsJSON();
    const counter = metrics.find((m) => m.name === "agent_runs_total");
    expect(counter).toBeDefined();
    const values = counter!.values as Array<{ labels: { status: string }; value: number }>;
    expect(values.find((v) => v.labels.status === "success")?.value).toBe(2);
    expect(values.find((v) => v.labels.status === "error")?.value).toBe(1);
  });

  it("toolCallsTotal has tool and status labels", async () => {
    toolCallsTotal.inc({ tool: "query_prometheus", status: "success" });
    const metrics = await registry.getMetricsAsJSON();
    const counter = metrics.find((m) => m.name === "tool_calls_total");
    expect(counter).toBeDefined();
  });

  it("registry exposes Prometheus text format", async () => {
    llmCallsTotal.inc({ status: "success" });
    const text = await registry.metrics();
    expect(text).toContain("llm_calls_total");
  });
});
