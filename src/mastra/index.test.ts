import { describe, it, expect, vi } from "vitest";
import { createModel, applyModelMiddleware, generateWithEffortFallback } from "./index.js";
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

describe("generateWithEffortFallback", () => {
  const empty = { content: [], finishReason: { unified: "length" } };
  const answered = { content: [{ type: "text", text: "{\"ok\":true}" }], finishReason: { unified: "stop" } };
  const params = { providerOptions: { openaiCompatible: { reasoningEffort: "medium" } } };

  it("retries once at low effort when the budget went to reasoning and no text came back", async () => {
    const retry = vi.fn(async () => answered);
    const out = await generateWithEffortFallback(async () => empty, retry, params, { reasoningEffort: "medium" });
    expect(out).toBe(answered);
    expect(retry).toHaveBeenCalledWith({ providerOptions: { openaiCompatible: { reasoningEffort: "low" } } });
  });

  it("keeps a real answer", async () => {
    const retry = vi.fn();
    const out = await generateWithEffortFallback(async () => answered, retry, params, { reasoningEffort: "medium" });
    expect(out).toBe(answered);
    expect(retry).not.toHaveBeenCalled();
  });

  it("keeps tool calls even with no text", async () => {
    const toolCall = { content: [{ type: "tool-call" }], finishReason: { unified: "length" } };
    const retry = vi.fn();
    expect(await generateWithEffortFallback(async () => toolCall, retry, params, { reasoningEffort: "high" })).toBe(toolCall);
    expect(retry).not.toHaveBeenCalled();
  });

  it("does not retry at low or unset effort, or when the model stopped normally", async () => {
    const retry = vi.fn();
    await generateWithEffortFallback(async () => empty, retry, params, { reasoningEffort: "low" });
    await generateWithEffortFallback(async () => empty, retry, params, {});
    await generateWithEffortFallback(async () => ({ content: [], finishReason: { unified: "stop" } }), retry, params, { reasoningEffort: "medium" });
    expect(retry).not.toHaveBeenCalled();
  });
});
