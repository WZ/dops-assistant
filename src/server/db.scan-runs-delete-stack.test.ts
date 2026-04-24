import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "./db.js";

describe("deleteStack — scan_runs cleanup", () => {
  let db: Database;
  beforeEach(() => { db = new Database(":memory:"); });
  afterEach(() => { db.close(); });

  it("removes scan_runs and scan_run_investigations when a stack is deleted", () => {
    db.createStack({ id: "s1", name: "Stack 1", slug: "stack-1", config: "{}" });

    // Direct insert via prepared statements — the CRUD for scan_runs arrives in Task 2, so for now
    // we write via this.db.prepare() or use a raw exec to seed.
    const now = Date.now();
    (db as unknown as { db: import("better-sqlite3").Database }).db
      .prepare("INSERT INTO scan_runs (id, stack_id, trigger, status, started_at) VALUES (?, ?, 'cron', 'complete', ?)")
      .run("r1", "s1", now);
    (db as unknown as { db: import("better-sqlite3").Database }).db
      .prepare("INSERT INTO scan_run_investigations (scan_run_id, investigation_id, service, rule_name, value, severity, dispatched_at) VALUES (?, ?, 'svc', 'rule', 0, 0.5, ?)")
      .run("r1", "inv1", now);

    db.deleteStack("s1");

    const runs = (db as unknown as { db: import("better-sqlite3").Database }).db
      .prepare("SELECT * FROM scan_runs WHERE stack_id = ?").all("s1");
    const links = (db as unknown as { db: import("better-sqlite3").Database }).db
      .prepare("SELECT * FROM scan_run_investigations WHERE scan_run_id = ?").all("r1");
    expect(runs).toEqual([]);
    expect(links).toEqual([]);
  });
});
