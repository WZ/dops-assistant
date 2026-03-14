import { describe, it, expect } from "vitest";
import { createMastraInstance, createModel } from "./index.js";

describe("createMastraInstance", () => {
  it("creates a Mastra instance with model config", () => {
    const mastra = createMastraInstance({
      llm: { model: "test-model", apiKey: "test-key", maxTokens: 4096 },
    });
    expect(mastra).toBeDefined();
  });

  it("uses custom baseURL when provided", () => {
    const mastra = createMastraInstance({
      llm: {
        model: "gpt-oss-120b",
        apiKey: "test-key",
        maxTokens: 4096,
        baseURL: "https://custom.endpoint/v1",
      },
    });
    expect(mastra).toBeDefined();
  });
});

describe("createModel", () => {
  it("creates a model from LLM config", () => {
    const model = createModel({
      model: "test-model",
      apiKey: "test-key",
      maxTokens: 4096,
    });
    expect(model).toBeDefined();
  });
});
