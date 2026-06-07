import { describe, it, expect, vi } from "vitest";
import { OrchestratorRunRegistry } from "./orchestrator-run-registry.js";
import type { ServerMessage } from "../types/ws-types.js";

const ID = "inv_reg_1";
const ev = (seq: number): ServerMessage => ({ type: "orchestrator:step", investigationId: ID, event: { seq, verb: "x", status: "running" } });

function freshRun(reg: OrchestratorRunRegistry, id = ID): AbortController {
  const ac = new AbortController();
  reg.create(id, ac);
  return ac;
}

describe("OrchestratorRunRegistry — lifecycle", () => {
  it("create registers a live run; duplicate create keeps the first entry", () => {
    const reg = new OrchestratorRunRegistry();
    const ac1 = freshRun(reg);
    expect(reg.has(ID)).toBe(true);
    expect(reg.isLive(ID)).toBe(true);
    expect(reg.status(ID)).toBe("running");
    expect(reg.abortControllerFor(ID)).toBe(ac1);
    // duplicate create is a no-op (keeps ac1)
    reg.create(ID, new AbortController());
    expect(reg.abortControllerFor(ID)).toBe(ac1);
  });

  it("abort() aborts the controller and resolves a pending pause so a blocked loop unblocks", () => {
    const reg = new OrchestratorRunRegistry();
    const ac = freshRun(reg);
    const resolve = vi.fn();
    reg.setPause(ID, { resolve, timer: null, kind: "operator" });
    reg.abort(ID, "stopped");
    expect(ac.signal.aborted).toBe(true);
    expect(resolve).toHaveBeenCalledWith("continue"); // unblock then hit the abort guard
    expect(reg.hasPause(ID)).toBe(false);
  });

  it("create REPLACES a terminal entry (relaunch during GC grace) but never a live one", () => {
    const reg = new OrchestratorRunRegistry();
    const ac1 = freshRun(reg);
    reg.markTerminal(ID, 1000);
    // relaunch while the terminal entry is still in its grace window → fresh live
    // entry tracking the NEW abort (so Stop/subscribe/park act on the new run)
    const ac2 = new AbortController();
    reg.create(ID, ac2);
    expect(reg.status(ID)).toBe("running");
    expect(reg.abortControllerFor(ID)).toBe(ac2);
    expect(reg.sinkCount(ID)).toBe(0); // fresh
    // a LIVE entry is still never clobbered by a duplicate create
    reg.create(ID, new AbortController());
    expect(reg.abortControllerFor(ID)).toBe(ac2);
    void ac1;
  });

  it("markTerminal flips status and clears pause; delete removes the entry", () => {
    const reg = new OrchestratorRunRegistry();
    freshRun(reg);
    reg.setPause(ID, { resolve: vi.fn(), timer: null, kind: "operator" });
    reg.markTerminal(ID, 1000);
    expect(reg.status(ID)).toBe("terminal");
    expect(reg.isLive(ID)).toBe(false);
    expect(reg.hasPause(ID)).toBe(false);
    reg.delete(ID);
    expect(reg.has(ID)).toBe(false);
  });
});

describe("OrchestratorRunRegistry — sinks / broadcast (multi-tab)", () => {
  it("fans a message out to every attached sink", () => {
    const reg = new OrchestratorRunRegistry();
    freshRun(reg);
    const a = vi.fn(); const b = vi.fn();
    reg.attachSink(ID, a); reg.attachSink(ID, b);
    expect(reg.sinkCount(ID)).toBe(2);
    reg.broadcast(ID, ev(0));
    expect(a).toHaveBeenCalledWith(ev(0));
    expect(b).toHaveBeenCalledWith(ev(0));
  });

  it("broadcast with no sinks is a silent no-op (persist-only upstream)", () => {
    const reg = new OrchestratorRunRegistry();
    freshRun(reg);
    expect(() => reg.broadcast(ID, ev(0))).not.toThrow();
  });

  it("a sink that throws is dropped; the others still receive and the run is unaffected", () => {
    const reg = new OrchestratorRunRegistry();
    freshRun(reg);
    const bad = vi.fn(() => { throw new Error("half-open socket"); });
    const good = vi.fn();
    reg.attachSink(ID, bad); reg.attachSink(ID, good);
    reg.broadcast(ID, ev(0));
    expect(good).toHaveBeenCalledWith(ev(0));
    expect(reg.sinkCount(ID)).toBe(1); // bad dropped
    // a second broadcast only reaches the good sink
    reg.broadcast(ID, ev(1));
    expect(good).toHaveBeenCalledTimes(2);
    expect(bad).toHaveBeenCalledTimes(1);
  });

  it("detachSink stamps empty-time only when the LAST sink leaves", () => {
    const reg = new OrchestratorRunRegistry();
    freshRun(reg);
    const a = vi.fn(); const b = vi.fn();
    reg.attachSink(ID, a); reg.attachSink(ID, b);
    reg.detachSink(ID, a, 1000);
    expect(reg.sinkCount(ID)).toBe(1);
    // still one attached → not park-eligible yet
    expect(reg.sweep(1000 + 10 * 60_000).parked).not.toContain(ID);
    reg.detachSink(ID, b, 2000);
    expect(reg.sinkCount(ID)).toBe(0);
    expect(reg.sweep(2000 + 10 * 60_000).parked).toContain(ID);
  });

  it("attachSink clears the empty-timer and a pending park request (a viewer is back)", () => {
    const reg = new OrchestratorRunRegistry();
    freshRun(reg);
    const a = vi.fn();
    reg.attachSink(ID, a);
    reg.detachSink(ID, a, 1000);
    reg.requestPark(ID);
    reg.attachSink(ID, vi.fn());
    expect(reg.consumeParkRequest(ID)).toBe(false); // park request cleared on reattach
  });
});

describe("OrchestratorRunRegistry — pause / decision-lock (cross-tab)", () => {
  it("resolvePause fires the resolver, clears its timer, and empties the slot", () => {
    const reg = new OrchestratorRunRegistry();
    freshRun(reg);
    const resolve = vi.fn();
    const timer = setTimeout(() => {}, 10_000);
    reg.setPause(ID, { resolve, timer, kind: "operator" });
    reg.resolvePause(ID, "escalate");
    expect(resolve).toHaveBeenCalledWith("escalate");
    expect(reg.hasPause(ID)).toBe(false);
  });

  it("tryLockDecision: first caller wins, second is rejected until unlock", () => {
    const reg = new OrchestratorRunRegistry();
    freshRun(reg);
    expect(reg.tryLockDecision(ID)).toBe(true);
    expect(reg.tryLockDecision(ID)).toBe(false); // a second tab can't double-submit
    reg.unlockDecision(ID);
    expect(reg.tryLockDecision(ID)).toBe(true); // resumes → lock reopens
  });

  it("setPause re-opens the decision lock (a fresh pause is actionable again)", () => {
    const reg = new OrchestratorRunRegistry();
    freshRun(reg);
    expect(reg.tryLockDecision(ID)).toBe(true);
    expect(reg.tryLockDecision(ID)).toBe(false); // locked
    reg.setPause(ID, { resolve: vi.fn(), timer: null, kind: "operator" });
    expect(reg.tryLockDecision(ID)).toBe(true); // new pause → lock reopened
  });
});

describe("OrchestratorRunRegistry — park lifecycle", () => {
  it("requestPark only flags a running run; consume returns true once", () => {
    const reg = new OrchestratorRunRegistry();
    freshRun(reg);
    reg.requestPark(ID);
    expect(reg.consumeParkRequest(ID)).toBe(true);
    expect(reg.consumeParkRequest(ID)).toBe(false); // consumed
  });

  it("markParked / markRunning transition status; requestPark ignores a parked run", () => {
    const reg = new OrchestratorRunRegistry();
    freshRun(reg);
    reg.markParked(ID);
    expect(reg.status(ID)).toBe("parked");
    reg.requestPark(ID); // not running → ignored
    expect(reg.consumeParkRequest(ID)).toBe(false);
    reg.markRunning(ID);
    expect(reg.status(ID)).toBe("running");
  });
});

describe("OrchestratorRunRegistry — watchdog sweep", () => {
  it("parks a running run with no sinks past the idle threshold (once)", () => {
    const reg = new OrchestratorRunRegistry();
    const a = vi.fn();
    freshRun(reg);
    reg.attachSink(ID, a);
    reg.detachSink(ID, a, 1_000);
    // not yet past idle
    expect(reg.sweep(1_000 + 60_000, 120_000).parked).toEqual([]);
    // past idle → parked flagged
    expect(reg.sweep(1_000 + 130_000, 120_000).parked).toEqual([ID]);
    // already flagged → not parked again
    expect(reg.sweep(1_000 + 200_000, 120_000).parked).toEqual([]);
  });

  it("does NOT park a run that still has a sink attached", () => {
    const reg = new OrchestratorRunRegistry();
    freshRun(reg);
    reg.attachSink(ID, vi.fn());
    expect(reg.sweep(10 * 60_000, 120_000).parked).toEqual([]);
  });

  it("sweeps (deletes) a terminal run past the grace window", () => {
    const reg = new OrchestratorRunRegistry();
    freshRun(reg);
    reg.markTerminal(ID, 1_000);
    expect(reg.sweep(1_000 + 10_000, 120_000, 30_000).swept).toEqual([]); // within grace
    expect(reg.has(ID)).toBe(true);
    expect(reg.sweep(1_000 + 40_000, 120_000, 30_000).swept).toEqual([ID]); // past grace
    expect(reg.has(ID)).toBe(false);
  });

  it("isolates state per investigationId", () => {
    const reg = new OrchestratorRunRegistry();
    freshRun(reg, "a");
    freshRun(reg, "b");
    const sa = vi.fn();
    reg.attachSink("a", sa);
    reg.broadcast("a", ev(0));
    expect(sa).toHaveBeenCalledTimes(1);
    expect(reg.sinkCount("b")).toBe(0);
    expect(reg.size()).toBe(2);
  });
});
