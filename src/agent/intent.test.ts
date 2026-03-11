import { describe, it, expect, vi } from "vitest";
import { IntentRouter, matchService, matchServiceFromText, messageMatchesAnyService, validateLlmServiceMatch, resolveServiceFromHistory } from "./intent.js";
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

  it("prefers shorter service name when multiple contain the query", () => {
    // Without aliases, substring match prefers shortest name containing query
    const svcs = [svc("kudu-tserver-extended"), svc("kudu-tserver"), svc("kudu-master")];
    expect(matchService("kudu", svcs)?.name).toBe("kudu-master");
  });

  it("prefers longest reverse match when query contains multiple service names", () => {
    const svcs = [svc("clickhouse-sinker"), svc("ch-clickhouse"), svc("ch-clickhouse-headless")];
    expect(matchService("clickhouse", svcs)?.name).toBe("ch-clickhouse");
  });

  it("resolves alias 'kafka' to kafka-brokers service", () => {
    const svcs = [svc("stream-kafka-cluster-cruise-control"), svc("stream-kafka-cluster-kafka-brokers")];
    expect(matchService("kafka", svcs)?.name).toBe("stream-kafka-cluster-kafka-brokers");
  });

  it("resolves alias 'postgres' to stolon-proxy", () => {
    const svcs = [svc("stolon-proxy"), svc("stolon-keeper-headless")];
    expect(matchService("postgres", svcs)?.name).toBe("stolon-proxy");
  });

  it("resolves alias 'redis' to cache-redis-ha", () => {
    const svcs = [svc("cache-redis-ha"), svc("cache-redis-ha-haproxy")];
    expect(matchService("redis", svcs)?.name).toBe("cache-redis-ha");
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

  it("prefers exact service name over longer name with more tokens", () => {
    const svcs = [svc("data-catalog-server-headless"), svc("data-server"), svc("data-catalog-server")];
    expect(matchServiceFromText("data-server queries are slow", svcs)?.name).toBe("data-server");
  });

  it("prefers faz-web-server over faz-web-proxy when user says faz-web-server", () => {
    const svcs = [svc("faz-web-proxy"), svc("faz-web-server")];
    expect(matchServiceFromText("check faz-web-server for issues", svcs)?.name).toBe("faz-web-server");
  });

  it("matches hyphenated service name in message", () => {
    const svcs = [svc("ingestion-server"), svc("data-server")];
    expect(matchServiceFromText("the ingestion-server is throwing errors", svcs)?.name).toBe("ingestion-server");
  });

  it("resolves alias 'clickhouse' in message to ch-clickhouse", () => {
    const svcs = [svc("clickhouse-sinker"), svc("ch-clickhouse"), svc("stream-kafka-cluster-cruise-control")];
    expect(matchServiceFromText("check ClickHouse cluster health", svcs)?.name).toBe("ch-clickhouse");
  });

  it("resolves alias 'kafka' in message to kafka-brokers service", () => {
    const svcs = [svc("stream-kafka-cluster-kafka-bootstrap"), svc("stream-kafka-cluster-kafka-brokers")];
    expect(matchServiceFromText("are there issues with the Kafka cluster?", svcs)?.name).toBe("stream-kafka-cluster-kafka-brokers");
  });

  it("prefers shorter service when token scores tie", () => {
    const svcs = [svc("stream-kafka-cluster-cruise-control"), svc("ch-clickhouse")];
    // "clickhouse" token matches ch-clickhouse via alias
    expect(matchServiceFromText("check clickhouse cluster health", svcs)?.name).toBe("ch-clickhouse");
  });

  it("does not match on generic token 'cluster' alone", () => {
    const svcs = [svc("stream-kafka-cluster-kafka-brokers"), svc("ch-clickhouse")];
    expect(matchServiceFromText("what's the disk utilization across the cluster?", svcs)).toBeUndefined();
  });

  it("does not match on generic token 'metrics' alone", () => {
    const svcs = [svc("metrics-server"), svc("ingestion-server")];
    expect(matchServiceFromText("show me network throughput metrics", svcs)).toBeUndefined();
  });

  it("does not match on generic token 'server' alone", () => {
    const svcs = [svc("ingestion-server"), svc("data-server")];
    expect(matchServiceFromText("the server is slow", svcs)).toBeUndefined();
  });

  it("still matches specific tokens even when generic tokens also present", () => {
    const svcs = [svc("ingestion-server"), svc("data-server")];
    expect(matchServiceFromText("the ingestion server is slow", svcs)?.name).toBe("ingestion-server");
  });
});

describe("messageMatchesAnyService", () => {
  const names = ["ingestion-server", "payments-api", "kudu-tserver"];

  it("matches when a service name token appears in the message", () => {
    expect(messageMatchesAnyService("ingestion rate dropped", names)).toBe(true);
  });

  it("matches when full service name is in the message", () => {
    expect(messageMatchesAnyService("check payments-api for errors", names)).toBe(true);
  });

  it("matches alias keyword like kafka", () => {
    expect(messageMatchesAnyService("kafka is having issues", ["some-other-service"])).toBe(true);
  });

  it("does not match on short tokens like 'api'", () => {
    expect(messageMatchesAnyService("the api is slow", ["payments-api"])).toBe(false);
  });

  it("does not match when no service tokens are present", () => {
    expect(messageMatchesAnyService("what dashboards do we have?", names)).toBe(false);
  });

  it("does not match on generic token 'cluster'", () => {
    expect(messageMatchesAnyService("disk utilization across the cluster", ["stream-kafka-cluster-kafka-brokers"])).toBe(false);
  });

  it("does not match on generic token 'server'", () => {
    expect(messageMatchesAnyService("the server is slow", ["ingestion-server"])).toBe(false);
  });

  it("matches when full service name appears as substring", () => {
    expect(messageMatchesAnyService("check faz-web-server for issues", ["faz-web-server"])).toBe(true);
  });
});

describe("validateLlmServiceMatch", () => {
  const services = [svc("data-catalog-server-headless"), svc("data-server"), svc("kudu-tserver"), svc("ingestion-server")];

  it("rejects LLM pick when no tokens overlap with user message", () => {
    // LLM hallucinated "data-catalog-server-headless" for a query about kudu
    expect(validateLlmServiceMatch("data-catalog-server-headless", "how's the kudu workload today? show me a chart", services)).toBeUndefined();
  });

  it("accepts LLM pick when service tokens appear in user message", () => {
    expect(validateLlmServiceMatch("kudu-tserver", "how's the kudu workload today?", services)?.name).toBe("kudu-tserver");
  });

  it("accepts LLM pick when LLM query appears in user message", () => {
    // LLM extracts "ingestion" which appears in the message
    expect(validateLlmServiceMatch("ingestion", "ingestion rate is dropping", services)?.name).toBe("ingestion-server");
  });

  it("returns undefined when LLM service is empty", () => {
    expect(validateLlmServiceMatch("", "show me a chart", services)).toBeUndefined();
  });

  it("returns undefined when LLM service doesn't resolve to any config", () => {
    expect(validateLlmServiceMatch("nonexistent-service", "check nonexistent-service", services)).toBeUndefined();
  });

  it("accepts when partial token overlap exists (substring match >= 5 chars)", () => {
    // "catalog" (7 chars) vs "catalog" in message
    expect(validateLlmServiceMatch("data-catalog-server-headless", "check the data catalog", services)?.name).toBe("data-catalog-server-headless");
  });

  it("rejects when overlap is only generic infra tokens", () => {
    // LLM picks "metrics-server" for a message about generic "metrics" — "metrics" is generic
    const svcs = [svc("metrics-server"), svc("ingestion-server")];
    expect(validateLlmServiceMatch("metrics-server", "show me the metrics", svcs)).toBeUndefined();
  });
});

describe("resolveServiceFromHistory", () => {
  const services = [svc("ingestion-server"), svc("payments-api"), svc("kudu-tserver")];

  it("resolves service from assistant message mentioning service name", () => {
    const history = [
      { role: "user", content: "how's the ingestion log rate?" },
      { role: "assistant", content: "The ingestion-server log rate has been stable at 5k/s." },
    ];
    expect(resolveServiceFromHistory(history, services)?.name).toBe("ingestion-server");
  });

  it("returns most recent service mention (scans backwards)", () => {
    const history = [
      { role: "user", content: "check ingestion-server" },
      { role: "assistant", content: "ingestion-server looks fine." },
      { role: "user", content: "what about payments-api?" },
      { role: "assistant", content: "payments-api error rate is elevated." },
    ];
    expect(resolveServiceFromHistory(history, services)?.name).toBe("payments-api");
  });

  it("returns undefined when no service is mentioned in history", () => {
    const history = [
      { role: "user", content: "what dashboards do we have?" },
      { role: "assistant", content: "We have several Grafana dashboards." },
    ];
    expect(resolveServiceFromHistory(history, services)).toBeUndefined();
  });

  it("handles empty history", () => {
    expect(resolveServiceFromHistory([], services)).toBeUndefined();
  });

  it("skips entries with null content", () => {
    const history = [
      { role: "user", content: "check ingestion-server" },
      { role: "assistant", content: null },
    ];
    expect(resolveServiceFromHistory(history, services)?.name).toBe("ingestion-server");
  });

  it("resolves from token match in history (e.g. 'ingestion' → ingestion-server)", () => {
    const history = [
      { role: "assistant", content: "The ingestion rate dropped to 2k/s yesterday." },
    ];
    expect(resolveServiceFromHistory(history, services)?.name).toBe("ingestion-server");
  });
});

describe("IntentRouter", () => {
  // --- Keyword fast-path tests (bypasses LLM) ---

  // --- Display-request fast-path tests ---

  it("display fast-path: 'show me' routes to question without calling LLM", async () => {
    const llm = makeLlm(JSON.stringify({ intent: "investigation", service: "kafka" }));
    const router = new IntentRouter(llm);
    const result = await router.route("show me Kafka Batches Received Rate in ingestion monitor");
    expect(result.intent).toBe("question");
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it("display fast-path: 'show the' routes to question", async () => {
    const llm = makeLlm(JSON.stringify({ intent: "investigation", service: "" }));
    const router = new IntentRouter(llm);
    const result = await router.route("show the grafana dashboards for memory usage");
    expect(result.intent).toBe("question");
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it("display fast-path: 'display' routes to question", async () => {
    const llm = makeLlm(JSON.stringify({ intent: "investigation", service: "" }));
    const router = new IntentRouter(llm);
    const result = await router.route("display CPU usage chart");
    expect(result.intent).toBe("question");
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it("display fast-path: does NOT fire when symptom words present", async () => {
    const llm = makeLlm(JSON.stringify({ intent: "investigation", service: "kafka" }));
    const router = new IntentRouter(llm);
    const result = await router.route("show me the errors on kafka");
    expect(result.intent).toBe("investigation");
    // LLM should be called since symptom word blocks the display fast-path
  });

  // --- Keyword fast-path tests (bypasses LLM) ---

  it("fast-path: 'investigate' routes to investigation without calling LLM", async () => {
    const llm = makeLlm(JSON.stringify({ intent: "question", service: "" }));
    const router = new IntentRouter(llm);
    const result = await router.route("investigate payments-api");
    expect(result.intent).toBe("investigation");
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it("fast-path: 'diagnose' routes to investigation", async () => {
    const llm = makeLlm(JSON.stringify({ intent: "question", service: "" }));
    const router = new IntentRouter(llm);
    const result = await router.route("diagnose the ingestion rate drop");
    expect(result.intent).toBe("investigation");
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it("fast-path: 'rca' routes to investigation", async () => {
    const llm = makeLlm(JSON.stringify({ intent: "question", service: "" }));
    const router = new IntentRouter(llm);
    const result = await router.route("run rca on payments-api");
    expect(result.intent).toBe("investigation");
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it("fast-path: 'troubleshoot' routes to investigation", async () => {
    const llm = makeLlm(JSON.stringify({ intent: "question", service: "" }));
    const router = new IntentRouter(llm);
    const result = await router.route("troubleshoot the connection errors");
    expect(result.intent).toBe("investigation");
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it("fast-path: 'root cause' routes to investigation", async () => {
    const llm = makeLlm(JSON.stringify({ intent: "question", service: "" }));
    const router = new IntentRouter(llm);
    const result = await router.route("find the root cause of the outage");
    expect(result.intent).toBe("investigation");
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it("fast-path: 'postmortem' routes to investigation", async () => {
    const llm = makeLlm(JSON.stringify({ intent: "question", service: "" }));
    const router = new IntentRouter(llm);
    const result = await router.route("run a postmortem on yesterday's incident");
    expect(result.intent).toBe("investigation");
    expect(llm.chat).not.toHaveBeenCalled();
  });

  // --- Symptom + service fast-path tests ---

  it("symptom fast-path: 'dropped' + service token routes to investigation", async () => {
    const llm = makeLlm(JSON.stringify({ intent: "question", service: "" }));
    const router = new IntentRouter(llm);
    const result = await router.route("ingestion rate dropped yesterday", ["ingestion-server", "payments-api"]);
    expect(result.intent).toBe("investigation");
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it("symptom fast-path: 'slow' + service token routes to investigation", async () => {
    const llm = makeLlm(JSON.stringify({ intent: "question", service: "" }));
    const router = new IntentRouter(llm);
    const result = await router.route("payments-api is slow", ["ingestion-server", "payments-api"]);
    expect(result.intent).toBe("investigation");
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it("symptom fast-path: 'errors' + alias routes to investigation", async () => {
    const llm = makeLlm(JSON.stringify({ intent: "question", service: "" }));
    const router = new IntentRouter(llm);
    const result = await router.route("kafka errors are spiking", ["some-other-service"]);
    expect(result.intent).toBe("investigation");
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it("symptom fast-path: 'check' + alias routes to investigation", async () => {
    const llm = makeLlm(JSON.stringify({ intent: "question", service: "" }));
    const router = new IntentRouter(llm);
    const result = await router.route("check ClickHouse cluster health", ["ch-clickhouse", "ingestion-server"]);
    expect(result.intent).toBe("investigation");
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it("symptom fast-path: 'check' does NOT fire without service mention", async () => {
    const llm = makeLlm(JSON.stringify({ intent: "question", service: "" }));
    const router = new IntentRouter(llm);
    const result = await router.route("check what dashboards we have available", ["ingestion-server"]);
    expect(result.intent).toBe("question");
    expect(llm.chat).toHaveBeenCalled();
  });

  it("symptom fast-path: does NOT fire without service mention", async () => {
    const llm = makeLlm(JSON.stringify({ intent: "question", service: "" }));
    const router = new IntentRouter(llm);
    const result = await router.route("what is the error rate?", ["ingestion-server"]);
    expect(result.intent).toBe("question");
    expect(llm.chat).toHaveBeenCalled();
  });

  it("symptom fast-path: does NOT fire without serviceNames", async () => {
    const llm = makeLlm(JSON.stringify({ intent: "question", service: "" }));
    const router = new IntentRouter(llm);
    const result = await router.route("ingestion rate dropped yesterday");
    expect(result.intent).toBe("question");
    expect(llm.chat).toHaveBeenCalled();
  });

  // --- LLM classification tests (no fast-path keywords) ---

  it("classifies investigation intent via LLM when no keyword match", async () => {
    const llm = makeLlm(JSON.stringify({ intent: "investigation", service: "payments-api" }));
    const router = new IntentRouter(llm);
    const result = await router.route("payments-api errors are spiking");
    expect(result.intent).toBe("investigation");
    if (result.intent === "investigation") {
      expect(result.service).toBe("payments-api");
    }
  });

  it("passes service names to the system prompt", async () => {
    const llm = makeLlm(JSON.stringify({ intent: "investigation", service: "ingestion-server" }));
    const router = new IntentRouter(llm);
    // Use a message without fast-path keywords or symptoms so the LLM is actually called
    await router.route("tell me about ingestion-server health", ["ingestion-server", "payments-api"]);
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
    const result = await router.route("how does this system work?");
    expect(result.intent).toBe("question");
  });

  it("falls back to question on LLM error", async () => {
    const llm = {
      chat: vi.fn().mockRejectedValue(new Error("LLM timeout")),
    } as unknown as LlmClient;
    const router = new IntentRouter(llm);
    const result = await router.route("show me the current dashboards");
    expect(result.intent).toBe("question");
  });
});
