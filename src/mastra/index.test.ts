import { describe, it, expect } from "vitest";
import { createModel, applyModelMiddleware } from "./index.js";
import type { Config } from "../config/schema.js";

const baseLlmConfig: Config["llm"] = {
  model: "test-model",
  apiKey: "test-key",
  retry: {
    maxAttempts: 8,
    initialDelayMs: 2000,
    maxDelayMs: 60_000,
    jitterPercent: 0.3,
  },
};

describe("createModel", () => {
  it("creates a model from LLM config", () => {
    const model = createModel(baseLlmConfig);
    expect(model).toBeDefined();
  });
});

describe("applyModelMiddleware", () => {
  it("injects reasoningEffort into providerOptions.openaiCompatible when set", () => {
    const out = applyModelMiddleware({}, { reasoningEffort: "high" });
    expect(out.providerOptions?.["openaiCompatible"]?.["reasoningEffort"]).toBe("high");
  });

  it("omits reasoning_effort when unset", () => {
    const out = applyModelMiddleware({}, {});
    expect(out.providerOptions).toBeUndefined();
  });

  it("preserves caller-supplied reasoningEffort", () => {
    const out = applyModelMiddleware(
      { providerOptions: { openaiCompatible: { reasoningEffort: "high" } } },
      { reasoningEffort: "low" },
    );
    expect(out.providerOptions?.["openaiCompatible"]?.["reasoningEffort"]).toBe("high");
  });

  it("merges reasoningEffort beside other providerOptions keys", () => {
    const out = applyModelMiddleware(
      { providerOptions: { openaiCompatible: { user: "tester" } } },
      { reasoningEffort: "medium" },
    );
    expect(out.providerOptions?.["openaiCompatible"]).toEqual({
      user: "tester",
      reasoningEffort: "medium",
    });
  });

  it("defaults maxOutputTokens to 4096", () => {
    const out = applyModelMiddleware({}, {});
    expect(out.maxOutputTokens).toBe(4096);
  });

  it("preserves caller-supplied maxOutputTokens", () => {
    const out = applyModelMiddleware({ maxOutputTokens: 1024 }, {});
    expect(out.maxOutputTokens).toBe(1024);
  });
});
