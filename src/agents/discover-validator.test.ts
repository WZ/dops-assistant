import { describe, it, expect } from "vitest";
import { createValidatorAgent } from "./discover-validator.js";
import type { LanguageModel } from "ai";

const fakeModel = {} as LanguageModel;

describe("createValidatorAgent", () => {
  it("creates an agent with id 'discover-validator'", () => {
    const agent = createValidatorAgent({ model: fakeModel, servicesToValidate: [] });
    expect(agent.id).toBe("discover-validator");
  });

  it("includes service list in instructions", () => {
    const agent = createValidatorAgent({
      model: fakeModel,
      servicesToValidate: [{ name: "svc1", metrics: [{ query: "up{}", description: "health" }], logLabels: { app: "svc1" } }],
    });
    expect(agent).toBeDefined();
  });
});
