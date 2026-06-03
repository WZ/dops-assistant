import { describe, it, expect } from "vitest";
import { traceEntryToStreamEvent, assembleCausalChain, traceSummary } from "./orchestrator-stream.js";
import type { TraceEntry } from "./orchestrator.js";
import type { NormalizedObservation } from "../workflows/steps/corroboration.js";

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

  it("assembles a causal chain: incident → followed deps → root cause", () => {
    const trace: TraceEntry[] = [
      { move: "hypothesize", detail: "local OOM" },
      { move: "test", detail: "local OOM", verdict: "absent" },
      { move: "follow-cause", detail: "impala-catalog → +1 findings" },
      { move: "hypothesize", detail: "catalog pool starvation" },
      { move: "test", detail: "catalog pool starvation", verdict: "satisfied" },
    ];
    const chain = assembleCausalChain(trace, { hypothesis: "catalog pool starvation", prediction: {} }, "impala");
    expect(chain).toEqual([
      { label: "impala", kind: "incident" },
      { label: "impala-catalog", kind: "followed", evidence: undefined },
      { label: "root cause: catalog pool starvation", kind: "root-cause", evidence: undefined },
    ]);
  });

  it("attributes each link to its supporting finding/prediction (source attribution)", () => {
    const trace: TraceEntry[] = [
      { move: "follow-cause", detail: "impala-catalog → +1 findings" },
      { move: "hypothesize", detail: "catalog pool starvation" },
      { move: "test", detail: "catalog pool starvation", verdict: "satisfied" },
    ];
    const evidence: NormalizedObservation[] = [
      { phase: "infra", subject: "impala-catalog", text: "subagent: connection pool saturated — clients blocked" },
    ];
    const chain = assembleCausalChain(
      trace,
      { hypothesis: "catalog pool starvation", prediction: { kind: "metric-threshold", metric: "pool_used", op: ">", value: 95 } },
      "impala",
      evidence,
    );
    expect(chain[1]).toEqual({
      label: "impala-catalog",
      kind: "followed",
      evidence: "connection pool saturated — clients blocked",
    });
    expect(chain[2]).toEqual({
      label: "root cause: catalog pool starvation",
      kind: "root-cause",
      evidence: "confirmed by pool_used > 95",
    });
  });

  it("dedupes a service followed more than once into a single chain link", () => {
    const trace: TraceEntry[] = [
      { move: "follow-cause", detail: "statestore → +1 findings" },
      { move: "follow-cause", detail: "catalog → +1 findings" },
      { move: "follow-cause", detail: "statestore → +1 findings" }, // re-followed
    ];
    const chain = assembleCausalChain(trace, undefined, "impala");
    expect(chain.map((l) => l.label)).toEqual(["impala", "statestore", "catalog"]);
  });

  it("causal chain is just the incident when nothing was followed or confirmed", () => {
    const chain = assembleCausalChain([{ move: "test", detail: "x", verdict: "absent" }], undefined, "impala");
    expect(chain).toEqual([{ label: "impala", kind: "incident" }]);
  });

  it("traceSummary reads as a one-line run trace", () => {
    expect(traceSummary({ moves: 12, toolCalls: 5, tokensSpent: 0, strikes: 0, depth: 1, subagents: 2, elapsedMs: 0 }, "confirmed"))
      .toBe("12 moves · 5 queries · 2 subagents · confirmed at depth 1");
    expect(traceSummary({ moves: 1, toolCalls: 1, tokensSpent: 0, strikes: 0, depth: 0, subagents: 0, elapsedMs: 0 }, "operator-pause"))
      .toBe("1 move · 1 query · operator-pause at depth 0");
  });

  it("maps subagent + follow-cause completions to done rows", () => {
    expect(traceEntryToStreamEvent({ move: "spawn-subagent", detail: "payments: why slow? → +2 findings" })).toMatchObject({
      verb: "spun up a subagent",
      status: "done",
      indent: 1,
    });
    expect(traceEntryToStreamEvent({ move: "follow-cause", detail: "payments → +1 findings" })).toMatchObject({
      verb: "followed the trail to",
      status: "done",
    });
  });
});
