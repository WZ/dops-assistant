import { describe, it, expect } from "vitest";
import { ConfigSchema } from "./schema.js";

/** Minimal valid LLM config for reuse in tests */
const llm = { apiKey: "k", model: "gpt-4", maxTokens: 1000 };

/** Minimal valid MCP server config */
const stdioMcp = { transport: "stdio" as const, command: "npx", args: [] };

describe("ConfigSchema – new sections", () => {
  it("applies default values for timeouts, retry, and observability", () => {
    const result = ConfigSchema.parse({
      llm,
      grafana: { mcpServer: stdioMcp },
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
      llm,
      grafana: { mcpServer: stdioMcp },
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

describe("ConfigSchema – providers array", () => {
  it("accepts a providers array with roles", () => {
    const result = ConfigSchema.safeParse({
      llm,
      providers: [
        {
          name: "grafana-cloud",
          roles: ["metrics", "logs"],
          mcpServer: stdioMcp,
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.providers).toHaveLength(1);
      expect(result.data.providers[0].name).toBe("grafana-cloud");
      expect(result.data.providers[0].roles).toEqual(["metrics", "logs"]);
    }
  });

  it("accepts multiple providers", () => {
    const result = ConfigSchema.safeParse({
      llm,
      providers: [
        {
          name: "grafana-cloud",
          roles: ["metrics", "dashboards"],
          mcpServer: stdioMcp,
        },
        {
          name: "loki-server",
          roles: ["logs"],
          mcpServer: { transport: "http", url: "http://localhost:3100/mcp" },
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.providers).toHaveLength(2);
      expect(result.data.providers[0].name).toBe("grafana-cloud");
      expect(result.data.providers[1].name).toBe("loki-server");
      expect(result.data.providers[1].roles).toEqual(["logs"]);
    }
  });

  it("rejects providers with no roles (empty array)", () => {
    const result = ConfigSchema.safeParse({
      llm,
      providers: [
        {
          name: "grafana-cloud",
          roles: [],
          mcpServer: stdioMcp,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("backward compat: transforms grafana key into providers array", () => {
    const result = ConfigSchema.safeParse({
      llm,
      grafana: { mcpServer: stdioMcp },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.providers).toHaveLength(1);
      expect(result.data.providers[0].name).toBe("grafana");
      expect(result.data.providers[0].roles).toEqual([
        "metrics",
        "logs",
        "dashboards",
        "dependencies",
      ]);
      expect(result.data.providers[0].mcpServer).toEqual(
        expect.objectContaining({ transport: "stdio", command: "npx" })
      );
    }
  });

  it("rejects config with neither grafana nor providers", () => {
    const result = ConfigSchema.safeParse({ llm });
    expect(result.success).toBe(false);
  });

  it("prefers providers over grafana when both are given", () => {
    const result = ConfigSchema.safeParse({
      llm,
      grafana: { mcpServer: stdioMcp },
      providers: [
        {
          name: "custom",
          roles: ["metrics"],
          mcpServer: { transport: "http", url: "http://localhost:8080/mcp" },
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // providers takes precedence; grafana is ignored
      expect(result.data.providers).toHaveLength(1);
      expect(result.data.providers[0].name).toBe("custom");
    }
  });
});
