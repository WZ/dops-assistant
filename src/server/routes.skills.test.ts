import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ulid } from "ulid";
import { registerRoutes } from "./routes.js";
import { Database } from "./db.js";
import { SkillStore } from "../skills/store.js";

const GATES = {
  appliesToServiceMetric: "consul_health_service_status",
  healthySignal: 'max(up{job="x"})',
  failureSignal: 'min(up{job="x"}) == 0',
  failureCause: "service down",
  identityHint: "consul service",
  incompatibleClaims: "pod|deployment",
};

let app: Express;
let db: Database;
let dbPath: string;
let dir: string;

beforeEach(async () => {
  dbPath = join(tmpdir(), `routes-skills-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  dir = mkdtempSync(join(tmpdir(), "skills-"));
  db = new Database(dbPath);
  const stackId = ulid();
  db.createStack({ id: stackId, name: "Default", slug: "default", config: "{\"providers\":[]}" });
  const skillStore = new SkillStore({ dir, maxPerQuery: 3, maxCharsPerSkill: 4000 });
  await skillStore.loadAll();

  app = express();
  app.use(express.json());
  registerRoutes(app, {
    db,
    stackManager: {
      resolveStackIdWithFallback: () => ({ id: stackId, fallback: false }),
      getContext: () => ({ id: stackId, slug: "default", serviceRegistry: { load: () => [] }, providerRegistry: { getProviders: () => [], getAll: () => [] } }),
      bumpActivity: () => {},
    } as any,
    config: { llm: { apiKey: "k", model: "test" }, services: [] } as any,
    skillStore,
    llmModel: {} as any,
  } as any);
});

afterEach(() => {
  db.close();
  try { unlinkSync(dbPath); } catch { /* ignore */ }
  rmSync(dir, { recursive: true, force: true });
});

const base = { title: "Gated", services: [], alerts: [], tags: [], scope: ["investigation"], body: "steps" };

describe("skills API keeps health/failure gate fields", () => {
  it("POST stores gate fields", async () => {
    const res = await request(app).post("/api/skills").send({ ...base, ...GATES }).expect(201);
    expect(res.body).toMatchObject(GATES);
    expect(readFileSync(join(dir, `${res.body.id}.md`), "utf-8")).toContain("healthySignal:");
  });

  it("PUT without gate fields (GUI editor) keeps the existing ones", async () => {
    await request(app).put("/api/skills/gated").send({ ...base, ...GATES }).expect(200);
    const res = await request(app).put("/api/skills/gated").send({ ...base, body: "edited" }).expect(200);
    expect(res.body).toMatchObject({ ...GATES, body: "edited" });
    const file = readFileSync(join(dir, "gated.md"), "utf-8");
    for (const key of Object.keys(GATES)) expect(file).toContain(`${key}:`);
  });

  it("PUT with a new gate value replaces it; an empty string clears it", async () => {
    await request(app).put("/api/skills/gated").send({ ...base, ...GATES }).expect(200);
    const res = await request(app).put("/api/skills/gated").send({ ...base, healthySignal: "vector(1)", failureCause: "" }).expect(200);
    expect(res.body.healthySignal).toBe("vector(1)");
    expect(res.body.failureCause).toBeUndefined();
    expect(res.body.failureSignal).toBe(GATES.failureSignal);
  });
});
