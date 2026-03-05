# Grafana Chart Screenshots Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver Grafana panel screenshots inline in Slack alongside agent text responses.

**Architecture:** The MCP client extracts image content from tool results into a `ToolResult` type. The agent core and investigation agent collect images as a side channel during the tool-call loop and return them in `AgentResult.images`. The Slack bot uploads images to threads via `files.uploadV2`.

**Tech Stack:** TypeScript, Vitest, @slack/bolt (web-api), @modelcontextprotocol/sdk

---

### Task 1: Add ImageContent and ToolResult types to MCP client

**Files:**
- Modify: `src/mcp/client.ts` (add types, change `callTool` return type)
- Modify: `src/mcp/client.test.ts` (update assertions + add image test)

**Step 1: Write the failing test**

Add to `src/mcp/client.test.ts` inside the first `describe("McpClient")` block, after the existing `callTool returns [Tool Error]` test:

```ts
it("callTool returns ToolResult with images when result contains image parts", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  client = new McpClient(baseConfig, baseTimeouts);
  await client.connect();
  const instance = (Client as ReturnType<typeof vi.fn>).mock.instances[0];
  instance.callTool.mockResolvedValueOnce({
    content: [
      { type: "text", text: "Panel rendered" },
      { type: "image", mimeType: "image/png", data: "iVBOR...base64..." },
    ],
  });
  const result = await client.callTool("get_panel_image", { dashboardUid: "abc", panelId: 1 });
  expect(result.text).toBe("Panel rendered");
  expect(result.images).toHaveLength(1);
  expect(result.images[0].mimeType).toBe("image/png");
  expect(result.images[0].data).toBe("iVBOR...base64...");
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/wli02/Documents/workspace_work/WZ/dops-assistant/.worktrees/mvp && npx vitest run src/mcp/client.test.ts`
Expected: FAIL — `callTool` returns `string`, not an object with `.text`

**Step 3: Write minimal implementation**

In `src/mcp/client.ts`, add the types after the existing `OpenAITool` type:

```ts
export type ImageContent = {
  mimeType: string;
  data: string;
};

export type ToolResult = {
  text: string;
  images: ImageContent[];
};
```

Change `callTool` return type from `Promise<string>` to `Promise<ToolResult>` and update the body:

```ts
async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (!this.client) throw new Error("MCP client not connected");

  const end = toolDurationSeconds.startTimer({ tool: name });
  try {
    const result = await withTimeout(
      this.client.callTool({ name, arguments: args }),
      this.timeouts.toolExecutionMs,
      `tool:${name}`,
    );
    end();
    const parts = result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    const text = parts
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("\n");
    const images: ImageContent[] = parts
      .filter((p) => p.type === "image")
      .map((p) => ({ mimeType: p.mimeType ?? "image/png", data: p.data ?? "" }));
    toolCallsTotal.inc({ tool: name, status: "success" });
    return { text: result.isError ? `[Tool Error] ${text}` : text, images };
  } catch (err) {
    end();
    toolCallsTotal.inc({
      tool: name,
      status: err instanceof TimeoutError ? "timeout" : "error",
    });
    throw err;
  }
}
```

**Step 4: Fix existing tests**

All existing tests that assert on `callTool` returning a string now need updating. The mock `callTool` in the SDK mock (line 37-39) returns `{ content: [{ type: "text", text: "result data" }] }` — that's fine, it's the SDK mock. But the **assertion** on line 118 checks `expect(result).toBe("result data")` — change it to:

```ts
expect(result.text).toBe("result data");
expect(result.images).toEqual([]);
```

And in the `[Tool Error]` test (line 151), change to:

```ts
expect(result.text).toMatch(/^\[Tool Error\]/);
expect(result.text).toBe("[Tool Error] metric not found");
```

**Step 5: Run tests to verify they pass**

Run: `cd /Users/wli02/Documents/workspace_work/WZ/dops-assistant/.worktrees/mvp && npx vitest run src/mcp/client.test.ts`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add src/mcp/client.ts src/mcp/client.test.ts
git commit -m "feat: MCP callTool returns ToolResult with image support"
```

---

### Task 2: Add ImageAttachment type and images field to AgentResult

**Files:**
- Modify: `src/agent/types.ts`

**Step 1: Add the type and update AgentResult**

In `src/agent/types.ts`, add `ImageAttachment` and update `AgentResult`:

```ts
export type ImageAttachment = {
  filename: string;
  mimeType: string;
  data: Buffer;
};

export type AgentResult = {
  response: string;
  updatedHistory: Message[];
  images: ImageAttachment[];
};
```

**Step 2: Run tsc to verify no errors**

Run: `cd /Users/wli02/Documents/workspace_work/WZ/dops-assistant/.worktrees/mvp && npx tsc --noEmit`
Expected: Compile errors in `core.ts` and `investigation.ts` (they return `AgentResult` without `images`). This is expected and will be fixed in Tasks 3-4.

**Step 3: Commit**

```bash
git add src/agent/types.ts
git commit -m "feat: add ImageAttachment type to AgentResult"
```

---

### Task 3: Update AgentCore to collect images from tool results

**Files:**
- Modify: `src/agent/core.ts`
- Modify: `src/agent/core.test.ts`

**Step 1: Write the failing test**

Add to `src/agent/core.test.ts`:

```ts
it("collects images from tool results and returns them in AgentResult", async () => {
  (mockLlm.chat as ReturnType<typeof vi.fn>)
    .mockResolvedValueOnce({
      type: "tool_calls",
      calls: [{ id: "call_img", name: "get_panel_image", args: { dashboardUid: "abc", panelId: 1 } }],
    })
    .mockResolvedValueOnce({ type: "text", content: "Here is your chart." });

  (mockMcp.callTool as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    text: "Panel rendered",
    images: [{ mimeType: "image/png", data: "aWJhc2U2NA==" }],
  });

  const core = new AgentCore(mockLlm, mockMcp, { maxIterations: 10 });
  const result = await core.run({ mode: "conversational", message: "Show me the error rate chart." });

  expect(result.images).toHaveLength(1);
  expect(result.images[0].filename).toMatch(/^get_panel_image-.+\.png$/);
  expect(result.images[0].mimeType).toBe("image/png");
  expect(result.images[0].data).toBeInstanceOf(Buffer);
});

it("appends image-captured hint to tool result text when images present", async () => {
  (mockLlm.chat as ReturnType<typeof vi.fn>)
    .mockResolvedValueOnce({
      type: "tool_calls",
      calls: [{ id: "call_img", name: "get_panel_image", args: {} }],
    })
    .mockResolvedValueOnce({ type: "text", content: "Done." });

  (mockMcp.callTool as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    text: "Panel rendered",
    images: [{ mimeType: "image/png", data: "abc" }],
  });

  const core = new AgentCore(mockLlm, mockMcp, { maxIterations: 10 });
  await core.run({ mode: "conversational", message: "Chart." });

  const secondCallMessages = (mockLlm.chat as ReturnType<typeof vi.fn>).mock.calls[1][0];
  const toolMsg = secondCallMessages.find(
    (m: { role: string }) => m.role === "tool"
  );
  expect(toolMsg.content).toContain("chart image");
});

it("returns empty images array when no tool calls produce images", async () => {
  (mockLlm.chat as ReturnType<typeof vi.fn>).mockResolvedValue({
    type: "text",
    content: "All good.",
  });

  const core = new AgentCore(mockLlm, mockMcp, { maxIterations: 10 });
  const result = await core.run({ mode: "conversational", message: "status?" });

  expect(result.images).toEqual([]);
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/wli02/Documents/workspace_work/WZ/dops-assistant/.worktrees/mvp && npx vitest run src/agent/core.test.ts`
Expected: FAIL — `result.images` is undefined

**Step 3: Update existing test mocks**

All existing tests in `core.test.ts` that mock `mockMcp.callTool` to return a string need updating to return `ToolResult`:

- `mockMcp.callTool` default mock: change from `.mockResolvedValue("1.0")` to `.mockResolvedValue({ text: "1.0", images: [] })`
- Same for `"data"` and other string returns
- For `.mockRejectedValue(...)` — no change needed (these test the error path)

**Step 4: Write minimal implementation**

In `src/agent/core.ts`:

1. Import `ImageAttachment` from `./types.js` and `randomUUID` from `node:crypto`
2. Add `const collectedImages: ImageAttachment[] = [];` before the loop
3. In the tool result handling section, change from:

```ts
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
```

to:

```ts
const settled = await Promise.allSettled(
  response.calls.map((call) => this.mcp.callTool(call.name, call.args)),
);
for (let j = 0; j < response.calls.length; j++) {
  const outcome = settled[j]!;
  const call = response.calls[j]!;
  let toolText: string;
  if (outcome.status === "fulfilled") {
    const toolResult = outcome.value;
    toolText = toolResult.text;
    for (const img of toolResult.images) {
      collectedImages.push({
        filename: `${call.name}-${randomUUID().slice(0, 8)}.png`,
        mimeType: img.mimeType,
        data: Buffer.from(img.data, "base64"),
      });
    }
    if (toolResult.images.length > 0) {
      toolText += `\n[${toolResult.images.length} chart image(s) captured and will be sent to the user]`;
    }
  } else {
    toolText = `[Transport Error] ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`;
  }
  messages.push({
    role: "tool",
    content: toolText,
    tool_call_id: call.id,
  });
}
```

4. Update both return statements (success + truncation) to include `images: collectedImages`

**Step 5: Run tests to verify they pass**

Run: `cd /Users/wli02/Documents/workspace_work/WZ/dops-assistant/.worktrees/mvp && npx vitest run src/agent/core.test.ts`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add src/agent/core.ts src/agent/core.test.ts
git commit -m "feat: AgentCore collects images from tool results"
```

---

### Task 4: Update InvestigationAgent to handle ToolResult

**Files:**
- Modify: `src/agent/investigation.ts`
- Modify: `src/agent/investigation.test.ts`

**Step 1: Update existing test mocks**

In `src/agent/investigation.test.ts`, the `mockMcp.callTool` returns `"metric data"`. Change to:

```ts
const mockMcp = {
  getTools: vi.fn().mockReturnValue(mockTools),
  callTool: vi.fn().mockResolvedValue({ text: "metric data", images: [] }),
  isConnected: vi.fn().mockReturnValue(true),
} as unknown as McpClient;
```

**Step 2: Update investigation.ts runPhase**

In `src/agent/investigation.ts`, the `runPhase` method calls `this.mcp.callTool` and feeds the result (a string) into messages. Now it returns `ToolResult`. Update the tool result handling in the loop:

```ts
const settled = await Promise.allSettled(
  response.calls.map((call) => this.mcp.callTool(call.name, call.args)),
);
for (let j = 0; j < response.calls.length; j++) {
  const outcome = settled[j]!;
  const call = response.calls[j]!;
  messages.push({
    role: "tool",
    content: outcome.status === "fulfilled"
      ? outcome.value.text
      : `[Transport Error] ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
    tool_call_id: call.id,
  });
}
```

Note: Images from investigation phases are intentionally not collected here. The investigation response is structured JSON, not conversational — screenshots are most useful in conversational responses and Slack thread context. This keeps the investigation pipeline simple.

**Step 3: Run tests to verify they pass**

Run: `cd /Users/wli02/Documents/workspace_work/WZ/dops-assistant/.worktrees/mvp && npx vitest run src/agent/investigation.test.ts`
Expected: ALL PASS

**Step 4: Run full test suite**

Run: `cd /Users/wli02/Documents/workspace_work/WZ/dops-assistant/.worktrees/mvp && npx vitest run`
Expected: ALL PASS (verify no other files break from the ToolResult change)

**Step 5: Commit**

```bash
git add src/agent/investigation.ts src/agent/investigation.test.ts
git commit -m "feat: InvestigationAgent handles ToolResult from MCP client"
```

---

### Task 5: Update SlackBot to upload images

**Files:**
- Modify: `src/interfaces/slack.ts`
- Modify: `src/interfaces/slack.test.ts`

**Step 1: Write the failing test**

Add to `src/interfaces/slack.test.ts`. First, add a mock for `app.client.filesUploadV2`:

In the `vi.hoisted` block, add:

```ts
const mockFilesUploadV2 = vi.fn().mockResolvedValue({ ok: true });
```

Update `MockApp` to include a `client` property:

```ts
const MockApp = vi.fn().mockImplementation(function () {
  return {
    message: mockMessage,
    event: mockEvent,
    start: mockStart,
    stop: mockStop,
    client: { filesUploadV2: mockFilesUploadV2 },
  };
});
```

Then add the test in the main `describe("SlackBot")` block:

```ts
it("uploads images from agent result to Slack thread", async () => {
  const imgBuffer = Buffer.from("fake-png-data");
  (mockAgent.run as ReturnType<typeof vi.fn>).mockResolvedValue({
    response: "Here is the chart.",
    updatedHistory: [],
    images: [
      { filename: "get_panel_image-abc.png", mimeType: "image/png", data: imgBuffer },
    ],
  });

  const bot = new SlackBot(
    { botToken: "xoxb-test", appToken: "xapp-test" },
    mockAgent,
    mockMemory
  );

  await bot.handleMessage(
    { text: "Show error rate", threadTs: "123.456", userId: "U123", channelId: "C123" },
    mockSay,
  );

  expect(mockSay).toHaveBeenCalledWith(expect.objectContaining({ text: "Here is the chart." }));
  expect(mockFilesUploadV2).toHaveBeenCalledWith({
    channel_id: "C123",
    thread_ts: "123.456",
    file: imgBuffer,
    filename: "get_panel_image-abc.png",
  });
});

it("does not call filesUploadV2 when agent result has no images", async () => {
  (mockAgent.run as ReturnType<typeof vi.fn>).mockResolvedValue({
    response: "All good.",
    updatedHistory: [],
    images: [],
  });

  const bot = new SlackBot(
    { botToken: "xoxb-test", appToken: "xapp-test" },
    mockAgent,
    mockMemory
  );

  await bot.handleMessage(
    { text: "status?", threadTs: "123.456", userId: "U123", channelId: "C123" },
    mockSay,
  );

  expect(mockFilesUploadV2).not.toHaveBeenCalled();
});

it("logs warning but does not throw when image upload fails", async () => {
  const imgBuffer = Buffer.from("fake-png-data");
  (mockAgent.run as ReturnType<typeof vi.fn>).mockResolvedValue({
    response: "Here is the chart.",
    updatedHistory: [],
    images: [
      { filename: "chart.png", mimeType: "image/png", data: imgBuffer },
    ],
  });
  mockFilesUploadV2.mockRejectedValueOnce(new Error("upload failed"));

  const bot = new SlackBot(
    { botToken: "xoxb-test", appToken: "xapp-test" },
    mockAgent,
    mockMemory
  );

  // Should not throw — image upload failure is non-fatal
  await bot.handleMessage(
    { text: "chart", threadTs: "123.456", userId: "U123", channelId: "C123" },
    mockSay,
  );

  expect(mockSay).toHaveBeenCalledWith(expect.objectContaining({ text: "Here is the chart." }));
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/wli02/Documents/workspace_work/WZ/dops-assistant/.worktrees/mvp && npx vitest run src/interfaces/slack.test.ts`
Expected: FAIL — `channelId` not in `MessageContext`, no upload logic

**Step 3: Write minimal implementation**

In `src/interfaces/slack.ts`:

1. Add `channelId` to `MessageContext`:

```ts
type MessageContext = {
  text: string;
  threadTs: string;
  userId: string;
  channelId: string;
};
```

2. After the conversational `say()` call, add image upload:

```ts
// Upload images to thread (non-blocking — failures are logged, not thrown)
for (const img of result.images) {
  await this.app.client.filesUploadV2({
    channel_id: ctx.channelId,
    thread_ts: threadId,
    file: img.data,
    filename: img.filename,
  }).catch((err: unknown) => {
    logger.warn({ err, filename: img.filename }, "Failed to upload image to Slack");
  });
}
```

Add a logger at module level (import pino):

```ts
import pino from "pino";
const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });
```

3. Update `registerHandlers` to pass `channelId` from events:

In `app.message` handler:
```ts
const msg = message as { text?: string; ts: string; user?: string; channel?: string };
if (!msg.text) return;
await this.handleMessage(
  { text: msg.text, threadTs: msg.ts, userId: msg.user ?? "", channelId: msg.channel ?? "" },
  say as unknown as (msg: object) => Promise<void>,
);
```

In `app.event("app_mention")` handler:
```ts
const threadTs = event.thread_ts ?? event.ts;
await this.handleMessage(
  { text: event.text, threadTs, userId: event.user ?? "", channelId: event.channel ?? "" },
  say as unknown as (msg: object) => Promise<void>,
);
```

**Step 4: Update existing test handleMessage calls**

All existing test calls to `bot.handleMessage(...)` need to add `channelId`. Add `channelId: "C123"` to every `MessageContext` object in the test file.

**Step 5: Run tests to verify they pass**

Run: `cd /Users/wli02/Documents/workspace_work/WZ/dops-assistant/.worktrees/mvp && npx vitest run src/interfaces/slack.test.ts`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add src/interfaces/slack.ts src/interfaces/slack.test.ts
git commit -m "feat: SlackBot uploads chart images from agent results"
```

---

### Task 6: Update prompts to instruct LLM to use get_panel_image

**Files:**
- Modify: `src/agent/prompts.ts`
- Modify: `src/agent/rca-prompts.ts`
- Modify: `src/agent/prompts.test.ts` (if exists, update assertions)
- Modify: `src/agent/rca-prompts.test.ts`

**Step 1: Update conversational prompt**

In `src/agent/prompts.ts`, update the conversational system prompt (returned when `mode !== "proactive"`):

```ts
return `You are an ops assistant with access to Grafana monitoring data. Answer the user's question using the available tools.
- Be specific: include actual metric values, timestamps, and trends
- Link to dashboards when you find relevant ones
- When discussing metrics, use the get_panel_image tool to capture relevant Grafana panel screenshots. The images will be automatically sent to the user.
- If you cannot find the data needed, say so clearly`;
```

**Step 2: Update RCA metric deep dive prompt**

In `src/agent/rca-prompts.ts`, append to `METRIC_DEEP_DIVE_PROMPT`:

```ts
export const METRIC_DEEP_DIVE_PROMPT = `You are investigating a service anomaly. Your job is to deeply analyse the metrics for the affected service.
Query the metrics to determine:
- What values are currently abnormal (include exact numbers and timestamps)
- What the baseline/normal range appears to be
- When the anomaly window started

After querying metrics, use the get_panel_image tool to capture screenshots of the most relevant Grafana panels showing the anomaly.

Respond ONLY with valid JSON matching the required schema. Do not include any other text.`;
```

**Step 3: Update tests**

In `src/agent/rca-prompts.test.ts`, if there are tests that assert exact prompt text, update them to include the new `get_panel_image` instruction. If tests use `.toContain()` on keywords, they should still pass.

**Step 4: Run tests**

Run: `cd /Users/wli02/Documents/workspace_work/WZ/dops-assistant/.worktrees/mvp && npx vitest run`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/agent/prompts.ts src/agent/rca-prompts.ts src/agent/rca-prompts.test.ts
git commit -m "feat: update prompts to instruct LLM to capture panel screenshots"
```

---

### Task 7: Verify full test suite and type-check

**Files:** None (verification only)

**Step 1: Run type-check**

Run: `cd /Users/wli02/Documents/workspace_work/WZ/dops-assistant/.worktrees/mvp && npx tsc --noEmit`
Expected: Clean (0 errors)

**Step 2: Run full test suite**

Run: `cd /Users/wli02/Documents/workspace_work/WZ/dops-assistant/.worktrees/mvp && npx vitest run`
Expected: ALL PASS

**Step 3: Verify Docker build**

Run: `cd /Users/wli02/Documents/workspace_work/WZ/dops-assistant/.worktrees/mvp && docker build -t dops-assistant-test .`
Expected: Build succeeds

---

### Task 8: Update architecture docs

**Files:**
- Modify: `docs/architecture.md` (mention image pipeline in MCP Client, Agent Core, and Slack Bot sections)

**Step 1: Update docs**

In `docs/architecture.md`:

- **MCP Client section:** Add that `callTool` returns `ToolResult` with both text and image content from MCP responses.
- **Agent Core section:** Add that images from tool results are collected as a side channel and returned in `AgentResult.images`.
- **Slack Bot section:** Add that after sending the text response, any collected images are uploaded to the thread via `files.uploadV2`.

**Step 2: Commit**

```bash
git add docs/architecture.md
git commit -m "docs: add image pipeline to architecture doc"
```
