import { randomUUID } from "node:crypto";
import {
  buildSystemPrompt,
  ANOMALY_ASSESSMENT_RESPONSE_FORMAT,
} from "./prompts.js";
import type { AgentTask, AgentResult, ImageAttachment } from "./types.js";
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

    const collectedImages: ImageAttachment[] = [];
    let iterations = 0;
    try {
      for (let i = 0; i < this.maxIterations; i++) {
        iterations = i + 1;
        const response = await this.llm.chat(messages, tools, {
          responseFormat,
        });

        if (response.type === "text") {
          // Strip any base64 image markdown the LLM may have embedded
          const cleaned = response.content.replace(
            /!\[[^\]]*\]\(data:image\/[^)]+\)/g,
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
