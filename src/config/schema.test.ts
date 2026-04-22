import { describe, it, expect } from "vitest";
import { ConfigSchema } from "./schema.js";

/** Minimal valid LLM config for reuse in tests */
const llm = { apiKey: "k", model: "gpt-4", maxTokens: 1000 };

/** Minimal valid MCP server config */
const stdioMcp = { transport: "stdio" as const, command: "npx", args: [] };

/** Minimal valid provider */
const grafanaProvider = {
  name: "grafana",
  roles: ["metrics", "logs", "dashboards"] as const,
  mcpServer: stdioMcp,
};

describe("ConfigSchema – defaults", () => {
  it("applies default values for timeouts, retry, and observability", () => {
    const result = ConfigSchema.parse({
      llm,
      providers: [grafanaProvider],
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
      providers: [grafanaProvider],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agent.investigationTriggerPhrases).toContain("investigate");
    }
  });

  it("accepts serviceAliases config", () => {
    const result = ConfigSchema.safeParse({
      llm,
      providers: [grafanaProvider],
      serviceAliases: {
        pg: ["stolon-proxy"],
        mykafka: ["kafka-brokers", "kafka-bootstrap"],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.serviceAliases).toEqual({
        pg: ["stolon-proxy"],
        mykafka: ["kafka-brokers", "kafka-bootstrap"],
      });
    }
  });

  it("defaults serviceAliases to empty object when absent", () => {
    const result = ConfigSchema.safeParse({
      llm,
      providers: [grafanaProvider],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.serviceAliases).toEqual({});
    }
  });

  it("accepts discovery config with defaults", () => {
    const result = ConfigSchema.safeParse({
      llm,
      providers: [grafanaProvider],
      discovery: {
        excludeServices: ["consul", "prometheus"],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.discovery.autoRefresh).toBe(false);
      expect(result.data.discovery.excludeServices).toEqual(["consul", "prometheus"]);
    }
  });
});

describe("ConfigSchema – providers", () => {
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

  it("accepts config with no providers (defaults to empty array)", () => {
    const result = ConfigSchema.safeParse({ llm });
    expect(result.success).toBe(true);
  });

  it("accepts config with empty providers array (GUI providers supplement)", () => {
    const result = ConfigSchema.safeParse({ llm, providers: [] });
    expect(result.success).toBe(true);
  });

  it("rejects provider name with invalid characters", () => {
    const result = ConfigSchema.safeParse({
      llm,
      providers: [{ name: "grafana cloud!", roles: ["metrics"], mcpServer: stdioMcp }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate provider names", () => {
    const result = ConfigSchema.safeParse({
      llm,
      providers: [
        { name: "grafana", roles: ["metrics"], mcpServer: stdioMcp },
        { name: "grafana", roles: ["logs"], mcpServer: stdioMcp },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts provider with webUrl", () => {
    const result = ConfigSchema.safeParse({
      llm,
      providers: [
        {
          name: "grafana",
          roles: ["metrics", "dashboards"],
          mcpServer: stdioMcp,
          webUrl: "https://grafana.internal:3000",
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.providers[0].webUrl).toBe("https://grafana.internal:3000");
    }
  });

  it("accepts provider without webUrl", () => {
    const result = ConfigSchema.safeParse({
      llm,
      providers: [grafanaProvider],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.providers[0].webUrl).toBeUndefined();
    }
  });

  it("rejects provider with invalid webUrl", () => {
    const result = ConfigSchema.safeParse({
      llm,
      providers: [
        {
          name: "grafana",
          roles: ["metrics"],
          mcpServer: stdioMcp,
          webUrl: "not-a-url",
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("ConfigSchema – scan section", () => {
  it("scan is disabled by default when section is omitted", () => {
    const result = ConfigSchema.parse({ llm, providers: [grafanaProvider] });
    expect(result.scan.enabled).toBe(false);
    expect(result.scan.cron).toBe("0 */4 * * *");
    expect(result.scan.timezone).toBe("UTC");
    expect(result.scan.maxInvestigationsPerTick).toBe(5);
    expect(result.scan.investigationTemplate).toBe("standard");
    expect(result.scan.runOnEnable).toBe(true);
    expect(result.scan.dedupWindowMinutes).toBe(30);
  });

  it("applies nested probe defaults", () => {
    const result = ConfigSchema.parse({ llm, providers: [grafanaProvider] });
    expect(result.scan.probe.concurrency).toBe(8);
    expect(result.scan.probe.queryTimeoutMs).toBe(3_000);
    expect(result.scan.probe.metrics.length).toBe(3);
    expect(result.scan.probe.metrics[0]!.name).toBe("availability");
    expect(result.scan.probe.metrics[0]!.threshold).toEqual({ op: "lt", value: 1 });
    expect(result.scan.probe.metrics[0]!.consecutiveTicks).toBe(1);
    expect(result.scan.probe.metrics[1]!.consecutiveTicks).toBe(2);
    expect(result.scan.probe.logs.enabled).toBe(true);
    expect(result.scan.probe.logs.errorRateThreshold).toBe(10);
  });

  it("accepts overrides at any depth", () => {
    const result = ConfigSchema.parse({
      llm,
      providers: [grafanaProvider],
      scan: {
        enabled: true,
        cron: "*/15 * * * *",
        timezone: "America/New_York",
        maxInvestigationsPerTick: 3,
        runOnEnable: false,
        probe: {
          concurrency: 4,
          metrics: [
            {
              name: "custom",
              query: "custom_metric",
              threshold: { op: "gte", value: 100 },
              consecutiveTicks: 5,
            },
          ],
          logs: { enabled: false, window: "5m", errorRateThreshold: 50, consecutiveTicks: 1 },
        },
      },
    });
    expect(result.scan.enabled).toBe(true);
    expect(result.scan.cron).toBe("*/15 * * * *");
    expect(result.scan.timezone).toBe("America/New_York");
    expect(result.scan.maxInvestigationsPerTick).toBe(3);
    expect(result.scan.runOnEnable).toBe(false);
    expect(result.scan.probe.concurrency).toBe(4);
    expect(result.scan.probe.metrics).toHaveLength(1);
    expect(result.scan.probe.metrics[0]!.threshold).toEqual({ op: "gte", value: 100 });
    expect(result.scan.probe.metrics[0]!.consecutiveTicks).toBe(5);
    expect(result.scan.probe.logs.enabled).toBe(false);
  });

  it("rejects consecutiveTicks below 1", () => {
    const result = ConfigSchema.safeParse({
      llm,
      providers: [grafanaProvider],
      scan: {
        probe: {
          metrics: [
            {
              name: "x",
              query: "q",
              threshold: { op: "gt", value: 0 },
              consecutiveTicks: 0,
            },
          ],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid threshold op", () => {
    const result = ConfigSchema.safeParse({
      llm,
      providers: [grafanaProvider],
      scan: {
        probe: {
          metrics: [{ name: "x", query: "q", threshold: { op: "eq", value: 1 } }],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects queryTimeoutMs below 100", () => {
    const result = ConfigSchema.safeParse({
      llm,
      providers: [grafanaProvider],
      scan: { probe: { queryTimeoutMs: 50 } },
    });
    expect(result.success).toBe(false);
  });
});

describe("ConfigSchema — notifications.email", () => {
  const base = {
    llm,
    providers: [grafanaProvider],
  };

  it("accepts a valid notifications.email config", () => {
    const result = ConfigSchema.safeParse({
      ...base,
      notifications: {
        email: {
          enabled: false,
          smtp: {
            host: "smtp.example.com",
            port: 587,
            secure: false,
            user: "u",
            pass: "p",
          },
          from: "DOps <dops@example.com>",
          appBaseUrl: "https://dops.example.com/",
          retry: { attempts: 4, backoffMs: [1000, 5000, 30000] },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("defaults the whole notifications section to undefined", () => {
    const result = ConfigSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.notifications?.email).toBeUndefined();
    }
  });

  it("rejects when backoffMs.length !== attempts - 1", () => {
    const result = ConfigSchema.safeParse({
      ...base,
      notifications: {
        email: {
          smtp: { host: "x", port: 587, user: "u", pass: "p" },
          from: "x@example.com",
          appBaseUrl: "https://x.example.com/",
          retry: { attempts: 4, backoffMs: [1000, 5000] },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid smtp.port", () => {
    const result = ConfigSchema.safeParse({
      ...base,
      notifications: {
        email: {
          smtp: { host: "x", port: 99999, user: "u", pass: "p" },
          from: "x@example.com",
          appBaseUrl: "https://x.example.com/",
        },
      },
    });
    expect(result.success).toBe(false);
  });
});
