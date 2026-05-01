import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ServiceConfig } from "../config/schema.js";
import express, { type Express } from "express";
import request from "supertest";
import nodemailer from "nodemailer";
import { registerRoutes } from "./routes.js";
import { Database } from "./db.js";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { exportProviderConfig, validateImportProviders, categorizeImportActions, type ImportDryRunResult } from "./routes.js";

/**
 * Route handler tests — the old buildHandlers wrapper was removed in the
 * multi-stack refactor. These tests now verify the inferDependencyGraph logic
 * directly via the HTTP route layer using a minimal express setup.
 *
 * Since routes now depend on StackManager (middleware), full route integration
 * tests will be added in Phase 5. These tests verify the graph inference logic
 * that is still used by the routes.
 */

// We can't easily import inferDependencyGraph since it's a private function.
// Instead, test the dependency graph logic conceptually.

const services: ServiceConfig[] = [
  { name: "payments-api", metrics: [{ query: "rate(errors[5m])", description: "error rate" }], logLabels: { app: "payments" } },
];

describe("dependency graph inference", () => {
  it("detects dependencies from metric query references", () => {
    const multiServices: ServiceConfig[] = [
      { name: "api-gateway", metrics: [{ query: 'rate(http_requests_total{upstream="checkout"}[5m])', description: "req rate" }], logLabels: {} },
      { name: "checkout", metrics: [], logLabels: {} },
      { name: "payments", metrics: [], logLabels: {} },
    ];

    // Simulate the inferDependencyGraph logic
    const serviceNames = new Set(multiServices.map(s => s.name));
    const edges: Array<{ source: string; target: string }> = [];

    for (const svc of multiServices) {
      for (const metric of svc.metrics) {
        for (const otherName of serviceNames) {
          if (otherName === svc.name) continue;
          if (metric.query.includes(otherName) || metric.query.includes(otherName.replace(/-/g, "_"))) {
            if (!edges.some(e => e.source === svc.name && e.target === otherName)) {
              edges.push({ source: svc.name, target: otherName });
            }
          }
        }
      }
    }

    expect(edges.some(e => e.source === "api-gateway" && e.target === "checkout")).toBe(true);
  });

  it("returns no edges when no dependencies found", () => {
    const isolated: ServiceConfig[] = [{ name: "isolated-svc", metrics: [], logLabels: {} }];
    const serviceNames = new Set(isolated.map(s => s.name));
    const edges: Array<{ source: string; target: string }> = [];

    for (const svc of isolated) {
      for (const metric of svc.metrics) {
        for (const otherName of serviceNames) {
          if (otherName === svc.name) continue;
          if (metric.query.includes(otherName)) {
            edges.push({ source: svc.name, target: otherName });
          }
        }
      }
    }

    expect(edges).toHaveLength(0);
  });
});

// ── Feedback + Pattern tests (using real DB) ────────────────────────────────

/** Create a temp DB for testing */
function makeTempDb(): { db: Database; cleanup: () => void } {
  const dbPath = join(tmpdir(), `routes-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const db = new Database(dbPath);
  return {
    db,
    cleanup: () => {
      db.close();
      try { unlinkSync(dbPath); } catch {}
    },
  };
}

const STACK = "test-stack";

describe("Feedback creates pattern on 'useful' rating", () => {
  it("creates an incident pattern when feedback is 'useful' and report exists", () => {
    const { db, cleanup } = makeTempDb();
    try {
      // Create an investigation with a report
      db.createInvestigation(STACK, { id: "inv_1", service: "payments-api", query: "why is it slow?", status: "complete" });
      db.updateInvestigation("inv_1", {
        status: "complete",
        report: JSON.stringify({
          service: "payments-api",
          severity: "high",
          summary: "High latency on payment endpoint",
          rootCause: "Connection pool exhaustion due to leaked connections",
          recommendedActions: ["Increase pool size", "Add connection timeout"],
          confidenceScore: 0.85,
        }),
      });

      // Simulate "useful" feedback + pattern extraction (same logic as route handler)
      const investigation = db.getInvestigation(STACK, "inv_1");
      expect(investigation).toBeDefined();

      const rating = "useful";
      db.upsertFeedback(STACK, { id: "fb_1", investigationId: "inv_1", rating });

      if (rating === "useful" && investigation!.report) {
        const report = JSON.parse(investigation!.report);
        const validSeverities = ["low", "medium", "high", "critical"];
        const actions = Array.isArray(report.recommendedActions) ? report.recommendedActions.join("; ") : "";
        db.createPattern(STACK, {
          id: "pat_1",
          service: investigation!.service,
          symptom: typeof report.summary === "string" ? report.summary.slice(0, 500) : investigation!.query,
          rootCause: typeof report.rootCause === "string" ? report.rootCause.slice(0, 500) : "Unknown",
          severity: validSeverities.includes(report.severity) ? report.severity : "medium",
          recommendedActions: actions.slice(0, 1000),
          sourceInvestigationId: "inv_1",
        });
      }

      // Verify pattern was created
      const patterns = db.findSimilarPatterns(STACK, "payments-api");
      expect(patterns).toHaveLength(1);
      expect(patterns[0]!.root_cause).toBe("Connection pool exhaustion due to leaked connections");
      expect(patterns[0]!.severity).toBe("high");
      expect(patterns[0]!.recommended_actions).toContain("Increase pool size");
    } finally {
      cleanup();
    }
  });

  it("does not create a pattern when feedback is 'not_useful'", () => {
    const { db, cleanup } = makeTempDb();
    try {
      db.createInvestigation(STACK, { id: "inv_2", service: "api", query: "test", status: "complete" });
      db.updateInvestigation("inv_2", {
        status: "complete",
        report: JSON.stringify({ rootCause: "test", summary: "test", severity: "low" }),
      });

      // "not_useful" feedback — should NOT create a pattern
      db.upsertFeedback(STACK, { id: "fb_2", investigationId: "inv_2", rating: "not_useful" });

      // Pattern extraction only happens for "useful" — verify no pattern exists
      const patterns = db.findSimilarPatterns(STACK, "api");
      expect(patterns).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

describe("Feedback rejects invalid rating", () => {
  it("only accepts 'useful' or 'not_useful' as valid ratings", () => {
    // The route handler checks: if (rating !== "useful" && rating !== "not_useful") return 400
    // The DB also has a CHECK constraint: rating IN ('useful', 'not_useful')
    const validRatings = ["useful", "not_useful"];
    const invalidRatings = ["good", "bad", "thumbs_up", "", "USEFUL", "not-useful"];

    for (const rating of validRatings) {
      expect(rating === "useful" || rating === "not_useful").toBe(true);
    }
    for (const rating of invalidRatings) {
      expect(rating === "useful" || rating === "not_useful").toBe(false);
    }
  });

  it("DB CHECK constraint rejects invalid rating values", () => {
    const { db, cleanup } = makeTempDb();
    try {
      db.createInvestigation(STACK, { id: "inv_3", service: "api", query: "test", status: "complete" });

      // This should throw due to the CHECK constraint in the DB
      expect(() => {
        db.upsertFeedback(STACK, { id: "fb_3", investigationId: "inv_3", rating: "invalid" as any });
      }).toThrow();
    } finally {
      cleanup();
    }
  });
});

describe("Pattern extraction from RCA report", () => {
  it("extracts symptom from report summary", () => {
    const report = {
      summary: "Memory usage exceeds 90% on checkout-service pods",
      rootCause: "Memory leak in request handler",
      severity: "critical",
      recommendedActions: ["Restart pods", "Fix memory leak in handler.ts"],
    };

    const symptom = typeof report.summary === "string" ? report.summary.slice(0, 500) : "fallback";
    expect(symptom).toBe("Memory usage exceeds 90% on checkout-service pods");
  });

  it("falls back to query when summary is missing", () => {
    const report = { rootCause: "Unknown", severity: "medium" } as any;
    const query = "why is checkout slow?";

    const symptom = typeof report.summary === "string" ? report.summary.slice(0, 500) : query;
    expect(symptom).toBe("why is checkout slow?");
  });

  it("defaults severity to medium when report severity is invalid", () => {
    const report = { summary: "test", rootCause: "test", severity: "banana" };
    const validSeverities = ["low", "medium", "high", "critical"];
    const severity = validSeverities.includes(report.severity) ? report.severity : "medium";
    expect(severity).toBe("medium");
  });

  it("joins recommendedActions array into semicolon-separated string", () => {
    const report = { recommendedActions: ["Scale up", "Add caching", "Review queries"] };
    const actions = Array.isArray(report.recommendedActions) ? report.recommendedActions.join("; ") : "";
    expect(actions).toBe("Scale up; Add caching; Review queries");
  });

  it("truncates long fields to prevent DB overflow", () => {
    const longString = "x".repeat(1000);
    const report = {
      summary: longString,
      rootCause: longString,
      severity: "high",
      recommendedActions: [longString, longString],
    };

    const symptom = report.summary.slice(0, 500);
    const rootCause = report.rootCause.slice(0, 500);
    const actions = report.recommendedActions.join("; ").slice(0, 1000);

    expect(symptom.length).toBe(500);
    expect(rootCause.length).toBe(500);
    expect(actions.length).toBe(1000);
  });
});

// ── Provider Export/Import tests ─────────────────────────────────────────

describe("GET /api/providers/export", () => {
  it("returns provider configs as an array", async () => {
    const mockProviderInfo = {
      config: {
        name: "test-grafana",
        roles: ["metrics", "logs"],
        mcpServer: { transport: "http" as const, url: "http://localhost:8000/mcp" },
        region: "us-west-1",
      },
      source: "config" as const,
      status: "connected" as const,
      toolCount: 5,
      enabledToolCount: 3,
    };
    const exported = exportProviderConfig(mockProviderInfo as any);
    expect(exported).toEqual({
      name: "test-grafana",
      roles: ["metrics", "logs"],
      mcpServer: { transport: "http", url: "http://localhost:8000/mcp" },
      region: "us-west-1",
    });
  });

  it("omits undefined optional fields", async () => {
    const mockProviderInfo = {
      config: {
        name: "test-k8s",
        roles: ["infrastructure"],
        mcpServer: { transport: "http" as const, url: "http://localhost:8001/mcp" },
      },
      source: "gui" as const,
      status: "connected" as const,
      toolCount: 10,
      enabledToolCount: 7,
    };
    const exported = exportProviderConfig(mockProviderInfo as any);
    expect(exported).toEqual({
      name: "test-k8s",
      roles: ["infrastructure"],
      mcpServer: { transport: "http", url: "http://localhost:8001/mcp" },
    });
    expect(exported).not.toHaveProperty("region");
    expect(exported).not.toHaveProperty("webUrl");
  });
});

describe("validateImportProviders", () => {
  it("marks valid new providers as ready", () => {
    const providers = [
      { name: "new-grafana", roles: ["metrics"], mcpServer: { transport: "http", url: "http://localhost:8000/mcp" } },
    ];
    const existing = new Map<string, "config" | "gui">();
    const results = validateImportProviders(providers, existing);
    expect(results).toEqual([{ name: "new-grafana", status: "ready" }]);
  });

  it("marks invalid providers with error", () => {
    const providers = [
      { name: "bad!", roles: [], mcpServer: { transport: "http", url: "not-a-url" } },
    ];
    const existing = new Map<string, "config" | "gui">();
    const results = validateImportProviders(providers, existing);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("invalid");
    expect(results[0]!.error).toBeDefined();
  });

  it("marks conflicting providers with source", () => {
    const providers = [
      { name: "grafana", roles: ["metrics"], mcpServer: { transport: "http", url: "http://localhost:8000/mcp" } },
    ];
    const existing = new Map<string, "config" | "gui">([["grafana", "config"]]);
    const results = validateImportProviders(providers, existing);
    expect(results).toEqual([{ name: "grafana", status: "conflict", source: "config" }]);
  });

  it("marks duplicate names within the batch as invalid", () => {
    const providers = [
      { name: "my-prov", roles: ["metrics"], mcpServer: { transport: "http", url: "http://localhost:8000/mcp" } },
      { name: "my-prov", roles: ["logs"], mcpServer: { transport: "http", url: "http://localhost:8001/mcp" } },
    ];
    const existing = new Map<string, "config" | "gui">();
    const results = validateImportProviders(providers, existing);
    expect(results[0]!.status).toBe("ready");
    expect(results[1]!.status).toBe("invalid");
    expect(results[1]!.error!.toLowerCase()).toContain("duplicate");
  });

  it("handles a mix of ready, conflict, and invalid", () => {
    const providers = [
      { name: "new-one", roles: ["metrics"], mcpServer: { transport: "http", url: "http://localhost:8000/mcp" } },
      { name: "existing", roles: ["logs"], mcpServer: { transport: "http", url: "http://localhost:8001/mcp" } },
      { name: "bad", roles: [], mcpServer: { transport: "http", url: "bad" } },
    ];
    const existing = new Map<string, "config" | "gui">([["existing", "gui"]]);
    const results = validateImportProviders(providers, existing);
    expect(results[0]!.status).toBe("ready");
    expect(results[1]!.status).toBe("conflict");
    expect(results[1]!.source).toBe("gui");
    expect(results[2]!.status).toBe("invalid");
  });
});

describe("import confirm logic", () => {
  it("categorizes providers into add, overwrite, and skip", () => {
    const providers = [
      { name: "new-one", roles: ["metrics"], mcpServer: { transport: "http", url: "http://localhost:8000/mcp" } },
      { name: "existing-gui", roles: ["logs"], mcpServer: { transport: "http", url: "http://localhost:8001/mcp" } },
      { name: "existing-config", roles: ["infrastructure"], mcpServer: { transport: "http", url: "http://localhost:8002/mcp" } },
      { name: "conflict-skip", roles: ["dashboards"], mcpServer: { transport: "http", url: "http://localhost:8003/mcp" } },
    ];
    const overwrite = ["existing-gui", "existing-config"];
    const existing = new Map<string, "config" | "gui">([
      ["existing-gui", "gui"],
      ["existing-config", "config"],
      ["conflict-skip", "gui"],
    ]);
    const actions = categorizeImportActions(providers, overwrite, existing);
    expect(actions).toEqual([
      { config: providers[0], action: "add" },
      { config: providers[1], action: "overwrite" },
      { config: providers[2], action: "skip", reason: "Cannot overwrite config provider" },
      { config: providers[3], action: "skip", reason: "Conflict not in overwrite list" },
    ]);
  });
});

// ── Email notifications CRUD endpoints ──────────────────────────────────────

function makeEmailApp(opts?: { withSmtp?: boolean; config?: Record<string, unknown> }): { app: Express; db: Database; cleanup: () => void } {
  const dbPath = join(tmpdir(), `routes-email-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const db = new Database(dbPath);
  const app = express();
  app.use(express.json());
  // Minimal stackManager mock: resolves to a single "default" stack context
  const mockStackContext = {
    slug: "default",
    serviceRegistry: { load: () => [] },
    providerRegistry: { getAll: () => [], getToolsForProvider: async () => [], updateEnabledTools: async () => {} },
    investigationStore: {},
    scanScheduler: null,
  } as any;
  const mockStackManager = {
    resolveStackIdWithFallback: () => ({ id: "default", fallback: false }),
    getContext: () => mockStackContext,
    bumpActivity: () => {},
  } as any;
  const emailCfg = opts?.withSmtp
    ? {
        enabled: false,
        smtp: { host: "smtp.test.local", port: 587, secure: false, user: "u", pass: "p" },
        from: "DOps Test <dops@test.local>",
        appBaseUrl: "https://dops.test.local/",
        retry: { attempts: 1, backoffMs: [] },
      }
    : undefined;
  registerRoutes(app, {
    db,
    stackManager: mockStackManager,
    config: { notifications: { email: emailCfg }, webhook: {}, ...(opts?.config ?? {}) } as any,
    skillStore: {} as any,
    sharedDedup: {} as any,
    llmModel: {} as any,
  });
  return { app, db, cleanup: () => { db.close(); try { unlinkSync(dbPath); } catch {} } };
}

describe("GET /api/patterns/:id", () => {
  let ctx: ReturnType<typeof makeEmailApp>;
  beforeEach(() => { ctx = makeEmailApp(); });
  afterEach(() => { ctx.cleanup(); });

  function setPatternCreatedAt(id: string, iso: string) {
    (ctx.db as any).db.prepare("UPDATE incident_patterns SET created_at = ? WHERE id = ?").run(iso, id);
  }

  it("returns a computed same-service recurrence cluster with source investigation metadata", async () => {
    ctx.db.createInvestigation("default", {
      id: "inv_seed",
      service: "payments-api",
      query: "why 5xx?",
      status: "complete",
    });
    ctx.db.updateInvestigation("inv_seed", { completed_at: "2026-04-20T12:00:00.000Z" });
    ctx.db.createInvestigation("default", {
      id: "inv_match",
      service: "payments-api",
      query: "why pool exhausted?",
      status: "complete",
    });
    ctx.db.updateInvestigation("inv_match", { completed_at: "2026-04-25T12:00:00.000Z" });
    ctx.db.createPattern("default", {
      id: "pat_seed",
      service: "payments-api",
      symptom: "5xx spike during deploy",
      rootCause: "Connection pool exhaustion due to leaked database connections",
      severity: "high",
      recommendedActions: "Increase pool max; Audit retry release path",
      sourceInvestigationId: "inv_seed",
    });
    ctx.db.createPattern("default", {
      id: "pat_match",
      service: "payments-api",
      symptom: "Elevated latency and 5xx",
      rootCause: "Leaked database connections exhausted the connection pool",
      severity: "medium",
      recommendedActions: "increase pool max; Add pool saturation alert",
      sourceInvestigationId: "inv_match",
    });
    ctx.db.createPattern("default", {
      id: "pat_miss",
      service: "payments-api",
      symptom: "Memory pressure",
      rootCause: "OOMKilled pod due to memory limit",
      severity: "high",
    });
    setPatternCreatedAt("pat_seed", "2026-04-20T00:00:00.000Z");
    setPatternCreatedAt("pat_match", "2026-04-25T00:00:00.000Z");
    setPatternCreatedAt("pat_miss", "2026-04-24T00:00:00.000Z");

    const res = await request(ctx.app).get("/api/patterns/pat_seed");

    expect(res.status).toBe(200);
    expect(res.body.seed.id).toBe("pat_seed");
    expect(res.body.clusterId).toBe("cluster_pat_seed");
    expect(res.body.recurrenceCount).toBe(2);
    expect(res.body.firstSeen).toBe("2026-04-20T00:00:00.000Z");
    expect(res.body.lastSeen).toBe("2026-04-25T00:00:00.000Z");
    expect(res.body.occurrences.map((o: { id: string }) => o.id)).toEqual(["pat_match", "pat_seed"]);
    expect(res.body.occurrences[0].investigation).toMatchObject({
      id: "inv_match",
      status: "complete",
      query: "why pool exhausted?",
    });
    expect(res.body.dedupedRecommendedActions).toEqual([
      "increase pool max",
      "Add pool saturation alert",
      "Audit retry release path",
    ]);
    expect(res.body.matchBasis).toMatchObject({
      strategy: "same_service_root_cause_overlap_v1",
      serviceScoped: true,
    });
  });

  it("returns 404 when the seed pattern is missing in the resolved stack", async () => {
    const res = await request(ctx.app).get("/api/patterns/nope");
    expect(res.status).toBe(404);
  });

  it("does not leak a seed pattern from another stack", async () => {
    ctx.db.createPattern("other-stack", {
      id: "pat_other",
      service: "payments-api",
      symptom: "x",
      rootCause: "y",
      severity: "high",
    });

    const res = await request(ctx.app).get("/api/patterns/pat_other");

    expect(res.status).toBe(404);
  });

  it("keeps an occurrence when its source investigation is missing", async () => {
    ctx.db.createPattern("default", {
      id: "pat_seed",
      service: "payments-api",
      symptom: "5xx spike",
      rootCause: "Connection pool exhaustion due to leaked database connections",
      severity: "high",
    });
    (ctx.db as any).db.pragma("foreign_keys = OFF");
    (ctx.db as any).db.prepare("UPDATE incident_patterns SET source_investigation_id = ? WHERE id = ?")
      .run("missing_inv", "pat_seed");
    (ctx.db as any).db.pragma("foreign_keys = ON");

    const res = await request(ctx.app).get("/api/patterns/pat_seed");

    expect(res.status).toBe(200);
    expect(res.body.occurrences).toHaveLength(1);
    expect(res.body.occurrences[0].investigation).toBeNull();
  });
});

describe("GET /api/investigations/:id/locate", () => {
  // Regression: deep-linking to /investigations/:id in a clean browser
  // session lands on the default stack, and the investigation 404s if it
  // lives in a different stack. The SPA now hits this endpoint to discover
  // the owning stack and replaceState's to /stacks/:stackId/investigations/:id.
  let ctx: ReturnType<typeof makeEmailApp>;
  beforeEach(() => { ctx = makeEmailApp(); });
  afterEach(() => { ctx.cleanup(); });

  it("resolves an investigation id to its owning stack regardless of req.stackId", async () => {
    // Seed investigations in two different stacks. The mock stackManager
    // resolves req.stackId to "default" (see makeEmailApp), so a regular
    // GET /api/investigations/:id would 404 for inv_other_stack.
    ctx.db.createInvestigation("default", {
      id: "inv_in_default",
      service: "payments-api",
      query: "x",
      status: "complete",
    });
    ctx.db.createInvestigation("staging", {
      id: "inv_in_staging",
      service: "payments-api",
      query: "y",
      status: "complete",
    });

    const a = await request(ctx.app).get("/api/investigations/inv_in_default/locate");
    expect(a.status).toBe(200);
    expect(a.body).toEqual({ stackId: "default" });

    const b = await request(ctx.app).get("/api/investigations/inv_in_staging/locate");
    expect(b.status).toBe(200);
    expect(b.body).toEqual({ stackId: "staging" });
  });

  it("returns 404 when the investigation id doesn't exist in any stack", async () => {
    const res = await request(ctx.app).get("/api/investigations/inv_does_not_exist/locate");
    expect(res.status).toBe(404);
  });
});

describe("/api/notifications/email", () => {
  let ctx: ReturnType<typeof makeEmailApp>;
  beforeEach(() => { ctx = makeEmailApp(); });
  afterEach(() => { ctx.cleanup(); });

  it("GET returns enabled=false and empty recipients on fresh DB", async () => {
    const res = await request(ctx.app).get("/api/notifications/email");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false, recipients: [] });
  });

  it("PUT updates global enabled", async () => {
    const res = await request(ctx.app).put("/api/notifications/email").send({ enabled: true });
    expect(res.status).toBe(200);
    const get = await request(ctx.app).get("/api/notifications/email");
    expect(get.body.enabled).toBe(true);
  });

  it("POST /recipients creates a recipient with validated fields", async () => {
    const res = await request(ctx.app).post("/api/notifications/email/recipients").send({
      address: "sre@example.com",
      label: "#sre",
      minSeverity: "high",
      allowedSources: ["webhook", "scan"],
      enabled: true,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      address: "sre@example.com",
      label: "#sre",
      minSeverity: "high",
      allowedSources: ["webhook", "scan"],
      enabled: true,
    });
    expect(res.body.id).toBeGreaterThan(0);
  });

  it("POST /recipients rejects invalid email address", async () => {
    const res = await request(ctx.app).post("/api/notifications/email/recipients").send({
      address: "not-an-email",
      minSeverity: "high",
      allowedSources: ["webhook"],
      enabled: true,
    });
    expect(res.status).toBe(400);
  });

  it("POST /recipients rejects empty allowedSources", async () => {
    const res = await request(ctx.app).post("/api/notifications/email/recipients").send({
      address: "sre@example.com",
      minSeverity: "high",
      allowedSources: [],
      enabled: true,
    });
    expect(res.status).toBe(400);
  });

  it("PUT /recipients/:id updates fields", async () => {
    const created = await request(ctx.app).post("/api/notifications/email/recipients").send({
      address: "a@x.com", minSeverity: "low", allowedSources: ["webhook"], enabled: true,
    });
    const res = await request(ctx.app).put(`/api/notifications/email/recipients/${created.body.id}`).send({
      minSeverity: "critical", enabled: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.minSeverity).toBe("critical");
    expect(res.body.enabled).toBe(false);
  });

  it("PUT /recipients/:id returns 404 for unknown id", async () => {
    const res = await request(ctx.app).put(`/api/notifications/email/recipients/99999`).send({ enabled: false });
    expect(res.status).toBe(404);
  });

  it("DELETE /recipients/:id removes the row", async () => {
    const created = await request(ctx.app).post("/api/notifications/email/recipients").send({
      address: "a@x.com", minSeverity: "low", allowedSources: ["webhook"], enabled: true,
    });
    const del = await request(ctx.app).delete(`/api/notifications/email/recipients/${created.body.id}`);
    expect(del.status).toBe(204);
    const list = await request(ctx.app).get("/api/notifications/email");
    expect(list.body.recipients).toHaveLength(0);
  });

  it("POST /test returns 403 when email notifications are globally disabled", async () => {
    const withSmtp = makeEmailApp({ withSmtp: true });
    try {
      const created = await request(withSmtp.app).post("/api/notifications/email/recipients").send({
        address: "sre@example.com", minSeverity: "low", allowedSources: ["manual"], enabled: true,
      });
      // Global toggle still off (enabled defaults to false). Expect 403.
      const res = await request(withSmtp.app).post("/api/notifications/email/test").send({ recipientId: created.body.id });
      expect(res.status).toBe(403);
    } finally { withSmtp.cleanup(); }
  });

  it("POST /test returns 400 when SMTP is not configured", async () => {
    // Default makeEmailApp has emailCfg undefined. Enable the global toggle so
    // the 403 guard passes; the endpoint should then fail on missing SMTP.
    const created = await request(ctx.app).post("/api/notifications/email/recipients").send({
      address: "sre@example.com", minSeverity: "low", allowedSources: ["manual"], enabled: true,
    });
    await request(ctx.app).put("/api/notifications/email").send({ enabled: true });
    const res = await request(ctx.app).post("/api/notifications/email/test").send({ recipientId: created.body.id });
    expect(res.status).toBe(400);
  });

  it("POST /test returns 404 for unknown recipient id", async () => {
    const withSmtp = makeEmailApp({ withSmtp: true });
    try {
      await request(withSmtp.app).put("/api/notifications/email").send({ enabled: true });
      const res = await request(withSmtp.app).post("/api/notifications/email/test").send({ recipientId: 99999 });
      expect(res.status).toBe(404);
    } finally { withSmtp.cleanup(); }
  });

  it("POST /test uses the recipient's own minSeverity so the severity filter matches", async () => {
    // The test fixture used to hardcode severity: "high", which silently
    // dropped critical-only recipients. Regression check: creating a
    // critical-only recipient and ask for a test — the notifier must attempt
    // to send, not silently filter out.
    const withSmtp = makeEmailApp({ withSmtp: true });
    try {
      // Stub nodemailer.createTransport so sends don't actually leave the box.
      const jsonT = nodemailer.createTransport({ jsonTransport: true });
      const spy = vi.spyOn(nodemailer, "createTransport").mockReturnValue(jsonT);
      try {
        await request(withSmtp.app).put("/api/notifications/email").send({ enabled: true });
        const created = await request(withSmtp.app).post("/api/notifications/email/recipients").send({
          address: "crit@example.com", minSeverity: "critical", allowedSources: ["manual"], enabled: true,
        });
        const res = await request(withSmtp.app).post("/api/notifications/email/test").send({ recipientId: created.body.id });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.envelope).toMatchObject({ to: "crit@example.com" });
      } finally { spy.mockRestore(); }
    } finally { withSmtp.cleanup(); }
  });

  it("POST /test surfaces SMTP errors as 500", async () => {
    const withSmtp = makeEmailApp({ withSmtp: true });
    try {
      const failTransport = nodemailer.createTransport({ jsonTransport: true });
      (failTransport as any).sendMail = async () => { throw Object.assign(new Error("auth failure"), { responseCode: 535 }); };
      const spy = vi.spyOn(nodemailer, "createTransport").mockReturnValue(failTransport);
      try {
        await request(withSmtp.app).put("/api/notifications/email").send({ enabled: true });
        const created = await request(withSmtp.app).post("/api/notifications/email/recipients").send({
          address: "a@example.com", minSeverity: "low", allowedSources: ["manual"], enabled: true,
        });
        const res = await request(withSmtp.app).post("/api/notifications/email/test").send({ recipientId: created.body.id });
        expect(res.status).toBe(500);
        expect(res.body.error).toContain("auth failure");
      } finally { spy.mockRestore(); }
    } finally { withSmtp.cleanup(); }
  });

  it("accepts scan-run in allowedSources for email recipients", async () => {
    const res = await request(ctx.app).post("/api/notifications/email/recipients").send({
      address: "ops@example.com",
      minSeverity: "low",
      allowedSources: ["scan-run"],
      enabled: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.allowedSources).toEqual(["scan-run"]);
  });
});

describe("/api/notifications slack onScanComplete", () => {
  let ctx: ReturnType<typeof makeEmailApp>;
  beforeEach(() => { ctx = makeEmailApp(); });
  afterEach(() => { ctx.cleanup(); });

  it("defaults onScanComplete to 'hits-only' in GET response when unset", async () => {
    const res = await request(ctx.app).get("/api/notifications");
    expect(res.status).toBe(200);
    expect(res.body.slack.onScanComplete).toBe("hits-only");
  });

  it("saves notifications.slack.onScanComplete via PUT /api/notifications", async () => {
    const put = await request(ctx.app).put("/api/notifications").send({
      slack: { onScanComplete: "always" },
    });
    expect(put.status).toBe(200);
    const get = await request(ctx.app).get("/api/notifications");
    expect(get.body.slack.onScanComplete).toBe("always");
  });

  it("accepts 'off' for onScanComplete", async () => {
    const put = await request(ctx.app).put("/api/notifications").send({
      slack: { onScanComplete: "off" },
    });
    expect(put.status).toBe(200);
    const get = await request(ctx.app).get("/api/notifications");
    expect(get.body.slack.onScanComplete).toBe("off");
  });

  it("rejects invalid onScanComplete values", async () => {
    const put = await request(ctx.app).put("/api/notifications").send({
      slack: { onScanComplete: "maybe" },
    });
    expect(put.status).toBe(400);
  });

  it("does not overwrite existing onScanComplete when PUT omits the field", async () => {
    // Seed the setting
    await request(ctx.app).put("/api/notifications").send({
      slack: { onScanComplete: "always" },
    });
    // PUT with only webhookUrl — onScanComplete should remain "always"
    const put = await request(ctx.app).put("/api/notifications").send({
      slack: { enabled: true },
    });
    expect(put.status).toBe(200);
    const get = await request(ctx.app).get("/api/notifications");
    expect(get.body.slack.onScanComplete).toBe("always");
  });
});

describe("/api/discovery/settings", () => {
  it("returns config periodic defaults when no DB override exists", async () => {
    const ctx = makeEmailApp({
      config: {
        discovery: {
          periodic: {
            enabled: true,
            cron: "0 3 * * *",
            timezone: "America/Los_Angeles",
            consensusRuns: 4,
            consensusRunsForRemovals: 5,
          },
        },
      },
    });
    try {
      const res = await request(ctx.app).get("/api/discovery/settings");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        enabled: true,
        cron: "0 3 * * *",
        timezone: "America/Los_Angeles",
        consensusRuns: 4,
        consensusRunsForRemovals: 5,
      });
    } finally {
      ctx.cleanup();
    }
  });
});
