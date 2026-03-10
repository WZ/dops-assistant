import type { Express, Request, Response } from "express";
import type { Database, InvestigationRow, PhaseRow, EventRow } from "./db.js";
import type { ServiceConfig } from "../config/schema.js";
import type { MultiMcpClient } from "../mcp/multi-client.js";

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

export function buildHandlers(db: Database, services: ServiceConfig[], mcp: MultiMcpClient): RouteHandlers {
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

export function registerRoutes(app: Express, db: Database, services: ServiceConfig[], mcp: MultiMcpClient): void {
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
}
