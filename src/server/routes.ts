import type { Express, Request, Response } from "express";
import type { Database, InvestigationRow, PhaseRow, EventRow, KpiStats } from "./db.js";
import type { ServiceConfig, BrandingConfig } from "../config/schema.js";
import { ProviderSchema } from "../config/schema.js";
import { createMcpProvider, listProviderTools } from "../mcp/provider.js";
import type { MastraProvider } from "../mcp/provider.js";
import type { SkillStore } from "../skills/store.js";
import type { ServiceRegistryStore } from "../services/registry.js";
import type { ProviderRegistry } from "../mcp/provider-registry.js";
import type { ServiceHealthPoller } from "./service-health-poller.js";
import { queryServiceMetrics } from "./prometheus-query.js";
import type { MetricSeries } from "./prometheus-query.js";

export interface DependencyNode {
  id: string;
  name: string;
  type: "service" | "database" | "queue" | "cache" | "external";
  status?: "healthy" | "degraded" | "unhealthy";
}

export interface DependencyEdge {
  source: string;
  target: string;
  label?: string;
}

export interface RouteHandlers {
  getServices(): ServiceConfig[];
  listInvestigations(limit: number, offset: number, service?: string): InvestigationRow[];
  getInvestigation(id: string): { investigation: InvestigationRow; phases: PhaseRow[]; events: EventRow[] } | undefined;
  getDependencies(service: string): Promise<{ nodes: DependencyNode[]; edges: DependencyEdge[] }>;
  getKpiStats(): KpiStats;
}

/**
 * Infer service dependency graph from service registry data.
 * Uses metric query labels and service name patterns to detect relationships.
 */
function inferDependencyGraph(services: ServiceConfig[]): { nodes: DependencyNode[]; edges: DependencyEdge[] } {
  const nodes: DependencyNode[] = services.map(s => ({
    id: s.name,
    name: s.name,
    type: "service" as const,
  }));

  const edges: DependencyEdge[] = [];
  const serviceNames = new Set(services.map(s => s.name));

  for (const svc of services) {
    // Check if any metric queries reference other services by name
    for (const metric of svc.metrics) {
      for (const otherName of serviceNames) {
        if (otherName === svc.name) continue;
        // Look for service references in metric queries (e.g., upstream="other-service")
        if (metric.query.includes(otherName) || metric.query.includes(otherName.replace(/-/g, "_"))) {
          const edgeId = `${svc.name}->${otherName}`;
          if (!edges.some(e => e.source === svc.name && e.target === otherName)) {
            edges.push({ source: svc.name, target: otherName, label: "metrics" });
          }
        }
      }
    }

    // Check log labels for service references
    const logLabelValues = Object.values(svc.logLabels ?? {});
    for (const val of logLabelValues) {
      for (const otherName of serviceNames) {
        if (otherName === svc.name) continue;
        if (val.includes(otherName)) {
          if (!edges.some(e => e.source === svc.name && e.target === otherName)) {
            edges.push({ source: svc.name, target: otherName, label: "logs" });
          }
        }
      }
    }
  }

  return { nodes, edges };
}

export function buildHandlers(db: Database, services: ServiceConfig[]): RouteHandlers {
  return {
    getServices: () => services,
    listInvestigations: (limit, offset, service) => db.listInvestigations(limit, offset, service),
    getKpiStats: () => db.getKpiStats(),
    getInvestigation: (id) => {
      const investigation = db.getInvestigation(id);
      if (!investigation) return undefined;
      const phases = db.getPhases(id);
      const events = db.getEvents(id);
      return { investigation, phases, events };
    },
    getDependencies: async (service: string) => {
      const graph = inferDependencyGraph(services);
      // Filter to just the requested service and its neighbors
      const related = new Set<string>([service]);
      for (const edge of graph.edges) {
        if (edge.source === service) related.add(edge.target);
        if (edge.target === service) related.add(edge.source);
      }
      return {
        nodes: graph.nodes.filter(n => related.has(n.id)),
        edges: graph.edges.filter(e => related.has(e.source) && related.has(e.target)),
      };
    },
  };
}

export function registerRoutes(
  app: Express, db: Database, services: ServiceConfig[], _mcp?: unknown,
  skillStore?: SkillStore, registryStore?: ServiceRegistryStore,
  providerRegistry?: ProviderRegistry,
  branding?: BrandingConfig,
  healthPoller?: ServiceHealthPoller,
  getProviders?: () => MastraProvider[],
): void {
  const handlers = buildHandlers(db, services);

  // ── Metrics cache for /api/services/:name/metrics ───────────────────────
  const VALID_RANGES = new Set(["1h", "6h", "24h", "7d"]);
  const MAX_CACHE_ENTRIES = 200;
  const metricsCache = new Map<string, { data: MetricSeries[]; fetchedAt: number }>();
  const METRICS_CACHE_TTL = 60_000; // 60 seconds

  app.get("/api/services", (_req: Request, res: Response) => {
    // Merge config.yaml inline services with registry (services.yaml) entries.
    // Config services take precedence (dedup by name), then append registry-only services.
    let allServices: ServiceConfig[];
    if (registryStore) {
      const configNames = new Set(services.map(s => s.name));
      const registryServices = registryStore.load().filter(s => !configNames.has(s.name));
      allServices = [...services, ...registryServices];
    } else {
      allServices = handlers.getServices();
    }

    // Merge service metadata (alias, tags) into each service object
    const allMeta = db.getAllServiceMetadata();
    const metaMap = new Map(allMeta.map(m => [m.service, m]));
    const enriched = allServices.map(s => {
      const meta = metaMap.get(s.name);
      return meta ? { ...s, alias: meta.alias, tags: meta.tags } : s;
    });
    res.json(enriched);
  });

  app.get("/api/branding", (_req: Request, res: Response) => {
    res.json(branding ?? { title: "dops", subtitle: "assistant" });
  });

  app.get("/api/services/graph", (_req: Request, res: Response) => {
    let current = services;
    if (registryStore) {
      const configNames = new Set(services.map(s => s.name));
      const registryServices = registryStore.load().filter(s => !configNames.has(s.name));
      current = [...services, ...registryServices];
    }
    res.json(inferDependencyGraph(current));
  });

  // ── Service Health REST API ───────────────────────────────────────────────
  app.get("/api/services/health", (_req: Request, res: Response) => {
    if (!healthPoller) {
      res.json({});
      return;
    }
    res.json(Object.fromEntries(healthPoller.getHealth()));
  });

  app.get("/api/services/health/history", (req: Request, res: Response) => {
    const service = req.query["service"] as string | undefined;
    if (!service) {
      res.status(400).json({ error: "service query parameter is required" });
      return;
    }
    const hours = Math.max(1, Math.min(Number(req.query["hours"]) || 6, 168));
    if (!healthPoller) {
      res.json([]);
      return;
    }
    res.json(healthPoller.getHistory(service, hours));
  });

  app.get("/api/stats/kpi", (_req: Request, res: Response) => {
    res.json(handlers.getKpiStats());
  });

  app.get("/api/investigations", (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query["limit"]) || 20, 100);
    const offset = Number(req.query["offset"]) || 0;
    const service = req.query["service"] as string | undefined;
    res.json(handlers.listInvestigations(limit, offset, service));
  });

  app.get("/api/investigations/:id", (req: Request, res: Response) => {
    const id = req.params["id"];
    const idStr = Array.isArray(id) ? id[0]! : id!;
    const result = handlers.getInvestigation(idStr);
    if (!result) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(result);
  });

  // ── Service Metadata REST API ──────────────────────────────────────────
  app.get("/api/services/:name/metadata", (req: Request, res: Response) => {
    const name = req.params["name"] as string;
    const meta = db.getServiceMetadata(name);
    res.json(meta ?? { service: name, alias: null, tags: [] });
  });

  app.put("/api/services/:name/alias", (req: Request, res: Response) => {
    const name = req.params["name"] as string;
    const { alias } = req.body as { alias: string | null };
    db.upsertServiceMetadata(name, { alias: alias === null || alias === "" ? "" : alias });
    res.json({ ok: true });
  });

  app.put("/api/services/:name/tags", (req: Request, res: Response) => {
    const name = req.params["name"] as string;
    const { tags } = req.body as { tags: string[] };
    db.upsertServiceMetadata(name, { tags });
    res.json({ ok: true });
  });

  // ── Service Metrics REST API ────────────────────────────────────────────
  app.get("/api/services/:name/metrics", async (req: Request, res: Response) => {
    const name = req.params["name"] as string;
    const rawRange = (req.query["range"] as string) || "24h";
    const range = VALID_RANGES.has(rawRange) ? rawRange : "24h";
    const cacheKey = `${name}:${range}`;
    // Evict old entries to prevent unbounded memory growth
    if (metricsCache.size > MAX_CACHE_ENTRIES) {
      const oldest = [...metricsCache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
      for (let i = 0; i < oldest.length - MAX_CACHE_ENTRIES / 2; i++) metricsCache.delete(oldest[i][0]);
    }

    const cached = metricsCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < METRICS_CACHE_TTL) {
      res.json({ metrics: cached.data, cached: true, fetchedAt: cached.fetchedAt });
      return;
    }

    if (!getProviders) {
      // No providers available — return empty metrics
      res.json({ metrics: [], cached: false, fetchedAt: Date.now() });
      return;
    }

    try {
      const allServices = registryStore ? registryStore.load() : services;
      const svc = allServices.find((s) => s.name === name);
      const metrics = await queryServiceMetrics(name, range, getProviders(), svc?.metrics);
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

  app.get("/api/messages", (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query["limit"]) || 50, 200);
    const investigationId = req.query["investigationId"] as string | undefined;
    res.json(db.listMessages(limit, investigationId));
  });

  app.get("/api/dependencies/:service", async (req: Request, res: Response) => {
    const service = Array.isArray(req.params["service"]) ? req.params["service"][0]! : req.params["service"]!;
    try {
      const result = await handlers.getDependencies(service);
      res.json(result);
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

  app.get("/api/services/hidden", (_req: Request, res: Response) => {
    try {
      res.json(db.getHiddenServiceDetails());
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
      db.hideService(service.trim(), reason);
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
      db.hideServices(trimmed, reason);
      res.json({ ok: true, count: trimmed.length });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Failed to hide services" });
    }
  });

  app.delete("/api/services/hidden/:name", (req: Request, res: Response) => {
    try {
      const name = Array.isArray(req.params["name"]) ? req.params["name"][0]! : req.params["name"]!;
      db.unhideService(decodeURIComponent(name));
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Failed to unhide service" });
    }
  });

  app.get("/api/services/stale-unknown", (req: Request, res: Response) => {
    try {
      const days = Math.max(1, Math.min(Number(req.query["days"]) || 7, 90));
      res.json(db.getStaleUnknownServices(days));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Failed to check stale services" });
    }
  });

  // ── Service Registry REST API ─────────────────────────────────────────────
  if (registryStore) {
    app.put("/api/services", (req: Request, res: Response) => {
      try {
        const services = req.body as ServiceConfig[];
        if (!Array.isArray(services)) {
          res.status(400).json({ error: "Body must be an array of services" });
          return;
        }
        const versionId = registryStore.save(services, "manual");
        res.json({ versionId, serviceCount: services.length });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/services/versions", (_req: Request, res: Response) => {
      res.json(registryStore.listVersions());
    });

    app.get("/api/services/versions/:id", (req: Request, res: Response) => {
      try {
        const id = Array.isArray(req.params["id"]) ? req.params["id"][0]! : req.params["id"]!;
        const services = registryStore.getVersion(id);
        res.json(services);
      } catch (err) {
        res.status(404).json({ error: String(err) });
      }
    });

    app.post("/api/services/versions/:id/restore", (req: Request, res: Response) => {
      try {
        const id = Array.isArray(req.params["id"]) ? req.params["id"][0]! : req.params["id"]!;
        registryStore.rollback(id);
        res.json({ restored: true, services: registryStore.load() });
      } catch (err) {
        res.status(404).json({ error: String(err) });
      }
    });
  }

  // ── Feedback + Patterns REST API ────────────────────────────────────────
  app.post("/api/investigations/:id/feedback", async (req: Request, res: Response) => {
    try {
      const investigationId = Array.isArray(req.params["id"]) ? req.params["id"][0]! : req.params["id"]!;
      const { rating } = req.body as { rating: string };
      if (rating !== "useful" && rating !== "not_useful") {
        res.status(400).json({ error: "rating must be 'useful' or 'not_useful'" });
        return;
      }
      const investigation = db.getInvestigation(investigationId);
      if (!investigation) {
        res.status(404).json({ error: "Investigation not found" });
        return;
      }
      const { ulid: makeId } = await import("ulid");
      db.createFeedback({ id: `fb_${makeId()}`, investigationId, rating });

      // If positive feedback + report exists, extract a pattern
      if (rating === "useful" && investigation.report) {
        try {
          const report = JSON.parse(investigation.report);
          const validSeverities = ["low", "medium", "high", "critical"];
          const actions = Array.isArray(report.recommendedActions) ? report.recommendedActions.join("; ") : "";
          db.createPattern({
            id: `pat_${makeId()}`,
            service: investigation.service,
            symptom: typeof report.summary === "string" ? report.summary.slice(0, 500) : investigation.query,
            rootCause: typeof report.rootCause === "string" ? report.rootCause.slice(0, 500) : "Unknown",
            severity: validSeverities.includes(report.severity) ? report.severity : "medium",
            recommendedActions: actions.slice(0, 1000),
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
    res.json(db.findSimilarPatterns(service));
  });

  // ── Provider Management REST API ──────────────────────────────────────
  if (providerRegistry) {
    // GET /api/providers — list all with connection status
    app.get("/api/providers", (_req: Request, res: Response) => {
      const providers = providerRegistry.getAll();
      res.json(providers.map(p => ({
        name: p.config.name,
        roles: p.config.roles,
        region: p.config.region,
        transport: p.config.mcpServer.transport,
        command: p.config.mcpServer.transport === "stdio" ? p.config.mcpServer.command : undefined,
        url: p.config.mcpServer.transport === "http" ? p.config.mcpServer.url : undefined,
        source: p.source,
        status: p.status,
        toolCount: p.toolCount,
        error: p.error,
      })));
    });

    // POST /api/providers — add a new provider
    app.post("/api/providers", async (req: Request, res: Response) => {
      try {
        const config = req.body;
        const parsed = ProviderSchema.safeParse(config);
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
        const name = Array.isArray(req.params["name"]) ? req.params["name"][0]! : req.params["name"]!;
        const config = req.body;
        const parsed = ProviderSchema.safeParse(config);
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
        const name = Array.isArray(req.params["name"]) ? req.params["name"][0]! : req.params["name"]!;
        const result = await providerRegistry.test(name);
        res.json(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("not found")) res.status(404).json({ error: msg });
        else res.status(500).json({ error: msg });
      }
    });
  }
}
