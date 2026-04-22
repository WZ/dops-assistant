import type { Express, Request, Response } from "express";
import { createLogger } from "../logger.js";
import type { Database } from "./db.js";
import type { ServiceConfig, Config, ProviderConfig } from "../config/schema.js";
import { MAX_CACHE_ENTRIES } from "../constants.js";
import { ProviderSchema, StackConfigSchema } from "../config/schema.js";
import { DEFAULT_STACK_SLUG } from "../types/stack-types.js";
import { createMcpProvider, listProviderTools } from "../mcp/provider.js";
import { clearStackCaches } from "./ws-handler.js";
import type { SkillStore } from "../skills/store.js";
import type { ProviderInfo } from "../mcp/provider-registry.js";
import type { StackManager } from "./stack-manager.js";
import type { InvestigationDedup } from "./investigation-dedup.js";
import { queryServiceMetrics } from "./prometheus-query.js";
import type { MetricSeries } from "./prometheus-query.js";
import { inferDependencyGraph } from "./dependency-graph.js";
import { buildServiceBrief } from "./service-brief.js";
import type { LanguageModel } from "ai";
import { eventLog } from "./event-log.js";
import { SkillInputSchema } from "./sanitize.js";
import { Cron } from "croner";
import { z } from "zod";
import { getScanSettingsView } from "./scan-settings.js";
import nodemailer from "nodemailer";
import type { RcaReport } from "../types/rca-types.js";
import { notifyEmail } from "./email-notifier.js";

/**
 * Zod schema for PUT /api/scan/settings body.
 *
 * - `enabled` / `cron` / `timezone` each accept: a typed value (writes the
 *   override), `null` (clears the override, reverts to config.yaml), or
 *   absent (leaves the existing override untouched).
 * - Empty strings are explicitly rejected — they otherwise silently soft-break
 *   the scheduler ('' is a valid cron input that croner can't parse, and ''
 *   is a nonsense timezone). Operators who want to clear an override should
 *   send `null`.
 * - `.strict()` rejects unknown keys so API misuse produces a loud 400 instead
 *   of silently ignoring typos.
 */
const ScanSettingsUpdateSchema = z.object({
  enabled: z.union([z.boolean(), z.null()]).optional(),
  cron: z.union([z.string().min(1, "cron must be non-empty or null"), z.null()]).optional(),
  timezone: z.union([z.string().min(1, "timezone must be non-empty or null"), z.null()]).optional(),
}).strict();

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

/** Extract the portable ProviderConfig from a ProviderInfo, stripping runtime fields. */
export function exportProviderConfig(info: ProviderInfo): ProviderConfig {
  const cfg: Record<string, unknown> = {
    name: info.config.name,
    roles: info.config.roles,
    mcpServer: info.config.mcpServer,
  };
  if (info.config.region) cfg.region = info.config.region;
  if (info.config.webUrl) cfg.webUrl = info.config.webUrl;
  return cfg as ProviderConfig;
}

export interface ImportDryRunResult {
  name: string;
  status: "ready" | "conflict" | "invalid";
  source?: "config" | "gui";
  error?: string;
}

export function validateImportProviders(
  providers: unknown[],
  existingProviders: Map<string, "config" | "gui">,
): ImportDryRunResult[] {
  const results: ImportDryRunResult[] = [];
  const seenNames = new Set<string>();

  for (const raw of providers) {
    const parsed = ProviderSchema.safeParse(raw);
    if (!parsed.success) {
      const name = (raw && typeof raw === "object" && "name" in raw && typeof (raw as any).name === "string")
        ? (raw as any).name
        : `(unnamed)`;
      results.push({ name, status: "invalid", error: parsed.error.issues.map(i => i.message).join("; ") });
      continue;
    }
    const config = parsed.data;
    if (seenNames.has(config.name)) {
      results.push({ name: config.name, status: "invalid", error: `Duplicate name in import: "${config.name}" appears more than once` });
      continue;
    }
    seenNames.add(config.name);
    const existingSource = existingProviders.get(config.name);
    if (existingSource) {
      results.push({ name: config.name, status: "conflict", source: existingSource });
      continue;
    }
    results.push({ name: config.name, status: "ready" });
  }
  return results;
}

export interface ImportAction {
  config: ProviderConfig;
  action: "add" | "overwrite" | "skip";
  reason?: string;
}

export function categorizeImportActions(
  providers: unknown[],
  overwrite: string[],
  existingProviders: Map<string, "config" | "gui">,
): ImportAction[] {
  const overwriteSet = new Set(overwrite);
  const actions: ImportAction[] = [];
  for (const raw of providers) {
    const parsed = ProviderSchema.safeParse(raw);
    if (!parsed.success) continue;
    const config = parsed.data;
    const existingSource = existingProviders.get(config.name);
    if (!existingSource) {
      actions.push({ config, action: "add" });
    } else if (overwriteSet.has(config.name)) {
      if (existingSource === "config") {
        actions.push({ config, action: "skip", reason: "Cannot overwrite config provider" });
      } else {
        actions.push({ config, action: "overwrite" });
      }
    } else {
      actions.push({ config, action: "skip", reason: "Conflict not in overwrite list" });
    }
  }
  return actions;
}

const logger = createLogger("routes");

export function registerRoutes(app: Express, deps: RouteDeps): void {
  const { db, stackManager, config } = deps;
  const skillStore = deps.skillStore;

  // ── Stack middleware — resolve stack for all /api routes ──────────────
  //
  // When the X-Stack-Id header is missing or doesn't match any stack, we fall
  // back to the default stack. That's the long-standing behavior, but the
  // client used to have no way to know the fallback happened — a bookmarked
  // URL pointing at a deleted stack would silently serve default-stack data.
  // We now:
  //   - log at debug level so operators can trace "wrong data on /foo" issues
  //   - set `X-Dops-Stack-Fallback: true` on the response so the UI can warn
  app.use("/api", (req: Request, res: Response, next) => {
    const headerStackId = req.headers["x-stack-id"] as string | undefined;
    const resolved = stackManager.resolveStackIdWithFallback(headerStackId);
    req.stackId = resolved.id;
    if (resolved.fallback) {
      logger.debug({ wanted: headerStackId, resolved: resolved.id }, "stack id fell back to default");
      res.setHeader("X-Dops-Stack-Fallback", "true");
    }
    try {
      req.stackContext = stackManager.getContext(req.stackId);
    } catch {
      res.status(400).json({ error: "Invalid stack" });
      return;
    }
    // Touch the stack's last-active timestamp on any API hit — covers UI
    // navigation, tool calls (the LLM agent talks to us via /api), webhook
    // proxies, and the service detail page. Poll cycles bump separately
    // from within the poller itself so they stay independent of HTTP.
    try { stackManager.bumpActivity(req.stackId); } catch { /* best-effort */ }
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

  /**
   * Proactive scan status for the resolved stack. Read-only, always safe to poll
   * from the UI. Shape matches the ScanStatus interface in scan-scheduler.ts
   * plus the `enabled` flag coming from the effective runtime config (not the
   * startup config — matters when scan.enabled is flipped in config + restart).
   */
  app.get("/api/scan/status", (req: Request, res: Response) => {
    if (!req.stackContext) {
      res.status(400).json({ error: "No active stack" });
      return;
    }
    res.json(req.stackContext.scanScheduler.getStatus());
  });

  /**
   * GET effective scan settings — global, not per-stack (probe config lives
   * in config.yaml and is shared). Matches the shape of /api/notifications:
   * effective values + per-field `source` (gui|config) so the UI can show a
   * "from config.yaml" badge.
   */
  app.get("/api/scan/settings", (_req: Request, res: Response) => {
    res.json(getScanSettingsView(db, config));
  });

  /**
   * PUT scan settings — writes `scan.enabled`, `scan.cron`, `scan.timezone`
   * to db.settings, validates cron via croner, then calls
   * stackManager.reloadAllScanSchedulers() so the change takes effect
   * without a server restart.
   *
   * Accepts partial updates. Missing fields are left untouched. To clear
   * an override and revert to config.yaml, set the field to `null`.
   */
  app.put("/api/scan/settings", (req: Request, res: Response) => {
    const parsed = ScanSettingsUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      const errors = parsed.error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`);
      res.status(400).json({ error: "Invalid request body", details: errors });
      return;
    }
    const body = parsed.data;

    // Validate cron + timezone BEFORE writing. Probe construction must use
    // the same options the scheduler itself uses at start() — otherwise
    // validation can pass but start() can throw on identical input, and the
    // DB ends up holding a poisoned value.
    //
    // Validate if EITHER field is being changed: timezone-only changes also
    // need to work with the existing cron, so we resolve the effective-after
    // pair and validate that combination.
    const willChangeCron = typeof body.cron === "string";
    const willChangeTimezone = typeof body.timezone === "string";
    if (willChangeCron || willChangeTimezone) {
      const currentView = getScanSettingsView(db, config);
      const effectiveCron = willChangeCron ? (body.cron as string) : currentView.cron;
      const effectiveTimezone = willChangeTimezone ? (body.timezone as string) : currentView.timezone;
      try {
        // Match scheduler's options exactly (scan-scheduler.ts `start()`):
        // `protect: true` is intentional — any difference from start()'s
        // options could let a value validate here but throw there.
        const probe = new Cron(
          effectiveCron,
          { timezone: effectiveTimezone, protect: true, paused: true },
          () => {},
        );
        probe.stop();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(400).json({
          error: "Invalid cron expression or timezone",
          details: [msg, `resolved to: cron="${effectiveCron}", timezone="${effectiveTimezone}"`],
        });
        return;
      }
    }

    // `null` clears the override; otherwise persist the validated value.
    if (body.enabled === null) db.deleteSetting("scan.enabled");
    else if (typeof body.enabled === "boolean") db.setSetting("scan.enabled", String(body.enabled));

    if (body.cron === null) db.deleteSetting("scan.cron");
    else if (typeof body.cron === "string") db.setSetting("scan.cron", body.cron);

    if (body.timezone === null) db.deleteSetting("scan.timezone");
    else if (typeof body.timezone === "string") db.setSetting("scan.timezone", body.timezone);

    // Propagate to every running scheduler. Idempotent — reload() no-ops
    // when nothing changed.
    stackManager.reloadAllScanSchedulers();

    res.json(getScanSettingsView(db, config));
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

    // Validate name if provided
    if (name !== undefined) {
      const trimmed = name.trim();
      if (!trimmed || trimmed.length > 64) {
        res.status(400).json({ error: "Name must be 1-64 characters" });
        return;
      }
    }

    // Validate config if provided
    if (stackConfig !== undefined) {
      const parsed = StackConfigSchema.safeParse(stackConfig);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues.map(i => i.message).join(", ") });
        return;
      }
    }

    // Validate slug format if slug is being changed
    if (slug !== undefined && slug !== stack.slug) {
      // Block slug rename for the default stack — startup uses the literal
      // "default" slug to identify it; renaming would orphan the stack and
      // a fresh "Default" would be created on next boot.
      if (stack.slug === DEFAULT_STACK_SLUG) {
        res.status(403).json({ error: "Cannot change the slug of the default stack" });
        return;
      }
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
      name: name !== undefined ? name.trim() : undefined,
      slug,
      config: stackConfig !== undefined ? JSON.stringify(stackConfig) : undefined,
    });
    // listStacks() reads name/slug from the DB row, so the rename is visible
    // immediately. The in-memory StackContext.name is unused for read paths.
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
    const providerRegistry = req.stackContext.providerRegistry;
    const dashProvider = providerRegistry.getAll().find(
      (p: { config: { roles: string[]; webUrl?: string } }) => p.config.roles.includes("dashboards") && p.config.webUrl,
    );
    // Fallback: if no dashboards provider has a webUrl, use the metrics provider's
    // webUrl so the Service Detail "Open in Grafana" button is still wired up.
    // Common setup: a single Grafana provider with both "metrics" and "dashboards" roles,
    // but plenty of users only tag "metrics".
    const metricsProvider = providerRegistry.getAll().find(
      (p: { config: { roles: string[]; webUrl?: string } }) => p.config.roles.includes("metrics") && p.config.webUrl,
    );
    const anyMetricsProvider = providerRegistry.getAll().find(
      (p: { config: { roles: string[] } }) => p.config.roles.includes("metrics"),
    );
    res.json({
      ...base,
      grafanaUrl: dashProvider?.config.webUrl ?? metricsProvider?.config.webUrl,
      prometheusDatasource: anyMetricsProvider?.prometheusDatasourceUid,
    });
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

  app.get("/api/events/recent", (req: Request, res: Response) => {
    const limitParam = Number(req.query.limit);
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 50;
    // Filter events to the active stack (plus global events like process-wide probes).
    // req.stackId is populated by the stack middleware; empty string means unresolved.
    const stackId = req.stackId && req.stackId !== "" ? req.stackId : undefined;
    res.json(eventLog.recent(limit, stackId));
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
    // Treat null and "" as "clear the alias" rather than storing an empty
    // string sentinel. Previously null→"" round-tripped, so a GET after a
    // clear returned alias:"" instead of alias:null, confusing client logic.
    if (alias === null || alias === undefined || alias === "") {
      db.clearServiceAlias(req.stackId, name);
    } else {
      db.upsertServiceMetadata(req.stackId, name, { alias });
    }
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
    app.get("/api/skills", (req: Request, res: Response) => {
      const disabledIds = db.getDisabledSkills(req.stackId!);
      res.json(skillStore.getAll().map(s => ({ ...s, enabled: !disabledIds.has(s.id) })));
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
        const parsed = SkillInputSchema.safeParse(req.body);
        if (!parsed.success) {
          const errors = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
          res.status(400).json({ error: "Invalid skill input", details: errors });
          return;
        }
        const { title, services: svcs, alerts, tags, scope, body } = parsed.data;
        const skill = await skillStore.save(undefined, { title, services: svcs ?? [], alerts: alerts ?? [], tags: tags ?? [], scope }, body ?? "");
        res.status(201).json(skill);
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : "Failed to create skill" });
      }
    });

    app.put("/api/skills/:id", async (req: Request, res: Response) => {
      try {
        const id = Array.isArray(req.params["id"]) ? req.params["id"][0]! : req.params["id"]!;
        const parsed = SkillInputSchema.safeParse(req.body);
        if (!parsed.success) {
          const errors = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
          res.status(400).json({ error: "Invalid skill input", details: errors });
          return;
        }
        const { title, services: svcs, alerts, tags, scope, body } = parsed.data;
        const skill = await skillStore.save(id, { title, services: svcs ?? [], alerts: alerts ?? [], tags: tags ?? [], scope }, body ?? "");
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

    app.put("/api/skills/:id/enabled", (req: Request, res: Response) => {
      const id = Array.isArray(req.params["id"]) ? req.params["id"][0]! : req.params["id"]!;
      const skill = skillStore.getById(id);
      if (!skill) {
        res.status(404).json({ error: "Skill not found" });
        return;
      }
      const { enabled } = req.body as { enabled?: boolean };
      if (typeof enabled !== "boolean") {
        res.status(400).json({ error: "Body must include { enabled: boolean }" });
        return;
      }
      if (enabled) {
        db.enableSkill(req.stackId!, id);
      } else {
        db.disableSkill(req.stackId!, id);
      }
      res.json({ id, enabled });
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

        // Reject genuinely empty bodies — previously this handler happily
        // returned `{title:"Generated Skill", services:[], body:""}` for any
        // input, which masked upstream bugs (the caller sending nothing) and
        // wasted a round-trip in the UI. A real report has at minimum one
        // content field; otherwise there's nothing to templatize.
        const hasContent =
          (typeof report.service === "string" && report.service.trim() !== "") ||
          (typeof report.summary === "string" && report.summary.trim() !== "") ||
          (typeof report.rootCause === "string" && report.rootCause.trim() !== "") ||
          (typeof report.trigger === "string" && report.trigger.trim() !== "") ||
          (Array.isArray(report.recommendedActions) && report.recommendedActions.length > 0) ||
          (Array.isArray(report.contributingFactors) && report.contributingFactors.length > 0);
        if (!hasContent) {
          res.status(400).json({ error: "At least one of service, summary, rootCause, trigger, recommendedActions, or contributingFactors is required" });
          return;
        }

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
      webUrl: p.config.webUrl,
      source: p.source,
      status: p.status,
      toolCount: p.toolCount,
      enabledToolCount: p.enabledToolCount,
      error: p.error,
    })));
  });

  // GET /api/providers/export — return raw ProviderConfig[] for YAML export
  app.get("/api/providers/export", (req: Request, res: Response) => {
    const providerRegistry = req.stackContext.providerRegistry;
    const providers = providerRegistry.getAll();
    res.json(providers.map(exportProviderConfig));
  });

  // POST /api/providers/import — dry-run validation
  app.post("/api/providers/import", (req: Request, res: Response) => {
    const providerRegistry = req.stackContext.providerRegistry;
    const { providers } = req.body as { providers?: unknown[] };
    if (!Array.isArray(providers)) {
      res.status(400).json({ error: "providers must be an array" });
      return;
    }
    if (providers.length > 50) {
      res.status(400).json({ error: "Maximum 50 providers per import" });
      return;
    }
    const existing = new Map<string, "config" | "gui">();
    for (const info of providerRegistry.getAll()) {
      existing.set(info.config.name, info.source);
    }
    const results = validateImportProviders(providers, existing);
    res.json({ results });
  });

  // POST /api/providers/import/confirm — execute the import
  app.post("/api/providers/import/confirm", async (req: Request, res: Response) => {
    try {
      const providerRegistry = req.stackContext.providerRegistry;
      const { providers, overwrite = [] } = req.body as { providers?: unknown[]; overwrite?: string[] };
      if (!Array.isArray(providers)) {
        res.status(400).json({ error: "providers must be an array" });
        return;
      }
      if (providers.length > 50) {
        res.status(400).json({ error: "Maximum 50 providers per import" });
        return;
      }
      const existing = new Map<string, "config" | "gui">();
      for (const info of providerRegistry.getAll()) {
        existing.set(info.config.name, info.source);
      }
      const actions = categorizeImportActions(providers, overwrite, existing);
      const actionByName = new Map(actions.map(a => [a.config.name, a]));
      const results: Array<{ name: string; status: string; toolCount?: number; error?: string }> = [];

      // Iterate in input order to preserve the user's sequence
      for (const raw of providers) {
        const parsed = ProviderSchema.safeParse(raw);
        if (!parsed.success) {
          const name = (raw && typeof raw === "object" && "name" in raw && typeof (raw as any).name === "string")
            ? (raw as any).name : "(unnamed)";
          results.push({ name, status: "skipped", error: "Invalid provider config" });
          continue;
        }

        const entry = actionByName.get(parsed.data.name);
        if (!entry || entry.action === "skip") {
          results.push({ name: parsed.data.name, status: "skipped", error: entry?.reason });
          continue;
        }

        try {
          let info;
          if (entry.action === "overwrite") {
            info = await providerRegistry.update(entry.config.name, entry.config);
            results.push({ name: entry.config.name, status: "overwritten", toolCount: info.toolCount });
          } else {
            info = await providerRegistry.add(entry.config);
            results.push({ name: entry.config.name, status: "added", toolCount: info.toolCount });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push({ name: entry.config.name, status: "failed", error: msg });
        }
      }
      // Invalidate cached agents if anything was added or overwritten.
      if (results.some(r => r.status === "added" || r.status === "overwritten")) {
        clearStackCaches(req.stackId);
      }
      res.json({ results });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
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
      // Invalidate cached agents so the next WS request sees the new provider.
      clearStackCaches(req.stackId);
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
      // Invalidate cached agents — config changes may affect tool availability.
      clearStackCaches(req.stackId);
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
      // Invalidate cached agents so the next WS request stops using the removed provider.
      clearStackCaches(req.stackId);
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
      const provider = createMcpProvider(parsed.data, config.timeouts?.mcpConnectMs);
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
      // Invalidate cached agents so the next WS request respects the updated tool set.
      clearStackCaches(req.stackId);
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

  // ── Notifications REST API ──────────────────────────────────────────

  app.get("/api/notifications", (_req: Request, res: Response) => {
    const slackUrl = db.getSetting("notifications.slack.webhookUrl");
    const slackEnabled = db.getSetting("notifications.slack.enabled");
    // Fall back to config.yaml if no GUI override
    const effectiveUrl = slackUrl ?? config.webhook.slackWebhookUrl ?? null;
    const effectiveEnabled = slackEnabled !== undefined ? slackEnabled === "true" : !!effectiveUrl;
    res.json({
      slack: {
        webhookUrl: effectiveUrl,
        enabled: effectiveEnabled,
        source: slackUrl ? "gui" : (config.webhook.slackWebhookUrl ? "config" : "none"),
      },
    });
  });

  app.put("/api/notifications", (req: Request, res: Response) => {
    const { slack } = req.body as { slack?: { webhookUrl?: string | null; enabled?: boolean } };
    if (!slack) {
      res.status(400).json({ error: "Missing slack configuration" });
      return;
    }
    if (slack.webhookUrl !== undefined) {
      if (slack.webhookUrl === null || slack.webhookUrl === "") {
        db.deleteSetting("notifications.slack.webhookUrl");
        db.deleteSetting("notifications.slack.enabled");
      } else {
        try {
          const parsed = new URL(slack.webhookUrl);
          if (parsed.protocol !== "https:") {
            res.status(400).json({ error: "Webhook URL must use HTTPS" });
            return;
          }
        } catch {
          res.status(400).json({ error: "Invalid webhook URL" });
          return;
        }
        db.setSetting("notifications.slack.webhookUrl", slack.webhookUrl);
      }
    }
    if (slack.enabled !== undefined) {
      db.setSetting("notifications.slack.enabled", String(slack.enabled));
    }
    res.json({ ok: true });
  });

  app.post("/api/notifications/test", async (req: Request, res: Response) => {
    const { webhookUrl: bodyUrl } = req.body as { webhookUrl?: string } ?? {};
    const slackUrl = bodyUrl || db.getSetting("notifications.slack.webhookUrl") || config.webhook.slackWebhookUrl;
    if (!slackUrl) {
      res.status(400).json({ error: "No Slack webhook URL configured" });
      return;
    }
    try {
      const { notifySlack } = await import("./slack-notifier.js");
      await notifySlack(
        { slackWebhookUrl: slackUrl },
        "test_notification",
        "Test Service",
        {
          service: "Test Service",
          severity: "low",
          summary: "This is a test notification from dops-assistant.",
          rootCause: "Test notification — no actual incident.",
          confidenceScore: 1.0,
          confidence: "high",
          investigatedAt: new Date().toISOString(),
          impact: { duration: "N/A", description: "No impact — test only" },
          trigger: "Manual test from Settings → Notifications",
          contributingFactors: [],
          timeline: [],
          evidence: { metrics: [], logs: [], infra: [] },
          dashboardLinks: [],
          recommendedActions: ["No action required — this was a test."],
        },
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Failed to send test notification" });
    }
  });

  // ── Email notifications ─────────────────────────────────────────────────

  const ALL_SOURCES_SET = new Set(["webhook", "scan", "poller", "manual"]);
  const ALL_SEVERITIES_SET = new Set(["low", "medium", "high", "critical"]);
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function validateRecipientBody(body: any, { partial }: { partial: boolean }): string | null {
    if (!body || typeof body !== "object") return "Body must be an object";
    if (!partial || body.address !== undefined) {
      if (typeof body.address !== "string" || !EMAIL_RE.test(body.address)) return "Invalid email address";
    }
    if (!partial || body.minSeverity !== undefined) {
      if (!ALL_SEVERITIES_SET.has(body.minSeverity)) return "Invalid minSeverity";
    }
    if (!partial || body.allowedSources !== undefined) {
      if (!Array.isArray(body.allowedSources) || body.allowedSources.length === 0) return "allowedSources must be a non-empty array";
      for (const s of body.allowedSources) {
        if (!ALL_SOURCES_SET.has(s)) return `Invalid source: ${s}`;
      }
    }
    if (!partial || body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") return "enabled must be boolean";
    }
    if (body.label !== undefined && body.label !== null && typeof body.label !== "string") return "label must be string or null";
    return null;
  }

  app.get("/api/notifications/email", (_req: Request, res: Response) => {
    const dbEnabled = db.getSetting("notifications.email.enabled");
    const emailCfg = config.notifications?.email;
    const enabled = dbEnabled !== undefined ? dbEnabled === "true" : emailCfg?.enabled ?? false;
    const recipients = db.listEmailRecipients();
    res.json({ enabled, recipients });
  });

  app.put("/api/notifications/email", (req: Request, res: Response) => {
    const { enabled } = (req.body ?? {}) as { enabled?: boolean };
    if (typeof enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be boolean" });
      return;
    }
    db.setSetting("notifications.email.enabled", String(enabled));
    res.json({ ok: true, enabled });
  });

  app.get("/api/notifications/email/recipients", (_req: Request, res: Response) => {
    res.json(db.listEmailRecipients());
  });

  app.post("/api/notifications/email/recipients", (req: Request, res: Response) => {
    const err = validateRecipientBody(req.body, { partial: false });
    if (err) { res.status(400).json({ error: err }); return; }
    const body = req.body as {
      address: string; label?: string; minSeverity: import("../types/notifications.js").SeverityLevel;
      allowedSources: import("../types/notifications.js").NotificationSource[]; enabled: boolean;
    };
    const created = db.createEmailRecipient({
      address: body.address,
      label: body.label,
      minSeverity: body.minSeverity,
      allowedSources: body.allowedSources,
      enabled: body.enabled,
    });
    res.status(201).json(created);
  });

  app.put("/api/notifications/email/recipients/:id", (req: Request, res: Response) => {
    const id = Number(req.params["id"]);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid id" }); return; }
    const err = validateRecipientBody(req.body, { partial: true });
    if (err) { res.status(400).json({ error: err }); return; }
    const existing = db.getEmailRecipient(id);
    if (!existing) { res.status(404).json({ error: "Recipient not found" }); return; }
    const updated = db.updateEmailRecipient(id, req.body);
    res.json(updated);
  });

  app.delete("/api/notifications/email/recipients/:id", (req: Request, res: Response) => {
    const id = Number(req.params["id"]);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid id" }); return; }
    db.deleteEmailRecipient(id);
    res.status(204).end();
  });

  app.post("/api/notifications/email/test", async (req: Request, res: Response) => {
    const { recipientId } = (req.body ?? {}) as { recipientId?: number };
    if (typeof recipientId !== "number" || !Number.isInteger(recipientId) || recipientId <= 0) {
      res.status(400).json({ error: "recipientId must be a positive integer" });
      return;
    }

    // (a) Require the global email-enabled flag before allowing any send.
    // Prevents the endpoint from being used as an open SMTP relay by anyone
    // with access to the /api surface while email is nominally off.
    const emailCfg = config.notifications?.email;
    const dbEnabled = db.getSetting("notifications.email.enabled");
    const globalEnabled = dbEnabled !== undefined ? dbEnabled === "true" : emailCfg?.enabled ?? false;
    if (!globalEnabled) {
      res.status(403).json({ error: "Email notifications are disabled. Enable the global toggle first." });
      return;
    }

    // (c) Require real SMTP config so we never fake success via jsonTransport.
    // A user clicking "Test" expects a real round-trip; if SMTP isn't wired up,
    // that's a 400 they can act on — not a green checkmark.
    if (!emailCfg) {
      res.status(400).json({ error: "SMTP is not configured. Set notifications.email in config.yaml." });
      return;
    }

    const recipient = db.getEmailRecipient(recipientId);
    if (!recipient) { res.status(404).json({ error: "Recipient not found" }); return; }

    const realTransport = nodemailer.createTransport({
      host: emailCfg.smtp.host,
      port: emailCfg.smtp.port,
      secure: emailCfg.smtp.secure,
      auth: { user: emailCfg.smtp.user, pass: emailCfg.smtp.pass },
    });

    // (b) Use the recipient's own minSeverity as the fixture severity so the
    // filter in notifyEmail always matches. Otherwise a hard-coded "high"
    // fixture silently skips critical-only recipients — test button would lie.
    const fixture: RcaReport = {
      service: "test-service",
      severity: recipient.minSeverity,
      summary: "This is a test notification from DOps Assistant",
      impact: { duration: "0s", description: "No production impact — this is a test." },
      trigger: "Manual test from Notifications settings",
      rootCause: "N/A (test notification)",
      contributingFactors: ["Config validation in progress"],
      timeline: [{ time: new Date().toISOString().slice(11, 16), event: "Test email triggered" }],
      evidence: { metrics: ["cpu=12%"], logs: [], infra: [] },
      dashboardLinks: [],
      recommendedActions: ["Confirm you received this email in your inbox or Teams channel"],
      confidence: "high",
      confidenceScore: 1,
      investigatedAt: new Date().toISOString(),
    };

    // (d) Capture SMTP errors from the wrapped transport so we can surface
    // them to the caller. `notifyEmail` swallows send failures by design,
    // so the test endpoint has to watch the transport directly.
    const captured: unknown[] = [];
    let sendError: unknown = null;
    const wrappedTransport = {
      sendMail: async (envelope: unknown) => {
        captured.push(envelope);
        try {
          return await realTransport.sendMail(envelope as any);
        } catch (err) {
          sendError = err;
          throw err;
        }
      },
    } as unknown as ReturnType<typeof nodemailer.createTransport>;

    await notifyEmail(
      {
        isGloballyEnabled: () => true,
        listEnabledRecipients: () => [recipient],
        transport: wrappedTransport,
        config: {
          from: emailCfg.from,
          appBaseUrl: emailCfg.appBaseUrl,
          retry: { attempts: 1, backoffMs: [] },
        },
      },
      `test_${Date.now()}`,
      fixture,
      recipient.allowedSources[0] ?? "manual",
    );

    if (sendError) {
      const msg = sendError instanceof Error ? sendError.message : String(sendError);
      res.status(500).json({ error: `SMTP send failed: ${msg}` });
      return;
    }

    res.json({ ok: true, envelope: captured[0] ?? null });
  });
}
