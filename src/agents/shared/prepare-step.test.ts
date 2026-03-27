import { describe, it, expect } from "vitest";
import { createQuirkPrepareStep } from "./prepare-step.js";
import type { ProcessInputStepArgs } from "@mastra/core/processors";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal ProcessInputStepArgs with a given stepNumber */
function makeArgs(stepNumber: number): ProcessInputStepArgs {
  return {
    stepNumber,
    steps: [],
    systemMessages: [],
    state: {},
    model: {} as ProcessInputStepArgs["model"],
    retryCount: 0,
    messages: [],
    abort: () => {},
  } as unknown as ProcessInputStepArgs;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createQuirkPrepareStep", () => {
  describe("normal iterations", () => {
    it("returns undefined for step 0 (first step)", () => {
      const prepareStep = createQuirkPrepareStep({ maxSteps: 10 });
      const result = prepareStep(makeArgs(0));
      expect(result).toBeUndefined();
    });

    it("returns undefined for a mid-range step that is not the midpoint", () => {
      const prepareStep = createQuirkPrepareStep({ maxSteps: 10 });
      // midpoint is floor(10 * 0.6) = 6, wind-down starts at 8
      // step 3 should be a plain iteration
      const result = prepareStep(makeArgs(3));
      expect(result).toBeUndefined();
    });

    it("returns undefined for a step just before wind-down begins", () => {
      const prepareStep = createQuirkPrepareStep({ maxSteps: 10 });
      // wind-down starts at step 8 (maxSteps - 2)
      const result = prepareStep(makeArgs(7));
      expect(result).toBeUndefined();
    });
  });

  describe("wind-down phase (last 2 steps)", () => {
    it("disables tools at the first wind-down step", () => {
      const prepareStep = createQuirkPrepareStep({ maxSteps: 10 });
      // wind-down starts at step 8
      const result = prepareStep(makeArgs(8));
      expect(result).toBeDefined();
      expect(result).toMatchObject({
        tools: {},
        toolChoice: "none",
      });
    });

    it("disables tools at the last step", () => {
      const prepareStep = createQuirkPrepareStep({ maxSteps: 10 });
      // last step is index 9
      const result = prepareStep(makeArgs(9));
      expect(result).toBeDefined();
      expect(result).toMatchObject({
        tools: {},
        toolChoice: "none",
      });
    });

    it("returns empty tools object (not undefined or null)", () => {
      const prepareStep = createQuirkPrepareStep({ maxSteps: 6 });
      // wind-down starts at step 4 (6 - 2)
      const result = prepareStep(makeArgs(4));
      expect(result).toBeDefined();
      expect((result as { tools: unknown }).tools).toEqual({});
    });

    it("works with a small maxSteps of 2", () => {
      const prepareStep = createQuirkPrepareStep({ maxSteps: 2 });
      // windDownStart = 0, so both steps are wind-down
      expect(prepareStep(makeArgs(0))).toMatchObject({ toolChoice: "none" });
      expect(prepareStep(makeArgs(1))).toMatchObject({ toolChoice: "none" });
    });
  });

  describe("midpoint nudge at 60%", () => {
    it("returns toolChoice auto at the midpoint step (floor(10 * 0.6) = 6)", () => {
      const prepareStep = createQuirkPrepareStep({ maxSteps: 10 });
      const result = prepareStep(makeArgs(6));
      expect(result).toBeDefined();
      expect((result as { toolChoice: string }).toolChoice).toBe("auto");
    });

    it("does not return a nudge one step before the midpoint", () => {
      const prepareStep = createQuirkPrepareStep({ maxSteps: 10 });
      const result = prepareStep(makeArgs(5));
      expect(result).toBeUndefined();
    });

    it("does not return a nudge one step after the midpoint (unless wind-down)", () => {
      const prepareStep = createQuirkPrepareStep({ maxSteps: 10 });
      // step 7 is between midpoint(6) and windDown(8) — should be normal
      const result = prepareStep(makeArgs(7));
      expect(result).toBeUndefined();
    });

    it("accepts a custom nudge message (no error)", () => {
      // The custom message is stored but not injected in the current impl
      // as a messages array — just ensure the factory doesn't throw
      const prepareStep = createQuirkPrepareStep({
        maxSteps: 10,
        nudgeMessage: "Custom reminder",
      });
      const result = prepareStep(makeArgs(6));
      expect(result).toBeDefined();
      expect((result as { toolChoice: string }).toolChoice).toBe("auto");
    });

    it("midpoint nudge includes messages array with nudge text", () => {
      const prepareStep = createQuirkPrepareStep({ maxSteps: 10 });
      const midpoint = Math.floor(10 * 0.65); // step 6
      const result = prepareStep(makeArgs(midpoint));
      expect(result).toBeDefined();
      expect(result).toHaveProperty("messages");
      expect((result as any).messages).toBeInstanceOf(Array);
      expect((result as any).messages.length).toBeGreaterThan(0);
      expect((result as any).messages[0]).toHaveProperty("role", "user");
      expect((result as any).messages[0].content).toContain("synthesizing");
    });

    it("midpoint nudge uses custom message when provided", () => {
      const customMsg = "Wrap it up now.";
      const prepareStep = createQuirkPrepareStep({ maxSteps: 10, nudgeMessage: customMsg });
      const midpoint = Math.floor(10 * 0.65); // step 6
      const result = prepareStep(makeArgs(midpoint));
      expect(result).toBeDefined();
      expect((result as any).messages[0].content).toBe(customMsg);
    });

    it("wind-down takes priority over midpoint when they overlap", () => {
      // With maxSteps=3: midpoint=floor(1.8)=1, windDownStart=1
      // Step 1 is both midpoint and wind-down — wind-down should win
      const prepareStep = createQuirkPrepareStep({ maxSteps: 3 });
      const result = prepareStep(makeArgs(1));
      // Wind-down check runs first
      expect((result as { toolChoice: string }).toolChoice).toBe("none");
    });
  });

  describe("edge cases", () => {
    it("handles maxSteps of 1 (single step is wind-down)", () => {
      const prepareStep = createQuirkPrepareStep({ maxSteps: 1 });
      // windDownStart = 1 - 2 = -1, so every step >= -1 is wind-down
      const result = prepareStep(makeArgs(0));
      expect(result).toMatchObject({ toolChoice: "none" });
    });

    it("produces the same result on repeated calls (pure function)", () => {
      const prepareStep = createQuirkPrepareStep({ maxSteps: 10 });
      const args = makeArgs(8);
      expect(prepareStep(args)).toEqual(prepareStep(args));
    });
  });
});
