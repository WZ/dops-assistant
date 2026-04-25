import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "./db.js";
import { startEventsRetentionTask } from "./events-retention.js";

const S = "stack-a";

describe("startEventsRetentionTask", () => {
  let db: Database;

  beforeEach(() => { db = new Database(":memory:"); });
  afterEach(() => db.close());

  it("sweep() removes rows older than retentionDays", () => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    db.insertEvent({ id: "old", ts: now - 60 * dayMs, kind: "k", severity: "info", summary: "old", stackId: S });
    db.insertEvent({ id: "fresh", ts: now - 1 * dayMs, kind: "k", severity: "info", summary: "fresh", stackId: S });

    const task = startEventsRetentionTask({ db, retentionDays: 30 });
    const removed = task.sweep();
    task.stop();

    expect(removed).toBe(1);
    expect(db.countEvents({ stackId: S })).toBe(1);
    expect(db.listEvents({ stackId: S }).map((r) => r.id)).toEqual(["fresh"]);
  });

  it("retentionDays=0 disables the sweep (escape hatch for archival pipelines)", () => {
    db.insertEvent({ id: "ancient", ts: 0, kind: "k", severity: "info", summary: "x", stackId: S });
    const task = startEventsRetentionTask({ db, retentionDays: 0 });
    const removed = task.sweep();
    task.stop();
    expect(removed).toBe(0);
    expect(db.countEvents({ stackId: S })).toBe(1);
  });

  it("returns 0 when nothing is expired", () => {
    db.insertEvent({ id: "fresh", ts: Date.now(), kind: "k", severity: "info", summary: "x", stackId: S });
    const task = startEventsRetentionTask({ db, retentionDays: 30 });
    expect(task.sweep()).toBe(0);
    task.stop();
  });

  it("stop() is idempotent", () => {
    const task = startEventsRetentionTask({ db, retentionDays: 30 });
    task.stop();
    task.stop();
  });
});
