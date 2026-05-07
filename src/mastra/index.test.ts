import { describe, it, expect } from "vitest";
import { createModel } from "./index.js";

describe("createModel", () => {
  it("creates a model from LLM config", () => {
    const model = createModel({
      model: "test-model",
      apiKey: "test-key",
    });
    expect(model).toBeDefined();
  });
});
