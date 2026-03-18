import { describe, it, expect, vi } from "vitest";
import { buildHandlers } from "./routes.js";
import type { Database } from "./db.js";
import type { ServiceConfig } from "../config/schema.js";

function mockDb() {
  return {
    listInvestigations: vi.fn().mockReturnValue([
      { id: "inv_1", service: "payments-api", query: "errors", status: "complete", report: '{"rootCause":"OOM"}', created_at: "2026-03-08T10:00:00Z", completed_at: "2026-03-08T10:05:00Z" },
    ]),
    getInvestigation: vi.fn().mockReturnValue(
      { id: "inv_1", service: "payments-api", query: "errors", status: "complete", report: '{"rootCause":"OOM"}', created_at: "2026-03-08T10:00:00Z", completed_at: "2026-03-08T10:05:00Z" },
    ),
    getPhases: vi.fn().mockReturnValue([]),
    getEvents: vi.fn().mockReturnValue([]),
  } as unknown as Database;
}

const services: ServiceConfig[] = [
  { name: "payments-api", metrics: [{ query: "rate(errors[5m])", description: "error rate" }], logLabels: { app: "payments" } },
];

describe("route handlers", () => {
  it("getServices returns service list", () => {
    const handlers = buildHandlers(mockDb() as Database, services);
    const result = handlers.getServices();
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("payments-api");
  });

  it("listInvestigations returns investigations from db", () => {
    const db = mockDb();
    const handlers = buildHandlers(db as Database, services);
    const result = handlers.listInvestigations(20, 0);
    expect(result).toHaveLength(1);
    expect(db.listInvestigations).toHaveBeenCalledWith(20, 0);
  });

  it("getInvestigation returns investigation with phases", () => {
    const db = mockDb();
    const handlers = buildHandlers(db as Database, services);
    const result = handlers.getInvestigation("inv_1");
    expect(result).toBeDefined();
    expect(result!.investigation.id).toBe("inv_1");
  });

  it("getInvestigation returns undefined for missing id", () => {
    const db = mockDb();
    (db.getInvestigation as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    const handlers = buildHandlers(db as Database, services);
    const result = handlers.getInvestigation("nope");
    expect(result).toBeUndefined();
  });
});

describe("dependency graph inference", () => {
  it("detects dependencies from metric query references", async () => {
    const multiServices: ServiceConfig[] = [
      { name: "api-gateway", metrics: [{ query: 'rate(http_requests_total{upstream="checkout"}[5m])', description: "req rate" }], logLabels: {} },
      { name: "checkout", metrics: [], logLabels: {} },
      { name: "payments", metrics: [], logLabels: {} },
    ];
    const handlers = buildHandlers(mockDb() as Database, multiServices);
    const result = await handlers.getDependencies("api-gateway");
    expect(result.nodes.some(n => n.id === "api-gateway")).toBe(true);
    expect(result.edges.some(e => e.source === "api-gateway" && e.target === "checkout")).toBe(true);
  });

  it("returns single node when no dependencies found", async () => {
    const isolated: ServiceConfig[] = [{ name: "isolated-svc", metrics: [], logLabels: {} }];
    const handlers = buildHandlers(mockDb() as Database, isolated);
    const result = await handlers.getDependencies("isolated-svc");
    expect(result.nodes).toHaveLength(1);
    expect(result.edges).toHaveLength(0);
  });
});
