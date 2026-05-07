import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { registerRoutes } from "./routes.js";
import { Database } from "./db.js";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * Route tests for GET /api/webhooks/info and GET /api/webhooks/recent.
 *
 * Bootstrap pattern follows routes.scan-runs.test.ts: real Database, express
 * with registerRoutes wired up, mock stackManager that maps X-Stack-Id to
 * a fake context.
 *
 * Tokens used in fixtures are 20+ chars (>= the schema's min(16) floor)
 * so the mask test exercises the production path.
 */

interface TestCtx {
  app: Express;
  db: Database;
  defaultStackId: string;
  cleanup: () => void;
}

interface MakeAppOptions {
  stacks?: Array<{ id: string; slug: string }>;
  webhook?: {
    secret?: string;
    tokens?: Record<string, string>;
    severityTemplateMap?: Record<string, string>;
    defaultTemplate?: string;
    dedupWindowSeconds?: number;
    maxConcurrent?: number;
  };
}

function makeApp(opts: MakeAppOptions = {}): TestCtx {
  const stacks = opts.stacks ?? [{ id: "stack-default", slug: "default" }];
  const dbPath = join(tmpdir(), `routes-webhooks-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const db = new Database(dbPath);
  const app = express();
  app.use(express.json());

  const stackById = new Map(stacks.map((s) => [s.id, s]));
  const defaultStackId = stacks[0]!.id;

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
      return { id, slug: s.slug } as any;
    },
    bumpActivity: () => {},
  } as any;

  registerRoutes(app, {
    db,
    stackManager: mockStackManager,
    config: {
      notifications: {},
      webhook: {
        secret: opts.webhook?.secret,
        tokens: opts.webhook?.tokens,
        severityTemplateMap: opts.webhook?.severityTemplateMap ?? {
          critical: "full",
          warning: "standard",
          info: "quick",
        },
        defaultTemplate: opts.webhook?.defaultTemplate ?? "standard",
        dedupWindowSeconds: opts.webhook?.dedupWindowSeconds ?? 300,
        maxConcurrent: opts.webhook?.maxConcurrent ?? 3,
      },
    } as any,
    skillStore: {} as any,
    sharedDedup: {} as any,
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

  it("masks per-sender tokens as first4…last4 (>=16 char path)", async () => {
    ctx = makeApp({
      webhook: {
        tokens: {
          grafana: "tok-aaaa-bbbb-cccc-dddd",   // 22 chars
          datadog: "ddog-1234567890abcdef",      // 20 chars
        },
      },
    });

    const res = await request(ctx.app).get("/api/webhooks/info").expect(200);

    expect(res.body.tokens).toHaveLength(2);
    const grafana = res.body.tokens.find((t: { name: string }) => t.name === "grafana");
    expect(grafana).toMatchObject({ name: "grafana", legacy: false, masked: "tok-…dddd" });
    const datadog = res.body.tokens.find((t: { name: string }) => t.name === "datadog");
    expect(datadog).toMatchObject({ name: "datadog", legacy: false, masked: "ddog…cdef" });
    // Full token must NEVER appear in the response — guard against accidental
    // re-introduction during refactors.
    expect(JSON.stringify(res.body)).not.toContain("tok-aaaa-bbbb-cccc-dddd");
    expect(JSON.stringify(res.body)).not.toContain("ddog-1234567890abcdef");
  });

  it("renders the legacy webhook.secret as a row named 'default' with legacy=true", async () => {
    ctx = makeApp({ webhook: { secret: "legacy-secret-1234567" } });

    const res = await request(ctx.app).get("/api/webhooks/info").expect(200);

    expect(res.body.tokens).toHaveLength(1);
    expect(res.body.tokens[0]).toMatchObject({
      name: "default",
      legacy: true,
      masked: "lega…4567",
    });
  });

  it("hides short legacy secrets entirely (the schema lets them through for back-compat)", async () => {
    // webhook.secret has no min(16) for back-compat with old deployments;
    // when the value is shorter than 16, masking degrades to a placeholder
    // so the GUI doesn't leak the entire secret.
    const secret = "ZXC123";  // 6 chars, distinct enough that we can grep
    ctx = makeApp({ webhook: { secret } });

    const res = await request(ctx.app).get("/api/webhooks/info").expect(200);

    expect(res.body.tokens[0].masked).toBe("<short token, edit config.yaml to view>");
    expect(JSON.stringify(res.body)).not.toContain(secret);
  });

  it("returns the stack-scoped path URL based on X-Stack-Id", async () => {
    ctx = makeApp({
      stacks: [
        { id: "stack-default", slug: "default" },
        { id: "stack-east", slug: "us-east" },
      ],
      webhook: { tokens: { grafana: "tok-1234567890123456" } },
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
    // The whole reason this endpoint exists: an operator pasting a Grafana
    // contact point into dops needs to know which labels dops looks for and
    // how severity maps to investigation depth, without reading source.
    ctx = makeApp({
      webhook: {
        tokens: { g: "tok-1234567890123456" },
        severityTemplateMap: { critical: "full", page: "full", warning: "standard" },
        defaultTemplate: "quick",
        dedupWindowSeconds: 600,
        maxConcurrent: 5,
      },
    });

    const res = await request(ctx.app).get("/api/webhooks/info").expect(200);

    expect(res.body.serviceLabelKeys).toEqual(["service", "service_name", "app", "job", "deployment"]);
    expect(res.body.severityTemplateMap).toEqual({ critical: "full", page: "full", warning: "standard" });
    expect(res.body.defaultTemplate).toBe("quick");
    expect(res.body.dedupWindowSeconds).toBe(600);
    expect(res.body.maxConcurrent).toBe(5);
    expect(res.body.acceptsResolved).toBe(false);
  });
});

describe("GET /api/webhooks/recent", () => {
  let ctx: TestCtx;
  afterEach(() => { ctx?.cleanup(); });

  it("returns alert_received events filtered to source=alertmanager, newest first, capped at 20", async () => {
    ctx = makeApp();
    // Seed: 22 alertmanager events + 5 unrelated kinds + 3 inbound events
    // from a different (future) source. Only the 20 newest alertmanager
    // ones should come back, in newest-first order.
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
    for (let i = 0; i < 3; i++) {
      ctx.db.insertEvent({
        id: `pd-${i}`,
        ts: baseTs + 200 + i,
        kind: "alert_received",
        severity: "warn",
        summary: "pagerduty",
        stackId: ctx.defaultStackId,
        meta: { source: "pagerduty", sender: "pd-prod" },
      });
    }

    const res = await request(ctx.app).get("/api/webhooks/recent").expect(200);

    expect(res.body.events).toHaveLength(20);
    // Newest first
    expect(res.body.events[0].id).toBe("am-21");
    // No pagerduty leakage
    expect(res.body.events.every((e: { id: string }) => e.id.startsWith("am-"))).toBe(true);
    // Shape
    expect(res.body.events[0]).toMatchObject({
      sender: "grafana",
      alertName: "A21",
      service: "checkout",
      deliveryStatus: "investigated",
    });
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

    const def = await request(ctx.app).get("/api/webhooks/recent").expect(200);
    expect(def.body.events.map((e: { id: string }) => e.id)).toEqual(["default-1"]);
  });

  it("returns empty events array when no webhook events exist", async () => {
    ctx = makeApp();
    const res = await request(ctx.app).get("/api/webhooks/recent").expect(200);
    expect(res.body.events).toEqual([]);
  });
});
