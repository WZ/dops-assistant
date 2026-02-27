import { describe, it, expect, vi } from "vitest";
import { DiscoveryAgent } from "./discovery.js";
import type { LlmClient } from "../llm/openai.js";
import type { McpClient } from "../mcp/client.js";
import type { DiscoveryConfig } from "../config/schema.js";

function mockLlm(response: string): LlmClient {
  return {
    chat: vi.fn().mockResolvedValue({
      type: "text",
      content: response,
      usage: { inputTokens: 100, outputTokens: 50 },
    }),
  } as unknown as LlmClient;
}

function mockMcp(): McpClient {
  return {
    getTools: vi.fn().mockReturnValue([]),
    callTool: vi.fn().mockResolvedValue({ text: "", images: [] }),
  } as unknown as McpClient;
}

const discoveryConfig: DiscoveryConfig = {
  autoRefresh: false,
  excludeServices: ["consul"],
  consulMetric: "consul_catalog_service_node_healthy",
};

describe("DiscoveryAgent", () => {
  it("returns discovered services from LLM response", async () => {
    const response = JSON.stringify({
      services: [
        {
          name: "payments-api",
          metrics: [{ query: 'rate(http_requests_total{job="payments-api"}[5m])', description: "Request rate" }],
          logLabels: { app: "payments-api" },
        },
      ],
    });
    const agent = new DiscoveryAgent(mockLlm(response), mockMcp(), { maxIterations: 10 });
    const result = await agent.discover(discoveryConfig);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("payments-api");
    expect(result[0]!.metrics).toHaveLength(1);
  });

  it("calls onTokenUsage callback", async () => {
    const response = JSON.stringify({ services: [] });
    const agent = new DiscoveryAgent(mockLlm(response), mockMcp(), { maxIterations: 10 });
    const onTokenUsage = vi.fn();
    await agent.discover(discoveryConfig, onTokenUsage);
    expect(onTokenUsage).toHaveBeenCalledWith({ inputTokens: 100, outputTokens: 50 });
  });

  it("filters excluded services from results", async () => {
    const response = JSON.stringify({
      services: [
        { name: "consul", metrics: [], logLabels: {} },
        { name: "payments-api", metrics: [], logLabels: {} },
      ],
    });
    const agent = new DiscoveryAgent(mockLlm(response), mockMcp(), { maxIterations: 10 });
    const result = await agent.discover(discoveryConfig);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("payments-api");
  });
});
