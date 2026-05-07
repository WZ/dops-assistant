import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import { createWebhookHandler } from "./webhook-handler.js";
import type { InvestigationRunner } from "./investigation-runner.js";
import type { WebhookConfig, ServiceConfig } from "../config/schema.js";
import { eventLog } from "./event-log.js";

const SERVICES: ServiceConfig[] = [
  { name: "checkout-service", metrics: [], logLabels: {} },
  { name: "payments-api", metrics: [], logLabels: {} },
];

const DEFAULT_CONFIG: WebhookConfig = {
  secret: "test-secret",
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

describe("webhook handler", () => {
  let runner: InvestigationRunner;

  beforeEach(() => {
    runner = mockRunner();
  });

  it("rejects requests without bearer token", async () => {
    const handler = createWebhookHandler({ runner, config: DEFAULT_CONFIG, services: SERVICES });
    const { req, res } = mockReqRes({ alerts: [] });

    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects requests with wrong bearer token", async () => {
    const handler = createWebhookHandler({ runner, config: DEFAULT_CONFIG, services: SERVICES });
    const { req, res } = mockReqRes({ alerts: [] }, "Bearer wrong-token");

    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects payloads with no alerts", async () => {
    const handler = createWebhookHandler({ runner, config: DEFAULT_CONFIG, services: SERVICES });
    const { req, res } = mockReqRes({ alerts: [] }, "Bearer test-secret");

    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("returns 422 when service cannot be matched", async () => {
    const handler = createWebhookHandler({ runner, config: DEFAULT_CONFIG, services: SERVICES });
    const { req, res } = mockReqRes(
      { alerts: [{ status: "firing", labels: { alertname: "test", unknown_label: "xyz" }, annotations: {}, startsAt: "", endsAt: "" }] },
      "Bearer test-secret",
    );

    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(422);
  });

  it("returns 202 and triggers investigation for valid alert", async () => {
    const handler = createWebhookHandler({ runner, config: DEFAULT_CONFIG, services: SERVICES });
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
      "Bearer test-secret",
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
    const handler = createWebhookHandler({ runner, config: DEFAULT_CONFIG, services: SERVICES });
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
      "Bearer test-secret",
    );

    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("passes readOnlyTools: true for headless investigations", async () => {
    const handler = createWebhookHandler({ runner, config: DEFAULT_CONFIG, services: SERVICES });
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
      "Bearer test-secret",
    );

    await handler(req, res);
    expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({
      readOnlyTools: true,
    }));
  });

  it("returns structured 503 when no secret is configured", async () => {
    // Issue #18: without a secret, the webhook used to 404 from Express's
    // default HTML fallback. Now the handler always runs and returns a
    // JSON 503 with a hint so operators see a meaningful error.
    const noSecretConfig = { ...DEFAULT_CONFIG, secret: undefined };
    const handler = createWebhookHandler({ runner, config: noSecretConfig, services: SERVICES });
    const { req, res } = mockReqRes(
      {
        alerts: [{
          status: "firing",
          labels: { service: "payments-api", severity: "warning" },
          annotations: { summary: "Slow responses" },
          startsAt: "",
          endsAt: "",
        }],
      },
    );

    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: "Webhook not configured",
      // AP9: hint should name the config key, file, section, AND instruct the
      // operator to restart — terse hints caused support loops.
      hint: expect.stringMatching(/webhook\.secret.*config\.yaml.*webhook section.*restart the server/),
    }));
    // Should NOT kick off an investigation.
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("accepts valid bearer token when secret is configured (D-3 sanity)", async () => {
    // Mirrors the "returns 202" test but under the D-3 scope header — explicit
    // regression coverage that adding the 503 path didn't break the happy case.
    const handler = createWebhookHandler({ runner, config: DEFAULT_CONFIG, services: SERVICES });
    const { req, res } = mockReqRes(
      {
        alerts: [{
          status: "firing",
          labels: { alertname: "Slow", service: "payments-api", severity: "warning" },
          annotations: { summary: "Slow responses" },
          startsAt: "2026-04-17T10:00:00Z",
          endsAt: "0001-01-01T00:00:00Z",
        }],
      },
      "Bearer test-secret",
    );

    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(202);
  });

  it("rejects with 401 (not 503) when secret is set but the bearer is wrong", async () => {
    // D-3 boundary: the 503 gate must only fire when the secret is *unset*.
    // A misconfigured client (wrong token) with secret set should still 401.
    const handler = createWebhookHandler({ runner, config: DEFAULT_CONFIG, services: SERVICES });
    const { req, res } = mockReqRes({ alerts: [] }, "Bearer nope");

    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.status).not.toHaveBeenCalledWith(503);
  });
});

describe("webhook handler — named tokens (per-sender auth)", () => {
  let runner: InvestigationRunner;

  beforeEach(() => {
    runner = mockRunner();
    eventLog.reset();
  });

  const VALID_ALERT = {
    alerts: [{
      status: "firing" as const,
      labels: { alertname: "HighErrorRate", service: "checkout-service", severity: "critical" },
      annotations: { summary: "Error rate is high" },
      startsAt: "2026-04-26T10:00:00Z",
      endsAt: "0001-01-01T00:00:00Z",
    }],
  };

  it("accepts a token from webhook.tokens (no legacy secret)", async () => {
    const config: WebhookConfig = {
      ...DEFAULT_CONFIG,
      secret: undefined,
      tokens: { grafana: "grafana-token", "fortinet-shim": "fortinet-token" },
    };
    const handler = createWebhookHandler({ runner, config, services: SERVICES });
    const { req, res } = mockReqRes(VALID_ALERT, "Bearer grafana-token");

    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(202);
  });

  it("accepts each named token in the map", async () => {
    const config: WebhookConfig = {
      ...DEFAULT_CONFIG,
      secret: undefined,
      tokens: { a: "token-a", b: "token-b" },
    };
    for (const token of ["token-a", "token-b"]) {
      const localRunner = mockRunner();
      const handler = createWebhookHandler({ runner: localRunner, config, services: SERVICES });
      const { req, res } = mockReqRes(VALID_ALERT, `Bearer ${token}`);
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(202);
    }
  });

  it("legacy secret still works alongside tokens", async () => {
    const config: WebhookConfig = {
      ...DEFAULT_CONFIG,
      tokens: { other: "other-token" },
    };
    const handler = createWebhookHandler({ runner, config, services: SERVICES });
    const { req, res } = mockReqRes(VALID_ALERT, "Bearer test-secret");

    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(202);
  });

  it("rejects unknown tokens when only tokens map is set", async () => {
    const config: WebhookConfig = {
      ...DEFAULT_CONFIG,
      secret: undefined,
      tokens: { grafana: "grafana-token" },
    };
    const handler = createWebhookHandler({ runner, config, services: SERVICES });
    const { req, res } = mockReqRes(VALID_ALERT, "Bearer wrong-token");

    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("returns 503 when neither secret nor tokens map is configured", async () => {
    const config: WebhookConfig = { ...DEFAULT_CONFIG, secret: undefined };
    const handler = createWebhookHandler({ runner, config, services: SERVICES });
    const { req, res } = mockReqRes(VALID_ALERT, "Bearer any-token");

    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("returns 503 when tokens map is present but empty", async () => {
    const config: WebhookConfig = { ...DEFAULT_CONFIG, secret: undefined, tokens: {} };
    const handler = createWebhookHandler({ runner, config, services: SERVICES });
    const { req, res } = mockReqRes(VALID_ALERT, "Bearer any-token");

    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("attributes the sender name in the alert_received event", async () => {
    const config: WebhookConfig = {
      ...DEFAULT_CONFIG,
      secret: undefined,
      tokens: { "fortinet-shim": "fortinet-token" },
    };
    const handler = createWebhookHandler({ runner, config, services: SERVICES });
    const { req, res } = mockReqRes(VALID_ALERT, "Bearer fortinet-token");

    await handler(req, res);

    const { events } = eventLog.recent(10);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].kind).toBe("alert_received");
    expect(events[0].meta).toMatchObject({ sender: "fortinet-shim" });
  });

  it('attributes the legacy secret as sender "default"', async () => {
    const handler = createWebhookHandler({ runner, config: DEFAULT_CONFIG, services: SERVICES });
    const { req, res } = mockReqRes(VALID_ALERT, "Bearer test-secret");

    await handler(req, res);

    const { events } = eventLog.recent(10);
    expect(events[0].meta).toMatchObject({ sender: "default" });
  });
});

describe("webhook handler eventLog integration", () => {
  let runner: InvestigationRunner;

  beforeEach(() => {
    runner = mockRunner();
    eventLog.reset();
  });

  it("emits alert_received event with correct service when a firing alert is processed", async () => {
    const handler = createWebhookHandler({ runner, config: DEFAULT_CONFIG, services: SERVICES });
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
      "Bearer test-secret",
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
    const handler = createWebhookHandler({ runner, config: DEFAULT_CONFIG, services: SERVICES });
    const payload = {
      alerts: [{
        status: "firing",
        labels: { alertname: "HighErrorRate", service: "checkout-service", severity: "critical" },
        annotations: {},
        startsAt: "2026-03-18T10:00:00Z",
        endsAt: "0001-01-01T00:00:00Z",
      }],
    };

    const first = mockReqRes(payload, "Bearer test-secret");
    await handler(first.req, first.res);
    const second = mockReqRes(payload, "Bearer test-secret");
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
    const handler = createWebhookHandler({ runner: heldRunner, config: cfg, services: SERVICES });

    // First fires for checkout-service, takes the only slot.
    const first = mockReqRes(
      { alerts: [{ status: "firing", labels: { alertname: "A", service: "checkout-service", severity: "warning" }, annotations: {}, startsAt: "", endsAt: "" }] },
      "Bearer test-secret",
    );
    await handler(first.req, first.res);

    // Second fires for a different service — would normally bypass dedup,
    // but concurrency is at cap so it must be rejected with 429.
    const second = mockReqRes(
      { alerts: [{ status: "firing", labels: { alertname: "B", service: "payments-api", severity: "warning" }, annotations: {}, startsAt: "", endsAt: "" }] },
      "Bearer test-secret",
    );
    await handler(second.req, second.res);

    expect(second.res.status).toHaveBeenCalledWith(429);
    const { events } = eventLog.recent(10);
    const concEvent = events.find((e) => e.meta?.deliveryStatus === "concurrency_skipped");
    expect(concEvent).toBeDefined();
    expect(concEvent!.service).toBe("payments-api");
  });

  it("emits alert_received with deliveryStatus=no_service_match when labels don't resolve", async () => {
    const handler = createWebhookHandler({ runner, config: DEFAULT_CONFIG, services: SERVICES });
    const { req, res } = mockReqRes(
      { alerts: [{ status: "firing", labels: { alertname: "Mystery", weird_label: "xyz" }, annotations: {}, startsAt: "", endsAt: "" }] },
      "Bearer test-secret",
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
