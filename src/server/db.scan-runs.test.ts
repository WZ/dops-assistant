import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "./db.js";

describe("scan_runs CRUD", () => {
  let db: Database;
  beforeEach(() => { db = new Database(":memory:"); });
  afterEach(() => { db.close(); });

  it("insertScanRun creates a row and getScanRun retrieves it", () => {
    const now = Date.now();
    db.insertScanRun({ id: "r1", stackId: "s1", trigger: "manual", startedAt: now });
    const row = db.getScanRun("s1", "r1");
    expect(row).toMatchObject({ id: "r1", stackId: "s1", trigger: "manual", status: "running", startedAt: now });
  });

  it("getScanRun returns null when stack_id does not match (cross-stack isolation)", () => {
    db.insertScanRun({ id: "r1", stackId: "s1", trigger: "manual", startedAt: Date.now() });
    expect(db.getScanRun("s2", "r1")).toBeNull();
  });

  it("updateScanRun applies probe stats + status change", () => {
    db.insertScanRun({ id: "r1", stackId: "s1", trigger: "cron", startedAt: Date.now() });
    db.updateScanRun("r1", {
      servicesProbed: 117, rulesApplied: 4, queriesExecuted: 468, probeErrors: 4,
      probeDurationMs: 2300, probeDetailJson: JSON.stringify({ errors: [] }),
    });
    const row = db.getScanRun("s1", "r1")!;
    expect(row.servicesProbed).toBe(117);
    expect(row.probeErrors).toBe(4);
  });

  it("listScanRuns returns newest first, filtered by stack", () => {
    const now = Date.now();
    db.insertScanRun({ id: "a", stackId: "s1", trigger: "cron", startedAt: now - 2000 });
    db.insertScanRun({ id: "b", stackId: "s1", trigger: "cron", startedAt: now });
    db.insertScanRun({ id: "c", stackId: "s2", trigger: "cron", startedAt: now });
    const rows = db.listScanRuns({ stackId: "s1", limit: 10 });
    expect(rows.map(r => r.id)).toEqual(["b", "a"]);
  });

  it("listScanRuns cursor: ?before filters out rows at or after", () => {
    const now = Date.now();
    db.insertScanRun({ id: "a", stackId: "s1", trigger: "cron", startedAt: now - 2000 });
    db.insertScanRun({ id: "b", stackId: "s1", trigger: "cron", startedAt: now });
    const rows = db.listScanRuns({ stackId: "s1", limit: 10, before: now });
    expect(rows.map(r => r.id)).toEqual(["a"]);
  });

  it("linkScanRunInvestigation persists and getScanRunInvestigations returns them", () => {
    db.insertScanRun({ id: "r1", stackId: "s1", trigger: "manual", startedAt: Date.now() });
    db.linkScanRunInvestigation("r1", "inv1", {
      service: "api", ruleName: "availability", value: 0.5, severity: 0.5, dispatchedAt: Date.now(),
    });
    const links = db.getScanRunInvestigations("r1");
    expect(links).toHaveLength(1);
    expect(links[0]!.investigationId).toBe("inv1");
  });
});

describe("reapScanRuns", () => {
  let db: Database;
  beforeEach(() => { db = new Database(":memory:"); });
  afterEach(() => { db.close(); });

  it("keeps last 200 rows per stack regardless of age", () => {
    const stacks = ["s1", "s2"];
    const base = Date.now() - 60 * 24 * 60 * 60 * 1000;
    for (const stackId of stacks) {
      for (let i = 0; i < 250; i++) {
        db.insertScanRun({ id: `${stackId}-${i}`, stackId, trigger: "cron", startedAt: base + i * 1000 });
        db.updateScanRun(`${stackId}-${i}`, { status: "complete", finishedAt: base + i * 1000 + 5 });
      }
    }
    db.reapScanRuns({ keepLast: 200, maxAgeMs: 30 * 24 * 60 * 60 * 1000 });
    const s1rows = db.listScanRuns({ stackId: "s1", limit: 500 });
    const s2rows = db.listScanRuns({ stackId: "s2", limit: 500 });
    expect(s1rows).toHaveLength(200);
    expect(s2rows).toHaveLength(200);
  });

  it("pins runs with hits_dispatched>0 even past age cutoff", () => {
    const base = Date.now() - 60 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 10; i++) {
      db.insertScanRun({ id: `r-${i}`, stackId: "s1", trigger: "cron", startedAt: base + i });
      db.updateScanRun(`r-${i}`, { status: "complete", finishedAt: base + i, hitsDispatched: i === 0 ? 3 : 0 });
    }
    db.reapScanRuns({ keepLast: 5, maxAgeMs: 1 });
    expect(db.getScanRun("s1", "r-0")).not.toBeNull();
  });

  it("cascade deletes scan_run_investigations when reaping", () => {
    const base = Date.now() - 60 * 24 * 60 * 60 * 1000;
    db.insertScanRun({ id: "r1", stackId: "s1", trigger: "cron", startedAt: base });
    db.updateScanRun("r1", { status: "complete", finishedAt: base });
    db.linkScanRunInvestigation("r1", "inv1", {
      service: "api", ruleName: "availability", value: 0, severity: 0.5, dispatchedAt: base,
    });
    db.reapScanRuns({ keepLast: 0, maxAgeMs: 1 });
    expect(db.getScanRun("s1", "r1")).toBeNull();
    expect(db.getScanRunInvestigations("r1")).toEqual([]);
  });
});
