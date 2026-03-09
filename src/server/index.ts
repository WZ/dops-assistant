import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";

const envPath = process.env["DOTENV_PATH"] ?? resolve(process.cwd(), "dev/.env");
loadDotenv({ path: envPath });

import express from "express";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import pino from "pino";
import { Database } from "./db.js";
import { registerRoutes } from "./routes.js";
import { setupWebSocket } from "./ws-handler.js";
import { createMultiMcpClient } from "../mcp/factory.js";
import { LlmClient } from "../llm/openai.js";
import { ChatAgent } from "../agent/core.js";
import { InvestigationAgent } from "../agent/investigation.js";
import { IntentRouter, matchService, matchServiceFromText } from "../agent/intent.js";
import { ConversationMemory } from "../memory/conversation.js";
import { loadConfig } from "../config/loader.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

async function main() {
  const config = loadConfig(process.env["CONFIG_PATH"] ?? "config.yaml");

  const dbPath = process.env["DB_PATH"] ?? "dops.sqlite";
  const db = new Database(dbPath);

  const mcp = createMultiMcpClient(config);
  await mcp.connect();
  logger.info("MCP connected (%d tools)", mcp.getTools().length);

  const llm = new LlmClient(config.llm, config.timeouts, config.retry);
  const agent = new ChatAgent(llm, mcp, { maxIterations: config.agent.maxIterations });
  const investigationAgent = new InvestigationAgent(llm, mcp, { maxIterations: config.agent.maxIterations });
  const router = new IntentRouter(llm);
  const memory = new ConversationMemory(config.agent.conversationMemory);

  const app = express();
  const server = createServer(app);
  const port = Number(process.env["PORT"] ?? 3000);

  registerRoutes(app, db, config.services, mcp);

  setupWebSocket(server, {
    db, agent, investigationAgent, router, memory,
    services: config.services, matchService, matchServiceFromText,
  });

  const staticDir = path.resolve(__dirname, "../../dist/web");
  app.use(express.static(staticDir));
  app.get(/^(?!\/api\/)/, (_req, res) => {
    res.sendFile(path.join(staticDir, "index.html"));
  });

  server.listen(port, () => {
    logger.info({ port }, "dops-assistant web server running");
  });

  const shutdown = async () => {
    logger.info("Shutting down...");
    memory.destroy();
    await mcp.disconnect();
    db.close();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.error(err, "Failed to start web server");
  process.exit(1);
});
