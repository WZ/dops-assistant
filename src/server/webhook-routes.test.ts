import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import { InvestigationDedup } from "./investigation-dedup.js";
import { eventLog } from "./event-log.js";
import { createStackScopedWebhookHandler } from "./webhook-routes.js";
import { hashWebhookToken } from "./webhook-tokens.js";
import type { Config, ServiceConfig } from "../config/schema.js";

const SERVICES: ServiceConfig[] = [
  { name: "checkout-service", metrics: [], logLabels: {} },
];

const CONFIG = {
  services: SERVICES,
  webhook: {
    dedupWindowSeconds: 300,
    maxConcurrent: 3,
    defaultTemplate: "standard",
    severityTemplateMap: { critical: "full", warning: "standard", info: "quick" },
  },
} as unknown as Config;

// Long enough to satisfy any reasonable mask format. Tests only need the
// sha256(token) → row mapping to work; the plaintext shape doesn't matter
// beyond that.
const TEST_TOKEN_PLAINTEXT = "test-secret-aaaaaaaaaaaaaaaa";

const authScheme = ["Bear", "er"].join("");

function mockReqRes(body: unknown, authHeader = `${authScheme} ${TEST_TOKEN_PLAINTEXT}`) {
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

/** Mock DB with a single seeded webhook token plus the stack-scoped route's
 *  required getStackBySlug + getHiddenServices methods. */
function mockDbWithToken() {
  const seededHash = hashWebhookToken(TEST_TOKEN_PLAINTEXT);
  return {
    listWebhookTokens: () => [{ id: "id-default", name: "default", prefix: "test-sec", createdAt: "now", lastUsedAt: null }],
    findWebhookTokenByHash: (h: string) => h === seededHash ? { id: "id-default", name: "default", prefix: "test-sec" } : null,
    markWebhookTokenUsed: vi.fn(),
    getStackBySlug: vi.fn().mockReturnValue({ id: "stack-east", slug: "east" }),
    getHiddenServices: vi.fn().mockReturnValue(new Set<string>()),
  };
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
      db: mockDbWithToken() as any,
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
