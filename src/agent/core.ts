import { randomUUID } from "node:crypto";
import {
  buildSystemPrompt,
  ANOMALY_ASSESSMENT_RESPONSE_FORMAT,
} from "./prompts.js";
import type { ChatRequest, ChatResponse, ImageAttachment } from "./types.js";
import type { LlmClient, Message, ToolCall } from "../llm/openai.js";
import type { MultiMcpClient } from "../mcp/multi-client.js";
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

export class ChatAgent {
  private llm: LlmClient;
  private mcp: MultiMcpClient;
  private maxIterations: number;

  constructor(llm: LlmClient, mcp: MultiMcpClient, opts: { maxIterations: number }) {
    this.llm = llm;
    this.mcp = mcp;
    this.maxIterations = opts.maxIterations;
  }

  async chat(task: ChatRequest): Promise<ChatResponse> {
    const log = logger.child({
      component: "agent",
      correlationId: task.correlationId,
    });
    const tools = this.mcp.getTools();
    const systemPrompt = buildSystemPrompt(
      task.mode,
      task.serviceContext,
      task.skillContext,
      task.supportsInlineCharts ?? false,
    );
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
    let agentStreamStarted = false;
    try {
      for (let i = 0; i < this.maxIterations; i++) {
        iterations = i + 1;

        let contentText = "";
        let toolCalls: ToolCall[] | null = null;

        for await (const event of this.llm.chatStream(messages, tools, { responseFormat })) {
          if (event.type === "reasoning" || event.type === "content") {
            if (!agentStreamStarted) {
              task.onStreamStart?.();
              agentStreamStarted = true;
            }
            task.onStreamDelta?.(event);
            if (event.type === "content") {
              contentText += event.content;
            }
          } else if (event.type === "tool_calls") {
            toolCalls = event.calls;
          } else if (event.type === "done") {
            if (event.usage) task.onTokenUsage?.(event.usage);
          }
        }

        if (contentText && toolCalls) {
          log.warn({ contentLength: contentText.length, toolCallCount: toolCalls.length }, "LLM returned both content and tool_calls in same response; prioritizing tool calls");
        }

        if (toolCalls) {
          messages.push({
            role: "assistant",
            content: null,
            tool_calls: toolCalls.map((c) => ({
              id: c.id, name: c.name, args: c.args,
            })),
          });

          for (const call of toolCalls) {
            task.onToolCall?.(call.name, call.args);
          }

          const settled = await Promise.allSettled(
            toolCalls.map((call) => this.mcp.callTool(call.name, call.args)),
          );
          for (let j = 0; j < toolCalls.length; j++) {
            const outcome = settled[j]!;
            const call = toolCalls[j]!;
            let toolText: string;
            if (outcome.status === "fulfilled") {
              const toolResult = outcome.value;
              task.onToolCall?.(call.name, call.args, toolResult.text);
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
        } else if (contentText) {
          const cleaned = contentText.replace(
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

      // Return a user-friendly message for transport/network errors instead of crashing
      const errMsg = err instanceof Error ? err.message : String(err);
      const isTransient = /premature close|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|abort/i.test(errMsg);
      if (isTransient) {
        const response = `Connection error during processing. Please try again.`;
        return {
          response,
          updatedHistory: messages.filter((m) => m.role !== "system"),
          images: collectedImages,
        };
      }
      throw err;
    }
  }
}
