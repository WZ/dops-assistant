import { describe, it, expect } from "vitest";
import { parseMove, buildStatePrompt, createLlmDecideMove } from "./orchestrator-llm.js";
import type { OrchestratorState, OrchestratorGuards } from "./orchestrator.js";
import type { LanguageModel } from "ai";
import { LlmUnavailableError } from "./shared/llm-errors.js";

const guards: OrchestratorGuards = {
  maxTokens: 150_000,
  maxDepth: 3,
  maxStrikes: 3,
  maxToolCalls: 40,
  wallClockMs: 600_000,
};

const emptyState: OrchestratorState = {
  hypotheses: [],
  evidence: [],
  depth: 0,
  strikes: 0,
  tokensSpent: 0,
  toolCalls: 0,
  elapsedMs: 0,
  trace: [],
};

const stubModel = {} as unknown as LanguageModel;

describe("parseMove", () => {
  it("parses a hypothesize move with a valid prediction", () => {
    const m = parseMove('{"move":"hypothesize","hypothesis":"oom","prediction":{"kind":"infra-status","resource":"pod","status":"OOMKilled"}}');
    expect(m).toEqual({
      type: "hypothesize",
      hypothesis: { hypothesis: "oom", prediction: { kind: "infra-status", resource: "pod", status: "OOMKilled" } },
    });
  });

  it("parses query / test / spawn-subagent / follow-cause", () => {
    expect(parseMove('{"move":"query","target":2}')).toEqual({ type: "query", target: 2 });
    expect(parseMove('{"move":"test","target":0}')).toEqual({ type: "test", target: 0 });
    expect(parseMove('{"move":"spawn-subagent","service":"payments","question":"why slow?"}')).toEqual({
      type: "spawn-subagent",
      service: "payments",
      question: "why slow?",
    });
    expect(parseMove('{"move":"follow-cause","service":"db"}')).toEqual({ type: "follow-cause", service: "db" });
  });

  it("applies defaults for conclude confidence/rationale", () => {
    expect(parseMove('{"move":"conclude","leading":1}')).toEqual({
      type: "conclude",
      leading: 1,
      confidence: 0.5,
      rationale: "",
    });
  });

  it("treats an explicit done as null (exhausted)", () => {
    expect(parseMove('{"move":"done"}')).toBeNull();
  });

  it("extracts JSON from ```json fences and surrounding prose", () => {
    expect(parseMove('Here is my move:\n```json\n{"move":"query","target":0}\n```')).toEqual({ type: "query", target: 0 });
    expect(parseMove('I think we should query. {"move":"query","target":3} done.')).toEqual({ type: "query", target: 3 });
  });

  it("returns null for unparseable / schema-invalid output (graceful, no throw)", () => {
    expect(parseMove("not json at all")).toBeNull();
    expect(parseMove("{ broken json")).toBeNull();
    expect(parseMove('{"move":"hypothesize","hypothesis":"x"}')).toBeNull(); // missing prediction
    expect(parseMove('{"move":"hypothesize","hypothesis":"x","prediction":{"kind":"bogus"}}')).toBeNull(); // bad kind
    expect(parseMove('{"move":"frobnicate"}')).toBeNull(); // unknown move
    expect(parseMove('{"move":"query","target":-1}')).toBeNull(); // negative index
  });
});

describe("buildStatePrompt", () => {
  it("renders budget, hypotheses with verdicts, and evidence", () => {
    const state: OrchestratorState = {
      ...emptyState,
      tokensSpent: 5000,
      toolCalls: 3,
      strikes: 1,
      hypotheses: [
        { hypothesis: { hypothesis: "memory exhaustion", prediction: { kind: "metric-threshold", metric: "mem", op: ">", value: 90 } }, standing: "confirmed", lastVerdict: "satisfied" },
        { hypothesis: { hypothesis: "disk pressure", prediction: { kind: "infra-status", status: "DiskPressure" } }, standing: "ruled-out", lastVerdict: "absent" },
      ],
      evidence: [{ phase: "metrics", subject: "mem", value: 99 }],
    };
    const prompt = buildStatePrompt("checkout-api 5xx spike", state, guards);
    expect(prompt).toContain("checkout-api 5xx spike");
    expect(prompt).toContain("strikes 1/3");
    expect(prompt).toContain("[0] memory exhaustion — standing: confirmed, verdict: satisfied");
    expect(prompt).toContain("[1] disk pressure — standing: ruled-out, verdict: absent");
    expect(prompt).toContain("metrics mem = 99");
    // budget left = 150000 - 5000
    expect(prompt).toContain("145000");
  });

  it("guides the agent when there are no hypotheses yet", () => {
    const prompt = buildStatePrompt("incident", emptyState, guards);
    expect(prompt).toContain("(none — start by hypothesizing");
    expect(prompt).toContain("(none yet)");
  });
});

describe("createLlmDecideMove", () => {
  it("returns the parsed move from the model text (via injected callModel)", async () => {
    const decide = createLlmDecideMove({
      model: stubModel,
      focus: "incident",
      guards,
      callModel: async () => '{"move":"hypothesize","hypothesis":"oom","prediction":{"kind":"metric-threshold","metric":"mem","op":">","value":90}}',
    });
    const move = await decide(emptyState);
    expect(move).toEqual({
      type: "hypothesize",
      hypothesis: { hypothesis: "oom", prediction: { kind: "metric-threshold", metric: "mem", op: ">", value: 90 } },
    });
  });

  it("feeds the rendered state (focus + hypotheses) into the model prompt", async () => {
    let seenPrompt = "";
    const decide = createLlmDecideMove({
      model: stubModel,
      focus: "payments latency",
      guards,
      callModel: async (_system, prompt) => {
        seenPrompt = prompt;
        return '{"move":"done"}';
      },
    });
    await decide({
      ...emptyState,
      hypotheses: [{ hypothesis: { hypothesis: "pool starvation", prediction: { kind: "log-pattern", pattern: "timeout" } }, standing: "open" }],
    });
    expect(seenPrompt).toContain("payments latency");
    expect(seenPrompt).toContain("pool starvation");
  });

  it("propagates LlmUnavailableError so the runner can fail cleanly", async () => {
    const decide = createLlmDecideMove({
      model: stubModel,
      focus: "x",
      guards,
      callModel: async () => {
        throw new LlmUnavailableError("upstream down");
      },
    });
    await expect(decide(emptyState)).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it("degrades a non-LLM-unavailable error to null (one bad turn doesn't crash the loop)", async () => {
    const decide = createLlmDecideMove({
      model: stubModel,
      focus: "x",
      guards,
      callModel: async () => {
        throw new Error("transient parse weirdness");
      },
    });
    await expect(decide(emptyState)).resolves.toBeNull();
  });
});
