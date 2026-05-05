import { describe, it, expect } from "vitest";
import { Database } from "../db.js";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

function makeTempDb(): { db: Database; cleanup: () => void } {
  const dbPath = join(tmpdir(), `email-recip-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const db = new Database(dbPath);
  return {
    db,
    cleanup: () => {
      db.close();
      try { unlinkSync(dbPath); } catch {}
    },
  };
}

describe("Database — email_recipients CRUD", () => {
  it("listEmailRecipients returns empty on a fresh DB", () => {
    const { db, cleanup } = makeTempDb();
    try {
      expect(db.listEmailRecipients()).toEqual([]);
    } finally { cleanup(); }
  });

  it("createEmailRecipient + getEmailRecipient roundtrips all fields", () => {
    const { db, cleanup } = makeTempDb();
    try {
      const created = db.createEmailRecipient({
        address: "sre@example.com",
        label: "#sre-alerts",
        minSeverity: "high",
        allowedSources: ["webhook", "scan"],
        enabled: true,
      });
      expect(created.id).toBeGreaterThan(0);
      const got = db.getEmailRecipient(created.id);
      expect(got).toMatchObject({
        address: "sre@example.com",
        label: "#sre-alerts",
        minSeverity: "high",
        allowedSources: ["webhook", "scan"],
        enabled: true,
      });
    } finally { cleanup(); }
  });

  it("listEmailRecipients({enabledOnly: true}) filters disabled rows", () => {
    const { db, cleanup } = makeTempDb();
    try {
      db.createEmailRecipient({ address: "a@x.com", minSeverity: "low", allowedSources: ["webhook"], enabled: true });
      db.createEmailRecipient({ address: "b@x.com", minSeverity: "low", allowedSources: ["webhook"], enabled: false });
      const rows = db.listEmailRecipients({ enabledOnly: true });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.address).toBe("a@x.com");
    } finally { cleanup(); }
  });

  it("updateEmailRecipient changes fields and bumps updated_at", async () => {
    const { db, cleanup } = makeTempDb();
    try {
      const r = db.createEmailRecipient({ address: "a@x.com", minSeverity: "low", allowedSources: ["webhook"], enabled: true });
      const before = r.updatedAt;
      await new Promise((res) => setTimeout(res, 10));
      const updated = db.updateEmailRecipient(r.id, { minSeverity: "critical", enabled: false });
      expect(updated?.minSeverity).toBe("critical");
      expect(updated?.enabled).toBe(false);
      expect(updated?.updatedAt).not.toBe(before);
    } finally { cleanup(); }
  });

  it("deleteEmailRecipient removes the row", () => {
    const { db, cleanup } = makeTempDb();
    try {
      const r = db.createEmailRecipient({ address: "a@x.com", minSeverity: "low", allowedSources: ["webhook"], enabled: true });
      db.deleteEmailRecipient(r.id);
      expect(db.getEmailRecipient(r.id)).toBeUndefined();
    } finally { cleanup(); }
  });

  it("allowedSources is persisted as JSON and parsed back", () => {
    const { db, cleanup } = makeTempDb();
    try {
      const r = db.createEmailRecipient({
        address: "a@x.com",
        minSeverity: "low",
        allowedSources: ["webhook", "scan", "poller", "manual"],
        enabled: true,
      });
      const got = db.getEmailRecipient(r.id);
      expect(got?.allowedSources).toEqual(["webhook", "scan", "poller", "manual"]);
    } finally { cleanup(); }
  });
});

describe("Database — email_recipients stack scope", () => {
  it("createEmailRecipient defaults to global (stack_id NULL) when scope omitted", () => {
    const { db, cleanup } = makeTempDb();
    try {
      const r = db.createEmailRecipient({
        address: "a@x", minSeverity: "high", allowedSources: ["scan"], enabled: true,
      });
      expect(r.stackId).toBeNull();
      expect(r.scope).toBe("global");
    } finally { cleanup(); }
  });

  it("createEmailRecipient with stackId pins to that stack", () => {
    const { db, cleanup } = makeTempDb();
    try {
      const r = db.createEmailRecipient({
        address: "p@x", minSeverity: "high", allowedSources: ["scan"], enabled: true,
        stackId: "stk-prod",
      });
      expect(r.stackId).toBe("stk-prod");
      expect(r.scope).toBe("stack");
    } finally { cleanup(); }
  });

  it("listEmailRecipientsForStack returns globals + own pinned, excludes other stacks", () => {
    const { db, cleanup } = makeTempDb();
    try {
      db.createEmailRecipient({ address: "g@x", minSeverity: "high", allowedSources: ["scan"], enabled: true });
      db.createEmailRecipient({ address: "p@x", minSeverity: "high", allowedSources: ["scan"], enabled: true, stackId: "stk-prod" });
      db.createEmailRecipient({ address: "s@x", minSeverity: "high", allowedSources: ["scan"], enabled: true, stackId: "stk-staging" });
      const got = db.listEmailRecipientsForStack("stk-prod");
      const addresses = got.map((r) => r.address).sort();
      expect(addresses).toEqual(["g@x", "p@x"]);
    } finally { cleanup(); }
  });

  it("updateEmailRecipient can re-scope (clear or set stack_id)", () => {
    const { db, cleanup } = makeTempDb();
    try {
      const r = db.createEmailRecipient({ address: "a@x", minSeverity: "high", allowedSources: ["scan"], enabled: true });
      db.updateEmailRecipient(r.id, { stackId: "stk-prod" });
      expect(db.getEmailRecipient(r.id)!.stackId).toBe("stk-prod");
      db.updateEmailRecipient(r.id, { stackId: null });
      expect(db.getEmailRecipient(r.id)!.stackId).toBeNull();
    } finally { cleanup(); }
  });
});
