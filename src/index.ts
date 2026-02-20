import { loadConfig } from "./config/loader.js";
import { McpClient } from "./mcp/client.js";
import { LlmClient } from "./llm/openai.js";
import { AgentCore } from "./agent/core.js";
import { ConversationMemory } from "./memory/conversation.js";
import { sendAnomalyAlert } from "./notifications/slack-webhook.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { SlackBot } from "./interfaces/slack.js";
import pino from "pino";

const logger = pino({ level: "info" });

const configPath = process.env.CONFIG_PATH ?? "config.yaml";

async function main(): Promise<void> {
  logger.info({ configPath }, "Loading config");
  const config = loadConfig(configPath);

  // Layer 1: MCP client
  const mcp = new McpClient(config.grafana.mcpServer);
  logger.info("Connecting to Grafana MCP server...");
  await mcp.connect();
  logger.info("MCP connected");

  // Layer 2: LLM client
  const llm = new LlmClient(config.llm);

  // Layer 3: Agent core
  const agent = new AgentCore(llm, mcp, { maxIterations: config.agent.maxIterations });

  // Layer 4: Conversation memory
  const memory = new ConversationMemory(config.agent.conversationMemory);

  // Layer 5: Slack webhook notifier (used by scheduler)
  const webhookUrl = config.notifications.slack?.webhookUrl ?? "";

  // Layer 6: Scheduler
  let scheduler: Scheduler | null = null;
  if (config.scheduler.anomalyCheck) {
    scheduler = new Scheduler(
      config.scheduler.anomalyCheck,
      config.services,
      agent,
      sendAnomalyAlert,
      webhookUrl
    );
    scheduler.start();
    logger.info("Scheduler started");
  }

  // Layer 7: Slack bot
  let slackBot: SlackBot | null = null;
  if (config.interfaces.slack?.enabled) {
    const slackCfg = config.interfaces.slack;
    if (!slackCfg.botToken || !slackCfg.appToken) {
      throw new Error("Slack enabled but botToken or appToken missing");
    }
    slackBot = new SlackBot(
      { botToken: slackCfg.botToken, appToken: slackCfg.appToken },
      agent,
      memory
    );
    await slackBot.start();
    logger.info("Slack bot started");
  }

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "Shutting down");
    scheduler?.stop();
    await slackBot?.stop();
    memory.destroy();
    await mcp.disconnect();
    logger.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  logger.info("dops-assistant running");
}

main().catch((err) => {
  logger.error(err, "Fatal error");
  process.exit(1);
});
