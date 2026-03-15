import { describe, it, expect } from "vitest";
import { buildIntentClassifierPrompt } from "./rca-prompts.js";

describe("buildIntentClassifierPrompt", () => {
  it("instructs intent classification", () => {
    const prompt = buildIntentClassifierPrompt();
    expect(prompt).toContain("investigation");
    expect(prompt).toContain("JSON");
  });

  it("includes few-shot examples", () => {
    const prompt = buildIntentClassifierPrompt();
    expect(prompt).toContain("EXAMPLES");
    expect(prompt).toContain("connection errors");
    expect(prompt).toContain("what dashboards");
  });

  it("includes symptom and error patterns", () => {
    const prompt = buildIntentClassifierPrompt();
    expect(prompt).toContain("slow");
    expect(prompt).toContain("error");
    expect(prompt).toContain("check");
  });

  it("includes service names when provided", () => {
    const prompt = buildIntentClassifierPrompt(["ingestion-server", "payments-api"]);
    expect(prompt).toContain("known services");
    expect(prompt).toContain("ingestion-server");
    expect(prompt).toContain("payments-api");
  });
});
