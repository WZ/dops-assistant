import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "./db.js";

const S = "stack-a";

interface SeedPattern {
  id: string;
  service: string;
  symptom?: string;
  rootCause?: string;
  severity?: "low" | "medium" | "high" | "critical";
  recommendedActions?: string;
  sourceInvestigationId?: string;
}

/**
 * Monotonically increasing fake clock — ensures back-to-back seeds get
 * distinct created_at timestamps. SQLite's `datetime('now')` only has
 * second resolution, so without this every seed in the same test second
 * collapses to one timestamp and ORDER BY created_at becomes undefined.
 */
let CLOCK = Date.parse("2026-04-25T00:00:00Z");
function nextTs(): string {
  CLOCK += 1000;
  return new Date(CLOCK).toISOString();
}

function seed(db: Database, p: SeedPattern) {
  // If a sourceInvestigationId was supplied, materialize a matching investigation
  // first so the FK constraint passes. Default leaves it null (allowed by schema).
  if (p.sourceInvestigationId) {
    db.createInvestigation(S, {
      id: p.sourceInvestigationId,
      service: p.service,
      query: "test",
      status: "complete",
    });
  }
  db.createPattern(S, {
    id: p.id,
    service: p.service,
    symptom: p.symptom ?? "Symptom",
    rootCause: p.rootCause ?? "Root cause",
    severity: p.severity ?? "medium",
    recommendedActions: p.recommendedActions ?? "Action 1; Action 2",
    ...(p.sourceInvestigationId ? { sourceInvestigationId: p.sourceInvestigationId } : {}),
  });
  // Bump created_at via raw SQL — createPattern uses default datetime('now'),
  // and second-resolution timestamps collapse in tests.
  (db as any).db.prepare("UPDATE incident_patterns SET created_at = ? WHERE id = ?")
    .run(nextTs(), p.id);
}

describe("Database.listPatterns + countPatterns", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    CLOCK = Date.parse("2026-04-25T00:00:00Z");
  });
  afterEach(() => db.close());

  it("returns rows newest-first by default with no filters", () => {
    seed(db, { id: "pat_1", service: "payments-api" });
    seed(db, { id: "pat_2", service: "checkout-api" });
    seed(db, { id: "pat_3", service: "payments-api", severity: "critical" });

    const rows = db.listPatterns({ stackId: S });
    expect(rows.map((r) => r.id)).toEqual(["pat_3", "pat_2", "pat_1"]);
    expect(db.countPatterns({ stackId: S })).toBe(3);
  });

  it("filters by service (single-select)", () => {
    seed(db, { id: "p1", service: "payments-api" });
    seed(db, { id: "p2", service: "checkout-api" });
    seed(db, { id: "p3", service: "payments-api" });

    const rows = db.listPatterns({ stackId: S, service: "payments-api" });
    expect(rows.map((r) => r.id).sort()).toEqual(["p1", "p3"]);
    expect(db.countPatterns({ stackId: S, service: "payments-api" })).toBe(2);
  });

  it("filters by severity (multi-select)", () => {
    seed(db, { id: "p1", service: "a", severity: "low" });
    seed(db, { id: "p2", service: "a", severity: "high" });
    seed(db, { id: "p3", service: "a", severity: "critical" });

    const rows = db.listPatterns({ stackId: S, severity: ["high", "critical"] });
    expect(rows.map((r) => r.id).sort()).toEqual(["p2", "p3"]);
  });

  it("q searches across symptom, root_cause, and recommended_actions (case-insensitive)", () => {
    seed(db, { id: "p1", service: "a", symptom: "5xx error rate spiked" });
    seed(db, { id: "p2", service: "a", rootCause: "OOMKilled in upstream worker" });
    seed(db, { id: "p3", service: "a", recommendedActions: "Add circuit breaker" });
    seed(db, { id: "p4", service: "a", symptom: "latency normal" });

    expect(db.listPatterns({ stackId: S, q: "oomkilled" }).map((r) => r.id)).toEqual(["p2"]);
    expect(db.listPatterns({ stackId: S, q: "circuit" }).map((r) => r.id)).toEqual(["p3"]);
    expect(db.listPatterns({ stackId: S, q: "5xx" }).map((r) => r.id)).toEqual(["p1"]);
  });

  it("q escapes %% and _ so they don't act as wildcards", () => {
    seed(db, { id: "p1", service: "a", symptom: "100% error rate" });
    seed(db, { id: "p2", service: "a", symptom: "high latency" });

    // Without escape, "100%" would match both rows. With escape, only p1.
    const rows = db.listPatterns({ stackId: S, q: "100%" });
    expect(rows.map((r) => r.id)).toEqual(["p1"]);
  });

  it("filters by since/until window", () => {
    seed(db, { id: "p1", service: "a" });
    seed(db, { id: "p2", service: "a" });
    seed(db, { id: "p3", service: "a" });
    // Override the helper-stamped timestamps so the window math is precise.
    const t = new Date("2026-04-25T12:00:00Z").getTime();
    (db as any).db.prepare("UPDATE incident_patterns SET created_at = ? WHERE id = ?")
      .run(new Date(t - 60_000).toISOString(), "p1");
    (db as any).db.prepare("UPDATE incident_patterns SET created_at = ? WHERE id = ?")
      .run(new Date(t).toISOString(), "p2");
    (db as any).db.prepare("UPDATE incident_patterns SET created_at = ? WHERE id = ?")
      .run(new Date(t + 60_000).toISOString(), "p3");

    const rows = db.listPatterns({
      stackId: S,
      since: t - 30_000,
      until: t + 30_000,
    });
    expect(rows.map((r) => r.id)).toEqual(["p2"]);
  });

  it("sort=severity orders critical→low with newest-first tie-break", () => {
    seed(db, { id: "p1", service: "a", severity: "low" });
    seed(db, { id: "p2", service: "a", severity: "critical" });
    seed(db, { id: "p3", service: "a", severity: "high" });
    seed(db, { id: "p4", service: "a", severity: "medium" });
    seed(db, { id: "p5", service: "a", severity: "critical" });

    const rows = db.listPatterns({ stackId: S, sort: "severity" });
    // p5 (critical, newer) before p2 (critical) before p3 (high) before p4 (medium) before p1 (low)
    expect(rows.map((r) => r.id)).toEqual(["p5", "p2", "p3", "p4", "p1"]);
  });

  it("paginates with limit + offset", () => {
    for (let i = 0; i < 7; i++) seed(db, { id: `p${i}`, service: "a" });

    const page1 = db.listPatterns({ stackId: S, limit: 3, offset: 0 });
    const page2 = db.listPatterns({ stackId: S, limit: 3, offset: 3 });
    const page3 = db.listPatterns({ stackId: S, limit: 3, offset: 6 });

    expect(page1).toHaveLength(3);
    expect(page2).toHaveLength(3);
    expect(page3).toHaveLength(1);
    const all = [...page1, ...page2, ...page3].map((r) => r.id);
    expect(new Set(all).size).toBe(7);
  });

  it("scopes to stackId", () => {
    seed(db, { id: "p1", service: "a" });
    db.createPattern("stack-b", {
      id: "p2",
      service: "a",
      symptom: "x",
      rootCause: "y",
      severity: "medium",
      recommendedActions: "",
    });
    expect(db.listPatterns({ stackId: S }).map((r) => r.id)).toEqual(["p1"]);
    expect(db.countPatterns({ stackId: S })).toBe(1);
  });

  it("listPatternServices returns distinct service names alphabetically", () => {
    seed(db, { id: "p1", service: "zeta" });
    seed(db, { id: "p2", service: "alpha" });
    seed(db, { id: "p3", service: "alpha" });
    seed(db, { id: "p4", service: "mu" });

    expect(db.listPatternServices(S)).toEqual(["alpha", "mu", "zeta"]);
  });

  it("returns rows including source_investigation_id", () => {
    seed(db, { id: "p1", service: "a", sourceInvestigationId: "inv_xyz" });
    const [row] = db.listPatterns({ stackId: S });
    expect(row?.source_investigation_id).toBe("inv_xyz");
  });

  it("getPattern returns one pattern scoped to stack", () => {
    seed(db, { id: "p1", service: "payments-api" });
    db.createPattern("stack-b", {
      id: "p2",
      service: "payments-api",
      symptom: "Other",
      rootCause: "Other",
      severity: "high",
    });

    expect(db.getPattern(S, "p1")?.service).toBe("payments-api");
    expect(db.getPattern(S, "p2")).toBeUndefined();
  });

  it("listPatternsForService returns all same-service candidates newest-first and stack-scoped", () => {
    seed(db, { id: "p1", service: "payments-api" });
    seed(db, { id: "p2", service: "checkout-api" });
    seed(db, { id: "p3", service: "payments-api" });
    db.createPattern("stack-b", {
      id: "p4",
      service: "payments-api",
      symptom: "Other",
      rootCause: "Other",
      severity: "high",
    });

    expect(db.listPatternsForService(S, "payments-api").map((r) => r.id)).toEqual(["p3", "p1"]);
  });

  it("getInvestigationSummary returns source investigation metadata scoped to stack", () => {
    db.createInvestigation(S, {
      id: "inv_1",
      service: "payments-api",
      query: "why 5xx?",
      status: "complete",
    });
    db.updateInvestigation("inv_1", { completed_at: "2026-04-25T12:00:00.000Z" });
    db.createInvestigation("stack-b", {
      id: "inv_2",
      service: "payments-api",
      query: "other stack",
      status: "complete",
    });

    expect(db.getInvestigationSummary(S, "inv_1")).toMatchObject({
      id: "inv_1",
      status: "complete",
      query: "why 5xx?",
      completed_at: "2026-04-25T12:00:00.000Z",
    });
    expect(db.getInvestigationSummary(S, "inv_2")).toBeUndefined();
  });
});
