import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parse } from "yaml";
import type { ProviderConfig } from "../config/schema.js";
import type { MastraProvider } from "./provider.js";

// ---------------------------------------------------------------------------
// Mock createMcpProvider and listProviderTools from provider.ts
// ---------------------------------------------------------------------------
const mockCreateMcpProvider = vi.fn();
const mockListProviderTools = vi.fn();
const mockListAllProviderTools = vi.fn();
const mockGetToolsWithMetadata = vi.fn();
const mockComputeDefaultEnabledTools = vi.fn();

vi.mock("./provider.js", async (importOriginal) => {
  // Preserve `isMcpConnectionError` (and other pure helpers) — registry's
  // test() calls it synchronously to classify errors, and a missing export
  // would turn the error path into a thrown ReferenceError.
  const actual = await importOriginal<typeof import("./provider.js")>();
  return {
    ...actual,
    createMcpProvider: (...args: unknown[]) => mockCreateMcpProvider(...args),
    listProviderTools: (...args: unknown[]) => mockListProviderTools(...args),
    listAllProviderTools: (...args: unknown[]) => mockListAllProviderTools(...args),
    getToolsWithMetadata: (...args: unknown[]) => mockGetToolsWithMetadata(...args),
    computeDefaultEnabledTools: (...args: unknown[]) => mockComputeDefaultEnabledTools(...args),
  };
});

import { ProviderRegistry } from "./provider-registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeConfig(
  name: string,
  roles: ("metrics" | "logs" | "dashboards")[] = ["metrics"],
  enabledTools?: string[],
): ProviderConfig {
  return {
    name,
    roles,
    mcpServer: {
      transport: "http" as const,
      url: `http://localhost:8080/${name}`,
      ...(enabledTools !== undefined ? { enabledTools } : {}),
    },
  };
}

function makeFakeProvider(config: ProviderConfig): MastraProvider {
  return {
    name: config.name,
    roles: config.roles,
    client: { listTools: vi.fn() } as never,
    enabledTools: config.mcpServer.enabledTools,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("ProviderRegistry", () => {
  let dir: string;
  let providersPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), "provider-registry-test-"));
    providersPath = join(dir, "providers.yaml");

    // Default mocks: createMcpProvider returns a fake, listProviderTools
    // returns one tool. Tests that exercise the "0 tools = error" path
    // opt in by overriding mockListProviderTools to return {} themselves.
    mockCreateMcpProvider.mockImplementation((config: ProviderConfig) => makeFakeProvider(config));
    mockListProviderTools.mockResolvedValue({ default_tool: {} });
    mockListAllProviderTools.mockResolvedValue({ default_tool: {} });
    mockGetToolsWithMetadata.mockResolvedValue([]);
    mockComputeDefaultEnabledTools.mockReturnValue([]);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Constructor + initialize
  // -----------------------------------------------------------------------
  describe("constructor + initialize", () => {
    it("initializes with config providers and sets status", async () => {
      const configs = [makeConfig("grafana", ["metrics"]), makeConfig("loki", ["logs"])];
      mockListProviderTools.mockResolvedValue({ some_tool: {} });

      const registry = new ProviderRegistry(configs, providersPath);
      await registry.initialize();

      const all = registry.getAll();
      expect(all).toHaveLength(2);
      expect(all[0].config.name).toBe("grafana");
      expect(all[0].source).toBe("config");
      expect(all[0].status).toBe("connected");
      expect(all[0].toolCount).toBe(1);
      expect(all[1].config.name).toBe("loki");
      expect(all[1].source).toBe("config");
    });

    it("sets error status when listProviderTools fails during init", async () => {
      mockListProviderTools.mockRejectedValue(new Error("connection refused"));

      const registry = new ProviderRegistry([makeConfig("broken")], providersPath);
      await registry.initialize();

      const all = registry.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].status).toBe("error");
      expect(all[0].error).toBe("connection refused");
      expect(all[0].toolCount).toBe(0);
    });

    // Reclassify "connected with 0 tools" as an error because @mastra/mcp
    // silently swallows per-server connection failures inside listTools()
    // (see node_modules/@mastra/mcp/dist/index.js → MCPClient.listTools).
    // Without this, an unreachable upstream renders as a healthy green
    // dot in the UI and the chat path runs with an empty tool set.
    it("treats 0 tools after a 'successful' listTools as an error (init)", async () => {
      mockListProviderTools.mockResolvedValue({});
      mockListAllProviderTools.mockResolvedValue({});

      const registry = new ProviderRegistry([makeConfig("silent-fail")], providersPath);
      await registry.initialize();

      const all = registry.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].status).toBe("error");
      expect(all[0].toolCount).toBe(0);
      expect(all[0].error).toMatch(/no tools/i);
    });

    it("keeps a raw-reachable provider connected when all tools are intentionally disabled", async () => {
      mockListProviderTools.mockResolvedValue({});
      mockListAllProviderTools.mockResolvedValue({ grafana_query_prometheus: {} });

      const registry = new ProviderRegistry([makeConfig("grafana", ["metrics"], [])], providersPath);
      await registry.initialize();

      const info = registry.getAll()[0];
      expect(info?.status).toBe("connected");
      expect(info?.toolCount).toBe(1);
      expect(info?.enabledToolCount).toBe(0);
      expect(info?.provider.enabledTools).toEqual([]);
      expect(info?.toolNames).toEqual([]);
      expect(mockComputeDefaultEnabledTools).not.toHaveBeenCalled();
    });

    it("reports raw tool count separately from enabled tool count", async () => {
      mockListProviderTools.mockResolvedValue({ grafana_query_prometheus: {} });
      mockListAllProviderTools.mockResolvedValue({
        grafana_query_prometheus: {},
        grafana_get_panel_image: {},
      });

      const registry = new ProviderRegistry([makeConfig("grafana", ["metrics"], ["query_prometheus"])], providersPath);
      await registry.initialize();

      const info = registry.getAll()[0];
      expect(info?.status).toBe("connected");
      expect(info?.toolCount).toBe(2);
      expect(info?.enabledToolCount).toBe(1);
      expect(info?.toolNames).toEqual(["grafana_query_prometheus"]);
    });

    it("loads GUI providers from providers.yaml on initialize", async () => {
      const guiConfig = makeConfig("gui-grafana", ["dashboards"]);
      writeFileSync(
        providersPath,
        `- name: gui-grafana\n  roles: [dashboards]\n  mcpServer:\n    transport: http\n    url: http://localhost:8080/gui-grafana\n`,
      );

      const registry = new ProviderRegistry([], providersPath);
      await registry.initialize();

      const all = registry.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].config.name).toBe("gui-grafana");
      expect(all[0].source).toBe("gui");
    });

    it("skips GUI providers that conflict with config provider names", async () => {
      writeFileSync(
        providersPath,
        `- name: grafana\n  roles: [logs]\n  mcpServer:\n    transport: http\n    url: http://localhost:9090/alt\n`,
      );

      const registry = new ProviderRegistry([makeConfig("grafana", ["metrics"])], providersPath);
      await registry.initialize();

      const all = registry.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].source).toBe("config");
      expect(all[0].config.roles).toEqual(["metrics"]);
    });
  });

  // -----------------------------------------------------------------------
  // add()
  // -----------------------------------------------------------------------
  describe("add()", () => {
    it("creates provider, tests connection, and persists to file", async () => {
      mockListProviderTools.mockResolvedValue({ tool_a: {}, tool_b: {} });

      const registry = new ProviderRegistry([], providersPath);
      await registry.initialize();

      const info = await registry.add(makeConfig("new-provider", ["logs"]));

      expect(info.config.name).toBe("new-provider");
      expect(info.source).toBe("gui");
      expect(info.status).toBe("connected");
      expect(info.toolCount).toBe(2);

      // Verify persisted to file
      expect(existsSync(providersPath)).toBe(true);
      const raw = readFileSync(providersPath, "utf-8");
      const parsed = parse(raw) as unknown[];
      expect(parsed).toHaveLength(1);
      expect((parsed[0] as { name: string }).name).toBe("new-provider");
    });

    // Regression: a YAML import (or any add) of a provider whose MCP server is
    // unreachable used to block the request ~80s — each dead upstream waited
    // out a Streamable-HTTP→SSE transport cascade twice. The filtered probe
    // already returns the full tool set when enabledTools is undefined, so the
    // second raw re-probe is pure waste. It must not be issued.
    it("skips the redundant raw-tool re-probe when enabledTools is undefined", async () => {
      mockListProviderTools.mockResolvedValue({});

      const registry = new ProviderRegistry([], providersPath);
      await registry.initialize();
      mockListAllProviderTools.mockClear();

      const info = await registry.add(makeConfig("no-enabled-tools", ["logs"]));

      expect(mockListAllProviderTools).not.toHaveBeenCalled();
      expect(info.status).toBe("error");
      expect(info.toolCount).toBe(0);
    });

    // Regression: an unreachable upstream whose probe never settles must not
    // hang the registration (and therefore the import request) forever. The
    // probe is raced against PROBE_TIMEOUT_MS and the provider is persisted
    // with an error status that the periodic reconnect ticker later heals.
    it("bounds a never-settling probe with a timeout instead of hanging", async () => {
      vi.useFakeTimers();
      mockListProviderTools.mockReturnValue(new Promise(() => {}));

      const registry = new ProviderRegistry([], providersPath);
      await registry.initialize();

      const addPromise = registry.add(makeConfig("dead-upstream", ["logs"]));
      await vi.advanceTimersByTimeAsync(6_000);
      const info = await addPromise;

      expect(info.status).toBe("error");
      expect(info.error).toMatch(/timed out/i);
      expect(info.toolCount).toBe(0);
      vi.useRealTimers();
    });

    it("throws on duplicate name", async () => {
      const registry = new ProviderRegistry([makeConfig("grafana")], providersPath);
      await registry.initialize();

      await expect(registry.add(makeConfig("grafana"))).rejects.toThrow(
        "Provider name already exists",
      );
    });

    it("throws on duplicate name across GUI providers", async () => {
      const registry = new ProviderRegistry([], providersPath);
      await registry.initialize();
      await registry.add(makeConfig("my-provider"));

      await expect(registry.add(makeConfig("my-provider"))).rejects.toThrow(
        "Provider name already exists",
      );
    });
  });

  // -----------------------------------------------------------------------
  // remove()
  // -----------------------------------------------------------------------
  describe("remove()", () => {
    it("removes a GUI provider and persists", async () => {
      const registry = new ProviderRegistry([], providersPath);
      await registry.initialize();
      await registry.add(makeConfig("removable"));

      await registry.remove("removable");

      expect(registry.getAll()).toHaveLength(0);
      // File should exist but have no provider entries
      const raw = readFileSync(providersPath, "utf-8");
      expect(raw).toContain("Managed by dops-assistant");
    });

    it("throws when removing a config provider", async () => {
      const registry = new ProviderRegistry([makeConfig("grafana")], providersPath);
      await registry.initialize();

      await expect(registry.remove("grafana")).rejects.toThrow("Cannot remove system provider");
    });

    it("throws when removing non-existent provider", async () => {
      const registry = new ProviderRegistry([], providersPath);
      await registry.initialize();

      await expect(registry.remove("ghost")).rejects.toThrow("Provider not found");
    });
  });

  // -----------------------------------------------------------------------
  // update()
  // -----------------------------------------------------------------------
  describe("update()", () => {
    it("updates a GUI provider config", async () => {
      const registry = new ProviderRegistry([], providersPath);
      await registry.initialize();
      await registry.add(makeConfig("editable", ["metrics"]));

      const updated = await registry.update("editable", makeConfig("editable", ["logs"]));

      expect(updated.config.roles).toEqual(["logs"]);
      expect(updated.source).toBe("gui");
    });

    it("throws when updating a config provider", async () => {
      const registry = new ProviderRegistry([makeConfig("grafana")], providersPath);
      await registry.initialize();

      await expect(registry.update("grafana", makeConfig("grafana", ["logs"]))).rejects.toThrow(
        "Cannot update system provider",
      );
    });

    it("throws when updating to a name that already exists", async () => {
      const registry = new ProviderRegistry([], providersPath);
      await registry.initialize();
      await registry.add(makeConfig("provider-a"));
      await registry.add(makeConfig("provider-b"));

      await expect(
        registry.update("provider-a", makeConfig("provider-b")),
      ).rejects.toThrow("Provider name already exists");

      // Original should still be there
      expect(registry.getAll().find((i) => i.config.name === "provider-a")).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // getByRole()
  // -----------------------------------------------------------------------
  describe("getByRole()", () => {
    it("filters providers by role", async () => {
      const registry = new ProviderRegistry(
        [makeConfig("grafana", ["metrics"]), makeConfig("loki", ["logs"])],
        providersPath,
      );
      await registry.initialize();

      const metricsProviders = registry.getByRole("metrics");
      expect(metricsProviders).toHaveLength(1);
      expect(metricsProviders[0].name).toBe("grafana");

      const logsProviders = registry.getByRole("logs");
      expect(logsProviders).toHaveLength(1);
      expect(logsProviders[0].name).toBe("loki");
    });

    it("returns empty array when no providers match role", async () => {
      const registry = new ProviderRegistry([makeConfig("grafana", ["metrics"])], providersPath);
      await registry.initialize();

      expect(registry.getByRole("logs")).toEqual([]);
    });

    it("returns multiple providers when several share a role", async () => {
      const registry = new ProviderRegistry(
        [makeConfig("grafana-a", ["metrics"]), makeConfig("grafana-b", ["metrics"])],
        providersPath,
      );
      await registry.initialize();

      const providers = registry.getByRole("metrics");
      expect(providers).toHaveLength(2);
    });
  });

  // -----------------------------------------------------------------------
  // getProviders()
  // -----------------------------------------------------------------------
  describe("getProviders()", () => {
    it("returns flat array of all MastraProviders", async () => {
      const registry = new ProviderRegistry(
        [makeConfig("grafana"), makeConfig("loki", ["logs"])],
        providersPath,
      );
      await registry.initialize();

      const providers = registry.getProviders();
      expect(providers).toHaveLength(2);
      expect(providers[0].name).toBe("grafana");
      expect(providers[1].name).toBe("loki");
    });

    it("returns empty array when no providers registered", async () => {
      const registry = new ProviderRegistry([], providersPath);
      await registry.initialize();

      expect(registry.getProviders()).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // test()
  // -----------------------------------------------------------------------
  describe("test()", () => {
    it("returns ok status with tool count on success", async () => {
      mockListProviderTools.mockResolvedValue({ a: {}, b: {}, c: {} });

      const registry = new ProviderRegistry([makeConfig("grafana")], providersPath);
      await registry.initialize();

      // Reset mock so test() gets fresh results
      mockListProviderTools.mockResolvedValue({ x: {}, y: {} });
      mockListAllProviderTools.mockResolvedValue({ x: {}, y: {} });
      const result = await registry.test("grafana");

      expect(result.status).toBe("ok");
      expect(result.toolCount).toBe(2);
    });

    it("returns error status on failure", async () => {
      mockListProviderTools.mockResolvedValue({ default_tool: {} });

      const registry = new ProviderRegistry([makeConfig("grafana")], providersPath);
      await registry.initialize();

      mockListProviderTools.mockRejectedValue(new Error("timeout"));
      const result = await registry.test("grafana");

      expect(result.status).toBe("error");
      expect(result.toolCount).toBe(0);
      expect(result.error).toBe("timeout");
    });

    // Same heuristic as the init-time check, but on the Test button path:
    // a click that "succeeds" with zero tools should not flip the dot
    // green again — that would just hide the connectivity problem.
    it("treats 0 tools after a 'successful' listTools as an error (test)", async () => {
      mockListProviderTools.mockResolvedValue({ default_tool: {} });

      const registry = new ProviderRegistry([makeConfig("grafana")], providersPath);
      await registry.initialize();

      mockListProviderTools.mockResolvedValue({});
      mockListAllProviderTools.mockResolvedValue({});
      const result = await registry.test("grafana");

      expect(result.status).toBe("error");
      expect(result.toolCount).toBe(0);
      expect(result.error).toMatch(/no tools/i);
      const entry = registry.getAll().find((p) => p.config.name === "grafana");
      expect(entry?.status).toBe("error");
      expect(entry?.toolCount).toBe(0);
    });

    it("rebuilds and retries when a stale client returns zero raw tools during test", async () => {
      const initialTools = { grafana_query_prometheus: {} };
      mockListProviderTools.mockResolvedValue(initialTools);
      mockListAllProviderTools.mockResolvedValue(initialTools);
      mockComputeDefaultEnabledTools.mockReturnValue(["query_prometheus"]);

      const registry = new ProviderRegistry([makeConfig("grafana")], providersPath);
      await registry.initialize();

      mockCreateMcpProvider.mockClear();
      mockListProviderTools.mockReset();
      mockListAllProviderTools.mockReset();

      const recoveredTools = {
        grafana_query_prometheus: {},
        grafana_get_metrics: {},
      };
      mockListProviderTools
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(recoveredTools);
      mockListAllProviderTools
        .mockResolvedValueOnce({})
        .mockResolvedValue(recoveredTools);

      const result = await registry.test("grafana");

      expect(mockCreateMcpProvider).toHaveBeenCalledTimes(1);
      expect(result.status).toBe("ok");
      expect(result.toolCount).toBe(2);
      const entry = registry.getAll().find((p) => p.config.name === "grafana");
      expect(entry?.status).toBe("connected");
      expect(entry?.provider.enabledTools).toEqual(["query_prometheus"]);
      expect(entry?.enabledToolCount).toBe(1);
    });

    it("keeps disabled-all tools disabled when Test confirms the raw server has tools", async () => {
      mockListProviderTools.mockResolvedValue({ grafana_query_prometheus: {} });
      mockListAllProviderTools.mockResolvedValue({ grafana_query_prometheus: {} });

      const registry = new ProviderRegistry([makeConfig("grafana")], providersPath);
      await registry.initialize();
      await registry.updateEnabledTools("grafana", []);

      mockListProviderTools.mockResolvedValue({});
      mockListAllProviderTools.mockResolvedValue({ grafana_query_prometheus: {} });

      const result = await registry.test("grafana");

      expect(result.status).toBe("ok");
      expect(result.toolCount).toBe(1);
      const entry = registry.getAll().find((p) => p.config.name === "grafana");
      expect(entry?.status).toBe("connected");
      expect(entry?.toolCount).toBe(1);
      expect(entry?.enabledToolCount).toBe(0);
      expect(entry?.provider.enabledTools).toEqual([]);
      expect(entry?.toolNames).toEqual([]);
    });

    it("updates provider status in registry after test", async () => {
      mockListProviderTools.mockResolvedValue({});

      const registry = new ProviderRegistry([makeConfig("grafana")], providersPath);
      await registry.initialize();

      // Simulate failure
      mockListProviderTools.mockRejectedValue(new Error("down"));
      await registry.test("grafana");

      const info = registry.getAll().find((i) => i.config.name === "grafana");
      expect(info?.status).toBe("error");
      expect(info?.error).toBe("down");

      // Simulate recovery
      mockListProviderTools.mockResolvedValue({ tool: {} });
      await registry.test("grafana");

      const recovered = registry.getAll().find((i) => i.config.name === "grafana");
      expect(recovered?.status).toBe("connected");
      expect(recovered?.error).toBeUndefined();
    });

    it("throws for non-existent provider", async () => {
      const registry = new ProviderRegistry([], providersPath);
      await registry.initialize();

      await expect(registry.test("ghost")).rejects.toThrow("Provider not found");
    });

    // Regression: provider-registry-stale-enabledToolCount.
    // After a successful reconnect, enabledTools/enabledToolCount must reflect the
    // fresh tool set. Previously the UI showed "0 tools (41 enabled)" because the
    // auto-compute was skipped when enabledTools was already populated.
    it("re-runs auto-compute of enabledTools after successful reconnect", async () => {
      // Initial registration: 3 tools, auto-compute picks 2.
      mockListProviderTools.mockResolvedValue({ a: {}, b: {}, c: {} });
      mockListAllProviderTools.mockResolvedValue({ a: {}, b: {}, c: {} });
      mockComputeDefaultEnabledTools.mockReturnValue(["a", "b"]);

      const registry = new ProviderRegistry([makeConfig("grafana")], providersPath);
      await registry.initialize();

      const initial = registry.getAll().find((i) => i.config.name === "grafana");
      expect(initial?.enabledToolCount).toBe(2);
      expect(initial?.provider.enabledTools).toEqual(["a", "b"]);

      // Simulate reconnect: tool set changed, previously enabled tools no longer exist.
      mockListProviderTools.mockResolvedValue({ x: {}, y: {} });
      mockListAllProviderTools.mockResolvedValue({ x: {}, y: {} });
      mockComputeDefaultEnabledTools.mockReturnValue(["x"]);

      const result = await registry.test("grafana");
      expect(result.status).toBe("ok");
      expect(result.toolCount).toBe(2);

      const after = registry.getAll().find((i) => i.config.name === "grafana");
      // Fresh set has no survivors of the previous selection, so defaults kick in.
      expect(after?.provider.enabledTools).toEqual(["x"]);
      // Most importantly: enabledToolCount tracks the fresh list, not the stale 2.
      expect(after?.enabledToolCount).toBe(1);
      expect(after?.toolCount).toBe(2);
    });

    it("preserves user-curated enabledTools across reconnect when survivors exist", async () => {
      mockListProviderTools.mockResolvedValue({ a: {}, b: {}, c: {} });
      mockListAllProviderTools.mockResolvedValue({ a: {}, b: {}, c: {} });
      mockComputeDefaultEnabledTools.mockReturnValue(["a", "b", "c"]);

      const registry = new ProviderRegistry([makeConfig("grafana")], providersPath);
      await registry.initialize();

      // User curates: disable "c", leaving ["a", "b"]
      await registry.updateEnabledTools("grafana", ["a", "b"]);

      // Reconnect — "b" is gone, "a" + new "d"
      mockListProviderTools.mockResolvedValue({ a: {}, d: {} });
      mockListAllProviderTools.mockResolvedValue({ a: {}, d: {} });
      mockComputeDefaultEnabledTools.mockReturnValue(["a", "d"]);

      await registry.test("grafana");
      const after = registry.getAll().find((i) => i.config.name === "grafana");
      // "a" survives, so the user's selection wins ("d" is NOT added automatically).
      expect(after?.provider.enabledTools).toEqual(["a"]);
      expect(after?.enabledToolCount).toBe(1);
    });
  });

  describe("rebuildClient()", () => {
    it("mutates the existing provider object so handed-out wrappers keep the fresh client", async () => {
      const staleDisconnect = vi.fn().mockResolvedValue(undefined);
      const staleClient = {
        listTools: vi.fn(),
        disconnect: staleDisconnect,
      } as unknown as MastraProvider["client"];
      const freshClient = {
        listTools: vi.fn(),
        disconnect: vi.fn(),
      } as unknown as MastraProvider["client"];
      mockCreateMcpProvider
        .mockReturnValueOnce({
          name: "grafana",
          roles: ["metrics"],
          client: staleClient,
        })
        .mockReturnValueOnce({
          name: "grafana",
          roles: ["metrics"],
          client: freshClient,
        });
      mockListProviderTools.mockResolvedValue({ grafana_query_prometheus: {} });
      mockListAllProviderTools.mockResolvedValue({ grafana_query_prometheus: {} });
      mockComputeDefaultEnabledTools.mockReturnValue(["query_prometheus"]);

      const registry = new ProviderRegistry([makeConfig("grafana")], providersPath);
      await registry.initialize();

      const entry = registry.getAll()[0];
      const providerRef = entry.provider;

      await registry.rebuildClient(entry);

      expect(staleDisconnect).toHaveBeenCalledTimes(1);
      expect(entry.provider).toBe(providerRef);
      expect(providerRef.client).toBe(freshClient);
      expect(providerRef.enabledTools).toEqual(["query_prometheus"]);
      expect(providerRef.reconnect).toEqual(expect.any(Function));
    });
  });

  // -----------------------------------------------------------------------
  // File round-trip
  // -----------------------------------------------------------------------
  describe("file round-trip", () => {
    it("save then load preserves data", async () => {
      const registry1 = new ProviderRegistry([], providersPath);
      await registry1.initialize();
      await registry1.add(makeConfig("provider-a", ["metrics"]));
      await registry1.add(makeConfig("provider-b", ["logs", "dashboards"]));

      // Create a new registry that loads the same file
      const registry2 = new ProviderRegistry([], providersPath);
      await registry2.initialize();

      const all = registry2.getAll();
      expect(all).toHaveLength(2);

      const a = all.find((i) => i.config.name === "provider-a");
      expect(a).toBeDefined();
      expect(a!.config.roles).toEqual(["metrics"]);
      expect(a!.source).toBe("gui");

      const b = all.find((i) => i.config.name === "provider-b");
      expect(b).toBeDefined();
      expect(b!.config.roles).toEqual(["logs", "dashboards"]);
    });

    it("config providers are not written to providers.yaml", async () => {
      const registry = new ProviderRegistry([makeConfig("system-grafana")], providersPath);
      await registry.initialize();

      // Add a GUI provider to trigger file write
      await registry.add(makeConfig("gui-loki", ["logs"]));

      const raw = readFileSync(providersPath, "utf-8");
      const parsed = parse(raw) as unknown[];
      expect(parsed).toHaveLength(1);
      expect((parsed[0] as { name: string }).name).toBe("gui-loki");
    });

    it("handles empty providers.yaml gracefully", async () => {
      writeFileSync(providersPath, "");

      const registry = new ProviderRegistry([], providersPath);
      await registry.initialize();

      expect(registry.getAll()).toHaveLength(0);
    });

    it("handles missing providers.yaml gracefully", async () => {
      const registry = new ProviderRegistry([], join(dir, "nonexistent.yaml"));
      await registry.initialize();

      expect(registry.getAll()).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // hasViableMetricsProvider + onChange (B-1 init-time poller gate)
  // -----------------------------------------------------------------------
  describe("hasViableMetricsProvider", () => {
    it("returns false when no providers are registered", async () => {
      const registry = new ProviderRegistry([], providersPath);
      await registry.initialize();
      expect(registry.hasViableMetricsProvider()).toBe(false);
    });

    it("returns false when the metrics provider has no tools (toolCount=0)", async () => {
      // Simulates the FAZBD-240-style legacy stack: 3 providers configured,
      // all returning empty tool sets at runtime. The init-time poller gate
      // must say "no viable provider" so we don't log-spam forever.
      mockListProviderTools.mockResolvedValue({});
      mockListAllProviderTools.mockResolvedValue({});
      const registry = new ProviderRegistry([makeConfig("empty-grafana", ["metrics"])], providersPath);
      await registry.initialize();
      expect(registry.hasViableMetricsProvider()).toBe(false);
    });

    it("returns false when metrics provider has tools but none is a metric query tool", async () => {
      mockListProviderTools.mockResolvedValue({
        list_namespaces: { execute: vi.fn() },
        list_pods: { execute: vi.fn() },
      });
      const registry = new ProviderRegistry([makeConfig("k8s-only", ["metrics"])], providersPath);
      await registry.initialize();
      expect(registry.hasViableMetricsProvider()).toBe(false);
    });

    it("returns true when a metrics provider exposes a query_prometheus-style tool", async () => {
      const tools = {
        grafana_query_prometheus: { execute: vi.fn() },
      };
      mockListProviderTools.mockResolvedValue(tools);
      mockListAllProviderTools.mockResolvedValue(tools);
      mockComputeDefaultEnabledTools.mockReturnValue(["query_prometheus"]);
      const registry = new ProviderRegistry([makeConfig("grafana", ["metrics"])], providersPath);
      await registry.initialize();
      expect(registry.hasViableMetricsProvider()).toBe(true);
    });

    it("ignores providers that are not in the metrics role", async () => {
      mockListProviderTools.mockResolvedValue({
        loki_query_range: { execute: vi.fn() },
      });
      // logs-only provider should not satisfy the gate
      const registry = new ProviderRegistry([makeConfig("loki", ["logs"])], providersPath);
      await registry.initialize();
      expect(registry.hasViableMetricsProvider()).toBe(false);
    });
  });

  describe("onChange", () => {
    it("fires on add()", async () => {
      const registry = new ProviderRegistry([], providersPath);
      await registry.initialize();
      const listener = vi.fn();
      registry.onChange(listener);

      await registry.add(makeConfig("new-provider", ["metrics"]));
      expect(listener).toHaveBeenCalledWith({ kind: "add", name: "new-provider" });
    });

    it("fires on update() and remove()", async () => {
      const registry = new ProviderRegistry([], providersPath);
      await registry.initialize();
      await registry.add(makeConfig("p", ["metrics"]));

      const listener = vi.fn();
      registry.onChange(listener);

      await registry.update("p", makeConfig("p", ["metrics", "logs"]));
      expect(listener).toHaveBeenCalledWith({ kind: "update", name: "p" });

      await registry.remove("p");
      expect(listener).toHaveBeenCalledWith({ kind: "remove", name: "p" });
    });

    it("fires on test() success and test() failure", async () => {
      mockListProviderTools.mockResolvedValue({ grafana_query_prometheus: { execute: vi.fn() } });
      const registry = new ProviderRegistry([], providersPath);
      await registry.initialize();
      await registry.add(makeConfig("p", ["metrics"]));

      const listener = vi.fn();
      registry.onChange(listener);

      await registry.test("p");
      expect(listener).toHaveBeenCalledWith({ kind: "test", name: "p" });

      // Now make it fail
      listener.mockClear();
      mockListProviderTools.mockRejectedValueOnce(new Error("boom"));
      await registry.test("p");
      expect(listener).toHaveBeenCalledWith({ kind: "test", name: "p" });
    });

    it("returns an unsubscribe function that detaches the listener", async () => {
      const registry = new ProviderRegistry([], providersPath);
      await registry.initialize();
      const listener = vi.fn();
      const unsubscribe = registry.onChange(listener);

      unsubscribe();
      await registry.add(makeConfig("unheard", ["metrics"]));
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
