import type { Express, Request, Response } from "express";
import type { Database, InvestigationRow, PhaseRow, EventRow } from "./db.js";
import type { ServiceConfig } from "../config/schema.js";
import type { SkillStore } from "../skills/store.js";
import type { ServiceRegistryStore } from "../services/registry.js";

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
  listInvestigations(limit: number, offset: number): InvestigationRow[];
  getInvestigation(id: string): { investigation: InvestigationRow; phases: PhaseRow[]; events: EventRow[] } | undefined;
  getDependencies(service: string): Promise<{ nodes: DependencyNode[]; edges: DependencyEdge[] }>;
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
    listInvestigations: (limit, offset) => db.listInvestigations(limit, offset),
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
): void {
  const handlers = buildHandlers(db, services);

  app.get("/api/services", (_req: Request, res: Response) => {
    res.json(handlers.getServices());
  });

  app.get("/api/services/graph", (_req: Request, res: Response) => {
    res.json(inferDependencyGraph(services));
  });

  app.get("/api/investigations", (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query["limit"]) || 20, 100);
    const offset = Number(req.query["offset"]) || 0;
    res.json(handlers.listInvestigations(limit, offset));
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
}
