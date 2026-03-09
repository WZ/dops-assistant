import { describe, it, expect, vi, beforeEach } from "vitest";
import { MultiMcpClient } from "./multi-client.js";
import type { ProviderEntry } from "./multi-client.js";
import type { McpClient, OpenAITool, ToolResult } from "./client.js";
import type { ProviderRole } from "../config/schema.js";

/** Helper to create a mock McpClient with configurable tools. */
function mockMcpClient(tools: OpenAITool[]): McpClient {
  let connected = false;
  return {
    connect: vi.fn(async () => { connected = true; }),
    disconnect: vi.fn(async () => { connected = false; }),
    isConnected: vi.fn(() => connected),
    getTools: vi.fn(() => tools),
    callTool: vi.fn(async (_name: string, _args: Record<string, unknown>): Promise<ToolResult> => ({
      text: `result from ${_name}`,
      images: [],
    })),
  } as unknown as McpClient;
}

function tool(name: string, description = ""): OpenAITool {
  return {
    type: "function",
    function: { name, description, parameters: {} },
  };
}

describe("MultiMcpClient", () => {
  let grafanaClient: McpClient;
  let lokiClient: McpClient;
  let providers: ProviderEntry[];

  beforeEach(() => {
    grafanaClient = mockMcpClient([
      tool("query_prometheus", "Query Prometheus metrics"),
      tool("get_datasources", "List datasources"),
    ]);
    lokiClient = mockMcpClient([
      tool("query_loki", "Query Loki logs"),
      tool("list_labels", "List Loki labels"),
    ]);
    providers = [
      { name: "grafana", roles: ["metrics", "dashboards"] as ProviderRole[], client: grafanaClient },
      { name: "loki", roles: ["logs"] as ProviderRole[], client: lokiClient },
    ];
  });

  describe("connect / disconnect", () => {
    it("connects all providers in parallel", async () => {
      const multi = new MultiMcpClient(providers);
      await multi.connect();

      expect(grafanaClient.connect).toHaveBeenCalledTimes(1);
      expect(lokiClient.connect).toHaveBeenCalledTimes(1);
      expect(multi.isConnected()).toBe(true);
    });

    it("disconnects all providers", async () => {
      const multi = new MultiMcpClient(providers);
      await multi.connect();
      await multi.disconnect();

      expect(grafanaClient.disconnect).toHaveBeenCalledTimes(1);
      expect(lokiClient.disconnect).toHaveBeenCalledTimes(1);
      expect(multi.isConnected()).toBe(false);
    });

    it("rolls back successful connections on partial failure", async () => {
      const failClient = mockMcpClient([]);
      (failClient.connect as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("connection refused"));

      const partialProviders: ProviderEntry[] = [
        { name: "grafana", roles: ["metrics"] as ProviderRole[], client: grafanaClient },
        { name: "failing", roles: ["logs"] as ProviderRole[], client: failClient },
      ];

      const multi = new MultiMcpClient(partialProviders);
      await expect(multi.connect()).rejects.toThrow(/failed to connect/);

      // The successful provider should have been disconnected
      expect(grafanaClient.disconnect).toHaveBeenCalledTimes(1);
    });

    it("isConnected returns false if any provider is not connected", async () => {
      const multi = new MultiMcpClient(providers);
      await multi.connect();

      // Disconnect just one provider
      await lokiClient.disconnect();

      expect(multi.isConnected()).toBe(false);
    });
  });

  describe("tool merging", () => {
    it("merges tools from all providers", async () => {
      const multi = new MultiMcpClient(providers);
      await multi.connect();
      const tools = multi.getTools();

      expect(tools).toHaveLength(4);
      const names = tools.map((t) => t.function.name);
      expect(names).toContain("query_prometheus");
      expect(names).toContain("get_datasources");
      expect(names).toContain("query_loki");
      expect(names).toContain("list_labels");
    });
  });

  describe("tool routing", () => {
    it("routes callTool to the owning provider", async () => {
      const multi = new MultiMcpClient(providers);
      await multi.connect();

      await multi.callTool("query_prometheus", { query: "up" });
      expect(grafanaClient.callTool).toHaveBeenCalledWith("query_prometheus", { query: "up" });
      expect(lokiClient.callTool).not.toHaveBeenCalled();

      await multi.callTool("query_loki", { query: '{job="api"}' });
      expect(lokiClient.callTool).toHaveBeenCalledWith("query_loki", { query: '{job="api"}' });
    });

    it("throws on unknown tool name", async () => {
      const multi = new MultiMcpClient(providers);
      await multi.connect();

      await expect(multi.callTool("nonexistent_tool", {})).rejects.toThrow(
        /unknown tool.*nonexistent_tool/i,
      );
    });
  });

  describe("collision handling", () => {
    it("prefixes tool names on collision", async () => {
      const clientA = mockMcpClient([tool("shared_tool", "From A")]);
      const clientB = mockMcpClient([tool("shared_tool", "From B")]);
      const collisionProviders: ProviderEntry[] = [
        { name: "providerA", roles: ["metrics"] as ProviderRole[], client: clientA },
        { name: "providerB", roles: ["logs"] as ProviderRole[], client: clientB },
      ];

      const multi = new MultiMcpClient(collisionProviders);
      await multi.connect();
      const tools = multi.getTools();

      expect(tools).toHaveLength(2);
      const names = tools.map((t) => t.function.name);
      expect(names).toContain("providerA__shared_tool");
      expect(names).toContain("providerB__shared_tool");
    });

    it("routes prefixed tool name to correct provider, stripping prefix", async () => {
      const clientA = mockMcpClient([tool("shared_tool", "From A")]);
      const clientB = mockMcpClient([tool("shared_tool", "From B")]);
      const collisionProviders: ProviderEntry[] = [
        { name: "providerA", roles: ["metrics"] as ProviderRole[], client: clientA },
        { name: "providerB", roles: ["logs"] as ProviderRole[], client: clientB },
      ];

      const multi = new MultiMcpClient(collisionProviders);
      await multi.connect();

      await multi.callTool("providerA__shared_tool", { foo: "bar" });
      expect(clientA.callTool).toHaveBeenCalledWith("shared_tool", { foo: "bar" });
      expect(clientB.callTool).not.toHaveBeenCalled();

      await multi.callTool("providerB__shared_tool", { baz: 42 });
      expect(clientB.callTool).toHaveBeenCalledWith("shared_tool", { baz: 42 });
    });

    it("does not prefix when no collision", async () => {
      const multi = new MultiMcpClient(providers);
      await multi.connect();
      const tools = multi.getTools();
      const names = tools.map((t) => t.function.name);

      // None should have a collision prefix
      for (const name of names) {
        expect(name).not.toContain("__");
      }
    });
  });

  describe("role-based queries", () => {
    it("returns providers by role", async () => {
      const multi = new MultiMcpClient(providers);
      await multi.connect();

      const metricsProviders = multi.getProvidersByRole("metrics");
      expect(metricsProviders).toHaveLength(1);
      expect(metricsProviders[0].name).toBe("grafana");

      const logsProviders = multi.getProvidersByRole("logs");
      expect(logsProviders).toHaveLength(1);
      expect(logsProviders[0].name).toBe("loki");
    });

    it("returns tools filtered by role", async () => {
      const multi = new MultiMcpClient(providers);
      await multi.connect();

      const metricsTools = multi.getToolsByRole("metrics");
      expect(metricsTools).toHaveLength(2);
      const names = metricsTools.map((t) => t.function.name);
      expect(names).toContain("query_prometheus");
      expect(names).toContain("get_datasources");

      const logsTools = multi.getToolsByRole("logs");
      expect(logsTools).toHaveLength(2);
      const logNames = logsTools.map((t) => t.function.name);
      expect(logNames).toContain("query_loki");
      expect(logNames).toContain("list_labels");
    });

    it("hasRole returns true if any provider has the role", async () => {
      const multi = new MultiMcpClient(providers);

      expect(multi.hasRole("metrics")).toBe(true);
      expect(multi.hasRole("logs")).toBe(true);
      expect(multi.hasRole("dashboards")).toBe(true);
      expect(multi.hasRole("dependencies")).toBe(false);
    });

    it("returns empty arrays for roles with no providers", async () => {
      const multi = new MultiMcpClient(providers);
      await multi.connect();

      expect(multi.getProvidersByRole("dependencies")).toEqual([]);
      expect(multi.getToolsByRole("dependencies")).toEqual([]);
    });
  });

  describe("edge cases", () => {
    it("works with a single provider", async () => {
      const singleProvider: ProviderEntry[] = [
        { name: "grafana", roles: ["metrics", "logs"] as ProviderRole[], client: grafanaClient },
      ];
      const multi = new MultiMcpClient(singleProvider);
      await multi.connect();

      expect(multi.getTools()).toHaveLength(2);
      expect(multi.isConnected()).toBe(true);

      await multi.callTool("query_prometheus", {});
      expect(grafanaClient.callTool).toHaveBeenCalledWith("query_prometheus", {});
    });

    it("works with zero providers", async () => {
      const multi = new MultiMcpClient([]);
      await multi.connect();

      expect(multi.getTools()).toHaveLength(0);
      expect(multi.isConnected()).toBe(true);
    });

    it("rebuilds tool index on connect", async () => {
      const multi = new MultiMcpClient(providers);
      await multi.connect();

      const tools = multi.getTools();
      expect(tools).toHaveLength(4);
    });
  });
});
