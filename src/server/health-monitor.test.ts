import { describe, it, expect, vi, afterEach } from "vitest";
import type { Request, Response } from "express";
import { startHealthMonitor, stopHealthMonitor, healthHandler } from "./health-monitor.js";
import type { Database } from "./db.js";
import { eventLog } from "./event-log.js";

function mockDb(shouldFail = false): Database {
  return {
    listInvestigations: shouldFail
      ? vi.fn().mockImplementation(() => { throw new Error("DB locked"); })
      : vi.fn().mockReturnValue([]),
  } as unknown as Database;
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
  it("returns 200 with healthy body when DB probe passes", async () => {
    startHealthMonitor({ db: mockDb() }, 60_000);
    await new Promise((r) => setTimeout(r, 50));

    const res = mockRes();
    healthHandler({} as Request, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "healthy",
        probes: expect.objectContaining({
          db: expect.objectContaining({ status: "ok" }),
        }),
      }),
    );
  });

  it("returns 200 with degraded body when DB probe fails", async () => {
    // Always 200 — k8s readiness/liveness probes hit /api/health and we don't
    // want a DB hiccup to take the pod NotReady. Status flag in the body
    // tells operators something's wrong without the cluster yanking traffic.
    // (Regression: PR #184 caused a self-inflicted prod outage by 503'ing
    // here when MCP went unreachable; PR #185 made the endpoint always 200
    // and this cleanup removed MCP from the probe entirely.)
    startHealthMonitor({ db: mockDb(true) }, 60_000);
    await new Promise((r) => setTimeout(r, 50));

    const res = mockRes();
    healthHandler({} as Request, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "degraded",
        probes: expect.objectContaining({
          db: expect.objectContaining({ status: "error", error: "DB locked" }),
        }),
      }),
    );
  });

  it("does not include an MCP probe in the response body", async () => {
    // MCP health is per-stack and lives on /api/stacks → providerHealth.
    // /api/health is server-level (default-stack only would lie anyway), so
    // the field was removed entirely. If this test fails, someone re-added
    // it without checking the consumers — the UI strip and StackSwitcher
    // both already source MCP from the per-stack endpoint.
    startHealthMonitor({ db: mockDb() }, 60_000);
    await new Promise((r) => setTimeout(r, 50));

    const res = mockRes();
    healthHandler({} as Request, res);

    const payload = (res.json as any).mock.calls[0][0];
    expect(payload.probes).not.toHaveProperty("mcp");
  });

  it("includes server-level metadata (uptime, version) in the body", async () => {
    startHealthMonitor({ db: mockDb() }, 60_000);
    await new Promise((r) => setTimeout(r, 50));

    const res = mockRes();
    healthHandler({} as Request, res);

    const payload = (res.json as any).mock.calls[0][0];
    expect(payload).toHaveProperty("uptime");
    expect(typeof payload.uptime).toBe("number");
    expect(payload).toHaveProperty("version");
  });
});

describe("health monitor eventLog integration", () => {
  it("emits provider_health_changed when DB transitions from ok to error", async () => {
    // Cycle 1: healthy probe — seeds prevDbStatus = "ok" (no event emitted on first run)
    startHealthMonitor({ db: mockDb(false) }, 60_000);
    await new Promise((r) => setTimeout(r, 50));
    stopHealthMonitor();

    // Reset eventLog so we only see events from cycle 2
    eventLog.reset();

    // Cycle 2: failing probe — prevDbStatus is now "ok", next is "error" → transition
    startHealthMonitor({ db: mockDb(true) }, 60_000);
    await new Promise((r) => setTimeout(r, 50));

    const { events } = eventLog.recent(10);
    const transition = events.find((e) => e.kind === "provider_health_changed");
    expect(transition).toBeDefined();
    expect(transition!.meta).toMatchObject({ provider: "db", from: "ok", to: "error" });
  });
});
