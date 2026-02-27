import type { LlmClient, Message, TokenUsage } from "../llm/openai.js";
import type { McpClient } from "../mcp/client.js";
import type { ServiceConfig, DiscoveryConfig } from "../config/schema.js";
import { sanitizeToolResult } from "./core.js";
import {
  DISCOVERY_PROMPT,
  DISCOVERED_SERVICES_SCHEMA,
  buildDiscoveryUserMessage,
} from "./discovery-prompts.js";

type DiscoveredServices = {
  services: Array<{
    name: string;
    metrics: Array<{ query: string; description: string }>;
    logLabels: Record<string, string>;
  }>;
};

export class DiscoveryAgent {
  private readonly llm: LlmClient;
  private readonly mcp: McpClient;
  private readonly maxIterations: number;

  constructor(llm: LlmClient, mcp: McpClient, opts: { maxIterations: number }) {
    this.llm = llm;
    this.mcp = mcp;
    this.maxIterations = opts.maxIterations;
  }

  async discover(
    config: DiscoveryConfig,
    onTokenUsage?: (usage: TokenUsage) => void,
    onToolCall?: (name: string, args: Record<string, unknown>) => void,
  ): Promise<ServiceConfig[]> {
    const tools = this.mcp.getTools();
    const messages: Message[] = [
      { role: "system", content: DISCOVERY_PROMPT },
      { role: "user", content: buildDiscoveryUserMessage(config) },
    ];

    for (let i = 0; i < this.maxIterations; i++) {
      const response = await this.llm.chat(messages, tools, {
        responseFormat: DISCOVERED_SERVICES_SCHEMA,
      });

      if (response.usage) onTokenUsage?.(response.usage);

      if (response.type === "text") {
        const parsed = JSON.parse(response.content) as DiscoveredServices;
        const excludeSet = new Set(config.excludeServices.map((s) => s.toLowerCase()));
        return parsed.services
          .filter((s) => !excludeSet.has(s.name.toLowerCase()))
          .map((s) => ({
            name: s.name,
            metrics: s.metrics,
            logLabels: s.logLabels,
          }));
      }

      messages.push({
        role: "assistant",
        content: null,
        tool_calls: response.calls.map((c) => ({
          id: c.id, name: c.name, args: c.args,
        })),
      });

      for (const call of response.calls) {
        onToolCall?.(call.name, call.args);
      }

      const settled = await Promise.allSettled(
        response.calls.map((call) => this.mcp.callTool(call.name, call.args)),
      );
      for (let j = 0; j < response.calls.length; j++) {
        const outcome = settled[j]!;
        const call = response.calls[j]!;
        messages.push({
          role: "tool",
          content: outcome.status === "fulfilled"
            ? sanitizeToolResult(outcome.value.text)
            : `[Error] ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
          tool_call_id: call.id,
        });
      }
    }

    throw new Error(`Discovery did not complete within ${this.maxIterations} iterations`);
  }
}
