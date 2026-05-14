import { describe, it, expect, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { registerRoutes } from "./routes.js";
import { Database } from "./db.js";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ulid } from "ulid";

interface TestCtx {
  app: Express;
  db: Database;
  stackId: string;
  cleanup: () => void;
}

function makeApp(reasoningEffort?: Record<string, "low" | "medium" | "high">): TestCtx {
  const dbPath = join(tmpdir(), `routes-llm-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const db = new Database(dbPath);
  const stackId = ulid();
  db.createStack({ id: stackId, name: "Default", slug: "default", config: "{\"providers\":[]}" });

  const app = express();
  app.use(express.json());

  const mockStackManager = {
    resolveStackIdWithFallback: () => ({ id: stackId, fallback: false }),
    getContext: () => ({
      id: stackId,
      slug: "default",
      serviceRegistry: { load: () => [] },
      providerRegistry: { getProviders: () => [], getAll: () => [] },
    } as any),
    bumpActivity: () => {},
  } as any;

  registerRoutes(app, {
    db,
    stackManager: mockStackManager,
    config: {
      llm: {
        apiKey: "k",
        model: "test",
        retry: { maxAttempts: 8, initialDelayMs: 2000, maxDelayMs: 60_000, jitterPercent: 0.3 },
        ...(reasoningEffort ? { reasoningEffort } : {}),
      },
      services: [],
      webhook: {
        severityTemplateMap: { critical: "full", warning: "standard", info: "quick" },
        defaultTemplate: "standard",
        dedupWindowSeconds: 300,
        maxConcurrent: 3,
      },
    } as any,
    skillStore: { search: () => [], searchEnabled: () => [], formatForPrompt: () => "" } as any,
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
    stackId,
    cleanup: () => {
      db.close();
      try { unlinkSync(dbPath); } catch { /* ignore */ }
    },
  };
}

describe("GET /api/stacks/:id/llm/settings", () => {
  let ctx: TestCtx;
  afterEach(() => { ctx?.cleanup(); });

  it("404s for an unknown stack", async () => {
    ctx = makeApp();
    await request(ctx.app).get("/api/stacks/does-not-exist/llm/settings").expect(404);
  });

  it("returns null sources for every bucket when nothing is set", async () => {
    ctx = makeApp();
    const res = await request(ctx.app).get(`/api/stacks/${ctx.stackId}/llm/settings`).expect(200);
    expect(res.body.stack).toEqual({});
    expect(res.body.effective.chat.source).toBeNull();
    expect(res.body.effective.investigation.source).toBeNull();
    expect(res.body.effective.discovery.source).toBeNull();
  });

  it("returns config defaults with source=config or source=default", async () => {
    ctx = makeApp({ default: "medium", chat: "low" });
    const res = await request(ctx.app).get(`/api/stacks/${ctx.stackId}/llm/settings`).expect(200);
    expect(res.body.effective.chat).toEqual({ effort: "low", source: "config" });
    expect(res.body.effective.investigation).toEqual({ effort: "medium", source: "default" });
    expect(res.body.config.default).toBe("medium");
  });
});

describe("PUT /api/stacks/:id/llm/settings", () => {
  let ctx: TestCtx;
  afterEach(() => { ctx?.cleanup(); });

  it("404s for an unknown stack", async () => {
    ctx = makeApp();
    await request(ctx.app).put("/api/stacks/does-not-exist/llm/settings").send({ chat: "high" }).expect(404);
  });

  it("400s on unknown bucket", async () => {
    ctx = makeApp();
    const res = await request(ctx.app).put(`/api/stacks/${ctx.stackId}/llm/settings`).send({ bogus: "high" });
    expect(res.status).toBe(400);
  });

  it("400s on invalid effort", async () => {
    ctx = makeApp();
    const res = await request(ctx.app).put(`/api/stacks/${ctx.stackId}/llm/settings`).send({ chat: "extreme" });
    expect(res.status).toBe(400);
  });

  it("writes a per-bucket override and returns the updated view", async () => {
    ctx = makeApp({ default: "medium" });
    const res = await request(ctx.app).put(`/api/stacks/${ctx.stackId}/llm/settings`).send({ chat: "high" }).expect(200);
    expect(res.body.stack).toEqual({ chat: "high" });
    expect(res.body.effective.chat).toEqual({ effort: "high", source: "stack" });
    expect(res.body.effective.investigation).toEqual({ effort: "medium", source: "default" });
  });

  it("null clears the bucket and restores inheritance", async () => {
    ctx = makeApp({ default: "medium" });
    await request(ctx.app).put(`/api/stacks/${ctx.stackId}/llm/settings`).send({ chat: "high" }).expect(200);
    const cleared = await request(ctx.app).put(`/api/stacks/${ctx.stackId}/llm/settings`).send({ chat: null }).expect(200);
    expect(cleared.body.stack).toEqual({});
    expect(cleared.body.effective.chat).toEqual({ effort: "medium", source: "default" });
  });

  it("partial PUT preserves untouched buckets", async () => {
    ctx = makeApp();
    await request(ctx.app).put(`/api/stacks/${ctx.stackId}/llm/settings`).send({ chat: "high", investigation: "medium" }).expect(200);
    const partial = await request(ctx.app).put(`/api/stacks/${ctx.stackId}/llm/settings`).send({ investigation: "low" }).expect(200);
    expect(partial.body.stack).toEqual({ chat: "high", investigation: "low" });
  });
});
