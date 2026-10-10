import { describe, it, expect } from "vitest";
import { createSynthesisAgent, SYNTHESIS_MAX_OUTPUT_TOKENS } from "./synthesis.js";

describe("createSynthesisAgent", () => {
  it("raises the output budget above the 4096 model default so reasoning cannot crowd out the JSON", async () => {
    const agent = createSynthesisAgent({ model: {} as any });
    const opts = await agent.getDefaultOptions();
    expect(SYNTHESIS_MAX_OUTPUT_TOKENS).toBeGreaterThan(4096);
    expect(opts.modelSettings?.maxOutputTokens).toBe(SYNTHESIS_MAX_OUTPUT_TOKENS);
    expect(opts.modelSettings?.temperature).toBe(0);
  });
});
