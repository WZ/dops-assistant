import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import { createWebhookHandler } from "./webhook-handler.js";
import type { InvestigationRunner } from "./investigation-runner.js";
import type { WebhookConfig, ServiceConfig } from "../config/schema.js";

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

  it("allows requests when no secret is configured", async () => {
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
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      template: "standard", // severity=warning → standard
    }));
  });
});
