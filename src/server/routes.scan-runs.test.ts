import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { registerRoutes } from "./routes.js";
import { Database } from "./db.js";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * Route tests for GET /api/scan/runs.
 *
 * Bootstrap pattern copied from routes.test.ts → makeEmailApp(): a real
 * file-backed Database plus express() + registerRoutes() wiring, and a
 * minimal stackManager mock that routes X-Stack-Id → stackContext. The mock
 * accepts a set of known stack IDs so tests can assert cross-stack
 * isolation via the /api middleware.
 */

interface TestCtx {
  app: Express;
  db: Database;
  defaultStackId: string;
  knownStacks: Set<string>;
  cleanup: () => void;
}

function makeApp(stacks: string[] = ["stack-a"]): TestCtx {
  const dbPath = join(tmpdir(), `routes-scan-runs-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const db = new Database(dbPath);
  const app = express();
  app.use(express.json());

  const knownStacks = new Set(stacks);
  const defaultStackId = stacks[0]!;

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
    app,
    db,
    defaultStackId,
    knownStacks,
    cleanup: () => {
      db.close();
      try { unlinkSync(dbPath); } catch {}
    },
  };
}

describe("GET /api/scan/runs", () => {
  let ctx: TestCtx;
  afterEach(() => { ctx?.cleanup(); });

  it("filters by req.stackId (cross-stack isolation)", async () => {
    ctx = makeApp(["stack-a", "stack-b"]);
    const now = Date.now();
    ctx.db.insertScanRun({ id: "a1", stackId: "stack-a", trigger: "manual", startedAt: now });
    ctx.db.insertScanRun({ id: "a2", stackId: "stack-a", trigger: "cron", startedAt: now - 1000 });
    ctx.db.insertScanRun({ id: "b1", stackId: "stack-b", trigger: "manual", startedAt: now });

    const resA = await request(ctx.app).get("/api/scan/runs").set("X-Stack-Id", "stack-a");
    expect(resA.status).toBe(200);
    const idsA = (resA.body.runs as Array<{ id: string }>).map(r => r.id).sort();
    expect(idsA).toEqual(["a1", "a2"]);

    const resB = await request(ctx.app).get("/api/scan/runs").set("X-Stack-Id", "stack-b");
    expect(resB.status).toBe(200);
    const idsB = (resB.body.runs as Array<{ id: string }>).map(r => r.id);
    expect(idsB).toEqual(["b1"]);
  });

  it("applies limit (default 50, max 200)", async () => {
    ctx = makeApp(["stack-a"]);
    const now = Date.now();
    for (let i = 0; i < 210; i++) {
      ctx.db.insertScanRun({ id: `r${i}`, stackId: "stack-a", trigger: "cron", startedAt: now - i });
    }
    const res = await request(ctx.app).get("/api/scan/runs?limit=500").set("X-Stack-Id", "stack-a");
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(200);
  });

  it("respects the before cursor (pagination)", async () => {
    ctx = makeApp(["stack-a"]);
    const t = Date.now();
    ctx.db.insertScanRun({ id: "older", stackId: "stack-a", trigger: "cron", startedAt: t - 1000 });
    ctx.db.insertScanRun({ id: "newer", stackId: "stack-a", trigger: "cron", startedAt: t });

    const res = await request(ctx.app).get(`/api/scan/runs?before=${t}`).set("X-Stack-Id", "stack-a");
    expect(res.status).toBe(200);
    const ids = (res.body.runs as Array<{ id: string }>).map(r => r.id);
    expect(ids).toEqual(["older"]);
  });

  it("default limit is 50 when no limit query param", async () => {
    ctx = makeApp(["stack-a"]);
    const now = Date.now();
    for (let i = 0; i < 60; i++) {
      ctx.db.insertScanRun({ id: `r${i}`, stackId: "stack-a", trigger: "cron", startedAt: now - i });
    }
    const res = await request(ctx.app).get("/api/scan/runs").set("X-Stack-Id", "stack-a");
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(50);
  });

  it("returns empty array when no runs exist", async () => {
    ctx = makeApp(["stack-a"]);
    const res = await request(ctx.app).get("/api/scan/runs").set("X-Stack-Id", ctx.defaultStackId);
    expect(res.status).toBe(200);
    expect(res.body.runs).toEqual([]);
  });

  it("falls back to default 50 when limit is NaN or non-positive", async () => {
    ctx = makeApp(["stack-a"]);
    const now = Date.now();
    for (let i = 0; i < 60; i++) {
      ctx.db.insertScanRun({ id: `r${i}`, stackId: "stack-a", trigger: "cron", startedAt: now - i });
    }
    const resNaN = await request(ctx.app).get("/api/scan/runs?limit=abc").set("X-Stack-Id", "stack-a");
    expect(resNaN.status).toBe(200);
    expect(resNaN.body.runs).toHaveLength(50);

    const resNeg = await request(ctx.app).get("/api/scan/runs?limit=-5").set("X-Stack-Id", "stack-a");
    expect(resNeg.status).toBe(200);
    expect(resNeg.body.runs).toHaveLength(50);
  });
});
