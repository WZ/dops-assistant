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

vi.mock("./provider.js", () => ({
  createMcpProvider: (...args: unknown[]) => mockCreateMcpProvider(...args),
  listProviderTools: (...args: unknown[]) => mockListProviderTools(...args),
  listAllProviderTools: (...args: unknown[]) => mockListAllProviderTools(...args),
  getToolsWithMetadata: (...args: unknown[]) => mockGetToolsWithMetadata(...args),
  computeDefaultEnabledTools: (...args: unknown[]) => mockComputeDefaultEnabledTools(...args),
}));

import { ProviderRegistry } from "./provider-registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeConfig(name: string, roles: ("metrics" | "logs" | "dashboards")[] = ["metrics"]): ProviderConfig {
  return {
    name,
    roles,
    mcpServer: {
      transport: "http" as const,
      url: `http://localhost:8080/${name}`,
    },
  };
}

function makeFakeProvider(config: ProviderConfig): MastraProvider {
  return {
    name: config.name,
    roles: config.roles,
    client: { listTools: vi.fn() } as never,
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

    // Default mocks: createMcpProvider returns a fake, listProviderTools returns empty tools
    mockCreateMcpProvider.mockImplementation((config: ProviderConfig) => makeFakeProvider(config));
    mockListProviderTools.mockResolvedValue({});
    mockListAllProviderTools.mockResolvedValue({});
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
      const result = await registry.test("grafana");

      expect(result.status).toBe("ok");
      expect(result.toolCount).toBe(2);
    });

    it("returns error status on failure", async () => {
      mockListProviderTools.mockResolvedValue({});

      const registry = new ProviderRegistry([makeConfig("grafana")], providersPath);
      await registry.initialize();

      mockListProviderTools.mockRejectedValue(new Error("timeout"));
      const result = await registry.test("grafana");

      expect(result.status).toBe("error");
      expect(result.toolCount).toBe(0);
      expect(result.error).toBe("timeout");
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
      mockListProviderTools.mockResolvedValue({
        grafana_query_prometheus: { execute: vi.fn() },
      });
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
