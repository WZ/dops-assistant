import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { registerRoutes } from "./routes.js";
import { Database } from "./db.js";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

interface TestCtx {
  app: Express;
  db: Database;
  defaultStackId: string;
  cleanup: () => void;
}

function makeApp(stackIds: string[] = ["stk-1"]): TestCtx {
  const dbPath = join(tmpdir(), `routes-notifs-scope-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const db = new Database(dbPath);
  const app = express();
  app.use(express.json());

  const knownStacks = new Set(stackIds);
  const defaultStackId = stackIds[0]!;

  for (const id of stackIds) {
    db.createStack({ id, name: id, slug: id, config: "{}" });
  }

  const makeCtx = (slug: string) => ({
    slug,
    serviceRegistry: { load: () => [] },
    providerRegistry: { getAll: () => [], getToolsForProvider: async () => [], updateEnabledTools: async () => {} },
    investigationStore: {},
    scanScheduler: null,
  }) as any;

  const mockStackManager = {
    resolveStackIdWithFallback: (headerStackId: string | undefined) => {
      if (headerStackId && knownStacks.has(headerStackId)) {
        return { id: headerStackId, fallback: false };
      }
      return { id: defaultStackId, fallback: headerStackId !== undefined };
    },
    getContext: (id: string) => {
      if (!knownStacks.has(id)) throw new Error(`Unknown stack ${id}`);
      return makeCtx(id);
    },
    bumpActivity: () => {},
  } as any;

  registerRoutes(app, {
    db,
    stackManager: mockStackManager,
    config: { notifications: {}, webhook: {} } as any,
    skillStore: {} as any,
    sharedDedup: {} as any,
    llmModel: {} as any,
  });

  return {
    app, db, defaultStackId,
    cleanup: () => { db.close(); try { unlinkSync(dbPath); } catch {} },
  };
}

describe("GET /api/notifications — effective view", () => {
  let ctx: TestCtx;
  beforeEach(() => { ctx = makeApp(["stk-1"]); });
  afterEach(() => { ctx.cleanup(); });

  it("returns built-in defaults when nothing is configured", async () => {
    const res = await request(ctx.app).get("/api/notifications").set("X-Stack-Id", "stk-1");
    expect(res.status).toBe(200);
    expect(res.body.slack.webhookUrl).toEqual({ value: null, source: "default" });
    expect(res.body.slack.enabled.value).toBe(false);
    expect(res.body.slack.onScanComplete.value).toBe("hits-only");
    expect(res.body.email.enabled.value).toBe(false);
    expect(res.body.email.recipients).toEqual([]);
  });

  it("surfaces a per-stack override with source=override", async () => {
    ctx.db.setSetting("notifications.slack.webhookUrl", "https://hooks.example.com/g");
    ctx.db.setStackSetting("stk-1", "notifications.slack.webhookUrl", "https://hooks.example.com/o");
    const res = await request(ctx.app).get("/api/notifications").set("X-Stack-Id", "stk-1");
    expect(res.body.slack.webhookUrl).toEqual({
      value: "https://hooks.example.com/o", source: "override",
    });
  });

  it("returns global recipients + this-stack-pinned recipients", async () => {
    ctx.db.createEmailRecipient({ address: "g@x", minSeverity: "high", allowedSources: ["scan"], enabled: true });
    ctx.db.createEmailRecipient({ address: "p@x", minSeverity: "high", allowedSources: ["scan"], enabled: true, stackId: "stk-1" });
    ctx.db.createEmailRecipient({ address: "o@x", minSeverity: "high", allowedSources: ["scan"], enabled: true, stackId: "stk-other" });
    const res = await request(ctx.app).get("/api/notifications").set("X-Stack-Id", "stk-1");
    const addrs = res.body.email.recipients.map((r: any) => r.address).sort();
    expect(addrs).toEqual(["g@x", "p@x"]);
    expect(res.body.email.recipients.find((r: any) => r.address === "g@x").scope).toBe("global");
  });
});

describe("PUT /api/notifications — per-stack write", () => {
  let ctx: TestCtx;
  beforeEach(() => { ctx = makeApp(["stk-1", "stk-2"]); });
  afterEach(() => { ctx.cleanup(); });

  it("writes Slack singletons into stack_settings keyed by X-Stack-Id", async () => {
    const res = await request(ctx.app)
      .put("/api/notifications")
      .set("X-Stack-Id", "stk-1")
      .send({ slack: { webhookUrl: "https://hooks.example.com/o", enabled: true, onScanComplete: "always" } });
    expect(res.status).toBe(200);
    expect(ctx.db.getStackSetting("stk-1", "notifications.slack.webhookUrl")).toBe("https://hooks.example.com/o");
    expect(ctx.db.getStackSetting("stk-1", "notifications.slack.enabled")).toBe("true");
    expect(ctx.db.getStackSetting("stk-1", "notifications.slack.onScanComplete")).toBe("always");
    expect(ctx.db.getSetting("notifications.slack.webhookUrl")).toBeUndefined();
  });

  it("400s on non-https webhook URL", async () => {
    const res = await request(ctx.app)
      .put("/api/notifications")
      .set("X-Stack-Id", "stk-1")
      .send({ slack: { webhookUrl: "http://insecure.example.com/x" } });
    expect(res.status).toBe(400);
  });

  it("clears the per-stack webhook override when sent webhookUrl: null", async () => {
    ctx.db.setStackSetting("stk-1", "notifications.slack.webhookUrl", "https://hooks.example.com/o");
    const res = await request(ctx.app)
      .put("/api/notifications")
      .set("X-Stack-Id", "stk-1")
      .send({ slack: { webhookUrl: null } });
    expect(res.status).toBe(200);
    expect(ctx.db.getStackSetting("stk-1", "notifications.slack.webhookUrl")).toBeUndefined();
  });

  it("writes per-stack email.enabled into stack_settings", async () => {
    const res = await request(ctx.app)
      .put("/api/notifications")
      .set("X-Stack-Id", "stk-1")
      .send({ email: { enabled: false } });
    expect(res.status).toBe(200);
    expect(ctx.db.getStackSetting("stk-1", "notifications.email.enabled")).toBe("false");
    expect(ctx.db.getSetting("notifications.email.enabled")).toBeUndefined();
  });
});

describe("PUT /api/notifications/global — global write", () => {
  let ctx: TestCtx;
  beforeEach(() => { ctx = makeApp(["stk-1"]); });
  afterEach(() => { ctx.cleanup(); });

  it("writes Slack singletons into the global settings table", async () => {
    const res = await request(ctx.app)
      .put("/api/notifications/global")
      .set("X-Stack-Id", "stk-1")
      .send({ slack: { webhookUrl: "https://hooks.example.com/g", enabled: true } });
    expect(res.status).toBe(200);
    expect(ctx.db.getSetting("notifications.slack.webhookUrl")).toBe("https://hooks.example.com/g");
    expect(ctx.db.getSetting("notifications.slack.enabled")).toBe("true");
    expect(ctx.db.getStackSetting("stk-1", "notifications.slack.webhookUrl")).toBeUndefined();
  });

  it("writes global email.enabled", async () => {
    const res = await request(ctx.app)
      .put("/api/notifications/global")
      .set("X-Stack-Id", "stk-1")
      .send({ email: { enabled: true } });
    expect(res.status).toBe(200);
    expect(ctx.db.getSetting("notifications.email.enabled")).toBe("true");
  });
});

describe("POST /api/notifications/email/test — honors per-stack enable", () => {
  let ctx: TestCtx;
  beforeEach(() => { ctx = makeApp(["stk-1", "stk-2"]); });
  afterEach(() => { ctx.cleanup(); });

  it("403s when no global and no override are set", async () => {
    const r = ctx.db.createEmailRecipient({
      address: "g@x", minSeverity: "low", allowedSources: ["manual"], enabled: true,
    });
    const res = await request(ctx.app)
      .post("/api/notifications/email/test")
      .set("X-Stack-Id", "stk-1")
      .send({ recipientId: r.id });
    expect(res.status).toBe(403);
  });

  it("does not 403 when stack has email.enabled override even with global off", async () => {
    ctx.db.setStackSetting("stk-1", "notifications.email.enabled", "true");
    const r = ctx.db.createEmailRecipient({
      address: "g@x", minSeverity: "low", allowedSources: ["manual"], enabled: true,
    });
    const res = await request(ctx.app)
      .post("/api/notifications/email/test")
      .set("X-Stack-Id", "stk-1")
      .send({ recipientId: r.id });
    // The 403 guard must not trip. Downstream we expect 400 (no SMTP config
    // in this test app) — anything other than 403 confirms the resolver path.
    expect(res.status).not.toBe(403);
  });

  it("403s on stk-2 when only stk-1 has the override", async () => {
    ctx.db.setStackSetting("stk-1", "notifications.email.enabled", "true");
    const r = ctx.db.createEmailRecipient({
      address: "g@x", minSeverity: "low", allowedSources: ["manual"], enabled: true,
    });
    const res = await request(ctx.app)
      .post("/api/notifications/email/test")
      .set("X-Stack-Id", "stk-2")
      .send({ recipientId: r.id });
    expect(res.status).toBe(403);
  });
});

describe("POST /api/notifications/test — Slack honors per-stack webhook URL", () => {
  let ctx: TestCtx;
  beforeEach(() => { ctx = makeApp(["stk-1", "stk-2"]); });
  afterEach(() => { ctx.cleanup(); });

  it("400s when no global and no override are set", async () => {
    const res = await request(ctx.app)
      .post("/api/notifications/test")
      .set("X-Stack-Id", "stk-1")
      .send({});
    expect(res.status).toBe(400);
  });

  it("does not 400 when only the per-stack webhook URL is set", async () => {
    // Use an unroutable .invalid host so the Slack POST will fail at the
    // network layer (500), but the URL-configured guard must already have
    // passed by then. Anything other than 400 confirms the resolver path.
    ctx.db.setStackSetting("stk-1", "notifications.slack.webhookUrl", "https://hooks.invalid/o");
    const res = await request(ctx.app)
      .post("/api/notifications/test")
      .set("X-Stack-Id", "stk-1")
      .send({});
    expect(res.status).not.toBe(400);
  });
});

describe("Recipient routes — scope round-trip", () => {
  let ctx: TestCtx;
  beforeEach(() => { ctx = makeApp(["stk-1"]); });
  afterEach(() => { ctx.cleanup(); });

  it("GET /recipients filters out recipients pinned to other stacks", async () => {
    ctx.db.createEmailRecipient({ address: "g@x", minSeverity: "high", allowedSources: ["scan"], enabled: true });
    ctx.db.createEmailRecipient({ address: "p@x", minSeverity: "high", allowedSources: ["scan"], enabled: true, stackId: "stk-1" });
    ctx.db.createEmailRecipient({ address: "o@x", minSeverity: "high", allowedSources: ["scan"], enabled: true, stackId: "stk-other" });
    const res = await request(ctx.app).get("/api/notifications/email/recipients").set("X-Stack-Id", "stk-1");
    expect(res.status).toBe(200);
    const addrs = res.body.map((r: any) => r.address).sort();
    expect(addrs).toEqual(["g@x", "p@x"]);
  });

  it("GET /email returns scope-filtered recipients", async () => {
    ctx.db.createEmailRecipient({ address: "g@x", minSeverity: "high", allowedSources: ["scan"], enabled: true });
    ctx.db.createEmailRecipient({ address: "o@x", minSeverity: "high", allowedSources: ["scan"], enabled: true, stackId: "stk-other" });
    const res = await request(ctx.app).get("/api/notifications/email").set("X-Stack-Id", "stk-1");
    const addrs = res.body.recipients.map((r: any) => r.address).sort();
    expect(addrs).toEqual(["g@x"]);
  });

  it("POST with scope: 'global' creates a recipient with stack_id NULL", async () => {
    const res = await request(ctx.app)
      .post("/api/notifications/email/recipients")
      .set("X-Stack-Id", "stk-1")
      .send({ address: "g@x.com", minSeverity: "high", allowedSources: ["scan"], enabled: true, scope: "global" });
    expect(res.status).toBe(201);
    expect(res.body.stackId).toBeNull();
    expect(res.body.scope).toBe("global");
  });

  it("POST with scope: 'stack' uses X-Stack-Id", async () => {
    const res = await request(ctx.app)
      .post("/api/notifications/email/recipients")
      .set("X-Stack-Id", "stk-1")
      .send({ address: "p@x.com", minSeverity: "high", allowedSources: ["scan"], enabled: true, scope: "stack" });
    expect(res.body.stackId).toBe("stk-1");
    expect(res.body.scope).toBe("stack");
  });

  it("POST without scope defaults to global (stack_id NULL)", async () => {
    const res = await request(ctx.app)
      .post("/api/notifications/email/recipients")
      .set("X-Stack-Id", "stk-1")
      .send({ address: "g@x.com", minSeverity: "high", allowedSources: ["scan"], enabled: true });
    expect(res.status).toBe(201);
    expect(res.body.stackId).toBeNull();
  });

  it("PUT can re-scope an existing recipient", async () => {
    const r = ctx.db.createEmailRecipient({ address: "a@x", minSeverity: "high", allowedSources: ["scan"], enabled: true });
    const res = await request(ctx.app)
      .put(`/api/notifications/email/recipients/${r.id}`)
      .set("X-Stack-Id", "stk-1")
      .send({ scope: "stack" });
    expect(res.body.stackId).toBe("stk-1");
  });

  it("PUT with scope: 'global' clears stackId", async () => {
    const r = ctx.db.createEmailRecipient({ address: "a@x", minSeverity: "high", allowedSources: ["scan"], enabled: true, stackId: "stk-1" });
    const res = await request(ctx.app)
      .put(`/api/notifications/email/recipients/${r.id}`)
      .set("X-Stack-Id", "stk-1")
      .send({ scope: "global" });
    expect(res.body.stackId).toBeNull();
  });
});

describe("DELETE /api/notifications/override — clear stack overrides", () => {
  let ctx: TestCtx;
  beforeEach(() => { ctx = makeApp(["stk-1", "stk-2"]); });
  afterEach(() => { ctx.cleanup(); });

  it("removes all stack_settings rows for X-Stack-Id, leaves globals + other stacks untouched", async () => {
    ctx.db.setSetting("notifications.slack.webhookUrl", "https://hooks.example.com/g");
    ctx.db.setStackSetting("stk-1", "notifications.slack.webhookUrl", "https://hooks.example.com/o1");
    ctx.db.setStackSetting("stk-1", "notifications.slack.enabled", "false");
    ctx.db.setStackSetting("stk-2", "notifications.slack.webhookUrl", "https://hooks.example.com/o2");
    const res = await request(ctx.app).delete("/api/notifications/override").set("X-Stack-Id", "stk-1");
    expect(res.status).toBe(200);
    expect(ctx.db.getStackSetting("stk-1", "notifications.slack.webhookUrl")).toBeUndefined();
    expect(ctx.db.getStackSetting("stk-1", "notifications.slack.enabled")).toBeUndefined();
    expect(ctx.db.getStackSetting("stk-2", "notifications.slack.webhookUrl")).toBe("https://hooks.example.com/o2");
    expect(ctx.db.getSetting("notifications.slack.webhookUrl")).toBe("https://hooks.example.com/g");
  });
});
