import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Database } from "./db.js";
import { createScanRunStore } from "./scan-run-store.js";

describe("ScanRunTracker", () => {
  let db: Database;
  beforeEach(() => { db = new Database(":memory:"); });
  afterEach(() => { db.close(); });

  it("begin() inserts a row with status='running' and emits scan:started", () => {
    const emit = vi.fn();
    const store = createScanRunStore({ db, emit });
    const t = store.begin({ stackId: "s1", trigger: "manual" });
    const row = db.getScanRun("s1", t.id)!;
    expect(row.status).toBe("running");
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: "scan:started", runId: t.id, stackId: "s1", trigger: "manual",
    }));
  });

  it("recordProbeComplete persists stats + emits scan:probe_complete", () => {
    const emit = vi.fn();
    const t = createScanRunStore({ db, emit }).begin({ stackId: "s1", trigger: "cron" });
    t.recordProbeComplete({
      servicesProbed: 10, rulesApplied: 2, queriesExecuted: 20, probeErrors: 1,
      durationMs: 500, detail: { errors: [{ service: "a", rule: "r", err: "boom" }] },
    });
    const row = db.getScanRun("s1", t.id)!;
    expect(row.servicesProbed).toBe(10);
    expect(row.probeErrors).toBe(1);
    expect(JSON.parse(row.probeDetailJson!)).toEqual({ errors: [{ service: "a", rule: "r", err: "boom" }] });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "scan:probe_complete" }));
  });

  it("finalize('complete') sets status + finished_at + emits scan:complete", () => {
    const emit = vi.fn();
    const t = createScanRunStore({ db, emit }).begin({ stackId: "s1", trigger: "cron" });
    t.finalize("complete");
    const row = db.getScanRun("s1", t.id)!;
    expect(row.status).toBe("complete");
    expect(row.finishedAt).toBeGreaterThan(0);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "scan:complete" }));
  });

  it("skip() persists reason + emits scan:skipped", () => {
    const emit = vi.fn();
    const t = createScanRunStore({ db, emit }).begin({ stackId: "s1", trigger: "cron" });
    t.skip("no_provider");
    const row = db.getScanRun("s1", t.id)!;
    expect(row.status).toBe("skipped");
    expect(row.skipReason).toBe("no_provider");
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "scan:skipped", reason: "no_provider" }));
  });

  it("fail() persists error_message + emits scan:failed", () => {
    const emit = vi.fn();
    const t = createScanRunStore({ db, emit }).begin({ stackId: "s1", trigger: "cron" });
    t.fail(new Error("boom"));
    const row = db.getScanRun("s1", t.id)!;
    expect(row.status).toBe("failed");
    expect(row.errorMessage).toContain("boom");
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "scan:failed" }));
  });

  it("second finalize is a no-op (logged, not thrown)", () => {
    const emit = vi.fn();
    const t = createScanRunStore({ db, emit }).begin({ stackId: "s1", trigger: "cron" });
    t.finalize("complete");
    const callsAfterFirst = emit.mock.calls.length;
    t.finalize("complete");
    expect(emit.mock.calls.length).toBe(callsAfterFirst);
  });

  it("emit callback is optional (cron ticks with no WS connection)", () => {
    const store = createScanRunStore({ db });
    const t = store.begin({ stackId: "s1", trigger: "cron" });
    expect(() => t.finalize("complete")).not.toThrow();
    expect(db.getScanRun("s1", t.id)!.status).toBe("complete");
  });

  it("linkInvestigation writes to scan_run_investigations + emits scan:investigation_dispatched", () => {
    const emit = vi.fn();
    const t = createScanRunStore({ db, emit }).begin({ stackId: "s1", trigger: "manual" });
    t.linkInvestigation("inv1", { service: "api", ruleName: "availability", value: 0, severity: 0.5 });
    expect(db.getScanRunInvestigations(t.id)).toHaveLength(1);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: "scan:investigation_dispatched", investigationId: "inv1",
    }));
  });

  it("onComplete hook fires once with final summary", () => {
    const onComplete = vi.fn();
    const store = createScanRunStore({ db, onComplete });
    const t = store.begin({ stackId: "s1", trigger: "manual" });
    t.recordProbeComplete({ servicesProbed: 50, rulesApplied: 2, queriesExecuted: 100, probeErrors: 0, durationMs: 100 });
    t.linkInvestigation("inv1", { service: "api", ruleName: "r", value: 0, severity: 0.5 });
    t.finalize("complete");
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete.mock.calls[0]![0]).toMatchObject({
      runId: t.id, stackId: "s1", trigger: "manual",
      servicesProbed: 50, hitsDispatched: 1, dispatchedServices: ["api"],
    });
  });

  it("onComplete does NOT fire on skip/fail", () => {
    const onComplete = vi.fn();
    const store = createScanRunStore({ db, onComplete });
    const t = store.begin({ stackId: "s1", trigger: "cron" });
    t.skip("no_provider");
    expect(onComplete).not.toHaveBeenCalled();
  });
});
