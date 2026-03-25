import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Tool } from "@mastra/core/tools";
import type { ProviderConfig, ProviderRole } from "../config/schema.js";

// ---------------------------------------------------------------------------
// Mock @mastra/mcp before importing provider.ts so MCPClient is replaced.
// We use a plain function (not vi.fn()) so it can be used as a constructor.
// Constructor calls are tracked via the `constructorCalls` array.
// ---------------------------------------------------------------------------
const constructorCalls: unknown[] = [];

vi.mock("@mastra/mcp", () => {
  function MCPClient(this: Record<string, unknown>, opts: unknown) {
    constructorCalls.push(opts);
    this["listTools"] = vi.fn().mockResolvedValue({});
    this["disconnect"] = vi.fn().mockResolvedValue(undefined);
  }
  return { MCPClient };
});

import { createMcpProvider, getToolsByRole, getAllTools, listProviderTools, classifyToolAccess } from "./provider.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeTool(description = "a tool"): Tool {
  return { description } as unknown as Tool;
}

function httpConfig(name: string, roles: ProviderRole[], enabledTools?: string[]): ProviderConfig {
  return {
    name,
    roles,
    mcpServer: { transport: "http", url: "http://localhost:8080/mcp", enabledTools },
  };
}

function stdioConfig(name: string, roles: ProviderRole[], enabledTools?: string[]): ProviderConfig {
  return {
    name,
    roles,
    mcpServer: {
      transport: "stdio",
      command: "npx",
      args: ["some-mcp-server"],
      env: { API_KEY: "test" },
      enabledTools,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("createMcpProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    constructorCalls.length = 0;
  });

  it("creates a provider with correct name and roles from HTTP config", () => {
    const config = httpConfig("grafana", ["metrics", "dashboards"]);
    const provider = createMcpProvider(config);

    expect(provider.name).toBe("grafana");
    expect(provider.roles).toEqual(["metrics", "dashboards"]);
    expect(provider.client).toBeDefined();
  });

  it("creates a provider with correct name and roles from stdio config", () => {
    const config = stdioConfig("loki", ["logs"]);
    const provider = createMcpProvider(config);

    expect(provider.name).toBe("loki");
    expect(provider.roles).toEqual(["logs"]);
    expect(provider.client).toBeDefined();
  });

  it("instantiates MCPClient with HTTP config using a URL object", () => {
    const config = httpConfig("grafana", ["metrics"]);
    createMcpProvider(config);

    expect(constructorCalls).toHaveLength(1);
    const callArgs = constructorCalls[0] as {
      id: string;
      servers: Record<string, { url: URL }>;
    };
    expect(callArgs.id).toBe("provider-grafana");
    const serverDef = callArgs.servers["grafana"];
    expect(serverDef.url).toBeInstanceOf(URL);
    expect(serverDef.url.toString()).toBe("http://localhost:8080/mcp");
  });

  it("instantiates MCPClient with stdio config including command and args", () => {
    const config = stdioConfig("loki", ["logs"]);
    createMcpProvider(config);

    expect(constructorCalls).toHaveLength(1);
    const callArgs = constructorCalls[0] as {
      id: string;
      servers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    const serverDef = callArgs.servers["loki"];
    expect(serverDef.command).toBe("npx");
    expect(serverDef.args).toEqual(["some-mcp-server"]);
    expect(serverDef.env).toEqual({ API_KEY: "test" });
  });

  it("preserves enabledTools on the provider wrapper", () => {
    const provider = createMcpProvider(httpConfig("grafana", ["metrics"], ["query_prometheus"]));
    expect(provider.enabledTools).toEqual(["query_prometheus"]);
  });
});

describe("listProviderTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    constructorCalls.length = 0;
  });

  it("filters namespaced tools to the enabledTools allow-list", async () => {
    const provider = createMcpProvider(httpConfig("grafana", ["metrics"], ["query_prometheus"]));
    const queryTool = makeTool("query");
    const imageTool = makeTool("image");

    (provider.client.listTools as ReturnType<typeof vi.fn>).mockResolvedValue({
      grafana_query_prometheus: queryTool,
      grafana_get_panel_image: imageTool,
    });

    const result = await listProviderTools(provider);
    expect(result).toEqual({
      grafana_query_prometheus: queryTool,
    });
  });

  it("returns all tools when no enabledTools filter is configured", async () => {
    const provider = createMcpProvider(httpConfig("grafana", ["metrics"]));
    const queryTool = makeTool("query");
    const imageTool = makeTool("image");

    (provider.client.listTools as ReturnType<typeof vi.fn>).mockResolvedValue({
      grafana_query_prometheus: queryTool,
      grafana_get_panel_image: imageTool,
    });

    const result = await listProviderTools(provider);
    expect(result).toEqual({
      grafana_query_prometheus: queryTool,
      grafana_get_panel_image: imageTool,
    });
  });
});

describe("getToolsByRole", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    constructorCalls.length = 0;
  });

  it("returns empty record when no providers match the role", async () => {
    const grafana = createMcpProvider(httpConfig("grafana", ["metrics"]));
    const result = await getToolsByRole([grafana], "logs");
    expect(result).toEqual({});
  });

  it("returns tools only from providers that match the role", async () => {
    const grafanaTool = makeTool("grafana-tool");
    const lokiTool = makeTool("loki-tool");

    const grafana = createMcpProvider(httpConfig("grafana", ["metrics"]));
    const loki = createMcpProvider(httpConfig("loki", ["logs"]));

    (grafana.client.listTools as ReturnType<typeof vi.fn>).mockResolvedValue({
      grafana_query: grafanaTool,
    });
    (loki.client.listTools as ReturnType<typeof vi.fn>).mockResolvedValue({
      loki_query: lokiTool,
    });

    const result = await getToolsByRole([grafana, loki], "metrics");
    expect(result).toEqual({ grafana_query: grafanaTool });
    expect(result).not.toHaveProperty("loki_query");
  });

  it("returns empty record when providers list is empty", async () => {
    const result = await getToolsByRole([], "metrics");
    expect(result).toEqual({});
  });

  it("merges tools from multiple providers with the same role", async () => {
    const toolA = makeTool("tool-a");
    const toolB = makeTool("tool-b");

    const providerA = createMcpProvider(httpConfig("providerA", ["metrics"]));
    const providerB = createMcpProvider(httpConfig("providerB", ["metrics"]));

    (providerA.client.listTools as ReturnType<typeof vi.fn>).mockResolvedValue({ tool_a: toolA });
    (providerB.client.listTools as ReturnType<typeof vi.fn>).mockResolvedValue({ tool_b: toolB });

    const result = await getToolsByRole([providerA, providerB], "metrics");
    expect(result).toHaveProperty("tool_a");
    expect(result).toHaveProperty("tool_b");
  });

  it("respects enabledTools when merging role-matched providers", async () => {
    const provider = createMcpProvider(httpConfig("grafana", ["metrics"], ["query_prometheus"]));
    const queryTool = makeTool("query");
    const imageTool = makeTool("image");

    (provider.client.listTools as ReturnType<typeof vi.fn>).mockResolvedValue({
      grafana_query_prometheus: queryTool,
      grafana_get_panel_image: imageTool,
    });

    const result = await getToolsByRole([provider], "metrics");
    expect(result).toEqual({
      grafana_query_prometheus: queryTool,
    });
  });
});

describe("getAllTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    constructorCalls.length = 0;
  });

  it("returns empty record when no providers given", async () => {
    const result = await getAllTools([]);
    expect(result).toEqual({});
  });

  it("collects tools from all providers regardless of role", async () => {
    const grafanaTool = makeTool("grafana-tool");
    const lokiTool = makeTool("loki-tool");

    const grafana = createMcpProvider(httpConfig("grafana", ["metrics"]));
    const loki = createMcpProvider(httpConfig("loki", ["logs"]));

    (grafana.client.listTools as ReturnType<typeof vi.fn>).mockResolvedValue({
      grafana_query: grafanaTool,
    });
    (loki.client.listTools as ReturnType<typeof vi.fn>).mockResolvedValue({
      loki_query: lokiTool,
    });

    const result = await getAllTools([grafana, loki]);
    expect(result).toHaveProperty("grafana_query");
    expect(result).toHaveProperty("loki_query");
  });

  it("merges tools from a single provider", async () => {
    const toolA = makeTool("tool-a");
    const toolB = makeTool("tool-b");

    const grafana = createMcpProvider(httpConfig("grafana", ["metrics", "dashboards"]));
    (grafana.client.listTools as ReturnType<typeof vi.fn>).mockResolvedValue({
      tool_a: toolA,
      tool_b: toolB,
    });

    const result = await getAllTools([grafana]);
    expect(Object.keys(result)).toHaveLength(2);
  });

  it("filters getAllTools to enabledTools when configured", async () => {
    const provider = createMcpProvider(httpConfig("grafana", ["metrics", "dashboards"], ["query_prometheus"]));
    const queryTool = makeTool("tool-a");
    const imageTool = makeTool("tool-b");

    (provider.client.listTools as ReturnType<typeof vi.fn>).mockResolvedValue({
      grafana_query_prometheus: queryTool,
      grafana_get_panel_image: imageTool,
    });

    const result = await getAllTools([provider]);
    expect(result).toEqual({
      grafana_query_prometheus: queryTool,
    });
  });
});
