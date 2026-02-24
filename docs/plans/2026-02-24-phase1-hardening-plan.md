# Phase 1 Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Harden dops-assistant into a production-ready service with timeouts, retries, observability, correlation IDs, and structured anomaly detection.

**Architecture:** Add two utility modules (`src/utils/`) and one observability module (`src/observability/`), then apply them to all existing modules in-place. No new abstraction layers — each module is updated independently.

**Tech Stack:** TypeScript, Vitest, `prom-client` (new dep), Node.js built-in `http` and `crypto`

---

## Task 1: Install prom-client

**Files:**
- Modify: `package.json`

**Step 1: Install the dependency**

```bash
cd /Users/wli02/Documents/workspace_work/WZ/dops-assistant/.worktrees/mvp
npm install prom-client
```

Expected: `package.json` and `package-lock.json` updated with `prom-client`.

**Step 2: Verify**

```bash
node -e "import('prom-client').then(m => console.log('ok', Object.keys(m)))"
```

Expected: prints `ok` followed by exported names.

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: add prom-client dependency"
```

---

## Task 2: Config schema additions

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `config.yaml.example`

**Step 1: Write the failing test**

Add to the end of `src/config/schema.test.ts` (create if it doesn't exist):

```ts
import { describe, it, expect } from "vitest";
import { ConfigSchema } from "./schema.js";

describe("ConfigSchema – new sections", () => {
  it("applies default values for timeouts, retry, and observability", () => {
    const result = ConfigSchema.parse({
      llm: { apiKey: "k", model: "gpt-4", maxTokens: 1000 },
      grafana: { mcpServer: { command: "npx", args: [] } },
    });
    expect(result.timeouts.mcpConnectMs).toBe(30_000);
    expect(result.timeouts.llmCallMs).toBe(60_000);
    expect(result.timeouts.toolExecutionMs).toBe(30_000);
    expect(result.timeouts.agentIterationMs).toBe(90_000);
    expect(result.retry.maxAttempts).toBe(3);
    expect(result.retry.baseDelayMs).toBe(500);
    expect(result.observability.port).toBe(9090);
    expect(result.observability.logLevel).toBe("info");
  });

  it("accepts alertCooldownMinutes on anomalyCheck", () => {
    const result = ConfigSchema.parse({
      llm: { apiKey: "k", model: "gpt-4", maxTokens: 1000 },
      grafana: { mcpServer: { command: "npx", args: [] } },
      scheduler: { anomalyCheck: { interval: "5m", alertCooldownMinutes: 15 } },
    });
    expect(result.scheduler.anomalyCheck?.alertCooldownMinutes).toBe(15);
  });
});
```

**Step 2: Run to verify it fails**

```bash
npx vitest run src/config/schema.test.ts
```

Expected: FAIL — `result.timeouts` is undefined.

**Step 3: Update `src/config/schema.ts`**

Add these schemas before `ConfigSchema`:

```ts
const TimeoutsSchema = z.object({
  mcpConnectMs: z.number().default(30_000),
  llmCallMs: z.number().default(60_000),
  toolExecutionMs: z.number().default(30_000),
  agentIterationMs: z.number().default(90_000),
});

const RetrySchema = z.object({
  maxAttempts: z.number().default(3),
  baseDelayMs: z.number().default(500),
});

const ObservabilitySchema = z.object({
  port: z.number().default(9090),
  logLevel: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
});
```

Add `alertCooldownMinutes` to `AnomalyCheckSchema`:

```ts
const AnomalyCheckSchema = z.object({
  interval: z.string().default("5m"),
  services: z.array(z.string()).optional(),
  maxConcurrency: z.number().default(3),
  alertCooldownMinutes: z.number().default(30),
});
```

Add the three new sections to `ConfigSchema`:

```ts
export const ConfigSchema = z.object({
  llm: LlmSchema,
  grafana: GrafanaSchema,
  services: z.array(ServiceSchema).default([]),
  scheduler: SchedulerSchema.optional().default({}),
  agent: AgentSchema.optional().default({}),
  notifications: NotificationsSchema.optional().default({}),
  interfaces: InterfacesSchema.optional().default({}),
  timeouts: TimeoutsSchema.optional().default({}),
  retry: RetrySchema.optional().default({}),
  observability: ObservabilitySchema.optional().default({}),
});
```

Export the new types at the bottom of the file:

```ts
export type TimeoutsConfig = z.infer<typeof TimeoutsSchema>;
export type RetryConfig = z.infer<typeof RetrySchema>;
export type ObservabilityConfig = z.infer<typeof ObservabilitySchema>;
```

**Step 4: Update `config.yaml.example`** — append at the end:

```yaml
timeouts:
  mcpConnectMs: 30000
  llmCallMs: 60000
  toolExecutionMs: 30000
  agentIterationMs: 90000

retry:
  maxAttempts: 3
  baseDelayMs: 500

scheduler:
  anomalyCheck:
    interval: "5m"
    services:
      - payments-api
      - checkout-service
    maxConcurrency: 3
    alertCooldownMinutes: 30

observability:
  port: 9090
  logLevel: info
```

**Step 5: Run to verify it passes**

```bash
npx vitest run src/config/schema.test.ts
```

Expected: PASS.

**Step 6: Run full suite to check no regressions**

```bash
npm test
```

Expected: all tests pass.

**Step 7: Commit**

```bash
git add src/config/schema.ts config.yaml.example src/config/schema.test.ts
git commit -m "feat: add timeouts, retry, observability config sections"
```

---

## Task 3: Timeout utility

**Files:**
- Create: `src/utils/timeout.ts`
- Create: `src/utils/timeout.test.ts`

**Step 1: Write the failing test**

Create `src/utils/timeout.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { withTimeout, TimeoutError } from "./timeout.js";

describe("withTimeout", () => {
  it("resolves when promise completes before timeout", async () => {
    const result = await withTimeout(Promise.resolve(42), 1000, "test");
    expect(result).toBe(42);
  });

  it("rejects with TimeoutError when promise exceeds deadline", async () => {
    vi.useFakeTimers();
    const hanging = new Promise<never>(() => {});
    const p = withTimeout(hanging, 500, "hang-op");
    vi.advanceTimersByTime(501);
    await expect(p).rejects.toBeInstanceOf(TimeoutError);
    vi.useRealTimers();
  });

  it("TimeoutError carries label and ms", async () => {
    vi.useFakeTimers();
    const p = withTimeout(new Promise<never>(() => {}), 200, "my-op");
    vi.advanceTimersByTime(201);
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).label).toBe("my-op");
    expect((err as TimeoutError).ms).toBe(200);
    vi.useRealTimers();
  });

  it("propagates rejection from the original promise", async () => {
    const cause = new Error("original");
    await expect(withTimeout(Promise.reject(cause), 1000, "test")).rejects.toThrow("original");
  });

  it("does not fire timeout after promise resolves", async () => {
    vi.useFakeTimers();
    const p = withTimeout(Promise.resolve("done"), 500, "test");
    const result = await p;
    vi.advanceTimersByTime(600); // would have timed out
    expect(result).toBe("done"); // no unhandled rejection
    vi.useRealTimers();
  });
});
```

**Step 2: Run to verify it fails**

```bash
npx vitest run src/utils/timeout.test.ts
```

Expected: FAIL — module not found.

**Step 3: Create `src/utils/timeout.ts`**

```ts
export class TimeoutError extends Error {
  constructor(
    public readonly label: string,
    public readonly ms: number,
  ) {
    super(`${label} timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(label, ms));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
```

**Step 4: Run to verify it passes**

```bash
npx vitest run src/utils/timeout.test.ts
```

Expected: 5 tests pass.

**Step 5: Commit**

```bash
git add src/utils/timeout.ts src/utils/timeout.test.ts
git commit -m "feat: add withTimeout utility"
```

---

## Task 4: Retry utility

**Files:**
- Create: `src/utils/retry.ts`
- Create: `src/utils/retry.test.ts`

**Step 1: Write the failing test**

Create `src/utils/retry.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { withRetry, isRetryable } from "./retry.js";

describe("isRetryable", () => {
  it("returns true for HTTP 429", () => {
    expect(isRetryable({ status: 429 })).toBe(true);
  });
  it("returns true for HTTP 503", () => {
    expect(isRetryable({ status: 503 })).toBe(true);
  });
  it("returns false for HTTP 400", () => {
    expect(isRetryable({ status: 400 })).toBe(false);
  });
  it("returns true for ECONNRESET", () => {
    expect(isRetryable(new Error("ECONNRESET"))).toBe(true);
  });
  it("returns false for unknown error", () => {
    expect(isRetryable(new Error("some other error"))).toBe(false);
  });
});

describe("withRetry", () => {
  it("returns immediately on success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 0 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on retryable error and succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ status: 429 })
      .mockResolvedValue("ok");
    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 0 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws immediately on non-retryable error", async () => {
    const err = { status: 400 };
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 0 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("exhausts all attempts and throws last error", async () => {
    const err = { status: 503 };
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 0 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("respects custom retryOn predicate", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("custom"))
      .mockResolvedValue("done");
    const result = await withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 0,
      retryOn: (err) => err instanceof Error && err.message === "custom",
    });
    expect(result).toBe("done");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
```

**Step 2: Run to verify it fails**

```bash
npx vitest run src/utils/retry.test.ts
```

Expected: FAIL — module not found.

**Step 3: Create `src/utils/retry.ts`**

```ts
export function isRetryable(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "status" in err) {
    const status = (err as { status: number }).status;
    return status === 429 || status === 503;
  }
  if (err instanceof Error) {
    return (
      err.message.includes("ECONNRESET") ||
      err.message.includes("ENOTFOUND") ||
      err.message.includes("ETIMEDOUT")
    );
  }
  return false;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    maxAttempts: number;
    baseDelayMs: number;
    retryOn?: (err: unknown) => boolean;
  },
): Promise<T> {
  const shouldRetry = opts.retryOn ?? isRetryable;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === opts.maxAttempts || !shouldRetry(err)) throw err;
      const delay =
        opts.baseDelayMs *
        Math.pow(2, attempt - 1) *
        (0.5 + Math.random() * 0.5);
      await new Promise<void>((r) => setTimeout(r, Math.round(delay)));
    }
  }
  // unreachable — loop always throws or returns
  throw new Error("withRetry: unreachable");
}
```

**Step 4: Run to verify it passes**

```bash
npx vitest run src/utils/retry.test.ts
```

Expected: 10 tests pass.

**Step 5: Commit**

```bash
git add src/utils/retry.ts src/utils/retry.test.ts
git commit -m "feat: add withRetry utility"
```

---

## Task 5: Observability metrics module

**Files:**
- Create: `src/observability/metrics.ts`
- Create: `src/observability/metrics.test.ts`

**Step 1: Write the failing test**

Create `src/observability/metrics.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { registry, agentRunsTotal, toolCallsTotal, llmCallsTotal } from "./metrics.js";

beforeEach(() => {
  registry.resetMetrics();
});

describe("metrics", () => {
  it("agentRunsTotal increments by status", async () => {
    agentRunsTotal.inc({ status: "success" });
    agentRunsTotal.inc({ status: "success" });
    agentRunsTotal.inc({ status: "error" });
    const metrics = await registry.getMetricsAsJSON();
    const counter = metrics.find((m) => m.name === "agent_runs_total");
    expect(counter).toBeDefined();
    const values = counter!.values as Array<{ labels: { status: string }; value: number }>;
    expect(values.find((v) => v.labels.status === "success")?.value).toBe(2);
    expect(values.find((v) => v.labels.status === "error")?.value).toBe(1);
  });

  it("toolCallsTotal has tool and status labels", async () => {
    toolCallsTotal.inc({ tool: "query_prometheus", status: "success" });
    const metrics = await registry.getMetricsAsJSON();
    const counter = metrics.find((m) => m.name === "tool_calls_total");
    expect(counter).toBeDefined();
  });

  it("registry exposes Prometheus text format", async () => {
    llmCallsTotal.inc({ status: "success" });
    const text = await registry.metrics();
    expect(text).toContain("llm_calls_total");
  });
});
```

**Step 2: Run to verify it fails**

```bash
npx vitest run src/observability/metrics.test.ts
```

Expected: FAIL — module not found.

**Step 3: Create `src/observability/metrics.ts`**

```ts
import { Registry, Counter, Histogram } from "prom-client";

export const registry = new Registry();

export const agentRunsTotal = new Counter({
  name: "agent_runs_total",
  help: "Total number of agent runs",
  labelNames: ["status"] as const,
  registers: [registry],
});

export const agentIterations = new Histogram({
  name: "agent_iterations",
  help: "Number of iterations per agent run",
  buckets: [1, 3, 5, 10, 20],
  registers: [registry],
});

export const llmCallsTotal = new Counter({
  name: "llm_calls_total",
  help: "Total LLM API calls",
  labelNames: ["status"] as const,
  registers: [registry],
});

export const llmTokensUsedTotal = new Counter({
  name: "llm_tokens_used_total",
  help: "Total LLM tokens used",
  labelNames: ["type"] as const,
  registers: [registry],
});

export const toolCallsTotal = new Counter({
  name: "tool_calls_total",
  help: "Total MCP tool calls",
  labelNames: ["tool", "status"] as const,
  registers: [registry],
});

export const toolDurationSeconds = new Histogram({
  name: "tool_duration_seconds",
  help: "MCP tool call duration in seconds",
  labelNames: ["tool"] as const,
  registers: [registry],
});

export const schedulerChecksTotal = new Counter({
  name: "scheduler_checks_total",
  help: "Total scheduler service checks",
  labelNames: ["service", "status"] as const,
  registers: [registry],
});

export const slackMessagesTotal = new Counter({
  name: "slack_messages_total",
  help: "Total Slack messages handled",
  labelNames: ["status"] as const,
  registers: [registry],
});

export const alertNotificationsTotal = new Counter({
  name: "alert_notifications_total",
  help: "Total anomaly alert notifications sent",
  labelNames: ["status"] as const,
  registers: [registry],
});
```

**Step 4: Run to verify it passes**

```bash
npx vitest run src/observability/metrics.test.ts
```

Expected: 3 tests pass.

**Step 5: Commit**

```bash
git add src/observability/metrics.ts src/observability/metrics.test.ts
git commit -m "feat: add Prometheus metrics registry"
```

---

## Task 6: Observability HTTP server

**Files:**
- Create: `src/observability/server.ts`
- Create: `src/observability/server.test.ts`

**Step 1: Write the failing test**

Create `src/observability/server.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ObservabilityServer } from "./server.js";
import { registry } from "./metrics.js";

const TEST_PORT = 19090;

describe("ObservabilityServer", () => {
  let server: ObservabilityServer;

  beforeEach(async () => {
    registry.resetMetrics();
    server = new ObservabilityServer(TEST_PORT, () => true);
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("GET /health returns 200 when MCP connected", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; mcpConnected: boolean };
    expect(body.status).toBe("ok");
    expect(body.mcpConnected).toBe(true);
  });

  it("GET /health returns 503 when MCP disconnected", async () => {
    await server.stop();
    server = new ObservabilityServer(TEST_PORT, () => false);
    await server.start();
    const res = await fetch(`http://localhost:${TEST_PORT}/health`);
    expect(res.status).toBe(503);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("degraded");
  });

  it("GET /metrics returns Prometheus text format", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
  });

  it("GET /unknown returns 404", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/unknown`);
    expect(res.status).toBe(404);
  });
});
```

**Step 2: Run to verify it fails**

```bash
npx vitest run src/observability/server.test.ts
```

Expected: FAIL — module not found.

**Step 3: Create `src/observability/server.ts`**

```ts
import http from "node:http";
import { registry } from "./metrics.js";

export class ObservabilityServer {
  private server: http.Server;

  constructor(
    private readonly port: number,
    private readonly isMcpConnected: () => boolean,
  ) {
    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (req.url === "/health") {
      const connected = this.isMcpConnected();
      res.writeHead(connected ? 200 : 503, {
        "Content-Type": "application/json",
      });
      res.end(
        JSON.stringify({
          status: connected ? "ok" : "degraded",
          uptime: process.uptime(),
          mcpConnected: connected,
        }),
      );
    } else if (req.url === "/metrics") {
      const body = await registry.metrics();
      res.writeHead(200, { "Content-Type": registry.contentType });
      res.end(body);
    } else {
      res.writeHead(404);
      res.end();
    }
  }

  start(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.port, resolve));
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}
```

**Step 4: Run to verify it passes**

```bash
npx vitest run src/observability/server.test.ts
```

Expected: 4 tests pass.

**Step 5: Commit**

```bash
git add src/observability/server.ts src/observability/server.test.ts
git commit -m "feat: add /health and /metrics HTTP server"
```

---

## Task 7: Harden MCP client

**Files:**
- Modify: `src/mcp/client.ts`
- Modify: `src/mcp/client.test.ts`

**Step 1: Add test cases to `src/mcp/client.test.ts`**

Read the existing test file first, then append these test cases to the existing describe block (or add a new describe block):

```ts
import { TimeoutError } from "../utils/timeout.js";

// Add inside the existing describe or as a new describe:
describe("McpClient – timeouts and metrics", () => {
  it("throws TimeoutError if connect exceeds mcpConnectMs", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    vi.mocked(Client.prototype.connect).mockImplementation(
      () => new Promise(() => {}), // hangs forever
    );
    const client = new McpClient(
      { command: "npx", args: [], env: {}, enabledTools: undefined },
      { mcpConnectMs: 1, llmCallMs: 60_000, toolExecutionMs: 30_000, agentIterationMs: 90_000 },
    );
    await expect(client.connect()).rejects.toBeInstanceOf(TimeoutError);
  });

  it("exposes isConnected()", async () => {
    const client = new McpClient(
      { command: "npx", args: [], env: {}, enabledTools: undefined },
      { mcpConnectMs: 30_000, llmCallMs: 60_000, toolExecutionMs: 30_000, agentIterationMs: 90_000 },
    );
    expect(client.isConnected()).toBe(false);
  });
});
```

**Step 2: Run to verify new tests fail**

```bash
npx vitest run src/mcp/client.test.ts
```

Expected: new tests FAIL (constructor signature mismatch).

**Step 3: Update `src/mcp/client.ts`**

Replace the full file content:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerConfig, TimeoutsConfig } from "../config/schema.js";
import { withTimeout } from "../utils/timeout.js";
import { TimeoutError } from "../utils/timeout.js";
import {
  toolCallsTotal,
  toolDurationSeconds,
} from "../observability/metrics.js";

export type OpenAITool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export class McpClient {
  private config: McpServerConfig;
  private timeouts: TimeoutsConfig;
  private client: Client | null = null;
  private tools: OpenAITool[] = [];

  constructor(config: McpServerConfig, timeouts: TimeoutsConfig) {
    this.config = config;
    this.timeouts = timeouts;
  }

  async connect(): Promise<void> {
    if (this.client !== null) return;
    const transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args,
      env: { ...process.env, ...this.config.env } as Record<string, string>,
    });

    this.client = new Client(
      { name: "dops-assistant", version: "0.1.0" },
      { capabilities: {} },
    );

    await withTimeout(
      this.client.connect(transport),
      this.timeouts.mcpConnectMs,
      "MCP connect",
    );

    const { tools } = await this.client.listTools();

    const filtered = this.config.enabledTools
      ? tools.filter((t) => this.config.enabledTools!.includes(t.name))
      : tools;

    this.tools = filtered.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters: t.inputSchema as Record<string, unknown>,
      },
    }));
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  getTools(): OpenAITool[] {
    if (!this.client) throw new Error("MCP client not connected");
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.client) throw new Error("MCP client not connected");

    const end = toolDurationSeconds.startTimer({ tool: name });
    try {
      const result = await withTimeout(
        this.client.callTool({ name, arguments: args }),
        this.timeouts.toolExecutionMs,
        `tool:${name}`,
      );
      end();
      const parts = result.content as Array<{ type: string; text?: string }>;
      const text = parts
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("\n");
      toolCallsTotal.inc({ tool: name, status: "success" });
      return result.isError ? `[Tool Error] ${text}` : text;
    } catch (err) {
      end();
      toolCallsTotal.inc({
        tool: name,
        status: err instanceof TimeoutError ? "timeout" : "error",
      });
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    await this.client?.close();
    this.client = null;
    this.tools = [];
  }
}
```

**Step 4: Run to verify all MCP tests pass**

```bash
npx vitest run src/mcp/client.test.ts
```

Expected: all tests pass (existing + new).

**Step 5: Run full suite**

```bash
npm test
```

Expected: all pass (index.ts will fail to compile — fix in Task 13).

> Note: if TypeScript compile errors appear in index.ts for `new McpClient(...)` constructor, that is expected and will be fixed in Task 13. Run `npx vitest run src/mcp/` specifically to verify just MCP tests.

**Step 6: Commit**

```bash
git add src/mcp/client.ts src/mcp/client.test.ts
git commit -m "feat: add timeout and metrics to McpClient"
```

---

## Task 8: Harden LLM client

**Files:**
- Modify: `src/llm/openai.ts`
- Modify: `src/llm/openai.test.ts`

**Step 1: Add test cases to `src/llm/openai.test.ts`**

Read the existing test file, then append:

```ts
import { TimeoutError } from "../utils/timeout.js";

describe("LlmClient – timeout and retry", () => {
  it("wraps chat call with timeout", async () => {
    const { default: OpenAI } = await import("openai");
    vi.mocked(OpenAI.prototype.chat?.completions?.create ?? (() => {}))
      // Use the existing mock pattern from the file
      .mockImplementation(() => new Promise(() => {})); // hangs

    const client = new LlmClient(
      { apiKey: "k", model: "gpt-4", maxTokens: 100 },
      { mcpConnectMs: 30_000, llmCallMs: 1, toolExecutionMs: 30_000, agentIterationMs: 90_000 },
      { maxAttempts: 1, baseDelayMs: 0 },
    );
    await expect(client.chat([], [])).rejects.toBeInstanceOf(TimeoutError);
  });

  it("passes responseFormat to OpenAI when provided", async () => {
    // use existing mock setup from the file
    // verify that create() was called with response_format set
  });
});
```

> Tip: look at how the existing `src/llm/openai.test.ts` mocks `openai` and replicate the pattern for the new tests.

**Step 2: Run to verify new tests fail**

```bash
npx vitest run src/llm/openai.test.ts
```

Expected: new tests FAIL.

**Step 3: Replace `src/llm/openai.ts`**

```ts
import OpenAI from "openai";
import type { OpenAITool } from "../mcp/client.js";
import type { TimeoutsConfig, RetryConfig } from "../config/schema.js";
import { withTimeout } from "../utils/timeout.js";
import { withRetry } from "../utils/retry.js";
import {
  llmCallsTotal,
  llmTokensUsedTotal,
} from "../observability/metrics.js";

export type LlmConfig = {
  apiKey: string;
  model: string;
  maxTokens: number;
  baseURL?: string;
};

export type Message = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: OpenAI.Chat.ChatCompletionMessageToolCall[];
  name?: string;
};

export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

export type LlmResponse =
  | { type: "text"; content: string }
  | { type: "tool_calls"; calls: ToolCall[] };

export class LlmClient {
  private openai: OpenAI;
  private config: LlmConfig;
  private timeouts: TimeoutsConfig;
  private retry: RetryConfig;

  constructor(config: LlmConfig, timeouts: TimeoutsConfig, retry: RetryConfig) {
    this.config = config;
    this.timeouts = timeouts;
    this.retry = retry;
    this.openai = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    });
  }

  async chat(
    messages: Message[],
    tools: OpenAITool[],
    opts?: { responseFormat?: OpenAI.ResponseFormatJSONSchema },
  ): Promise<LlmResponse> {
    return withRetry(
      () =>
        withTimeout(
          this.doChat(messages, tools, opts),
          this.timeouts.llmCallMs,
          "LLM chat",
        ),
      {
        maxAttempts: this.retry.maxAttempts,
        baseDelayMs: this.retry.baseDelayMs,
      },
    );
  }

  private async doChat(
    messages: Message[],
    tools: OpenAITool[],
    opts?: { responseFormat?: OpenAI.ResponseFormatJSONSchema },
  ): Promise<LlmResponse> {
    let response: OpenAI.Chat.ChatCompletion;
    try {
      response = await this.openai.chat.completions.create({
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
        ...(tools.length > 0
          ? { tools: tools as OpenAI.Chat.ChatCompletionTool[] }
          : {}),
        ...(opts?.responseFormat
          ? { response_format: opts.responseFormat }
          : {}),
      });
      llmCallsTotal.inc({ status: "success" });
    } catch (err) {
      const isRateLimit =
        typeof err === "object" &&
        err !== null &&
        "status" in err &&
        (err as { status: number }).status === 429;
      llmCallsTotal.inc({ status: isRateLimit ? "rate_limited" : "error" });
      throw err;
    }

    if (response.usage) {
      llmTokensUsedTotal.inc(
        { type: "prompt" },
        response.usage.prompt_tokens,
      );
      llmTokensUsedTotal.inc(
        { type: "completion" },
        response.usage.completion_tokens,
      );
    }

    const choice = response.choices[0];
    if (!choice) {
      throw new Error(
        "LLM returned no choices (possible content filter or API error)",
      );
    }
    const message = choice.message;

    if (message.tool_calls && message.tool_calls.length > 0) {
      return {
        type: "tool_calls",
        calls: message.tool_calls.map((tc) => {
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          } catch {
            throw new Error(
              `Failed to parse tool arguments for "${tc.function.name}": ${tc.function.arguments}`,
            );
          }
          return { id: tc.id, name: tc.function.name, args };
        }),
      };
    }

    return { type: "text", content: message.content ?? "" };
  }
}
```

**Step 4: Run to verify all LLM tests pass**

```bash
npx vitest run src/llm/openai.test.ts
```

Expected: all tests pass.

**Step 5: Commit**

```bash
git add src/llm/openai.ts src/llm/openai.test.ts
git commit -m "feat: add timeout, retry, responseFormat, and token tracking to LlmClient"
```

---

## Task 9: Types and structured prompt for anomaly detection

**Files:**
- Modify: `src/agent/types.ts`
- Modify: `src/agent/prompts.ts`
- Modify: `src/agent/prompts.test.ts` (create if it doesn't exist)

**Step 1: Write the failing test**

Create `src/agent/prompts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  buildSystemPrompt,
  buildProactiveStructuredPrompt,
  ANOMALY_ASSESSMENT_RESPONSE_FORMAT,
} from "./prompts.js";

describe("buildProactiveStructuredPrompt", () => {
  it("includes service name and metrics", () => {
    const prompt = buildProactiveStructuredPrompt([
      {
        name: "payments-api",
        metrics: [{ query: 'rate(http_requests_total[5m])', description: "RPS" }],
        logLabels: { app: "payments" },
      },
    ]);
    expect(prompt).toContain("payments-api");
    expect(prompt).toContain("RPS");
    expect(prompt).toContain("json");
  });

  it("handles no services", () => {
    const prompt = buildProactiveStructuredPrompt([]);
    expect(typeof prompt).toBe("string");
  });
});

describe("ANOMALY_ASSESSMENT_RESPONSE_FORMAT", () => {
  it("is a json_schema response format", () => {
    expect(ANOMALY_ASSESSMENT_RESPONSE_FORMAT.type).toBe("json_schema");
    expect(ANOMALY_ASSESSMENT_RESPONSE_FORMAT.json_schema.name).toBe(
      "anomaly_assessment",
    );
    expect(ANOMALY_ASSESSMENT_RESPONSE_FORMAT.json_schema.strict).toBe(true);
  });

  it("schema requires all AnomalyAssessment fields", () => {
    const schema = ANOMALY_ASSESSMENT_RESPONSE_FORMAT.json_schema.schema as {
      required: string[];
    };
    expect(schema.required).toContain("isAnomaly");
    expect(schema.required).toContain("severity");
    expect(schema.required).toContain("summary");
    expect(schema.required).toContain("affectedMetrics");
    expect(schema.required).toContain("recommendedAction");
  });
});
```

**Step 2: Run to verify it fails**

```bash
npx vitest run src/agent/prompts.test.ts
```

Expected: FAIL — `buildProactiveStructuredPrompt` and `ANOMALY_ASSESSMENT_RESPONSE_FORMAT` not exported.

**Step 3: Update `src/agent/types.ts`**

Replace the full file:

```ts
import type { Message } from "../llm/openai.js";
import type { ServiceConfig } from "../config/schema.js";

export type AgentMode = "proactive" | "conversational";

export type AgentTask = {
  mode: AgentMode;
  message: string;
  serviceContext?: ServiceConfig[];
  history?: Message[];
  correlationId?: string;
};

export type AgentResult = {
  response: string;
  updatedHistory: Message[];
};

export type AnomalyAssessment = {
  isAnomaly: boolean;
  severity: "low" | "medium" | "high" | "critical";
  summary: string;
  affectedMetrics: string[];
  recommendedAction: string;
};
```

**Step 4: Update `src/agent/prompts.ts`**

Replace the full file:

```ts
import type OpenAI from "openai";
import type { ServiceConfig } from "../config/schema.js";

export function buildSystemPrompt(
  mode: "proactive" | "conversational",
  services?: ServiceConfig[],
): string {
  if (mode === "proactive") {
    return buildProactiveStructuredPrompt(services);
  }

  return `You are an ops assistant with access to Grafana monitoring data. Answer the user's question using the available tools.
- Be specific: include actual metric values, timestamps, and trends
- Link to dashboards when you find relevant ones
- If you cannot find the data needed, say so clearly`;
}

export function buildProactiveStructuredPrompt(
  services?: ServiceConfig[],
): string {
  const serviceList = services
    ?.map((s) => {
      const metrics = s.metrics
        .map((m) => `  - ${m.description}: \`${m.query}\``)
        .join("\n");
      const logs = Object.entries(s.logLabels ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      return `Service: ${s.name}\nMetrics:\n${metrics}${logs ? `\nLog labels: {${logs}}` : ""}`;
    })
    .join("\n\n");

  return `You are an infrastructure monitoring agent. Check the following services for anomalies by querying Grafana.

For each service, use the available tools to query its metrics and recent logs. Look for:
- Unusually high or low request rates
- Elevated error rates or latency spikes
- Unusual log patterns or errors

After investigating, respond ONLY with a valid JSON object matching the required schema. Do not include any other text.

${serviceList ?? "No services configured."}`;
}

export const ANOMALY_ASSESSMENT_RESPONSE_FORMAT: OpenAI.ResponseFormatJSONSchema =
  {
    type: "json_schema",
    json_schema: {
      name: "anomaly_assessment",
      strict: true,
      schema: {
        type: "object",
        properties: {
          isAnomaly: { type: "boolean" },
          severity: {
            type: "string",
            enum: ["low", "medium", "high", "critical"],
          },
          summary: { type: "string" },
          affectedMetrics: { type: "array", items: { type: "string" } },
          recommendedAction: { type: "string" },
        },
        required: [
          "isAnomaly",
          "severity",
          "summary",
          "affectedMetrics",
          "recommendedAction",
        ],
        additionalProperties: false,
      },
    },
  };
```

**Step 5: Run to verify prompts tests pass**

```bash
npx vitest run src/agent/prompts.test.ts
```

Expected: all pass.

**Step 6: Commit**

```bash
git add src/agent/types.ts src/agent/prompts.ts src/agent/prompts.test.ts
git commit -m "feat: add AnomalyAssessment type and structured proactive prompt"
```

---

## Task 10: Harden agent core

**Files:**
- Modify: `src/agent/core.ts`
- Modify: `src/agent/core.test.ts`

**Step 1: Add test cases to `src/agent/core.test.ts`**

Read the existing test file. Add these cases:

```ts
it("records correlationId in task", async () => {
  // Use the existing mock LLM that returns text immediately.
  // Verify agent.run() accepts a correlationId without throwing.
  const result = await agent.run({
    mode: "conversational",
    message: "hello",
    correlationId: "test-id-123",
  });
  expect(result.response).toBeDefined();
});

it("uses structured response format for proactive mode", async () => {
  // Mock LLM to capture the call args and verify responseFormat is passed
  // when mode === "proactive"
  const assessment = {
    isAnomaly: false,
    severity: "low",
    summary: "All good",
    affectedMetrics: [],
    recommendedAction: "none",
  };
  mockLlm.chat.mockResolvedValueOnce({
    type: "text",
    content: JSON.stringify(assessment),
  });

  const result = await agent.run({
    mode: "proactive",
    message: "Check service: payments",
    serviceContext: [],
  });
  expect(result.response).toContain("isAnomaly");
  // Verify chat was called with responseFormat
  const callArgs = mockLlm.chat.mock.calls[0];
  expect(callArgs[2]?.responseFormat).toBeDefined();
});
```

**Step 2: Run to verify new tests fail**

```bash
npx vitest run src/agent/core.test.ts
```

Expected: new tests FAIL.

**Step 3: Replace `src/agent/core.ts`**

```ts
import {
  buildSystemPrompt,
  ANOMALY_ASSESSMENT_RESPONSE_FORMAT,
} from "./prompts.js";
import type { AgentTask, AgentResult } from "./types.js";
import type { LlmClient, Message } from "../llm/openai.js";
import type { McpClient } from "../mcp/client.js";
import { TimeoutError } from "../utils/timeout.js";
import {
  agentRunsTotal,
  agentIterations,
} from "../observability/metrics.js";
import pino from "pino";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

export class AgentCore {
  private llm: LlmClient;
  private mcp: McpClient;
  private maxIterations: number;

  constructor(llm: LlmClient, mcp: McpClient, opts: { maxIterations: number }) {
    this.llm = llm;
    this.mcp = mcp;
    this.maxIterations = opts.maxIterations;
  }

  async run(task: AgentTask): Promise<AgentResult> {
    const log = logger.child({
      component: "agent",
      correlationId: task.correlationId,
    });
    const tools = this.mcp.getTools();
    const systemPrompt = buildSystemPrompt(task.mode, task.serviceContext);
    const responseFormat =
      task.mode === "proactive"
        ? ANOMALY_ASSESSMENT_RESPONSE_FORMAT
        : undefined;

    const messages: Message[] = [
      { role: "system", content: systemPrompt },
      ...(task.history ?? []),
      { role: "user", content: task.message },
    ];

    let iterations = 0;
    try {
      for (let i = 0; i < this.maxIterations; i++) {
        iterations = i + 1;
        const response = await this.llm.chat(messages, tools, {
          responseFormat,
        });

        if (response.type === "text") {
          messages.push({ role: "assistant", content: response.content });
          agentRunsTotal.inc({ status: "success" });
          agentIterations.observe(iterations);
          return {
            response: response.content,
            updatedHistory: messages.filter((m) => m.role !== "system"),
          };
        }

        messages.push({
          role: "assistant",
          content: null,
          tool_calls: response.calls.map((c) => ({
            id: c.id,
            type: "function" as const,
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        });

        const settled = await Promise.allSettled(
          response.calls.map((call) => this.mcp.callTool(call.name, call.args)),
        );
        for (let j = 0; j < response.calls.length; j++) {
          const outcome = settled[j]!;
          const call = response.calls[j]!;
          messages.push({
            role: "tool",
            content:
              outcome.status === "fulfilled"
                ? outcome.value
                : `[Transport Error] ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
            tool_call_id: call.id,
          });
        }
      }

      const truncationMsg = "Reached maximum iterations without a final response.";
      messages.push({ role: "assistant", content: truncationMsg });
      agentRunsTotal.inc({ status: "truncated" });
      agentIterations.observe(iterations);
      log.warn({ iterations }, "Agent reached max iterations");
      return {
        response: truncationMsg,
        updatedHistory: messages.filter((m) => m.role !== "system"),
      };
    } catch (err) {
      const status = err instanceof TimeoutError ? "timeout" : "error";
      agentRunsTotal.inc({ status });
      agentIterations.observe(iterations);
      log.error({ err, iterations }, "Agent run failed");
      throw err;
    }
  }
}
```

**Step 4: Run to verify all agent tests pass**

```bash
npx vitest run src/agent/
```

Expected: all tests pass.

**Step 5: Commit**

```bash
git add src/agent/core.ts src/agent/core.test.ts
git commit -m "feat: add correlationId, structured output, and metrics to AgentCore"
```

---

## Task 11: Structured anomaly detection and alert deduplication in Scheduler

**Files:**
- Modify: `src/scheduler/scheduler.ts`
- Modify: `src/scheduler/scheduler.test.ts`

**Step 1: Add test cases to `src/scheduler/scheduler.test.ts`**

Read the existing test file. Add these cases:

```ts
import type { AnomalyAssessment } from "../agent/types.js";

describe("AlertDeduplicator", () => {
  it("allows alert on first occurrence", () => {
    const dedup = new AlertDeduplicator(30);
    expect(dedup.shouldAlert("svc")).toBe(true);
  });

  it("suppresses alert within cooldown window", () => {
    const dedup = new AlertDeduplicator(30);
    dedup.record("svc");
    expect(dedup.shouldAlert("svc")).toBe(false);
  });

  it("allows alert after cooldown expires", () => {
    vi.useFakeTimers();
    const dedup = new AlertDeduplicator(30);
    dedup.record("svc");
    vi.advanceTimersByTime(31 * 60 * 1000);
    expect(dedup.shouldAlert("svc")).toBe(true);
    vi.useRealTimers();
  });
});

describe("Scheduler – structured anomaly detection", () => {
  it("sends alert when isAnomaly is true in structured response", async () => {
    const assessment: AnomalyAssessment = {
      isAnomaly: true,
      severity: "high",
      summary: "Latency spike detected",
      affectedMetrics: ["P99 latency"],
      recommendedAction: "Check recent deploys",
    };
    mockAgent.run.mockResolvedValueOnce({
      response: JSON.stringify(assessment),
      updatedHistory: [],
    });
    // ... run check and verify notify was called with severity: "high"
    // and recommendedAction in alert
  });

  it("does not send alert when isAnomaly is false", async () => {
    const assessment: AnomalyAssessment = {
      isAnomaly: false,
      severity: "low",
      summary: "All metrics normal",
      affectedMetrics: [],
      recommendedAction: "No action needed",
    };
    mockAgent.run.mockResolvedValueOnce({
      response: JSON.stringify(assessment),
      updatedHistory: [],
    });
    // ... run check and verify notify was NOT called
  });

  it("falls back to error status if JSON parse fails", async () => {
    mockAgent.run.mockResolvedValueOnce({
      response: "not valid json",
      updatedHistory: [],
    });
    // ... run check and verify no notify call, check logs error
  });
});
```

**Step 2: Run to verify new tests fail**

```bash
npx vitest run src/scheduler/scheduler.test.ts
```

Expected: new tests FAIL.

**Step 3: Replace `src/scheduler/scheduler.ts`**

```ts
import cron from "node-cron";
import pino from "pino";
import type { AgentCore } from "../agent/core.js";
import type { AnomalyAlert, sendAnomalyAlert } from "../notifications/slack-webhook.js";
import type { AnomalyAssessment } from "../agent/types.js";
import type { ServiceConfig, AnomalyCheckConfig } from "../config/schema.js";
import {
  schedulerChecksTotal,
  alertNotificationsTotal,
} from "../observability/metrics.js";
import { randomUUID } from "node:crypto";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

export function parseDurationToCron(interval: string): string {
  const minuteMatch = interval.match(/^(\d+)m$/);
  if (minuteMatch) {
    const n = parseInt(minuteMatch[1]!, 10);
    if (n === 0)
      throw new Error(
        `Unsupported interval format: "${interval}". Use e.g. "5m" or "1h".`,
      );
    return `*/${n} * * * *`;
  }

  const hourMatch = interval.match(/^(\d+)h$/);
  if (hourMatch) {
    const n = parseInt(hourMatch[1]!, 10);
    if (n === 0)
      throw new Error(
        `Unsupported interval format: "${interval}". Use e.g. "5m" or "1h".`,
      );
    return `0 */${n} * * *`;
  }

  throw new Error(
    `Unsupported interval format: "${interval}". Use e.g. "5m" or "1h".`,
  );
}

export class AlertDeduplicator {
  private lastAlerts = new Map<string, number>();
  private cooldownMs: number;

  constructor(cooldownMinutes: number) {
    this.cooldownMs = cooldownMinutes * 60_000;
  }

  shouldAlert(service: string): boolean {
    const last = this.lastAlerts.get(service);
    return last === undefined || Date.now() - last >= this.cooldownMs;
  }

  record(service: string): void {
    this.lastAlerts.set(service, Date.now());
  }
}

export class Scheduler {
  private config: AnomalyCheckConfig;
  private services: ServiceConfig[];
  private agent: AgentCore;
  private notify: typeof sendAnomalyAlert;
  private task: cron.ScheduledTask | null = null;
  private webhookUrl: string;
  private deduplicator: AlertDeduplicator;

  constructor(
    config: AnomalyCheckConfig,
    services: ServiceConfig[],
    agent: AgentCore,
    notify: typeof sendAnomalyAlert,
    webhookUrl = "",
  ) {
    this.config = config;
    this.services = services;
    this.agent = agent;
    this.notify = notify;
    this.webhookUrl = webhookUrl;
    this.deduplicator = new AlertDeduplicator(
      config.alertCooldownMinutes,
    );
  }

  start(): void {
    if (this.task !== null) return;
    const cronExpr = parseDurationToCron(this.config.interval);
    this.task = cron.schedule(cronExpr, () => {
      void this.runChecks();
    });
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
  }

  private async runChecks(): Promise<void> {
    const targetNames = this.config.services;
    const targets = targetNames
      ? this.services.filter((s) => targetNames.includes(s.name))
      : this.services;

    const limit = this.config.maxConcurrency;
    const chunks: ServiceConfig[][] = [];
    for (let i = 0; i < targets.length; i += limit) {
      chunks.push(targets.slice(i, i + limit));
    }

    for (const chunk of chunks) {
      const results = await Promise.allSettled(
        chunk.map((service) => this.checkService(service)),
      );

      for (const [i, outcome] of results.entries()) {
        if (outcome.status === "rejected") {
          logger.error(
            { err: outcome.reason, service: chunk[i]!.name },
            "Service check failed",
          );
          schedulerChecksTotal.inc({
            service: chunk[i]!.name,
            status: "error",
          });
        }
      }
    }
  }

  private async checkService(service: ServiceConfig): Promise<void> {
    const correlationId = randomUUID().slice(0, 8);
    const log = logger.child({
      component: "scheduler",
      service: service.name,
      correlationId,
    });

    const result = await this.agent.run({
      mode: "proactive",
      message: `Check service: ${service.name}`,
      serviceContext: [service],
      correlationId,
    });

    let assessment: AnomalyAssessment;
    try {
      assessment = JSON.parse(result.response) as AnomalyAssessment;
    } catch {
      log.error({ response: result.response }, "Failed to parse anomaly assessment JSON");
      schedulerChecksTotal.inc({ service: service.name, status: "error" });
      return;
    }

    if (!assessment.isAnomaly) {
      schedulerChecksTotal.inc({ service: service.name, status: "healthy" });
      log.info("Service healthy");
      return;
    }

    schedulerChecksTotal.inc({ service: service.name, status: "anomaly" });

    if (!this.deduplicator.shouldAlert(service.name)) {
      log.info("Anomaly detected but suppressed by cooldown");
      alertNotificationsTotal.inc({ status: "deduplicated" });
      return;
    }

    const alert: AnomalyAlert = {
      service: service.name,
      severity: assessment.severity,
      summary: assessment.summary,
      affectedMetrics: assessment.affectedMetrics,
      recommendedAction: assessment.recommendedAction,
    };

    try {
      await this.notify(this.webhookUrl, alert);
      this.deduplicator.record(service.name);
      alertNotificationsTotal.inc({ status: "success" });
      log.info({ severity: assessment.severity }, "Anomaly alert sent");
    } catch (err) {
      alertNotificationsTotal.inc({ status: "error" });
      log.error({ err }, "Failed to send anomaly alert");
    }
  }
}
```

**Step 4: Run to verify all scheduler tests pass**

```bash
npx vitest run src/scheduler/scheduler.test.ts
```

Expected: all tests pass.

**Step 5: Commit**

```bash
git add src/scheduler/scheduler.ts src/scheduler/scheduler.test.ts
git commit -m "feat: structured anomaly detection and alert deduplication in Scheduler"
```

---

## Task 12: Harden Slack webhook notifier

**Files:**
- Modify: `src/notifications/slack-webhook.ts`
- Modify: `src/notifications/slack-webhook.test.ts`

**Step 1: Add test cases to `src/notifications/slack-webhook.test.ts`**

Read the existing test file. Add:

```ts
it("retries on 503", async () => {
  global.fetch = vi
    .fn()
    .mockResolvedValueOnce({ ok: false, status: 503, statusText: "Service Unavailable" })
    .mockResolvedValueOnce({ ok: true });

  await expect(
    sendAnomalyAlert("https://hooks.slack.com/test", {
      service: "svc",
      severity: "high",
      summary: "down",
    }),
  ).resolves.toBeUndefined();
  expect(global.fetch).toHaveBeenCalledTimes(2);
});

it("includes recommendedAction in Slack blocks when provided", async () => {
  global.fetch = vi.fn().mockResolvedValue({ ok: true });
  await sendAnomalyAlert("https://hooks.slack.com/test", {
    service: "svc",
    severity: "critical",
    summary: "Outage",
    recommendedAction: "Restart the pod",
  });
  const body = JSON.parse(
    (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
  ) as { blocks: Array<{ text?: { text: string } }> };
  const texts = body.blocks
    .flatMap((b) => (b.text ? [b.text.text] : []))
    .join(" ");
  expect(texts).toContain("Restart the pod");
});
```

**Step 2: Run to verify new tests fail**

```bash
npx vitest run src/notifications/slack-webhook.test.ts
```

Expected: new tests FAIL.

**Step 3: Replace `src/notifications/slack-webhook.ts`**

```ts
import type { KnownBlock } from "@slack/bolt";
import { withRetry } from "../utils/retry.js";

export type AnomalyAlert = {
  service: string;
  severity: "low" | "medium" | "high" | "critical";
  summary: string;
  affectedMetrics?: string[];
  dashboardUrl?: string;
  recommendedAction?: string;
};

const SEVERITY_EMOJI: Record<AnomalyAlert["severity"], string> = {
  low: ":yellow_circle:",
  medium: ":orange_circle:",
  high: ":red_circle:",
  critical: ":rotating_light:",
};

export async function sendAnomalyAlert(
  webhookUrl: string,
  alert: AnomalyAlert,
): Promise<void> {
  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${SEVERITY_EMOJI[alert.severity]} Anomaly detected: ${alert.service}`,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Service:*\n${alert.service}` },
        { type: "mrkdwn", text: `*Severity:*\n${alert.severity}` },
      ],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Summary:*\n${alert.summary}` },
    },
  ];

  if (alert.recommendedAction) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Recommended action:*\n${alert.recommendedAction}`,
      },
    });
  }

  if (alert.affectedMetrics && alert.affectedMetrics.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Affected metrics:*\n${alert.affectedMetrics.map((m) => `• ${m}`).join("\n")}`,
      },
    });
  }

  if (alert.dashboardUrl) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View Dashboard" },
          url: alert.dashboardUrl,
        },
      ],
    });
  }

  await withRetry(
    async () => {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blocks }),
      });
      if (!response.ok) {
        const err = Object.assign(
          new Error(`Slack webhook failed: ${response.status} ${response.statusText}`),
          { status: response.status },
        );
        throw err;
      }
    },
    { maxAttempts: 3, baseDelayMs: 500 },
  );
}
```

**Step 4: Run to verify all webhook tests pass**

```bash
npx vitest run src/notifications/slack-webhook.test.ts
```

Expected: all tests pass.

**Step 5: Commit**

```bash
git add src/notifications/slack-webhook.ts src/notifications/slack-webhook.test.ts
git commit -m "feat: add retry and recommendedAction to Slack webhook notifier"
```

---

## Task 13: Harden Slack bot (correlationId + metrics)

**Files:**
- Modify: `src/interfaces/slack.ts`
- Modify: `src/interfaces/slack.test.ts`

**Step 1: Add test cases to `src/interfaces/slack.test.ts`**

Read the existing test file. Add:

```ts
it("increments slackMessagesTotal on success", async () => {
  registry.resetMetrics();
  await bot.handleMessage({ text: "hello", threadTs: "ts1", userId: "U1" }, mockSay);
  const metrics = await registry.getMetricsAsJSON();
  const counter = metrics.find((m) => m.name === "slack_messages_total");
  const values = counter?.values as Array<{ labels: { status: string }; value: number }>;
  expect(values?.find((v) => v.labels.status === "success")?.value).toBe(1);
});

it("increments slackMessagesTotal on error", async () => {
  registry.resetMetrics();
  mockAgent.run.mockRejectedValueOnce(new Error("boom"));
  await expect(
    bot.handleMessage({ text: "fail", threadTs: "ts2", userId: "U2" }, mockSay),
  ).rejects.toThrow("boom");
  const metrics = await registry.getMetricsAsJSON();
  const counter = metrics.find((m) => m.name === "slack_messages_total");
  const values = counter?.values as Array<{ labels: { status: string }; value: number }>;
  expect(values?.find((v) => v.labels.status === "error")?.value).toBe(1);
});
```

**Step 2: Run to verify new tests fail**

```bash
npx vitest run src/interfaces/slack.test.ts
```

Expected: new tests FAIL.

**Step 3: Update `src/interfaces/slack.ts`**

Replace the full file:

```ts
import { App } from "@slack/bolt";
import { randomUUID } from "node:crypto";
import type { AgentCore } from "../agent/core.js";
import type { ConversationMemory } from "../memory/conversation.js";
import { slackMessagesTotal } from "../observability/metrics.js";

export type SlackConfig = {
  botToken: string;
  appToken: string;
};

type MessageContext = {
  text: string;
  threadTs: string;
  userId: string;
};

export class SlackBot {
  private app: App;
  private agent: AgentCore;
  private memory: ConversationMemory;

  constructor(config: SlackConfig, agent: AgentCore, memory: ConversationMemory) {
    this.agent = agent;
    this.memory = memory;
    this.app = new App({
      token: config.botToken,
      appToken: config.appToken,
      socketMode: true,
    });
    this.registerHandlers();
  }

  async start(): Promise<void> {
    await this.app.start();
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }

  // Public for testing
  async handleMessage(
    ctx: MessageContext,
    say: (msg: object) => Promise<void>,
  ): Promise<void> {
    const correlationId = randomUUID().slice(0, 8);
    const threadId = ctx.threadTs;
    const history = this.memory.get(threadId);

    this.memory.append(threadId, { role: "user", content: ctx.text });

    try {
      const result = await this.agent.run({
        mode: "conversational",
        message: ctx.text,
        history,
        correlationId,
      });
      this.memory.append(threadId, { role: "assistant", content: result.response });
      await say({ text: result.response, thread_ts: threadId });
      slackMessagesTotal.inc({ status: "success" });
    } catch (err) {
      slackMessagesTotal.inc({ status: "error" });
      const errorText = "Sorry, something went wrong. Please try again.";
      await say({ text: errorText, thread_ts: threadId }).catch(() => undefined);
      throw err;
    }
  }

  private registerHandlers(): void {
    this.app.message(async ({ message, say }) => {
      const msg = message as { text?: string; ts: string; user?: string };
      if (!msg.text) return;
      await this.handleMessage(
        { text: msg.text, threadTs: msg.ts, userId: msg.user ?? "" },
        say as unknown as (msg: object) => Promise<void>,
      );
    });

    this.app.event("app_mention", async ({ event, say }) => {
      const threadTs = event.thread_ts ?? event.ts;
      await this.handleMessage(
        { text: event.text, threadTs, userId: event.user ?? "" },
        say as unknown as (msg: object) => Promise<void>,
      );
    });
  }
}
```

**Step 4: Run to verify all Slack bot tests pass**

```bash
npx vitest run src/interfaces/slack.test.ts
```

Expected: all tests pass.

**Step 5: Commit**

```bash
git add src/interfaces/slack.ts src/interfaces/slack.test.ts
git commit -m "feat: add correlationId and metrics to SlackBot"
```

---

## Task 14: Wire everything in index.ts

**Files:**
- Modify: `src/index.ts`

No new tests needed — this is wiring. Run the full suite to verify.

**Step 1: Replace `src/index.ts`**

```ts
import { loadConfig } from "./config/loader.js";
import { McpClient } from "./mcp/client.js";
import { LlmClient } from "./llm/openai.js";
import { AgentCore } from "./agent/core.js";
import { ConversationMemory } from "./memory/conversation.js";
import { sendAnomalyAlert } from "./notifications/slack-webhook.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { SlackBot } from "./interfaces/slack.js";
import { ObservabilityServer } from "./observability/server.js";
import pino from "pino";

const configPath = process.env["CONFIG_PATH"] ?? "config.yaml";

async function main(): Promise<void> {
  const config = loadConfig(configPath);

  const logger = pino({
    level: process.env["LOG_LEVEL"] ?? config.observability.logLevel,
  });

  logger.info({ configPath }, "Loading config");

  // Observability server (starts early so /health is available during startup)
  const obsServer = new ObservabilityServer(
    config.observability.port,
    () => mcp.isConnected(),
  );
  await obsServer.start();
  logger.info({ port: config.observability.port }, "Observability server started");

  // Layer 1: MCP client
  const mcp = new McpClient(config.grafana.mcpServer, config.timeouts);
  logger.info("Connecting to Grafana MCP server...");
  await mcp.connect();
  logger.info("MCP connected");

  // Layer 2: LLM client
  const llm = new LlmClient(config.llm, config.timeouts, config.retry);

  // Layer 3: Agent core
  const agent = new AgentCore(llm, mcp, {
    maxIterations: config.agent.maxIterations,
  });

  // Layer 4: Conversation memory
  const memory = new ConversationMemory(config.agent.conversationMemory);

  // Layer 5: Slack webhook notifier (used by scheduler)
  const webhookUrl = config.notifications.slack?.webhookUrl ?? "";

  // Layer 6: Scheduler
  let scheduler: Scheduler | null = null;
  if (config.scheduler.anomalyCheck) {
    scheduler = new Scheduler(
      config.scheduler.anomalyCheck,
      config.services,
      agent,
      sendAnomalyAlert,
      webhookUrl,
    );
    scheduler.start();
    logger.info("Scheduler started");
  }

  // Layer 7: Slack bot
  let slackBot: SlackBot | null = null;
  if (config.interfaces.slack?.enabled) {
    const slackCfg = config.interfaces.slack;
    if (!slackCfg.botToken || !slackCfg.appToken) {
      throw new Error("Slack enabled but botToken or appToken missing");
    }
    slackBot = new SlackBot(
      { botToken: slackCfg.botToken, appToken: slackCfg.appToken },
      agent,
      memory,
    );
    await slackBot.start();
    logger.info("Slack bot started");
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "Shutting down");
    scheduler?.stop();
    await slackBot?.stop();
    memory.destroy();
    await mcp.disconnect();
    await obsServer.stop();
    logger.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  logger.info("dops-assistant running");
}

main().catch((err) => {
  console.error("Fatal error", err);
  process.exit(1);
});
```

**Step 2: Run full test suite**

```bash
npm test
```

Expected: all tests pass.

**Step 3: TypeScript compile check**

```bash
npx tsc --noEmit
```

Expected: no errors.

**Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire observability server and updated constructor signatures in index.ts"
```

---

## Task 15: Update docker-compose and config.yaml.example

**Files:**
- Modify: `docker-compose.yml`
- Verify: `config.yaml.example` (already updated in Task 2)

**Step 1: Update `docker-compose.yml`** to expose the observability port:

```yaml
services:
  dops-assistant:
    build: .
    restart: unless-stopped
    env_file: .env
    environment:
      CONFIG_PATH: /app/config.yaml
    volumes:
      - ./config.yaml:/app/config.yaml:ro
    ports:
      - "9090:9090"
```

**Step 2: Run full test suite one final time**

```bash
npm test
```

Expected: all tests pass.

**Step 3: Build Docker image to verify it compiles**

```bash
docker build -t dops-assistant:phase1 .
```

Expected: build succeeds.

**Step 4: Final commit**

```bash
git add docker-compose.yml
git commit -m "feat: expose observability port 9090 in docker-compose"
```

---

## Summary

| Task | Files | Outcome |
|---|---|---|
| 1 | package.json | prom-client installed |
| 2 | config/schema.ts | timeouts, retry, observability, cooldown sections |
| 3 | utils/timeout.ts | `withTimeout` + `TimeoutError` |
| 4 | utils/retry.ts | `withRetry` + `isRetryable` |
| 5 | observability/metrics.ts | 9 Prometheus metrics |
| 6 | observability/server.ts | `/health` + `/metrics` on port 9090 |
| 7 | mcp/client.ts | connect + callTool timeouts, metrics |
| 8 | llm/openai.ts | timeout, retry, responseFormat, token tracking |
| 9 | agent/types.ts + prompts.ts | AnomalyAssessment type, structured prompt, json_schema |
| 10 | agent/core.ts | correlationId, structured output for proactive, metrics |
| 11 | scheduler/scheduler.ts | JSON parsing, AlertDeduplicator, metrics |
| 12 | notifications/slack-webhook.ts | retry, recommendedAction field, critical severity |
| 13 | interfaces/slack.ts | correlationId generation, metrics |
| 14 | index.ts | wire ObservabilityServer, updated constructors |
| 15 | docker-compose.yml | expose port 9090 |
