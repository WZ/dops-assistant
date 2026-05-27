import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Tool } from "@mastra/core/tools";
import type { ProviderConfig } from "../config/schema.js";
import type { MastraProvider } from "./provider.js";

// ---------------------------------------------------------------------------
// Section 1: isMcpConnectionError + wrapToolsForReconnect (pure helpers)
// ---------------------------------------------------------------------------
//
// These functions live in provider.ts and don't depend on @mastra/mcp at
// runtime (we only pass them fake MastraProvider objects), so we can import
// them directly without mocking the SDK.

import { isMcpConnectionError, wrapToolsForReconnect } from "./provider.js";

describe("isMcpConnectionError", () => {
  it("matches the Mastra MCP_CLIENT_GET_TOOLS_FAILED code", () => {
    const err = Object.assign(new Error("Could not connect to server with any available HTTP transport"), {
      code: "MCP_CLIENT_GET_TOOLS_FAILED",
    });
    expect(isMcpConnectionError(err)).toBe(true);
  });

  it("matches the streamable-http exhaustion message even without a code", () => {
    expect(isMcpConnectionError(new Error("Could not connect to server with any available HTTP transport"))).toBe(true);
  });

  it("matches the SSE-fallback 'Already connected to a transport' cascade", () => {
    expect(isMcpConnectionError(new Error("Already connected to a transport. Call close() before connecting"))).toBe(true);
  });

  it("matches 'Not connected' protocol-state errors", () => {
    expect(isMcpConnectionError(new Error("Not connected"))).toBe(true);
  });

  it.each(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EPIPE"])("matches %s connection errno", (code) => {
    expect(isMcpConnectionError(new Error(`fetch failed: ${code}`))).toBe(true);
  });

  it("does NOT match unrelated errors (e.g. validation, auth, business logic)", () => {
    expect(isMcpConnectionError(new Error("Invalid PromQL syntax"))).toBe(false);
    expect(isMcpConnectionError(new Error("401 Unauthorized"))).toBe(false);
    expect(isMcpConnectionError(new Error("Tool not found: query_prometheus"))).toBe(false);
  });

  it("returns false for null/undefined/non-Error values", () => {
    expect(isMcpConnectionError(null)).toBe(false);
    expect(isMcpConnectionError(undefined)).toBe(false);
    expect(isMcpConnectionError(42)).toBe(false);
  });
});

describe("wrapToolsForReconnect", () => {
  function makeProvider(reconnect?: () => Promise<void>): MastraProvider & { client: { listTools: ReturnType<typeof vi.fn> } } {
    return {
      name: "grafana",
      roles: ["metrics"],
      client: { listTools: vi.fn() } as never,
      reconnect,
    } as MastraProvider & { client: { listTools: ReturnType<typeof vi.fn> } };
  }

  function makeTool(execute: (...args: unknown[]) => Promise<unknown>): Tool {
    return { description: "t", execute } as unknown as Tool;
  }

  it("returns the input unchanged when the provider has no reconnect hook", () => {
    const provider = makeProvider(undefined);
    const tools = { grafana_query_prometheus: makeTool(async () => "ok") };
    expect(wrapToolsForReconnect(provider, tools)).toBe(tools);
  });

  it("leaves tools without an execute function alone", async () => {
    const provider = makeProvider(vi.fn().mockResolvedValue(undefined));
    const tool = { description: "no exec" } as unknown as Tool;
    const wrapped = wrapToolsForReconnect(provider, { grafana_x: tool });
    expect(wrapped.grafana_x).toBe(tool);
  });

  it("does NOT trigger reconnect on non-connection errors", async () => {
    const reconnect = vi.fn().mockResolvedValue(undefined);
    const provider = makeProvider(reconnect);
    const tool = makeTool(async () => { throw new Error("Invalid PromQL syntax"); });
    const wrapped = wrapToolsForReconnect(provider, { grafana_query_prometheus: tool });

    await expect((wrapped.grafana_query_prometheus as any).execute({})).rejects.toThrow("Invalid PromQL syntax");
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("triggers reconnect AND retries a read-only tool on MCP connection error", async () => {
    let attempt = 0;
    const original = vi.fn().mockImplementation(async () => {
      attempt++;
      if (attempt === 1) throw new Error("Could not connect to server with any available HTTP transport");
      return { content: [{ text: "fresh-result" }] };
    });

    const reconnect = vi.fn().mockResolvedValue(undefined);
    const provider = makeProvider(reconnect);
    // After reconnect, listTools returns a fresh tool whose execute is the
    // second call into `original` (simulating a new client with a healthy
    // tool bound to the rebuilt session).
    const freshTool = makeTool(original);
    (provider.client.listTools as any).mockResolvedValue({ grafana_query_prometheus: freshTool });

    const wrapped = wrapToolsForReconnect(provider, { grafana_query_prometheus: makeTool(original) });
    const result = await (wrapped.grafana_query_prometheus as any).execute({});

    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(attempt).toBe(2);
    expect(result).toEqual({ content: [{ text: "fresh-result" }] });
  });

  it("triggers reconnect but does NOT retry a write tool", async () => {
    const original = vi.fn().mockRejectedValue(new Error("Could not connect to server with any available HTTP transport"));
    const reconnect = vi.fn().mockResolvedValue(undefined);
    const provider = makeProvider(reconnect);
    const wrapped = wrapToolsForReconnect(provider, { grafana_delete_dashboard: makeTool(original) });

    await expect((wrapped.grafana_delete_dashboard as any).execute({})).rejects.toThrow("Could not connect");
    expect(reconnect).toHaveBeenCalledTimes(1);
    // Original execute called exactly once — no replay of the write call.
    expect(original).toHaveBeenCalledTimes(1);
  });

  it("surfaces the original error when reconnect itself fails", async () => {
    const original = vi.fn().mockRejectedValue(new Error("Could not connect to server with any available HTTP transport"));
    const reconnect = vi.fn().mockRejectedValue(new Error("rebuild failed"));
    const provider = makeProvider(reconnect);
    const wrapped = wrapToolsForReconnect(provider, { grafana_query_prometheus: makeTool(original) });

    await expect((wrapped.grafana_query_prometheus as any).execute({})).rejects.toThrow("Could not connect");
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(original).toHaveBeenCalledTimes(1);
  });

  it("surfaces the original error when the fresh client has no matching tool", async () => {
    const original = vi.fn().mockRejectedValue(new Error("Could not connect to server with any available HTTP transport"));
    const reconnect = vi.fn().mockResolvedValue(undefined);
    const provider = makeProvider(reconnect);
    // Fresh listTools doesn't return the same tool name (tool was removed upstream).
    (provider.client.listTools as any).mockResolvedValue({});
    const wrapped = wrapToolsForReconnect(provider, { grafana_query_prometheus: makeTool(original) });

    await expect((wrapped.grafana_query_prometheus as any).execute({})).rejects.toThrow("Could not connect");
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("uses the unprefixed name when classifying read/write", async () => {
    // `grafana_query_prometheus` → unprefix to `query_prometheus` → read.
    // If the wrapper accidentally classified the full namespaced name, the
    // "query" segment would still match read, so we also check an entity_verb
    // pattern that depends on the unprefix step working correctly.
    const original = vi.fn().mockRejectedValue(new Error("Could not connect to server"));
    const reconnect = vi.fn().mockResolvedValue(undefined);
    const provider = makeProvider(reconnect);
    (provider.client.listTools as any).mockResolvedValue({
      k8s_pods_list: { description: "list pods", execute: vi.fn().mockResolvedValue("ok") },
    });
    // Override provider name for this case
    const k8sProvider = { ...provider, name: "k8s" } as MastraProvider;
    const wrapped = wrapToolsForReconnect(k8sProvider, { k8s_pods_list: { description: "list pods", execute: original } as unknown as Tool });

    const result = await (wrapped.k8s_pods_list as any).execute({});
    expect(result).toBe("ok");
    expect(reconnect).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Section 2: ProviderRegistry reconnect behavior
// ---------------------------------------------------------------------------
//
// Mocks `./provider.js` so we can control createMcpProvider / listProviderTools
// independently and observe the registry's rebuild + retry behavior.

const mockCreateMcpProvider = vi.fn();
const mockListProviderTools = vi.fn();
const mockListAllProviderTools = vi.fn();
const mockGetToolsWithMetadata = vi.fn();
const mockComputeDefaultEnabledTools = vi.fn();

vi.mock("./provider.js", async (importOriginal) => {
  // Keep the real isMcpConnectionError and wrapToolsForReconnect — Section 1
  // exercises them directly, and the registry's test() uses the real one to
  // classify errors. Only mock the constructor + listTools functions.
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

import { ProviderRegistry, DEFAULT_RECONNECT_INTERVAL_MS } from "./provider-registry.js";

function makeConfig(name: string): ProviderConfig {
  return {
    name,
    roles: ["metrics"],
    mcpServer: { transport: "http" as const, url: `http://localhost:8080/${name}` },
  };
}

function makeFakeProvider(name: string): MastraProvider & { client: { listTools: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> } } {
  return {
    name,
    roles: ["metrics"],
    client: {
      listTools: vi.fn().mockResolvedValue({ default_tool: {} }),
      disconnect: vi.fn().mockResolvedValue(undefined),
    } as never,
  } as MastraProvider & { client: { listTools: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> } };
}

describe("ProviderRegistry.rebuildClient", () => {
  let dir: string;
  let providersPath: string;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useRealTimers();
    dir = mkdtempSync(join(tmpdir(), "provider-reconnect-test-"));
    providersPath = join(dir, "providers.yaml");
    mockListProviderTools.mockResolvedValue({ tool_a: {} });
    mockListAllProviderTools.mockResolvedValue({ tool_a: {} });
    mockGetToolsWithMetadata.mockResolvedValue([]);
    mockComputeDefaultEnabledTools.mockReturnValue([]);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("disconnects the old client and swaps it in place (preserves the MastraProvider reference)", async () => {
    const first = makeFakeProvider("grafana");
    const second = makeFakeProvider("grafana");
    // Capture the stale disconnect before the rebuild mutates entry.provider.client
    // — once the swap happens, first.client points at second.client and the
    // original disconnect mock is no longer reachable through that path.
    const staleDisconnect = first.client.disconnect;
    const freshClient = second.client;
    mockCreateMcpProvider.mockReturnValueOnce(first).mockReturnValueOnce(second);

    const registry = new ProviderRegistry([makeConfig("grafana")], providersPath);
    await registry.initialize();

    const entry = registry.getAll()[0];
    const providerRef = entry.provider;
    expect(providerRef).toBe(first);

    await registry.rebuildClient(entry);

    expect(staleDisconnect).toHaveBeenCalledTimes(1);
    // Reference identity preserved; only internals mutated.
    expect(entry.provider).toBe(providerRef);
    expect(providerRef.client).toBe(freshClient);
    // The reconnect hook must be re-installed so the next tool wrapper still
    // has an escape hatch.
    expect(typeof providerRef.reconnect).toBe("function");
  });

  it("preserves the user-curated enabledTools across the rebuild", async () => {
    const first = makeFakeProvider("grafana");
    first.enabledTools = ["query_prometheus", "list_datasources"];
    const second = makeFakeProvider("grafana");
    mockCreateMcpProvider.mockReturnValueOnce(first).mockReturnValueOnce(second);

    const registry = new ProviderRegistry([makeConfig("grafana")], providersPath);
    await registry.initialize();
    const entry = registry.getAll()[0];

    await registry.rebuildClient(entry);

    expect(entry.provider.enabledTools).toEqual(["query_prometheus", "list_datasources"]);
  });

  it("ignores disconnect failures and still rebuilds", async () => {
    const first = makeFakeProvider("grafana");
    (first.client.disconnect as any).mockRejectedValue(new Error("disconnect failed"));
    const second = makeFakeProvider("grafana");
    const freshClient = second.client;
    mockCreateMcpProvider.mockReturnValueOnce(first).mockReturnValueOnce(second);

    const registry = new ProviderRegistry([makeConfig("grafana")], providersPath);
    await registry.initialize();
    const entry = registry.getAll()[0];

    await registry.rebuildClient(entry);
    // Reference preserved, client swapped despite the disconnect throw.
    expect(entry.provider.client).toBe(freshClient);
  });

  it("deduplicates concurrent rebuilds on the same entry", async () => {
    const first = makeFakeProvider("grafana");
    const second = makeFakeProvider("grafana");
    const freshClient = second.client;
    // Block disconnect on the first client so the rebuild stays in-flight
    // while we issue a second concurrent call. createMcpProvider stays
    // synchronous (registry calls it that way) — the deferral lives in
    // disconnect, which is the rebuild's first await point.
    let releaseDisconnect: () => void = () => {};
    const staleDisconnect = first.client.disconnect as ReturnType<typeof vi.fn>;
    staleDisconnect.mockImplementation(
      () => new Promise<void>((res) => { releaseDisconnect = res; }),
    );
    mockCreateMcpProvider.mockReturnValueOnce(first).mockReturnValueOnce(second);

    const registry = new ProviderRegistry([makeConfig("grafana")], providersPath);
    await registry.initialize();
    const entry = registry.getAll()[0];

    const p1 = registry.rebuildClient(entry);
    const p2 = registry.rebuildClient(entry);

    releaseDisconnect();
    await Promise.all([p1, p2]);

    // Dedup is observable as: only one createMcpProvider call for the rebuild,
    // and only one disconnect on the old client. (Both p1 and p2 wrap the same
    // in-flight async work but each call returns its own outer Promise — async
    // functions can't be reference-compared.)
    expect(mockCreateMcpProvider).toHaveBeenCalledTimes(2); // 1 init + 1 rebuild
    expect(staleDisconnect).toHaveBeenCalledTimes(1);
    expect(entry.provider.client).toBe(freshClient);
  });
});

describe("ProviderRegistry.test() reconnect path", () => {
  let dir: string;
  let providersPath: string;

  beforeEach(() => {
    vi.resetAllMocks();
    dir = mkdtempSync(join(tmpdir(), "provider-test-reconnect-"));
    providersPath = join(dir, "providers.yaml");
    mockListProviderTools.mockResolvedValue({ tool_a: {} });
    mockListAllProviderTools.mockResolvedValue({ tool_a: {} });
    mockGetToolsWithMetadata.mockResolvedValue([]);
    mockComputeDefaultEnabledTools.mockReturnValue([]);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rebuilds the client and retries when listTools fails with a connection error", async () => {
    const first = makeFakeProvider("grafana");
    const second = makeFakeProvider("grafana");
    const staleDisconnect = first.client.disconnect;
    const freshClient = second.client;
    mockCreateMcpProvider.mockReturnValueOnce(first).mockReturnValueOnce(second);

    const registry = new ProviderRegistry([makeConfig("grafana")], providersPath);
    await registry.initialize();
    const entry = registry.getAll()[0];
    expect(entry.provider).toBe(first);

    // Next two calls to listProviderTools: first throws connection error,
    // second (after rebuild) succeeds.
    mockListProviderTools
      .mockRejectedValueOnce(Object.assign(new Error("Could not connect to server with any available HTTP transport"), { code: "MCP_CLIENT_GET_TOOLS_FAILED" }))
      .mockResolvedValueOnce({ tool_a: {} });

    const result = await registry.test("grafana");

    expect(result.status).toBe("ok");
    // Reference preserved (mutate-in-place rebuild), but the inner client is
    // the new one and the stale disconnect was called exactly once.
    expect(entry.provider.client).toBe(freshClient);
    expect(staleDisconnect).toHaveBeenCalledTimes(1);
  });

  it("does NOT rebuild when listTools fails with a non-connection error", async () => {
    const first = makeFakeProvider("grafana");
    mockCreateMcpProvider.mockReturnValueOnce(first);

    const registry = new ProviderRegistry([makeConfig("grafana")], providersPath);
    await registry.initialize();
    const entry = registry.getAll()[0];

    mockListProviderTools.mockRejectedValueOnce(new Error("401 Unauthorized"));

    const result = await registry.test("grafana");

    expect(result.status).toBe("error");
    expect(result.error).toContain("401");
    // Same client, no disconnect.
    expect(entry.provider).toBe(first);
    expect(first.client.disconnect).not.toHaveBeenCalled();
  });

  it("propagates the error when the retry after rebuild also fails", async () => {
    const first = makeFakeProvider("grafana");
    const second = makeFakeProvider("grafana");
    mockCreateMcpProvider.mockReturnValueOnce(first).mockReturnValueOnce(second);

    const registry = new ProviderRegistry([makeConfig("grafana")], providersPath);
    await registry.initialize();

    const connErr = Object.assign(new Error("Could not connect to server"), { code: "MCP_CLIENT_GET_TOOLS_FAILED" });
    mockListProviderTools.mockRejectedValueOnce(connErr).mockRejectedValueOnce(connErr);

    const result = await registry.test("grafana");
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/Could not connect/);
  });
});

describe("ProviderRegistry periodic reconnect", () => {
  let dir: string;
  let providersPath: string;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), "provider-periodic-test-"));
    providersPath = join(dir, "providers.yaml");
    mockListProviderTools.mockResolvedValue({ tool_a: {} });
    mockListAllProviderTools.mockResolvedValue({ tool_a: {} });
    mockGetToolsWithMetadata.mockResolvedValue([]);
    mockComputeDefaultEnabledTools.mockReturnValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("exposes a sane default interval", () => {
    expect(DEFAULT_RECONNECT_INTERVAL_MS).toBe(60_000);
  });

  it("only re-tests providers currently in error state", async () => {
    const okProv = makeFakeProvider("grafana-ok");
    const errProv = makeFakeProvider("grafana-err");
    mockCreateMcpProvider.mockReturnValueOnce(okProv).mockReturnValueOnce(errProv);

    // Per-provider mock: ok stays healthy; errored one returns empty (the
    // registry classifies "0 tools" as error) until we flip the switch.
    let errProvHealed = false;
    const provToolsFor = (p: MastraProvider) =>
      p.name === "grafana-ok"
        ? Promise.resolve({ tool_a: {} })
        : Promise.resolve(errProvHealed ? { tool_a: {} } : {});
    mockListProviderTools.mockImplementation(provToolsFor);
    mockListAllProviderTools.mockImplementation(provToolsFor);

    const registry = new ProviderRegistry(
      [makeConfig("grafana-ok"), makeConfig("grafana-err")],
      providersPath,
    );
    await registry.initialize();

    const all = registry.getAll();
    expect(all.find(p => p.config.name === "grafana-ok")?.status).toBe("connected");
    expect(all.find(p => p.config.name === "grafana-err")?.status).toBe("error");

    // Spy on test() so we can assert which providers the ticker re-probes.
    const testSpy = vi.spyOn(registry, "test");
    errProvHealed = true;

    registry.startPeriodicReconnect(1000);
    await vi.advanceTimersByTimeAsync(1000);
    registry.stopPeriodicReconnect();

    // grafana-err was re-tested (still in error state at tick time);
    // grafana-ok was skipped (already connected).
    expect(testSpy).toHaveBeenCalledWith("grafana-err");
    expect(testSpy).not.toHaveBeenCalledWith("grafana-ok");
    expect(registry.getAll().find(p => p.config.name === "grafana-err")?.status).toBe("connected");
  });

  it("stopPeriodicReconnect clears the interval and is idempotent", () => {
    const registry = new ProviderRegistry([], providersPath);
    registry.startPeriodicReconnect(1000);
    registry.stopPeriodicReconnect();
    // Second stop is a no-op (doesn't throw).
    registry.stopPeriodicReconnect();
  });

  it("startPeriodicReconnect is idempotent — two calls leave only one timer", async () => {
    const first = makeFakeProvider("grafana");
    mockCreateMcpProvider.mockReturnValueOnce(first);
    mockListProviderTools.mockResolvedValue({}); // status=error every call
    mockListAllProviderTools.mockResolvedValue({});

    const registry = new ProviderRegistry([makeConfig("grafana")], providersPath);
    await registry.initialize();

    const testSpy = vi.spyOn(registry, "test");

    registry.startPeriodicReconnect(1000);
    registry.startPeriodicReconnect(1000);
    await vi.advanceTimersByTimeAsync(1000);
    registry.stopPeriodicReconnect();

    // Exactly one tick per interval window — not two.
    expect(testSpy).toHaveBeenCalledTimes(1);
  });
});
