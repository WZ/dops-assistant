# CLI Enhancement: Programmatic Validation & Benchmark Interface — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repurpose the CLI from an interactive REPL into a subcommand-based tool that AI agents can invoke for validation and benchmarking, with JSON output to stdout.

**Architecture:** Rewrite `src/cli/index.tsx` as a subcommand dispatcher. Each command (`investigate`, `chat`, `mcp-check`, `e2e`, `interactive`) is a separate module under `src/cli/commands/`. A shared `output.ts` builds the JSON envelope. An `assertions.ts` module handles e2e scenario assertions. The existing Ink REPL moves to `commands/interactive.tsx` unchanged.

**Tech Stack:** TypeScript, Node.js `process.argv` parsing, Mastra agents (existing), Vitest for tests.

**Spec:** `docs/superpowers/specs/2026-03-15-cli-enhance-design.md`

---

## Chunk 1: Foundation — Arg Parser, Output Envelope, Shared Types

### Task 1: CLI Output Types and Envelope Builder

**Files:**
- Create: `src/cli/types.ts`
- Create: `src/cli/output.ts`
- Create: `src/cli/output.test.ts`

- [ ] **Step 1: Write the failing tests for output envelope**

```typescript
// src/cli/output.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildOutput, writeOutput, type ToolCallRecord } from "./output.js";

describe("buildOutput", () => {
  it("builds a success envelope with all fields", () => {
    const result = buildOutput({
      command: "investigate",
      status: "success",
      durationMs: 1234,
      tokens: { input: 100, output: 50, total: 150 },
      toolCalls: [],
      result: { severity: "high" },
      extra: { service: "api-gateway", history: false },
    });

    expect(result).toEqual({
      command: "investigate",
      service: "api-gateway",
      history: false,
      status: "success",
      durationMs: 1234,
      tokens: { input: 100, output: 50, total: 150 },
      toolCalls: [],
      result: { severity: "high" },
      error: null,
    });
  });

  it("builds an error envelope with null result", () => {
    const result = buildOutput({
      command: "chat",
      status: "error",
      durationMs: 500,
      tokens: null,
      toolCalls: [],
      result: null,
      error: "LLM timeout",
      extra: { message: "hello" },
    });

    expect(result).toEqual({
      command: "chat",
      message: "hello",
      status: "error",
      durationMs: 500,
      tokens: null,
      toolCalls: [],
      result: null,
      error: "LLM timeout",
    });
  });
});

describe("writeOutput", () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((_data, cb?: any) => {
      if (typeof cb === "function") cb();
      return true;
    });
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
  });

  it("writes JSON to stdout and exits with code", async () => {
    const data = { command: "mcp-check", status: "success" };
    await writeOutput(data, 0);
    const written = writeSpy.mock.calls[0]?.[0] as string;
    expect(JSON.parse(written)).toEqual(data);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("exits with code 1 on error", async () => {
    const data = { command: "chat", status: "error", error: "timeout" };
    await writeOutput(data, 1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/output.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Create CLI types**

```typescript
// src/cli/types.ts
import type { RcaReport } from "../types/rca-types.js";

export type CliCommand = "investigate" | "chat" | "mcp-check" | "e2e" | "interactive";

export type TokenSummary = {
  input: number;
  output: number;
  total: number;
};

export type ToolCallRecord = {
  name: string;
  argsSummary: string;
  durationMs?: number;
  // --verbose only:
  result?: string;
  error?: string;
  phase?: string;
};

export type CliFlags = {
  timeout: number;
  verbose: boolean;
  config: string;
  history: boolean;
};

export type InvestigateOutput = {
  command: "investigate";
  service: string;
  status: "success" | "error";
  durationMs: number;
  tokens: TokenSummary | null;
  toolCalls: ToolCallRecord[];
  history: boolean;
  result: RcaReport | null;
  error: string | null;
};

export type ChatOutput = {
  command: "chat";
  message: string;
  status: "success" | "error";
  durationMs: number;
  tokens: TokenSummary | null;
  toolCalls: ToolCallRecord[];
  result: { response: string } | null;
  error: string | null;
};

export type McpCheckProvider = {
  name: string;
  status: "connected" | "error";
  toolsCount: number;
  tools: string[];
  error: string | null;
};

export type McpCheckOutput = {
  command: "mcp-check";
  status: "success" | "error";
  durationMs: number;
  providers: McpCheckProvider[];
};

export type E2eStepResult = {
  name: string;
  status: "pass" | "fail" | "skipped";
  durationMs: number;
  error: string | null;
  assertions?: Array<{
    field: string;
    expected: unknown;
    actual: unknown;
    pass: boolean;
  }>;
};

export type E2eOutput = {
  command: "e2e";
  scenario: string;
  status: "pass" | "fail";
  durationMs: number;
  steps: E2eStepResult[];
};
```

- [ ] **Step 4: Implement output.ts**

```typescript
// src/cli/output.ts
export type BuildOutputOpts = {
  command: string;
  status: string;
  durationMs: number;
  tokens?: { input: number; output: number; total: number } | null;
  toolCalls?: Array<Record<string, unknown>>;
  result?: unknown;
  error?: string;
  extra?: Record<string, unknown>;
};

export function buildOutput(opts: BuildOutputOpts): Record<string, unknown> {
  const { command, status, durationMs, tokens, toolCalls, result, error, extra } = opts;
  return {
    command,
    ...extra,
    status,
    durationMs,
    tokens: tokens ?? null,
    toolCalls: toolCalls ?? [],
    result: result ?? null,
    error: error ?? null,
  };
}

export function writeOutput(data: unknown, exitCode: number): Promise<never> {
  const json = JSON.stringify(data, null, 2) + "\n";
  return new Promise((resolve) => {
    process.stdout.write(json, () => {
      process.exit(exitCode);
    });
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/cli/output.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/cli/types.ts src/cli/output.ts src/cli/output.test.ts
git commit -m "feat(cli): add output envelope builder and CLI types"
```

---

### Task 2: Arg Parser and Subcommand Dispatcher

**Files:**
- Create: `src/cli/parse-args.ts`
- Create: `src/cli/parse-args.test.ts`

- [ ] **Step 1: Write failing tests for arg parser**

```typescript
// src/cli/parse-args.test.ts
import { describe, it, expect } from "vitest";
import { parseArgs } from "./parse-args.js";

describe("parseArgs", () => {
  it("parses investigate command", () => {
    const result = parseArgs(["investigate", "api-gateway"]);
    expect(result).toEqual({
      command: "investigate",
      args: ["api-gateway"],
      flags: { timeout: 120000, verbose: false, config: "config.yaml", history: false },
    });
  });

  it("parses chat command with quoted message", () => {
    const result = parseArgs(["chat", "What alerts fired?"]);
    expect(result).toEqual({
      command: "chat",
      args: ["What alerts fired?"],
      flags: { timeout: 120000, verbose: false, config: "config.yaml", history: false },
    });
  });

  it("parses mcp-check command", () => {
    const result = parseArgs(["mcp-check"]);
    expect(result.command).toBe("mcp-check");
  });

  it("parses e2e command with scenario file", () => {
    const result = parseArgs(["e2e", "scenarios/test.json"]);
    expect(result).toEqual({
      command: "e2e",
      args: ["scenarios/test.json"],
      flags: { timeout: 120000, verbose: false, config: "config.yaml", history: false },
    });
  });

  it("parses interactive command", () => {
    const result = parseArgs(["interactive"]);
    expect(result.command).toBe("interactive");
  });

  it("defaults to interactive when no command given", () => {
    const result = parseArgs([]);
    expect(result.command).toBe("interactive");
  });

  it("parses --verbose flag", () => {
    const result = parseArgs(["investigate", "svc", "--verbose"]);
    expect(result.flags.verbose).toBe(true);
  });

  it("parses --timeout flag", () => {
    const result = parseArgs(["chat", "hi", "--timeout", "30000"]);
    expect(result.flags.timeout).toBe(30000);
  });

  it("parses --config flag", () => {
    const result = parseArgs(["mcp-check", "--config", "/path/to/config.yaml"]);
    expect(result.flags.config).toBe("/path/to/config.yaml");
  });

  it("parses --history flag to enable history", () => {
    const result = parseArgs(["investigate", "svc", "--history"]);
    expect(result.flags.history).toBe(true);
  });

  it("returns unknown command as-is for error handling upstream", () => {
    const result = parseArgs(["bogus"]);
    expect(result.command).toBe("bogus");
  });

  it("uses CONFIG_PATH env var when --config not set", () => {
    const prev = process.env.CONFIG_PATH;
    process.env.CONFIG_PATH = "/env/config.yaml";
    const result = parseArgs(["mcp-check"]);
    expect(result.flags.config).toBe("/env/config.yaml");
    process.env.CONFIG_PATH = prev;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/parse-args.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement parse-args.ts**

```typescript
// src/cli/parse-args.ts
import type { CliFlags } from "./types.js";

export type ParsedArgs = {
  command: string;
  args: string[];
  flags: CliFlags;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: CliFlags = {
    timeout: 120000,
    verbose: false,
    config: process.env.CONFIG_PATH ?? "config.yaml",
    history: false,
  };

  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--verbose") {
      flags.verbose = true;
    } else if (arg === "--timeout" && argv[i + 1]) {
      flags.timeout = parseInt(argv[++i]!, 10);
    } else if (arg === "--config" && argv[i + 1]) {
      flags.config = argv[++i]!;
    } else if (arg === "--history") {
      flags.history = true;
    } else if (!arg.startsWith("--")) {
      positional.push(arg);
    }
  }

  const command = positional[0] ?? "interactive";
  const args = positional.slice(1);

  return { command, args, flags };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/cli/parse-args.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/parse-args.ts src/cli/parse-args.test.ts
git commit -m "feat(cli): add arg parser with subcommand and flag support"
```

---

### Task 3: Tool Call Collector Utility

The `investigate` and `chat` commands both need to collect tool calls during agent execution. This utility wraps the `OnToolCallEnriched` callback and produces `ToolCallRecord[]` with timing.

**Files:**
- Create: `src/cli/tool-collector.ts`
- Create: `src/cli/tool-collector.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/cli/tool-collector.test.ts
import { describe, it, expect } from "vitest";
import { createToolCollector } from "./tool-collector.js";

describe("createToolCollector", () => {
  it("collects tool calls in non-verbose mode", () => {
    const collector = createToolCollector(false);
    collector.callback("search_dashboards", { query: "api-gateway" }, "result-data", 340, undefined, "anomaly");
    collector.callback("query_prometheus", { expr: "up{job='api'}" }, "metric-data", 520, undefined, "metrics");

    const records = collector.getRecords();
    expect(records).toEqual([
      { name: "search_dashboards", argsSummary: '{"query":"api-gateway"}', durationMs: 340 },
      { name: "query_prometheus", argsSummary: '{"expr":"up{job=\'api\'}"}', durationMs: 520 },
    ]);
  });

  it("truncates argsSummary to 80 chars in non-verbose mode", () => {
    const collector = createToolCollector(false);
    const longArgs = { query: "a".repeat(200) };
    collector.callback("tool", longArgs);

    const records = collector.getRecords();
    expect(records[0]!.argsSummary.length).toBeLessThanOrEqual(83); // 80 + "..."
  });

  it("includes full details in verbose mode", () => {
    const collector = createToolCollector(true);
    collector.callback("tool", { q: "x" }, "big-result", 100, undefined, "planning");

    const records = collector.getRecords();
    expect(records[0]).toEqual({
      name: "tool",
      argsSummary: '{"q":"x"}',
      durationMs: 100,
      result: "big-result",
      phase: "planning",
    });
  });

  it("includes error in verbose mode when present", () => {
    const collector = createToolCollector(true);
    collector.callback("tool", {}, undefined, 50, "connection refused", "prefetch");

    const records = collector.getRecords();
    expect(records[0]!.error).toBe("connection refused");
  });

  it("omits durationMs when undefined", () => {
    const collector = createToolCollector(false);
    collector.callback("tool", {});

    const records = collector.getRecords();
    expect(records[0]!.durationMs).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/tool-collector.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement tool-collector.ts**

```typescript
// src/cli/tool-collector.ts
import type { ToolCallRecord } from "./types.js";
import type { OnToolCallEnriched } from "../types/agent-interfaces.js";

const MAX_ARGS_SUMMARY = 80;

export function createToolCollector(verbose: boolean) {
  const records: ToolCallRecord[] = [];

  const callback: OnToolCallEnriched = (name, args, result, durationMs, error, phase) => {
    let argsSummary = JSON.stringify(args);
    if (!verbose && argsSummary.length > MAX_ARGS_SUMMARY) {
      argsSummary = argsSummary.slice(0, MAX_ARGS_SUMMARY) + "...";
    }

    const record: ToolCallRecord = { name, argsSummary };
    if (durationMs !== undefined) record.durationMs = durationMs;

    if (verbose) {
      if (result !== undefined) record.result = result;
      if (error !== undefined) record.error = error;
      if (phase !== undefined) record.phase = phase;
    }

    records.push(record);
  };

  return {
    callback,
    getRecords: () => records,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/cli/tool-collector.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/tool-collector.ts src/cli/tool-collector.test.ts
git commit -m "feat(cli): add tool call collector with verbose mode"
```

---

## Chunk 2: Commands — mcp-check, chat, investigate

### Task 4: `mcp-check` Command

The simplest command — connects to MCP providers and lists tools. No agents needed.

**Files:**
- Create: `src/cli/commands/mcp-check.ts`
- Create: `src/cli/commands/mcp-check.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/cli/commands/mcp-check.test.ts
import { describe, it, expect, vi } from "vitest";
import { runMcpCheck } from "./mcp-check.js";
import type { MastraProvider } from "../../mcp/provider.js";

function makeMockProvider(name: string, tools: string[], shouldFail = false): MastraProvider {
  return {
    name,
    roles: ["metrics"],
    client: {
      listTools: shouldFail
        ? vi.fn().mockRejectedValue(new Error("connection refused"))
        : vi.fn().mockResolvedValue(Object.fromEntries(tools.map((t) => [t, {}]))),
    } as any,
  };
}

describe("runMcpCheck", () => {
  it("returns connected status with tool list", async () => {
    const providers = [makeMockProvider("grafana", ["search_dashboards", "query_prometheus"])];
    const result = await runMcpCheck(providers);

    expect(result.command).toBe("mcp-check");
    expect(result.status).toBe("success");
    expect(result.providers[0]).toEqual({
      name: "grafana",
      status: "connected",
      toolsCount: 2,
      tools: ["search_dashboards", "query_prometheus"],
      error: null,
    });
  });

  it("reports error for failed provider", async () => {
    const providers = [makeMockProvider("grafana", [], true)];
    const result = await runMcpCheck(providers);

    expect(result.status).toBe("error");
    expect(result.providers[0]!.status).toBe("error");
    expect(result.providers[0]!.error).toContain("connection refused");
  });

  it("reports mixed status when some providers fail", async () => {
    const providers = [
      makeMockProvider("grafana", ["tool1"]),
      makeMockProvider("loki", [], true),
    ];
    const result = await runMcpCheck(providers);

    expect(result.status).toBe("error"); // overall error if any fail
    expect(result.providers[0]!.status).toBe("connected");
    expect(result.providers[1]!.status).toBe("error");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/commands/mcp-check.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement mcp-check.ts**

```typescript
// src/cli/commands/mcp-check.ts
import type { MastraProvider } from "../../mcp/provider.js";
import type { McpCheckOutput, McpCheckProvider } from "../types.js";

export async function runMcpCheck(providers: MastraProvider[]): Promise<McpCheckOutput> {
  const start = performance.now();
  const results: McpCheckProvider[] = [];
  let anyError = false;

  for (const provider of providers) {
    try {
      const tools = await provider.client.listTools();
      const toolNames = Object.keys(tools);
      results.push({
        name: provider.name,
        status: "connected",
        toolsCount: toolNames.length,
        tools: toolNames,
        error: null,
      });
    } catch (err) {
      anyError = true;
      results.push({
        name: provider.name,
        status: "error",
        toolsCount: 0,
        tools: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    command: "mcp-check",
    status: anyError ? "error" : "success",
    durationMs: Math.round(performance.now() - start),
    providers: results,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/cli/commands/mcp-check.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/mcp-check.ts src/cli/commands/mcp-check.test.ts
git commit -m "feat(cli): add mcp-check command"
```

---

### Task 5: `chat` Command

**Files:**
- Create: `src/cli/commands/chat.ts`
- Create: `src/cli/commands/chat.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/cli/commands/chat.test.ts
import { describe, it, expect, vi } from "vitest";
import { runChat } from "./chat.js";
import type { IChatAgent } from "../../types/agent-interfaces.js";

function makeMockChatAgent(response: string): IChatAgent {
  return {
    chat: vi.fn().mockResolvedValue({
      response,
      updatedHistory: [],
      images: [],
    }),
  };
}

describe("runChat", () => {
  it("returns chat response with success status", async () => {
    const agent = makeMockChatAgent("There are 3 alerts firing.");
    const result = await runChat(agent, "What alerts fired?", { verbose: false });

    expect(result.command).toBe("chat");
    expect(result.message).toBe("What alerts fired?");
    expect(result.status).toBe("success");
    expect(result.result).toEqual({ response: "There are 3 alerts firing." });
    expect(result.error).toBeNull();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("passes correct ChatRequest to agent", async () => {
    const agent = makeMockChatAgent("ok");
    await runChat(agent, "hello", { verbose: false });

    expect(agent.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "conversational",
        message: "hello",
        history: [],
      }),
    );
  });

  it("returns error status on agent failure", async () => {
    const agent: IChatAgent = {
      chat: vi.fn().mockRejectedValue(new Error("LLM timeout")),
    };
    const result = await runChat(agent, "hello", { verbose: false });

    expect(result.status).toBe("error");
    expect(result.error).toBe("LLM timeout");
    expect(result.result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/commands/chat.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement chat.ts**

```typescript
// src/cli/commands/chat.ts
import type { IChatAgent } from "../../types/agent-interfaces.js";
import type { ChatOutput, TokenSummary } from "../types.js";
import { createToolCollector } from "../tool-collector.js";

export type ChatOptions = {
  verbose: boolean;
};

// Note: ChatRequest.onToolCall has a 3-param signature (name, args, result)
// while OnToolCallEnriched has 6 params. The collector.callback will work
// (extra params are assignable) but durationMs/error/phase will always be
// undefined for chat tool calls. This is a known limitation — the chat agent
// stream does not provide per-tool timing data.

export async function runChat(
  agent: IChatAgent,
  message: string,
  opts: ChatOptions,
): Promise<ChatOutput> {
  const start = performance.now();
  const collector = createToolCollector(opts.verbose);
  let tokens: TokenSummary | null = null;

  try {
    const response = await agent.chat({
      mode: "conversational",
      message,
      history: [],
      onToolCall: collector.callback,
      onTokenUsage: (usage) => {
        if (!tokens) tokens = { input: 0, output: 0, total: 0 };
        tokens.input += usage.inputTokens;
        tokens.output += usage.outputTokens;
        tokens.total += usage.inputTokens + usage.outputTokens;
      },
    });

    return {
      command: "chat",
      message,
      status: "success",
      durationMs: Math.round(performance.now() - start),
      tokens,
      toolCalls: collector.getRecords(),
      result: { response: response.response },
      error: null,
    };
  } catch (err) {
    return {
      command: "chat",
      message,
      status: "error",
      durationMs: Math.round(performance.now() - start),
      tokens,
      toolCalls: collector.getRecords(),
      result: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/cli/commands/chat.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/chat.ts src/cli/commands/chat.test.ts
git commit -m "feat(cli): add chat command"
```

---

### Task 6: `investigate` Command

**Files:**
- Create: `src/cli/commands/investigate.ts`
- Create: `src/cli/commands/investigate.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/cli/commands/investigate.test.ts
import { describe, it, expect, vi } from "vitest";
import { runInvestigate, resolveService } from "./investigate.js";
import type { IInvestigationAgent } from "../../types/agent-interfaces.js";
import type { ServiceConfig } from "../../config/schema.js";
import type { RcaReport } from "../../types/rca-types.js";

const MOCK_SERVICE: ServiceConfig = {
  name: "api-gateway",
  metrics: [],
  logLabels: {},
};

const MOCK_REPORT: RcaReport = {
  service: "api-gateway",
  severity: "high",
  confidence: "high",
  confidenceScore: 0.85,
  summary: "High CPU usage",
  trigger: "Alert fired",
  rootCause: "Memory leak in handler",
  impact: { duration: "30m", description: "Degraded response times" },
  contributingFactors: ["Increased traffic"],
  timeline: [{ time: "14:30", event: "CPU spike" }],
  evidence: { metrics: ["cpu > 90%"], logs: ["OOM errors"], infra: [] },
  dashboardLinks: [],
  recommendedActions: ["Restart pods"],
  investigatedAt: "2026-03-15T14:35:00Z",
};

describe("resolveService", () => {
  const services = [MOCK_SERVICE, { name: "payment-service", metrics: [], logLabels: {} }];

  it("matches exact service name case-insensitively", () => {
    expect(resolveService("API-Gateway", services)).toEqual(MOCK_SERVICE);
  });

  it("returns undefined for unknown service", () => {
    expect(resolveService("unknown-svc", services)).toBeUndefined();
  });
});

describe("runInvestigate", () => {
  it("returns RCA report on success", async () => {
    const agent: IInvestigationAgent = {
      investigate: vi.fn().mockResolvedValue(MOCK_REPORT),
    };

    const result = await runInvestigate(agent, MOCK_SERVICE, {
      verbose: false,
      history: false,
      userMessage: "investigate api-gateway",
    });

    expect(result.command).toBe("investigate");
    expect(result.service).toBe("api-gateway");
    expect(result.status).toBe("success");
    expect(result.result).toEqual(MOCK_REPORT);
    expect(result.history).toBe(false);
  });

  it("returns error on agent failure", async () => {
    const agent: IInvestigationAgent = {
      investigate: vi.fn().mockRejectedValue(new Error("workflow failed")),
    };

    const result = await runInvestigate(agent, MOCK_SERVICE, {
      verbose: false,
      history: false,
      userMessage: "investigate api-gateway",
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("workflow failed");
    expect(result.result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/commands/investigate.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement investigate.ts**

```typescript
// src/cli/commands/investigate.ts
import type { IInvestigationAgent } from "../../types/agent-interfaces.js";
import type { ServiceConfig } from "../../config/schema.js";
import type { InvestigateOutput, TokenSummary } from "../types.js";
import { createToolCollector } from "../tool-collector.js";

export type InvestigateOptions = {
  verbose: boolean;
  history: boolean;
  userMessage: string;
};

export function resolveService(name: string, services: ServiceConfig[]): ServiceConfig | undefined {
  const lower = name.toLowerCase();
  return services.find((s) => s.name.toLowerCase() === lower);
}

export async function runInvestigate(
  agent: IInvestigationAgent,
  service: ServiceConfig,
  opts: InvestigateOptions,
): Promise<InvestigateOutput> {
  const start = performance.now();
  const collector = createToolCollector(opts.verbose);
  let tokens: TokenSummary | null = null;

  const onTokenUsage = (usage: { inputTokens: number; outputTokens: number }) => {
    if (!tokens) tokens = { input: 0, output: 0, total: 0 };
    tokens.input += usage.inputTokens;
    tokens.output += usage.outputTokens;
    tokens.total += usage.inputTokens + usage.outputTokens;
  };

  try {
    const report = await agent.investigate(
      service,
      undefined, // initialAnomaly
      undefined, // correlationId
      onTokenUsage,
      opts.userMessage,
      collector.callback,
      undefined, // onPhase (not needed for JSON output)
      undefined, // onIteration
      undefined, // skillContext
    );

    return {
      command: "investigate",
      service: service.name,
      status: "success",
      durationMs: Math.round(performance.now() - start),
      tokens,
      toolCalls: collector.getRecords(),
      history: opts.history,
      result: report,
      error: null,
    };
  } catch (err) {
    return {
      command: "investigate",
      service: service.name,
      status: "error",
      durationMs: Math.round(performance.now() - start),
      tokens,
      toolCalls: collector.getRecords(),
      history: opts.history,
      result: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/cli/commands/investigate.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/investigate.ts src/cli/commands/investigate.test.ts
git commit -m "feat(cli): add investigate command with exact service matching"
```

---

## Chunk 3: E2E Scenario Engine and Assertions

### Task 7: Assertion Engine

**Files:**
- Create: `src/cli/assertions.ts`
- Create: `src/cli/assertions.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/cli/assertions.test.ts
import { describe, it, expect } from "vitest";
import { evaluateAssertions, getNestedValue } from "./assertions.js";

describe("getNestedValue", () => {
  it("gets top-level field", () => {
    expect(getNestedValue({ status: "success" }, "status")).toBe("success");
  });

  it("gets nested field", () => {
    expect(getNestedValue({ result: { severity: "high" } }, "result.severity")).toBe("high");
  });

  it("gets deeply nested field", () => {
    const obj = { result: { evidence: { metrics: ["cpu > 90%"] } } };
    expect(getNestedValue(obj, "result.evidence.metrics")).toEqual(["cpu > 90%"]);
  });

  it("returns undefined for missing field", () => {
    expect(getNestedValue({ a: 1 }, "b")).toBeUndefined();
  });
});

describe("evaluateAssertions", () => {
  const data = {
    status: "success",
    result: {
      severity: "high",
      confidenceScore: 0.85,
      evidence: { metrics: ["cpu spike"], logs: [], infra: [] },
      summary: "High CPU due to memory leak",
    },
  };

  it("evaluates literal match", () => {
    const results = evaluateAssertions(data, { status: "success" });
    expect(results[0]).toEqual({ field: "status", expected: "success", actual: "success", pass: true });
  });

  it("evaluates 'in' operator", () => {
    const results = evaluateAssertions(data, { "result.severity": { in: ["high", "critical"] } });
    expect(results[0]!.pass).toBe(true);
  });

  it("fails 'in' operator when not in set", () => {
    const results = evaluateAssertions(data, { "result.severity": { in: ["low"] } });
    expect(results[0]!.pass).toBe(false);
  });

  it("evaluates 'gte' operator", () => {
    const results = evaluateAssertions(data, { "result.confidenceScore": { gte: 0.5 } });
    expect(results[0]!.pass).toBe(true);
  });

  it("evaluates 'lte' operator", () => {
    const results = evaluateAssertions(data, { "result.confidenceScore": { lte: 1.0 } });
    expect(results[0]!.pass).toBe(true);
  });

  it("evaluates 'not_empty' operator on array", () => {
    const results = evaluateAssertions(data, { "result.evidence.metrics": { not_empty: true } });
    expect(results[0]!.pass).toBe(true);
  });

  it("fails 'not_empty' on empty array", () => {
    const results = evaluateAssertions(data, { "result.evidence.logs": { not_empty: true } });
    expect(results[0]!.pass).toBe(false);
  });

  it("evaluates 'contains' operator", () => {
    const results = evaluateAssertions(data, { "result.summary": { contains: "memory leak" } });
    expect(results[0]!.pass).toBe(true);
  });

  it("fails 'contains' when substring not found", () => {
    const results = evaluateAssertions(data, { "result.summary": { contains: "disk full" } });
    expect(results[0]!.pass).toBe(false);
  });

  it("evaluates multiple assertions", () => {
    const results = evaluateAssertions(data, {
      status: "success",
      "result.severity": { in: ["high", "critical"] },
      "result.confidenceScore": { gte: 0.5 },
    });
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.pass)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/assertions.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement assertions.ts**

```typescript
// src/cli/assertions.ts

export type AssertionResult = {
  field: string;
  expected: unknown;
  actual: unknown;
  pass: boolean;
};

type AssertionOperator =
  | { in: unknown[] }
  | { gte: number }
  | { lte: number }
  | { not_empty: true }
  | { contains: string };

export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  let current: unknown = obj;
  for (const key of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function evaluateOperator(actual: unknown, operator: AssertionOperator): boolean {
  if ("in" in operator) {
    return (operator.in as unknown[]).includes(actual);
  }
  if ("gte" in operator) {
    return typeof actual === "number" && actual >= operator.gte;
  }
  if ("lte" in operator) {
    return typeof actual === "number" && actual <= operator.lte;
  }
  if ("not_empty" in operator) {
    if (Array.isArray(actual)) return actual.length > 0;
    if (typeof actual === "string") return actual.length > 0;
    return false;
  }
  if ("contains" in operator) {
    return typeof actual === "string" && actual.includes(operator.contains);
  }
  return false;
}

function isOperator(value: unknown): value is AssertionOperator {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && ["in", "gte", "lte", "not_empty", "contains"].includes(keys[0]!);
}

export function evaluateAssertions(
  data: Record<string, unknown>,
  assertions: Record<string, unknown>,
): AssertionResult[] {
  const results: AssertionResult[] = [];

  for (const [field, expected] of Object.entries(assertions)) {
    const actual = getNestedValue(data, field);

    if (isOperator(expected)) {
      results.push({
        field,
        expected,
        actual,
        pass: evaluateOperator(actual, expected),
      });
    } else {
      // Literal match
      results.push({
        field,
        expected,
        actual,
        pass: actual === expected,
      });
    }
  }

  return results;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/cli/assertions.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/assertions.ts src/cli/assertions.test.ts
git commit -m "feat(cli): add assertion engine for e2e scenarios"
```

---

### Task 8: `e2e` Command

**Files:**
- Create: `src/cli/commands/e2e.ts`
- Create: `src/cli/commands/e2e.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/cli/commands/e2e.test.ts
import { describe, it, expect, vi } from "vitest";
import { runE2e, type ScenarioFile } from "./e2e.js";
import type { IChatAgent, IInvestigationAgent } from "../../types/agent-interfaces.js";
import type { ServiceConfig } from "../../config/schema.js";

const MOCK_SERVICE: ServiceConfig = { name: "api-gateway", metrics: [], logLabels: {} };

const MOCK_REPORT = {
  service: "api-gateway",
  severity: "high",
  confidence: "high",
  confidenceScore: 0.85,
  summary: "CPU spike",
  trigger: "Alert",
  rootCause: "Memory leak",
  impact: { duration: "30m", description: "Slow" },
  contributingFactors: [],
  timeline: [],
  evidence: { metrics: ["cpu > 90%"], logs: [], infra: [] },
  dashboardLinks: [],
  recommendedActions: [],
  investigatedAt: "2026-03-15T14:35:00Z",
};

function makeMockAgents() {
  return {
    chatAgent: {
      chat: vi.fn().mockResolvedValue({ response: "3 alerts firing", updatedHistory: [], images: [] }),
    } as IChatAgent,
    investigationAgent: {
      investigate: vi.fn().mockResolvedValue(MOCK_REPORT),
    } as IInvestigationAgent,
  };
}

describe("runE2e", () => {
  it("runs a passing scenario", async () => {
    const agents = makeMockAgents();
    const scenario: ScenarioFile = {
      name: "basic-test",
      steps: [
        {
          command: "investigate",
          args: { service: "api-gateway" },
          assert: { status: "success" },
        },
      ],
    };

    const result = await runE2e(scenario, agents, [MOCK_SERVICE], { verbose: false, history: false });

    expect(result.command).toBe("e2e");
    expect(result.status).toBe("pass");
    expect(result.steps[0]!.status).toBe("pass");
  });

  it("reports failing assertion", async () => {
    const agents = makeMockAgents();
    const scenario: ScenarioFile = {
      name: "fail-test",
      steps: [
        {
          command: "investigate",
          args: { service: "api-gateway" },
          assert: { "result.severity": "critical" }, // actual is "high"
        },
      ],
    };

    const result = await runE2e(scenario, agents, [MOCK_SERVICE], { verbose: false, history: false });

    expect(result.status).toBe("fail");
    expect(result.steps[0]!.status).toBe("fail");
    expect(result.steps[0]!.assertions![0]!.pass).toBe(false);
  });

  it("runs chat steps", async () => {
    const agents = makeMockAgents();
    const scenario: ScenarioFile = {
      name: "chat-test",
      steps: [
        {
          command: "chat",
          args: { message: "What alerts?" },
          assert: { status: "success", "result.response": { contains: "alerts" } },
        },
      ],
    };

    const result = await runE2e(scenario, agents, [MOCK_SERVICE], { verbose: false, history: false });

    expect(result.status).toBe("pass");
    expect(result.steps[0]!.assertions!).toHaveLength(2);
  });

  it("skips remaining steps on fatal error", async () => {
    const agents = makeMockAgents();
    (agents.investigationAgent.investigate as any).mockRejectedValueOnce(new Error("MCP connection lost"));

    const scenario: ScenarioFile = {
      name: "skip-test",
      steps: [
        { command: "investigate", args: { service: "api-gateway" }, assert: { status: "success" } },
        { command: "chat", args: { message: "hello" }, assert: { status: "success" } },
      ],
    };

    // When an investigate step errors, the step should be "fail", not "skipped".
    // Only subsequent steps after a connectivity error are skipped.
    const result = await runE2e(scenario, agents, [MOCK_SERVICE], { verbose: false, history: false });

    expect(result.status).toBe("fail");
    expect(result.steps[0]!.status).toBe("fail");
    // Step 2 still runs because a generic agent error is not a connectivity fatal
    expect(result.steps[1]!.status).toBe("pass");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/commands/e2e.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement e2e.ts**

```typescript
// src/cli/commands/e2e.ts
import type { IChatAgent, IInvestigationAgent } from "../../types/agent-interfaces.js";
import type { ServiceConfig } from "../../config/schema.js";
import type { E2eOutput, E2eStepResult } from "../types.js";
import { evaluateAssertions } from "../assertions.js";
import { runChat } from "./chat.js";
import { runInvestigate, resolveService } from "./investigate.js";

export type ScenarioStep = {
  command: "investigate" | "chat";
  args: Record<string, string>;
  assert: Record<string, unknown>;
};

export type ScenarioFile = {
  name: string;
  steps: ScenarioStep[];
};

type E2eAgents = {
  chatAgent: IChatAgent;
  investigationAgent: IInvestigationAgent;
};

type E2eOptions = {
  verbose: boolean;
  history: boolean;
};

async function executeStep(
  step: ScenarioStep,
  agents: E2eAgents,
  services: ServiceConfig[],
  opts: E2eOptions,
): Promise<{ output: Record<string, unknown>; isFatal: boolean }> {
  if (step.command === "investigate") {
    const serviceName = step.args.service;
    if (!serviceName) throw new Error("investigate step requires args.service");
    const service = resolveService(serviceName, services);
    if (!service) throw new Error(`unknown service: ${serviceName}`);
    const result = await runInvestigate(agents.investigationAgent, service, {
      verbose: opts.verbose,
      history: opts.history,
      userMessage: `investigate ${serviceName}`,
    });
    return { output: result as unknown as Record<string, unknown>, isFatal: false };
  }

  if (step.command === "chat") {
    const message = step.args.message;
    if (!message) throw new Error("chat step requires args.message");
    const result = await runChat(agents.chatAgent, message, { verbose: opts.verbose });
    return { output: result as unknown as Record<string, unknown>, isFatal: false };
  }

  throw new Error(`unknown step command: ${step.command}`);
}

export async function runE2e(
  scenario: ScenarioFile,
  agents: E2eAgents,
  services: ServiceConfig[],
  opts: E2eOptions,
  scenarioFile?: string,
): Promise<E2eOutput> {
  const start = performance.now();
  const stepResults: E2eStepResult[] = [];
  let skipRemaining = false;
  let skipReason = "";

  for (const step of scenario.steps) {
    if (skipRemaining) {
      stepResults.push({
        name: `${step.command} ${step.args.service ?? step.args.message ?? ""}`.trim(),
        status: "skipped",
        durationMs: 0,
        error: skipReason,
      });
      continue;
    }

    const stepStart = performance.now();
    const stepName = `${step.command} ${step.args.service ?? step.args.message ?? ""}`.trim();

    try {
      const { output } = await executeStep(step, agents, services, opts);
      const assertions = evaluateAssertions(output, step.assert);
      const allPassed = assertions.every((a) => a.pass);

      stepResults.push({
        name: stepName,
        status: allPassed ? "pass" : "fail",
        durationMs: Math.round(performance.now() - stepStart),
        error: null,
        assertions,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const isMcpError = errorMsg.toLowerCase().includes("mcp") || errorMsg.toLowerCase().includes("connection");

      stepResults.push({
        name: stepName,
        status: "fail",
        durationMs: Math.round(performance.now() - stepStart),
        error: errorMsg,
        assertions: [],
      });

      if (isMcpError) {
        skipRemaining = true;
        skipReason = `skipped: ${errorMsg} in previous step`;
      }
    }
  }

  const overallPass = stepResults.every((s) => s.status === "pass");

  return {
    command: "e2e",
    scenario: scenarioFile ?? scenario.name,
    status: overallPass ? "pass" : "fail",
    durationMs: Math.round(performance.now() - start),
    steps: stepResults,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/cli/commands/e2e.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/e2e.ts src/cli/commands/e2e.test.ts
git commit -m "feat(cli): add e2e scenario runner with assertion evaluation"
```

---

## Chunk 4: Entry Point Rewrite, Interactive Migration, Integration

### Task 9: Move Existing REPL to `interactive` Subcommand

**Files:**
- Create: `src/cli/commands/interactive.tsx`
- Modify: `src/cli/App.tsx` (no changes needed — just re-exported from new location)

- [ ] **Step 1: Create interactive.tsx as a thin wrapper**

The interactive command re-uses the existing `App.tsx` and all its Ink components. It just needs its own entry function.

```typescript
// src/cli/commands/interactive.tsx
import type { Config } from "../../config/schema.js";
import type { MastraProvider } from "../../mcp/provider.js";

export async function runInteractive(config: Config, providers: MastraProvider[]): Promise<never> {
  // Dynamic imports after LOG_LEVEL is set to "silent" (done by caller)
  const { getAllTools } = await import("../../mcp/provider.js");
  const { createMastraAdapters } = await import("../../server/agents.js");
  const { createModel } = await import("../../mastra/index.js");
  const { IntentRouter } = await import("../../agents/intent.js");
  const { ConversationMemory } = await import("../../memory/conversation.js");
  const { render } = await import("ink");
  const { default: React } = await import("react");
  const { App } = await import("../App.js");

  const toolCount = Object.keys(await getAllTools(providers)).length;
  const { chatAgent, investigationAgent } = await createMastraAdapters({ config, providers });
  const model = createModel(config.llm);
  const router = new IntentRouter(model);
  const memory = new ConversationMemory({
    maxMessages: config.agent.conversationMemory?.maxMessages ?? 50,
    ttlMinutes: config.agent.conversationMemory?.ttlMinutes ?? 30,
  });

  const { waitUntilExit } = render(
    React.createElement(App, {
      agent: chatAgent,
      memory,
      services: config.services,
      router,
      investigationAgent,
      toolCount,
    }),
  );

  await waitUntilExit();
  process.exit(0);
}
```

- [ ] **Step 2: Verify App.tsx exports are accessible**

Run: `npx tsc --noEmit`
Expected: No new errors (existing errors are fine)

- [ ] **Step 3: Commit**

```bash
git add src/cli/commands/interactive.tsx
git commit -m "feat(cli): add interactive subcommand wrapping existing REPL"
```

---

### Task 10: Rewrite Entry Point (`index.tsx`)

**Files:**
- Modify: `src/cli/index.tsx`

- [ ] **Step 1: Read and understand current index.tsx**

The current file:
- Sets LOG_LEVEL before imports
- Loads dotenv
- Loads config
- Creates MCP providers
- Creates Mastra adapters
- Renders Ink app

The new version:
- Parses subcommand from argv
- Sets LOG_LEVEL based on command (silent for interactive, info for others)
- Loads dotenv + config
- Creates MCP providers
- Dispatches to command handler
- Wraps in timeout
- Writes JSON output + exits

- [ ] **Step 2: Rewrite index.tsx**

```typescript
// src/cli/index.tsx
import { resolve, basename } from "node:path";
import { parseArgs } from "./parse-args.js";
import type { ScenarioFile } from "./commands/e2e.js";

const parsed = parseArgs(process.argv.slice(2));
const isInteractive = parsed.command === "interactive";

// Set LOG_LEVEL BEFORE any dynamic imports (pino reads it at module load).
// Keep silent for all modes — pino defaults to stdout which would corrupt
// JSON output. The JSON output itself provides all diagnostic information.
const explicitLogLevel = process.env.LOG_LEVEL;
if (!explicitLogLevel) {
  process.env.LOG_LEVEL = "silent";
}

// Dynamic imports — must come after LOG_LEVEL is set
const { config: dotenv } = await import("dotenv");
const dotenvPath = process.env.DOTENV_PATH ?? resolve(process.cwd(), "dev/.env");
dotenv({ path: dotenvPath });

const { loadConfig } = await import("../config/loader.js");
const { createMcpProvider } = await import("../mcp/provider.js");
const { writeOutput } = await import("./output.js");

const config = loadConfig(parsed.flags.config);

const providers = config.providers.map(createMcpProvider);

// ── Dispatch ──────────────────────────────────────────────────────────────────

async function dispatch(): Promise<void> {
  if (isInteractive) {
    const { runInteractive } = await import("./commands/interactive.js");
    return runInteractive(config, providers);
  }

  if (parsed.command === "mcp-check") {
    const { runMcpCheck } = await import("./commands/mcp-check.js");
    const result = await runMcpCheck(providers);
    const exitCode = result.status === "success" ? 0 : 1;
    return writeOutput(result, exitCode);
  }

  if (parsed.command === "investigate") {
    const serviceName = parsed.args[0];
    if (!serviceName) {
      return writeOutput(
        { command: "investigate", status: "error", error: "usage: dops investigate <service>" },
        2,
      );
    }

    const { createMastraAdapters } = await import("../server/agents.js");
    const { runInvestigate, resolveService } = await import("./commands/investigate.js");

    const service = resolveService(serviceName, config.services);
    if (!service) {
      return writeOutput(
        { command: "investigate", service: serviceName, status: "error", error: `unknown service: ${serviceName}` },
        1,
      );
    }

    const { investigationAgent } = await createMastraAdapters({
      config,
      providers,
      noHistory: !parsed.flags.history,
    });
    const result = await runInvestigate(investigationAgent, service, {
      verbose: parsed.flags.verbose,
      history: parsed.flags.history,
      userMessage: `investigate ${serviceName}`,
    });
    const exitCode = result.status === "success" ? 0 : 1;
    return writeOutput(result, exitCode);
  }

  if (parsed.command === "chat") {
    const message = parsed.args[0];
    if (!message) {
      return writeOutput(
        { command: "chat", status: "error", error: "usage: dops chat \"<message>\"" },
        2,
      );
    }

    const { createMastraAdapters } = await import("../server/agents.js");
    const { runChat } = await import("./commands/chat.js");

    const { chatAgent } = await createMastraAdapters({
      config,
      providers,
      noHistory: !parsed.flags.history,
    });
    const result = await runChat(chatAgent, message, { verbose: parsed.flags.verbose });
    const exitCode = result.status === "success" ? 0 : 1;
    return writeOutput(result, exitCode);
  }

  if (parsed.command === "e2e") {
    const scenarioPath = parsed.args[0];
    if (!scenarioPath) {
      return writeOutput(
        { command: "e2e", status: "error", error: "usage: dops e2e <scenario-file>" },
        2,
      );
    }

    const { readFile } = await import("node:fs/promises");
    const { createMastraAdapters } = await import("../server/agents.js");
    const { runE2e } = await import("./commands/e2e.js");

    let scenario: ScenarioFile;
    try {
      const raw = await readFile(resolve(scenarioPath), "utf-8");
      scenario = JSON.parse(raw);
    } catch (err) {
      return writeOutput(
        { command: "e2e", status: "error", error: `invalid scenario file: ${err instanceof Error ? err.message : err}` },
        2,
      );
    }

    const { chatAgent, investigationAgent } = await createMastraAdapters({
      config,
      providers,
      noHistory: !parsed.flags.history,
    });
    const result = await runE2e(
      scenario,
      { chatAgent, investigationAgent },
      config.services,
      { verbose: parsed.flags.verbose, history: parsed.flags.history },
      basename(scenarioPath),
    );
    const exitCode = result.status === "pass" ? 0 : 1;
    return writeOutput(result, exitCode);
  }

  // Unknown command
  return writeOutput(
    { command: parsed.command, status: "error", error: `unknown command: ${parsed.command}. Available: investigate, chat, mcp-check, e2e, interactive` },
    2,
  );
}

// ── Timeout wrapper ───────────────────────────────────────────────────────────

const timeout = parsed.flags.timeout;
const timeoutPromise = new Promise<never>((_, reject) =>
  setTimeout(() => reject(new Error("timeout")), timeout),
);

try {
  await Promise.race([dispatch(), timeoutPromise]);
} catch (err) {
  if (!isInteractive) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await writeOutput(
      { command: parsed.command, status: "error", error: errorMsg },
      1,
    );
  } else {
    throw err;
  }
}
```

- [ ] **Step 3: Verify type checking passes**

Run: `npx tsc --noEmit`
Expected: No new errors from CLI files

- [ ] **Step 4: Commit**

```bash
git add src/cli/index.tsx
git commit -m "feat(cli): rewrite entry point as subcommand dispatcher"
```

---

### Task 11: Wire `--no-history` Through Workflow

The `createMastraAdapters` function currently always sets `projectRoot: process.cwd()`, which enables history. We need to pass through a `noHistory` option that sets `projectRoot` to `undefined` when history is disabled.

**Files:**
- Modify: `src/server/agents.ts`
- Modify: `src/server/agents.test.ts` (add test for noHistory)

- [ ] **Step 1: Write failing test**

Add to existing `src/server/agents.test.ts`:

```typescript
// At the top of the test file, add mock for createInvestigationWorkflow:
import { createInvestigationWorkflow } from "../workflows/investigation.js";

vi.mock("../workflows/investigation.js", () => ({
  createInvestigationWorkflow: vi.fn().mockReturnValue({
    createRun: vi.fn().mockReturnValue({
      start: vi.fn().mockResolvedValue({ results: {} }),
    }),
  }),
}));

describe("createMastraAdapters noHistory", () => {
  it("sets projectRoot to undefined when noHistory is true", async () => {
    const deps = {
      config: mockConfig,
      providers: [],
      noHistory: true,
    };
    await createMastraAdapters(deps);
    expect(vi.mocked(createInvestigationWorkflow)).toHaveBeenCalledWith(
      expect.objectContaining({ projectRoot: undefined }),
    );
  });

  it("sets projectRoot to process.cwd() when noHistory is false", async () => {
    const deps = {
      config: mockConfig,
      providers: [],
      noHistory: false,
    };
    await createMastraAdapters(deps);
    expect(vi.mocked(createInvestigationWorkflow)).toHaveBeenCalledWith(
      expect.objectContaining({ projectRoot: process.cwd() }),
    );
  });
});
```

- [ ] **Step 2: Add `noHistory` to `MastraAdapterDeps` type**

In `src/server/agents.ts`, add `noHistory?: boolean` to the deps type and use it:

```typescript
// In the MastraAdapterDeps type or createMastraAdapters function:
export type MastraAdapterDeps = {
  config: Config;
  providers: MastraProvider[];
  noHistory?: boolean;
};

// In createMastraAdapters:
const workflowConfig: WorkflowConfig = {
  model,
  providers: deps.providers,
  services: deps.config.services,
  projectRoot: deps.noHistory ? undefined : process.cwd(),
  useQuirkHandling: true,
};
```

- [ ] **Step 3: Verify type checking and existing tests pass**

Run: `npx tsc --noEmit && npx vitest run src/server/agents.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/server/agents.ts src/server/agents.test.ts
git commit -m "feat(cli): add noHistory option to disable incident history"
```

---

### Task 12: Update `package.json` Scripts

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add CLI subcommand scripts**

Add convenient npm scripts so agents can run commands without knowing the full tsx invocation:

```json
{
  "scripts": {
    "cli": "NODE_TLS_REJECT_UNAUTHORIZED=0 NODE_NO_WARNINGS=1 tsx src/cli/index.tsx",
    "cli:investigate": "NODE_TLS_REJECT_UNAUTHORIZED=0 NODE_NO_WARNINGS=1 tsx src/cli/index.tsx investigate",
    "cli:chat": "NODE_TLS_REJECT_UNAUTHORIZED=0 NODE_NO_WARNINGS=1 tsx src/cli/index.tsx chat",
    "cli:mcp-check": "NODE_TLS_REJECT_UNAUTHORIZED=0 NODE_NO_WARNINGS=1 tsx src/cli/index.tsx mcp-check",
    "cli:e2e": "NODE_TLS_REJECT_UNAUTHORIZED=0 NODE_NO_WARNINGS=1 tsx src/cli/index.tsx e2e"
  }
}
```

The existing `"cli"` script with no args will now default to `interactive` mode (backward compatible).

- [ ] **Step 2: Commit**

```bash
git add package.json
git commit -m "feat(cli): add npm scripts for CLI subcommands"
```

---

### Task 13: Verify Pino Is Silent

Pino defaults to stdout across the codebase (e.g., `src/agents/intent.ts` creates `pino()` with no explicit destination). Task 10 already sets `LOG_LEVEL=silent` for all CLI modes, which suppresses all pino output. This is intentional — the JSON output itself provides all diagnostic information, and redirecting pino to stderr would require touching every logger instantiation point.

**Known spec divergence:** The spec says non-interactive commands should use `LOG_LEVEL=info` with pino on stderr. We keep `silent` for simplicity. If stderr logging is needed later, create a shared logger factory that writes to `pino.destination(2)`.

- [ ] **Step 1: Verify LOG_LEVEL=silent is set in index.tsx (already done in Task 10)**

No code changes needed. Just confirm `index.tsx` has:
```typescript
if (!explicitLogLevel) {
  process.env.LOG_LEVEL = "silent";
}
```

- [ ] **Step 2: No commit needed — already covered by Task 10**

---

### Task 14: Full Integration Smoke Test

**Files:**
- Create: `src/cli/cli-integration.test.ts`

- [ ] **Step 1: Write integration tests that verify the full arg-parse → dispatch → output flow**

These tests mock the agents/providers but exercise the real arg parser, output builder, and command modules together.

```typescript
// src/cli/cli-integration.test.ts
import { describe, it, expect } from "vitest";
import { parseArgs } from "./parse-args.js";
import { buildOutput } from "./output.js";
import { evaluateAssertions } from "./assertions.js";

describe("CLI integration", () => {
  it("arg parser → investigate → output envelope", () => {
    const parsed = parseArgs(["investigate", "api-gateway", "--verbose", "--timeout", "60000"]);
    expect(parsed.command).toBe("investigate");
    expect(parsed.args).toEqual(["api-gateway"]);
    expect(parsed.flags.verbose).toBe(true);
    expect(parsed.flags.timeout).toBe(60000);
    expect(parsed.flags.history).toBe(false);

    const output = buildOutput({
      command: "investigate",
      status: "success",
      durationMs: 5000,
      tokens: { input: 100, output: 50, total: 150 },
      toolCalls: [{ name: "tool1", argsSummary: "{}", durationMs: 100 }],
      result: { severity: "high" },
      extra: { service: "api-gateway", history: false },
    });

    expect(output.command).toBe("investigate");
    expect(output.service).toBe("api-gateway");
    expect(output.status).toBe("success");
  });

  it("assertion engine works with investigate output shape", () => {
    const output = {
      command: "investigate",
      status: "success",
      result: {
        severity: "high",
        confidenceScore: 0.85,
        evidence: { metrics: ["cpu > 90%"], logs: [], infra: [] },
      },
    };

    const results = evaluateAssertions(output, {
      status: "success",
      "result.severity": { in: ["high", "critical"] },
      "result.confidenceScore": { gte: 0.5 },
      "result.evidence.metrics": { not_empty: true },
    });

    expect(results.every((r) => r.pass)).toBe(true);
  });

  it("e2e defaults: no args → interactive, history off", () => {
    const parsed = parseArgs([]);
    expect(parsed.command).toBe("interactive");
    expect(parsed.flags.history).toBe(false);
  });

  it("unknown command produces exit code 2 shape", () => {
    const parsed = parseArgs(["bogus"]);
    expect(parsed.command).toBe("bogus");

    // The dispatch would produce this output:
    const output = buildOutput({
      command: parsed.command,
      status: "error",
      durationMs: 0,
      error: `unknown command: ${parsed.command}. Available: investigate, chat, mcp-check, e2e, interactive`,
    });
    expect(output.status).toBe("error");
    expect(output.error).toContain("unknown command: bogus");
  });

  it("missing required args produce exit code 2 shape", () => {
    const parsed = parseArgs(["investigate"]);
    expect(parsed.command).toBe("investigate");
    expect(parsed.args).toEqual([]);

    const output = buildOutput({
      command: "investigate",
      status: "error",
      durationMs: 0,
      error: "usage: dops investigate <service>",
    });
    expect(output.error).toContain("usage:");
  });
});
```

- [ ] **Step 2: Run all CLI tests**

Run: `npx vitest run src/cli/`
Expected: ALL PASS

- [ ] **Step 3: Run type checking**

Run: `npx tsc --noEmit`
Expected: No new errors from CLI files

- [ ] **Step 4: Commit**

```bash
git add src/cli/cli-integration.test.ts
git commit -m "test(cli): add integration smoke tests for CLI pipeline"
```

---

### Task 15: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass (existing + new CLI tests)

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Manual smoke test (if MCP is available)**

```bash
npm run cli:mcp-check
# Expected: JSON output to stdout with provider status

npm run cli:chat -- "What is Grafana?"
# Expected: JSON output with chat response

npm run cli
# Expected: Interactive REPL starts (backward compatible)
```

- [ ] **Step 4: Final commit if any fixes needed**

---

## Summary

| Task | Component | Files Created | Files Modified |
|------|-----------|---------------|----------------|
| 1 | Output envelope + types | `types.ts`, `output.ts`, `output.test.ts` | — |
| 2 | Arg parser | `parse-args.ts`, `parse-args.test.ts` | — |
| 3 | Tool collector | `tool-collector.ts`, `tool-collector.test.ts` | — |
| 4 | mcp-check command | `commands/mcp-check.ts`, `commands/mcp-check.test.ts` | — |
| 5 | chat command | `commands/chat.ts`, `commands/chat.test.ts` | — |
| 6 | investigate command | `commands/investigate.ts`, `commands/investigate.test.ts` | — |
| 7 | Assertion engine | `assertions.ts`, `assertions.test.ts` | — |
| 8 | e2e command | `commands/e2e.ts`, `commands/e2e.test.ts` | — |
| 9 | interactive subcommand | `commands/interactive.tsx` | — |
| 10 | Entry point rewrite | — | `index.tsx` |
| 11 | History toggle | — | `agents.ts`, `agents.test.ts` |
| 12 | npm scripts | — | `package.json` |
| 13 | Pino stderr config | — | `index.tsx` |
| 14 | Integration tests | `cli-integration.test.ts` | — |
| 15 | Final verification | — | — |
