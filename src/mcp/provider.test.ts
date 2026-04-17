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

import { createMcpProvider, getToolsByRole, getAllTools, listProviderTools, classifyToolAccess, filterToReadOnlyTools, DEFAULT_MCP_CONNECT_TIMEOUT_MS } from "./provider.js";

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

  it("threads connectTimeout onto the HTTP server definition", () => {
    createMcpProvider(httpConfig("grafana", ["metrics"]), 45_000);
    const callArgs = constructorCalls[0] as {
      servers: Record<string, { url: URL; connectTimeout?: number }>;
    };
    expect(callArgs.servers["grafana"]?.connectTimeout).toBe(45_000);
  });

  // Stdio uses `timeout` (from BaseServerOptions), HTTP uses `connectTimeout`.
  // `StdioServerDefinition` types `connectTimeout` as `never`; `timeout` is the
  // value @mastra/mcp reads for the stdio connect phase.
  it("threads the connect timeout onto the stdio server definition as `timeout`", () => {
    createMcpProvider(stdioConfig("loki", ["logs"]), 45_000);
    const callArgs = constructorCalls[0] as {
      servers: Record<string, { command: string; timeout?: number }>;
    };
    expect(callArgs.servers["loki"]?.timeout).toBe(45_000);
  });

  // REGRESSION (IRON RULE): default timeout must stay at 30s, not regress to
  // the @mastra/mcp built-in 3s default that causes spurious failures in QA.
  it("uses a 30s default connectTimeout when none is provided", () => {
    createMcpProvider(httpConfig("grafana", ["metrics"]));
    const callArgs = constructorCalls[0] as {
      servers: Record<string, { url: URL; connectTimeout?: number }>;
    };
    expect(DEFAULT_MCP_CONNECT_TIMEOUT_MS).toBe(30_000);
    expect(callArgs.servers["grafana"]?.connectTimeout).toBe(30_000);
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

describe("classifyToolAccess", () => {
  it("classifies get_ prefixed tools as read", () => {
    expect(classifyToolAccess("get_dashboard_by_uid")).toBe("read");
  });
  it("classifies list_ prefixed tools as read", () => {
    expect(classifyToolAccess("list_datasources")).toBe("read");
  });
  it("classifies query_ prefixed tools as read", () => {
    expect(classifyToolAccess("query_prometheus")).toBe("read");
  });
  it("classifies search_ prefixed tools as read", () => {
    expect(classifyToolAccess("search_dashboards")).toBe("read");
  });
  it("classifies create_ prefixed tools as write", () => {
    expect(classifyToolAccess("create_dashboard")).toBe("write");
  });
  it("classifies update_ prefixed tools as write", () => {
    expect(classifyToolAccess("update_alert_rule")).toBe("write");
  });
  it("classifies delete_ prefixed tools as write", () => {
    expect(classifyToolAccess("delete_dashboard")).toBe("write");
  });
  it("classifies unknown prefixes as write (safe default)", () => {
    expect(classifyToolAccess("run_migration")).toBe("write");
  });
  it("is case-insensitive", () => {
    expect(classifyToolAccess("GET_dashboard")).toBe("read");
    expect(classifyToolAccess("Query_Prometheus")).toBe("read");
  });

  // K8s MCP uses entity_verb naming (pods_list, nodes_log, etc.)
  it("classifies _list suffixed tools as read", () => {
    expect(classifyToolAccess("pods_list")).toBe("read");
    expect(classifyToolAccess("events_list")).toBe("read");
    expect(classifyToolAccess("namespaces_list")).toBe("read");
    expect(classifyToolAccess("resources_list")).toBe("read");
    expect(classifyToolAccess("pods_list_in_namespace")).toBe("read");
  });
  it("classifies _get suffixed tools as read", () => {
    expect(classifyToolAccess("pods_get")).toBe("read");
    expect(classifyToolAccess("resources_get")).toBe("read");
  });
  it("classifies _log/_logs suffixed tools as read", () => {
    expect(classifyToolAccess("pods_log")).toBe("read");
    expect(classifyToolAccess("nodes_log")).toBe("read");
  });
  it("classifies _top/_stats/_summary suffixed tools as read", () => {
    expect(classifyToolAccess("pods_top")).toBe("read");
    expect(classifyToolAccess("nodes_top")).toBe("read");
    expect(classifyToolAccess("nodes_stats_summary")).toBe("read");
  });
  it("classifies configuration_view as read (exact match)", () => {
    expect(classifyToolAccess("configuration_view")).toBe("read");
  });

  // Write-keyword denylist — write keywords take priority over read keywords
  it("classifies ambiguous names with write keywords as write", () => {
    // "delete" write keyword overrides "list" read keyword
    expect(classifyToolAccess("pods_delete_list")).toBe("write");
    // "create" write keyword even with "readonly" in the name
    expect(classifyToolAccess("create_readonly_snapshot")).toBe("write");
  });

  it("classifies all write-keyword denylist entries correctly", () => {
    // Every write keyword should force "write" classification
    const writeKeywords = [
      "delete", "create", "update", "modify", "remove",
      "patch", "put", "write", "set", "add",
      "drop", "kill", "stop", "restart", "scale",
      "exec", "run", "apply", "deploy",
    ];
    for (const keyword of writeKeywords) {
      expect(classifyToolAccess(`pods_${keyword}`)).toBe("write");
      expect(classifyToolAccess(`${keyword}_something`)).toBe("write");
    }
  });

  it("does not regress existing read classifications", () => {
    // Comprehensive regression check — all of these must remain "read"
    const readTools = [
      "get_dashboard_by_uid", "list_datasources", "query_prometheus",
      "search_dashboards", "pods_list", "pods_get", "pods_log",
      "nodes_log", "pods_top", "nodes_top", "nodes_stats_summary",
      "pods_list_in_namespace", "events_list", "namespaces_list",
      "resources_list", "resources_get", "configuration_view",
      "get_metrics", "list_pods", "describe_pod", "check_health",
      "fetch_logs", "lookup_service", "count_pods", "show_dashboard",
      "find_errors", "read_config",
    ];
    for (const tool of readTools) {
      expect(classifyToolAccess(tool)).toBe("read");
    }
  });
});

describe("filterToReadOnlyTools", () => {
  it("filters out write tools and keeps read tools", () => {
    const tools: Record<string, Tool> = {
      list_pods: makeTool("list pods"),
      get_metrics: makeTool("get metrics"),
      delete_pod: makeTool("delete pod"),
      create_dashboard: makeTool("create dashboard"),
      query_prometheus: makeTool("query prometheus"),
    };

    const filtered = filterToReadOnlyTools(tools);
    expect(Object.keys(filtered).sort()).toEqual(["get_metrics", "list_pods", "query_prometheus"]);
  });

  it("returns a new object, does not mutate the input", () => {
    const tools: Record<string, Tool> = {
      list_pods: makeTool("list pods"),
      delete_pod: makeTool("delete pod"),
    };
    const originalKeys = Object.keys(tools);
    const filtered = filterToReadOnlyTools(tools);

    // Input unchanged
    expect(Object.keys(tools)).toEqual(originalKeys);
    // Result is a different object
    expect(filtered).not.toBe(tools);
    // Write tool removed from result
    expect(filtered).not.toHaveProperty("delete_pod");
    // Read tool kept
    expect(filtered).toHaveProperty("list_pods");
  });

  it("returns empty record when all tools are write", () => {
    const tools: Record<string, Tool> = {
      deploy_service: makeTool("deploy"),
      kill_process: makeTool("kill"),
    };
    const filtered = filterToReadOnlyTools(tools);
    expect(Object.keys(filtered)).toHaveLength(0);
  });

  it("returns all tools when all are read-only", () => {
    const tools: Record<string, Tool> = {
      list_pods: makeTool("list"),
      get_metrics: makeTool("get"),
    };
    const filtered = filterToReadOnlyTools(tools);
    expect(Object.keys(filtered)).toHaveLength(2);
  });
});
