import { describe, it, expect, vi } from "vitest";
import { IntentClassifier, matchService } from "./intent.js";
import type { LlmClient } from "../llm/openai.js";
import type { ServiceConfig } from "../config/schema.js";

function makeLlm(response: string): LlmClient {
  return {
    chat: vi.fn().mockResolvedValue({ type: "text", content: response }),
  } as unknown as LlmClient;
}

const svc = (name: string): ServiceConfig => ({ name, metrics: [], logLabels: {} });

describe("matchService", () => {
  const services = [svc("ingestion-server"), svc("payments-api"), svc("kudu-tserver")];

  it("matches exact name", () => {
    expect(matchService("ingestion-server", services)?.name).toBe("ingestion-server");
  });

  it("matches unicode non-breaking hyphen as regular hyphen", () => {
    // U+2011 non-breaking hyphen
    expect(matchService("ingestion\u2011server", services)?.name).toBe("ingestion-server");
  });

  it("matches en-dash as hyphen", () => {
    // U+2013 en-dash
    expect(matchService("ingestion\u2013server", services)?.name).toBe("ingestion-server");
  });

  it("matches case-insensitive", () => {
    expect(matchService("Payments-API", services)?.name).toBe("payments-api");
  });

  it("matches partial (query contained in service name)", () => {
    expect(matchService("kudu", services)?.name).toBe("kudu-tserver");
  });

  it("returns undefined for no match", () => {
    expect(matchService("unknown-svc", services)).toBeUndefined();
  });
});

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
