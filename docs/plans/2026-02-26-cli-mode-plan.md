# CLI Mode Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a terminal REPL interface using Ink (React for CLIs) that provides the same conversational and investigation capabilities as the Slack bot.

**Architecture:** A new `src/cli.tsx` entry point wires the same core components (MCP, LLM, AgentCore, IntentClassifier, InvestigationAgent, ConversationMemory) and renders an Ink React app. The app has a TextInput for user messages, a Spinner while thinking, a real-time tool call log, and formatted RCA report output. An `onToolCall` callback added to `AgentTask` enables real-time tool call visibility.

**Tech Stack:** Ink (`ink`, `@inkjs/ui`), React, TypeScript with JSX

---

### Task 1: Install dependencies and configure JSX

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`

**Step 1: Install ink, react, and @inkjs/ui**

Run:
```bash
cd /Users/wli02/Documents/workspace_work/WZ/dops-assistant/.worktrees/mvp && npm install ink react @inkjs/ui && npm install -D @types/react
```

**Step 2: Add JSX support to tsconfig.json**

In `tsconfig.json`, add `"jsx": "react-jsx"` to `compilerOptions`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "jsx": "react-jsx"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", ".worktrees", "src/**/*.test.ts"]
}
```

**Step 3: Add cli script to package.json**

Add to `"scripts"`:

```json
"cli": "tsx src/cli.tsx"
```

**Step 4: Verify tsc still works**

Run: `cd /Users/wli02/Documents/workspace_work/WZ/dops-assistant/.worktrees/mvp && npx tsc --noEmit`
Expected: Clean (0 errors)

**Step 5: Verify tests still pass**

Run: `cd /Users/wli02/Documents/workspace_work/WZ/dops-assistant/.worktrees/mvp && npx vitest run`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json
git commit -m "chore: add ink, react, @inkjs/ui deps and JSX config

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 2: Add onToolCall callback to AgentTask and AgentCore

**Files:**
- Modify: `src/agent/types.ts`
- Modify: `src/agent/core.ts`
- Modify: `src/agent/core.test.ts`

**Step 1: Write the failing test**

Add to `src/agent/core.test.ts`:

```ts
it("calls onToolCall callback before executing each tool", async () => {
  const onToolCall = vi.fn();
  (mockLlm.chat as ReturnType<typeof vi.fn>)
    .mockResolvedValueOnce({
      type: "tool_calls",
      calls: [
        { id: "call_1", name: "query_prometheus", args: { query: "up" } },
        { id: "call_2", name: "query_loki", args: { query: "{app=\"x\"}" } },
      ],
    })
    .mockResolvedValueOnce({ type: "text", content: "Done." });

  (mockMcp.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({ text: "data", images: [] });

  const core = new AgentCore(mockLlm, mockMcp, { maxIterations: 10 });
  await core.run({ mode: "conversational", message: "check", onToolCall });

  expect(onToolCall).toHaveBeenCalledTimes(2);
  expect(onToolCall).toHaveBeenCalledWith("query_prometheus", { query: "up" });
  expect(onToolCall).toHaveBeenCalledWith("query_loki", { query: "{app=\"x\"}" });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/wli02/Documents/workspace_work/WZ/dops-assistant/.worktrees/mvp && npx vitest run src/agent/core.test.ts`
Expected: FAIL — `onToolCall` not in `AgentTask` type

**Step 3: Add onToolCall to AgentTask type**

In `src/agent/types.ts`, add the optional callback:

```ts
export type AgentTask = {
  mode: AgentMode;
  message: string;
  serviceContext?: ServiceConfig[];
  history?: Message[];
  correlationId?: string;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
};
```

**Step 4: Call onToolCall in AgentCore.run()**

In `src/agent/core.ts`, inside the `for` loop where tool calls are dispatched (before `Promise.allSettled`), add:

```ts
// Notify callback for each tool call
for (const call of response.calls) {
  task.onToolCall?.(call.name, call.args);
}
```

Add this right after the `messages.push({ role: "assistant", ... tool_calls ... })` block and before the `const settled = await Promise.allSettled(...)` line.

**Step 5: Run tests to verify they pass**

Run: `cd /Users/wli02/Documents/workspace_work/WZ/dops-assistant/.worktrees/mvp && npx vitest run src/agent/core.test.ts`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add src/agent/types.ts src/agent/core.ts src/agent/core.test.ts
git commit -m "feat: add onToolCall callback to AgentTask for real-time tool visibility

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 3: Create the CLI entry point and App component

**Files:**
- Create: `src/cli.tsx`
- Create: `src/interfaces/cli/App.tsx`

**Step 1: Create the App component**

Create `src/interfaces/cli/App.tsx`:

```tsx
import React, { useState, useCallback } from "react";
import { Box, Text, useApp } from "ink";
import { TextInput, Spinner } from "@inkjs/ui";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentCore } from "../../agent/core.js";
import type { IntentClassifier } from "../../agent/intent.js";
import type { InvestigationAgent } from "../../agent/investigation.js";
import type { ConversationMemory } from "../../memory/conversation.js";
import type { ServiceConfig } from "../../config/schema.js";
import type { RcaReport } from "../../agent/rca-types.js";
import type { ImageAttachment } from "../../agent/types.js";

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "rca" | "error" | "image";
  content: string;
};

type ToolCallEntry = {
  name: string;
  args: string;
};

type AppProps = {
  agent: AgentCore;
  memory: ConversationMemory;
  services: ServiceConfig[];
  classifier: IntentClassifier;
  investigationAgent: InvestigationAgent;
  toolCount: number;
};

function formatRcaText(report: RcaReport): string {
  const severityEmoji: Record<string, string> = {
    low: "🟢", medium: "🟡", high: "🟠", critical: "🔴",
  };
  const emoji = severityEmoji[report.severity] ?? "⚪";
  const actions = report.recommendedActions
    .map((a, i) => `  ${i + 1}. ${a}`)
    .join("\n");
  return [
    `${emoji} RCA Report: ${report.service}`,
    `Severity: ${report.severity} | Confidence: ${report.confidence}`,
    `Root cause: ${report.rootCause}`,
    `Summary: ${report.summary}`,
    report.recommendedActions.length > 0 ? `Actions:\n${actions}` : "",
    `Investigated at: ${report.investigatedAt}`,
  ].filter(Boolean).join("\n");
}

function saveAndOpenImages(images: ImageAttachment[]): string[] {
  const saved: string[] = [];
  for (const img of images) {
    const filePath = join(tmpdir(), `dops-${img.filename}`);
    writeFileSync(filePath, img.data);
    saved.push(filePath);
    if (process.platform === "darwin") {
      execFile("open", [filePath], () => {});
    }
  }
  return saved;
}

export function App({ agent, memory, services, classifier, investigationAgent, toolCount }: AppProps) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isThinking, setIsThinking] = useState(false);
  const [toolCalls, setToolCalls] = useState<ToolCallEntry[]>([]);
  const [thinkingLabel, setThinkingLabel] = useState("Thinking");
  const threadId = "cli-session";

  const addMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  const handleSubmit = useCallback(async (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) return;

    if (trimmed === "exit" || trimmed === "quit") {
      exit();
      return;
    }

    if (trimmed === "clear") {
      setMessages([]);
      return;
    }

    addMessage({ id: randomUUID(), role: "user", content: trimmed });
    setIsThinking(true);
    setToolCalls([]);

    const correlationId = randomUUID().slice(0, 8);

    try {
      // Classify intent
      const intent = await classifier.classify(trimmed);

      if (intent.intent === "investigation") {
        setThinkingLabel("Running investigation");
        const service = services.find((s) => s.name === intent.service)
          ?? services[0];

        if (!service) {
          addMessage({ id: randomUUID(), role: "error", content: "No services configured to investigate." });
          setIsThinking(false);
          return;
        }

        const report = await investigationAgent.investigate(service, undefined, correlationId);
        addMessage({ id: randomUUID(), role: "rca", content: formatRcaText(report) });
      } else {
        setThinkingLabel("Thinking");
        const history = memory.get(threadId);
        memory.append(threadId, { role: "user", content: trimmed });

        const onToolCall = (name: string, args: Record<string, unknown>) => {
          const summary = JSON.stringify(args).slice(0, 80);
          setToolCalls((prev) => [...prev, { name, args: summary }]);
        };

        const result = await agent.run({
          mode: "conversational",
          message: trimmed,
          history,
          correlationId,
          onToolCall,
        });

        memory.append(threadId, { role: "assistant", content: result.response });
        addMessage({ id: randomUUID(), role: "assistant", content: result.response });

        if (result.images.length > 0) {
          const paths = saveAndOpenImages(result.images);
          for (const p of paths) {
            addMessage({ id: randomUUID(), role: "image", content: `📎 Saved: ${p} (opened)` });
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addMessage({ id: randomUUID(), role: "error", content: msg });
    } finally {
      setIsThinking(false);
      setToolCalls([]);
    }
  }, [agent, memory, services, classifier, investigationAgent, addMessage, exit]);

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Message history */}
      {messages.map((msg) => (
        <Box key={msg.id} marginBottom={msg.role === "rca" ? 1 : 0}>
          {msg.role === "user" && (
            <Text>
              <Text bold color="cyan">{"> "}</Text>
              <Text>{msg.content}</Text>
            </Text>
          )}
          {msg.role === "assistant" && (
            <Text color="white">{"  "}{msg.content}</Text>
          )}
          {msg.role === "rca" && (
            <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
              <Text>{msg.content}</Text>
            </Box>
          )}
          {msg.role === "error" && (
            <Text color="red">{"  ✗ "}{msg.content}</Text>
          )}
          {msg.role === "image" && (
            <Text color="green">{"  "}{msg.content}</Text>
          )}
        </Box>
      ))}

      {/* Tool call log */}
      {toolCalls.map((tc, i) => (
        <Text key={i} dimColor>{"  ◼ "}{tc.name}({tc.args})</Text>
      ))}

      {/* Spinner or input */}
      {isThinking ? (
        <Box marginTop={0}>
          <Text>{"  "}</Text>
          <Spinner label={thinkingLabel} />
        </Box>
      ) : (
        <Box marginTop={messages.length > 0 ? 1 : 0}>
          <Text bold color="cyan">{"> "}</Text>
          <TextInput
            placeholder="Ask a question or type 'investigate <service>'..."
            onSubmit={handleSubmit}
          />
        </Box>
      )}
    </Box>
  );
}
```

**Step 2: Create the CLI entry point**

Create `src/cli.tsx`:

```tsx
import React from "react";
import { render, Box, Text } from "ink";
import { loadConfig } from "./config/loader.js";
import { McpClient } from "./mcp/client.js";
import { LlmClient } from "./llm/openai.js";
import { AgentCore } from "./agent/core.js";
import { InvestigationAgent } from "./agent/investigation.js";
import { IntentClassifier } from "./agent/intent.js";
import { ConversationMemory } from "./memory/conversation.js";
import { App } from "./interfaces/cli/App.js";

const configPath = process.env["CONFIG_PATH"] ?? "config.yaml";

async function main(): Promise<void> {
  const config = loadConfig(configPath);

  console.log("");
  console.log("  dops-assistant v0.1.0");
  console.log("  Connecting to Grafana MCP server...");

  const mcp = new McpClient(config.grafana.mcpServer, config.timeouts);
  await mcp.connect();

  const toolCount = mcp.getTools().length;
  console.log(`  Connected to Grafana MCP (${toolCount} tools available)`);
  console.log("");

  const llm = new LlmClient(config.llm, config.timeouts, config.retry);
  const agent = new AgentCore(llm, mcp, { maxIterations: config.agent.maxIterations });
  const memory = new ConversationMemory(config.agent.conversationMemory);
  const investigationAgent = new InvestigationAgent(llm, mcp, { maxIterations: config.agent.maxIterations });
  const classifier = new IntentClassifier(llm);

  const { waitUntilExit } = render(
    <App
      agent={agent}
      memory={memory}
      services={config.services}
      classifier={classifier}
      investigationAgent={investigationAgent}
      toolCount={toolCount}
    />,
  );

  await waitUntilExit();

  memory.destroy();
  await mcp.disconnect();
  console.log("\n  Goodbye!");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
```

**Step 3: Verify it compiles**

Run: `cd /Users/wli02/Documents/workspace_work/WZ/dops-assistant/.worktrees/mvp && npx tsc --noEmit`
Expected: Clean (0 errors)

**Step 4: Verify tests still pass**

Run: `cd /Users/wli02/Documents/workspace_work/WZ/dops-assistant/.worktrees/mvp && npx vitest run`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/cli.tsx src/interfaces/cli/App.tsx
git commit -m "feat: add CLI mode with Ink React terminal UI

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 4: Manual smoke test

**Files:** None (testing only)

This task is manual — verify the CLI starts and works.

**Step 1: Start the grafana-mcp sidecar**

Make sure your grafana-mcp is running (either via docker-compose or standalone).

**Step 2: Run the CLI**

```bash
cd /Users/wli02/Documents/workspace_work/WZ/dops-assistant/.worktrees/mvp
CONFIG_PATH=dev/config.yaml npm run cli
```

Expected: See the banner and a `>` prompt.

**Step 3: Test conversational mode**

Type: `what dashboards are available?`

Expected: Spinner shows, tool calls appear, response prints.

**Step 4: Test exit**

Type: `exit`

Expected: Prints "Goodbye!" and exits cleanly.

**Step 5: Test error handling**

Start the CLI without grafana-mcp running.

Expected: Prints "Fatal error:" with MCP connection error and exits.

---

### Task 5: Update architecture docs

**Files:**
- Modify: `docs/architecture-overiew.md`

**Step 1: Add CLI section**

After the Slack Bot section in `docs/architecture-overiew.md`, add a new section:

```markdown
### CLI Interface

**Files:** `src/cli.tsx`, `src/interfaces/cli/App.tsx`

A terminal REPL built with Ink (React for CLIs). Started via `npm run cli`. Uses the same components as the Slack Bot — AgentCore, IntentClassifier, InvestigationAgent, ConversationMemory — but renders to the terminal instead of Slack.

Features:
- Real-time tool call log (via `onToolCall` callback on `AgentTask`)
- Spinner while the agent is thinking
- RCA reports displayed in bordered boxes
- Images saved to `/tmp` and opened automatically on macOS
- Conversation memory persists across turns within the session
- Special commands: `exit`/`quit`, `clear`
```

**Step 2: Update Entry Point section**

In the Entry Point section, add a note that `src/cli.tsx` is the CLI entry point, started via `npm run cli`, which skips Slack, Scheduler, and ObservabilityServer.

**Step 3: Commit**

```bash
git add docs/architecture-overiew.md
git commit -m "docs: add CLI interface to architecture doc

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```
