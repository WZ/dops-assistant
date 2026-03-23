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
});
