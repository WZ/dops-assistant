import type { Express, Request, Response } from "express";
import type { Config } from "../config/schema.js";
import type { SkillStore } from "../skills/store.js";
import type { Database } from "./db.js";
import type { InvestigationDedup } from "./investigation-dedup.js";
import type { RunnerDeps } from "./investigation-runner.js";
import { InvestigationRunner } from "./investigation-runner.js";
import type { StackManager } from "./stack-manager.js";
import { createMastraAdapters } from "./agents.js";
import { strictLimiter } from "./rate-limit.js";
import { createWebhookHandler } from "./webhook-handler.js";

type CreateAdapters = typeof createMastraAdapters;
type CreateRunner = (deps: RunnerDeps) => InvestigationRunner;

export interface StackScopedWebhookHandlerDeps {
  db: Database;
  stackManager: StackManager;
  config: Config;
  skillStore?: SkillStore;
  sharedDedup: InvestigationDedup;
  globalOnComplete?: RunnerDeps["globalOnComplete"];
  createAdapters?: CreateAdapters;
  createRunner?: CreateRunner;
}

export function createStackScopedWebhookHandler(deps: StackScopedWebhookHandlerDeps) {
  const buildAdapters = deps.createAdapters ?? createMastraAdapters;
  const buildRunner = deps.createRunner ?? ((runnerDeps: RunnerDeps) => new InvestigationRunner(runnerDeps));

  return async (req: Request, res: Response): Promise<void> => {
    const slug = req.params["stackSlug"] as string;
    const stackRow = deps.db.getStackBySlug(slug);
    if (!stackRow) {
      res.status(404).json({ error: `Stack with slug "${slug}" not found` });
      return;
    }

    deps.stackManager.bumpActivity(stackRow.id);
    const ctx = deps.stackManager.getContext(stackRow.id);
    const stackProviders = ctx.providerRegistry.getProviders();
    const stackAdapters = await buildAdapters({
      config: deps.config,
      providers: stackProviders,
      registryStore: ctx.serviceRegistry,
      db: deps.db,
      stackId: stackRow.id,
    });
    const stackRunner = buildRunner({
      db: deps.db,
      investigationAgent: stackAdapters.investigationAgent,
      skillStore: deps.skillStore,
      globalOnComplete: deps.globalOnComplete,
    });
    const stackWebhookHandler = createWebhookHandler({
      runner: stackRunner,
      config: deps.config.webhook,
      services: [
        ...deps.config.services,
        ...ctx.serviceRegistry.load().filter(s => !deps.config.services.some(c => c.name === s.name)),
      ],
      db: deps.db,
      stackId: stackRow.id,
      dedup: deps.sharedDedup,
      getHiddenServices: () => deps.db.getHiddenServices(stackRow.id),
    });
    await stackWebhookHandler(req, res);
  };
}

export function registerStackScopedWebhookRoute(app: Express, deps: StackScopedWebhookHandlerDeps): void {
  app.post("/api/webhook/alert/:stackSlug", strictLimiter, createStackScopedWebhookHandler(deps));
}
