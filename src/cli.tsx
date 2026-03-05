import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";

const envPath = process.env["DOTENV_PATH"] ?? resolve(process.cwd(), "dev/.env");
loadDotenv({ path: envPath });

import React from "react";
import { render } from "ink";
import { loadConfig } from "./config/loader.js";
import { McpClient } from "./mcp/client.js";
import { LlmClient } from "./llm/openai.js";
import { ChatAgent } from "./agent/core.js";
import { InvestigationAgent } from "./agent/investigation.js";
import { IntentClassifier } from "./agent/intent.js";
import { ConversationMemory } from "./memory/conversation.js";
import { App } from "./interfaces/cli/App.js";

// Silence pino loggers — their stdout output corrupts Ink's terminal rendering
if (!process.env["LOG_LEVEL"]) {
  process.env["LOG_LEVEL"] = "silent";
}

const configPath = process.env["CONFIG_PATH"] ?? "dev/config.yaml";

async function main(): Promise<void> {
  const config = loadConfig(configPath);

  const R = "\x1b[31m";   // red (Fortinet brand)
  const B = "\x1b[1m";    // bold
  const DM = "\x1b[2m";   // dim
  const X = "\x1b[0m";    // reset

  console.log(`
  ${R}███${X} ${R}███${X} ${R}███${X}   ${B}dops-assistant${X} ${DM}v0.1.0${X}

  ${R}███${X}     ${R}███${X}   AI-powered DevOps monitoring

  ${R}███${X} ${R}███${X} ${R}███${X}   Grafana + MCP

  `);
  console.log("  Connecting to Grafana MCP server...");

  const mcp = new McpClient(config.grafana.mcpServer, config.timeouts);
  await mcp.connect();

  const toolCount = mcp.getTools().length;
  console.log(`  Connected to Grafana MCP (${toolCount} tools available)`);
  console.log("");

  const llm = new LlmClient(config.llm, config.timeouts, config.retry);
  const agent = new ChatAgent(llm, mcp, { maxIterations: config.agent.maxIterations });
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
