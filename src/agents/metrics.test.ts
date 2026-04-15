import { describe, it, expect } from "vitest";
import { createMetricsAgent } from "./metrics.js";

// Minimal dummy model — satisfies the Agent constructor without making real
// LLM calls. These tests only inspect prompt text, never call generate().
const dummyModel = {
  specificationVersion: "v1",
  provider: "test",
  modelId: "dummy",
} as any;

describe("createMetricsAgent prompt", () => {
  // Fix #2 (plan-eng-review 2026-04-15): the metrics agent used to report
  // severity:high on flat-zero replica series (services that are intentionally
  // not deployed). The prompt was updated to explicitly carve out that case.
  // Runtime behavioral regression requires running rca-eval.ts against real
  // investigations — this unit test only verifies the prompt text is present.
  it("includes the INTENTIONALLY-DISABLED SERVICES guidance", async () => {
    const agent = createMetricsAgent({ model: dummyModel });
    const instructions = await agent.getInstructions();
    const text = typeof instructions === "string" ? instructions : JSON.stringify(instructions);
    expect(text).toContain("INTENTIONALLY-DISABLED SERVICES");
    expect(text).toContain("flat value of 0");
    expect(text).toContain("not deployed");
    expect(text).toContain("observations: []");
  });

  it("still tells the agent to query the full investigation window", async () => {
    const agent = createMetricsAgent({ model: dummyModel });
    const instructions = await agent.getInstructions();
    const text = typeof instructions === "string" ? instructions : JSON.stringify(instructions);
    expect(text).toContain("FULL investigation time window");
  });
});
