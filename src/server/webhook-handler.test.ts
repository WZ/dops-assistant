import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import { createWebhookHandler } from "./webhook-handler.js";
import { hashWebhookToken } from "./webhook-tokens.js";
import type { InvestigationRunner } from "./investigation-runner.js";
import type { WebhookConfig, ServiceConfig } from "../config/schema.js";
import type { Database } from "./db.js";
import { eventLog } from "./event-log.js";

const SERVICES: ServiceConfig[] = [
  { name: "checkout-service", metrics: [], logLabels: {} },
  { name: "payments-api", metrics: [], logLabels: {} },
];

const DEFAULT_CONFIG: WebhookConfig = {
  dedupWindowSeconds: 300,
  maxConcurrent: 3,
  defaultTemplate: "standard",
  severityTemplateMap: { critical: "full", warning: "standard", info: "quick" },
};

function mockReqRes(body: unknown, authHeader?: string) {
  const req = { body, headers: { authorization: authHeader } } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return { req, res };
}

function mockRunner(): InvestigationRunner {
  return { run: vi.fn().mockResolvedValue({}) } as unknown as InvestigationRunner;
}

/** Mock DB with the webhook-token methods the handler needs. Pass a map of
 *  plaintext token → sender name; the mock hashes them on access so the
 *  handler's resolveTokenRow flow exercises the real hashing path. */
function mockTokenDb(plaintextTokens: Record<string, string>): Database {
  const byHash = new Map<string, { id: string; name: string; prefix: string }>();
  for (const [tok, name] of Object.entries(plaintextTokens)) {
    byHash.set(hashWebhookToken(tok), { id: `id-${name}`, name, prefix: tok.slice(0, 8) });
  }
  // Mock ignores stackId — handler tests verify the auth flow, not the
  // DB-side stack scoping (which has its own tests against a real DB).
  return {
    listWebhookTokens: (_stackId: string) => Array.from(byHash.values()).map((v) => ({
      id: v.id, name: v.name, prefix: v.prefix, createdAt: "now", lastUsedAt: null,
    })),
    findWebhookTokenByHash: (hash: string, _stackId: string) => byHash.get(hash) ?? null,
    markWebhookTokenUsed: vi.fn(),
  } as unknown as Database;
}

const DEFAULT_DB = () => mockTokenDb({ "test-secret-aaaaaaaaaaaaaaaa": "default" });

describe("webhook handler", () => {
  let runner: InvestigationRunner;

  beforeEach(() => {
    runner = mockRunner();
  });

  it("rejects requests without bearer token", async () => {
    const handler = createWebhookHandler({ runner, config: DEFAULT_CONFIG, services: SERVICES, db: DEFAULT_DB() });
    const { req, res } = mockReqRes({ alerts: [] });

    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects requests with wrong bearer token", async () => {
    const handler = createWebhookHandler({ runner, config: DEFAULT_CONFIG, services: SERVICES, db: DEFAULT_DB() });
    const { req, res } = mockReqRes({ alerts: [] }, "Bearer wrong-token");

    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects payloads with no alerts", async () => {
    const handler = createWebhookHandler({ runner, config: DEFAULT_CONFIG, services: SERVICES, db: DEFAULT_DB() });
    const { req, res } = mockReqRes({ alerts: [] }, "Bearer test-secret-aaaaaaaaaaaaaaaa");

    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("returns 422 when service cannot be matched", async () => {
    const handler = createWebhookHandler({ runner, config: DEFAULT_CONFIG, services: SERVICES, db: DEFAULT_DB() });
    const { req, res } = mockReqRes(
      { alerts: [{ status: "firing", labels: { alertname: "test", unknown_label: "xyz" }, annotations: {}, startsAt: "", endsAt: "" }] },
      "Bearer test-secret-aaaaaaaaaaaaaaaa",
    );

    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(422);
  });

  it("returns 202 and triggers investigation for valid alert", async () => {
    const handler = createWebhookHandler({ runner, config: DEFAULT_CONFIG, services: SERVICES, db: DEFAULT_DB() });
    const { req, res } = mockReqRes(
      {
        alerts: [{
          status: "firing",
          labels: { alertname: "HighErrorRate", service: "checkout-service", severity: "critical" },
          annotations: { summary: "Error rate is high" },
          startsAt: "2026-03-18T10:00:00Z",
          endsAt: "0001-01-01T00:00:00Z",
        }],
      },
      "Bearer test-secret-aaaaaaaaaaaaaaaa",
    );

    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      service: "checkout-service",
      template: "full", // severity=critical → full
    }));
    // Runner should have been called
    expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({
      service: expect.objectContaining({ name: "checkout-service" }),
      template: "full",
    }));
  });

  it("skips resolved alerts", async () => {
    const handler = createWebhookHandler({ runner, config: DEFAULT_CONFIG, services: SERVICES, db: DEFAULT_DB() });
    const { req, res } = mockReqRes(
      {
        alerts: [{
          status: "resolved",
          labels: { service: "checkout-service" },
          annotations: {},
          startsAt: "",
          endsAt: "",
        }],
      },
      "Bearer test-secret-aaaaaaaaaaaaaaaa",
    );

    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("passes readOnlyTools: true for headless investigations", async () => {
    const handler = createWebhookHandler({ runner, config: DEFAULT_CONFIG, services: SERVICES, db: DEFAULT_DB() });
    const { req, res } = mockReqRes(
      {
        alerts: [{
          status: "firing",
          labels: { alertname: "HighErrorRate", service: "checkout-service", severity: "critical" },
          annotations: { summary: "Error rate is high" },
          startsAt: "2026-03-18T10:00:00Z",
          endsAt: "0001-01-01T00:00:00Z",
        }],
      },
      "Bearer test-secret-aaaaaaaaaaaaaaaa",
    );

    await handler(req, res);
    expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({
      readOnlyTools: true,
    }));
  });

  it("returns structured 503 with GUI-pointing hint when no tokens are configured in the DB", async () => {
    // Fresh deploy, zero tokens generated. Hint points operators at
    // Settings → Alert Webhooks (yaml-managed tokens were dropped in
    // the same PR as this DB-backed flow).
    const emptyDb = mockTokenDb({});
    const handler = createWebhookHandler({ runner, config: DEFAULT_CONFIG, services: SERVICES, db: emptyDb });
    const { req, res } = mockReqRes(
      {
        alerts: [{
          status: "firing",
          labels: { service: "payments-api", severity: "warning" },
          annotations: {},
          startsAt: "",
          endsAt: "",
        }],
      },
    );

    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: "Webhook not configured",
      hint: expect.stringMatching(/Settings.*Alert Webhooks/),
    }));
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("rejects unknown bearer with 401 (not 503) when the DB has tokens", async () => {
    const handler = createWebhookHandler({ runner, config: DEFAULT_CONFIG, services: SERVICES, db: DEFAULT_DB() });
    const { req, res } = mockReqRes({ alerts: [] }, "Bearer some-other-bearer-token-here");

    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.status).not.toHaveBeenCalledWith(503);
  });

  it("attributes the sender name (token row's name) in the alert_received event", async () => {
    const customDb = mockTokenDb({ "grafana-prod-token-aaaaaaaa": "grafana-prod" });
    const handler = createWebhookHandler({ runner, config: DEFAULT_CONFIG, services: SERVICES, db: customDb });
    const { req, res } = mockReqRes(
      {
        alerts: [{
          status: "firing",
          labels: { alertname: "HighErrorRate", service: "checkout-service", severity: "critical" },
          annotations: {},
          startsAt: "2026-05-07T10:00:00Z",
          endsAt: "0001-01-01T00:00:00Z",
        }],
      },
      "Bearer grafana-prod-token-aaaaaaaa",
    );

    await handler(req, res);

    const { events } = eventLog.recent(10);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].kind).toBe("alert_received");
    expect(events[0].meta).toMatchObject({ sender: "grafana-prod" });
  });

  it("bumps last_used_at on accepted webhook delivery", async () => {
    const customDb = mockTokenDb({ "valid-token-aaaaaaaaaaaaaaaa": "grafana" });
    const handler = createWebhookHandler({ runner, config: DEFAULT_CONFIG, services: SERVICES, db: customDb });
    const { req, res } = mockReqRes(
      {
        alerts: [{
          status: "firing",
          labels: { alertname: "Slow", service: "payments-api" },
          annotations: {},
          startsAt: "",
          endsAt: "0001-01-01T00:00:00Z",
        }],
      },
      "Bearer valid-token-aaaaaaaaaaaaaaaa",
    );

    await handler(req, res);
    expect(customDb.markWebhookTokenUsed).toHaveBeenCalledWith("id-grafana");
  });
});

describe("webhook handler eventLog integration", () => {
  let runner: InvestigationRunner;

  beforeEach(() => {
    runner = mockRunner();
    eventLog.reset();
  });

  it("emits alert_received event with correct service when a firing alert is processed", async () => {
    const handler = createWebhookHandler({ runner, config: DEFAULT_CONFIG, services: SERVICES, db: DEFAULT_DB() });
    const { req, res } = mockReqRes(
      {
        alerts: [{
          status: "firing",
          labels: { alertname: "HighErrorRate", service: "checkout-service", severity: "critical" },
          annotations: { summary: "Error rate is high" },
          startsAt: "2026-03-18T10:00:00Z",
          endsAt: "0001-01-01T00:00:00Z",
        }],
      },
      "Bearer test-secret-aaaaaaaaaaaaaaaa",
    );

    await handler(req, res);

    const { events } = eventLog.recent(10);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].kind).toBe("alert_received");
    expect(events[0].service).toBe("checkout-service");
    expect(events[0].meta?.deliveryStatus).toBe("investigated");
  });

  // The activity log in the upcoming Settings → Alert Webhooks tab needs
  // to render dedup + concurrency outcomes — pre-fix the eventLog only
  // recorded accepted alerts, so an operator's "did Grafana actually
  // deliver?" question went silent on every dedup'd retry. Now every
  // post-auth alert produces an event with meta.deliveryStatus.
  it("emits alert_received with deliveryStatus=deduplicated when same service is hit twice", async () => {
    const handler = createWebhookHandler({ runner, config: DEFAULT_CONFIG, services: SERVICES, db: DEFAULT_DB() });
    const payload = {
      alerts: [{
        status: "firing",
        labels: { alertname: "HighErrorRate", service: "checkout-service", severity: "critical" },
        annotations: {},
        startsAt: "2026-03-18T10:00:00Z",
        endsAt: "0001-01-01T00:00:00Z",
      }],
    };

    const first = mockReqRes(payload, "Bearer test-secret-aaaaaaaaaaaaaaaa");
    await handler(first.req, first.res);
    const second = mockReqRes(payload, "Bearer test-secret-aaaaaaaaaaaaaaaa");
    await handler(second.req, second.res);

    expect(second.res.status).toHaveBeenCalledWith(200);
    const { events } = eventLog.recent(10);
    const dedupEvent = events.find((e) => e.meta?.deliveryStatus === "deduplicated");
    expect(dedupEvent).toBeDefined();
    expect(dedupEvent!.service).toBe("checkout-service");
    expect(dedupEvent!.meta?.source).toBe("alertmanager");
  });

  it("emits alert_received with deliveryStatus=concurrency_skipped when concurrency cap hit", async () => {
    const cfg: WebhookConfig = { ...DEFAULT_CONFIG, maxConcurrent: 1 };
    // The background runner from the first call must still be holding the
    // dedup slot when the second call arrives — use a never-resolving
    // promise so markCompleted never fires during the test.
    const heldRunner = { run: vi.fn(() => new Promise(() => { /* never resolves */ })) } as unknown as InvestigationRunner;
    const handler = createWebhookHandler({ runner: heldRunner, config: cfg, services: SERVICES, db: DEFAULT_DB() });

    // First fires for checkout-service, takes the only slot.
    const first = mockReqRes(
      { alerts: [{ status: "firing", labels: { alertname: "A", service: "checkout-service", severity: "warning" }, annotations: {}, startsAt: "", endsAt: "" }] },
      "Bearer test-secret-aaaaaaaaaaaaaaaa",
    );
    await handler(first.req, first.res);

    // Second fires for a different service — would normally bypass dedup,
    // but concurrency is at cap so it must be rejected with 429.
    const second = mockReqRes(
      { alerts: [{ status: "firing", labels: { alertname: "B", service: "payments-api", severity: "warning" }, annotations: {}, startsAt: "", endsAt: "" }] },
      "Bearer test-secret-aaaaaaaaaaaaaaaa",
    );
    await handler(second.req, second.res);

    expect(second.res.status).toHaveBeenCalledWith(429);
    const { events } = eventLog.recent(10);
    const concEvent = events.find((e) => e.meta?.deliveryStatus === "concurrency_skipped");
    expect(concEvent).toBeDefined();
    expect(concEvent!.service).toBe("payments-api");
  });

  it("emits alert_received with deliveryStatus=no_service_match when labels don't resolve", async () => {
    const handler = createWebhookHandler({ runner, config: DEFAULT_CONFIG, services: SERVICES, db: DEFAULT_DB() });
    const { req, res } = mockReqRes(
      { alerts: [{ status: "firing", labels: { alertname: "Mystery", weird_label: "xyz" }, annotations: {}, startsAt: "", endsAt: "" }] },
      "Bearer test-secret-aaaaaaaaaaaaaaaa",
    );

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    const { events } = eventLog.recent(10);
    const event = events.find((e) => e.meta?.deliveryStatus === "no_service_match");
    expect(event).toBeDefined();
    // No service association on the event row itself — the service couldn't
    // be matched. Operators reading the activity log see the alertname only.
    expect(event!.service).toBeUndefined();
    expect(event!.meta?.alertName).toBe("Mystery");
  });
});
