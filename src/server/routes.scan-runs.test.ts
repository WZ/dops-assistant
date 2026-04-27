import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { registerRoutes } from "./routes.js";
import { Database } from "./db.js";
import { __resetAppBaseUrlWarn } from "./slack-notifier.js";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// The slack-notifier holds a module-level "warn once per process" flag so
// operators don't get spammed when notifications.email.appBaseUrl is unset.
// Vitest's default forks-per-file isolation means the flag doesn't actually
// leak between this file and slack-notifier.test.ts today — the reset is
// defensive against a future test in this file that asserts on the
// missing-config branch and would otherwise be order-dependent.
beforeEach(() => { __resetAppBaseUrlWarn(); });

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

interface MakeAppOptions {
  stacks?: string[];
  scanScheduler?: unknown;
  /** Sets `config.notifications.email.appBaseUrl` so the Slack scan-run
   *  post emits a clickable "View run" hyperlink. Without this, the
   *  notifier (correctly) omits the link to avoid pointing operators at a
   *  default localhost URL they can't reach. Tests that assert on the
   *  link contents need to opt in. */
  appBaseUrl?: string;
}

function makeApp(optsOrStacks: string[] | MakeAppOptions = ["stack-a"]): TestCtx {
  const opts: MakeAppOptions = Array.isArray(optsOrStacks) ? { stacks: optsOrStacks } : optsOrStacks;
  const stacks = opts.stacks ?? ["stack-a"];
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
    scanScheduler: opts.scanScheduler ?? null,
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
    config: {
      notifications: opts.appBaseUrl
        ? { email: { appBaseUrl: opts.appBaseUrl } }
        : {},
      webhook: {},
    } as any,
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

  it("response includes total + hasMore alongside runs (additive shape)", async () => {
    ctx = makeApp(["stack-a"]);
    const now = Date.now();
    for (let i = 0; i < 12; i++) {
      ctx.db.insertScanRun({ id: `r${i}`, stackId: "stack-a", trigger: "cron", startedAt: now - i });
    }
    const res = await request(ctx.app).get("/api/scan/runs?limit=5").set("X-Stack-Id", "stack-a");
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(5);
    expect(res.body.total).toBe(12);
    expect(res.body.hasMore).toBe(true);
  });

  it("hasMore is false on the final page", async () => {
    ctx = makeApp(["stack-a"]);
    const now = Date.now();
    for (let i = 0; i < 7; i++) {
      ctx.db.insertScanRun({ id: `r${i}`, stackId: "stack-a", trigger: "cron", startedAt: now - i });
    }
    const res = await request(ctx.app).get("/api/scan/runs?limit=5&offset=5").set("X-Stack-Id", "stack-a");
    expect(res.body.runs).toHaveLength(2);
    expect(res.body.total).toBe(7);
    expect(res.body.hasMore).toBe(false);
  });

  it("filters by trigger (CSV multi-select)", async () => {
    ctx = makeApp(["stack-a"]);
    const now = Date.now();
    ctx.db.insertScanRun({ id: "m", stackId: "stack-a", trigger: "manual", startedAt: now });
    ctx.db.insertScanRun({ id: "c", stackId: "stack-a", trigger: "cron", startedAt: now - 1 });

    const resManual = await request(ctx.app).get("/api/scan/runs?trigger=manual").set("X-Stack-Id", "stack-a");
    expect(resManual.body.runs.map((r: { id: string }) => r.id)).toEqual(["m"]);

    const resBoth = await request(ctx.app).get("/api/scan/runs?trigger=manual,cron").set("X-Stack-Id", "stack-a");
    expect(resBoth.body.total).toBe(2);
  });

  it("filters by status", async () => {
    ctx = makeApp(["stack-a"]);
    const now = Date.now();
    ctx.db.insertScanRun({ id: "ok", stackId: "stack-a", trigger: "cron", startedAt: now });
    ctx.db.updateScanRun("ok", { status: "complete", finishedAt: now + 100 });
    ctx.db.insertScanRun({ id: "bad", stackId: "stack-a", trigger: "cron", startedAt: now - 1 });
    ctx.db.updateScanRun("bad", { status: "failed", finishedAt: now });

    const res = await request(ctx.app).get("/api/scan/runs?status=failed").set("X-Stack-Id", "stack-a");
    expect(res.body.runs.map((r: { id: string }) => r.id)).toEqual(["bad"]);
  });

  it("filters by outcome (clean / tripped / dispatched derived from hits)", async () => {
    ctx = makeApp(["stack-a"]);
    const now = Date.now();
    // clean: hits_raw=0 (default)
    ctx.db.insertScanRun({ id: "clean", stackId: "stack-a", trigger: "cron", startedAt: now });
    // tripped: raw>0, dispatched=0
    ctx.db.insertScanRun({ id: "tripped", stackId: "stack-a", trigger: "cron", startedAt: now - 1 });
    ctx.db.updateScanRun("tripped", { hitsRaw: 5, hitsDispatched: 0 });
    // dispatched: dispatched>0
    ctx.db.insertScanRun({ id: "disp", stackId: "stack-a", trigger: "cron", startedAt: now - 2 });
    ctx.db.updateScanRun("disp", { hitsRaw: 3, hitsDispatched: 2 });

    const clean = await request(ctx.app).get("/api/scan/runs?outcome=clean").set("X-Stack-Id", "stack-a");
    expect(clean.body.runs.map((r: { id: string }) => r.id)).toEqual(["clean"]);

    const tripped = await request(ctx.app).get("/api/scan/runs?outcome=tripped").set("X-Stack-Id", "stack-a");
    expect(tripped.body.runs.map((r: { id: string }) => r.id)).toEqual(["tripped"]);

    const dispatched = await request(ctx.app).get("/api/scan/runs?outcome=dispatched").set("X-Stack-Id", "stack-a");
    expect(dispatched.body.runs.map((r: { id: string }) => r.id)).toEqual(["disp"]);

    const trippedOrDispatched = await request(ctx.app).get("/api/scan/runs?outcome=tripped,dispatched").set("X-Stack-Id", "stack-a");
    expect(trippedOrDispatched.body.runs.map((r: { id: string }) => r.id).sort()).toEqual(["disp", "tripped"]);
  });

  it("filters by since/until window (ISO timestamps)", async () => {
    ctx = makeApp(["stack-a"]);
    // Window is 11:59:30 → 12:00:30 (one minute centered on noon). The
    // "early" and "late" rows sit five minutes outside it on either side
    // so the filter must exclude them.
    const t = new Date("2026-04-25T12:00:00Z").getTime();
    ctx.db.insertScanRun({ id: "early", stackId: "stack-a", trigger: "cron", startedAt: t - 5 * 60_000 });
    ctx.db.insertScanRun({ id: "in",    stackId: "stack-a", trigger: "cron", startedAt: t });
    ctx.db.insertScanRun({ id: "late",  stackId: "stack-a", trigger: "cron", startedAt: t + 5 * 60_000 });

    const res = await request(ctx.app)
      .get(`/api/scan/runs?since=${encodeURIComponent("2026-04-25T11:59:30Z")}&until=${encodeURIComponent("2026-04-25T12:00:30Z")}`)
      .set("X-Stack-Id", "stack-a");
    expect(res.body.runs.map((r: { id: string }) => r.id).sort()).toEqual(["in"]);
  });

  it("ignores invalid filter tokens silently (URL state is soft input)", async () => {
    ctx = makeApp(["stack-a"]);
    ctx.db.insertScanRun({ id: "r1", stackId: "stack-a", trigger: "cron", startedAt: Date.now() });
    const res = await request(ctx.app)
      .get("/api/scan/runs?status=bogus,complete&trigger=junk&since=not-a-date")
      .set("X-Stack-Id", "stack-a");
    expect(res.status).toBe(200);
    // status=complete still valid; "bogus" dropped. Run is still status=running
    // (no finalize called), so it shouldn't match the complete filter.
    expect(res.body.runs).toEqual([]);
  });

  it("offset paginates and offset wins over before when both present", async () => {
    ctx = makeApp(["stack-a"]);
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      ctx.db.insertScanRun({ id: `r${i}`, stackId: "stack-a", trigger: "cron", startedAt: now - i });
    }
    const res = await request(ctx.app).get(`/api/scan/runs?limit=3&offset=3&before=${now}`).set("X-Stack-Id", "stack-a");
    // Newest first, offset 3 means r3..r5
    expect(res.body.runs.map((r: { id: string }) => r.id)).toEqual(["r3", "r4", "r5"]);
    expect(res.body.total).toBe(10);
  });

  it("sort=duration orders by probe_duration_ms desc with NULLs last", async () => {
    ctx = makeApp(["stack-a"]);
    const now = Date.now();
    ctx.db.insertScanRun({ id: "fast", stackId: "stack-a", trigger: "cron", startedAt: now });
    ctx.db.updateScanRun("fast", { probeDurationMs: 100 });
    ctx.db.insertScanRun({ id: "slow", stackId: "stack-a", trigger: "cron", startedAt: now - 1 });
    ctx.db.updateScanRun("slow", { probeDurationMs: 5000 });
    ctx.db.insertScanRun({ id: "unknown", stackId: "stack-a", trigger: "cron", startedAt: now - 2 });
    // probe_duration_ms stays NULL — no updateScanRun call

    const res = await request(ctx.app).get("/api/scan/runs?sort=duration").set("X-Stack-Id", "stack-a");
    expect(res.body.runs.map((r: { id: string }) => r.id)).toEqual(["slow", "fast", "unknown"]);
  });
});

describe("GET /api/scan/runs/:id", () => {
  let ctx: TestCtx;
  afterEach(() => { ctx?.cleanup(); });

  it("returns run + joined investigations for own stack", async () => {
    ctx = makeApp(["stack-a", "stack-b"]);
    const now = Date.now();
    ctx.db.insertScanRun({ id: "r1", stackId: "stack-a", trigger: "manual", startedAt: now });
    ctx.db.updateScanRun("r1", { status: "complete", finishedAt: now + 5, hitsDispatched: 1 });
    ctx.db.linkScanRunInvestigation("r1", "inv1", {
      service: "api", ruleName: "availability", value: 0, severity: 0.5, dispatchedAt: now,
    });
    const res = await request(ctx.app).get("/api/scan/runs/r1").set("X-Stack-Id", "stack-a");
    expect(res.status).toBe(200);
    expect(res.body.run.id).toBe("r1");
    expect(res.body.investigations).toHaveLength(1);
    expect(res.body.investigations[0].investigationId).toBe("inv1");
    // status/reportSummary may be "unknown"/null when investigation doesn't exist yet
    expect(res.body.investigations[0].service).toBe("api");
    expect(res.body.investigations[0].ruleName).toBe("availability");
  });

  it("returns 404 with expectedStackId when run belongs to a different stack", async () => {
    ctx = makeApp(["stack-a", "stack-b"]);
    ctx.db.insertScanRun({ id: "r1", stackId: "stack-b", trigger: "cron", startedAt: Date.now() });
    const res = await request(ctx.app).get("/api/scan/runs/r1").set("X-Stack-Id", "stack-a");
    expect(res.status).toBe(404);
    expect(res.body.expectedStackId).toBe("stack-b");
  });

  it("returns 404 (no hint) when run does not exist at all", async () => {
    ctx = makeApp(["stack-a"]);
    const res = await request(ctx.app).get("/api/scan/runs/nope").set("X-Stack-Id", "stack-a");
    expect(res.status).toBe(404);
    expect(res.body.expectedStackId).toBeUndefined();
  });

  it("enriches investigation rows with current status and reportSummary (when report is JSON-parseable)", async () => {
    ctx = makeApp(["stack-a"]);
    const now = Date.now();
    ctx.db.insertScanRun({ id: "r1", stackId: "stack-a", trigger: "manual", startedAt: now });
    ctx.db.linkScanRunInvestigation("r1", "inv1", {
      service: "api", ruleName: "availability", value: 0, severity: 0.5, dispatchedAt: now,
    });
    // Seed an investigation with a JSON report containing a summary. No public helper
    // accepts a custom report at insert time, so we insert via raw prepared statement.
    (ctx.db as unknown as { db: import("better-sqlite3").Database }).db.prepare(
      "INSERT INTO investigations (id, service, query, status, report, stack_id) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("inv1", "api", "why down?", "complete", JSON.stringify({ summary: "DB pool exhausted", severity: "high" }), "stack-a");

    const res = await request(ctx.app).get("/api/scan/runs/r1").set("X-Stack-Id", "stack-a");
    expect(res.status).toBe(200);
    expect(res.body.investigations[0].status).toBe("complete");
    expect(res.body.investigations[0].reportSummary).toBe("DB pool exhausted");
  });

  it("returns reportSummary=null when report is not parseable JSON", async () => {
    ctx = makeApp(["stack-a"]);
    const now = Date.now();
    ctx.db.insertScanRun({ id: "r1", stackId: "stack-a", trigger: "manual", startedAt: now });
    ctx.db.linkScanRunInvestigation("r1", "inv1", {
      service: "api", ruleName: "availability", value: 0, severity: 0.5, dispatchedAt: now,
    });
    (ctx.db as unknown as { db: import("better-sqlite3").Database }).db.prepare(
      "INSERT INTO investigations (id, service, query, status, report, stack_id) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("inv1", "api", "q", "complete", "not json{{{", "stack-a");

    const res = await request(ctx.app).get("/api/scan/runs/r1").set("X-Stack-Id", "stack-a");
    expect(res.body.investigations[0].reportSummary).toBeNull();
  });
});

describe("POST /api/scan/trigger — runId in response", () => {
  let ctx: TestCtx;
  afterEach(() => { ctx?.cleanup(); });

  function makeScheduler(overrides: { enabled?: boolean; ticking?: boolean; lastRunId?: string | null } = {}) {
    const triggerNow = vi.fn(async () => undefined);
    const lastRunId = "lastRunId" in overrides ? overrides.lastRunId! : "fake-run-id";
    const getLastRunId = vi.fn(() => lastRunId);
    const getStatus = vi.fn(() => ({
      enabled: overrides.enabled ?? true,
      ticking: overrides.ticking ?? false,
      cron: "0 */4 * * *",
      timezone: "UTC",
      nextRun: null,
      lastRun: null,
      lastError: null,
      dropsByConcurrency: 0,
    }));
    return { triggerNow, getLastRunId, getStatus };
  }

  it("includes runId in the 202 success response body", async () => {
    const scheduler = makeScheduler({ lastRunId: "run-xyz" });
    ctx = makeApp({ stacks: ["stack-a"], scanScheduler: scheduler });

    const res = await request(ctx.app).post("/api/scan/trigger").set("X-Stack-Id", "stack-a");
    expect(res.status).toBe(202);
    expect(res.body.runId).toBe("run-xyz");
    expect(res.body.message).toBe("Probe pass dispatched");
    expect(scheduler.triggerNow).toHaveBeenCalledWith("manual");
    expect(scheduler.getLastRunId).toHaveBeenCalled();
  });

  it("returns 400 when scan is disabled (no runId in error body)", async () => {
    const scheduler = makeScheduler({ enabled: false });
    ctx = makeApp({ stacks: ["stack-a"], scanScheduler: scheduler });

    const res = await request(ctx.app).post("/api/scan/trigger").set("X-Stack-Id", "stack-a");
    expect(res.status).toBe(400);
    expect(res.body.runId).toBeUndefined();
    expect(scheduler.triggerNow).not.toHaveBeenCalled();
  });

  it("returns 409 when a tick is already in flight (no runId in error body)", async () => {
    const scheduler = makeScheduler({ ticking: true });
    ctx = makeApp({ stacks: ["stack-a"], scanScheduler: scheduler });

    const res = await request(ctx.app).post("/api/scan/trigger").set("X-Stack-Id", "stack-a");
    expect(res.status).toBe(409);
    expect(res.body.runId).toBeUndefined();
    expect(scheduler.triggerNow).not.toHaveBeenCalled();
  });

  it("includes runId: null when no tick has ever run yet", async () => {
    const scheduler = makeScheduler({ lastRunId: null });
    ctx = makeApp({ stacks: ["stack-a"], scanScheduler: scheduler });

    const res = await request(ctx.app).post("/api/scan/trigger").set("X-Stack-Id", "stack-a");
    expect(res.status).toBe(202);
    expect(res.body.runId).toBeNull();
  });
});

describe("POST /api/notifications/scan-run/send", () => {
  let ctx: TestCtx;
  afterEach(() => { ctx?.cleanup(); });

  it("returns 400 when runId is missing", async () => {
    ctx = makeApp(["stack-a"]);
    const res = await request(ctx.app).post("/api/notifications/scan-run/send").set("X-Stack-Id", "stack-a").send({});
    expect(res.status).toBe(400);
  });

  it("returns 404 when the run does not exist in this stack", async () => {
    ctx = makeApp(["stack-a"]);
    const res = await request(ctx.app).post("/api/notifications/scan-run/send").set("X-Stack-Id", "stack-a").send({ runId: "missing" });
    expect(res.status).toBe(404);
  });

  it("returns 400 when Slack webhook is not configured", async () => {
    ctx = makeApp(["stack-a"]);
    ctx.db.insertScanRun({ id: "r1", stackId: "stack-a", trigger: "manual", startedAt: Date.now() });
    const res = await request(ctx.app).post("/api/notifications/scan-run/send").set("X-Stack-Id", "stack-a").send({ runId: "r1" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/webhook/i);
  });

  it("returns 200 on success and includes the View run link when appBaseUrl is configured", async () => {
    // Production-realistic: operator has email config (+ appBaseUrl) set,
    // so the Slack post carries a clickable run link. Without appBaseUrl
    // the link is intentionally omitted (see slack-notifier.test.ts) to
    // avoid pointing the operator at an unreachable default URL.
    ctx = makeApp({ stacks: ["stack-a"], appBaseUrl: "https://dops.example.com" });
    ctx.db.insertScanRun({ id: "r1", stackId: "stack-a", trigger: "manual", startedAt: Date.now() });
    ctx.db.setSetting("notifications.slack.webhookUrl", "https://hooks.slack.com/test");
    // Mock global fetch to capture the Slack post
    const origFetch = global.fetch;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      const res = await request(ctx.app).post("/api/notifications/scan-run/send").set("X-Stack-Id", "stack-a").send({ runId: "r1" });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledOnce();
      const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
      expect(JSON.stringify(body)).toContain("https://dops.example.com/scan/runs/r1");
    } finally {
      global.fetch = origFetch;
    }
  });

  it("returns 502 when Slack fetch fails", async () => {
    ctx = makeApp(["stack-a"]);
    ctx.db.insertScanRun({ id: "r1", stackId: "stack-a", trigger: "manual", startedAt: Date.now() });
    ctx.db.setSetting("notifications.slack.webhookUrl", "https://hooks.slack.com/test");
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockRejectedValue(new Error("network")) as unknown as typeof fetch;
    try {
      const res = await request(ctx.app).post("/api/notifications/scan-run/send").set("X-Stack-Id", "stack-a").send({ runId: "r1" });
      expect([502, 500]).toContain(res.status);
    } finally {
      global.fetch = origFetch;
    }
  });
});
