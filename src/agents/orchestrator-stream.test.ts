import { describe, it, expect } from "vitest";
import { traceEntryToStreamEvent } from "./orchestrator-stream.js";

describe("traceEntryToStreamEvent", () => {
  it("maps hypothesize → a running 'proposed a cause' row", () => {
    expect(traceEntryToStreamEvent({ move: "hypothesize", detail: "memory exhaustion" })).toEqual({
      verb: "proposed a cause:",
      target: "memory exhaustion",
      status: "running",
    });
  });

  it("maps query → a done 'gathered evidence' row", () => {
    const ev = traceEntryToStreamEvent({ move: "query", detail: "memory exhaustion → +3 observations" });
    expect(ev.verb).toBe("gathered evidence");
    expect(ev.status).toBe("done");
    expect(ev.detail).toContain("+3 observations");
  });

  it("maps a satisfied test → strong 'evidence backs'", () => {
    expect(traceEntryToStreamEvent({ move: "test", detail: "memory exhaustion", verdict: "satisfied" })).toEqual({
      verb: "evidence backs",
      target: "memory exhaustion",
      status: "strong",
    });
  });

  it("maps a failed test → rejected 'ruled out' with a plain reason", () => {
    const absent = traceEntryToStreamEvent({ move: "test", detail: "disk pressure", verdict: "absent" });
    expect(absent.verb).toBe("ruled out");
    expect(absent.status).toBe("rejected");
    expect(absent.detail).toContain("no supporting evidence");

    const contradicted = traceEntryToStreamEvent({ move: "test", detail: "leak", verdict: "contradicted" });
    expect(contradicted.detail).toContain("contradicts");
  });

  it("maps an accepted conclude → strong 'root cause'", () => {
    expect(traceEntryToStreamEvent({ move: "conclude", detail: "confirmed: memory exhaustion" })).toEqual({
      verb: "root cause:",
      target: "memory exhaustion",
      status: "strong",
    });
  });

  it("maps a rejected conclude → running 'kept looking'", () => {
    const ev = traceEntryToStreamEvent({
      move: "conclude",
      detail: "rejected — self-confidence 0.9 not backed by the keystone; continuing",
    });
    expect(ev.verb).toBe("not confirmed yet — kept looking");
    expect(ev.status).toBe("running");
  });

  it("maps deferred moves to indented/running rows", () => {
    expect(traceEntryToStreamEvent({ move: "spawn-subagent", detail: "payments: why slow? — deferred (v1)" })).toMatchObject({
      verb: "spun up a subagent",
      status: "running",
      indent: 1,
    });
    expect(traceEntryToStreamEvent({ move: "follow-cause", detail: "payments — deferred (v1)" })).toMatchObject({
      verb: "followed the trail",
      status: "running",
    });
  });
});
