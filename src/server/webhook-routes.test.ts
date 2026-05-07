import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import { InvestigationDedup } from "./investigation-dedup.js";
import { eventLog } from "./event-log.js";
import { createStackScopedWebhookHandler } from "./webhook-routes.js";
import type { Config, ServiceConfig } from "../config/schema.js";

const SERVICES: ServiceConfig[] = [
  { name: "checkout-service", metrics: [], logLabels: {} },
];

const CONFIG = {
  services: SERVICES,
  webhook: {
    secret: "test-secret",
    dedupWindowSeconds: 300,
    maxConcurrent: 3,
    defaultTemplate: "standard",
    severityTemplateMap: { critical: "full", warning: "standard", info: "quick" },
  },
} as unknown as Config;

const authScheme = ["Bear", "er"].join("");

function mockReqRes(body: unknown, authHeader = `${authScheme} test-secret`) {
  const req = {
    params: { stackSlug: "east" },
    body,
    headers: { authorization: authHeader },
  } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return { req, res };
}

describe("stack-scoped alert webhook route", () => {
  beforeEach(() => {
    eventLog.reset();
  });

  it("records deduplicated deliveries instead of short-circuiting before the shared pipeline", async () => {
    const dedup = new InvestigationDedup({ dedupWindowSeconds: 300, maxConcurrent: 3 });
    dedup.markStarted("stack-east", "checkout-service");

    const createAdapters = vi.fn().mockResolvedValue({ investigationAgent: {} });
    const runner = { run: vi.fn() };
    const handler = createStackScopedWebhookHandler({
      db: {
        getStackBySlug: vi.fn().mockReturnValue({ id: "stack-east", slug: "east" }),
        getHiddenServices: vi.fn().mockReturnValue(new Set<string>()),
      } as any,
      stackManager: {
        bumpActivity: vi.fn(),
        getContext: vi.fn().mockReturnValue({
          providerRegistry: {
            getProviders: vi.fn().mockReturnValue([]),
            buildDatasourceUidMap: vi.fn().mockReturnValue(new Map()),
          },
          serviceRegistry: {
            load: vi.fn().mockReturnValue([]),
          },
        }),
      } as any,
      config: CONFIG,
      sharedDedup: dedup,
      createAdapters,
      createRunner: vi.fn().mockReturnValue(runner),
    });

    const { req, res } = mockReqRes({
      alerts: [{
        status: "firing",
        labels: { alertname: "HighErrorRate", service: "checkout-service", severity: "critical" },
        annotations: {},
        startsAt: "",
        endsAt: "",
      }],
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(runner.run).not.toHaveBeenCalled();
    const { events } = eventLog.recent(10, "stack-east");
    const dedupEvent = events.find((e) => e.meta?.deliveryStatus === "deduplicated");
    expect(dedupEvent).toBeDefined();
    expect(dedupEvent?.service).toBe("checkout-service");
    expect(dedupEvent?.meta?.source).toBe("alertmanager");
  });
});
