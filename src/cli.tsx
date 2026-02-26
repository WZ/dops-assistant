import { config as loadDotenv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, "../dev/.env"), override: true });

import React from "react";
import { render } from "ink";
import { loadConfig } from "./config/loader.js";
import { McpClient } from "./mcp/client.js";
import { LlmClient } from "./llm/openai.js";
import { AgentCore } from "./agent/core.js";
import { InvestigationAgent } from "./agent/investigation.js";
import { IntentClassifier } from "./agent/intent.js";
import { ConversationMemory } from "./memory/conversation.js";
import { App } from "./interfaces/cli/App.js";

const configPath = process.env["CONFIG_PATH"] ?? "dev/config.yaml";

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
