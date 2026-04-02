import type { Express, Request, Response } from "express";
import type { Database } from "./db.js";
import type { ServiceConfig, Config } from "../config/schema.js";
import { MAX_CACHE_ENTRIES } from "../constants.js";
import { ProviderSchema, StackConfigSchema } from "../config/schema.js";
import { DEFAULT_STACK_SLUG } from "../types/stack-types.js";
import { createMcpProvider, listProviderTools } from "../mcp/provider.js";
import type { SkillStore } from "../skills/store.js";
import type { StackManager } from "./stack-manager.js";
import type { InvestigationDedup } from "./investigation-dedup.js";
import { queryServiceMetrics } from "./prometheus-query.js";
import type { MetricSeries } from "./prometheus-query.js";
import { inferDependencyGraph } from "./dependency-graph.js";
import { buildServiceBrief } from "./service-brief.js";
import type { LanguageModel } from "ai";

export interface DependencyNode {
  id: string;
  name: string;
  type: "service" | "database" | "queue" | "cache" | "external";
  status?: "healthy" | "degraded" | "unhealthy" | "unknown";
}

export interface DependencyEdge {
  source: string;
  target: string;
  label?: string;
}

/** Validates a service name route param: alphanumeric + hyphen/underscore/dot, max 253 chars (K8s limit). */
const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,252}$/;

export interface RouteDeps {
  db: Database;
  stackManager: StackManager;
  config: Config;
  skillStore?: SkillStore;
  sharedDedup: InvestigationDedup;
  llmModel?: LanguageModel;
}

/** Get all services for a stack by merging config + registry */
function getAllServices(config: Config, req: Request): ServiceConfig[] {
  const registryStore = req.stackContext.serviceRegistry;
  const isDefault = req.stackContext.slug === DEFAULT_STACK_SLUG;
  if (!isDefault) {
    // Non-default stacks only show their own discovered/managed services
    return registryStore.load();
  }
  // Default stack merges config.yaml services + registry (config takes precedence)
  const configNames = new Set(config.services.map(s => s.name));
  const registryServices = registryStore.load().filter(s => !configNames.has(s.name));
  return [...config.services, ...registryServices];
}

export function registerRoutes(app: Express, deps: RouteDeps): void {
  const { db, stackManager, config } = deps;
  const skillStore = deps.skillStore;

  // ── Stack middleware — resolve stack for all /api routes ──────────────
  app.use("/api", (req: Request, res: Response, next) => {
    const headerStackId = req.headers["x-stack-id"] as string | undefined;
    req.stackId = stackManager.resolveStackId(headerStackId);
    try {
      req.stackContext = stackManager.getContext(req.stackId);
    } catch {
      res.status(400).json({ error: "Invalid stack" });
      return;
    }
    next();
  });

  // ── Metrics cache for /api/services/:name/metrics ───────────────────────
  const VALID_RANGES = new Set(["1h", "6h", "24h", "7d"]);
  const metricsCache = new Map<string, { data: MetricSeries[]; fetchedAt: number }>();
  const METRICS_CACHE_TTL = 60_000; // 60 seconds

  /** Maximum length for pattern symptom field. */
  const MAX_SYMPTOM_LENGTH = 500;
  /** Maximum length for pattern root cause field. */
  const MAX_ROOT_CAUSE_LENGTH = 500;
  /** Maximum length for recommended actions text. */
  const MAX_ACTIONS_LENGTH = 1_000;

  // ── Stack CRUD ──────────────────────────────────────────────────────────

  /** Slug must be 2-64 lowercase alphanumeric chars and hyphens, no leading/trailing hyphens */
  const SLUG_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

  app.get("/api/stacks", (_req: Request, res: Response) => {
    res.json(stackManager.listStacks());
  });

  app.post("/api/stacks", async (req: Request, res: Response) => {
    try {
      const { name, slug, config: stackConfig } = req.body as { name: string; slug: string; config: unknown };
      if (!name || !slug) {
        res.status(400).json({ error: "name and slug are required" });
        return;
      }
      if (!SLUG_REGEX.test(slug) || slug.length > 64) {
        res.status(400).json({ error: "Invalid slug: must be 2-64 lowercase alphanumeric characters and hyphens" });
        return;
      }
      const parsed = StackConfigSchema.safeParse(stackConfig);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues.map(i => i.message).join(", ") });
        return;
      }
      const ctx = await stackManager.createStack(name, slug, parsed.data);
      res.status(201).json({ id: ctx.id, name: ctx.name, slug: ctx.slug });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("already exists")) {
        res.status(409).json({ error: msg });
      } else {
        res.status(500).json({ error: msg });
      }
    }
  });

  app.get("/api/stacks/:id", (req: Request, res: Response) => {
    const id = req.params["id"] as string;
    const stack = db.getStack(id);
    if (!stack) {
      res.status(404).json({ error: "Stack not found" });
      return;
    }
    // Sanitize config — strip provider env vars to avoid leaking credentials
    try {
      const parsed = JSON.parse(stack.config);
      if (parsed.providers) {
        parsed.providers = parsed.providers.map((p: Record<string, unknown>) => ({
          ...p,
          mcpServer: { ...(p.mcpServer as Record<string, unknown>), env: undefined },
        }));
      }
      res.json({ ...stack, config: JSON.stringify(parsed) });
    } catch {
      res.json({ ...stack, config: "{}" });
    }
  });

  app.put("/api/stacks/:id", (req: Request, res: Response) => {
    const id = req.params["id"] as string;
    const stack = db.getStack(id);
    if (!stack) {
      res.status(404).json({ error: "Stack not found" });
      return;
    }
    const { name, slug, config: stackConfig } = req.body as { name?: string; slug?: string; config?: unknown };

    // Validate config if provided
    if (stackConfig !== undefined) {
      const parsed = StackConfigSchema.safeParse(stackConfig);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues.map(i => i.message).join(", ") });
        return;
      }
    }

    // Validate slug format if slug is being changed
    if (slug !== undefined) {
      if (!SLUG_REGEX.test(slug) || slug.length > 64) {
        res.status(400).json({ error: "Invalid slug: must be 2-64 lowercase alphanumeric characters and hyphens" });
        return;
      }
      const existing = db.getStackBySlug(slug);
      if (existing && existing.id !== id) {
        res.status(409).json({ error: "Slug already in use" });
        return;
      }
    }

    db.updateStack(id, {
      name,
      slug,
      config: stackConfig !== undefined ? JSON.stringify(stackConfig) : undefined,
    });
    res.json({ ok: true });
  });

  app.delete("/api/stacks/:id", async (req: Request, res: Response) => {
    try {
      const id = req.params["id"] as string;
      await stackManager.deleteStack(id);
      res.status(204).end();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Cannot delete")) res.status(403).json({ error: msg });
      else if (msg.includes("not found")) res.status(404).json({ error: msg });
      else res.status(500).json({ error: msg });
    }
  });

  // ── Services ────────────────────────────────────────────────────────────

  app.get("/api/services", (req: Request, res: Response) => {
    const allServices = getAllServices(config, req);

    // Merge service metadata (alias, tags) into each service object
    const allMeta = db.getAllServiceMetadata(req.stackId);
    const metaMap = new Map(allMeta.map(m => [m.service, m]));
    const enriched = allServices.map(s => {
      const meta = metaMap.get(s.name);
      return meta ? { ...s, alias: meta.alias, tags: meta.tags } : s;
    });
    res.json(enriched);
  });

  app.get("/api/branding", (req: Request, res: Response) => {
    const base = config.branding ?? { title: "dops", subtitle: "assistant" };
    let grafanaUrl: string | undefined;
    const providerRegistry = req.stackContext.providerRegistry;
    const dashProvider = providerRegistry.getAll().find(
      (p: { config: { roles: string[]; webUrl?: string } }) => p.config.roles.includes("dashboards") && p.config.webUrl,
    );
    grafanaUrl = dashProvider?.config.webUrl;
    res.json({ ...base, grafanaUrl });
  });

  app.get("/api/services/graph", (req: Request, res: Response) => {
    const current = getAllServices(config, req);
    res.json(inferDependencyGraph(current));
  });

  // ── Service Health REST API ───────────────────────────────────────────────
  app.get("/api/services/health", (req: Request, res: Response) => {
    const healthPoller = req.stackContext.healthPoller;
    res.json(Object.fromEntries(healthPoller.getHealth()));
  });

  app.get("/api/services/health/history", (req: Request, res: Response) => {
    const service = req.query["service"] as string | undefined;
    if (!service) {
      res.status(400).json({ error: "service query parameter is required" });
      return;
    }
    const hours = Math.max(1, Math.min(Number(req.query["hours"]) || 6, 168));
    const healthPoller = req.stackContext.healthPoller;
    res.json(healthPoller.getHistory(service, hours));
  });

  app.get("/api/stats/kpi", (req: Request, res: Response) => {
    res.json(db.getKpiStats(req.stackId));
  });

  app.get("/api/investigations", (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query["limit"]) || 20, 100);
    const offset = Number(req.query["offset"]) || 0;
    const service = req.query["service"] as string | undefined;
    res.json(db.listInvestigations(req.stackId, limit, offset, service));
  });

  app.get("/api/investigations/:id", (req: Request, res: Response) => {
    const id = req.params["id"];
    const idStr = Array.isArray(id) ? id[0]! : id!;
    const investigation = db.getInvestigation(req.stackId, idStr);
    if (!investigation) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const phases = db.getPhases(idStr);
    const events = db.getEvents(idStr);
    res.json({ investigation, phases, events });
  });

  // ── Service Metadata REST API ──────────────────────────────────────────
  app.get("/api/services/:name/metadata", (req: Request, res: Response) => {
    const name = req.params["name"] as string;
    if (!NAME_PATTERN.test(name)) { res.status(400).json({ error: "Invalid service name" }); return; }
    const meta = db.getServiceMetadata(req.stackId, name);
    res.json(meta ?? { service: name, alias: null, tags: [] });
  });

  app.put("/api/services/:name/alias", (req: Request, res: Response) => {
    const name = req.params["name"] as string;
    if (!NAME_PATTERN.test(name)) { res.status(400).json({ error: "Invalid service name" }); return; }
    const { alias } = req.body as { alias: string | null };
    db.upsertServiceMetadata(req.stackId, name, { alias: alias === null || alias === "" ? "" : alias });
    res.json({ ok: true });
  });

  app.put("/api/services/:name/tags", (req: Request, res: Response) => {
    const name = req.params["name"] as string;
    if (!NAME_PATTERN.test(name)) { res.status(400).json({ error: "Invalid service name" }); return; }
    const { tags } = req.body as { tags: string[] };
    db.upsertServiceMetadata(req.stackId, name, { tags });
    res.json({ ok: true });
  });

  // ── Service Metrics REST API ────────────────────────────────────────────
  app.get("/api/services/:name/metrics", async (req: Request, res: Response) => {
    const name = req.params["name"] as string;
    if (!NAME_PATTERN.test(name)) { res.status(400).json({ error: "Invalid service name" }); return; }
    const rawRange = (req.query["range"] as string) || "24h";
    const range = VALID_RANGES.has(rawRange) ? rawRange : "24h";
    const cacheKey = `${req.stackId}:${name}:${range}`;
    // Evict old entries to prevent unbounded memory growth
    if (metricsCache.size > MAX_CACHE_ENTRIES) {
      const oldest = [...metricsCache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
      for (let i = 0; i < oldest.length - MAX_CACHE_ENTRIES / 2; i++) metricsCache.delete(oldest[i]![0]);
    }

    const cached = metricsCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < METRICS_CACHE_TTL) {
      res.json({ metrics: cached.data, cached: true, fetchedAt: cached.fetchedAt });
      return;
    }

    const providers = req.stackContext.providerRegistry.getProviders();
    if (providers.length === 0) {
      res.json({ metrics: [], cached: false, fetchedAt: Date.now() });
      return;
    }

    try {
      const allServices = getAllServices(config, req);
      const svc = allServices.find((s) => s.name === name);
      const metrics = await queryServiceMetrics(name, range, providers, svc?.metrics);
      const fetchedAt = Date.now();
      metricsCache.set(cacheKey, { data: metrics, fetchedAt });
      res.json({ metrics, cached: false, fetchedAt });
    } catch (err) {
      if (cached) {
        res.json({ metrics: cached.data, cached: true, fetchedAt: cached.fetchedAt, error: "Refresh failed" });
      } else {
        res.status(503).json({ error: "Prometheus unavailable", metrics: [] });
      }
    }
  });

  // ── Service Brief REST API ──────────────────────────────────────────────
  app.get("/api/services/:name/brief", async (req: Request, res: Response) => {
    const name = req.params["name"] as string;
    if (!NAME_PATTERN.test(name)) { res.status(400).json({ error: "Invalid service name" }); return; }
    try {
      const allServices = getAllServices(config, req);
      const brief = await buildServiceBrief(name, {
        providers: req.stackContext.providerRegistry.getProviders(),
        services: allServices,
        healthPoller: req.stackContext.healthPoller,
        llmModel: deps.llmModel,
      });
      res.json(brief);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Failed to build service brief" });
    }
  });

  app.get("/api/messages", (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query["limit"]) || 50, 200);
    const investigationId = req.query["investigationId"] as string | undefined;
    res.json(db.listMessages(req.stackId, limit, investigationId));
  });

  app.delete("/api/messages/:id", (req: Request, res: Response) => {
    const id = Array.isArray(req.params["id"]) ? req.params["id"][0]! : req.params["id"]!;
    const deleted = db.deleteMessage(req.stackId, id);
    if (!deleted) {
      res.status(404).json({ error: "Message not found or is an investigation message" });
      return;
    }
    res.status(204).end();
  });

  app.delete("/api/messages", (req: Request, res: Response) => {
    const deleted = db.clearConsoleMessages(req.stackId);
    // Also clear in-memory conversation history so the LLM doesn't remember deleted context
    req.stackContext.conversationMemory.clearAll();
    res.json({ deleted });
  });

  app.get("/api/dependencies/:service", async (req: Request, res: Response) => {
    const service = Array.isArray(req.params["service"]) ? req.params["service"][0]! : req.params["service"]!;
    try {
      const allServices = getAllServices(config, req);
      const graph = inferDependencyGraph(allServices);
      const related = new Set<string>([service]);
      for (const edge of graph.edges) {
        if (edge.source === service) related.add(edge.target);
        if (edge.target === service) related.add(edge.source);
      }
      res.json({
        nodes: graph.nodes.filter(n => related.has(n.id)),
        edges: graph.edges.filter(e => related.has(e.source) && related.has(e.target)),
      });
    } catch {
      res.status(500).json({ error: "Failed to fetch dependencies" });
    }
  });

  // ── Skills REST API ─────────────────────────────────────────────────────
  if (skillStore) {
    app.get("/api/skills", (_req: Request, res: Response) => {
      res.json(skillStore.getAll());
    });

    app.get("/api/skills/:id", (req: Request, res: Response) => {
      const id = Array.isArray(req.params["id"]) ? req.params["id"][0]! : req.params["id"]!;
      const skill = skillStore.getById(id);
      if (!skill) {
        res.status(404).json({ error: "Skill not found" });
        return;
      }
      res.json(skill);
    });

    app.post("/api/skills", async (req: Request, res: Response) => {
      try {
        const { title, services: svcs, alerts, tags, body } = req.body as {
          title: string; services: string[]; alerts: string[]; tags: string[]; body: string;
        };
        if (!title) {
          res.status(400).json({ error: "title is required" });
          return;
        }
        const skill = await skillStore.save(undefined, { title, services: svcs ?? [], alerts: alerts ?? [], tags: tags ?? [] }, body ?? "");
        res.status(201).json(skill);
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : "Failed to create skill" });
      }
    });

    app.put("/api/skills/:id", async (req: Request, res: Response) => {
      try {
        const id = Array.isArray(req.params["id"]) ? req.params["id"][0]! : req.params["id"]!;
        const { title, services: svcs, alerts, tags, body } = req.body as {
          title: string; services: string[]; alerts: string[]; tags: string[]; body: string;
        };
        if (!title) {
          res.status(400).json({ error: "title is required" });
          return;
        }
        const skill = await skillStore.save(id, { title, services: svcs ?? [], alerts: alerts ?? [], tags: tags ?? [] }, body ?? "");
        res.json(skill);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to update skill";
        res.status(message === "Invalid skill id" ? 400 : 500).json({ error: message });
      }
    });

    app.delete("/api/skills/:id", async (req: Request, res: Response) => {
      try {
        const id = Array.isArray(req.params["id"]) ? req.params["id"][0]! : req.params["id"]!;
        await skillStore.delete(id);
        res.status(204).end();
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : "Failed to delete skill" });
      }
    });

    app.post("/api/skills/generate", (req: Request, res: Response) => {
      try {
        const report = req.body as {
          service?: string;
          rootCause?: string;
          trigger?: string;
          summary?: string;
          recommendedActions?: string[];
          contributingFactors?: string[];
        };

        const title = report.service
          ? `Investigate ${report.service} Issue`
          : "Generated Skill";

        const bodyParts: string[] = [];
        if (report.summary) bodyParts.push(`## Summary\n${report.summary}`);
        if (report.rootCause) bodyParts.push(`## Root Cause\n${report.rootCause}`);
        if (report.trigger) bodyParts.push(`## Trigger\n${report.trigger}`);
        if (report.recommendedActions?.length) {
          bodyParts.push(`## Recommended Actions\n${report.recommendedActions.map((a, i) => `${i + 1}. ${a}`).join("\n")}`);
        }
        if (report.contributingFactors?.length) {
          bodyParts.push(`## Contributing Factors\n${report.contributingFactors.map((f) => `- ${f}`).join("\n")}`);
        }

        // Extract keywords from summary for tags
        const tags = (report.summary ?? "")
          .toLowerCase()
          .split(/[-_\s.,;:!?'"()]+/)
          .filter((t) => t.length >= 4)
          .slice(0, 8);

        res.json({
          title,
          services: report.service ? [report.service] : [],
          alerts: [],
          tags: [...new Set(tags)],
          body: bodyParts.join("\n\n"),
        });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : "Failed to generate skill" });
      }
    });
  }

  // ── Hidden Services REST API ──────────────────────────────────────────────

  app.get("/api/services/hidden", (req: Request, res: Response) => {
    try {
      res.json(db.getHiddenServiceDetails(req.stackId));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Failed to fetch hidden services" });
    }
  });

  app.post("/api/services/hidden", (req: Request, res: Response) => {
    try {
      const { service, reason } = req.body as { service?: string; reason?: string };
      if (!service || typeof service !== "string" || service.trim() === "") {
        res.status(400).json({ error: "service is required" });
        return;
      }
      db.hideService(req.stackId, service.trim(), reason);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Failed to hide service" });
    }
  });

  app.post("/api/services/hidden/batch", (req: Request, res: Response) => {
    try {
      const { services: svcs, reason } = req.body as { services?: string[]; reason?: string };
      if (!Array.isArray(svcs) || svcs.length === 0) {
        res.status(400).json({ error: "services must be a non-empty array" });
        return;
      }
      const trimmed = svcs.map(s => (typeof s === "string" ? s.trim() : "")).filter(s => s !== "");
      db.hideServices(req.stackId, trimmed, reason);
      res.json({ ok: true, count: trimmed.length });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Failed to hide services" });
    }
  });

  app.delete("/api/services/hidden/:name", (req: Request, res: Response) => {
    try {
      const name = Array.isArray(req.params["name"]) ? req.params["name"][0]! : req.params["name"]!;
      db.unhideService(req.stackId, decodeURIComponent(name));
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Failed to unhide service" });
    }
  });

  app.get("/api/services/stale-unknown", (req: Request, res: Response) => {
    try {
      const days = Math.max(1, Math.min(Number(req.query["days"]) || 7, 90));
      res.json(db.getStaleUnknownServices(req.stackId, days));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Failed to check stale services" });
    }
  });

  // ── Service Registry REST API ─────────────────────────────────────────────
  app.put("/api/services", (req: Request, res: Response) => {
    try {
      const services = req.body as ServiceConfig[];
      if (!Array.isArray(services)) {
        res.status(400).json({ error: "Body must be an array of services" });
        return;
      }
      const registryStore = req.stackContext.serviceRegistry;
      const versionId = registryStore.save(services, "manual");
      res.json({ versionId, serviceCount: services.length });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get("/api/services/versions", (req: Request, res: Response) => {
    const registryStore = req.stackContext.serviceRegistry;
    res.json(registryStore.listVersions());
  });

  app.get("/api/services/versions/:id", (req: Request, res: Response) => {
    try {
      const id = Array.isArray(req.params["id"]) ? req.params["id"][0]! : req.params["id"]!;
      const registryStore = req.stackContext.serviceRegistry;
      const services = registryStore.getVersion(id);
      res.json(services);
    } catch (err) {
      res.status(404).json({ error: String(err) });
    }
  });

  app.post("/api/services/versions/:id/restore", (req: Request, res: Response) => {
    try {
      const id = Array.isArray(req.params["id"]) ? req.params["id"][0]! : req.params["id"]!;
      const registryStore = req.stackContext.serviceRegistry;
      registryStore.rollback(id);
      res.json({ restored: true, services: registryStore.load() });
    } catch (err) {
      res.status(404).json({ error: String(err) });
    }
  });

  // ── Feedback + Patterns REST API ────────────────────────────────────────
  app.post("/api/investigations/:id/feedback", async (req: Request, res: Response) => {
    try {
      const investigationId = Array.isArray(req.params["id"]) ? req.params["id"][0]! : req.params["id"]!;
      const { rating } = req.body as { rating: string };
      if (rating !== "useful" && rating !== "not_useful") {
        res.status(400).json({ error: "rating must be 'useful' or 'not_useful'" });
        return;
      }
      const investigation = db.getInvestigation(req.stackId, investigationId);
      if (!investigation) {
        res.status(404).json({ error: "Investigation not found" });
        return;
      }
      const { ulid: makeId } = await import("ulid");
      db.createFeedback(req.stackId, { id: `fb_${makeId()}`, investigationId, rating });

      // If positive feedback + report exists, extract a pattern
      if (rating === "useful" && investigation.report) {
        try {
          const report = JSON.parse(investigation.report);
          const validSeverities = ["low", "medium", "high", "critical"];
          const actions = Array.isArray(report.recommendedActions) ? report.recommendedActions.join("; ") : "";
          db.createPattern(req.stackId, {
            id: `pat_${makeId()}`,
            service: investigation.service,
            symptom: typeof report.summary === "string" ? report.summary.slice(0, MAX_SYMPTOM_LENGTH) : investigation.query,
            rootCause: typeof report.rootCause === "string" ? report.rootCause.slice(0, MAX_ROOT_CAUSE_LENGTH) : "Unknown",
            severity: validSeverities.includes(report.severity) ? report.severity : "medium",
            recommendedActions: actions.slice(0, MAX_ACTIONS_LENGTH),
            sourceInvestigationId: investigationId,
          });
        } catch { /* pattern extraction failed — not critical */ }
      }

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Failed to save feedback" });
    }
  });

  app.get("/api/patterns", (req: Request, res: Response) => {
    const service = req.query["service"] as string | undefined;
    if (!service) {
      res.status(400).json({ error: "service query parameter is required" });
      return;
    }
    res.json(db.findSimilarPatterns(req.stackId, service));
  });

  // ── Metric Extraction (smart chart backfill) ─────────────────────
  app.post("/api/metrics/extract", async (req: Request, res: Response) => {
    const { text, service, timeRange } = req.body as {
      text: string;
      service: string;
      timeRange?: { from: string; to: string };
    };

    if (!text || !service) {
      res.status(400).json({ error: "text and service are required" });
      return;
    }

    try {
      const providers = req.stackContext.providerRegistry.getProviders();
      const { extractMetricsFromText } = await import("./metric-extraction.js");
      const series = await extractMetricsFromText(text, service, providers, timeRange);

      res.json({
        series: series
          .filter(s => s.values.length >= 2)
          .map(s => ({
            metric: s.name,
            query: s.query,
            values: s.values,
            min: s.min,
            max: s.max,
            avg: s.avg,
          })),
      });
    } catch (err) {
      res.json({ series: [], error: err instanceof Error ? err.message : "Extraction failed" });
    }
  });

  // ── Provider Management REST API ──────────────────────────────────────

  // GET /api/providers — list all with connection status
  app.get("/api/providers", (req: Request, res: Response) => {
    const providerRegistry = req.stackContext.providerRegistry;
    const providers = providerRegistry.getAll();
    res.json(providers.map((p: any) => ({
      name: p.config.name,
      roles: p.config.roles,
      region: p.config.region,
      transport: p.config.mcpServer.transport,
      url: p.config.mcpServer.transport === "http" ? p.config.mcpServer.url : undefined,
      source: p.source,
      status: p.status,
      toolCount: p.toolCount,
      enabledToolCount: p.enabledToolCount,
      error: p.error,
    })));
  });

  // POST /api/providers — add a new provider
  app.post("/api/providers", async (req: Request, res: Response) => {
    try {
      const providerRegistry = req.stackContext.providerRegistry;
      const provConfig = req.body;
      const parsed = ProviderSchema.safeParse(provConfig);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues.map(i => i.message).join(", ") });
        return;
      }
      const info = await providerRegistry.add(parsed.data);
      res.status(201).json({
        name: info.config.name,
        status: info.status,
        toolCount: info.toolCount,
        error: info.error,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("already exists")) {
        res.status(409).json({ error: msg });
      } else {
        res.status(500).json({ error: msg });
      }
    }
  });

  // PUT /api/providers/:name — update
  app.put("/api/providers/:name", async (req: Request, res: Response) => {
    try {
      const providerRegistry = req.stackContext.providerRegistry;
      const name = Array.isArray(req.params["name"]) ? req.params["name"][0]! : req.params["name"]!;
      const provConfig = req.body;
      const parsed = ProviderSchema.safeParse(provConfig);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues.map(i => i.message).join(", ") });
        return;
      }
      const info = await providerRegistry.update(name, parsed.data);
      res.json({ name: info.config.name, status: info.status, toolCount: info.toolCount });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("system provider")) res.status(403).json({ error: msg });
      else if (msg.includes("not found")) res.status(404).json({ error: msg });
      else res.status(500).json({ error: msg });
    }
  });

  // DELETE /api/providers/:name — remove
  app.delete("/api/providers/:name", async (req: Request, res: Response) => {
    try {
      const providerRegistry = req.stackContext.providerRegistry;
      const name = Array.isArray(req.params["name"]) ? req.params["name"][0]! : req.params["name"]!;
      await providerRegistry.remove(name);
      res.status(204).end();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("system provider")) res.status(403).json({ error: msg });
      else if (msg.includes("not found")) res.status(404).json({ error: msg });
      else res.status(500).json({ error: msg });
    }
  });

  // POST /api/providers/test-config — test a config without persisting
  app.post("/api/providers/test-config", async (req: Request, res: Response) => {
    try {
      const parsed = ProviderSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues.map(i => i.message).join(", ") });
        return;
      }
      const provider = createMcpProvider(parsed.data);
      const tools = await listProviderTools(provider);
      const toolCount = Object.keys(tools).length;
      res.json({ status: "ok", toolCount });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.json({ status: "error", toolCount: 0, error: msg });
    }
  });

  // POST /api/providers/:name/test — test connection
  app.post("/api/providers/:name/test", async (req: Request, res: Response) => {
    try {
      const providerRegistry = req.stackContext.providerRegistry;
      const name = Array.isArray(req.params["name"]) ? req.params["name"][0]! : req.params["name"]!;
      const result = await providerRegistry.test(name);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) res.status(404).json({ error: msg });
      else res.status(500).json({ error: msg });
    }
  });

  // GET /api/providers/:name/tools — list tools with metadata
  app.get("/api/providers/:name/tools", async (req: Request, res: Response) => {
    try {
      const providerRegistry = req.stackContext.providerRegistry;
      const name = Array.isArray(req.params["name"]) ? req.params["name"][0]! : req.params["name"]!;
      const tools = await providerRegistry.getToolsForProvider(name);
      // Sort: read-only first (alphabetical), then write (alphabetical)
      tools.sort((a: any, b: any) => {
        if (a.readOnly !== b.readOnly) return a.readOnly ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      res.json(tools);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) res.status(404).json({ error: msg });
      else res.status(500).json({ error: msg });
    }
  });

  // PUT /api/providers/:name/tools — update enabled tools
  app.put("/api/providers/:name/tools", async (req: Request, res: Response) => {
    try {
      const providerRegistry = req.stackContext.providerRegistry;
      const name = Array.isArray(req.params["name"]) ? req.params["name"][0]! : req.params["name"]!;
      const { enabledTools } = req.body as { enabledTools: string[] };
      if (!Array.isArray(enabledTools)) {
        res.status(400).json({ error: "enabledTools must be an array of strings" });
        return;
      }
      await providerRegistry.updateEnabledTools(name, enabledTools);
      const entry = providerRegistry.getAll().find((p: any) => p.config.name === name);
      res.json({
        ok: true,
        enabledToolCount: entry?.enabledToolCount ?? enabledTools.length,
        configWarning: entry?.source === "config"
          ? "Changes to system providers are in-memory only. Update config.yaml to persist."
          : undefined,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) res.status(404).json({ error: msg });
      else res.status(500).json({ error: msg });
    }
  });
}
