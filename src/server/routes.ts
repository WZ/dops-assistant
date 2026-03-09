import type { Express, Request, Response } from "express";
import type { Database, InvestigationRow, PhaseRow } from "./db.js";
import type { ServiceConfig } from "../config/schema.js";

export interface RouteHandlers {
  getServices(): ServiceConfig[];
  listInvestigations(limit: number, offset: number): InvestigationRow[];
  getInvestigation(id: string): { investigation: InvestigationRow; phases: PhaseRow[] } | undefined;
}

export function buildHandlers(db: Database, services: ServiceConfig[]): RouteHandlers {
  return {
    getServices: () => services,
    listInvestigations: (limit, offset) => db.listInvestigations(limit, offset),
    getInvestigation: (id) => {
      const investigation = db.getInvestigation(id);
      if (!investigation) return undefined;
      const phases = db.getPhases(id);
      return { investigation, phases };
    },
  };
}

export function registerRoutes(app: Express, db: Database, services: ServiceConfig[]): void {
  const handlers = buildHandlers(db, services);

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
}
