// src/server/event-log.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { EventLog } from "./event-log.js";
import { Database } from "./db.js";

describe("EventLog", () => {
  let log: EventLog;
  beforeEach(() => { log = new EventLog({ capacity: 3 }); });

  it("returns empty on fresh log", () => {
    expect(log.recent()).toEqual({ events: [], truncated: false });
  });

  it("returns events newest first", () => {
    log.append({ kind: "alert_received", severity: "warn", summary: "a" });
    log.append({ kind: "alert_received", severity: "warn", summary: "b" });
    const out = log.recent();
    expect(out.events.map(e => e.summary)).toEqual(["b", "a"]);
  });

  it("drops oldest past capacity and reports truncated", () => {
    log.append({ kind: "alert_received", severity: "warn", summary: "a" });
    log.append({ kind: "alert_received", severity: "warn", summary: "b" });
    log.append({ kind: "alert_received", severity: "warn", summary: "c" });
    log.append({ kind: "alert_received", severity: "warn", summary: "d" });
    const out = log.recent();
    expect(out.events.map(e => e.summary)).toEqual(["d", "c", "b"]);
    expect(out.truncated).toBe(true);
  });

  it("caps summary at 80 chars", () => {
    const long = "x".repeat(200);
    log.append({ kind: "alert_received", severity: "warn", summary: long });
    expect(log.recent().events[0].summary.length).toBe(80);
  });

  it("filters by stackId but includes stack-less (global) events", () => {
    log.append({ kind: "investigation_started", severity: "info", summary: "a", stackId: "stack-a" });
    log.append({ kind: "investigation_started", severity: "info", summary: "b", stackId: "stack-b" });
    log.append({ kind: "provider_health_changed", severity: "error", summary: "global" });
    const scoped = log.recent(10, "stack-a");
    expect(scoped.events.map((e) => e.summary)).toEqual(["global", "a"]);
    const all = log.recent(10);
    expect(all.events.map((e) => e.summary)).toEqual(["global", "b", "a"]);
  });

  it("bindDatabase persists every append to the events table", () => {
    const db = new Database(":memory:");
    try {
      log.bindDatabase(db);
      log.append({
        kind: "investigation_started",
        severity: "info",
        summary: "ring + DB write",
        stackId: "stack-a",
        service: "payments-api",
        href: "/investigations/inv_xyz",
        meta: { duration_ms: 1234 },
      });
      const persisted = db.listEvents({ stackId: "stack-a" });
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.summary).toBe("ring + DB write");
      expect(persisted[0]?.kind).toBe("investigation_started");
      expect(persisted[0]?.service).toBe("payments-api");
      expect(persisted[0]?.href).toBe("/investigations/inv_xyz");
      expect(persisted[0]?.meta).toEqual({ duration_ms: 1234 });
    } finally {
      db.close();
    }
  });

  it("works without a DB binding (in-memory only — used by tests + early boot)", () => {
    log.append({ kind: "alert_received", severity: "warn", summary: "no-db" });
    expect(log.recent().events).toHaveLength(1);
  });

  it("DB write failures are swallowed — ring still works", () => {
    // Stub a "broken" DB whose insertEvent throws. The ring must continue
    // serving from memory regardless. This exercises the catch block in
    // EventLog.append().
    const brokenDb = {
      insertEvent: () => { throw new Error("disk full"); },
    } as unknown as Database;
    log.bindDatabase(brokenDb);
    log.append({ kind: "alert_received", severity: "warn", summary: "still here" });
    expect(log.recent().events.map((e) => e.summary)).toEqual(["still here"]);
  });
});
