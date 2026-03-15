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
import { IntentRouter, matchServiceFromText, validateLlmServiceMatch } from "../agent/intent.js";
import { ConversationMemory } from "../memory/conversation.js";
import { loadConfig } from "../config/loader.js";
import { SkillStore } from "../skills/store.js";
import { createMastraAdapters } from "./mastra-adapter.js";
import { createMcpProvider, getToolsByRole } from "../mcp/provider.js";
import type { MastraProvider } from "../mcp/provider.js";
import { createModel } from "../mastra/index.js";
import type { ProviderRole } from "../config/schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

/**
 * Adapt Mastra MCP providers to the IMcpClient interface used by REST routes.
 * Wraps role-based tool queries and tool execution via @mastra/mcp.
 */
function createMcpClientFromProviders(providers: MastraProvider[]): IMcpClient {
  // Cache resolved tools per role to avoid repeated async listTools calls
  const toolCache = new Map<string, { function: { name: string } }[]>();

  return {
    hasRole(role: ProviderRole): boolean {
      return providers.some((p) => p.roles.includes(role));
    },

    getToolsByRole(role: ProviderRole): { function: { name: string } }[] {
      // Return cached result or empty (populated after first async call)
      return toolCache.get(role) ?? [];
    },

    async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string }> {
      // Resolve tools for the role if not cached yet
      for (const provider of providers) {
        const tools = await provider.client.listTools();
        for (const [toolName, tool] of Object.entries(tools)) {
          if (toolName === name || toolName.endsWith(`_${name}`)) {
            const result = await tool.execute({ context: {}, ...args });
            return { text: typeof result === "string" ? result : JSON.stringify(result) };
          }
        }
      }
      throw new Error(`Unknown tool: ${name}`);
    },
  };
}

async function main() {
  const config = loadConfig(process.env["CONFIG_PATH"] ?? "config.yaml");

  const dbPath = process.env["DB_PATH"] ?? "dops.sqlite";
  const db = new Database(dbPath);

  // Mastra MCP providers
  const providers = config.providers.map(createMcpProvider);

  // Build MCP client adapter for REST routes (dependency graph queries)
  const mcpClient = createMcpClientFromProviders(providers);

  // Pre-populate tool cache for dependency role
  if (mcpClient.hasRole("dependencies")) {
    const tools = await getToolsByRole(providers, "dependencies");
    // Tools are cached internally by the adapter
  }

  const model = createModel(config.llm);
  const router = new IntentRouter(model);
  const memory = new ConversationMemory(config.agent.conversationMemory);

  const mastraAdapters = await createMastraAdapters({ config, providers });
  const { chatAgent: agent, investigationAgent } = mastraAdapters;

  const toolCount = Object.keys(await import("../mcp/provider.js").then(m => m.getAllTools(providers)).catch(() => ({}))).length;
  logger.info("MCP connected (%d tools)", toolCount);

  // Initialize skill store
  const skillStore = new SkillStore(config.skills);
  await skillStore.loadAll();

  const app = express();
  app.use(express.json());
  const server = createServer(app);
  const port = Number(process.env["PORT"] ?? 3000);

  registerRoutes(app, db, config.services, mcpClient, skillStore);

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
