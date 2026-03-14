import { Agent } from "@mastra/core/agent";
import type { LanguageModel } from "ai";

interface ChatAgentConfig {
  model: LanguageModel;
  tools?: Record<string, any>;
  maxSteps?: number;
}

export function createChatAgent(config: ChatAgentConfig) {
  return new Agent({
    id: "chat",
    name: "chat",
    instructions: `You are a DevOps assistant. Use the available tools to query metrics, logs, dashboards, and infrastructure to answer questions about system health. Be concise and actionable.`,
    model: config.model as any,
    tools: config.tools ?? {},
    defaultOptions: {
      maxSteps: config.maxSteps ?? 15,
    },
  });
}
