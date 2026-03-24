import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "./db.js";

describe("Database", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  describe("investigations", () => {
    it("creates and retrieves an investigation", () => {
      db.createInvestigation({ id: "inv_1", service: "payments-api", query: "check errors", status: "running" });
      const inv = db.getInvestigation("inv_1");
      expect(inv).toBeDefined();
      expect(inv!.service).toBe("payments-api");
      expect(inv!.status).toBe("running");
    });

    it("updates investigation status and report", () => {
      db.createInvestigation({ id: "inv_1", service: "payments-api", query: "check errors", status: "running" });
      db.updateInvestigation("inv_1", { status: "complete", report: JSON.stringify({ rootCause: "OOM" }) });
      const inv = db.getInvestigation("inv_1");
      expect(inv!.status).toBe("complete");
      expect(JSON.parse(inv!.report!).rootCause).toBe("OOM");
    });

    it("lists investigations ordered by created_at desc", () => {
      db.createInvestigation({ id: "inv_1", service: "svc-a", query: "q1", status: "complete" });
      db.createInvestigation({ id: "inv_2", service: "svc-b", query: "q2", status: "running" });
      const list = db.listInvestigations(10, 0);
      expect(list).toHaveLength(2);
      expect(list[0]!.id).toBe("inv_2");
    });

    it("paginates with limit and offset", () => {
      for (let i = 0; i < 5; i++) {
        db.createInvestigation({ id: `inv_${i}`, service: "svc", query: "q", status: "complete" });
      }
      const page = db.listInvestigations(2, 2);
      expect(page).toHaveLength(2);
    });
  });

  describe("investigation phases", () => {
    it("creates and retrieves phases for an investigation", () => {
      db.createInvestigation({ id: "inv_1", service: "svc", query: "q", status: "running" });
      db.createPhase({ id: "ph_1", investigationId: "inv_1", phase: "metrics", status: "running" });
      db.updatePhase("ph_1", { status: "complete", findings: JSON.stringify({ observations: [] }) });
      const phases = db.getPhases("inv_1");
      expect(phases).toHaveLength(1);
      expect(phases[0]!.status).toBe("complete");
    });
  });

  describe("messages", () => {
    it("creates and retrieves messages", () => {
      db.createMessage({ id: "msg_1", role: "user", content: "hello" });
      db.createMessage({ id: "msg_2", role: "assistant", content: "hi there", investigationId: "inv_1" });
      const msgs = db.listMessages(50);
      expect(msgs).toHaveLength(2);
    });

    it("lists messages ordered by created_at asc", () => {
      db.createMessage({ id: "msg_1", role: "user", content: "first" });
      db.createMessage({ id: "msg_2", role: "assistant", content: "second" });
      const msgs = db.listMessages(50);
      expect(msgs[0]!.content).toBe("first");
    });
  });

  // ── Hidden services ──────────────────────────────────────────────────────

  describe("hidden services", () => {
    it("hideService inserts with reason", () => {
      db.hideService("kafka", "decommissioned");
      const details = db.getHiddenServiceDetails();
      expect(details).toHaveLength(1);
      expect(details[0]!.service).toBe("kafka");
      expect(details[0]!.reason).toBe("decommissioned");
      expect(details[0]!.hidden_at).toBeTruthy();
    });

    it("hideService is idempotent (INSERT OR REPLACE)", () => {
      db.hideService("kafka", "reason-1");
      db.hideService("kafka", "reason-2");
      const details = db.getHiddenServiceDetails();
      expect(details).toHaveLength(1);
      expect(details[0]!.reason).toBe("reason-2");
    });

    it("hideService works without reason", () => {
      db.hideService("kafka");
      const details = db.getHiddenServiceDetails();
      expect(details[0]!.reason).toBeNull();
    });

    it("unhideService removes existing", () => {
      db.hideService("kafka");
      db.unhideService("kafka");
      expect(db.getHiddenServices().size).toBe(0);
    });

    it("unhideService is no-op on non-hidden service", () => {
      db.unhideService("nonexistent");
      expect(db.getHiddenServices().size).toBe(0);
    });

    it("getHiddenServices returns Set with entries", () => {
      db.hideService("kafka");
      db.hideService("redis");
      const hidden = db.getHiddenServices();
      expect(hidden).toBeInstanceOf(Set);
      expect(hidden.size).toBe(2);
      expect(hidden.has("kafka")).toBe(true);
      expect(hidden.has("redis")).toBe(true);
    });

    it("getHiddenServices returns empty Set when none hidden", () => {
      const hidden = db.getHiddenServices();
      expect(hidden).toBeInstanceOf(Set);
      expect(hidden.size).toBe(0);
    });

    it("getHiddenServiceDetails returns full rows", () => {
      db.hideService("kafka", "old cluster");
      db.hideService("redis");
      const details = db.getHiddenServiceDetails();
      expect(details).toHaveLength(2);
      expect(details.every(d => d.hidden_at)).toBe(true);
    });

    it("hideServices batch inserts multiple", () => {
      db.hideServices(["kafka", "redis", "postgres"], "cleanup");
      const hidden = db.getHiddenServices();
      expect(hidden.size).toBe(3);
      const details = db.getHiddenServiceDetails();
      expect(details.every(d => d.reason === "cleanup")).toBe(true);
    });

    it("hideServices with empty array is no-op", () => {
      db.hideServices([]);
      expect(db.getHiddenServices().size).toBe(0);
    });

    it("isServiceHidden returns correct boolean", () => {
      db.hideService("kafka");
      expect(db.isServiceHidden("kafka")).toBe(true);
      expect(db.isServiceHidden("redis")).toBe(false);
    });

    it("getStaleUnknownServices returns services with only unknown checks", () => {
      // Insert health checks: kafka has only unknown, redis has a healthy check
      db.insertServiceHealthCheck("kafka", "unknown", new Date().toISOString());
      db.insertServiceHealthCheck("redis", "healthy", new Date().toISOString());
      const stale = db.getStaleUnknownServices(7);
      expect(stale).toContain("kafka");
      expect(stale).not.toContain("redis");
    });

    it("getStaleUnknownServices excludes already-hidden services", () => {
      db.insertServiceHealthCheck("kafka", "unknown", new Date().toISOString());
      db.hideService("kafka");
      const stale = db.getStaleUnknownServices(7);
      expect(stale).not.toContain("kafka");
    });
  });

  // ── Confidence score extraction ────────────────────────────────────────

  describe("confidence_score extraction", () => {
    it("extracts confidenceScore from valid report JSON via listInvestigations", () => {
      db.createInvestigation({ id: "inv_1", service: "svc", query: "q", status: "complete" });
      db.updateInvestigation("inv_1", { status: "complete", report: JSON.stringify({ confidenceScore: 0.85 }) });
      const list = db.listInvestigations(10, 0);
      expect(list[0]!.confidence_score).toBe(0.85);
    });

    it("extracts confidenceScore from valid report JSON via getInvestigation", () => {
      db.createInvestigation({ id: "inv_1", service: "svc", query: "q", status: "complete" });
      db.updateInvestigation("inv_1", { status: "complete", report: JSON.stringify({ confidenceScore: 0.7 }) });
      const inv = db.getInvestigation("inv_1");
      expect(inv!.confidence_score).toBe(0.7);
    });

    it("returns null when report JSON lacks confidenceScore field", () => {
      db.createInvestigation({ id: "inv_1", service: "svc", query: "q", status: "complete" });
      db.updateInvestigation("inv_1", { status: "complete", report: JSON.stringify({ rootCause: "OOM" }) });
      const inv = db.getInvestigation("inv_1");
      expect(inv!.confidence_score).toBeNull();
    });

    it("returns null when report is NULL", () => {
      db.createInvestigation({ id: "inv_1", service: "svc", query: "q", status: "running" });
      const inv = db.getInvestigation("inv_1");
      expect(inv!.confidence_score).toBeNull();
    });

    it("returns null for malformed non-JSON report (json_valid guard)", () => {
      db.createInvestigation({ id: "inv_1", service: "svc", query: "q", status: "complete" });
      db.updateInvestigation("inv_1", { status: "complete", report: "not valid json" });
      const inv = db.getInvestigation("inv_1");
      expect(inv!.confidence_score).toBeNull();
    });
  });

  // ── KPI Stats ─────────────────────────────────────────────────────────

  describe("getKpiStats", () => {
    it("returns zeros for empty database", () => {
      const stats = db.getKpiStats();
      expect(stats.investigations).toEqual({ total: 0, active: 0, complete: 0, failed: 0 });
      expect(stats.successRate).toBeNull();
      expect(stats.confidence).toEqual({ avg: null, scored: 0, lowConfidence: 0 });
      expect(stats.mttr.avg7d).toBe(0);
      expect(stats.mttr.completed7d).toBe(0);
      expect(stats.mttr.trend).toBeUndefined();
    });

    it("counts investigation statuses correctly", () => {
      db.createInvestigation({ id: "inv_1", service: "svc-a", query: "q", status: "complete" });
      db.createInvestigation({ id: "inv_2", service: "svc-b", query: "q", status: "running" });
      db.createInvestigation({ id: "inv_3", service: "svc-c", query: "q", status: "failed" });
      db.createInvestigation({ id: "inv_4", service: "svc-d", query: "q", status: "complete" });
      const stats = db.getKpiStats();
      expect(stats.investigations).toEqual({ total: 4, active: 1, complete: 2, failed: 1 });
    });

    it("computes success rate excluding stale-cleanup failures", () => {
      // 2 complete, 1 real failed (has report), 1 stale-cleanup failed (no report)
      db.createInvestigation({ id: "inv_1", service: "svc", query: "q", status: "complete" });
      db.updateInvestigation("inv_1", { report: '{"ok":true}' });
      db.createInvestigation({ id: "inv_2", service: "svc", query: "q", status: "complete" });
      db.updateInvestigation("inv_2", { report: '{"ok":true}' });
      db.createInvestigation({ id: "inv_3", service: "svc", query: "q", status: "failed" });
      db.updateInvestigation("inv_3", { report: '{"error":"timeout"}' });
      db.createInvestigation({ id: "inv_4", service: "svc", query: "q", status: "failed" });
      // inv_4 has no report — stale-cleanup, excluded from success rate
      const stats = db.getKpiStats();
      // successRate = 2 / (2 + 1) * 100 = 66.67
      expect(stats.successRate).toBeCloseTo(66.67, 1);
    });

    it("returns null success rate when no complete or real-failed investigations", () => {
      db.createInvestigation({ id: "inv_1", service: "svc", query: "q", status: "running" });
      const stats = db.getKpiStats();
      expect(stats.successRate).toBeNull();
    });

    it("computes average confidence from completed investigations", () => {
      db.createInvestigation({ id: "inv_1", service: "svc", query: "q", status: "complete" });
      db.updateInvestigation("inv_1", { report: JSON.stringify({ confidenceScore: 0.8 }) });
      db.createInvestigation({ id: "inv_2", service: "svc", query: "q", status: "complete" });
      db.updateInvestigation("inv_2", { report: JSON.stringify({ confidenceScore: 0.6 }) });
      const stats = db.getKpiStats();
      expect(stats.confidence.avg).toBeCloseTo(0.7, 5);
      expect(stats.confidence.scored).toBe(2);
      expect(stats.confidence.lowConfidence).toBe(0);
    });

    it("counts low confidence investigations (below 0.5)", () => {
      db.createInvestigation({ id: "inv_1", service: "svc", query: "q", status: "complete" });
      db.updateInvestigation("inv_1", { report: JSON.stringify({ confidenceScore: 0.3 }) });
      db.createInvestigation({ id: "inv_2", service: "svc", query: "q", status: "complete" });
      db.updateInvestigation("inv_2", { report: JSON.stringify({ confidenceScore: 0.8 }) });
      const stats = db.getKpiStats();
      expect(stats.confidence.lowConfidence).toBe(1);
    });

    it("excludes null confidence from average", () => {
      db.createInvestigation({ id: "inv_1", service: "svc", query: "q", status: "complete" });
      db.updateInvestigation("inv_1", { report: JSON.stringify({ confidenceScore: 0.9 }) });
      db.createInvestigation({ id: "inv_2", service: "svc", query: "q", status: "complete" });
      db.updateInvestigation("inv_2", { report: JSON.stringify({ rootCause: "OOM" }) }); // no confidenceScore
      const stats = db.getKpiStats();
      // Only inv_1 has confidence, so avg = 0.9
      expect(stats.confidence.avg).toBeCloseTo(0.9, 5);
      expect(stats.confidence.scored).toBe(1);
    });

    it("handles malformed report JSON gracefully in confidence", () => {
      db.createInvestigation({ id: "inv_1", service: "svc", query: "q", status: "complete" });
      db.updateInvestigation("inv_1", { report: "not json" });
      const stats = db.getKpiStats();
      expect(stats.confidence.avg).toBeNull();
      expect(stats.confidence.scored).toBe(0);
    });

    it("computes MTTR for last 7 days", () => {
      db.createInvestigation({ id: "inv_1", service: "svc", query: "q", status: "running" });
      db.updateInvestigation("inv_1", { status: "complete", total_duration_ms: 60_000 });
      db.createInvestigation({ id: "inv_2", service: "svc", query: "q", status: "running" });
      db.updateInvestigation("inv_2", { status: "complete", total_duration_ms: 120_000 });
      const stats = db.getKpiStats();
      expect(stats.mttr.avg7d).toBe(90_000);
      expect(stats.mttr.completed7d).toBe(2);
    });
  });

  // ── Service metadata ──────────────────────────────────────────────────

  describe("service metadata", () => {
    it("upsertServiceMetadata creates and getServiceMetadata retrieves", () => {
      db.upsertServiceMetadata("payments-api", { alias: "Payments", tags: ["critical", "backend"] });
      const meta = db.getServiceMetadata("payments-api");
      expect(meta).toBeDefined();
      expect(meta!.service).toBe("payments-api");
      expect(meta!.alias).toBe("Payments");
      expect(meta!.tags).toEqual(["critical", "backend"]);
      expect(meta!.updated_at).toBeTruthy();
    });

    it("returns null for unknown service", () => {
      const meta = db.getServiceMetadata("nonexistent");
      expect(meta).toBeNull();
    });

    it("updates alias without clearing tags", () => {
      db.upsertServiceMetadata("payments-api", { alias: "Payments", tags: ["critical"] });
      db.upsertServiceMetadata("payments-api", { alias: "Payments V2" });
      const meta = db.getServiceMetadata("payments-api");
      expect(meta!.alias).toBe("Payments V2");
      expect(meta!.tags).toEqual(["critical"]);
    });

    it("updates tags without clearing alias", () => {
      db.upsertServiceMetadata("payments-api", { alias: "Payments", tags: ["critical"] });
      db.upsertServiceMetadata("payments-api", { tags: ["critical", "tier-1"] });
      const meta = db.getServiceMetadata("payments-api");
      expect(meta!.alias).toBe("Payments");
      expect(meta!.tags).toEqual(["critical", "tier-1"]);
    });

    it("getAllServiceMetadata returns all entries", () => {
      db.upsertServiceMetadata("svc-a", { alias: "Service A" });
      db.upsertServiceMetadata("svc-b", { tags: ["backend"] });
      const all = db.getAllServiceMetadata();
      expect(all).toHaveLength(2);
      const names = all.map(m => m.service);
      expect(names).toContain("svc-a");
      expect(names).toContain("svc-b");
    });

    it("getAllServiceMetadata returns empty array when no metadata exists", () => {
      const all = db.getAllServiceMetadata();
      expect(all).toEqual([]);
    });

    it("upsertServiceMetadata with empty update on new service creates with nulls", () => {
      db.upsertServiceMetadata("svc-new", {});
      const meta = db.getServiceMetadata("svc-new");
      expect(meta).toBeDefined();
      expect(meta!.alias).toBeNull();
      expect(meta!.tags).toEqual([]);
    });
  });

  // ── listInvestigations with service filter ────────────────────────────

  describe("listInvestigations with service filter", () => {
    beforeEach(() => {
      db.createInvestigation({ id: "inv_1", service: "payments-api", query: "high latency", status: "complete" });
      db.createInvestigation({ id: "inv_2", service: "auth-service", query: "login failures", status: "complete" });
      db.createInvestigation({ id: "inv_3", service: "payments-api", query: "error spike", status: "running" });
      db.createInvestigation({ id: "inv_4", service: "redis", query: "memory", status: "complete" });
    });

    it("filters by service when param provided", () => {
      const list = db.listInvestigations(10, 0, "payments-api");
      expect(list).toHaveLength(2);
      expect(list.every(inv => inv.service === "payments-api")).toBe(true);
    });

    it("returns all when no service filter", () => {
      const list = db.listInvestigations(10, 0);
      expect(list).toHaveLength(4);
    });

    it("returns empty array when service has no investigations", () => {
      const list = db.listInvestigations(10, 0, "nonexistent-service");
      expect(list).toEqual([]);
    });

    it("respects limit and offset with service filter", () => {
      // Add more investigations for payments-api
      db.createInvestigation({ id: "inv_5", service: "payments-api", query: "q5", status: "complete" });
      const page = db.listInvestigations(1, 1, "payments-api");
      expect(page).toHaveLength(1);
      expect(page[0]!.service).toBe("payments-api");
    });
  });
});
