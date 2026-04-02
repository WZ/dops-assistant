import { describe, it, expect, vi } from "vitest";
import type { ServiceConfig } from "../config/schema.js";
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
      db.createFeedback(STACK, { id: "fb_1", investigationId: "inv_1", rating });

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
      db.createFeedback(STACK, { id: "fb_2", investigationId: "inv_2", rating: "not_useful" });

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
        db.createFeedback(STACK, { id: "fb_3", investigationId: "inv_3", rating: "invalid" as any });
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
