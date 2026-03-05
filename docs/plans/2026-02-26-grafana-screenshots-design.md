# Grafana Chart Screenshots in Slack

## Problem

The agent returns text responses that reference Grafana metrics, but users have to manually open Grafana to see the actual charts. Screenshots of relevant panels should be delivered inline in Slack alongside text responses.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| When to include screenshots | Any response with metrics + RCA + scheduled alerts | User preference — broad coverage |
| Panel discovery | LLM-driven | LLM uses `search_dashboards` / `get_panel_image` tools dynamically. No static config mapping needed. |
| Image delivery | Slack `files.uploadV2` | Works with existing bot token. No external storage. |
| Architecture | Image-aware tool results | Clean data flow: MCP → Agent → Slack. No post-processing or synthetic tools. |

## Design

### Data Model

```ts
// src/mcp/client.ts
type ImageContent = {
  mimeType: string;   // "image/png"
  data: string;       // base64-encoded
};

type ToolResult = {
  text: string;
  images: ImageContent[];
};

// src/agent/types.ts
type ImageAttachment = {
  filename: string;    // e.g. "get_panel_image-abc123.png"
  mimeType: string;
  data: Buffer;        // decoded from base64
};

// AgentResult gains images field
type AgentResult = {
  response: string;
  updatedHistory: Message[];
  images: ImageAttachment[];
};
```

### MCP Client

`McpClient.callTool` returns `ToolResult` instead of `string`. Extracts both `type: "text"` and `type: "image"` content parts from MCP results.

```ts
async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const parts = result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;

  const text = parts
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n");

  const images = parts
    .filter((p) => p.type === "image")
    .map((p) => ({ mimeType: p.mimeType ?? "image/png", data: p.data ?? "" }));

  return { text: result.isError ? `[Tool Error] ${text}` : text, images };
}
```

All callers update from `string` to `result.text`.

### Agent Core

During the tool-call loop, images accumulate as a side channel:

1. Call `mcp.callTool()` → get `ToolResult`
2. For each `image` in result: decode base64 → push `ImageAttachment` to `collectedImages[]`
3. Feed `result.text` back to LLM as tool result (with `[N chart image(s) captured]` hint if images present)
4. Return `collectedImages` in `AgentResult.images`

Same pattern in `InvestigationAgent.runPhase` — images from parallel phases merge into the final result.

### Slack Bot

After receiving an `AgentResult`:

1. Send text response (or RCA blocks) via `say()`
2. For each `ImageAttachment`, call `app.client.filesUploadV2({ channel_id, thread_ts, file: img.data, filename: img.filename })`

Images appear in the same Slack thread as the response.

### Webhook Notifier (Scheduled Alerts)

The webhook notifier posts via incoming webhook, which does not support file uploads. Scheduled alerts sent via webhook will not include screenshots. If the scheduler gains Slack bot access in the future, images can be added.

### Prompt Changes

- **Conversational system prompt:** Instruct the LLM to use `get_panel_image` when discussing metrics. "The images will be automatically sent to the user."
- **RCA metric/infra phase prompts:** Instruct the LLM to capture panel screenshots as supporting evidence.

### Error Handling

- Image upload failure → log warning, do not block text response
- `get_panel_image` tool failure → error text in tool result, no image collected, response works without screenshot
- Image size: Slack supports up to 1GB per file. Grafana panel PNGs are typically 100-500KB.

## Dependencies

- **Grafana Image Renderer plugin** must be installed and configured (`GF_RENDERING_SERVER_URL`)
- **`get_panel_image`** tool available in grafana-mcp (enabled by default)
- **Slack bot token** needs `files:write` scope (standard for bot tokens)

## Out of Scope

- Dashboard deep links in responses (can be added later)
- Static panel-to-service mapping in config (LLM discovery handles this)
- Image caching or deduplication
