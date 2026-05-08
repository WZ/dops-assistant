import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import { createTool } from "@mastra/core/tools";
import { loadConfig } from "../src/config/loader.js";
import { createModel } from "../src/mastra/index.js";
import { runDiscovery } from "../src/workflows/discovery.js";
import {
  scoreBenchmarkRun,
  summarizeBenchmarkRuns,
  type BenchmarkEvent,
  type BenchmarkRunScore,
} from "../src/eval/discovery-benchmark.js";
import type { MastraProvider } from "../src/mcp/provider.js";
import type { DiscoveryConfig } from "../src/config/schema.js";

interface CliArgs {
  iterations: number;
  round: string;
  outDir: string;
  configPath: string;
  llmTimeoutMs: number;
  maxIterations: number;
  maxOutputTokens: number;
  maxToolResultChars: number;
  retryAttempts: number;
}

interface FixtureService {
  name: string;
  namespace: string;
  kind: "deployment" | "statefulset" | "daemonset";
  app: string;
  container: string;
}

const fixtureServices: FixtureService[] = [
  { name: "checkout-api", namespace: "checkout", kind: "deployment", app: "checkout-api", container: "api" },
  { name: "payments-worker", namespace: "payments", kind: "deployment", app: "payments-worker", container: "worker" },
  { name: "postgres-main", namespace: "data", kind: "statefulset", app: "postgres-main", container: "postgres" },
  { name: "redis-cache", namespace: "data", kind: "statefulset", app: "redis-cache", container: "redis" },
  { name: "node-agent", namespace: "platform", kind: "daemonset", app: "node-agent", container: "agent" },
];

const anySchema = z.object({}).passthrough();

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    iterations: 20,
    round: "round-1",
    outDir: "tmp/discovery-benchmark",
    configPath: "dev/config.yaml",
    llmTimeoutMs: 60_000,
    maxIterations: 10,
    maxOutputTokens: 4096,
    maxToolResultChars: 8000,
    retryAttempts: 1,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--iterations" && next) args.iterations = Number(argv[++i]);
    else if (arg === "--round" && next) args.round = argv[++i]!;
    else if (arg === "--out-dir" && next) args.outDir = argv[++i]!;
    else if (arg === "--config" && next) args.configPath = argv[++i]!;
    else if (arg === "--llm-timeout-ms" && next) args.llmTimeoutMs = Number(argv[++i]);
    else if (arg === "--max-iterations" && next) args.maxIterations = Number(argv[++i]);
    else if (arg === "--max-output-tokens" && next) args.maxOutputTokens = Number(argv[++i]);
    else if (arg === "--max-tool-result-chars" && next) args.maxToolResultChars = Number(argv[++i]);
    else if (arg === "--retry-attempts" && next) args.retryAttempts = Number(argv[++i]);
  }
  return args;
}

function asText(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }] };
}

function promVector(metrics: Array<Record<string, string>>): unknown {
  return {
    status: "success",
    data: {
      resultType: "vector",
      result: metrics.map((metric, i) => ({
        metric,
        value: [Date.now() / 1000, String(i + 1)],
      })),
    },
  };
}

function serviceMentioned(query: string, service: FixtureService): boolean {
  return query.includes(service.name) ||
    query.includes(service.app) ||
    query.includes(`container="${service.container}"`) ||
    query.includes(`namespace="${service.namespace}"`);
}

function queryPrometheus(args: Record<string, unknown>): unknown {
  const query = String(args["query"] ?? args["expr"] ?? args["expression"] ?? "");

  if (query.includes("kube_deployment_status_replicas")) {
    return promVector(fixtureServices
      .filter((service) => service.kind === "deployment")
      .map((service) => ({ deployment: service.name, namespace: service.namespace, app: service.app })));
  }
  if (query.includes("kube_statefulset_status_replicas")) {
    return promVector(fixtureServices
      .filter((service) => service.kind === "statefulset")
      .map((service) => ({ statefulset: service.name, namespace: service.namespace, app: service.app })));
  }
  if (query.includes("kube_daemonset_status")) {
    return promVector(fixtureServices
      .filter((service) => service.kind === "daemonset")
      .map((service) => ({ daemonset: service.name, namespace: service.namespace, app: service.app })));
  }
  if (query.includes("kube_pod_container_info") || query.includes("kube_pod_info")) {
    return promVector(fixtureServices.map((service) => ({
      pod: `${service.name}-6f9d7c8b7-x1y2z`,
      namespace: service.namespace,
      container: service.container,
      app: service.app,
    })));
  }
  if (query.includes("up")) {
    if (fixtureServices.some((service) => serviceMentioned(query, service))) {
      return promVector(fixtureServices
        .filter((service) => serviceMentioned(query, service))
        .map((service) => ({ job: service.name, app: service.app, namespace: service.namespace })));
    }
    return promVector(fixtureServices.map((service) => ({
      job: service.name,
      app: service.app,
      namespace: service.namespace,
    })));
  }
  if (fixtureServices.some((service) => serviceMentioned(query, service))) {
    return promVector(fixtureServices
      .filter((service) => serviceMentioned(query, service))
      .map((service) => ({ service: service.name })));
  }
  return promVector([]);
}

function podsTable(): string {
  const header = "NAMESPACE APIVERSION KIND NAME READY STATUS RESTARTS AGE IP NODE LABELS";
  const rows = fixtureServices.map((service, index) => [
    service.namespace,
    "v1",
    "Pod",
    `${service.name}-6f9d7c8b7-x1y2z`,
    "1/1",
    "Running",
    "0",
    "2d",
    `10.0.0.${index + 10}`,
    `node-${index + 1}`,
    `app=${service.app},container=${service.container}`,
  ].join(" "));
  return [header, ...rows].join("\n");
}

function labelValues(labelName: unknown): string[] {
  switch (labelName) {
    case "namespace":
      return [...new Set(fixtureServices.map((service) => service.namespace))];
    case "container":
      return [...new Set(fixtureServices.map((service) => service.container))];
    case "app":
      return fixtureServices.map((service) => service.app);
    case "pod":
      return fixtureServices.map((service) => `${service.name}-6f9d7c8b7-x1y2z`);
    case "job":
      return fixtureServices.map((service) => service.name);
    default:
      return [];
  }
}

function queryLoki(args: Record<string, unknown>): unknown {
  const query = String(args["query"] ?? args["expr"] ?? "");
  const matched = fixtureServices.find((service) => serviceMentioned(query, service)) ?? fixtureServices[0]!;
  return {
    status: "success",
    data: {
      result: [{
        stream: { namespace: matched.namespace, container: matched.container, app: matched.app },
        values: [[String(Date.now() * 1_000_000), "healthy request completed"]],
      }],
    },
  };
}

function createFixtureProvider(): MastraProvider {
  const tools = {
    fixture_list_datasources: createTool({
      id: "fixture_list_datasources",
      description: "List available monitoring datasources.",
      inputSchema: anySchema,
      execute: async () => asText({
        datasources: [
          { uid: "prom-fixture", name: "Prometheus fixture", type: "prometheus" },
          { uid: "loki-fixture", name: "Loki fixture", type: "loki" },
        ],
      }),
    }),
    fixture_query_prometheus: createTool({
      id: "fixture_query_prometheus",
      description: "Run a Prometheus instant or range query.",
      inputSchema: anySchema,
      execute: async (args: Record<string, unknown>) => asText(queryPrometheus(args)),
    }),
    fixture_namespaces_list: createTool({
      id: "fixture_namespaces_list",
      description: "List Kubernetes namespaces.",
      inputSchema: anySchema,
      execute: async () => asText({ items: [...new Set(fixtureServices.map((service) => service.namespace))] }),
    }),
    fixture_pods_list: createTool({
      id: "fixture_pods_list",
      description: "List Kubernetes pods with namespaces, names, status, and labels.",
      inputSchema: anySchema,
      execute: async () => asText(podsTable()),
    }),
    fixture_list_loki_label_names: createTool({
      id: "fixture_list_loki_label_names",
      description: "List Loki label names.",
      inputSchema: anySchema,
      execute: async () => asText(["namespace", "container", "pod", "app", "job"]),
    }),
    fixture_list_loki_label_values: createTool({
      id: "fixture_list_loki_label_values",
      description: "List Loki label values for a label name.",
      inputSchema: anySchema,
      execute: async (args: Record<string, unknown>) => asText(labelValues(args["labelName"])),
    }),
    fixture_query_loki_logs: createTool({
      id: "fixture_query_loki_logs",
      description: "Run a Loki log query.",
      inputSchema: anySchema,
      execute: async (args: Record<string, unknown>) => asText(queryLoki(args)),
    }),
  };

  return {
    name: "fixture",
    roles: ["metrics", "logs", "infrastructure", "dashboards"],
    client: { listTools: async () => tools } as unknown as MastraProvider["client"],
  };
}

function benchmarkDiscoveryConfig(base: DiscoveryConfig, args: CliArgs): DiscoveryConfig {
  return {
    ...base,
    maxIterations: args.maxIterations,
    maxOutputTokens: args.maxOutputTokens,
    maxToolResultChars: args.maxToolResultChars,
    discoveryRecipes: [{
      providerType: "fixture-k8s",
      serviceQueries: [
        'count by (deployment) (kube_deployment_status_replicas_available)',
        'count by (statefulset) (kube_statefulset_status_replicas_ready)',
        'count by (daemonset) (kube_daemonset_status_number_ready)',
        'count by (app) (kube_pod_info)',
        'count by (job) (up)',
      ],
      labelKeys: ["app", "job", "namespace", "container"],
    }],
  };
}

async function runOne(args: CliArgs, iteration: number): Promise<BenchmarkRunScore> {
  const config = loadConfig(args.configPath);
  const model = createModel(config.llm);
  const provider = createFixtureProvider();
  const events: BenchmarkEvent[] = [];
  const started = Date.now();
  const mark = () => Date.now() - started;

  try {
    const result = await runDiscovery({
      model,
      providers: [provider],
      discoveryConfig: benchmarkDiscoveryConfig(config.discovery, args),
      llmRetry: { maxAttempts: args.retryAttempts },
      llmCallMs: args.llmTimeoutMs,
      onPhase: (phase) => events.push({ type: "phase", phase, tMs: mark() }),
      onIteration: (phase, step, maxIterations, description) => events.push({
        type: "iteration",
        phase,
        iteration: step,
        maxIterations,
        description,
        tMs: mark(),
      }),
      onToolCall: (tool, _toolArgs, _result, durationMs, error, phase) => events.push({
        type: "tool",
        phase,
        tool,
        durationMs,
        error,
        tMs: mark(),
      }),
      onRetry: (attempt, maxRetries, reason) => events.push({
        type: "retry",
        attempt,
        maxRetries,
        reason,
        tMs: mark(),
      }),
    });
    return scoreBenchmarkRun({
      round: args.round,
      iteration,
      expectedServices: fixtureServices.map((service) => service.name),
      durationMs: mark(),
      events,
      result,
    });
  } catch (err) {
    return scoreBenchmarkRun({
      round: args.round,
      iteration,
      expectedServices: fixtureServices.map((service) => service.name),
      durationMs: mark(),
      events,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function main(): Promise<void> {
  loadDotenv({ path: "dev/.env" });
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(args.outDir);
  mkdirSync(outDir, { recursive: true });
  const jsonlPath = join(outDir, `${args.round}.jsonl`);
  const summaryPath = join(outDir, `${args.round}-summary.json`);
  writeFileSync(jsonlPath, "");

  const runs: BenchmarkRunScore[] = [];
  for (let i = 1; i <= args.iterations; i++) {
    const run = await runOne(args, i);
    runs.push(run);
    appendFileSync(jsonlPath, `${JSON.stringify(run)}\n`);
    console.log([
      `${args.round} ${i}/${args.iterations}`,
      `success=${run.success}`,
      `score=${run.evalScore}`,
      `recall=${run.serviceRecall}`,
      `rules=${run.requiredRuleCoverage}`,
      `verified=${run.verifiedRatio}`,
      `durationMs=${run.durationMs}`,
      run.error ? `error=${run.error}` : "",
    ].filter(Boolean).join(" "));
  }

  const summary = summarizeBenchmarkRuns(args.round, runs);
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
