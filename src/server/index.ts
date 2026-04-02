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
import { IntentRouter, matchServiceFromText, validateLlmServiceMatch, setServiceAliases } from "../agents/intent.js";
import { loadConfig } from "../config/loader.js";
import { SkillStore } from "../skills/store.js";
import { createModel } from "../mastra/index.js";
import { InvestigationRunner } from "./investigation-runner.js";
import { createWebhookHandler } from "./webhook-handler.js";
import { InvestigationDedup } from "./investigation-dedup.js";
import { startHealthMonitor, stopHealthMonitor, healthHandler } from "./health-monitor.js";
import { StackManager } from "./stack-manager.js";
import { createMastraAdapters } from "./agents.js";
import { notifySlack } from "./slack-notifier.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

async function main() {
  const configPath = process.env["CONFIG_PATH"] ?? "config.yaml";
  const config = loadConfig(configPath);

  if (config.serviceAliases && Object.keys(config.serviceAliases).length > 0) {
    setServiceAliases(config.serviceAliases);
  }

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

  // Initialize StackManager — replaces singleton registryStore, ProviderRegistry, memory, healthPoller
  const stackManager = new StackManager(db, config);
  await stackManager.initialize();

  const model = createModel(config.llm);
  const router = new IntentRouter(model);

  // Initialize skill store
  const skillStore = new SkillStore(config.skills);
  await skillStore.loadAll();

  const app = express();
  app.use(express.json());
  const server = createServer(app);
  const port = Number(process.env["PORT"] ?? 3000);

  // Shared dedup for both webhook and health-poller auto-investigate
  // Pass db for fallback dedup checks that survive server restarts
  const sharedDedup = new InvestigationDedup({
    dedupWindowSeconds: config.webhook.dedupWindowSeconds,
    maxConcurrent: config.webhook.maxConcurrent,
    db,
  });

  // Build a global onComplete handler for Slack notifications.
  // Reads URL dynamically so GUI changes take effect without restart.
  const globalOnComplete = (investigationId: string, service: string, report: import("../types/rca-types.js").RcaReport) => {
    // GUI override (DB) → config.yaml fallback
    const url = db.getSetting("notifications.slack.webhookUrl") ?? config.webhook.slackWebhookUrl;
    if (!url) return;
    // Check if explicitly disabled via GUI
    const enabled = db.getSetting("notifications.slack.enabled");
    if (enabled === "false") return;

    const defaultCtx = stackManager.getDefaultContext();
    const dashProvider = defaultCtx.providerRegistry.getAll().find(
      (p: { config: { roles: string[]; webUrl?: string } }) => p.config.roles.includes("dashboards") && p.config.webUrl,
    );
    notifySlack(
      { slackWebhookUrl: url, grafanaUrl: dashProvider?.config.webUrl },
      investigationId,
      service,
      report,
    );
  };

  // Wire health transition handler for auto-investigate
  stackManager.onHealthTransition = (stackId, service, from, to) => {
    if (to !== "down") return;
    if (from !== "healthy" && from !== "unknown") return;
    // Defense in depth: skip hidden services
    if (db.isServiceHidden(stackId, service)) return;

    logger.info({ service, from, to, stackId }, "ServiceHealthPoller: service transitioned to down");

    if (!sharedDedup.shouldInvestigate(stackId, service)) {
      logger.info({ service, activeCount: sharedDedup.getActiveCount(), stackId }, "ServiceHealthPoller: auto-investigate suppressed by dedup/concurrency");
      return;
    }

    // Find the service config from live registry or config.yaml
    const ctx = stackManager.getContext(stackId);
    const allServices = [
      ...config.services,
      ...ctx.serviceRegistry.load().filter((s) => !config.services.some((c) => c.name === s.name)),
    ];
    const serviceConfig = allServices.find((s) => s.name === service);
    if (!serviceConfig) {
      logger.warn({ service, stackId }, "ServiceHealthPoller: service not found in config or registry, skipping auto-investigate");
      return;
    }

    // Build enriched message with service context
    const messageParts = [
      `Service health check: ${service} transitioned from ${from} to down.`,
    ];
    if (serviceConfig.metrics?.length) {
      messageParts.push(`Known metrics: ${serviceConfig.metrics.map(m => `${m.description} (${m.query})`).slice(0, 3).join("; ")}`);
    }
    if (serviceConfig.logLabels && Object.keys(serviceConfig.logLabels).length > 0) {
      const labels = Object.entries(serviceConfig.logLabels).map(([k, v]) => `${k}="${v}"`).join(",");
      messageParts.push(`Log selector: {${labels}}`);
    }

    logger.info({ service, stackId }, "ServiceHealthPoller: triggering auto-investigate (template=quick)");
    sharedDedup.markStarted(stackId, service);

    // Create agents lazily for the investigation
    const providers = ctx.providerRegistry.getProviders();
    createMastraAdapters({ config, providers, registryStore: ctx.serviceRegistry })
      .then(({ investigationAgent }) => {
        const runner = new InvestigationRunner({ db, investigationAgent, skillStore, globalOnComplete });
        return runner.run({
          service: serviceConfig,
          message: messageParts.join("\n"),
          template: "quick",
          stackId,
        });
      })
      .catch((err) => {
        logger.error({ err, service, stackId }, "ServiceHealthPoller: auto-investigate failed");
      })
      .finally(() => {
        sharedDedup.markCompleted();
      });
  };

  registerRoutes(app, { db, stackManager, config, skillStore, sharedDedup, llmModel: model });

  // Health check endpoint with background monitoring
  startHealthMonitor({ stackManager, db });
  app.get("/api/health", healthHandler);

  // Alert webhook endpoint (only if secret is configured)
  if (config.webhook.secret) {
    const defaultStackId = stackManager.getDefaultStackId();
    const defaultCtx = stackManager.getDefaultContext();
    const providers = defaultCtx.providerRegistry.getProviders();
    const { investigationAgent } = await createMastraAdapters({ config, providers, registryStore: defaultCtx.serviceRegistry });
    const runner = new InvestigationRunner({ db, investigationAgent, skillStore, globalOnComplete });

    const webhookHandler = createWebhookHandler({
      runner,
      config: config.webhook,
      services: config.services,
      stackId: defaultStackId,
      dedup: sharedDedup,
      getHiddenServices: () => db.getHiddenServices(defaultStackId),
    });
    app.post("/api/webhook/alert", webhookHandler);

    // Stack-scoped webhook: POST /api/webhook/alert/:stackSlug
    app.post("/api/webhook/alert/:stackSlug", async (req, res) => {
      const slug = req.params["stackSlug"] as string;
      const stackRow = db.getStackBySlug(slug);
      if (!stackRow) {
        res.status(404).json({ error: `Stack with slug "${slug}" not found` });
        return;
      }

      // Early dedup check: extract service name from payload before creating agents
      const payload = req.body as { alerts?: Array<{ status: string; labels: Record<string, string> }> };
      const firingAlerts = payload.alerts?.filter(a => a.status === "firing") ?? [];
      if (firingAlerts.length > 0) {
        const alert = firingAlerts[0]!;
        const serviceLabels = ["service", "service_name", "app", "job", "deployment"];
        const serviceName = serviceLabels.map(k => alert.labels[k]).find(Boolean);
        if (serviceName && !sharedDedup.shouldInvestigate(stackRow.id, serviceName)) {
          res.status(429).json({ error: "Investigation already in progress for this service", service: serviceName });
          return;
        }
      }

      const ctx = stackManager.getContext(stackRow.id);
      const stackProviders = ctx.providerRegistry.getProviders();
      const stackAdapters = await createMastraAdapters({ config, providers: stackProviders, registryStore: ctx.serviceRegistry });
      const stackRunner = new InvestigationRunner({ db, investigationAgent: stackAdapters.investigationAgent, skillStore, globalOnComplete });
      const stackWebhookHandler = createWebhookHandler({
        runner: stackRunner,
        config: config.webhook,
        services: [...config.services, ...ctx.serviceRegistry.load().filter(s => !config.services.some(c => c.name === s.name))],
        stackId: stackRow.id,
        dedup: sharedDedup,
        getHiddenServices: () => db.getHiddenServices(stackRow.id),
      });
      await stackWebhookHandler(req, res);
    });

    logger.info("Alert webhook enabled at POST /api/webhook/alert");
  }

  setupWebSocket(server, {
    db, stackManager, config, router, skillStore,
    sharedDedup, globalOnComplete,
    validateLlmServiceMatch, matchServiceFromText,
  });

  const staticDir = path.resolve(__dirname, "../../dist/web");
  app.use(express.static(staticDir));
  app.get(/^(?!\/api\/)/, (_req, res) => {
    res.sendFile(path.join(staticDir, "index.html"));
  });

  // Start all per-stack health pollers (staggered)
  stackManager.startAllPollers();

  server.listen(port, () => {
    logger.info({ port }, "dops-assistant web server running");
  });

  const shutdown = async () => {
    logger.info("Shutting down...");
    stopHealthMonitor();
    stackManager.stopAllPollers();
    stackManager.destroyAllMemory();
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
