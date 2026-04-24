import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database, severityOf } from "./db.js";

const S = "test-stack"; // default stackId for all tests

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
      db.createInvestigation(S, { id: "inv_1", service: "payments-api", query: "check errors", status: "running" });
      const inv = db.getInvestigation(S, "inv_1");
      expect(inv).toBeDefined();
      expect(inv!.service).toBe("payments-api");
      expect(inv!.status).toBe("running");
    });

    it("updates investigation status and report", () => {
      db.createInvestigation(S, { id: "inv_1", service: "payments-api", query: "check errors", status: "running" });
      db.updateInvestigation("inv_1", { status: "complete", report: JSON.stringify({ rootCause: "OOM" }) });
      const inv = db.getInvestigation(S, "inv_1");
      expect(inv!.status).toBe("complete");
      expect(JSON.parse(inv!.report!).rootCause).toBe("OOM");
    });

    it("lists investigations ordered by created_at desc", () => {
      db.createInvestigation(S, { id: "inv_1", service: "svc-a", query: "q1", status: "complete" });
      db.createInvestigation(S, { id: "inv_2", service: "svc-b", query: "q2", status: "running" });
      const list = db.listInvestigations(S, { limit: 10 });
      expect(list).toHaveLength(2);
      expect(list[0]!.id).toBe("inv_2");
    });

    it("paginates with limit and offset", () => {
      for (let i = 0; i < 5; i++) {
        db.createInvestigation(S, { id: `inv_${i}`, service: "svc", query: "q", status: "complete" });
      }
      const page = db.listInvestigations(S, { limit: 2, offset: 2 });
      expect(page).toHaveLength(2);
    });
  });

  describe("scan override (get/set/clear/getAll)", () => {
    it("returns null when no override is set", () => {
      expect(db.getScanOverride(S, "svc")).toBeNull();
    });

    it("round-trips a set value", () => {
      db.setScanOverride(S, "svc", '{"disabled":true}');
      expect(db.getScanOverride(S, "svc")).toBe('{"disabled":true}');
    });

    it("set creates a service_metadata row even if none existed", () => {
      // Previously there was no metadata row for "new-svc" at all. setScanOverride
      // must upsert rather than silently failing.
      db.setScanOverride(S, "new-svc", '{"disabled":true}');
      expect(db.getScanOverride(S, "new-svc")).toBe('{"disabled":true}');
    });

    it("clear reverts the service to null (global rules)", () => {
      db.setScanOverride(S, "svc", '{"disabled":true}');
      db.clearScanOverride(S, "svc");
      expect(db.getScanOverride(S, "svc")).toBeNull();
    });

    it("clear preserves other metadata fields (alias, tags)", () => {
      db.upsertServiceMetadata(S, "svc", { alias: "payments", tags: ["critical"] });
      db.setScanOverride(S, "svc", '{"disabled":true}');
      db.clearScanOverride(S, "svc");
      const meta = db.getServiceMetadata(S, "svc");
      expect(meta?.alias).toBe("payments");
      expect(meta?.tags).toEqual(["critical"]);
    });

    it("scopes by stack_id", () => {
      db.setScanOverride("stack-a", "svc", '{"disabled":true}');
      expect(db.getScanOverride("stack-b", "svc")).toBeNull();
      expect(db.getScanOverride("stack-a", "svc")).toBe('{"disabled":true}');
    });

    it("getAllScanOverrides returns only services with non-null overrides", () => {
      db.setScanOverride(S, "a", '{"disabled":true}');
      db.setScanOverride(S, "b", '{"rules":[]}');
      db.upsertServiceMetadata(S, "c", { alias: "no-override-here" });
      const all = db.getAllScanOverrides(S);
      expect(Object.keys(all).sort()).toEqual(["a", "b"]);
      expect(all.a).toBe('{"disabled":true}');
      expect(all.b).toBe('{"rules":[]}');
    });
  });

  describe("countScanTriggeredInvestigationsSince", () => {
    it("returns 0 when no investigations exist", () => {
      const since = new Date(Date.now() - 24 * 3600_000).toISOString();
      expect(db.countScanTriggeredInvestigationsSince(S, since)).toBe(0);
    });

    it("counts only rows whose query starts with the scan prefix", () => {
      db.createInvestigation(S, { id: "scan_1", service: "svc-a", query: "Proactive scan detected anomaly on svc-a. Rule: availability", status: "complete" });
      db.createInvestigation(S, { id: "scan_2", service: "svc-b", query: "Proactive scan detected anomaly on svc-b", status: "complete" });
      db.createInvestigation(S, { id: "alert_1", service: "svc-c", query: "Alert: HighErrorRate", status: "complete" });
      db.createInvestigation(S, { id: "user_1", service: "svc-d", query: "why is svc-d slow", status: "complete" });
      const since = new Date(Date.now() - 3600_000).toISOString();
      expect(db.countScanTriggeredInvestigationsSince(S, since)).toBe(2);
    });

    it("excludes in-progress and failed investigations", () => {
      db.createInvestigation(S, { id: "scan_1", service: "svc-a", query: "Proactive scan detected anomaly on svc-a", status: "complete" });
      db.createInvestigation(S, { id: "scan_2", service: "svc-b", query: "Proactive scan detected anomaly on svc-b", status: "running" });
      db.createInvestigation(S, { id: "scan_3", service: "svc-c", query: "Proactive scan detected anomaly on svc-c", status: "failed" });
      const since = new Date(Date.now() - 3600_000).toISOString();
      expect(db.countScanTriggeredInvestigationsSince(S, since)).toBe(1);
    });

    it("respects the since cutoff", () => {
      const rawDb = (db as unknown as { db: { prepare: (s: string) => { run: (...args: unknown[]) => void } } }).db;
      rawDb.prepare(
        "INSERT INTO investigations (id, stack_id, service, query, status, created_at) VALUES (?, ?, ?, ?, ?, datetime('now', '-48 hours'))"
      ).run("scan_old", S, "svc", "Proactive scan detected anomaly on svc", "complete");
      db.createInvestigation(S, { id: "scan_new", service: "svc", query: "Proactive scan detected anomaly on svc", status: "complete" });

      const since24h = new Date(Date.now() - 24 * 3600_000).toISOString();
      expect(db.countScanTriggeredInvestigationsSince(S, since24h)).toBe(1); // only "scan_new"

      const since72h = new Date(Date.now() - 72 * 3600_000).toISOString();
      expect(db.countScanTriggeredInvestigationsSince(S, since72h)).toBe(2);
    });

    it("scopes by stack_id", () => {
      db.createInvestigation("stack-a", { id: "scan_1", service: "svc", query: "Proactive scan detected anomaly on svc", status: "complete" });
      const since = new Date(Date.now() - 3600_000).toISOString();
      expect(db.countScanTriggeredInvestigationsSince("stack-b", since)).toBe(0);
      expect(db.countScanTriggeredInvestigationsSince("stack-a", since)).toBe(1);
    });

    it("does not match mid-sentence 'Proactive scan' (prefix match only)", () => {
      // Regression: an operator chat ending up with "proactive scan" inside
      // the query must not be counted as scan-triggered.
      db.createInvestigation(S, { id: "user_1", service: "svc", query: "why did the proactive scan fire?", status: "complete" });
      const since = new Date(Date.now() - 3600_000).toISOString();
      expect(db.countScanTriggeredInvestigationsSince(S, since)).toBe(0);
    });
  });

  describe("getLastInvestigationAt", () => {
    it("returns null when no investigation exists", () => {
      expect(db.getLastInvestigationAt(S, "nonexistent")).toBeNull();
    });

    it("returns epoch ms of the only investigation", () => {
      db.createInvestigation(S, { id: "inv_1", service: "payments", query: "q", status: "complete" });
      const ms = db.getLastInvestigationAt(S, "payments");
      expect(ms).not.toBeNull();
      expect(typeof ms).toBe("number");
      // Should be within a few seconds of now (SQLite datetime('now') is UTC seconds)
      const now = Date.now();
      expect(ms!).toBeGreaterThan(now - 10_000);
      expect(ms!).toBeLessThanOrEqual(now + 1_000);
    });

    it("returns the MOST RECENT completed investigation when multiple exist", () => {
      db.createInvestigation(S, { id: "inv_1", service: "svc", query: "q", status: "complete" });
      // Simulate a later investigation by manipulating created_at via raw SQL
      // (SQLite datetime resolution is 1s, so two sequential inserts can collide)
      const rawDb = (db as unknown as { db: { prepare: (s: string) => { run: (...args: unknown[]) => void } } }).db;
      rawDb.prepare(
        "INSERT INTO investigations (id, stack_id, service, query, status, created_at) VALUES (?, ?, ?, ?, ?, datetime('now', '+10 seconds'))"
      ).run("inv_2", S, "svc", "q", "complete");
      const ms = db.getLastInvestigationAt(S, "svc");
      const now = Date.now();
      // Second insert is ~10s in the future
      expect(ms!).toBeGreaterThan(now + 5_000);
    });

    it("excludes failed investigations from the lookup", () => {
      // Only a failed investigation → returns null (not the failed one's timestamp)
      db.createInvestigation(S, { id: "inv_1", service: "flaky", query: "q", status: "failed" });
      expect(db.getLastInvestigationAt(S, "flaky")).toBeNull();
    });

    it("excludes in-progress investigations (running/pending) from the lookup", () => {
      // Regression: a stuck-running investigation would otherwise pin its service
      // at "most recently investigated" forever and starve it from scan prioritization.
      db.createInvestigation(S, { id: "inv_1", service: "stuck", query: "q", status: "running" });
      expect(db.getLastInvestigationAt(S, "stuck")).toBeNull();
    });

    it("picks the most recent non-failed when mixed with failures", () => {
      db.createInvestigation(S, { id: "inv_1", service: "svc", query: "q", status: "complete" });
      const rawDb = (db as unknown as { db: { prepare: (s: string) => { run: (...args: unknown[]) => void } } }).db;
      // Later but failed → should be ignored; method returns the earlier complete one
      rawDb.prepare(
        "INSERT INTO investigations (id, stack_id, service, query, status, created_at) VALUES (?, ?, ?, ?, ?, datetime('now', '+20 seconds'))"
      ).run("inv_2", S, "svc", "q", "failed");
      const ms = db.getLastInvestigationAt(S, "svc");
      const now = Date.now();
      // Should be close to "now" (the first inv), not 20s in the future
      expect(ms!).toBeLessThan(now + 5_000);
    });

    it("scopes by stack_id", () => {
      db.createInvestigation("stack-a", { id: "inv_1", service: "svc", query: "q", status: "complete" });
      expect(db.getLastInvestigationAt("stack-b", "svc")).toBeNull();
      expect(db.getLastInvestigationAt("stack-a", "svc")).not.toBeNull();
    });
  });

  describe("investigation phases", () => {
    it("creates and retrieves phases for an investigation", () => {
      db.createInvestigation(S, { id: "inv_1", service: "svc", query: "q", status: "running" });
      db.createPhase({ id: "ph_1", investigationId: "inv_1", phase: "metrics", status: "running" });
      db.updatePhase("ph_1", { status: "complete", findings: JSON.stringify({ observations: [] }) });
      const phases = db.getPhases("inv_1");
      expect(phases).toHaveLength(1);
      expect(phases[0]!.status).toBe("complete");
    });
  });

  describe("messages", () => {
    it("creates and retrieves console messages (excludes investigation messages)", () => {
      db.createMessage(S, { id: "msg_1", role: "user", content: "hello" });
      db.createMessage(S, { id: "msg_2", role: "assistant", content: "hi there", investigationId: "inv_1" });
      const msgs = db.listMessages(S, 50);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.id).toBe("msg_1");
    });

    it("lists messages ordered by created_at asc", () => {
      db.createMessage(S, { id: "msg_1", role: "user", content: "first" });
      db.createMessage(S, { id: "msg_2", role: "assistant", content: "second" });
      const msgs = db.listMessages(S, 50);
      expect(msgs[0]!.content).toBe("first");
    });

    it("listMessages excludes investigation follow-up Q&A but keeps RCA completion summaries", () => {
      db.createMessage(S, { id: "msg_1", role: "user", content: "console 1" });
      db.createMessage(S, { id: "msg_2", role: "user", content: "console 2" });
      db.createMessage(S, { id: "msg_3", role: "assistant", content: "follow-up answer", investigationId: "inv_1" });
      db.createMessage(S, { id: "msg_4", role: "assistant", content: "**Root Cause:** something broke\n**Confidence:** high", investigationId: "inv_1" });
      const msgs = db.listMessages(S, 50);
      expect(msgs).toHaveLength(3); // 2 console + 1 RCA summary
      expect(msgs.some(m => m.content.startsWith("**Root Cause:**"))).toBe(true);
      expect(msgs.every(m => m.content !== "follow-up answer")).toBe(true);
    });

    it("listMessages with investigationId still returns scoped messages", () => {
      db.createMessage(S, { id: "msg_1", role: "user", content: "console msg" });
      db.createMessage(S, { id: "msg_2", role: "assistant", content: "inv msg 1", investigationId: "inv_1" });
      db.createMessage(S, { id: "msg_3", role: "assistant", content: "inv msg 2", investigationId: "inv_1" });
      const msgs = db.listMessages(S, 50, "inv_1");
      expect(msgs).toHaveLength(2);
      expect(msgs.every(m => m.investigation_id === "inv_1")).toBe(true);
    });

    it("listRecentMessages excludes investigation messages", () => {
      db.createMessage(S, { id: "msg_1", role: "user", content: "console 1" });
      db.createMessage(S, { id: "msg_2", role: "user", content: "console 2" });
      db.createMessage(S, { id: "msg_3", role: "assistant", content: "inv msg", investigationId: "inv_1" });
      const msgs = db.listRecentMessages(S, 50);
      expect(msgs).toHaveLength(2);
      expect(msgs.every(m => m.investigation_id === null)).toBe(true);
    });

    it("listMessages returns latest N not oldest N", () => {
      db.createMessage(S, { id: "msg_1", role: "user", content: "oldest" });
      db.createMessage(S, { id: "msg_2", role: "user", content: "old" });
      db.createMessage(S, { id: "msg_3", role: "user", content: "middle" });
      db.createMessage(S, { id: "msg_4", role: "user", content: "recent" });
      db.createMessage(S, { id: "msg_5", role: "user", content: "newest" });
      const msgs = db.listMessages(S, 3);
      expect(msgs).toHaveLength(3);
      // Should be the 3 most recent, returned in ASC order
      expect(msgs[0]!.content).toBe("middle");
      expect(msgs[1]!.content).toBe("recent");
      expect(msgs[2]!.content).toBe("newest");
    });

    it("deleteMessage only deletes console messages", () => {
      db.createMessage(S, { id: "msg_1", role: "user", content: "console msg" });
      db.createMessage(S, { id: "msg_2", role: "assistant", content: "inv msg", investigationId: "inv_1" });
      const deleted = db.deleteMessage(S, "msg_2");
      expect(deleted).toBe(false);
      // Investigation message should still exist
      const msgs = db.listMessages(S, 50, "inv_1");
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.id).toBe("msg_2");
    });

    it("deleteMessage returns true for console message", () => {
      db.createMessage(S, { id: "msg_1", role: "user", content: "console msg" });
      const deleted = db.deleteMessage(S, "msg_1");
      expect(deleted).toBe(true);
      const msgs = db.listMessages(S, 50);
      expect(msgs).toHaveLength(0);
    });

    it("clearConsoleMessages preserves investigation messages", () => {
      db.createMessage(S, { id: "msg_1", role: "user", content: "console 1" });
      db.createMessage(S, { id: "msg_2", role: "user", content: "console 2" });
      db.createMessage(S, { id: "msg_3", role: "user", content: "console 3" });
      db.createMessage(S, { id: "msg_4", role: "assistant", content: "inv msg 1", investigationId: "inv_1" });
      db.createMessage(S, { id: "msg_5", role: "assistant", content: "inv msg 2", investigationId: "inv_1" });
      const cleared = db.clearConsoleMessages(S);
      expect(cleared).toBe(3);
      // Investigation messages should still exist
      const invMsgs = db.listMessages(S, 50, "inv_1");
      expect(invMsgs).toHaveLength(2);
    });
  });

  // ── Hidden services ──────────────────────────────────────────────────────

  describe("hidden services", () => {
    it("hideService inserts with reason", () => {
      db.hideService(S, "kafka", "decommissioned");
      const details = db.getHiddenServiceDetails(S);
      expect(details).toHaveLength(1);
      expect(details[0]!.service).toBe("kafka");
      expect(details[0]!.reason).toBe("decommissioned");
      expect(details[0]!.hidden_at).toBeTruthy();
    });

    it("hideService is idempotent (INSERT OR REPLACE)", () => {
      db.hideService(S, "kafka", "reason-1");
      db.hideService(S, "kafka", "reason-2");
      const details = db.getHiddenServiceDetails(S);
      expect(details).toHaveLength(1);
      expect(details[0]!.reason).toBe("reason-2");
    });

    it("hideService works without reason", () => {
      db.hideService(S, "kafka");
      const details = db.getHiddenServiceDetails(S);
      expect(details[0]!.reason).toBeNull();
    });

    it("unhideService removes existing", () => {
      db.hideService(S, "kafka");
      db.unhideService(S, "kafka");
      expect(db.getHiddenServices(S).size).toBe(0);
    });

    it("unhideService is no-op on non-hidden service", () => {
      db.unhideService(S, "nonexistent");
      expect(db.getHiddenServices(S).size).toBe(0);
    });

    it("getHiddenServices returns Set with entries", () => {
      db.hideService(S, "kafka");
      db.hideService(S, "redis");
      const hidden = db.getHiddenServices(S);
      expect(hidden).toBeInstanceOf(Set);
      expect(hidden.size).toBe(2);
      expect(hidden.has("kafka")).toBe(true);
      expect(hidden.has("redis")).toBe(true);
    });

    it("getHiddenServices returns empty Set when none hidden", () => {
      const hidden = db.getHiddenServices(S);
      expect(hidden).toBeInstanceOf(Set);
      expect(hidden.size).toBe(0);
    });

    it("getHiddenServiceDetails returns full rows", () => {
      db.hideService(S, "kafka", "old cluster");
      db.hideService(S, "redis");
      const details = db.getHiddenServiceDetails(S);
      expect(details).toHaveLength(2);
      expect(details.every(d => d.hidden_at)).toBe(true);
    });

    it("hideServices batch inserts multiple", () => {
      db.hideServices(S, ["kafka", "redis", "postgres"], "cleanup");
      const hidden = db.getHiddenServices(S);
      expect(hidden.size).toBe(3);
      const details = db.getHiddenServiceDetails(S);
      expect(details.every(d => d.reason === "cleanup")).toBe(true);
    });

    it("hideServices with empty array is no-op", () => {
      db.hideServices(S, []);
      expect(db.getHiddenServices(S).size).toBe(0);
    });

    it("isServiceHidden returns correct boolean", () => {
      db.hideService(S, "kafka");
      expect(db.isServiceHidden(S, "kafka")).toBe(true);
      expect(db.isServiceHidden(S, "redis")).toBe(false);
    });

    it("getStaleUnknownServices returns services with only unknown checks", () => {
      // Insert health checks: kafka has only unknown, redis has a healthy check
      db.insertServiceHealthCheck(S, "kafka", "unknown", new Date().toISOString());
      db.insertServiceHealthCheck(S, "redis", "healthy", new Date().toISOString());
      const stale = db.getStaleUnknownServices(S, 7);
      expect(stale).toContain("kafka");
      expect(stale).not.toContain("redis");
    });

    it("getStaleUnknownServices excludes already-hidden services", () => {
      db.insertServiceHealthCheck(S, "kafka", "unknown", new Date().toISOString());
      db.hideService(S, "kafka");
      const stale = db.getStaleUnknownServices(S, 7);
      expect(stale).not.toContain("kafka");
    });
  });

  // ── Confidence score extraction ────────────────────────────────────────

  describe("confidence_score extraction", () => {
    it("extracts confidenceScore from valid report JSON via listInvestigations", () => {
      db.createInvestigation(S, { id: "inv_1", service: "svc", query: "q", status: "complete" });
      db.updateInvestigation("inv_1", { status: "complete", report: JSON.stringify({ confidenceScore: 0.85 }) });
      const list = db.listInvestigations(S, { limit: 10 });
      expect(list[0]!.confidence_score).toBe(0.85);
    });

    it("extracts confidenceScore from valid report JSON via getInvestigation", () => {
      db.createInvestigation(S, { id: "inv_1", service: "svc", query: "q", status: "complete" });
      db.updateInvestigation("inv_1", { status: "complete", report: JSON.stringify({ confidenceScore: 0.7 }) });
      const inv = db.getInvestigation(S, "inv_1");
      expect(inv!.confidence_score).toBe(0.7);
    });

    it("returns null when report JSON lacks confidenceScore field", () => {
      db.createInvestigation(S, { id: "inv_1", service: "svc", query: "q", status: "complete" });
      db.updateInvestigation("inv_1", { status: "complete", report: JSON.stringify({ rootCause: "OOM" }) });
      const inv = db.getInvestigation(S, "inv_1");
      expect(inv!.confidence_score).toBeNull();
    });

    it("returns null when report is NULL", () => {
      db.createInvestigation(S, { id: "inv_1", service: "svc", query: "q", status: "running" });
      const inv = db.getInvestigation(S, "inv_1");
      expect(inv!.confidence_score).toBeNull();
    });

    it("returns null for malformed non-JSON report (json_valid guard)", () => {
      db.createInvestigation(S, { id: "inv_1", service: "svc", query: "q", status: "complete" });
      db.updateInvestigation("inv_1", { status: "complete", report: "not valid json" });
      const inv = db.getInvestigation(S, "inv_1");
      expect(inv!.confidence_score).toBeNull();
    });
  });

  // ── KPI Stats ─────────────────────────────────────────────────────────

  describe("getKpiStats", () => {
    it("returns zeros for empty database", () => {
      const stats = db.getKpiStats(S);
      expect(stats.investigations).toEqual({ total: 0, active: 0, complete: 0, failed: 0 });
      expect(stats.successRate).toBeNull();
      expect(stats.confidence).toEqual({ avg: null, scored: 0, lowConfidence: 0 });
      expect(stats.mttr.avg7d).toBe(0);
      expect(stats.mttr.completed7d).toBe(0);
      expect(stats.mttr.trend).toBeUndefined();
    });

    it("counts investigation statuses correctly", () => {
      db.createInvestigation(S, { id: "inv_1", service: "svc-a", query: "q", status: "complete" });
      db.createInvestigation(S, { id: "inv_2", service: "svc-b", query: "q", status: "running" });
      db.createInvestigation(S, { id: "inv_3", service: "svc-c", query: "q", status: "failed" });
      db.createInvestigation(S, { id: "inv_4", service: "svc-d", query: "q", status: "complete" });
      const stats = db.getKpiStats(S);
      expect(stats.investigations).toEqual({ total: 4, active: 1, complete: 2, failed: 1 });
    });

    it("computes success rate excluding stale-cleanup failures", () => {
      // 2 complete, 1 real failed (has report), 1 stale-cleanup failed (no report)
      db.createInvestigation(S, { id: "inv_1", service: "svc", query: "q", status: "complete" });
      db.updateInvestigation("inv_1", { report: '{"ok":true}' });
      db.createInvestigation(S, { id: "inv_2", service: "svc", query: "q", status: "complete" });
      db.updateInvestigation("inv_2", { report: '{"ok":true}' });
      db.createInvestigation(S, { id: "inv_3", service: "svc", query: "q", status: "failed" });
      db.updateInvestigation("inv_3", { report: '{"error":"timeout"}' });
      db.createInvestigation(S, { id: "inv_4", service: "svc", query: "q", status: "failed" });
      // inv_4 has no report — stale-cleanup, excluded from success rate
      const stats = db.getKpiStats(S);
      // successRate = 2 / (2 + 1) * 100 = 66.67
      expect(stats.successRate).toBeCloseTo(66.67, 1);
    });

    it("returns null success rate when no complete or real-failed investigations", () => {
      db.createInvestigation(S, { id: "inv_1", service: "svc", query: "q", status: "running" });
      const stats = db.getKpiStats(S);
      expect(stats.successRate).toBeNull();
    });

    it("computes average confidence from completed investigations", () => {
      db.createInvestigation(S, { id: "inv_1", service: "svc", query: "q", status: "complete" });
      db.updateInvestigation("inv_1", { report: JSON.stringify({ confidenceScore: 0.8 }) });
      db.createInvestigation(S, { id: "inv_2", service: "svc", query: "q", status: "complete" });
      db.updateInvestigation("inv_2", { report: JSON.stringify({ confidenceScore: 0.6 }) });
      const stats = db.getKpiStats(S);
      expect(stats.confidence.avg).toBeCloseTo(0.7, 5);
      expect(stats.confidence.scored).toBe(2);
      expect(stats.confidence.lowConfidence).toBe(0);
    });

    it("counts low confidence investigations (below 0.5)", () => {
      db.createInvestigation(S, { id: "inv_1", service: "svc", query: "q", status: "complete" });
      db.updateInvestigation("inv_1", { report: JSON.stringify({ confidenceScore: 0.3 }) });
      db.createInvestigation(S, { id: "inv_2", service: "svc", query: "q", status: "complete" });
      db.updateInvestigation("inv_2", { report: JSON.stringify({ confidenceScore: 0.8 }) });
      const stats = db.getKpiStats(S);
      expect(stats.confidence.lowConfidence).toBe(1);
    });

    it("excludes null confidence from average", () => {
      db.createInvestigation(S, { id: "inv_1", service: "svc", query: "q", status: "complete" });
      db.updateInvestigation("inv_1", { report: JSON.stringify({ confidenceScore: 0.9 }) });
      db.createInvestigation(S, { id: "inv_2", service: "svc", query: "q", status: "complete" });
      db.updateInvestigation("inv_2", { report: JSON.stringify({ rootCause: "OOM" }) }); // no confidenceScore
      const stats = db.getKpiStats(S);
      // Only inv_1 has confidence, so avg = 0.9
      expect(stats.confidence.avg).toBeCloseTo(0.9, 5);
      expect(stats.confidence.scored).toBe(1);
    });

    it("handles malformed report JSON gracefully in confidence", () => {
      db.createInvestigation(S, { id: "inv_1", service: "svc", query: "q", status: "complete" });
      db.updateInvestigation("inv_1", { report: "not json" });
      const stats = db.getKpiStats(S);
      expect(stats.confidence.avg).toBeNull();
      expect(stats.confidence.scored).toBe(0);
    });

    it("computes MTTR for last 7 days", () => {
      db.createInvestigation(S, { id: "inv_1", service: "svc", query: "q", status: "running" });
      db.updateInvestigation("inv_1", { status: "complete", total_duration_ms: 60_000 });
      db.createInvestigation(S, { id: "inv_2", service: "svc", query: "q", status: "running" });
      db.updateInvestigation("inv_2", { status: "complete", total_duration_ms: 120_000 });
      const stats = db.getKpiStats(S);
      expect(stats.mttr.avg7d).toBe(90_000);
      expect(stats.mttr.completed7d).toBe(2);
    });
  });

  // ── Service metadata ──────────────────────────────────────────────────

  describe("service metadata", () => {
    it("upsertServiceMetadata creates and getServiceMetadata retrieves", () => {
      db.upsertServiceMetadata(S, "payments-api", { alias: "Payments", tags: ["critical", "backend"] });
      const meta = db.getServiceMetadata(S, "payments-api");
      expect(meta).toBeDefined();
      expect(meta!.service).toBe("payments-api");
      expect(meta!.alias).toBe("Payments");
      expect(meta!.tags).toEqual(["critical", "backend"]);
      expect(meta!.updated_at).toBeTruthy();
    });

    it("returns null for unknown service", () => {
      const meta = db.getServiceMetadata(S, "nonexistent");
      expect(meta).toBeNull();
    });

    it("updates alias without clearing tags", () => {
      db.upsertServiceMetadata(S, "payments-api", { alias: "Payments", tags: ["critical"] });
      db.upsertServiceMetadata(S, "payments-api", { alias: "Payments V2" });
      const meta = db.getServiceMetadata(S, "payments-api");
      expect(meta!.alias).toBe("Payments V2");
      expect(meta!.tags).toEqual(["critical"]);
    });

    it("updates tags without clearing alias", () => {
      db.upsertServiceMetadata(S, "payments-api", { alias: "Payments", tags: ["critical"] });
      db.upsertServiceMetadata(S, "payments-api", { tags: ["critical", "tier-1"] });
      const meta = db.getServiceMetadata(S, "payments-api");
      expect(meta!.alias).toBe("Payments");
      expect(meta!.tags).toEqual(["critical", "tier-1"]);
    });

    it("getAllServiceMetadata returns all entries", () => {
      db.upsertServiceMetadata(S, "svc-a", { alias: "Service A" });
      db.upsertServiceMetadata(S, "svc-b", { tags: ["backend"] });
      const all = db.getAllServiceMetadata(S);
      expect(all).toHaveLength(2);
      const names = all.map(m => m.service);
      expect(names).toContain("svc-a");
      expect(names).toContain("svc-b");
    });

    it("getAllServiceMetadata returns empty array when no metadata exists", () => {
      const all = db.getAllServiceMetadata(S);
      expect(all).toEqual([]);
    });

    it("upsertServiceMetadata with empty update on new service creates with nulls", () => {
      db.upsertServiceMetadata(S, "svc-new", {});
      const meta = db.getServiceMetadata(S, "svc-new");
      expect(meta).toBeDefined();
      expect(meta!.alias).toBeNull();
      expect(meta!.tags).toEqual([]);
    });

    it("clearServiceAlias on an existing row sets alias to null (and keeps tags)", () => {
      // Regression: route handler used to coerce client-sent `alias: null`
      // into `""` which never cleared the DB column. Now the handler calls
      // clearServiceAlias for null/empty input, which should actually null
      // the column without touching tags.
      db.upsertServiceMetadata(S, "payments-api", { alias: "Payments", tags: ["critical"] });
      db.clearServiceAlias(S, "payments-api");
      const meta = db.getServiceMetadata(S, "payments-api");
      expect(meta!.alias).toBeNull();
      expect(meta!.tags).toEqual(["critical"]);
    });

    it("clearServiceAlias on a missing row inserts a row with null alias", () => {
      // Clearing before any write should be a no-op conceptually. Idempotent
      // behavior: after the call, reading back returns the empty record.
      db.clearServiceAlias(S, "never-written");
      const meta = db.getServiceMetadata(S, "never-written");
      expect(meta).toBeDefined();
      expect(meta!.alias).toBeNull();
      expect(meta!.tags).toEqual([]);
    });
  });

  // ── listInvestigations with service filter ────────────────────────────

  describe("listInvestigations with service filter", () => {
    beforeEach(() => {
      db.createInvestigation(S, { id: "inv_1", service: "payments-api", query: "high latency", status: "complete" });
      db.createInvestigation(S, { id: "inv_2", service: "auth-service", query: "login failures", status: "complete" });
      db.createInvestigation(S, { id: "inv_3", service: "payments-api", query: "error spike", status: "running" });
      db.createInvestigation(S, { id: "inv_4", service: "redis", query: "memory", status: "complete" });
    });

    it("filters by service when param provided", () => {
      const list = db.listInvestigations(S, { limit: 10, service: "payments-api" });
      expect(list).toHaveLength(2);
      expect(list.every(inv => inv.service === "payments-api")).toBe(true);
    });

    it("returns all when no service filter", () => {
      const list = db.listInvestigations(S, { limit: 10 });
      expect(list).toHaveLength(4);
    });

    it("returns empty array when service has no investigations", () => {
      const list = db.listInvestigations(S, { limit: 10, service: "nonexistent-service" });
      expect(list).toEqual([]);
    });

    it("respects limit and offset with service filter", () => {
      // Add more investigations for payments-api
      db.createInvestigation(S, { id: "inv_5", service: "payments-api", query: "q5", status: "complete" });
      const page = db.listInvestigations(S, { limit: 1, offset: 1, service: "payments-api" });
      expect(page).toHaveLength(1);
      expect(page[0]!.service).toBe("payments-api");
    });
  });

  // ── Stack CRUD ────────────────────────────────────────────────────────

  describe("stack CRUD", () => {
    it("creates and retrieves a stack", () => {
      db.createStack({ id: "stk_1", name: "US East", slug: "us-east", config: '{"providers":[]}' });
      const stack = db.getStack("stk_1");
      expect(stack).toBeDefined();
      expect(stack!.name).toBe("US East");
      expect(stack!.slug).toBe("us-east");
      expect(stack!.config).toBe('{"providers":[]}');
    });

    it("getStackBySlug retrieves by slug", () => {
      db.createStack({ id: "stk_1", name: "US East", slug: "us-east", config: '{"providers":[]}' });
      const stack = db.getStackBySlug("us-east");
      expect(stack).toBeDefined();
      expect(stack!.id).toBe("stk_1");
    });

    it("listStacks returns all stacks ordered by created_at", () => {
      db.createStack({ id: "stk_1", name: "US East", slug: "us-east", config: '{"providers":[]}' });
      db.createStack({ id: "stk_2", name: "EU West", slug: "eu-west", config: '{"providers":[]}' });
      const stacks = db.listStacks();
      expect(stacks).toHaveLength(2);
      expect(stacks[0]!.id).toBe("stk_1");
      expect(stacks[1]!.id).toBe("stk_2");
    });

    it("updateStack updates name and slug", () => {
      db.createStack({ id: "stk_1", name: "US East", slug: "us-east", config: '{"providers":[]}' });
      db.updateStack("stk_1", { name: "US East Prod", slug: "us-east-prod" });
      const stack = db.getStack("stk_1");
      expect(stack!.name).toBe("US East Prod");
      expect(stack!.slug).toBe("us-east-prod");
    });

    it("deleteStack cascades to all related tables", () => {
      const stackId = "stk_1";
      db.createStack({ id: stackId, name: "Test", slug: "test", config: '{"providers":[]}' });
      db.createInvestigation(stackId, { id: "inv_1", service: "svc", query: "q", status: "complete" });
      db.createMessage(stackId, { id: "msg_1", role: "user", content: "hello" });
      db.hideService(stackId, "kafka");
      db.upsertServiceMetadata(stackId, "svc", { alias: "Service" });
      db.insertServiceHealthCheck(stackId, "svc", "healthy", new Date().toISOString());
      db.createFeedback(stackId, { id: "fb_1", investigationId: "inv_1", rating: "useful" });
      db.createPattern(stackId, { id: "pat_1", service: "svc", symptom: "high cpu", rootCause: "leak", severity: "high" });

      db.deleteStack(stackId);

      expect(db.getStack(stackId)).toBeUndefined();
      expect(db.listInvestigations(stackId, 10, 0)).toHaveLength(0);
      expect(db.listMessages(stackId, 50)).toHaveLength(0);
      expect(db.getHiddenServices(stackId).size).toBe(0);
      expect(db.getAllServiceMetadata(stackId)).toHaveLength(0);
    });

    it("deleteStack cascades investigation_phases and investigation_events", () => {
      const stackId = "stk_2";
      db.createStack({ id: stackId, name: "Cascade Test", slug: "cascade-test", config: '{"providers":[]}' });
      db.createInvestigation(stackId, { id: "inv_c1", service: "svc", query: "q", status: "running" });

      // Add phases and events for the investigation
      db.createPhase({ id: "ph_c1", investigationId: "inv_c1", phase: "metrics", status: "running" });
      db.createPhase({ id: "ph_c2", investigationId: "inv_c1", phase: "logs", status: "running" });
      db.createEvent({ id: "ev_c1", investigationId: "inv_c1", eventType: "tool_call", payload: '{"tool":"query"}' });
      db.createEvent({ id: "ev_c2", investigationId: "inv_c1", eventType: "observation", payload: '{"text":"high cpu"}' });

      // Verify they exist before delete
      expect(db.getPhases("inv_c1")).toHaveLength(2);
      expect(db.getEvents("inv_c1")).toHaveLength(2);

      db.deleteStack(stackId);

      // Phases and events should be cleaned up
      expect(db.getPhases("inv_c1")).toHaveLength(0);
      expect(db.getEvents("inv_c1")).toHaveLength(0);
    });
  });

  // ── Stack TTL columns + reaper (B-2) ──────────────────────────────────

  describe("stack TTL", () => {
    it("adds last_active_at, inactive_at, and deleted_at columns (idempotent)", () => {
      // Re-running the migration on an existing DB must be a no-op, not an
      // error. Better-sqlite3 throws on ALTER TABLE if the column already
      // exists — our migration has to guard with PRAGMA table_info.
      const info = (db as unknown as { db: { prepare: (s: string) => { all: () => Array<{ name: string }> } } }).db
        .prepare("PRAGMA table_info(stacks)")
        .all();
      const names = info.map(c => c.name);
      expect(names).toContain("last_active_at");
      expect(names).toContain("inactive_at");
      expect(names).toContain("deleted_at");
    });

    it("createStack populates last_active_at with the current time", () => {
      db.createStack({ id: "stk_fresh", name: "Fresh", slug: "fresh", config: '{"providers":[]}' });
      const row = db.getStack("stk_fresh");
      expect(row!.last_active_at).toBeDefined();
      // SQLite datetime('now') is UTC and close to Date.now()
      const activeTime = new Date(row!.last_active_at + "Z").getTime();
      expect(Math.abs(Date.now() - activeTime)).toBeLessThan(5000);
    });

    it("bumpStackActivity updates last_active_at and clears inactive_at", () => {
      db.createStack({ id: "stk_b", name: "B", slug: "b", config: '{"providers":[]}' });
      // Force both to the past using the underlying better-sqlite3 handle
      const raw = (db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db;
      raw.prepare("UPDATE stacks SET last_active_at = ?, inactive_at = ? WHERE id = ?")
        .run("2020-01-01 00:00:00", "2020-02-01 00:00:00", "stk_b");

      db.bumpStackActivity("stk_b");

      const row = db.getStack("stk_b");
      expect(row!.last_active_at).not.toBe("2020-01-01 00:00:00");
      expect(row!.inactive_at).toBeNull();
    });

    it("runStackTtlReaper marks idle stacks inactive at the 30-day cutoff", () => {
      db.createStack({ id: "stk_idle", name: "Idle", slug: "idle", config: '{"providers":[]}' });
      const raw = (db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db;
      // 31 days old — past inactive, not yet past delete
      const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString();
      raw.prepare("UPDATE stacks SET last_active_at = ? WHERE id = ?")
        .run(thirtyOneDaysAgo, "stk_idle");

      const result = db.runStackTtlReaper({
        defaultStackId: "nonexistent-default",
        inactiveAfterDays: 30,
        deleteAfterDays: 60,
      });

      expect(result.markedInactive).toBe(1);
      expect(result.softDeleted).toBe(0);
      const row = db.getStack("stk_idle");
      expect(row!.inactive_at).not.toBeNull();
      expect(row!.deleted_at).toBeNull();
    });

    it("runStackTtlReaper soft-deletes stacks past the 60-day cutoff", () => {
      db.createStack({ id: "stk_dead", name: "Dead", slug: "dead", config: '{"providers":[]}' });
      const raw = (db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db;
      const sixtyOneDaysAgo = new Date(Date.now() - 61 * 24 * 3600 * 1000).toISOString();
      raw.prepare("UPDATE stacks SET last_active_at = ? WHERE id = ?")
        .run(sixtyOneDaysAgo, "stk_dead");

      const result = db.runStackTtlReaper({
        defaultStackId: "nonexistent-default",
        inactiveAfterDays: 30,
        deleteAfterDays: 60,
      });

      expect(result.softDeleted).toBe(1);
      expect(db.getStack("stk_dead")).toBeUndefined();
      expect(db.listStacksIncludingDeleted().find(s => s.id === "stk_dead")).toBeDefined();
    });

    it("runStackTtlReaper never reaps the default stack", () => {
      db.createStack({ id: "stk_default", name: "Default", slug: "default-for-test", config: '{"providers":[]}' });
      const raw = (db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db;
      const sixtyOneDaysAgo = new Date(Date.now() - 61 * 24 * 3600 * 1000).toISOString();
      raw.prepare("UPDATE stacks SET last_active_at = ? WHERE id = ?")
        .run(sixtyOneDaysAgo, "stk_default");

      const result = db.runStackTtlReaper({
        defaultStackId: "stk_default",
        inactiveAfterDays: 30,
        deleteAfterDays: 60,
      });

      expect(result.markedInactive).toBe(0);
      expect(result.softDeleted).toBe(0);
    });

    it("listStacks excludes soft-deleted rows; listStacksIncludingDeleted includes them", () => {
      db.createStack({ id: "stk_live", name: "Live", slug: "live", config: '{"providers":[]}' });
      db.createStack({ id: "stk_soft_dead", name: "Soft Dead", slug: "soft-dead", config: '{"providers":[]}' });
      const raw = (db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db;
      raw.prepare("UPDATE stacks SET deleted_at = datetime('now') WHERE id = ?")
        .run("stk_soft_dead");

      const visible = db.listStacks();
      expect(visible.find(s => s.id === "stk_soft_dead")).toBeUndefined();
      expect(visible.find(s => s.id === "stk_live")).toBeDefined();

      const all = db.listStacksIncludingDeleted();
      expect(all.find(s => s.id === "stk_soft_dead")).toBeDefined();
      expect(all.find(s => s.id === "stk_live")).toBeDefined();
    });

    it("getStack and getStackBySlug hide soft-deleted rows", () => {
      db.createStack({ id: "stk_hidden", name: "Hidden", slug: "hidden-stack", config: '{"providers":[]}' });
      const raw = (db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db;
      raw.prepare("UPDATE stacks SET deleted_at = datetime('now') WHERE id = ?")
        .run("stk_hidden");

      expect(db.getStack("stk_hidden")).toBeUndefined();
      expect(db.getStackBySlug("hidden-stack")).toBeUndefined();
    });

    it("migration idempotency: second Database instance reuses existing columns", () => {
      // Close + re-open the same in-memory DB is not possible (it's per-
      // instance), but we can verify migrateStacks is safe to call twice on
      // the same DB by opening a fresh :memory: and not inspecting a side
      // effect — the Database constructor calls migrate* multiple times
      // via the cascade. If the guards weren't working, ALTER TABLE would
      // throw during construction. The fact that beforeEach's `new Database`
      // succeeds means both code paths (first run + re-run) work.
      const second = new Database(":memory:");
      const raw = (second as unknown as { db: { prepare: (s: string) => { all: () => Array<{ name: string }> } } }).db;
      const names = raw.prepare("PRAGMA table_info(stacks)").all().map(c => c.name);
      expect(names).toContain("last_active_at");
      second.close();
    });
  });

  // ── Backfill default stack ────────────────────────────────────────────

  describe("backfillDefaultStack", () => {
    it("backfills null/empty stack_id with the given default", () => {
      // Create data without explicit stack_id (will be NULL from the migration default)
      db.createInvestigation("", { id: "inv_1", service: "svc", query: "q", status: "complete" });
      db.createMessage("", { id: "msg_1", role: "user", content: "hello" });
      db.hideService("", "kafka");
      db.upsertServiceMetadata("", "svc", { alias: "A" });

      db.backfillDefaultStack("default-stack-id");

      // Now data should be accessible under the new stackId
      expect(db.listInvestigations("default-stack-id", 10, 0)).toHaveLength(1);
      expect(db.listMessages("default-stack-id", 50)).toHaveLength(1);
      expect(db.getHiddenServices("default-stack-id").has("kafka")).toBe(true);
      expect(db.getServiceMetadata("default-stack-id", "svc")).toBeDefined();
    });
  });

  // ── Stack isolation ───────────────────────────────────────────────────

  describe("stack isolation", () => {
    it("investigations are isolated by stack", () => {
      db.createInvestigation("stack-a", { id: "inv_a", service: "svc", query: "q", status: "complete" });
      db.createInvestigation("stack-b", { id: "inv_b", service: "svc", query: "q", status: "complete" });
      expect(db.listInvestigations("stack-a", 10, 0)).toHaveLength(1);
      expect(db.listInvestigations("stack-b", 10, 0)).toHaveLength(1);
    });

    it("messages are isolated by stack", () => {
      db.createMessage("stack-a", { id: "msg_a", role: "user", content: "a" });
      db.createMessage("stack-b", { id: "msg_b", role: "user", content: "b" });
      expect(db.listMessages("stack-a", 50)).toHaveLength(1);
      expect(db.listMessages("stack-b", 50)).toHaveLength(1);
    });

    it("hidden services are isolated by stack", () => {
      db.hideService("stack-a", "kafka");
      db.hideService("stack-b", "redis");
      expect(db.getHiddenServices("stack-a").has("kafka")).toBe(true);
      expect(db.getHiddenServices("stack-a").has("redis")).toBe(false);
      expect(db.getHiddenServices("stack-b").has("redis")).toBe(true);
      expect(db.getHiddenServices("stack-b").has("kafka")).toBe(false);
    });

    it("service metadata is isolated by stack", () => {
      db.upsertServiceMetadata("stack-a", "svc", { alias: "A" });
      db.upsertServiceMetadata("stack-b", "svc", { alias: "B" });
      expect(db.getServiceMetadata("stack-a", "svc")!.alias).toBe("A");
      expect(db.getServiceMetadata("stack-b", "svc")!.alias).toBe("B");
    });

    it("KPI stats are isolated by stack", () => {
      db.createInvestigation("stack-a", { id: "inv_a1", service: "svc", query: "q", status: "complete" });
      db.createInvestigation("stack-a", { id: "inv_a2", service: "svc", query: "q", status: "complete" });
      db.createInvestigation("stack-b", { id: "inv_b1", service: "svc", query: "q", status: "running" });
      const statsA = db.getKpiStats("stack-a");
      const statsB = db.getKpiStats("stack-b");
      expect(statsA.investigations.total).toBe(2);
      expect(statsA.investigations.complete).toBe(2);
      expect(statsB.investigations.total).toBe(1);
      expect(statsB.investigations.active).toBe(1);
    });
  });

  describe("severityOf", () => {
    it("returns null for missing/invalid input", () => {
      expect(severityOf(null)).toBeNull();
      expect(severityOf("")).toBeNull();
      expect(severityOf(undefined)).toBeNull();
      expect(severityOf("not valid json")).toBeNull();
      expect(severityOf("[]")).toBeNull();
      expect(severityOf("null")).toBeNull();
      expect(severityOf(JSON.stringify({}))).toBeNull();
      expect(severityOf(JSON.stringify({ severity: null }))).toBeNull();
      expect(severityOf(JSON.stringify({ severity: 42 }))).toBeNull();
      expect(severityOf(JSON.stringify({ severity: "" }))).toBeNull();
      expect(severityOf(JSON.stringify({ severity: "bogus" }))).toBeNull();
    });

    it("canonicalizes valid severities to lowercase", () => {
      expect(severityOf(JSON.stringify({ severity: "critical" }))).toBe("critical");
      expect(severityOf(JSON.stringify({ severity: "CRITICAL" }))).toBe("critical");
      expect(severityOf(JSON.stringify({ severity: "  High  " }))).toBe("high");
      expect(severityOf(JSON.stringify({ severity: "Medium" }))).toBe("medium");
      expect(severityOf(JSON.stringify({ severity: "low" }))).toBe("low");
    });
  });

  describe("severity column + backfill", () => {
    it("populates severity column on updateInvestigation when report has severity", () => {
      db.createInvestigation(S, { id: "inv_1", service: "api", query: "q", status: "running" });
      db.updateInvestigation("inv_1", { status: "complete", report: JSON.stringify({ severity: "critical", rootCause: "OOM" }) });
      const row = db.getInvestigation(S, "inv_1");
      expect(row?.severity).toBe("critical");
    });

    it("sets severity to null when report has no valid severity", () => {
      db.createInvestigation(S, { id: "inv_1", service: "api", query: "q", status: "running" });
      db.updateInvestigation("inv_1", { status: "complete", report: JSON.stringify({ rootCause: "..." }) });
      expect(db.getInvestigation(S, "inv_1")?.severity).toBeNull();
    });

    it("sets severity to null when report has invalid value", () => {
      db.createInvestigation(S, { id: "inv_1", service: "api", query: "q", status: "running" });
      db.updateInvestigation("inv_1", { status: "complete", report: JSON.stringify({ severity: "CATASTROPHIC" }) });
      expect(db.getInvestigation(S, "inv_1")?.severity).toBeNull();
    });

    it("overwrites severity on subsequent report updates (keeps column in sync)", () => {
      db.createInvestigation(S, { id: "inv_1", service: "api", query: "q", status: "running" });
      db.updateInvestigation("inv_1", { status: "complete", report: JSON.stringify({ severity: "high" }) });
      expect(db.getInvestigation(S, "inv_1")?.severity).toBe("high");
      db.updateInvestigation("inv_1", { report: JSON.stringify({ severity: "critical" }) });
      expect(db.getInvestigation(S, "inv_1")?.severity).toBe("critical");
      db.updateInvestigation("inv_1", { report: JSON.stringify({ rootCause: "no sev" }) });
      expect(db.getInvestigation(S, "inv_1")?.severity).toBeNull();
    });
  });

  describe("listInvestigations filters", () => {
    beforeEach(() => {
      db.createInvestigation(S, { id: "inv_c", service: "admin-task", query: "q", status: "complete" });
      db.updateInvestigation("inv_c", { status: "complete", report: JSON.stringify({ severity: "critical", summary: "Redis outage", rootCause: "pool exhaustion" }) });
      db.createInvestigation(S, { id: "inv_h", service: "ingestion-flow", query: "q", status: "complete" });
      db.updateInvestigation("inv_h", { status: "complete", report: JSON.stringify({ severity: "high", summary: "disk pressure", rootCause: "nfs full" }) });
      db.createInvestigation(S, { id: "inv_m", service: "admin-task", query: "q", status: "complete" });
      db.updateInvestigation("inv_m", { status: "complete", report: JSON.stringify({ severity: "medium", summary: "slow queries", rootCause: "missing index" }) });
      db.createInvestigation(S, { id: "inv_r", service: "worker", query: "q", status: "running" });
    });

    it("no filters returns all rows in created_at DESC order", () => {
      const list = db.listInvestigations(S, {});
      expect(list.map((r) => r.id)).toEqual(["inv_r", "inv_m", "inv_h", "inv_c"]);
    });

    it("severity filter returns only matching rows", () => {
      const list = db.listInvestigations(S, { severity: ["critical"] });
      expect(list.map((r) => r.id)).toEqual(["inv_c"]);
    });

    it("severity multi-value applies OR semantics", () => {
      const list = db.listInvestigations(S, { severity: ["critical", "high"] });
      expect(new Set(list.map((r) => r.id))).toEqual(new Set(["inv_c", "inv_h"]));
    });

    it("status filter applies AND across filter groups", () => {
      const list = db.listInvestigations(S, { severity: ["critical", "high"], status: ["complete"] });
      expect(new Set(list.map((r) => r.id))).toEqual(new Set(["inv_c", "inv_h"]));
      expect(db.listInvestigations(S, { status: ["running"] }).map((r) => r.id)).toEqual(["inv_r"]);
    });

    it("q search matches service, report.summary, and report.rootCause", () => {
      expect(db.listInvestigations(S, { q: "admin" }).length).toBe(2);
      expect(db.listInvestigations(S, { q: "Redis" })[0]?.id).toBe("inv_c"); // matches summary
      expect(db.listInvestigations(S, { q: "nfs" })[0]?.id).toBe("inv_h"); // matches rootCause
    });

    it("q search escapes LIKE wildcards (% and _)", () => {
      db.createInvestigation(S, { id: "inv_pct", service: "svc-%weird%", query: "q", status: "complete" });
      const list = db.listInvestigations(S, { q: "%" });
      expect(list.map((r) => r.id)).toEqual(["inv_pct"]);
    });

    it("q search survives rows with malformed JSON reports (json_valid guard)", () => {
      // Historical rows can hold garbage in the report column. Without the
      // json_valid guard, SQLite's json_extract throws and takes down the
      // whole query with a 500. The filter should skip bad rows, not crash.
      db.createInvestigation(S, { id: "inv_bad", service: "svc-bad", query: "q", status: "complete" });
      const raw = (db as unknown as { db: { prepare: (s: string) => { run: (...args: unknown[]) => void } } }).db;
      raw.prepare("UPDATE investigations SET report = ? WHERE id = ?").run("{not-json", "inv_bad");
      // Must not throw. The bad row is skipped for JSON fields but still
      // searchable by its service/query columns.
      expect(() => db.listInvestigations(S, { q: "anything" })).not.toThrow();
      expect(db.listInvestigations(S, { q: "svc-bad" }).map((r) => r.id)).toContain("inv_bad");
    });

    it("since/until use datetime() wrapping so ISO strings compare correctly", () => {
      // Control time by setting created_at via raw SQL
      const raw = (db as unknown as { db: { prepare: (s: string) => { run: (...args: unknown[]) => void } } }).db;
      raw.prepare("UPDATE investigations SET created_at = ? WHERE id = ?").run("2024-06-01 10:00:00", "inv_c");
      raw.prepare("UPDATE investigations SET created_at = ? WHERE id = ?").run("2024-06-15 10:00:00", "inv_h");
      raw.prepare("UPDATE investigations SET created_at = ? WHERE id = ?").run("2024-07-01 10:00:00", "inv_m");
      // ISO format (with T) — plain lexical compare would fail since stored format uses space.
      const list = db.listInvestigations(S, { since: "2024-06-10T00:00:00Z", until: "2024-06-20T00:00:00Z" });
      expect(list.map((r) => r.id)).toEqual(["inv_h"]);
    });

    it("stack isolation holds with all new filters", () => {
      db.createInvestigation("other-stack", { id: "inv_other", service: "admin-task", query: "q", status: "complete" });
      db.updateInvestigation("inv_other", { status: "complete", report: JSON.stringify({ severity: "critical" }) });
      expect(db.listInvestigations(S, { severity: ["critical"] }).map((r) => r.id)).toEqual(["inv_c"]);
    });

    it("limit is clamped to [1, 10000]", () => {
      expect(db.listInvestigations(S, { limit: 0 }).length).toBeLessThanOrEqual(1);
      expect(db.listInvestigations(S, { limit: 50000 }).length).toBe(4); // still works, internal cap just prevents runaway
    });
  });

  describe("countInvestigations", () => {
    beforeEach(() => {
      db.createInvestigation(S, { id: "inv_1", service: "a", query: "q", status: "complete" });
      db.updateInvestigation("inv_1", { report: JSON.stringify({ severity: "critical" }) });
      db.createInvestigation(S, { id: "inv_2", service: "b", query: "q", status: "complete" });
      db.updateInvestigation("inv_2", { report: JSON.stringify({ severity: "high" }) });
      db.createInvestigation(S, { id: "inv_3", service: "c", query: "q", status: "running" });
    });

    it("returns total count ignoring limit/offset", () => {
      expect(db.countInvestigations(S, {})).toBe(3);
      expect(db.countInvestigations(S, { limit: 1 })).toBe(3);
      expect(db.countInvestigations(S, { offset: 100 })).toBe(3);
    });

    it("shares WHERE with list: same filter → consistent counts", () => {
      const filter = { severity: ["critical" as const, "high" as const] };
      expect(db.countInvestigations(S, filter)).toBe(db.listInvestigations(S, filter).length);
    });

    it("respects stack isolation", () => {
      db.createInvestigation("other", { id: "inv_other", service: "x", query: "q", status: "complete" });
      expect(db.countInvestigations(S, {})).toBe(3);
      expect(db.countInvestigations("other", {})).toBe(1);
    });
  });

  describe("countInvestigationsBySeverity", () => {
    beforeEach(() => {
      // 2 critical, 1 high, 1 medium, 1 low, 1 no-severity
      db.createInvestigation(S, { id: "c1", service: "a", query: "q", status: "complete" });
      db.updateInvestigation("c1", { report: JSON.stringify({ severity: "critical" }) });
      db.createInvestigation(S, { id: "c2", service: "a", query: "q", status: "complete" });
      db.updateInvestigation("c2", { report: JSON.stringify({ severity: "critical" }) });
      db.createInvestigation(S, { id: "h1", service: "b", query: "q", status: "complete" });
      db.updateInvestigation("h1", { report: JSON.stringify({ severity: "high" }) });
      db.createInvestigation(S, { id: "m1", service: "c", query: "q", status: "complete" });
      db.updateInvestigation("m1", { report: JSON.stringify({ severity: "medium" }) });
      db.createInvestigation(S, { id: "l1", service: "d", query: "q", status: "complete" });
      db.updateInvestigation("l1", { report: JSON.stringify({ severity: "low" }) });
      // Row with no severity — excluded from the histogram so the pills sum to the total.
      db.createInvestigation(S, { id: "n1", service: "e", query: "q", status: "running" });
    });

    it("groups by severity, excludes NULL severity rows", () => {
      expect(db.countInvestigationsBySeverity(S, {})).toEqual({
        critical: 2, high: 1, medium: 1, low: 1,
      });
    });

    it("ignores the severity filter so the histogram doesn't self-filter", () => {
      // Whether the user has severity=[critical] active or nothing, the pill
      // counts must be the same — otherwise clicking a pill immediately
      // zeros out the other pills and the strip becomes useless.
      const withSeverityActive = db.countInvestigationsBySeverity(S, { severity: ["critical"] });
      expect(withSeverityActive).toEqual({ critical: 2, high: 1, medium: 1, low: 1 });
    });

    it("applies every non-severity filter so pill counts reflect the other active filters", () => {
      // Restrict to one service — only c1 matches.
      expect(db.countInvestigationsBySeverity(S, { service: "a" })).toEqual({
        critical: 2, high: 0, medium: 0, low: 0,
      });
    });

    it("respects stack isolation", () => {
      db.createInvestigation("other", { id: "other_c", service: "z", query: "q", status: "complete" });
      db.updateInvestigation("other_c", { report: JSON.stringify({ severity: "critical" }) });
      expect(db.countInvestigationsBySeverity(S, {}).critical).toBe(2);
      expect(db.countInvestigationsBySeverity("other", {}).critical).toBe(1);
    });

    it("returns zeros for an empty stack", () => {
      expect(db.countInvestigationsBySeverity("nonexistent", {})).toEqual({
        critical: 0, high: 0, medium: 0, low: 0,
      });
    });
  });
});
