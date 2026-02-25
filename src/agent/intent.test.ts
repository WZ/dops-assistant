import { describe, it, expect, vi } from "vitest";
import { IntentClassifier } from "./intent.js";
import type { LlmClient } from "../llm/openai.js";

function makeLlm(response: string): LlmClient {
  return {
    chat: vi.fn().mockResolvedValue({ type: "text", content: response }),
  } as unknown as LlmClient;
}

describe("IntentClassifier", () => {
  it("classifies investigation intent with service name", async () => {
    const llm = makeLlm(JSON.stringify({ intent: "investigation", service: "payments-api" }));
    const classifier = new IntentClassifier(llm);
    const result = await classifier.classify("investigate payments-api");
    expect(result.intent).toBe("investigation");
    if (result.intent === "investigation") {
      expect(result.service).toBe("payments-api");
    }
  });

  it("classifies question intent", async () => {
    const llm = makeLlm(JSON.stringify({ intent: "question", service: "" }));
    const classifier = new IntentClassifier(llm);
    const result = await classifier.classify("what is the error rate?");
    expect(result.intent).toBe("question");
  });

  it("falls back to question on parse error", async () => {
    const llm = makeLlm("not valid json");
    const classifier = new IntentClassifier(llm);
    const result = await classifier.classify("investigate something");
    expect(result.intent).toBe("question");
  });

  it("falls back to question on LLM error", async () => {
    const llm = {
      chat: vi.fn().mockRejectedValue(new Error("LLM timeout")),
    } as unknown as LlmClient;
    const classifier = new IntentClassifier(llm);
    const result = await classifier.classify("is payments down?");
    expect(result.intent).toBe("question");
  });
});
