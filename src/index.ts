import { loadConfig } from "./config/loader.js";
import { McpClient } from "./mcp/client.js";
import { LlmClient } from "./llm/openai.js";
import { AgentCore } from "./agent/core.js";
import { InvestigationAgent } from "./agent/investigation.js";
import { IntentClassifier } from "./agent/intent.js";
import { ConversationMemory } from "./memory/conversation.js";
import { sendAnomalyAlert } from "./notifications/slack-webhook.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { SlackBot } from "./interfaces/slack.js";
import { ObservabilityServer } from "./observability/server.js";
import { DiscoveryAgent } from "./agent/discovery.js";
import pino from "pino";

const configPath = process.env["CONFIG_PATH"] ?? "config.yaml";

async function main(): Promise<void> {
  const config = loadConfig(configPath);

  const logger = pino({
    level: process.env["LOG_LEVEL"] ?? config.observability.logLevel,
  });

  logger.info({ configPath }, "Loading config");

  // Observability server (starts early so /health is available during startup)
  const obsServer = new ObservabilityServer(
    config.observability.port,
    () => mcp.isConnected(),
  );
  await obsServer.start();
  logger.info({ port: config.observability.port }, "Observability server started");

  // Layer 1: MCP client
  const mcp = new McpClient(config.grafana.mcpServer, config.timeouts);
  logger.info("Connecting to Grafana MCP server...");
  await mcp.connect();
  logger.info("MCP connected");

  // Layer 2: LLM client
  const llm = new LlmClient(config.llm, config.timeouts, config.retry);

  // Layer 3: Agent core
  const agent = new AgentCore(llm, mcp, {
    maxIterations: config.agent.maxIterations,
  });

  // Layer 4: Conversation memory
  const memory = new ConversationMemory(config.agent.conversationMemory);

  // Layer 5: Investigation pipeline
  const investigationAgent = new InvestigationAgent(llm, mcp, {
    maxIterations: config.agent.maxIterations,
  });
  const classifier = new IntentClassifier(llm);

  // Service discovery: optionally merge discovered services with static config
  let services = config.services;
  if (config.discovery.autoRefresh) {
    logger.info("Running service auto-discovery...");
    try {
      const discoveryAgent = new DiscoveryAgent(llm, mcp, { maxIterations: config.discovery.maxIterations });
      const discovered = await discoveryAgent.discover(config.discovery);
      const staticNames = new Set(services.map((s) => s.name));
      const newServices = discovered.filter((s) => !staticNames.has(s.name));
      services = [...services, ...newServices];
      logger.info({ discovered: newServices.length, total: services.length }, "Service discovery complete");
    } catch (err) {
      logger.warn({ err }, "Service discovery failed, using static config only");
    }
  }

  // Layer 6: Slack webhook notifier (used by scheduler)
  const webhookUrl = config.notifications.slack?.webhookUrl ?? "";

  // Layer 7: Scheduler
  let scheduler: Scheduler | null = null;
  if (config.scheduler.anomalyCheck) {
    scheduler = new Scheduler(
      config.scheduler.anomalyCheck,
      services,
      agent,
      sendAnomalyAlert,
      webhookUrl,
      investigationAgent,
    );
    scheduler.start();
    logger.info("Scheduler started");
  }

  // Layer 8: Slack bot
  let slackBot: SlackBot | null = null;
  if (config.interfaces.slack?.enabled) {
    const slackCfg = config.interfaces.slack;
    if (!slackCfg.botToken || !slackCfg.appToken) {
      throw new Error("Slack enabled but botToken or appToken missing");
    }
    slackBot = new SlackBot(
      { botToken: slackCfg.botToken, appToken: slackCfg.appToken },
      agent,
      memory,
      services,
      classifier,
      investigationAgent,
    );
    await slackBot.start();
    logger.info("Slack bot started");
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "Shutting down");
    scheduler?.stop();
    await slackBot?.stop();
    memory.destroy();
    await mcp.disconnect();
    await obsServer.stop();
    logger.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  logger.info("dops-assistant running");
}

main().catch((err) => {
  console.error("Fatal error", err);
  process.exit(1);
});
