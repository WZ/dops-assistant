import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "./db.js";

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
      const inv = db.getInvestigation("inv_1");
      expect(inv).toBeDefined();
      expect(inv!.service).toBe("payments-api");
      expect(inv!.status).toBe("running");
    });

    it("updates investigation status and report", () => {
      db.createInvestigation(S, { id: "inv_1", service: "payments-api", query: "check errors", status: "running" });
      db.updateInvestigation("inv_1", { status: "complete", report: JSON.stringify({ rootCause: "OOM" }) });
      const inv = db.getInvestigation("inv_1");
      expect(inv!.status).toBe("complete");
      expect(JSON.parse(inv!.report!).rootCause).toBe("OOM");
    });

    it("lists investigations ordered by created_at desc", () => {
      db.createInvestigation(S, { id: "inv_1", service: "svc-a", query: "q1", status: "complete" });
      db.createInvestigation(S, { id: "inv_2", service: "svc-b", query: "q2", status: "running" });
      const list = db.listInvestigations(S, 10, 0);
      expect(list).toHaveLength(2);
      expect(list[0]!.id).toBe("inv_2");
    });

    it("paginates with limit and offset", () => {
      for (let i = 0; i < 5; i++) {
        db.createInvestigation(S, { id: `inv_${i}`, service: "svc", query: "q", status: "complete" });
      }
      const page = db.listInvestigations(S, 2, 2);
      expect(page).toHaveLength(2);
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
      const deleted = db.deleteMessage("msg_2");
      expect(deleted).toBe(false);
      // Investigation message should still exist
      const msgs = db.listMessages(S, 50, "inv_1");
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.id).toBe("msg_2");
    });

    it("deleteMessage returns true for console message", () => {
      db.createMessage(S, { id: "msg_1", role: "user", content: "console msg" });
      const deleted = db.deleteMessage("msg_1");
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
      const list = db.listInvestigations(S, 10, 0);
      expect(list[0]!.confidence_score).toBe(0.85);
    });

    it("extracts confidenceScore from valid report JSON via getInvestigation", () => {
      db.createInvestigation(S, { id: "inv_1", service: "svc", query: "q", status: "complete" });
      db.updateInvestigation("inv_1", { status: "complete", report: JSON.stringify({ confidenceScore: 0.7 }) });
      const inv = db.getInvestigation("inv_1");
      expect(inv!.confidence_score).toBe(0.7);
    });

    it("returns null when report JSON lacks confidenceScore field", () => {
      db.createInvestigation(S, { id: "inv_1", service: "svc", query: "q", status: "complete" });
      db.updateInvestigation("inv_1", { status: "complete", report: JSON.stringify({ rootCause: "OOM" }) });
      const inv = db.getInvestigation("inv_1");
      expect(inv!.confidence_score).toBeNull();
    });

    it("returns null when report is NULL", () => {
      db.createInvestigation(S, { id: "inv_1", service: "svc", query: "q", status: "running" });
      const inv = db.getInvestigation("inv_1");
      expect(inv!.confidence_score).toBeNull();
    });

    it("returns null for malformed non-JSON report (json_valid guard)", () => {
      db.createInvestigation(S, { id: "inv_1", service: "svc", query: "q", status: "complete" });
      db.updateInvestigation("inv_1", { status: "complete", report: "not valid json" });
      const inv = db.getInvestigation("inv_1");
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
      const list = db.listInvestigations(S, 10, 0, "payments-api");
      expect(list).toHaveLength(2);
      expect(list.every(inv => inv.service === "payments-api")).toBe(true);
    });

    it("returns all when no service filter", () => {
      const list = db.listInvestigations(S, 10, 0);
      expect(list).toHaveLength(4);
    });

    it("returns empty array when service has no investigations", () => {
      const list = db.listInvestigations(S, 10, 0, "nonexistent-service");
      expect(list).toEqual([]);
    });

    it("respects limit and offset with service filter", () => {
      // Add more investigations for payments-api
      db.createInvestigation(S, { id: "inv_5", service: "payments-api", query: "q5", status: "complete" });
      const page = db.listInvestigations(S, 1, 1, "payments-api");
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
});
