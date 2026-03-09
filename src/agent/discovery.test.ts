import { describe, it, expect, vi } from "vitest";
import { DiscoveryAgent, enrichLogLabels } from "./discovery.js";
import type { LlmClient } from "../llm/openai.js";
import type { MultiMcpClient } from "../mcp/multi-client.js";
import type { DiscoveryConfig, ServiceConfig } from "../config/schema.js";

function mockLlm(response: string): LlmClient {
  return {
    chat: vi.fn().mockResolvedValue({
      type: "text",
      content: response,
      usage: { inputTokens: 100, outputTokens: 50 },
    }),
  } as unknown as LlmClient;
}

function mockMcp(): MultiMcpClient {
  return {
    getTools: vi.fn().mockReturnValue([]),
    callTool: vi.fn().mockResolvedValue({ text: "", images: [] }),
    getProvidersByRole: vi.fn().mockReturnValue([]),
    getToolsByRole: vi.fn().mockReturnValue([]),
    hasRole: vi.fn().mockReturnValue(false),
  } as unknown as MultiMcpClient;
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

function svc(name: string): ServiceConfig {
  return { name, metrics: [], logLabels: {} };
}

function mockMcpForLabels(labelNames: string[], labelValues: Record<string, string[]>): MultiMcpClient {
  return {
    getTools: vi.fn().mockReturnValue([]),
    callTool: vi.fn().mockImplementation((_name: string, args: Record<string, unknown>) => {
      if (_name === "list_loki_label_names") {
        return Promise.resolve({ text: JSON.stringify(labelNames), images: [] });
      }
      if (_name === "list_loki_label_values") {
        const values = labelValues[args.labelName as string] ?? [];
        return Promise.resolve({ text: JSON.stringify(values), images: [] });
      }
      return Promise.resolve({ text: "[]", images: [] });
    }),
    getProvidersByRole: vi.fn().mockReturnValue([]),
    getToolsByRole: vi.fn().mockReturnValue([]),
    hasRole: vi.fn().mockReturnValue(false),
  } as unknown as MultiMcpClient;
}

describe("enrichLogLabels", () => {
  it("matches exact app_fortidata_name", async () => {
    const mcp = mockMcpForLabels(
      ["app_fortidata_name", "job"],
      { app_fortidata_name: ["ingestion-server", "data-server"], job: ["default/ingestion-server"] },
    );
    const result = await enrichLogLabels([svc("ingestion-server")], mcp, "loki-uid");
    expect(result[0]!.logLabels).toEqual({ app_fortidata_name: "ingestion-server" });
  });

  it("matches -headless suffix by stripping it", async () => {
    const mcp = mockMcpForLabels(
      ["app_fortidata_name"],
      { app_fortidata_name: ["data-server"] },
    );
    const result = await enrichLogLabels([svc("data-server-headless")], mcp, "loki-uid");
    expect(result[0]!.logLabels).toEqual({ app_fortidata_name: "data-server" });
  });

  it("matches job label in namespace/name format", async () => {
    const mcp = mockMcpForLabels(
      ["job"],
      { job: ["default/ingestion-server", "db/ch-clickhouse-shard0"] },
    );
    const result = await enrichLogLabels([svc("ingestion-server")], mcp, "loki-uid");
    expect(result[0]!.logLabels).toEqual({ job: "default/ingestion-server" });
  });

  it("prefers app_fortidata_name over job", async () => {
    const mcp = mockMcpForLabels(
      ["app_fortidata_name", "job"],
      {
        app_fortidata_name: ["ingestion-server"],
        job: ["default/ingestion-server"],
      },
    );
    const result = await enrichLogLabels([svc("ingestion-server")], mcp, "loki-uid");
    expect(result[0]!.logLabels).toEqual({ app_fortidata_name: "ingestion-server" });
  });

  it("skips services that already have logLabels", async () => {
    const existing: ServiceConfig = { name: "my-svc", metrics: [], logLabels: { custom: "val" } };
    const mcp = mockMcpForLabels(
      ["app_fortidata_name"],
      { app_fortidata_name: ["my-svc"] },
    );
    const result = await enrichLogLabels([existing], mcp, "loki-uid");
    expect(result[0]!.logLabels).toEqual({ custom: "val" });
  });

  it("leaves logLabels empty when no match found", async () => {
    const mcp = mockMcpForLabels(
      ["app_fortidata_name"],
      { app_fortidata_name: ["some-other-service"] },
    );
    const result = await enrichLogLabels([svc("unknown-svc")], mcp, "loki-uid");
    expect(result[0]!.logLabels).toEqual({});
  });

  it("matches container_name when service name is a substring", async () => {
    const mcp = mockMcpForLabels(
      ["container_name"],
      { container_name: ["clickhouse", "kafka", "stolon"] },
    );
    const result = await enrichLogLabels([svc("ch-clickhouse")], mcp, "loki-uid");
    expect(result[0]!.logLabels).toEqual({ container_name: "clickhouse" });
  });

  it("handles multiple services with different label keys", async () => {
    const mcp = mockMcpForLabels(
      ["app_fortidata_name", "container_name", "job"],
      {
        app_fortidata_name: ["ingestion-server"],
        container_name: ["clickhouse", "stolon"],
        job: ["db/ch-clickhouse-shard0"],
      },
    );
    const services = [svc("ingestion-server"), svc("stolon-proxy"), svc("no-match")];
    const result = await enrichLogLabels(services, mcp, "loki-uid");
    expect(result[0]!.logLabels).toEqual({ app_fortidata_name: "ingestion-server" });
    expect(result[1]!.logLabels).toEqual({ container_name: "stolon" });
    expect(result[2]!.logLabels).toEqual({});
  });
});
