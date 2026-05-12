import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { parse as parseYaml } from "yaml";
import type { ServiceConfig } from "../src/config/schema.js";
import type { DiscoveryResult } from "../src/types/agent-interfaces.js";
import type { BenchmarkEvent, BenchmarkRunScore } from "../src/eval/discovery-benchmark.js";
import { scoreBenchmarkRun, summarizeBenchmarkRuns } from "../src/eval/discovery-benchmark.js";

interface CliArgs {
  iterations: number;
  round: string;
  outDir: string;
  appUrl: string;
  stackId: string;
  baseline: string;
  timeoutMs: number;
}

interface ServerMessage {
  type?: string;
  phase?: string;
  iteration?: number;
  maxIterations?: number;
  description?: string;
  tool?: string;
  args?: Record<string, unknown>;
  status?: string;
  result?: string;
  durationMs?: number;
  services?: ServiceConfig[];
  message?: string;
  attempt?: number;
  maxRetries?: number;
  reason?: string;
  inputTokens?: number;
  outputTokens?: number;
}

interface AppRunArtifact extends BenchmarkRunScore {
  totalUsage?: {
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
  };
  toolCalls: Array<{
    phase: string;
    tool: string;
    status: string;
    args?: Record<string, unknown>;
    resultChars: number;
    durationMs?: number;
  }>;
  discoveredNames: string[];
  serviceMetricCounts: Record<string, number>;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    iterations: 1,
    round: "app-eval",
    outDir: "tmp/discovery-app-eval",
    appUrl: "http://localhost:3000",
    stackId: "",
    baseline: "",
    timeoutMs: 600_000,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--iterations" && next) args.iterations = Number(argv[++i]);
    else if (arg === "--round" && next) args.round = argv[++i]!;
    else if (arg === "--out-dir" && next) args.outDir = argv[++i]!;
    else if (arg === "--app-url" && next) args.appUrl = argv[++i]!;
    else if (arg === "--stack-id" && next) args.stackId = argv[++i]!;
    else if (arg === "--baseline" && next) args.baseline = argv[++i]!;
    else if (arg === "--timeout-ms" && next) args.timeoutMs = Number(argv[++i]);
  }

  if (!args.stackId) throw new Error("--stack-id is required");
  if (!args.baseline) throw new Error("--baseline is required");
  return args;
}

function loadBaseline(path: string): ServiceConfig[] {
  const raw = readFileSync(path, "utf8");
  const parsed = parseYaml(raw) as unknown;
  const services = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === "object" ? (parsed as { services?: unknown }).services : undefined);
  if (!Array.isArray(services)) {
    throw new Error(`Baseline file does not contain a services array: ${path}`);
  }
  return services as ServiceConfig[];
}

function wsUrl(appUrl: string, stackId: string): string {
  const url = new URL(appUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.searchParams.set("stackId", stackId);
  return url.toString();
}

function resultChars(result: unknown): number {
  if (typeof result === "string") return result.length;
  if (result === undefined || result === null) return 0;
  return JSON.stringify(result).length;
}

async function runAppDiscovery(args: CliArgs, expectedServices: string[], iteration: number): Promise<AppRunArtifact> {
  const events: BenchmarkEvent[] = [];
  const toolCalls: AppRunArtifact["toolCalls"] = [];
  const started = Date.now();
  const mark = () => Date.now() - started;
  let totalUsage: AppRunArtifact["totalUsage"];

  const appResult = await new Promise<{ services?: ServiceConfig[]; error?: string }>((resolveRun) => {
    const ws = new WebSocket(wsUrl(args.appUrl, args.stackId));
    let settled = false;
    const finish = (result: { services?: ServiceConfig[]; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        ws.close();
      } catch {
        // ignore close failures during teardown
      }
      resolveRun(result);
    };
    const timeout = setTimeout(() => {
      finish({ error: `Timed out after ${args.timeoutMs}ms` });
    }, args.timeoutMs);

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "discover" }));
    });

    ws.on("message", (data) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(data.toString()) as ServerMessage;
      } catch {
        return;
      }

      if (msg.type === "discover:phase") {
        events.push({ type: "phase", phase: msg.phase, tMs: mark() });
      } else if (msg.type === "discover:iteration") {
        events.push({
          type: "iteration",
          phase: msg.phase,
          iteration: msg.iteration,
          maxIterations: msg.maxIterations,
          description: msg.description,
          tMs: mark(),
        });
      } else if (msg.type === "discover:tool_call") {
        events.push({
          type: "tool",
          phase: msg.phase,
          tool: msg.tool,
          durationMs: msg.durationMs,
          error: msg.status === "error" ? msg.result ?? "tool error" : undefined,
          tMs: mark(),
        });
        toolCalls.push({
          phase: msg.phase ?? "discovery",
          tool: msg.tool ?? "unknown",
          status: msg.status ?? "unknown",
          args: msg.args,
          resultChars: resultChars(msg.result),
          durationMs: msg.durationMs,
        });
      } else if (msg.type === "discover:retry") {
        events.push({
          type: "retry",
          attempt: msg.attempt,
          maxRetries: msg.maxRetries,
          reason: msg.reason,
          tMs: mark(),
        });
      } else if (msg.type === "discover:total_usage") {
        totalUsage = {
          inputTokens: msg.inputTokens ?? 0,
          outputTokens: msg.outputTokens ?? 0,
          durationMs: msg.durationMs ?? mark(),
        };
      } else if (msg.type === "discover:complete") {
        finish({ services: msg.services ?? [] });
      } else if (msg.type === "discover:error") {
        finish({ error: msg.message ?? "Discovery failed" });
      }
    });

    ws.on("error", (err) => {
      finish({ error: err instanceof Error ? err.message : String(err) });
    });

    ws.on("close", () => {
      if (!settled) finish({ error: "WebSocket closed before discovery completed" });
    });
  });

  const result: DiscoveryResult | undefined = appResult.services
    ? { services: appResult.services, globalProbeRules: [] }
    : undefined;
  const score = scoreBenchmarkRun({
    round: args.round,
    iteration,
    expectedServices,
    durationMs: mark(),
    events,
    result,
    error: appResult.error,
  });

  const services = appResult.services ?? [];
  const serviceMetricCounts: Record<string, number> = {};
  for (const s of services) {
    serviceMetricCounts[s.name] = (s.metrics ?? []).length;
  }
  return {
    ...score,
    totalUsage,
    toolCalls,
    discoveredNames: services.map((s) => s.name).sort(),
    serviceMetricCounts,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(args.outDir);
  mkdirSync(outDir, { recursive: true });
  const baseline = loadBaseline(resolve(args.baseline));
  const expectedServices = baseline.map((s) => s.name).sort();
  const jsonlPath = join(outDir, `${args.round}.jsonl`);
  const summaryPath = join(outDir, `${args.round}-summary.json`);
  writeFileSync(jsonlPath, "");

  const runs: AppRunArtifact[] = [];
  for (let i = 1; i <= args.iterations; i++) {
    const run = await runAppDiscovery(args, expectedServices, i);
    runs.push(run);
    appendFileSync(jsonlPath, `${JSON.stringify(run)}\n`);
    console.log([
      `${args.round} ${i}/${args.iterations}`,
      `success=${run.success}`,
      `score=${run.evalScore}`,
      `services=${run.serviceCount}/${run.expectedCount}`,
      `recall=${run.serviceRecall}`,
      `precision=${run.servicePrecision}`,
      `missing=${run.missingServices.length}`,
      `extra=${run.extraServices.length}`,
      `toolCalls=${run.toolCallCount}`,
      `durationMs=${run.durationMs}`,
      run.error ? `error=${run.error}` : "",
    ].filter(Boolean).join(" "));
  }

  const summary = {
    ...summarizeBenchmarkRuns(args.round, runs),
    expectedServiceCount: expectedServices.length,
    baseline: resolve(args.baseline),
    appUrl: args.appUrl,
    stackId: args.stackId,
    mostCommonMissingServices: countOccurrences(runs.flatMap((r) => r.missingServices)),
    mostCommonExtraServices: countOccurrences(runs.flatMap((r) => r.extraServices)),
  };
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

function countOccurrences(values: string[]): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, 50);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
