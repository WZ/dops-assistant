import { describe, it, expect, vi } from "vitest";
import { IntentRouter, matchService, matchServiceFromText } from "./intent.js";
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

  it("matches via token overlap (e.g. LLM invents a name sharing a token)", () => {
    expect(matchService("log-ingestion-pipeline", services)?.name).toBe("ingestion-server");
  });

  it("returns undefined for no token overlap", () => {
    expect(matchService("unknown-svc", services)).toBeUndefined();
  });
});

describe("matchServiceFromText", () => {
  const services = [svc("ingestion-server"), svc("payments-api"), svc("kudu-tserver"), svc("loki")];

  it("matches service name mentioned in user message", () => {
    expect(matchServiceFromText("the ingestion server is down", services)?.name).toBe("ingestion-server");
  });

  it("matches when user describes the service indirectly", () => {
    expect(matchServiceFromText("ingestion log rate dropped yesterday", services)?.name).toBe("ingestion-server");
  });

  it("prefers stronger token match over weaker one", () => {
    // "ingestion" (9 chars) is an exact token match for ingestion-server, not loki
    expect(matchServiceFromText("the ingestion log rate dropped to zero", services)?.name).toBe("ingestion-server");
  });

  it("matches exact service name in message", () => {
    expect(matchServiceFromText("investigate payments-api errors", services)?.name).toBe("payments-api");
  });

  it("returns undefined when no service matches the message", () => {
    expect(matchServiceFromText("how is the weather today", services)).toBeUndefined();
  });

  it("does not match on short generic words", () => {
    // "log" (3 chars) should not cause a match on "loki" since loki tokens are ["loki"] and no overlap with ["log"]
    expect(matchServiceFromText("check the log files please", services)?.name).not.toBe("loki");
  });
});

describe("IntentRouter", () => {
  it("classifies investigation intent with service name", async () => {
    const llm = makeLlm(JSON.stringify({ intent: "investigation", service: "payments-api" }));
    const router = new IntentRouter(llm);
    const result = await router.route("investigate payments-api");
    expect(result.intent).toBe("investigation");
    if (result.intent === "investigation") {
      expect(result.service).toBe("payments-api");
    }
  });

  it("passes service names to the system prompt", async () => {
    const llm = makeLlm(JSON.stringify({ intent: "investigation", service: "ingestion-server" }));
    const router = new IntentRouter(llm);
    await router.route("investigate ingestion", ["ingestion-server", "payments-api"]);
    const systemPrompt = (llm.chat as ReturnType<typeof vi.fn>).mock.calls[0]![0][0].content as string;
    expect(systemPrompt).toContain("ingestion-server");
    expect(systemPrompt).toContain("payments-api");
    expect(systemPrompt).toContain("known services");
  });

  it("classifies question intent", async () => {
    const llm = makeLlm(JSON.stringify({ intent: "question", service: "" }));
    const router = new IntentRouter(llm);
    const result = await router.route("what is the error rate?");
    expect(result.intent).toBe("question");
  });

  it("falls back to question on parse error", async () => {
    const llm = makeLlm("not valid json");
    const router = new IntentRouter(llm);
    const result = await router.route("investigate something");
    expect(result.intent).toBe("question");
  });

  it("falls back to question on LLM error", async () => {
    const llm = {
      chat: vi.fn().mockRejectedValue(new Error("LLM timeout")),
    } as unknown as LlmClient;
    const router = new IntentRouter(llm);
    const result = await router.route("is payments down?");
    expect(result.intent).toBe("question");
  });
});
