import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { IntentRouter, matchService, matchServiceFromText, messageMatchesAnyService, validateLlmServiceMatch, resolveServiceFromHistory, setServiceAliases } from "./intent.js";
import type { ServiceConfig } from "../config/schema.js";

// Mock the ai module's generateText function
vi.mock("ai", () => ({
  generateText: vi.fn(),
}));
import { generateText } from "ai";
const mockGenerateText = vi.mocked(generateText);

function mockLlmResponse(response: string): void {
  mockGenerateText.mockResolvedValue({ text: response } as any);
}

function mockLlmError(error: Error): void {
  mockGenerateText.mockRejectedValue(error);
}

// Dummy model (never actually called in fast-path tests; generateText is mocked for LLM tests)
const dummyModel = {} as any;

const svc = (name: string): ServiceConfig => ({ name, metrics: [], logLabels: {} });

beforeEach(() => {
  mockGenerateText.mockReset();
});

describe("matchService", () => {
  const services = [svc("ingestion-server"), svc("payments-api"), svc("kudu-tserver")];

  it("matches exact name", () => {
    expect(matchService("ingestion-server", services)?.name).toBe("ingestion-server");
  });

  it("matches unicode non-breaking hyphen as regular hyphen", () => {
    expect(matchService("ingestion\u2011server", services)?.name).toBe("ingestion-server");
  });

  it("matches en-dash as hyphen", () => {
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
    expect(matchServiceFromText("the ingestion log rate dropped to zero", services)?.name).toBe("ingestion-server");
  });

  it("matches exact service name in message", () => {
    expect(matchServiceFromText("investigate payments-api errors", services)?.name).toBe("payments-api");
  });

  it("returns undefined when no service matches the message", () => {
    expect(matchServiceFromText("how is the weather today", services)).toBeUndefined();
  });

  it("does not match on short generic words", () => {
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
    expect(validateLlmServiceMatch("data-catalog-server-headless", "how's the kudu workload today? show me a chart", services)).toBeUndefined();
  });

  it("accepts LLM pick when service tokens appear in user message", () => {
    expect(validateLlmServiceMatch("kudu-tserver", "how's the kudu workload today?", services)?.name).toBe("kudu-tserver");
  });

  it("accepts LLM pick when LLM query appears in user message", () => {
    expect(validateLlmServiceMatch("ingestion", "ingestion rate is dropping", services)?.name).toBe("ingestion-server");
  });

  it("returns undefined when LLM service is empty", () => {
    expect(validateLlmServiceMatch("", "show me a chart", services)).toBeUndefined();
  });

  it("returns undefined when LLM service doesn't resolve to any config", () => {
    expect(validateLlmServiceMatch("nonexistent-service", "check nonexistent-service", services)).toBeUndefined();
  });

  it("accepts when partial token overlap exists (substring match >= 5 chars)", () => {
    expect(validateLlmServiceMatch("data-catalog-server-headless", "check the data catalog", services)?.name).toBe("data-catalog-server-headless");
  });

  it("rejects when overlap is only generic infra tokens", () => {
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
  // --- Display-request fast-path tests ---

  it("display fast-path: 'show me' routes to question without calling LLM", async () => {
    const router = new IntentRouter(dummyModel);
    const result = await router.route("show me Kafka Batches Received Rate in ingestion monitor");
    expect(result.intent).toBe("question");
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("display fast-path: 'show the' routes to question", async () => {
    const router = new IntentRouter(dummyModel);
    const result = await router.route("show the grafana dashboards for memory usage");
    expect(result.intent).toBe("question");
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("display fast-path: 'display' routes to question", async () => {
    const router = new IntentRouter(dummyModel);
    const result = await router.route("display CPU usage chart");
    expect(result.intent).toBe("question");
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("display fast-path: does NOT fire when symptom words present", async () => {
    mockLlmResponse(JSON.stringify({ intent: "investigation", service: "kafka" }));
    const router = new IntentRouter(dummyModel);
    const result = await router.route("show me the errors on kafka");
    expect(result.intent).toBe("investigation");
  });

  // --- Informational-request fast-path tests ---

  it("informational fast-path: 'tell me about X health' routes to question", async () => {
    const router = new IntentRouter(dummyModel);
    const result = await router.route("tell me about ingestion-server health");
    expect(result.intent).toBe("question");
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("informational fast-path: 'how is X' routes to question", async () => {
    const router = new IntentRouter(dummyModel);
    const result = await router.route("how is the payments-api doing?");
    expect(result.intent).toBe("question");
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("informational fast-path: 'how's' routes to question", async () => {
    const router = new IntentRouter(dummyModel);
    const result = await router.route("how's the ingestion-server?");
    expect(result.intent).toBe("question");
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("informational fast-path: 'what about X' routes to question", async () => {
    const router = new IntentRouter(dummyModel);
    const result = await router.route("what about the kudu workload rate?");
    expect(result.intent).toBe("question");
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("informational fast-path: does NOT fire when symptom words present", async () => {
    mockLlmResponse(JSON.stringify({ intent: "investigation", service: "ingestion-server" }));
    const router = new IntentRouter(dummyModel);
    const result = await router.route("tell me about the ingestion-server errors", ["ingestion-server"]);
    expect(result.intent).toBe("investigation");
  });

  it("'how is X? it seems down' routes to question (chat agent uses tools)", async () => {
    // After dropping the symptom+service fast-path, symptom-with-service prompts
    // are LLM-classified. The conservative prompt routes them to "question" —
    // the chat agent has Prometheus / Loki / k8s tools to answer with real data.
    mockLlmResponse(JSON.stringify({ intent: "question", service: "payments-api" }));
    const router = new IntentRouter(dummyModel);
    const result = await router.route("how is payments-api? it seems down", ["payments-api"]);
    expect(result.intent).toBe("question");
    expect(mockGenerateText).toHaveBeenCalled();
  });

  // --- Keyword fast-path tests (bypasses LLM) ---

  it("fast-path: 'investigate' routes to investigation without calling LLM", async () => {
    const router = new IntentRouter(dummyModel);
    const result = await router.route("investigate payments-api");
    expect(result.intent).toBe("investigation");
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("fast-path: 'diagnose' routes to investigation", async () => {
    const router = new IntentRouter(dummyModel);
    const result = await router.route("diagnose the ingestion rate drop");
    expect(result.intent).toBe("investigation");
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("fast-path: 'rca' routes to investigation", async () => {
    const router = new IntentRouter(dummyModel);
    const result = await router.route("run rca on payments-api");
    expect(result.intent).toBe("investigation");
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("fast-path: 'troubleshoot' routes to investigation", async () => {
    const router = new IntentRouter(dummyModel);
    const result = await router.route("troubleshoot the connection errors");
    expect(result.intent).toBe("investigation");
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("fast-path: 'root cause' routes to investigation", async () => {
    const router = new IntentRouter(dummyModel);
    const result = await router.route("find the root cause of the outage");
    expect(result.intent).toBe("investigation");
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("fast-path: 'postmortem' routes to investigation", async () => {
    const router = new IntentRouter(dummyModel);
    const result = await router.route("run a postmortem on yesterday's incident");
    expect(result.intent).toBe("investigation");
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  // --- Symptom + service prompts (route to question via LLM) ---
  //
  // The symptom+service fast-path was removed — these prompts now route through
  // the LLM classifier, which (per the conservative prompt) returns "question"
  // for symptom reports. Chat agent answers via Prometheus / Loki / k8s tools.

  it("'<service> rate dropped' routes to question (chat agent answers)", async () => {
    mockLlmResponse(JSON.stringify({ intent: "question", service: "ingestion-server" }));
    const router = new IntentRouter(dummyModel);
    const result = await router.route("ingestion rate dropped yesterday", ["ingestion-server", "payments-api"]);
    expect(result.intent).toBe("question");
    expect(mockGenerateText).toHaveBeenCalled();
  });

  it("'<service> is slow' routes to question (chat agent answers)", async () => {
    mockLlmResponse(JSON.stringify({ intent: "question", service: "payments-api" }));
    const router = new IntentRouter(dummyModel);
    const result = await router.route("payments-api is slow", ["ingestion-server", "payments-api"]);
    expect(result.intent).toBe("question");
    expect(mockGenerateText).toHaveBeenCalled();
  });

  it("'kafka errors are spiking' routes to question (chat agent answers)", async () => {
    mockLlmResponse(JSON.stringify({ intent: "question", service: "kafka" }));
    const router = new IntentRouter(dummyModel);
    const result = await router.route("kafka errors are spiking", ["some-other-service"]);
    expect(result.intent).toBe("question");
    expect(mockGenerateText).toHaveBeenCalled();
  });

  it("'check ClickHouse cluster health' routes to question (chat agent answers)", async () => {
    mockLlmResponse(JSON.stringify({ intent: "question", service: "clickhouse" }));
    const router = new IntentRouter(dummyModel);
    const result = await router.route("check ClickHouse cluster health", ["ch-clickhouse", "ingestion-server"]);
    expect(result.intent).toBe("question");
    expect(mockGenerateText).toHaveBeenCalled();
  });

  it("'can you check errors in <job>' routes to question (regression: data-catalog-server-table-schema-check)", async () => {
    // Real prompt that previously triggered a misrouted investigation against
    // an MCP provider service. The "k8s" token used to overlap "k8s-mcp"; with
    // platform tokens added to GENERIC_INFRA_TOKENS, that match is gone too.
    mockLlmResponse(JSON.stringify({ intent: "question", service: "" }));
    const router = new IntentRouter(dummyModel);
    const result = await router.route(
      "can you check errors in data-catalog-server-table-schema-check job. there is a init hook k8s job when provisioning data-catalog-server",
      ["k8s-mcp", "data-catalog-server"],
    );
    expect(result.intent).toBe("question");
  });

  it("informational + symptom-without-service still routes to question", async () => {
    mockLlmResponse(JSON.stringify({ intent: "question", service: "" }));
    const router = new IntentRouter(dummyModel);
    const result = await router.route("what is the error rate?", ["ingestion-server"]);
    expect(result.intent).toBe("question");
    expect(mockGenerateText).toHaveBeenCalled();
  });

  it("symptom prompt without serviceNames routes to question", async () => {
    mockLlmResponse(JSON.stringify({ intent: "question", service: "" }));
    const router = new IntentRouter(dummyModel);
    const result = await router.route("ingestion rate dropped yesterday");
    expect(result.intent).toBe("question");
    expect(mockGenerateText).toHaveBeenCalled();
  });

  it("'check what dashboards we have' routes to question (no service mention)", async () => {
    mockLlmResponse(JSON.stringify({ intent: "question", service: "" }));
    const router = new IntentRouter(dummyModel);
    const result = await router.route("check what dashboards we have available", ["ingestion-server"]);
    expect(result.intent).toBe("question");
    expect(mockGenerateText).toHaveBeenCalled();
  });

  // --- Casual/greeting message tests (routed via LLM, not fast-path) ---

  it("LLM classifies 'hi' as question", async () => {
    mockLlmResponse(JSON.stringify({ intent: "question", service: "" }));
    const router = new IntentRouter(dummyModel);
    const result = await router.route("hi", ["kube-proxy", "ingestion-server"]);
    expect(result.intent).toBe("question");
    expect(mockGenerateText).toHaveBeenCalled();
  });

  it("LLM classifies 'hello' as question", async () => {
    mockLlmResponse(JSON.stringify({ intent: "question", service: "" }));
    const router = new IntentRouter(dummyModel);
    const result = await router.route("hello");
    expect(result.intent).toBe("question");
    expect(mockGenerateText).toHaveBeenCalled();
  });

  it("LLM classifies 'thanks' as question", async () => {
    mockLlmResponse(JSON.stringify({ intent: "question", service: "" }));
    const router = new IntentRouter(dummyModel);
    const result = await router.route("thanks");
    expect(result.intent).toBe("question");
    expect(mockGenerateText).toHaveBeenCalled();
  });

  it("LLM prompt biases toward question + lists explicit investigation verbs", async () => {
    mockLlmResponse(JSON.stringify({ intent: "question", service: "" }));
    const router = new IntentRouter(dummyModel);
    await router.route("hey there");
    const callArgs = mockGenerateText.mock.calls[0]![0] as any;
    // Greeting example still present
    expect(callArgs.system).toContain('"hi" → question');
    // New conservative prompt: explicit investigation verbs only
    expect(callArgs.system).toContain("investigate <service>");
    expect(callArgs.system).toContain("diagnose");
    expect(callArgs.system).toContain("RCA");
    // New prompt explicitly tells the LLM the chat agent has tools
    expect(callArgs.system).toContain("Prometheus");
    expect(callArgs.system).toContain("Loki");
    // Default-to-question rule
    expect(callArgs.system.toLowerCase()).toContain("default to \"question\"");
  });

  it("matchServiceFromText drops 'k8s' platform token (regression: k8s-mcp false-match)", async () => {
    // "k8s" used to token-overlap with "k8s-mcp" service tokens — adding it
    // to GENERIC_INFRA_TOKENS prevents the overlap.
    const result = matchServiceFromText("init hook k8s job", [{ name: "k8s-mcp" } as ServiceConfig]);
    expect(result).toBeUndefined();
  });

  // --- LLM classification tests (no fast-path keywords) ---

  it("classifies investigation intent via LLM when no keyword match", async () => {
    mockLlmResponse(JSON.stringify({ intent: "investigation", service: "payments-api" }));
    const router = new IntentRouter(dummyModel);
    const result = await router.route("payments-api errors are spiking");
    expect(result.intent).toBe("investigation");
    if (result.intent === "investigation") {
      expect(result.service).toBe("payments-api");
    }
  });

  it("passes service names context to generateText", async () => {
    mockLlmResponse(JSON.stringify({ intent: "investigation", service: "ingestion-server" }));
    const router = new IntentRouter(dummyModel);
    await router.route("ingestion-server seems unusual today", ["ingestion-server", "payments-api"]);
    const callArgs = mockGenerateText.mock.calls[0]![0] as any;
    expect(callArgs.system).toContain("ingestion-server");
    expect(callArgs.system).toContain("payments-api");
    expect(callArgs.system).toContain("known services");
  });

  it("classifies question intent", async () => {
    mockLlmResponse(JSON.stringify({ intent: "question", service: "" }));
    const router = new IntentRouter(dummyModel);
    const result = await router.route("what is the error rate?");
    expect(result.intent).toBe("question");
  });

  it("falls back to question on parse error", async () => {
    mockLlmResponse("not valid json");
    const router = new IntentRouter(dummyModel);
    const result = await router.route("how does this system work?");
    expect(result.intent).toBe("question");
  });

  it("falls back to question on application-level LLM error", async () => {
    // Non-transient error (auth failure) — should NOT trigger retry, falls back gracefully.
    mockLlmError(new Error("invalid api key"));
    const router = new IntentRouter(dummyModel);
    // Use a message that bypasses keyword fast-paths so the LLM path runs.
    const result = await router.route("payments-api errors are spiking");
    expect(result.intent).toBe("question");
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  it("retries transient LLM errors before succeeding", async () => {
    let calls = 0;
    mockGenerateText.mockImplementation(async () => {
      calls += 1;
      if (calls < 3) throw new Error("ECONNREFUSED");
      return { text: JSON.stringify({ intent: "investigation", service: "payments-api" }) } as any;
    });
    const router = new IntentRouter(dummyModel, { maxAttempts: 5, initialDelayMs: 1, maxDelayMs: 5 });
    const result = await router.route("payments-api errors are spiking");
    expect(calls).toBe(3);
    expect(result.intent).toBe("investigation");
    if (result.intent === "investigation") {
      expect(result.service).toBe("payments-api");
    }
  });

  it("rethrows LlmUnavailableError when LLM is persistently down", async () => {
    const { LlmUnavailableError } = await import("./shared/llm-errors.js");
    mockGenerateText.mockRejectedValue(new Error("ECONNREFUSED"));
    const router = new IntentRouter(dummyModel, { maxAttempts: 2, initialDelayMs: 1 });
    await expect(router.route("payments-api errors are spiking"))
      .rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it("passes an AbortSignal to generateText when llmCallMs is set", async () => {
    mockLlmResponse(JSON.stringify({ intent: "question", service: "" }));
    const router = new IntentRouter(dummyModel, { maxAttempts: 1 }, 60_000);
    await router.route("payments-api errors are spiking");
    const callArgs = mockGenerateText.mock.calls[0]![0] as any;
    expect(callArgs.abortSignal).toBeInstanceOf(AbortSignal);
    // Signal is fresh (not aborted) — the timeout hasn't fired yet.
    expect(callArgs.abortSignal.aborted).toBe(false);
  });

  it("omits abortSignal when llmCallMs is not provided", async () => {
    mockLlmResponse(JSON.stringify({ intent: "question", service: "" }));
    const router = new IntentRouter(dummyModel);
    await router.route("payments-api errors are spiking");
    const callArgs = mockGenerateText.mock.calls[0]![0] as any;
    expect(callArgs.abortSignal).toBeUndefined();
  });

  it("treats TimeoutError from a fired AbortSignal.timeout as transient and retries", async () => {
    let calls = 0;
    mockGenerateText.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        // AbortSignal.timeout() aborts with a TimeoutError DOMException.
        // The AI SDK rethrows that name, which isLlmUnavailable now matches.
        const err = new Error("The operation timed out");
        err.name = "TimeoutError";
        throw err;
      }
      return { text: JSON.stringify({ intent: "investigation", service: "payments-api" }) } as any;
    });
    const router = new IntentRouter(
      dummyModel,
      { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 5 },
      60_000,
    );
    const result = await router.route("payments-api errors are spiking");
    expect(calls).toBe(2);
    expect(result.intent).toBe("investigation");
  });

  it("uses a fresh AbortSignal for the retry after a timeout", async () => {
    let calls = 0;
    const signals: AbortSignal[] = [];
    let secondSignalSameAsFirst: boolean | undefined;
    let secondSignalAbortedOnEntry: boolean | undefined;

    mockGenerateText.mockImplementation(async (args: any) => {
      calls += 1;
      const signal = args.abortSignal as AbortSignal;
      signals.push(signal);

      if (calls === 1) {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw signal.reason;
      }

      secondSignalSameAsFirst = signal === signals[0];
      secondSignalAbortedOnEntry = signal.aborted;
      return { text: JSON.stringify({ intent: "investigation", service: "payments-api" }) } as any;
    });

    const router = new IntentRouter(
      dummyModel,
      { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 1, jitterPercent: 0 },
      1,
    );

    const result = await router.route("payments-api errors are spiking");
    expect(result.intent).toBe("investigation");
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(secondSignalSameAsFirst).toBe(false);
    expect(secondSignalAbortedOnEntry).toBe(false);
  });
});

describe("setServiceAliases", () => {
  afterEach(() => {
    // Reset to defaults after each test to avoid state leaking between tests
    setServiceAliases({});
  });

  it("overrides default aliases with config values", () => {
    setServiceAliases({ myapp: ["my-app-server"] });
    expect(messageMatchesAnyService("check myapp status", ["my-app-server"])).toBe(true);
  });

  it("merges config aliases over defaults (defaults still work)", () => {
    setServiceAliases({ myapp: ["my-app-server"] });
    // Default alias 'kafka' should still work
    expect(messageMatchesAnyService("kafka errors are spiking", ["some-other-service"])).toBe(true);
  });

  it("custom alias resolves to target service via matchService", () => {
    setServiceAliases({ pg: ["stolon-proxy"] });
    const services = [svc("stolon-proxy"), svc("redis-ha")];
    expect(matchService("pg", services)?.name).toBe("stolon-proxy");
  });

  it("custom alias resolves via matchServiceFromText", () => {
    setServiceAliases({ myapp: ["my-app-server"] });
    const services = [svc("my-app-server"), svc("other-service")];
    expect(matchServiceFromText("myapp is throwing errors", services)?.name).toBe("my-app-server");
  });
});
