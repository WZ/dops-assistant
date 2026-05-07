import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { registerRoutes } from "./routes.js";
import { Database } from "./db.js";
import { hashWebhookToken, generateWebhookToken } from "./webhook-tokens.js";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * Route tests for the webhook-tab endpoints. Bootstrap follows
 * routes.scan-runs.test.ts: real Database, express + registerRoutes wired
 * up, mock stackManager that maps X-Stack-Id to a fake context.
 *
 * Tokens are managed in DB now (yaml `webhook.tokens` / `webhook.secret`
 * were dropped in this PR), so test fixtures seed the webhook_tokens table
 * directly via db.createWebhookToken.
 */

interface TestCtx {
  app: Express;
  db: Database;
  defaultStackId: string;
  cleanup: () => void;
}

interface MakeAppOptions {
  stacks?: Array<{ id: string; slug: string }>;
  /** Pre-seeded tokens. Useful for /info, /tokens/:id deletion, and /test. */
  seedTokens?: Array<{ name: string; plaintext: string }>;
  /** Whether the mock stack context exposes any MCP providers. /test
   *  pre-flights this and returns 409 when empty. */
  hasProviders?: boolean;
  /** Services configured for the test stack. Default empty. */
  services?: Array<{ name: string; metrics?: Array<{ query: string; description: string }>; logLabels?: Record<string, string> }>;
}

function makeApp(opts: MakeAppOptions = {}): TestCtx {
  const stacks = opts.stacks ?? [{ id: "stack-default", slug: "default" }];
  const services = opts.services ?? [];
  const dbPath = join(tmpdir(), `routes-webhooks-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const db = new Database(dbPath);
  const app = express();
  app.use(express.json());

  // Seed tokens before route registration so /api/webhooks/info already
  // sees them on the very first request.
  if (opts.seedTokens) {
    for (const t of opts.seedTokens) {
      db.createWebhookToken({
        id: `id-${t.name}`,
        name: t.name,
        tokenHash: hashWebhookToken(t.plaintext),
        prefix: t.plaintext.replace(/^dops_/, "").slice(0, 8),
      });
    }
  }

  const stackById = new Map(stacks.map((s) => [s.id, s]));
  const defaultStackId = stacks[0]!.id;

  const makeCtx = (id: string, slug: string) => ({
    id,
    slug,
    serviceRegistry: { load: () => services },
    providerRegistry: {
      getProviders: () => opts.hasProviders ? [{ name: "mock" }] : [],
      buildDatasourceUidMap: () => new Map(),
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
      notifications: {},
      webhook: {
        severityTemplateMap: { critical: "full", warning: "standard", info: "quick" },
        defaultTemplate: "standard",
        dedupWindowSeconds: 300,
        maxConcurrent: 3,
      },
    } as any,
    skillStore: {} as any,
    sharedDedup: {
      shouldInvestigate: () => ({ allowed: true }),
      markStarted: () => {},
      markCompleted: () => {},
      getActiveCount: () => 0,
    } as any,
    llmModel: {} as any,
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
    ctx.db.createWebhookToken({ id: t1.id, name: "grafana", tokenHash: t1.tokenHash, prefix: t1.prefix });
    ctx.db.createWebhookToken({ id: t2.id, name: "datadog", tokenHash: t2.tokenHash, prefix: t2.prefix });

    const res = await request(ctx.app).get("/api/webhooks/info").expect(200);

    expect(res.body.tokens).toHaveLength(2);
    const grafana = res.body.tokens.find((t: { name: string }) => t.name === "grafana");
    expect(grafana.masked).toBe(`dops_${t1.prefix}…`);
    // Plaintext token MUST NEVER appear in the info response.
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
    expect(create.body.token).toMatch(/^dops_[0-9a-f]{32}$/);
    expect(create.body.masked).toMatch(/^dops_[0-9a-f]{8}…$/);
    expect(create.body.id).toBeTruthy();

    // The plaintext must be retrievable from the DB only via hash; the GET
    // endpoint must never echo it back.
    const list = await request(ctx.app).get("/api/webhooks/tokens").expect(200);
    expect(list.body.tokens).toHaveLength(1);
    expect(list.body.tokens[0]).toMatchObject({ name: "grafana-prod" });
    expect(JSON.stringify(list.body)).not.toContain(create.body.token);
  });

  it("rejects invalid token names", async () => {
    ctx = makeApp({});

    const empty = await request(ctx.app).post("/api/webhooks/tokens").send({ name: "" });
    expect(empty.status).toBe(400);

    const tooLong = await request(ctx.app).post("/api/webhooks/tokens").send({ name: "a".repeat(65) });
    expect(tooLong.status).toBe(400);

    const weirdChars = await request(ctx.app).post("/api/webhooks/tokens").send({ name: "name with /slash" });
    expect(weirdChars.status).toBe(400);

    const missing = await request(ctx.app).post("/api/webhooks/tokens").send({});
    expect(missing.status).toBe(400);
  });

  it("allows multiple tokens with the same display name (rotation pattern)", async () => {
    // Operators may want to keep both "grafana-prod" entries during a
    // rotation window (one per Grafana instance, etc). The schema doesn't
    // enforce name uniqueness — the display label is for humans, the id
    // is the primary key.
    ctx = makeApp({});

    await request(ctx.app).post("/api/webhooks/tokens").send({ name: "grafana-prod" }).expect(201);
    await request(ctx.app).post("/api/webhooks/tokens").send({ name: "grafana-prod" }).expect(201);

    const list = await request(ctx.app).get("/api/webhooks/tokens").expect(200);
    expect(list.body.tokens).toHaveLength(2);
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

  it("rejects when no token is supplied", async () => {
    ctx = makeApp({ services: [{ name: "checkout" }], hasProviders: true });
    await request(ctx.app).post("/api/webhooks/test").send({}).expect(401);
  });

  it("rejects when the supplied token doesn't match any DB row", async () => {
    ctx = makeApp({ services: [{ name: "checkout" }], hasProviders: true });
    await request(ctx.app)
      .post("/api/webhooks/test")
      .send({ token: "dops_unknown_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })
      .expect(401);
  });

  it("returns 409 when stack has no providers", async () => {
    const t = generateWebhookToken();
    ctx = makeApp({ services: [{ name: "checkout" }], hasProviders: false });
    ctx.db.createWebhookToken({ id: t.id, name: "grafana", tokenHash: t.tokenHash, prefix: t.prefix });

    const res = await request(ctx.app)
      .post("/api/webhooks/test")
      .send({ token: t.token })
      .expect(409);
    expect(res.body.error).toMatch(/No providers/i);
  });

  it("returns 409 when stack has no services", async () => {
    const t = generateWebhookToken();
    ctx = makeApp({ services: [], hasProviders: true });
    ctx.db.createWebhookToken({ id: t.id, name: "grafana", tokenHash: t.tokenHash, prefix: t.prefix });

    const res = await request(ctx.app)
      .post("/api/webhooks/test")
      .send({ token: t.token })
      .expect(409);
    expect(res.body.error).toMatch(/No services/i);
  });

  it("returns 404 when the requested service isn't in the stack", async () => {
    const t = generateWebhookToken();
    ctx = makeApp({ services: [{ name: "checkout" }], hasProviders: true });
    ctx.db.createWebhookToken({ id: t.id, name: "grafana", tokenHash: t.tokenHash, prefix: t.prefix });

    const res = await request(ctx.app)
      .post("/api/webhooks/test")
      .send({ token: t.token, service: "not-a-real-service" })
      .expect(404);
    expect(res.body.error).toMatch(/not found/i);
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
    for (let i = 0; i < 5; i++) {
      ctx.db.insertEvent({
        id: `inv-${i}`,
        ts: baseTs + 100 + i,
        kind: "investigation_started",
        severity: "info",
        summary: "investigation started",
        stackId: ctx.defaultStackId,
      });
    }

    const res = await request(ctx.app).get("/api/webhooks/recent").expect(200);

    expect(res.body.events).toHaveLength(20);
    expect(res.body.events[0].id).toBe("am-21");
    expect(res.body.events.every((e: { id: string }) => e.id.startsWith("am-"))).toBe(true);
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
