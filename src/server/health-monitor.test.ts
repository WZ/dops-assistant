import { describe, it, expect, vi, afterEach } from "vitest";
import type { Request, Response } from "express";
import { startHealthMonitor, stopHealthMonitor, healthHandler } from "./health-monitor.js";
import type { Database } from "./db.js";
import type { MastraProvider } from "../mcp/provider.js";
import type { ProviderInfo } from "../mcp/provider-registry.js";
import { eventLog } from "./event-log.js";

function mockDb(): Database {
  return { listInvestigations: vi.fn().mockReturnValue([]) } as unknown as Database;
}

function mockProvider(shouldFail = false): MastraProvider {
  return {
    name: "test",
    roles: ["metrics"],
    client: {
      listTools: shouldFail
        ? vi.fn().mockRejectedValue(new Error("MCP unreachable"))
        : vi.fn().mockResolvedValue({}),
    },
  } as unknown as MastraProvider;
}

function makeInfo(overrides: Partial<ProviderInfo> & { name?: string }): ProviderInfo {
  const { name = "p", ...rest } = overrides;
  return {
    provider: { name, roles: ["metrics"], client: {} as never },
    config: { name, roles: ["metrics"], mcpServer: { transport: "http", url: "http://x" } },
    source: "config",
    status: "connected",
    toolCount: 1,
    enabledToolCount: 1,
    ...rest,
  } as ProviderInfo;
}

function mockStackManager(infos: ProviderInfo[]) {
  return {
    getDefaultContext: () => ({
      providerRegistry: {
        getAll: () => infos,
      },
    }),
  };
}

function mockRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

afterEach(() => {
  stopHealthMonitor();
});

describe("health monitor", () => {
  it("returns healthy when all probes pass", async () => {
    startHealthMonitor({ providers: [mockProvider()], db: mockDb() }, 60_000);
    // Wait for initial probe to complete
    await new Promise(r => setTimeout(r, 50));

    const res = mockRes();
    healthHandler({} as Request, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: "healthy",
      probes: expect.objectContaining({
        mcp: expect.objectContaining({ status: "ok" }),
        db: expect.objectContaining({ status: "ok" }),
      }),
    }));
  });

  it("returns degraded when MCP probe fails", async () => {
    startHealthMonitor({ providers: [mockProvider(true)], db: mockDb() }, 60_000);
    await new Promise(r => setTimeout(r, 50));

    const res = mockRes();
    healthHandler({} as Request, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: "degraded",
      probes: expect.objectContaining({
        mcp: expect.objectContaining({ status: "error" }),
      }),
    }));
  });

  it("returns healthy with no providers configured", async () => {
    startHealthMonitor({ providers: [], db: mockDb() }, 60_000);
    await new Promise(r => setTimeout(r, 50));

    const res = mockRes();
    healthHandler({} as Request, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  // Registry-aware probe path (the production wiring). Pre-fix, the probe
  // called listTools() on providers[0] — and @mastra/mcp swallows
  // per-server connection failures inside listTools, so the probe always
  // reported "ok" even when every upstream was dead. Now the probe reads
  // the registry's reconciled status and reports error correctly.
  it("returns degraded when stackManager registry shows all providers errored", async () => {
    const stackManager = mockStackManager([
      makeInfo({ name: "grafana", status: "error", toolCount: 0, error: "MCP server returned no tools" }),
      makeInfo({ name: "loki", status: "error", toolCount: 0, error: "MCP server returned no tools" }),
    ]);
    startHealthMonitor({ stackManager, db: mockDb() }, 60_000);
    await new Promise(r => setTimeout(r, 50));

    const res = mockRes();
    healthHandler({} as Request, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: "degraded",
      probes: expect.objectContaining({
        mcp: expect.objectContaining({ status: "error" }),
      }),
    }));
  });

  it("returns healthy when registry has at least one connected provider with tools", async () => {
    const stackManager = mockStackManager([
      makeInfo({ name: "grafana", status: "connected", toolCount: 5 }),
    ]);
    startHealthMonitor({ stackManager, db: mockDb() }, 60_000);
    await new Promise(r => setTimeout(r, 50));

    const res = mockRes();
    healthHandler({} as Request, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      probes: expect.objectContaining({
        mcp: expect.objectContaining({ status: "ok" }),
      }),
    }));
  });

  it("flags partial outage as error with a count summary", async () => {
    const stackManager = mockStackManager([
      makeInfo({ name: "grafana", status: "connected", toolCount: 5 }),
      makeInfo({ name: "loki", status: "error", toolCount: 0 }),
    ]);
    startHealthMonitor({ stackManager, db: mockDb() }, 60_000);
    await new Promise(r => setTimeout(r, 50));

    const res = mockRes();
    healthHandler({} as Request, res);

    expect(res.status).toHaveBeenCalledWith(503);
    const payload = (res.json as any).mock.calls[0][0];
    expect(payload.probes.mcp.status).toBe("error");
    expect(payload.probes.mcp.error).toMatch(/1 of 2/);
  });
});

describe("health monitor eventLog integration", () => {
  afterEach(() => {
    stopHealthMonitor();
  });

  it("emits provider_health_changed when probe transitions from ok to error", async () => {
    // Cycle 1: healthy probe — seeds prevProbeStatus["mcp"] = "ok" (no event emitted on first run)
    startHealthMonitor({ providers: [mockProvider(false)], db: mockDb() }, 60_000);
    await new Promise(r => setTimeout(r, 50));
    stopHealthMonitor();

    // Reset eventLog so we only see events from cycle 2
    eventLog.reset();

    // Cycle 2: failing probe — prevProbeStatus["mcp"] is now "ok", next is "error" → transition
    startHealthMonitor({ providers: [mockProvider(true)], db: mockDb() }, 60_000);
    await new Promise(r => setTimeout(r, 50));

    const { events } = eventLog.recent(10);
    const transition = events.find((e) => e.kind === "provider_health_changed");
    expect(transition).toBeDefined();
    expect(transition!.meta).toMatchObject({ provider: "mcp", from: "ok", to: "error" });
  });
});
