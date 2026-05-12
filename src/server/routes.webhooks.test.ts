import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express, { type Express, type RequestHandler } from "express";
import request from "supertest";
import { registerRoutes } from "./routes.js";
import { Database } from "./db.js";
import { hashWebhookToken, generateWebhookToken } from "./webhook-tokens.js";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

vi.mock("./agents.js", () => ({
  createMastraAdapters: vi.fn().mockResolvedValue({
    investigationAgent: {
      investigate: vi.fn().mockResolvedValue({
        service: "checkout",
        severity: "low",
        summary: "Synthetic test report",
        impact: { duration: "0m", description: "Synthetic test impact" },
        trigger: "Synthetic alert",
        rootCause: "Synthetic test",
        contributingFactors: [],
        timeline: [],
        evidence: { metrics: [], logs: [], infra: [] },
        dashboardLinks: [],
        recommendedActions: [],
        confidence: "low",
        confidenceScore: 0.1,
        investigatedAt: new Date().toISOString(),
      }),
    },
  }),
}));

/**
 * Route tests for the Settings → Alert Webhooks endpoints. Tokens are
 * managed in the DB; fixtures seed the webhook_tokens table directly.
 */

interface TestCtx {
  app: Express;
  db: Database;
  defaultStackId: string;
  cleanup: () => void;
}

interface MakeAppOptions {
  stacks?: Array<{ id: string; slug: string }>;
  hasProviders?: boolean;
  services?: Array<{ name: string; metrics?: Array<{ query: string; description: string }>; logLabels?: Record<string, string> }>;
  appBaseUrl?: string;
  dedupAllowed?: boolean;
  webhookTestLimiter?: RequestHandler;
}

function makeApp(opts: MakeAppOptions = {}): TestCtx {
  const stacks = opts.stacks ?? [{ id: "stack-default", slug: "default" }];
  const services = opts.services ?? [];
  const dbPath = join(tmpdir(), `routes-webhooks-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const db = new Database(dbPath);
  const app = express();
  app.use(express.json());

  const stackById = new Map(stacks.map((s) => [s.id, s]));
  const defaultStackId = stacks[0]!.id;

  const makeCtx = (id: string, slug: string) => ({
    id,
    slug,
    serviceRegistry: { load: () => services },
    providerRegistry: {
      getProviders: () => opts.hasProviders ? [{ name: "mock" }] : [],
      getAll: () => [],
    },
  } as any);

  const mockStackManager = {
    resolveStackIdWithFallback: (headerStackId: string | undefined) => {
      if (headerStackId && stackById.has(headerStackId)) {
        return { id: headerStackId, fallback: false };
      }
      return { id: defaultStackId, fallback: headerStackId !== undefined };
    },
    getContext: (id: string) => {
      const s = stackById.get(id);
      if (!s) throw new Error(`Unknown stack ${id}`);
      return makeCtx(id, s.slug);
    },
    bumpActivity: () => {},
  } as any;

  registerRoutes(app, {
    db,
    stackManager: mockStackManager,
    config: {
      services,
      notifications: opts.appBaseUrl ? { email: { appBaseUrl: opts.appBaseUrl } } : {},
      webhook: {
        severityTemplateMap: { critical: "full", warning: "standard", info: "quick" },
        defaultTemplate: "standard",
        dedupWindowSeconds: 300,
        maxConcurrent: 3,
      },
    } as any,
    skillStore: {
      search: () => [],
      searchEnabled: () => [],
      formatForPrompt: () => "",
    } as any,
    sharedDedup: {
      shouldInvestigate: () => ({ allowed: opts.dedupAllowed ?? true }),
      markStarted: () => {},
      markCompleted: () => {},
      getActiveCount: () => 0,
    } as any,
    llmModel: {} as any,
    webhookTestLimiter: opts.webhookTestLimiter,
  });

  return {
    app,
    db,
    defaultStackId,
    cleanup: () => {
      db.close();
      try { unlinkSync(dbPath); } catch { /* file may not exist */ }
    },
  };
}

describe("GET /api/webhooks/info", () => {
  let ctx: TestCtx;
  afterEach(() => { ctx?.cleanup(); });

  it("returns DB tokens with prefix-based masking, never the plaintext", async () => {
    const t1 = generateWebhookToken();
    const t2 = generateWebhookToken();
    ctx = makeApp({});
    ctx.db.createWebhookToken({ id: t1.id, name: "grafana", tokenHash: t1.tokenHash, prefix: t1.prefix, stackId: ctx.defaultStackId });
    ctx.db.createWebhookToken({ id: t2.id, name: "datadog", tokenHash: t2.tokenHash, prefix: t2.prefix, stackId: ctx.defaultStackId });

    const res = await request(ctx.app).get("/api/webhooks/info").expect(200);

    expect(res.body.tokens).toHaveLength(2);
    const grafana = res.body.tokens.find((t: { name: string }) => t.name === "grafana");
    expect(grafana.masked).toBe(`hook_${t1.prefix}…`);
    expect(JSON.stringify(res.body)).not.toContain(t1.token);
    expect(JSON.stringify(res.body)).not.toContain(t2.token);
  });

  it("returns the stack-scoped path URL based on X-Stack-Id", async () => {
    ctx = makeApp({
      stacks: [
        { id: "stack-default", slug: "default" },
        { id: "stack-east", slug: "us-east" },
      ],
    });

    const east = await request(ctx.app)
      .get("/api/webhooks/info")
      .set("X-Stack-Id", "stack-east")
      .expect(200);

    expect(east.body.url).toBe("/api/webhook/alert/us-east");
    expect(east.body.stackSlug).toBe("us-east");
    expect(east.body.defaultUrl).toBe("/api/webhook/alert");
  });

  it("surfaces the service-label contract and severity map for the GUI panel", async () => {
    ctx = makeApp({});
    const res = await request(ctx.app).get("/api/webhooks/info").expect(200);

    expect(res.body.serviceLabelKeys).toEqual(["service", "service_name", "app", "job", "deployment"]);
    expect(res.body.severityTemplateMap).toEqual({ critical: "full", warning: "standard", info: "quick" });
    expect(res.body.defaultTemplate).toBe("standard");
    expect(res.body.dedupWindowSeconds).toBe(300);
    expect(res.body.maxConcurrent).toBe(3);
    expect(res.body.acceptsResolved).toBe(false);
  });

  it("returns an empty token list on a fresh deploy", async () => {
    ctx = makeApp({});
    const res = await request(ctx.app).get("/api/webhooks/info").expect(200);
    expect(res.body.tokens).toEqual([]);
  });
});

describe("POST /api/webhooks/tokens", () => {
  let ctx: TestCtx;
  afterEach(() => { ctx?.cleanup(); });

  it("generates a token, persists the hash, returns plaintext exactly once", async () => {
    ctx = makeApp({});

    const create = await request(ctx.app)
      .post("/api/webhooks/tokens")
      .send({ name: "grafana-prod" })
      .expect(201);

    expect(create.body.name).toBe("grafana-prod");
    expect(create.body.token).toMatch(/^hook_[0-9a-f]{32}$/);
    expect(create.body.masked).toMatch(/^hook_[0-9a-f]{8}…$/);
    expect(create.body.id).toBeTruthy();

    const list = await request(ctx.app).get("/api/webhooks/tokens").expect(200);
    expect(list.body.tokens).toHaveLength(1);
    expect(list.body.tokens[0]).toMatchObject({ name: "grafana-prod" });
    expect(JSON.stringify(list.body)).not.toContain(create.body.token);
  });

  it("rejects invalid token names", async () => {
    ctx = makeApp({});
    await request(ctx.app).post("/api/webhooks/tokens").send({ name: "" }).expect(400);
    await request(ctx.app).post("/api/webhooks/tokens").send({ name: "a".repeat(65) }).expect(400);
    await request(ctx.app).post("/api/webhooks/tokens").send({ name: "name with /slash" }).expect(400);
    await request(ctx.app).post("/api/webhooks/tokens").send({}).expect(400);
  });
});

describe("DELETE /api/webhooks/tokens/:id", () => {
  let ctx: TestCtx;
  afterEach(() => { ctx?.cleanup(); });

  it("revokes a token and returns 204; subsequent GETs no longer list it", async () => {
    ctx = makeApp({});
    const create = await request(ctx.app).post("/api/webhooks/tokens").send({ name: "grafana" }).expect(201);

    await request(ctx.app).delete(`/api/webhooks/tokens/${create.body.id}`).expect(204);

    const list = await request(ctx.app).get("/api/webhooks/tokens").expect(200);
    expect(list.body.tokens).toEqual([]);
  });

  it("returns 404 for unknown token id", async () => {
    ctx = makeApp({});
    await request(ctx.app).delete("/api/webhooks/tokens/not-a-real-id").expect(404);
  });
});

describe("POST /api/webhooks/test", () => {
  let ctx: TestCtx;
  afterEach(() => { ctx?.cleanup(); });

  it("runs the webhook test limiter before auth", async () => {
    const limitedPaths: string[] = [];
    ctx = makeApp({
      webhookTestLimiter: (req, res) => {
        limitedPaths.push(req.path);
        res.status(429).json({ error: "limited" });
      },
    });

    await request(ctx.app).post("/api/webhooks/test").send({}).expect(429);

    expect(limitedPaths).toEqual(["/api/webhooks/test"]);
  });

  it("rejects when no token is supplied", async () => {
    ctx = makeApp({ services: [{ name: "checkout" }], hasProviders: true });
    await request(ctx.app).post("/api/webhooks/test").send({}).expect(401);
  });

  it("rejects when the supplied token doesn't match any DB row", async () => {
    ctx = makeApp({ services: [{ name: "checkout" }], hasProviders: true });
    await request(ctx.app)
      .post("/api/webhooks/test")
      .send({ token: "hook_unknown_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })
      .expect(401);
  });

  it("returns 409 when stack has no providers", async () => {
    const t = generateWebhookToken();
    ctx = makeApp({ services: [{ name: "checkout" }], hasProviders: false });
    ctx.db.createWebhookToken({ id: t.id, name: "grafana", tokenHash: t.tokenHash, prefix: t.prefix, stackId: ctx.defaultStackId });

    const res = await request(ctx.app)
      .post("/api/webhooks/test")
      .send({ token: t.token })
      .expect(409);
    expect(res.body.error).toMatch(/No providers/i);
  });

  it("returns 409 when stack has no services", async () => {
    const t = generateWebhookToken();
    ctx = makeApp({ services: [], hasProviders: true });
    ctx.db.createWebhookToken({ id: t.id, name: "grafana", tokenHash: t.tokenHash, prefix: t.prefix, stackId: ctx.defaultStackId });

    const res = await request(ctx.app)
      .post("/api/webhooks/test")
      .send({ token: t.token })
      .expect(409);
    expect(res.body.error).toMatch(/No services/i);
  });

  it("returns 404 when the requested service isn't in the stack", async () => {
    const t = generateWebhookToken();
    ctx = makeApp({ services: [{ name: "checkout" }], hasProviders: true });
    ctx.db.createWebhookToken({ id: t.id, name: "grafana", tokenHash: t.tokenHash, prefix: t.prefix, stackId: ctx.defaultStackId });

    const res = await request(ctx.app)
      .post("/api/webhooks/test")
      .send({ token: t.token, service: "not-a-real-service" })
      .expect(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("returns 202 only when the synthetic alert starts an investigation", async () => {
    const t = generateWebhookToken();
    ctx = makeApp({ services: [{ name: "checkout" }], hasProviders: true });
    ctx.db.createWebhookToken({ id: t.id, name: "grafana", tokenHash: t.tokenHash, prefix: t.prefix, stackId: ctx.defaultStackId });

    const res = await request(ctx.app)
      .post("/api/webhooks/test")
      .send({ token: t.token })
      .expect(202);

    expect(res.body).toMatchObject({ deliveryStatus: "investigated", investigationStarted: true });
  });

  it("returns 409 when the synthetic alert is deduplicated instead of showing a successful test", async () => {
    const t = generateWebhookToken();
    ctx = makeApp({ services: [{ name: "checkout" }], hasProviders: true, dedupAllowed: false });
    ctx.db.createWebhookToken({ id: t.id, name: "grafana", tokenHash: t.tokenHash, prefix: t.prefix, stackId: ctx.defaultStackId });

    const res = await request(ctx.app)
      .post("/api/webhooks/test")
      .send({ token: t.token })
      .expect(409);

    expect(res.body).toMatchObject({ deliveryStatus: "deduplicated", investigationStarted: false });
  });
});

describe("POST /api/webhooks/loopback-test", () => {
  let ctx: TestCtx;
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    ctx?.cleanup();
  });

  it("runs the webhook test limiter before auth", async () => {
    const limitedPaths: string[] = [];
    ctx = makeApp({
      webhookTestLimiter: (req, res) => {
        limitedPaths.push(req.path);
        res.status(429).json({ error: "limited" });
      },
    });

    await request(ctx.app).post("/api/webhooks/loopback-test").send({}).expect(429);

    expect(limitedPaths).toEqual(["/api/webhooks/loopback-test"]);
  });

  it("returns 412 when appBaseUrl is unset (the loopback target is undefined)", async () => {
    const t = generateWebhookToken();
    ctx = makeApp({ services: [{ name: "checkout" }], hasProviders: true });
    ctx.db.createWebhookToken({ id: t.id, name: "grafana", tokenHash: t.tokenHash, prefix: t.prefix, stackId: ctx.defaultStackId });

    const res = await request(ctx.app)
      .post("/api/webhooks/loopback-test")
      .send({ token: t.token })
      .expect(412);
    expect(res.body.error).toMatch(/appBaseUrl/i);
  });

  it("rejects when no token is supplied", async () => {
    ctx = makeApp({ services: [{ name: "checkout" }], hasProviders: true, appBaseUrl: "https://alerts.example" });
    await request(ctx.app).post("/api/webhooks/loopback-test").send({}).expect(401);
  });

  it("dispatches an HTTP POST to appBaseUrl + the stack-scoped webhook path with the supplied bearer", async () => {
    const t = generateWebhookToken();
    ctx = makeApp({
      stacks: [{ id: "stack-east", slug: "us-east" }],
      services: [{ name: "checkout" }],
      hasProviders: true,
      appBaseUrl: "https://alerts.example.com",
    });
    ctx.db.createWebhookToken({ id: t.id, name: "grafana", tokenHash: t.tokenHash, prefix: t.prefix, stackId: ctx.defaultStackId });

    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    let capturedBody: unknown;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedHeaders = init?.headers as Record<string, string>;
      capturedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
      return new Response(JSON.stringify({ message: "Investigation started" }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const res = await request(ctx.app)
      .post("/api/webhooks/loopback-test")
      .set("X-Stack-Id", "stack-east")
      .send({ token: t.token, severity: "critical" })
      .expect(200);

    expect(capturedUrl).toBe("https://alerts.example.com/api/webhook/alert/us-east");
    expect(capturedHeaders?.["Authorization"]).toBe(`Bearer ${t.token}`);
    expect(capturedBody).toMatchObject({
      alerts: [{ status: "firing", labels: { service: "checkout", severity: "critical" } }],
    });
    expect(res.body).toMatchObject({
      targetUrl: "https://alerts.example.com/api/webhook/alert/us-east",
      status: 202,
      ok: true,
      tokenName: "grafana",
    });
    expect(res.body.latencyMs).toBeTypeOf("number");
  });

  it("returns 502 with a hint when the loopback fetch fails", async () => {
    const t = generateWebhookToken();
    ctx = makeApp({ services: [{ name: "checkout" }], hasProviders: true, appBaseUrl: "https://alerts.example.com" });
    ctx.db.createWebhookToken({ id: t.id, name: "grafana", tokenHash: t.tokenHash, prefix: t.prefix, stackId: ctx.defaultStackId });

    globalThis.fetch = (async () => { throw new Error("ENOTFOUND"); }) as typeof fetch;

    const res = await request(ctx.app)
      .post("/api/webhooks/loopback-test")
      .send({ token: t.token })
      .expect(502);

    expect(res.body.error).toMatch(/ENOTFOUND/);
    expect(res.body.targetUrl).toBe("https://alerts.example.com/api/webhook/alert/default");
    expect(res.body.hint).toMatch(/curl/);
  });

  it("relays whatever status the upstream webhook handler returned, including non-OK", async () => {
    const t = generateWebhookToken();
    ctx = makeApp({ services: [{ name: "checkout" }], hasProviders: true, appBaseUrl: "https://alerts.example.com" });
    ctx.db.createWebhookToken({ id: t.id, name: "grafana", tokenHash: t.tokenHash, prefix: t.prefix, stackId: ctx.defaultStackId });

    globalThis.fetch = (async () => new Response(
      JSON.stringify({ error: "Could not identify service from alert labels" }),
      { status: 422, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

    const res = await request(ctx.app)
      .post("/api/webhooks/loopback-test")
      .send({ token: t.token })
      .expect(200);

    expect(res.body.status).toBe(422);
    expect(res.body.ok).toBe(false);
    expect(res.body.body).toContain("Could not identify service");
  });

  it("trims trailing slashes off appBaseUrl so the assembled URL is well-formed", async () => {
    const t = generateWebhookToken();
    ctx = makeApp({ services: [{ name: "checkout" }], hasProviders: true, appBaseUrl: "https://alerts.example.com///" });
    ctx.db.createWebhookToken({ id: t.id, name: "grafana", tokenHash: t.tokenHash, prefix: t.prefix, stackId: ctx.defaultStackId });

    let capturedUrl: string | undefined;
    globalThis.fetch = (async (input: string | URL) => {
      capturedUrl = String(input);
      return new Response("{}", { status: 202 });
    }) as typeof fetch;

    await request(ctx.app).post("/api/webhooks/loopback-test").send({ token: t.token }).expect(200);
    expect(capturedUrl).toBe("https://alerts.example.com/api/webhook/alert/default");
  });
});

describe("GET /api/webhooks/recent", () => {
  let ctx: TestCtx;
  afterEach(() => { ctx?.cleanup(); });

  it("returns alert_received events filtered to source=alertmanager, newest first, capped at 20", async () => {
    ctx = makeApp();
    const baseTs = Date.now();
    for (let i = 0; i < 22; i++) {
      ctx.db.insertEvent({
        id: `am-${i}`,
        ts: baseTs + i,
        kind: "alert_received",
        severity: "warn",
        summary: `alert · A${i} · checkout`,
        stackId: ctx.defaultStackId,
        service: "checkout",
        meta: { source: "alertmanager", sender: "grafana", alertName: `A${i}`, deliveryStatus: "investigated" },
      });
    }

    const res = await request(ctx.app).get("/api/webhooks/recent").expect(200);
    expect(res.body.events).toHaveLength(20);
    expect(res.body.events[0].id).toBe("am-21");
  });

  it("scopes to the active stack via X-Stack-Id", async () => {
    ctx = makeApp({
      stacks: [
        { id: "stack-default", slug: "default" },
        { id: "stack-east", slug: "us-east" },
      ],
    });
    ctx.db.insertEvent({
      id: "default-1", ts: 1, kind: "alert_received", severity: "warn", summary: "default-alert",
      stackId: "stack-default", meta: { source: "alertmanager", sender: "g", deliveryStatus: "investigated" },
    });
    ctx.db.insertEvent({
      id: "east-1", ts: 2, kind: "alert_received", severity: "warn", summary: "east-alert",
      stackId: "stack-east", meta: { source: "alertmanager", sender: "g", deliveryStatus: "investigated" },
    });

    const east = await request(ctx.app).get("/api/webhooks/recent").set("X-Stack-Id", "stack-east").expect(200);
    expect(east.body.events.map((e: { id: string }) => e.id)).toEqual(["east-1"]);
  });

  it("returns empty events array when no webhook events exist", async () => {
    ctx = makeApp();
    const res = await request(ctx.app).get("/api/webhooks/recent").expect(200);
    expect(res.body.events).toEqual([]);
  });
});
