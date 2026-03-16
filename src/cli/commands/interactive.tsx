// src/cli/commands/interactive.tsx
import type { Config } from "../../config/schema.js";
import type { MastraProvider } from "../../mcp/provider.js";

export async function runInteractive(config: Config, providers: MastraProvider[]): Promise<never> {
  // Dynamic imports after LOG_LEVEL is set to "silent" (done by caller)
  const { getAllTools } = await import("../../mcp/provider.js");
  const { createMastraAdapters } = await import("../../server/agents.js");
  const { createModel } = await import("../../mastra/index.js");
  const { IntentRouter } = await import("../../agents/intent.js");
  const { ConversationMemory } = await import("../../memory/conversation.js");
  const { render } = await import("ink");
  const { default: React } = await import("react");
  const { App } = await import("../App.js");

  const toolCount = Object.keys(await getAllTools(providers)).length;
  const { chatAgent, investigationAgent } = await createMastraAdapters({ config, providers });
  const model = createModel(config.llm);
  const router = new IntentRouter(model);
  const memory = new ConversationMemory({
    maxMessages: config.agent.conversationMemory?.maxMessages ?? 50,
    ttlMinutes: config.agent.conversationMemory?.ttlMinutes ?? 30,
  });

  const { waitUntilExit } = render(
    React.createElement(App, {
      agent: chatAgent,
      memory,
      services: config.services,
      router,
      investigationAgent,
      toolCount,
    }),
  );

  await waitUntilExit();
  process.exit(0);
}
