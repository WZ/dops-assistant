import { randomUUID } from "node:crypto";
import {
  buildSystemPrompt,
  ANOMALY_ASSESSMENT_RESPONSE_FORMAT,
} from "./prompts.js";
import type { ChatRequest, ChatResponse, ImageAttachment } from "./types.js";
import type { LlmClient, Message } from "../llm/openai.js";
import type { McpClient } from "../mcp/client.js";
import type { OpenAITool, ToolResult } from "../mcp/client.js";
import { TimeoutError } from "../utils/timeout.js";
import {
  agentRunsTotal,
  agentIterations,
} from "../observability/metrics.js";
import pino from "pino";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

const MAX_TOOL_RESULT_CHARS = 8000;

/** Strip base64 blobs and truncate oversized tool results before sending to LLM */
export function sanitizeToolResult(text: string): string {
  // Strip inline base64 data URIs
  let cleaned = text.replace(/data:[a-z]+\/[a-z+.-]+;base64,[A-Za-z0-9+/=\s]{100,}/g, "[base64 image removed]");
  // Strip raw base64 blobs (>200 chars of contiguous base64)
  cleaned = cleaned.replace(/[A-Za-z0-9+/=]{200,}/g, "[large blob removed]");
  if (cleaned.length > MAX_TOOL_RESULT_CHARS) {
    cleaned = cleaned.slice(0, MAX_TOOL_RESULT_CHARS) + "\n...[truncated]";
  }
  return cleaned;
}

const CREATE_TEMP_PANEL_TOOL: OpenAITool = {
  type: "function",
  function: {
    name: "create_temp_panel",
    description:
      "Create a temporary Grafana dashboard with a single timeseries panel and return a screenshot. " +
      "Use this when the user asks for a visual/panel/graph and no existing dashboard has a matching panel.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Dashboard title, e.g. 'CPU usage for node blade-198-18-1-2'",
        },
        expr: {
          type: "string",
          description: "PromQL expression for the panel, e.g. '100 - (rate(node_cpu_seconds_total{instance=\"198.18.1.2:9100\",mode=\"idle\"}[5m]) * 100)'",
        },
        unit: {
          type: "string",
          description: "Panel unit (default: 'percent'). Common values: percent, short, bytes, s, reqps",
        },
      },
      required: ["title", "expr"],
      additionalProperties: false,
    },
  },
};

export class ChatAgent {
  private llm: LlmClient;
  private mcp: McpClient;
  private maxIterations: number;

  constructor(llm: LlmClient, mcp: McpClient, opts: { maxIterations: number }) {
    this.llm = llm;
    this.mcp = mcp;
    this.maxIterations = opts.maxIterations;
  }

  private hasUpdateDashboard(): boolean {
    return this.mcp.getTools().some((t) => t.function.name === "update_dashboard");
  }

  private async handleCreateTempPanel(args: Record<string, unknown>): Promise<ToolResult> {
    const title = String(args["title"] ?? "Temp panel");
    const expr = String(args["expr"] ?? "up");
    const unit = String(args["unit"] ?? "percent");

    const dashboardPayload = {
      dashboard: {
        uid: null,
        title: `dops-temp: ${title}`,
        panels: [
          {
            id: 1,
            type: "timeseries",
            title,
            gridPos: { h: 12, w: 24, x: 0, y: 0 },
            targets: [
              { datasource: { type: "prometheus" }, expr, refId: "A" },
            ],
            fieldConfig: { defaults: { unit }, overrides: [] },
          },
        ],
      },
      overwrite: true,
      message: "Auto-created by dops-assistant",
    };

    const createResult = await this.mcp.callTool("update_dashboard", dashboardPayload);

    // Extract the dashboard UID from the response
    let dashUid: string | undefined;
    try {
      const parsed = JSON.parse(createResult.text) as { uid?: string };
      dashUid = parsed.uid;
    } catch {
      // Try to find uid in the text
      const match = createResult.text.match(/"uid"\s*:\s*"([^"]+)"/);
      dashUid = match?.[1];
    }

    if (!dashUid) {
      return { text: `Dashboard created but could not extract UID. Response: ${createResult.text}`, images: [] };
    }

    const imageResult = await this.mcp.callTool("get_panel_image", {
      dashboardUid: dashUid,
      panelId: 1,
      timeRange: { from: "now-1h", to: "now" },
      width: 1000,
      height: 500,
      theme: "dark",
    });

    return {
      text: `Created temporary dashboard "${title}" (uid: ${dashUid}) and captured panel image.`,
      images: imageResult.images,
    };
  }

  async chat(task: ChatRequest): Promise<ChatResponse> {
    const log = logger.child({
      component: "agent",
      correlationId: task.correlationId,
    });
    const mcpTools = this.mcp.getTools();
    const tools = this.hasUpdateDashboard()
      ? [...mcpTools, CREATE_TEMP_PANEL_TOOL]
      : mcpTools;
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

    const collectedImages: ImageAttachment[] = [];
    let iterations = 0;
    try {
      for (let i = 0; i < this.maxIterations; i++) {
        iterations = i + 1;
        const response = await this.llm.chat(messages, tools, {
          responseFormat,
        });

        if (response.usage) task.onTokenUsage?.(response.usage);

        if (response.type === "text") {
          // Strip any base64 image markdown the LLM may have embedded
          const cleaned = response.content.replace(
            /!\[[^\]]*\]\(data:image\/[^;]+;base64,[^)]+\)/g,
            "",
          ).trim();
          messages.push({ role: "assistant", content: cleaned });
          agentRunsTotal.inc({ status: "success" });
          agentIterations.observe(iterations);
          return {
            response: cleaned,
            updatedHistory: messages.filter((m) => m.role !== "system"),
            images: collectedImages,
          };
        }

        messages.push({
          role: "assistant",
          content: null,
          tool_calls: response.calls.map((c) => ({
            id: c.id, name: c.name, args: c.args,
          })),
        });

        for (const call of response.calls) {
          task.onToolCall?.(call.name, call.args);
        }

        const settled = await Promise.allSettled(
          response.calls.map((call) =>
            call.name === "create_temp_panel"
              ? this.handleCreateTempPanel(call.args)
              : this.mcp.callTool(call.name, call.args),
          ),
        );
        for (let j = 0; j < response.calls.length; j++) {
          const outcome = settled[j]!;
          const call = response.calls[j]!;
          let toolText: string;
          if (outcome.status === "fulfilled") {
            const toolResult = outcome.value;
            toolText = sanitizeToolResult(toolResult.text);
            for (const img of toolResult.images) {
              const ext = img.mimeType.split("/")[1] ?? "png";
              collectedImages.push({
                filename: `${call.name}-${randomUUID().slice(0, 8)}.${ext}`,
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
      }

      const truncationMsg = "Reached maximum iterations without a final response.";
      messages.push({ role: "assistant", content: truncationMsg });
      agentRunsTotal.inc({ status: "truncated" });
      agentIterations.observe(iterations);
      log.warn({ iterations }, "Agent reached max iterations");
      return {
        response: truncationMsg,
        updatedHistory: messages.filter((m) => m.role !== "system"),
        images: collectedImages,
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
