import { describe, it, expect, vi, afterEach } from "vitest";
import type { Request, Response } from "express";
import { startHealthMonitor, stopHealthMonitor, healthHandler } from "./health-monitor.js";
import type { Database } from "./db.js";
import type { MastraProvider } from "../mcp/provider.js";

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
});
