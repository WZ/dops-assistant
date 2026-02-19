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
        // updatedHistory includes intermediate tool-call messages (role: "tool", content: null on assistant)
        // so conversation memory can be fully restored for the next LLM call
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
      const settled = await Promise.allSettled(
        response.calls.map((call) => this.mcp.callTool(call.name, call.args))
      );
      for (let j = 0; j < response.calls.length; j++) {
        const outcome = settled[j];
        const call = response.calls[j];
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
    // updatedHistory includes intermediate tool-call messages (role: "tool", content: null on assistant)
    // so conversation memory can be fully restored for the next LLM call
    return {
      response: truncationMsg,
      updatedHistory: messages.filter((m) => m.role !== "system"),
    };
  }
}
