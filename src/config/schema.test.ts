import { describe, it, expect } from "vitest";
import { ConfigSchema } from "./schema.js";

describe("ConfigSchema – new sections", () => {
  it("applies default values for timeouts, retry, and observability", () => {
    const result = ConfigSchema.parse({
      llm: { apiKey: "k", model: "gpt-4", maxTokens: 1000 },
      grafana: { mcpServer: { transport: "stdio", command: "npx", args: [] } },
    });
    expect(result.timeouts.mcpConnectMs).toBe(30_000);
    expect(result.timeouts.llmCallMs).toBe(60_000);
    expect(result.timeouts.toolExecutionMs).toBe(30_000);
    expect(result.timeouts.agentIterationMs).toBe(90_000);
    expect(result.retry.maxAttempts).toBe(3);
    expect(result.retry.baseDelayMs).toBe(500);
    expect(result.observability.port).toBe(9090);
    expect(result.observability.logLevel).toBe("info");
  });

  it("applies default investigationTriggerPhrases", () => {
    const result = ConfigSchema.safeParse({
      llm: { apiKey: "sk-test", model: "gpt-4", maxTokens: 4096 },
      grafana: { mcpServer: { transport: "stdio", command: "npx", args: [], env: {} } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agent.investigationTriggerPhrases).toContain("investigate");
    }
  });

  it("accepts discovery config with defaults", () => {
    const result = ConfigSchema.safeParse({
      llm: { apiKey: "k", model: "gpt-4", maxTokens: 1000 },
      grafana: { mcpServer: { transport: "stdio", command: "npx", args: [] } },
      discovery: {
        excludeServices: ["consul", "prometheus"],
        consulMetric: "consul_catalog_service_node_healthy",
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.discovery.autoRefresh).toBe(false);
      expect(result.data.discovery.excludeServices).toEqual(["consul", "prometheus"]);
    }
  });

});
