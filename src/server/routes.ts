import type { Express, Request, Response } from "express";
import type { Database, InvestigationRow, PhaseRow, EventRow } from "./db.js";
import type { ServiceConfig } from "../config/schema.js";
import type { SkillStore } from "../skills/store.js";
import type { ProviderRole } from "../config/schema.js";

/** Minimal MCP interface needed by routes (dependency graph queries). */
export interface IMcpClient {
  hasRole(role: ProviderRole): boolean;
  getToolsByRole(role: ProviderRole): { function: { name: string } }[];
  callTool(name: string, args: Record<string, unknown>): Promise<{ text: string }>;
}

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

export function buildHandlers(db: Database, services: ServiceConfig[], mcp: IMcpClient): RouteHandlers {
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
      if (!mcp.hasRole("dependencies")) {
        return { nodes: [{ id: service, name: service, type: "service" as const }], edges: [] };
      }

      try {
        const tools = mcp.getToolsByRole("dependencies");
        const toolNames = tools.map((t) => t.function.name);

        for (const name of toolNames) {
          if (name.includes("dependenc") || name.includes("topology") || name.includes("service_map")) {
            const result = await mcp.callTool(name, { service });
            const parsed = JSON.parse(result.text);
            if (parsed.nodes && parsed.edges) return parsed;
          }
        }
      } catch { /* fall through */ }

      return { nodes: [{ id: service, name: service, type: "service" as const }], edges: [] };
    },
  };
}

export function registerRoutes(app: Express, db: Database, services: ServiceConfig[], mcp: IMcpClient, skillStore?: SkillStore): void {
  const handlers = buildHandlers(db, services, mcp);

  app.get("/api/services", (_req: Request, res: Response) => {
    res.json(handlers.getServices());
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
}
