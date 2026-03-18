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
import { IntentRouter, matchServiceFromText, validateLlmServiceMatch } from "../agents/intent.js";
import { ConversationMemory } from "../memory/conversation.js";
import { loadConfig, getServicesFilePath } from "../config/loader.js";
import { SkillStore } from "../skills/store.js";
import { createMastraAdapters } from "./agents.js";
import { createMcpProvider, getAllTools } from "../mcp/provider.js";
import { createModel } from "../mastra/index.js";
import { ServiceRegistryStore } from "../services/registry.js";
import type { ValidatedServiceConfig } from "../types/discovery-types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

async function main() {
  const configPath = process.env["CONFIG_PATH"] ?? "config.yaml";
  const config = loadConfig(configPath);

  const dbPath = process.env["DB_PATH"] ?? "dops.sqlite";
  const db = new Database(dbPath);

  // Clean up investigations left in 'running' state from prior crashes
  try {
    const staleCount = db.markStaleInvestigations();
    if (staleCount > 0) {
      logger.info({ staleCount }, "Marked stale investigations as failed");
    }
  } catch (err) {
    logger.warn({ err }, "Failed to clean up stale investigations");
  }

  // Service registry store
  const servicesPath = getServicesFilePath(configPath);
  const registryStore = new ServiceRegistryStore(servicesPath);

  // Mastra MCP providers
  const providers = config.providers.map(createMcpProvider);

  const model = createModel(config.llm);
  const router = new IntentRouter(model);
  const memory = new ConversationMemory(config.agent.conversationMemory);

  const mastraAdapters = await createMastraAdapters({ config, providers, registryStore });
  const { chatAgent: agent, investigationAgent, discoverAgent } = mastraAdapters;

  const toolCount = Object.keys(await getAllTools(providers).catch(() => ({}))).length;
  logger.info("MCP connected (%d tools)", toolCount);

  // Initialize skill store
  const skillStore = new SkillStore(config.skills);
  await skillStore.loadAll();

  const app = express();
  app.use(express.json());
  const server = createServer(app);
  const port = Number(process.env["PORT"] ?? 3000);

  registerRoutes(app, db, config.services, undefined, skillStore, registryStore);

  let pendingDiscovery: ValidatedServiceConfig[] | null = null;

  setupWebSocket(server, {
    db, agent, investigationAgent, router, memory,
    services: config.services, skillStore, validateLlmServiceMatch, matchServiceFromText,
    discoverAgent,
    discoveryConfig: config.discovery,
    getPendingDiscovery: () => pendingDiscovery,
    clearPendingDiscovery: () => { pendingDiscovery = null; },
  });

  // Auto-refresh: run background discovery on startup if enabled
  if (config.discovery.autoRefresh && discoverAgent) {
    logger.info("Auto-refresh enabled, running background discovery...");
    discoverAgent
      .discover(config.discovery)
      .then((services) => {
        pendingDiscovery = services;
        logger.info({ count: services.length }, "Auto-refresh discovery complete, pending review");
      })
      .catch((err) => {
        logger.warn({ err }, "Auto-refresh discovery failed");
      });
  }

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
