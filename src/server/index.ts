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
import { registerRoutes, type IMcpClient } from "./routes.js";
import { setupWebSocket } from "./ws-handler.js";
import { IntentRouter, matchServiceFromText, validateLlmServiceMatch } from "../agents/intent.js";
import { ConversationMemory } from "../memory/conversation.js";
import { loadConfig } from "../config/loader.js";
import { SkillStore } from "../skills/store.js";
import { createMastraAdapters } from "./mastra-adapter.js";
import { createMcpProvider, getAllTools } from "../mcp/provider.js";
import { createModel } from "../mastra/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

/**
 * Stub IMcpClient backed by Mastra providers.
 * The dependency graph REST endpoint is not currently wired to Mastra tool execution;
 * it returns a single-node default response. Can be enhanced when needed.
 */
function createStubMcpClient(): IMcpClient {
  return {
    hasRole: () => false,
    getToolsByRole: () => [],
    callTool: async () => ({ text: "{}" }),
  };
}

async function main() {
  const config = loadConfig(process.env["CONFIG_PATH"] ?? "config.yaml");

  const dbPath = process.env["DB_PATH"] ?? "dops.sqlite";
  const db = new Database(dbPath);

  // Mastra MCP providers
  const providers = config.providers.map(createMcpProvider);

  const model = createModel(config.llm);
  const router = new IntentRouter(model);
  const memory = new ConversationMemory(config.agent.conversationMemory);

  const mastraAdapters = await createMastraAdapters({ config, providers });
  const { chatAgent: agent, investigationAgent } = mastraAdapters;

  const toolCount = Object.keys(await getAllTools(providers).catch(() => ({}))).length;
  logger.info("MCP connected (%d tools)", toolCount);

  // Initialize skill store
  const skillStore = new SkillStore(config.skills);
  await skillStore.loadAll();

  const app = express();
  app.use(express.json());
  const server = createServer(app);
  const port = Number(process.env["PORT"] ?? 3000);

  registerRoutes(app, db, config.services, createStubMcpClient(), skillStore);

  setupWebSocket(server, {
    db, agent, investigationAgent, router, memory,
    services: config.services, skillStore, validateLlmServiceMatch, matchServiceFromText,
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
