# MVP Components Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build all remaining components of the dops-assistant MVP — MCP client, LLM client, agent core, conversation memory, Slack webhook notifier, scheduler, Slack bot, and entry point.

**Architecture:** Bottom-up by dependency layer. Each layer is tested in isolation with mocks for the layer below. Single persistent MCP connection. Agentic loop routes between OpenAI and Grafana MCP tools until a final text response is produced.

**Tech Stack:** TypeScript ESM, `@modelcontextprotocol/sdk`, `openai`, `@slack/bolt`, `node-cron`, `pino`, `zod`, `vitest`

**Working directory for all commands:** `.worktrees/mvp/`

---

## Task 0: Set up Vitest

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`

**Step 1: Install vitest**

```bash
npm install --save-dev vitest
```

**Step 2: Create vitest config**

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
  },
});
```

**Step 3: Add test script to package.json**

In `package.json`, add to `"scripts"`:
```json
"test": "vitest run",
"test:watch": "vitest"
```

**Step 4: Verify vitest works**

```bash
npx vitest run
```
Expected: "No test files found"

**Step 5: Commit**

```bash
git add package.json vitest.config.ts package-lock.json
git commit -m "chore: add vitest"
```

---

## Task 1: MCP Client

**Files:**
- Create: `src/mcp/client.ts`
- Create: `src/mcp/client.test.ts`

**Background:** The MCP client wraps `@modelcontextprotocol/sdk`. It launches the Grafana MCP server as a stdio child process, discovers its tools, and executes tool calls on behalf of the agent. Tools are converted to OpenAI function definition format so the LLM can use them directly.

### Step 1: Write the failing tests

Create `src/mcp/client.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpClient } from "./client.js";
import type { McpServerConfig } from "../config/schema.js";

// Mock the MCP SDK
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({
      tools: [
        {
          name: "query_prometheus",
          description: "Query Prometheus metrics",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "PromQL query" },
            },
            required: ["query"],
          },
        },
        {
          name: "query_loki",
          description: "Query Loki logs",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
            },
          },
        },
      ],
    }),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "result data" }],
    }),
  })),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({})),
}));

const baseConfig: McpServerConfig = {
  command: "npx",
  args: ["-y", "@grafana/mcp-grafana"],
  env: {},
};

describe("McpClient", () => {
  let client: McpClient;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("connects and discovers all tools when no enabledTools filter", async () => {
    client = new McpClient(baseConfig);
    await client.connect();
    const tools = client.getTools();
    expect(tools).toHaveLength(2);
    expect(tools[0].function.name).toBe("query_prometheus");
    expect(tools[1].function.name).toBe("query_loki");
  });

  it("filters tools to only enabledTools when specified", async () => {
    client = new McpClient({ ...baseConfig, enabledTools: ["query_prometheus"] });
    await client.connect();
    const tools = client.getTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].function.name).toBe("query_prometheus");
  });

  it("converts tool schema to OpenAI function definition format", async () => {
    client = new McpClient({ ...baseConfig, enabledTools: ["query_prometheus"] });
    await client.connect();
    const tools = client.getTools();
    expect(tools[0]).toEqual({
      type: "function",
      function: {
        name: "query_prometheus",
        description: "Query Prometheus metrics",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "PromQL query" },
          },
          required: ["query"],
        },
      },
    });
  });

  it("executes a tool call and returns text result", async () => {
    client = new McpClient(baseConfig);
    await client.connect();
    const result = await client.callTool("query_prometheus", { query: "up" });
    expect(result).toBe("result data");
  });

  it("throws if getTools called before connect", () => {
    client = new McpClient(baseConfig);
    expect(() => client.getTools()).toThrow("MCP client not connected");
  });

  it("throws if callTool called before connect", async () => {
    client = new McpClient(baseConfig);
    await expect(client.callTool("query_prometheus", {})).rejects.toThrow("MCP client not connected");
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run src/mcp/client.test.ts
```
Expected: FAIL — "Cannot find module './client.js'"

**Step 3: Implement the MCP client**

Create `src/mcp/client.ts`:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerConfig } from "../config/schema.js";

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
  private client: Client | null = null;
  private tools: OpenAITool[] = [];

  constructor(config: McpServerConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    // TODO: add reconnection logic for future enhancement
    const transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args,
      env: { ...process.env, ...this.config.env } as Record<string, string>,
    });

    this.client = new Client({ name: "dops-assistant", version: "0.1.0" }, { capabilities: {} });
    await this.client.connect(transport);

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

  getTools(): OpenAITool[] {
    if (!this.client) throw new Error("MCP client not connected");
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.client) throw new Error("MCP client not connected");
    const result = await this.client.callTool({ name, arguments: args });
    const parts = result.content as Array<{ type: string; text?: string }>;
    return parts
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("\n");
  }

  async disconnect(): Promise<void> {
    await this.client?.close();
    this.client = null;
    this.tools = [];
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run src/mcp/client.test.ts
```
Expected: all 6 tests PASS

**Step 5: Commit**

```bash
git add src/mcp/client.ts src/mcp/client.test.ts
git commit -m "feat: add MCP client"
```

---

## Task 2: LLM Client

**Files:**
- Create: `src/llm/openai.ts`
- Create: `src/llm/openai.test.ts`

**Background:** Thin wrapper around the `openai` SDK. Sends a message array plus tool definitions to GPT-4 and returns either a final text response or a list of tool calls to execute.

### Step 1: Write the failing tests

Create `src/llm/openai.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { LlmClient } from "./openai.js";
import type { LlmConfig } from "./openai.js";

vi.mock("openai", () => {
  const mockCreate = vi.fn();
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: mockCreate,
        },
      },
    })),
    __mockCreate: mockCreate,
  };
});

const config: LlmConfig = {
  apiKey: "test-key",
  model: "gpt-4",
  maxTokens: 4096,
};

async function getMockCreate() {
  const mod = await import("openai");
  return (mod as unknown as { __mockCreate: ReturnType<typeof vi.fn> }).__mockCreate;
}

describe("LlmClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns text response when no tool calls", async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            role: "assistant",
            content: "Everything looks healthy.",
            tool_calls: null,
          },
          finish_reason: "stop",
        },
      ],
    });

    const client = new LlmClient(config);
    const result = await client.chat([{ role: "user", content: "Check the system." }], []);
    expect(result).toEqual({ type: "text", content: "Everything looks healthy." });
  });

  it("returns tool_calls response when LLM requests tools", async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "query_prometheus", arguments: '{"query":"up"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });

    const client = new LlmClient(config);
    const result = await client.chat([{ role: "user", content: "Check metrics." }], []);
    expect(result).toEqual({
      type: "tool_calls",
      calls: [
        {
          id: "call_1",
          name: "query_prometheus",
          args: { query: "up" },
        },
      ],
    });
  });

  it("passes baseURL to OpenAI client when configured", async () => {
    const OpenAI = (await import("openai")).default;
    new LlmClient({ ...config, baseURL: "https://custom.endpoint/v1" });
    expect(OpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: "https://custom.endpoint/v1" })
    );
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run src/llm/openai.test.ts
```
Expected: FAIL — "Cannot find module './openai.js'"

**Step 3: Implement the LLM client**

Create `src/llm/openai.ts`:

```ts
import OpenAI from "openai";
import type { OpenAITool } from "../mcp/client.js";

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

  constructor(config: LlmConfig) {
    this.config = config;
    this.openai = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    });
  }

  async chat(messages: Message[], tools: OpenAITool[]): Promise<LlmResponse> {
    const response = await this.openai.chat.completions.create({
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
      ...(tools.length > 0 ? { tools: tools as OpenAI.Chat.ChatCompletionTool[] } : {}),
    });

    const message = response.choices[0].message;

    if (message.tool_calls && message.tool_calls.length > 0) {
      return {
        type: "tool_calls",
        calls: message.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          args: JSON.parse(tc.function.arguments) as Record<string, unknown>,
        })),
      };
    }

    return { type: "text", content: message.content ?? "" };
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run src/llm/openai.test.ts
```
Expected: all 3 tests PASS

**Step 5: Commit**

```bash
git add src/llm/openai.ts src/llm/openai.test.ts
git commit -m "feat: add LLM client"
```

---

## Task 3: Agent Core

**Files:**
- Create: `src/agent/types.ts`
- Create: `src/agent/prompts.ts`
- Create: `src/agent/core.ts`
- Create: `src/agent/core.test.ts`

**Background:** The heart of the system. Runs an agentic loop — calls the LLM, if it returns tool calls executes them via MCP and feeds results back, repeats until a text response or maxIterations is reached. History is passed in and returned updated so callers can persist it.

### Step 1: Create types

Create `src/agent/types.ts`:

```ts
import type { Message } from "../llm/openai.js";
import type { ServiceConfig } from "../config/schema.js";

export type AgentMode = "proactive" | "conversational";

export type AgentTask = {
  mode: AgentMode;
  message: string;
  serviceContext?: ServiceConfig[];
  history?: Message[];
};

export type AgentResult = {
  response: string;
  updatedHistory: Message[];
};
```

### Step 2: Create prompts

Create `src/agent/prompts.ts`:

```ts
import type { ServiceConfig } from "../config/schema.js";

export function buildSystemPrompt(mode: "proactive" | "conversational", services?: ServiceConfig[]): string {
  if (mode === "proactive") {
    const serviceList = services
      ?.map((s) => {
        const metrics = s.metrics.map((m) => `  - ${m.description}: \`${m.query}\``).join("\n");
        const logs = Object.entries(s.logLabels ?? {})
          .map(([k, v]) => `${k}=${v}`)
          .join(", ");
        return `Service: ${s.name}\nMetrics:\n${metrics}${logs ? `\nLog labels: {${logs}}` : ""}`;
      })
      .join("\n\n");

    return `You are an infrastructure monitoring agent. Your job is to detect anomalies in the following services by querying Grafana.

For each service, use the available tools to check the metrics and recent logs. Look for:
- Unusually high or low request rates
- Elevated error rates or latency spikes
- Unusual log patterns or errors

If you find anomalies, describe them clearly: which service, what metric, current value vs expected, severity (low/medium/high).
If everything looks healthy, say so briefly.

${serviceList ?? "No services configured."}`;
  }

  return `You are an ops assistant with access to Grafana monitoring data. Answer the user's question using the available tools.
- Be specific: include actual metric values, timestamps, and trends
- Link to dashboards when you find relevant ones
- If you cannot find the data needed, say so clearly`;
}
```

### Step 3: Write the failing tests

Create `src/agent/core.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentCore } from "./core.js";
import type { McpClient } from "../mcp/client.js";
import type { LlmClient } from "../llm/openai.js";

const mockLlm = {
  chat: vi.fn(),
} as unknown as LlmClient;

const mockMcp = {
  getTools: vi.fn().mockReturnValue([
    {
      type: "function",
      function: { name: "query_prometheus", description: "Query metrics", parameters: {} },
    },
  ]),
  callTool: vi.fn(),
} as unknown as McpClient;

describe("AgentCore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns text response directly when LLM produces no tool calls", async () => {
    (mockLlm.chat as ReturnType<typeof vi.fn>).mockResolvedValue({
      type: "text",
      content: "All systems healthy.",
    });

    const core = new AgentCore(mockLlm, mockMcp, { maxIterations: 10 });
    const result = await core.run({ mode: "proactive", message: "Check services." });

    expect(result.response).toBe("All systems healthy.");
    expect(mockLlm.chat).toHaveBeenCalledTimes(1);
  });

  it("executes tool calls and feeds results back to LLM", async () => {
    (mockLlm.chat as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        type: "tool_calls",
        calls: [{ id: "call_1", name: "query_prometheus", args: { query: "up" } }],
      })
      .mockResolvedValueOnce({ type: "text", content: "Metrics look fine." });

    (mockMcp.callTool as ReturnType<typeof vi.fn>).mockResolvedValue("1.0");

    const core = new AgentCore(mockLlm, mockMcp, { maxIterations: 10 });
    const result = await core.run({ mode: "proactive", message: "Check metrics." });

    expect(result.response).toBe("Metrics look fine.");
    expect(mockLlm.chat).toHaveBeenCalledTimes(2);
    expect(mockMcp.callTool).toHaveBeenCalledWith("query_prometheus", { query: "up" });
  });

  it("returns truncation message when maxIterations reached", async () => {
    (mockLlm.chat as ReturnType<typeof vi.fn>).mockResolvedValue({
      type: "tool_calls",
      calls: [{ id: "call_1", name: "query_prometheus", args: {} }],
    });
    (mockMcp.callTool as ReturnType<typeof vi.fn>).mockResolvedValue("data");

    const core = new AgentCore(mockLlm, mockMcp, { maxIterations: 3 });
    const result = await core.run({ mode: "proactive", message: "Check." });

    expect(result.response).toContain("maximum iterations");
  });

  it("includes conversation history in messages", async () => {
    (mockLlm.chat as ReturnType<typeof vi.fn>).mockResolvedValue({
      type: "text",
      content: "Response.",
    });

    const core = new AgentCore(mockLlm, mockMcp, { maxIterations: 10 });
    const history = [
      { role: "user" as const, content: "Earlier message." },
      { role: "assistant" as const, content: "Earlier response." },
    ];
    await core.run({ mode: "conversational", message: "Follow up.", history });

    const callMessages = (mockLlm.chat as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: "Earlier message." }),
        expect.objectContaining({ content: "Earlier response." }),
      ])
    );
  });

  it("returns updatedHistory including new exchange", async () => {
    (mockLlm.chat as ReturnType<typeof vi.fn>).mockResolvedValue({
      type: "text",
      content: "Done.",
    });

    const core = new AgentCore(mockLlm, mockMcp, { maxIterations: 10 });
    const result = await core.run({ mode: "conversational", message: "Hello." });

    const userMsg = result.updatedHistory.find((m) => m.role === "user" && m.content === "Hello.");
    const assistantMsg = result.updatedHistory.find((m) => m.role === "assistant" && m.content === "Done.");
    expect(userMsg).toBeDefined();
    expect(assistantMsg).toBeDefined();
  });
});
```

**Step 4: Run tests to verify they fail**

```bash
npx vitest run src/agent/core.test.ts
```
Expected: FAIL — "Cannot find module './core.js'"

**Step 5: Implement agent core**

Create `src/agent/core.ts`:

```ts
import { buildSystemPrompt } from "./prompts.js";
import type { AgentTask, AgentResult } from "./types.js";
import type { LlmClient, Message } from "../llm/openai.js";
import type { McpClient } from "../mcp/client.js";

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
    const tools = this.mcp.getTools();
    const systemPrompt = buildSystemPrompt(task.mode, task.serviceContext);

    const messages: Message[] = [
      { role: "system", content: systemPrompt },
      ...(task.history ?? []),
      { role: "user", content: task.message },
    ];

    for (let i = 0; i < this.maxIterations; i++) {
      const response = await this.llm.chat(messages, tools);

      if (response.type === "text") {
        messages.push({ role: "assistant", content: response.content });
        return {
          response: response.content,
          updatedHistory: messages.filter((m) => m.role !== "system"),
        };
      }

      // Append assistant message with tool_calls
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: response.calls.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      });

      // Execute tool calls and append results
      for (const call of response.calls) {
        const result = await this.mcp.callTool(call.name, call.args);
        messages.push({
          role: "tool",
          content: result,
          tool_call_id: call.id,
        });
      }
    }

    const truncationMsg = "Reached maximum iterations without a final response.";
    messages.push({ role: "assistant", content: truncationMsg });
    return {
      response: truncationMsg,
      updatedHistory: messages.filter((m) => m.role !== "system"),
    };
  }
}
```

**Step 6: Run tests to verify they pass**

```bash
npx vitest run src/agent/core.test.ts
```
Expected: all 5 tests PASS

**Step 7: Commit**

```bash
git add src/agent/types.ts src/agent/prompts.ts src/agent/core.ts src/agent/core.test.ts
git commit -m "feat: add agent core"
```

---

## Task 4: Conversation Memory

**Files:**
- Create: `src/memory/conversation.ts`
- Create: `src/memory/conversation.test.ts`

**Background:** In-memory store keyed by Slack thread ID. Stores message history with TTL-based eviction and a max message cap. Used by the Slack bot to maintain context across turns in a thread.

### Step 1: Write the failing tests

Create `src/memory/conversation.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ConversationMemory } from "./conversation.js";

describe("ConversationMemory", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns empty array for unknown thread", () => {
    const mem = new ConversationMemory({ maxMessages: 10, ttlMinutes: 60 });
    expect(mem.get("unknown")).toEqual([]);
  });

  it("appends messages and retrieves them", () => {
    const mem = new ConversationMemory({ maxMessages: 10, ttlMinutes: 60 });
    mem.append("thread-1", { role: "user", content: "Hello." });
    mem.append("thread-1", { role: "assistant", content: "Hi." });
    expect(mem.get("thread-1")).toHaveLength(2);
  });

  it("trims to maxMessages when exceeded", () => {
    const mem = new ConversationMemory({ maxMessages: 3, ttlMinutes: 60 });
    mem.append("thread-1", { role: "user", content: "1" });
    mem.append("thread-1", { role: "assistant", content: "2" });
    mem.append("thread-1", { role: "user", content: "3" });
    mem.append("thread-1", { role: "assistant", content: "4" });
    const history = mem.get("thread-1");
    expect(history).toHaveLength(3);
    expect(history[0].content).toBe("2"); // oldest removed
  });

  it("clears a thread", () => {
    const mem = new ConversationMemory({ maxMessages: 10, ttlMinutes: 60 });
    mem.append("thread-1", { role: "user", content: "Hello." });
    mem.clear("thread-1");
    expect(mem.get("thread-1")).toEqual([]);
  });

  it("evicts threads inactive beyond ttlMinutes", () => {
    const mem = new ConversationMemory({ maxMessages: 10, ttlMinutes: 60 });
    mem.append("thread-1", { role: "user", content: "Hello." });

    // Advance 61 minutes, trigger eviction interval
    vi.advanceTimersByTime(61 * 60 * 1000 + 60 * 1000);

    expect(mem.get("thread-1")).toEqual([]);
  });

  it("does not evict active threads", () => {
    const mem = new ConversationMemory({ maxMessages: 10, ttlMinutes: 60 });
    mem.append("thread-1", { role: "user", content: "Hello." });

    vi.advanceTimersByTime(30 * 60 * 1000); // 30 minutes
    mem.append("thread-1", { role: "assistant", content: "Still here." });
    vi.advanceTimersByTime(31 * 60 * 1000 + 60 * 1000); // another 31min + eviction tick

    expect(mem.get("thread-1")).toHaveLength(2);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run src/memory/conversation.test.ts
```
Expected: FAIL — "Cannot find module './conversation.js'"

**Step 3: Implement conversation memory**

Create `src/memory/conversation.ts`:

```ts
import type { Message } from "../llm/openai.js";

type ThreadEntry = {
  messages: Message[];
  lastActivity: Date;
};

export class ConversationMemory {
  private store = new Map<string, ThreadEntry>();
  private maxMessages: number;
  private ttlMs: number;
  private evictionInterval: ReturnType<typeof setInterval>;

  constructor(opts: { maxMessages: number; ttlMinutes: number }) {
    this.maxMessages = opts.maxMessages;
    this.ttlMs = opts.ttlMinutes * 60 * 1000;
    this.evictionInterval = setInterval(() => this.evict(), 60 * 1000);
  }

  get(threadId: string): Message[] {
    return this.store.get(threadId)?.messages ?? [];
  }

  append(threadId: string, message: Message): void {
    const entry = this.store.get(threadId) ?? { messages: [], lastActivity: new Date() };
    entry.messages.push(message);
    if (entry.messages.length > this.maxMessages) {
      entry.messages = entry.messages.slice(entry.messages.length - this.maxMessages);
    }
    entry.lastActivity = new Date();
    this.store.set(threadId, entry);
  }

  clear(threadId: string): void {
    this.store.delete(threadId);
  }

  destroy(): void {
    clearInterval(this.evictionInterval);
  }

  private evict(): void {
    const now = Date.now();
    for (const [id, entry] of this.store) {
      if (now - entry.lastActivity.getTime() > this.ttlMs) {
        this.store.delete(id);
      }
    }
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run src/memory/conversation.test.ts
```
Expected: all 6 tests PASS

**Step 5: Commit**

```bash
git add src/memory/conversation.ts src/memory/conversation.test.ts
git commit -m "feat: add conversation memory"
```

---

## Task 5: Slack Webhook Notifier

**Files:**
- Create: `src/notifications/slack-webhook.ts`
- Create: `src/notifications/slack-webhook.test.ts`

**Background:** Sends a formatted Slack Block Kit message to a webhook URL when the scheduler detects anomalies. Simple fire-and-forget with error handling.

### Step 1: Write the failing tests

Create `src/notifications/slack-webhook.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendAnomalyAlert } from "./slack-webhook.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sendAnomalyAlert", () => {
  it("POSTs a JSON payload to the webhook URL", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await sendAnomalyAlert("https://hooks.slack.com/test", {
      service: "payments-api",
      severity: "high",
      summary: "P99 latency spike detected",
      metrics: ["p99: 4.2s"],
      dashboardUrl: "https://grafana.example.com/d/123",
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://hooks.slack.com/test",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
    );

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.blocks).toBeDefined();
  });

  it("includes service name, severity, and summary in payload", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await sendAnomalyAlert("https://hooks.slack.com/test", {
      service: "checkout-service",
      severity: "medium",
      summary: "Error rate elevated",
    });

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    const blockText = JSON.stringify(body);
    expect(blockText).toContain("checkout-service");
    expect(blockText).toContain("medium");
    expect(blockText).toContain("Error rate elevated");
  });

  it("throws on non-2xx response", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400, statusText: "Bad Request" });

    await expect(
      sendAnomalyAlert("https://hooks.slack.com/test", {
        service: "payments-api",
        severity: "low",
        summary: "Minor issue",
      })
    ).rejects.toThrow("Slack webhook failed: 400 Bad Request");
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run src/notifications/slack-webhook.test.ts
```
Expected: FAIL — "Cannot find module './slack-webhook.js'"

**Step 3: Implement the notifier**

Create `src/notifications/slack-webhook.ts`:

```ts
export type AnomalyAlert = {
  service: string;
  severity: "low" | "medium" | "high";
  summary: string;
  metrics?: string[];
  dashboardUrl?: string;
};

const SEVERITY_EMOJI = { low: ":yellow_circle:", medium: ":orange_circle:", high: ":red_circle:" };

export async function sendAnomalyAlert(webhookUrl: string, alert: AnomalyAlert): Promise<void> {
  const blocks: unknown[] = [
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

  if (alert.metrics && alert.metrics.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Metrics:*\n${alert.metrics.map((m) => `• ${m}`).join("\n")}` },
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

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ blocks }),
  });

  if (!response.ok) {
    throw new Error(`Slack webhook failed: ${response.status} ${response.statusText}`);
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run src/notifications/slack-webhook.test.ts
```
Expected: all 3 tests PASS

**Step 5: Commit**

```bash
git add src/notifications/slack-webhook.ts src/notifications/slack-webhook.test.ts
git commit -m "feat: add Slack webhook notifier"
```

---

## Task 6: Scheduler

**Files:**
- Create: `src/scheduler/scheduler.ts`
- Create: `src/scheduler/scheduler.test.ts`

**Background:** Runs proactive anomaly checks on a cron interval. Converts duration strings like `"5m"` to cron expressions. Runs checks with concurrency limiting. Sends alerts via the notifier when the agent flags anomalies.

**Note on anomaly detection:** The agent response is plain text. The scheduler treats any response that does NOT contain "healthy" or "no anomalies" (case-insensitive) as an anomaly signal. This is a simple heuristic — the agent is prompted to say "everything looks healthy" when there are no issues.

### Step 1: Write the failing tests

Create `src/scheduler/scheduler.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Scheduler, parseDurationToCron } from "./scheduler.js";
import type { AgentCore } from "../agent/core.js";
import type { sendAnomalyAlert } from "../notifications/slack-webhook.js";

describe("parseDurationToCron", () => {
  it("converts 5m to cron expression", () => {
    expect(parseDurationToCron("5m")).toBe("*/5 * * * *");
  });

  it("converts 10m to cron expression", () => {
    expect(parseDurationToCron("10m")).toBe("*/10 * * * *");
  });

  it("converts 1h to cron expression", () => {
    expect(parseDurationToCron("1h")).toBe("0 */1 * * *");
  });

  it("throws on invalid format", () => {
    expect(() => parseDurationToCron("invalid")).toThrow("Unsupported interval format");
  });
});

describe("Scheduler", () => {
  const mockRun = vi.fn();
  const mockAgent = { run: mockRun } as unknown as AgentCore;
  const mockNotify = vi.fn() as unknown as typeof sendAnomalyAlert;

  const services = [
    { name: "payments-api", metrics: [], logLabels: {} },
    { name: "checkout-service", metrics: [], logLabels: {} },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls agent for each service on tick", async () => {
    mockRun.mockResolvedValue({ response: "All healthy.", updatedHistory: [] });

    const scheduler = new Scheduler(
      { interval: "1m", services: ["payments-api", "checkout-service"], maxConcurrency: 5 },
      services,
      mockAgent,
      mockNotify
    );
    scheduler.start();

    await vi.runAllTimersAsync();

    expect(mockRun).toHaveBeenCalledTimes(2);
    expect(mockRun).toHaveBeenCalledWith(expect.objectContaining({ mode: "proactive" }));
  });

  it("calls notifier when agent response signals anomaly", async () => {
    mockRun.mockResolvedValue({
      response: "High latency detected on payments-api: P99 is 4.2s",
      updatedHistory: [],
    });

    const scheduler = new Scheduler(
      { interval: "1m", services: ["payments-api"], maxConcurrency: 5 },
      services,
      mockAgent,
      mockNotify
    );
    scheduler.start();

    await vi.runAllTimersAsync();

    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ service: "payments-api" })
    );
  });

  it("does not call notifier when agent says healthy", async () => {
    mockRun.mockResolvedValue({ response: "Everything looks healthy.", updatedHistory: [] });

    const scheduler = new Scheduler(
      { interval: "1m", services: ["payments-api"], maxConcurrency: 5 },
      services,
      mockAgent,
      mockNotify
    );
    scheduler.start();

    await vi.runAllTimersAsync();

    expect(mockNotify).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run src/scheduler/scheduler.test.ts
```
Expected: FAIL — "Cannot find module './scheduler.js'"

**Step 3: Implement the scheduler**

Create `src/scheduler/scheduler.ts`:

```ts
import cron from "node-cron";
import type { AgentCore } from "../agent/core.js";
import type { AnomalyAlert, sendAnomalyAlert } from "../notifications/slack-webhook.js";
import type { ServiceConfig, AnomalyCheckConfig } from "../config/schema.js";

export function parseDurationToCron(interval: string): string {
  const minuteMatch = interval.match(/^(\d+)m$/);
  if (minuteMatch) return `*/${minuteMatch[1]} * * * *`;

  const hourMatch = interval.match(/^(\d+)h$/);
  if (hourMatch) return `0 */${hourMatch[1]} * * *`;

  throw new Error(`Unsupported interval format: "${interval}". Use e.g. "5m" or "1h".`);
}

function isAnomaly(response: string): boolean {
  const lower = response.toLowerCase();
  return !lower.includes("healthy") && !lower.includes("no anomalies");
}

export class Scheduler {
  private config: AnomalyCheckConfig;
  private services: ServiceConfig[];
  private agent: AgentCore;
  private notify: typeof sendAnomalyAlert;
  private task: cron.ScheduledTask | null = null;
  private webhookUrl: string;

  constructor(
    config: AnomalyCheckConfig,
    services: ServiceConfig[],
    agent: AgentCore,
    notify: typeof sendAnomalyAlert,
    webhookUrl = ""
  ) {
    this.config = config;
    this.services = services;
    this.agent = agent;
    this.notify = notify;
    this.webhookUrl = webhookUrl;
  }

  start(): void {
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
      await Promise.allSettled(
        chunk.map(async (service) => {
          const result = await this.agent.run({
            mode: "proactive",
            message: `Check service: ${service.name}`,
            serviceContext: [service],
          });

          if (isAnomaly(result.response)) {
            const alert: AnomalyAlert = {
              service: service.name,
              severity: "medium",
              summary: result.response,
            };
            await this.notify(this.webhookUrl, alert);
          }
        })
      );
    }
  }
}
```

**Step 4: Export `AnomalyCheckConfig` from schema**

Check `src/config/schema.ts` — add this export at the bottom if not already there:

```ts
export type AnomalyCheckConfig = z.infer<typeof AnomalyCheckSchema>;
```

**Step 5: Run tests to verify they pass**

```bash
npx vitest run src/scheduler/scheduler.test.ts
```
Expected: all 7 tests PASS

**Step 6: Commit**

```bash
git add src/scheduler/scheduler.ts src/scheduler/scheduler.test.ts src/config/schema.ts
git commit -m "feat: add scheduler"
```

---

## Task 7: Slack Bot

**Files:**
- Create: `src/interfaces/slack.ts`
- Create: `src/interfaces/slack.test.ts`

**Background:** Uses `@slack/bolt` in Socket Mode. Listens for mentions and DMs. Maps Slack threads to conversation memory. Calls the agent in conversational mode and posts the response.

### Step 1: Write the failing tests

Create `src/interfaces/slack.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SlackBot } from "./slack.js";
import type { AgentCore } from "../agent/core.js";
import type { ConversationMemory } from "../memory/conversation.js";

// Mock @slack/bolt
const mockSay = vi.fn();
const mockOn = vi.fn();
const mockStart = vi.fn().mockResolvedValue(undefined);
const mockStop = vi.fn().mockResolvedValue(undefined);

vi.mock("@slack/bolt", () => ({
  App: vi.fn().mockImplementation(() => ({
    message: mockOn,
    event: mockOn,
    start: mockStart,
    stop: mockStop,
  })),
}));

const mockAgent = {
  run: vi.fn().mockResolvedValue({ response: "Here is the data.", updatedHistory: [] }),
} as unknown as AgentCore;

const mockMemory = {
  get: vi.fn().mockReturnValue([]),
  append: vi.fn(),
} as unknown as ConversationMemory;

describe("SlackBot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers message and app_mention handlers on start", async () => {
    const bot = new SlackBot(
      { botToken: "xoxb-test", appToken: "xapp-test" },
      mockAgent,
      mockMemory
    );
    await bot.start();
    expect(mockStart).toHaveBeenCalled();
    expect(mockOn).toHaveBeenCalled();
  });

  it("loads history and calls agent with user message", async () => {
    const existingHistory = [{ role: "user" as const, content: "Previous message." }];
    (mockMemory.get as ReturnType<typeof vi.fn>).mockReturnValue(existingHistory);

    const bot = new SlackBot(
      { botToken: "xoxb-test", appToken: "xapp-test" },
      mockAgent,
      mockMemory
    );

    // Simulate the handler being called
    await bot.handleMessage({ text: "How is the system?", threadTs: "123.456", userId: "U123" }, mockSay);

    expect(mockAgent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "conversational",
        message: "How is the system?",
        history: existingHistory,
      })
    );
  });

  it("appends user message and response to memory", async () => {
    const bot = new SlackBot(
      { botToken: "xoxb-test", appToken: "xapp-test" },
      mockAgent,
      mockMemory
    );

    await bot.handleMessage({ text: "Hello.", threadTs: "123.456", userId: "U123" }, mockSay);

    expect(mockMemory.append).toHaveBeenCalledWith(
      "123.456",
      expect.objectContaining({ role: "user", content: "Hello." })
    );
    expect(mockMemory.append).toHaveBeenCalledWith(
      "123.456",
      expect.objectContaining({ role: "assistant", content: "Here is the data." })
    );
  });

  it("posts agent response to the thread", async () => {
    const bot = new SlackBot(
      { botToken: "xoxb-test", appToken: "xapp-test" },
      mockAgent,
      mockMemory
    );

    await bot.handleMessage({ text: "Hello.", threadTs: "123.456", userId: "U123" }, mockSay);

    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Here is the data.",
        thread_ts: "123.456",
      })
    );
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run src/interfaces/slack.test.ts
```
Expected: FAIL — "Cannot find module './slack.js'"

**Step 3: Implement the Slack bot**

Create `src/interfaces/slack.ts`:

```ts
import { App } from "@slack/bolt";
import type { AgentCore } from "../agent/core.js";
import type { ConversationMemory } from "../memory/conversation.js";

type SlackConfig = {
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
  async handleMessage(ctx: MessageContext, say: (msg: object) => Promise<void>): Promise<void> {
    const threadId = ctx.threadTs;
    const history = this.memory.get(threadId);

    this.memory.append(threadId, { role: "user", content: ctx.text });

    const result = await this.agent.run({
      mode: "conversational",
      message: ctx.text,
      history,
    });

    this.memory.append(threadId, { role: "assistant", content: result.response });

    await say({ text: result.response, thread_ts: threadId });
  }

  private registerHandlers(): void {
    // Handle direct messages
    this.app.message(async ({ message, say }) => {
      const msg = message as { text?: string; ts: string; user?: string };
      if (!msg.text) return;
      await this.handleMessage(
        { text: msg.text, threadTs: msg.ts, userId: msg.user ?? "" },
        say as (msg: object) => Promise<void>
      );
    });

    // Handle mentions in channels
    this.app.event("app_mention", async ({ event, say }) => {
      const threadTs = event.thread_ts ?? event.ts;
      await this.handleMessage(
        { text: event.text, threadTs, userId: event.user },
        say as (msg: object) => Promise<void>
      );
    });
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run src/interfaces/slack.test.ts
```
Expected: all 4 tests PASS

**Step 5: Commit**

```bash
git add src/interfaces/slack.ts src/interfaces/slack.test.ts
git commit -m "feat: add Slack bot"
```

---

## Task 8: Entry Point

**Files:**
- Create: `src/index.ts`

**Background:** Wires everything together. No tests — it's pure composition. Loads config, connects MCP, starts scheduler and Slack bot based on config flags, handles graceful shutdown.

**Step 1: Implement entry point**

Create `src/index.ts`:

```ts
import { loadConfig } from "./config/loader.js";
import { McpClient } from "./mcp/client.js";
import { LlmClient } from "./llm/openai.js";
import { AgentCore } from "./agent/core.js";
import { ConversationMemory } from "./memory/conversation.js";
import { sendAnomalyAlert } from "./notifications/slack-webhook.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { SlackBot } from "./interfaces/slack.js";
import pino from "pino";

const logger = pino({ level: "info" });

const configPath = process.env.CONFIG_PATH ?? "config.yaml";

async function main(): Promise<void> {
  logger.info({ configPath }, "Loading config");
  const config = loadConfig(configPath);

  // Layer 1: MCP client
  const mcp = new McpClient(config.grafana.mcpServer);
  logger.info("Connecting to Grafana MCP server...");
  await mcp.connect();
  logger.info("MCP connected");

  // Layer 2: LLM client
  const llm = new LlmClient(config.llm);

  // Layer 3: Agent core
  const agent = new AgentCore(llm, mcp, { maxIterations: config.agent.maxIterations });

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
      webhookUrl
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
      memory
    );
    await slackBot.start();
    logger.info("Slack bot started");
  }

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "Shutting down");
    scheduler?.stop();
    await slackBot?.stop();
    memory.destroy();
    await mcp.disconnect();
    logger.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  logger.info("dops-assistant running");
}

main().catch((err) => {
  logger.error(err, "Fatal error");
  process.exit(1);
});
```

**Step 2: Run full test suite to confirm nothing broken**

```bash
npx vitest run
```
Expected: all tests PASS

**Step 3: Type-check**

```bash
npx tsc --noEmit
```
Expected: no errors

**Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: add entry point — wires all components together"
```

---

## Task 9: Final verification

**Step 1: Run all tests**

```bash
npx vitest run
```
Expected: all tests pass

**Step 2: Build**

```bash
npm run build
```
Expected: `dist/` produced, no TypeScript errors

**Step 3: Commit if any fixes needed, then final commit**

```bash
git add -A
git commit -m "chore: final build verification"
```
