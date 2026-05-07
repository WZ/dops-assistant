import type { Express, Request, Response } from "express";
import { createLogger } from "../logger.js";
import type { Database } from "./db.js";
import type { ServiceConfig, Config, ProviderConfig } from "../config/schema.js";
import { MAX_CACHE_ENTRIES } from "../constants.js";
import { ProviderSchema, StackConfigSchema, PeriodicDiscoverySchema, ServiceConfigSchema } from "../config/schema.js";
import { DEFAULT_STACK_SLUG } from "../types/stack-types.js";
import { createMcpProvider, listProviderTools } from "../mcp/provider.js";
import { clearStackCaches } from "./ws-handler.js";
import type { SkillStore } from "../skills/store.js";
import type { ProviderInfo } from "../mcp/provider-registry.js";
import type { StackManager } from "./stack-manager.js";
import type { InvestigationDedup } from "./investigation-dedup.js";
import { maskToken, SERVICE_LABEL_KEYS } from "./webhook-handler.js";
import { queryServiceMetrics } from "./prometheus-query.js";
import type { MetricSeries } from "./prometheus-query.js";
import { inferDependencyGraph } from "./dependency-graph.js";
import { buildServiceBrief } from "./service-brief.js";
import { isDemoMode } from "./demo-mode.js";
import type { LanguageModel } from "ai";
import { eventLog } from "./event-log.js";
import { SkillInputSchema } from "./sanitize.js";
import { Cron } from "croner";
import { z } from "zod";
import { getScanSettingsView, SCAN_SETTING_KEYS } from "./scan-settings.js";
import { getK8sEventsSettingsView, K8S_EVENTS_SETTING_KEYS } from "./k8s-events-settings.js";
import { validateRules } from "./scan-rule-validator.js";
import { validateOverride, parseOverride } from "./scan-service-override.js";
import { getToolsByRole } from "../mcp/provider.js";
import { parsePrometheusResult } from "./service-health-poller.js";
import nodemailer from "nodemailer";
import type { RcaReport } from "../types/rca-types.js";
import { notifyEmail } from "./email-notifier.js";
import { parseInvestigationFilters } from "./investigation-filters.js";
import { sendSlackScanRunPost } from "./slack-notifier.js";
import { ALL_SOURCES } from "../types/notifications.js";
import { buildPatternCluster } from "./pattern-similarity.js";

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
  // Probe rules: either an array (validated via validateRules before write),
  // null (clear override, revert to config.yaml), or absent (leave untouched).
  // We don't shape-validate here — validateRules does that with richer errors.
  rules: z.union([z.array(z.unknown()), z.null()]).optional(),
  // K8sEventPoller settings — sibling auto-investigator. Only `enabled` is
  // GUI-editable in v1; every other knob (intervalSeconds, badReasons, etc.)
  // stays config.yaml-only. `null` clears the override and reverts to
  // config.yaml; absent leaves the existing override untouched.
  k8sEvents: z.object({
    enabled: z.union([z.boolean(), z.null()]).optional(),
  }).strict().optional(),
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

/**
 * Extract a one-line summary from an investigation.report JSON blob. Returns
 * null if the column is non-JSON or has no string `.summary` field. Used by
 * GET /api/scan/runs/:id to decorate linked investigations without forcing
 * the caller to parse RCA reports on the client.
 */
function extractReportSummary(reportJson: string): string | null {
  try {
    const parsed = JSON.parse(reportJson) as { summary?: string };
    return typeof parsed.summary === "string" ? parsed.summary : null;
  } catch {
    return null;
  }
}

/**
 * Parse a comma-separated query-string value into a typed enum array,
 * dropping unknown tokens. Returns `[]` for missing/empty input so callers
 * can use the array length directly as "any filter set?". Used by the scan
 * runs list endpoint for status/trigger/outcome multi-select filters.
 */
function parseEnumCsv<T extends string>(raw: string | undefined, allowed: readonly T[]): T[] {
  if (!raw) return [];
  const valid = new Set<string>(allowed);
  const out: T[] = [];
  for (const tok of raw.split(",")) {
    const t = tok.trim();
    if (valid.has(t)) out.push(t as T);
  }
  return out;
}

/**
 * Parse an ISO 8601 timestamp into epoch ms. Returns `undefined` when the
 * string is missing or doesn't parse — callers treat that as "no filter".
 * Tolerant by design: URL state is soft input from bookmarks and pasted
 * links, so we drop garbage instead of 400-ing the request.
 */
function parseIsoToEpochMs(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : undefined;
}

/**
 * Loose CSV parser — keeps any non-empty trimmed token. Used for filters
 * whose enum is open-ended (event `kind`), where new values can show up
 * without a server config change. Each token still gets sanitized: trimmed,
 * empty rejected, single-line only (drop CR/LF/null).
 */
function parseEnumCsvLoose(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const tok of raw.split(",")) {
    const t = tok.trim();
    if (t && !/[\r\n\0]/.test(t)) out.push(t);
  }
  return out;
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
    res.json({
      ...getScanSettingsView(db, config),
      // Sibling auto-investigator settings — folded into the same endpoint
      // because operators think of them as the same thing ("automated
      // investigation toggles"). Each stack's K8sEventPoller has a live
      // `degradedReason` that tells the UI whether the toggle will actually
      // do anything (e.g. "infrastructure-not-kubernetes" means no k8s MCP
      // is wired so flipping enabled has no effect on that stack).
      k8sEvents: {
        ...getK8sEventsSettingsView(db, config),
        stacks: stackManager.getK8sEventPollerStatuses(),
      },
    });
  });

  /**
   * GET /api/scan/activity — aggregate for the Dashboard badge.
   *
   * Combines the scheduler's status snapshot with a SQL count of scan-triggered
   * investigations in the last N hours (default 24, override with `?window=`
   * where value is e.g. "1h", "6h", "24h", "7d"). Separate from /api/scan/status
   * so the Dashboard can poll a single endpoint and not pay a DB query cost on
   * every operator hitting the Scan tab.
   *
   * Response shape is deliberately flat and UI-friendly — the badge component
   * shouldn't need client-side computation over multiple fetches.
   */
  const ACTIVITY_WINDOW_HOURS: Record<string, number> = {
    "1h": 1, "6h": 6, "24h": 24, "7d": 24 * 7,
  };
  app.get("/api/scan/activity", (req: Request, res: Response) => {
    if (!req.stackContext) {
      res.status(400).json({ error: "No active stack" });
      return;
    }
    const windowParam = String(req.query["window"] ?? "24h");
    const windowHours = ACTIVITY_WINDOW_HOURS[windowParam];
    if (windowHours === undefined) {
      res.status(400).json({
        error: `Invalid window: ${windowParam}`,
        hint: `Accepted: ${Object.keys(ACTIVITY_WINDOW_HOURS).join(", ")}`,
      });
      return;
    }
    const sinceIso = new Date(Date.now() - windowHours * 3600_000).toISOString();
    const status = req.stackContext.scanScheduler.getStatus();
    const recentAnomalies = db.countScanTriggeredInvestigationsSince(req.stackId ?? "", sinceIso);
    res.json({
      enabled: status.enabled,
      ticking: status.ticking,
      lastRun: status.lastRun,
      nextRun: status.nextRun,
      lastError: status.lastError,
      dropsByConcurrency: status.dropsByConcurrency,
      windowHours,
      recentAnomalies,
    });
  });

  /**
   * POST /api/scan/trigger — fire one probe pass immediately, bypassing the
   * cron schedule. Used by the "Scan now" button and by operators who want
   * to smoke-test probe rules after an edit without waiting up to 4 hours.
   *
   * Response contract:
   *  - 202 Accepted — probe dispatched; client should poll /api/scan/status
   *    to see `ticking` clear and `lastRun` update. We don't wait for the
   *    tick to complete because ticks can take 10+ seconds on real MCPs.
   *  - 400 Bad Request — scan is disabled. "Enable first" is the right UX;
   *    manual trigger on a disabled scheduler is not a sanctioned dry-run
   *    path (would need new invariants in the scheduler we don't have).
   *  - 409 Conflict — a tick is already in flight. Matches the scheduler's
   *    own "skipping tick — previous still running" guard; prevents stacking
   *    manual triggers while one is mid-flight.
   */
  app.post("/api/scan/trigger", (req: Request, res: Response) => {
    if (!req.stackContext) {
      res.status(400).json({ error: "No active stack" });
      return;
    }
    const scheduler = req.stackContext.scanScheduler;
    const status = scheduler.getStatus();
    if (!status.enabled) {
      res.status(400).json({
        error: "Scan is disabled",
        hint: "Enable in Settings \u2192 Scan first.",
      });
      return;
    }
    if (status.ticking) {
      res.status(409).json({
        error: "A scan tick is already in flight",
        hint: "Wait for it to complete; check /api/scan/status.",
      });
      return;
    }
    eventLog.append({
      kind: "scan_triggered_manually",
      severity: "info",
      summary: `manual scan trigger \u00b7 stack=${req.stackId ?? "(default)"}`,
      stackId: req.stackId,
    });
    // Fire-and-forget — don't await. The tick runs asynchronously and the
    // UI polls /api/scan/status to observe state transitions.
    //
    // `scheduler.triggerNow()` is async but executes synchronously through
    // `scanRunStore.begin(...)` before its first `await runProbe(...)`, so
    // `getLastRunId()` on the next line reliably returns the new run's id.
    // Clients use this to navigate to /scan/runs/:runId for live progress.
    void scheduler.triggerNow("manual");
    res.status(202).json({
      message: "Probe pass dispatched",
      status: scheduler.getStatus(),
      runId: scheduler.getLastRunId(),
    });
  });

  /**
   * GET /api/scan/runs — list scan runs for the resolved stack, newest first.
   *
   * Query params:
   *  - `limit` — max rows. Default 50. Hard-capped at 200.
   *  - `offset` — page offset, 0-indexed. Default 0. Mutually exclusive
   *    with `before`; offset wins if both arrive.
   *  - `before` — legacy epoch-ms cursor used by the Ops Desk Recent Scans
   *    widget. Newer callers should prefer `offset`.
   *  - `status` — comma-separated subset of `running|complete|failed|skipped`.
   *  - `trigger` — comma-separated subset of `manual|cron`.
   *  - `outcome` — comma-separated subset of `clean|tripped|dispatched`,
   *    derived from hits counts (see db.listScanRuns docstring).
   *  - `since`, `until` — ISO 8601 timestamps, applied to started_at.
   *    Invalid timestamps are ignored.
   *  - `sort` — `started_at` (default, desc) or `duration` (probe_duration_ms desc).
   *
   * Response shape: `{ runs, total, hasMore }`. Legacy callers that read
   * `data.runs` and ignored extras still work — `total` and `hasMore` are
   * additive fields.
   *
   * Stack isolation is enforced by the /api middleware populating
   * req.stackId; db.listScanRuns filters by stack_id server-side.
   */
  app.get("/api/scan/runs", (req: Request, res: Response) => {
    const rawLimit = parseInt((req.query["limit"] as string) || "50", 10);
    const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 50, 200);
    const rawOffset = parseInt((req.query["offset"] as string) || "0", 10);
    const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
    const beforeRaw = req.query["before"] as string | undefined;
    const beforeParsed = beforeRaw !== undefined ? parseInt(beforeRaw, 10) : undefined;
    const before = Number.isFinite(beforeParsed as number) ? beforeParsed : undefined;

    const status = parseEnumCsv(req.query["status"] as string | undefined,
      ["running", "complete", "failed", "skipped"] as const);
    const trigger = parseEnumCsv(req.query["trigger"] as string | undefined,
      ["manual", "cron"] as const);
    const outcome = parseEnumCsv(req.query["outcome"] as string | undefined,
      ["clean", "tripped", "dispatched"] as const);

    const since = parseIsoToEpochMs(req.query["since"] as string | undefined);
    const until = parseIsoToEpochMs(req.query["until"] as string | undefined);

    const sortRaw = (req.query["sort"] as string | undefined) ?? "started_at";
    const sort: "started_at" | "duration" = sortRaw === "duration" ? "duration" : "started_at";

    // `before` and `offset` are alternative paginators. Offset wins if both
    // came in — that's the new canonical surface; `before` stays for the
    // existing Ops Desk widget which calls with `?limit=5` and no offset.
    const filterOpts = {
      stackId: req.stackId,
      ...(before !== undefined && offset === 0 ? { before } : {}),
      ...(status.length ? { status } : {}),
      ...(trigger.length ? { trigger } : {}),
      ...(outcome.length ? { outcome } : {}),
      ...(since !== undefined ? { since } : {}),
      ...(until !== undefined ? { until } : {}),
    };

    const runs = db.listScanRuns({ ...filterOpts, limit, offset, sort });
    const total = db.countScanRuns(filterOpts);
    const hasMore = offset + runs.length < total;
    res.json({ runs, total, hasMore });
  });

  /**
   * GET /api/scan/runs/:id — detail view for a single scan_run.
   *
   * Returns the run plus all linked investigations, each enriched with the
   * investigation's current `status` and a one-line `reportSummary`
   * (extracted from `report.summary` when the JSON is parseable). The
   * snapshot metadata stored on `scan_run_investigations` (service,
   * ruleName, value, severity, dispatchedAt) is preserved alongside the
   * live fields so the UI can show "what fired" even if the investigation
   * row has been GC'd or is still running.
   *
   * Cross-stack hint: if the run ID exists but belongs to another stack,
   * returns 404 with `{ expectedStackId }` so the web UI can offer a
   * "switch to that stack" banner instead of a dead end. A truly missing
   * ID returns plain 404 (no hint).
   */
  app.get("/api/scan/runs/:id", (req: Request, res: Response) => {
    const id = req.params["id"] as string;
    const run = db.getScanRun(req.stackId, id);
    if (!run) {
      const anyStack = db.getScanRunAnyStack(id);
      if (anyStack) {
        res.status(404).json({ error: "Wrong stack", expectedStackId: anyStack.stackId });
        return;
      }
      res.status(404).json({ error: "Scan run not found" });
      return;
    }
    const links = db.getScanRunInvestigations(id);
    const investigations = links.map(link => {
      const inv = db.getInvestigation(req.stackId, link.investigationId);
      return {
        ...link,
        status: inv?.status ?? "unknown",
        reportSummary: inv?.report ? extractReportSummary(inv.report) : null,
        completedAt: inv?.completed_at ?? null,
      };
    });
    res.json({ run, investigations });
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

    // Rules: validate BEFORE writing any DB setting. If rules validation
    // fails, abort the whole PUT so the settings stay in a consistent
    // state — no partial updates where cron wrote but rules didn't.
    let validatedRulesJson: string | null | undefined;
    if (body.rules === null) {
      validatedRulesJson = null; // sentinel for "clear override"
    } else if (Array.isArray(body.rules)) {
      const result = validateRules(body.rules);
      if (!result.ok) {
        res.status(400).json({
          error: "Invalid probe rules",
          details: result.errors,
        });
        return;
      }
      validatedRulesJson = JSON.stringify(result.rules);
    }

    // Atomically persist all settings changes. Without the transaction, a
    // crash or late-throw between the four setSetting calls leaves the
    // effective config incoherent (e.g., new cron but old enabled flag).
    // Validation already completed above; by this point every value is
    // safe to write.
    db.transaction(() => {
      if (body.enabled === null) db.deleteSetting("scan.enabled");
      else if (typeof body.enabled === "boolean") db.setSetting("scan.enabled", String(body.enabled));

      if (body.cron === null) db.deleteSetting("scan.cron");
      else if (typeof body.cron === "string") db.setSetting("scan.cron", body.cron);

      if (body.timezone === null) db.deleteSetting("scan.timezone");
      else if (typeof body.timezone === "string") db.setSetting("scan.timezone", body.timezone);

      if (validatedRulesJson === null) db.deleteSetting(SCAN_SETTING_KEYS.probeMetrics);
      else if (typeof validatedRulesJson === "string") db.setSetting(SCAN_SETTING_KEYS.probeMetrics, validatedRulesJson);

      // K8sEventPoller settings (sibling auto-investigator). Only `enabled`
      // is currently GUI-editable.
      if (body.k8sEvents !== undefined) {
        if (body.k8sEvents.enabled === null) db.deleteSetting(K8S_EVENTS_SETTING_KEYS.enabled);
        else if (typeof body.k8sEvents.enabled === "boolean") db.setSetting(K8S_EVENTS_SETTING_KEYS.enabled, String(body.k8sEvents.enabled));
      }
    });

    // Propagate to every running scheduler. Idempotent — reload() no-ops
    // when nothing changed.
    stackManager.reloadAllScanSchedulers();
    if (body.k8sEvents !== undefined) {
      stackManager.reloadAllK8sEventPollers();
    }

    res.json({
      ...getScanSettingsView(db, config),
      k8sEvents: {
        ...getK8sEventsSettingsView(db, config),
        stacks: stackManager.getK8sEventPollerStatuses(),
      },
    });
  });

  /**
   * POST /api/scan/rules/test — dry-run a single probe rule against real
   * Prometheus data via the metrics MCP tool. Lets the operator hit "Test"
   * in the UI before saving a rule and learn whether the query actually
   * returns numeric values at all, and whether the threshold would trip
   * right now.
   *
   * Body: { query, threshold, testService }
   *   - query: PromQL with "{service}" placeholder
   *   - threshold: { op, value } — op in gt|lt|gte|lte
   *   - testService: name from the registry; if omitted, we pick the first
   *     live service and return its name in the response so the UI can show
   *     "(tested against 'payments-api')"
   *
   * Response:
   *   200 { testedService, value, wouldTrip, rawResultCount, durationMs }
   *   400 on bad body, no registered services, or no MCP metrics tool
   */
  const RuleTestSchema = z.object({
    query: z.string().min(1),
    threshold: z.object({
      op: z.enum(["gt", "lt", "gte", "lte"]),
      value: z.number(),
    }),
    testService: z.string().optional(),
  }).strict();

  app.post("/api/scan/rules/test", async (req: Request, res: Response) => {
    if (!req.stackContext) {
      res.status(400).json({ error: "No active stack" });
      return;
    }
    const parsed = RuleTestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
      return;
    }
    const { query, threshold, testService } = parsed.data;
    if (!query.includes("{service}")) {
      res.status(400).json({ error: "Query must include the {service} placeholder" });
      return;
    }

    // Pick test service: operator-specified, else first in the stack registry.
    const services = req.stackContext.serviceRegistry.load();
    let resolvedService = testService;
    if (!resolvedService) {
      resolvedService = services[0]?.name;
      if (!resolvedService) {
        res.status(400).json({
          error: "No services registered",
          hint: "Run discovery first so there's at least one service to test against.",
        });
        return;
      }
    } else if (!services.some((s) => s.name === resolvedService)) {
      res.status(400).json({
        error: `Service "${resolvedService}" not found in registry`,
      });
      return;
    }

    const providers = req.stackContext.providerRegistry.getProviders();
    const datasourceUid = req.stackContext.providerRegistry.getAll().find(
      (p) => p.config.roles.includes("metrics") && p.prometheusDatasourceUid,
    )?.prometheusDatasourceUid;
    if (!datasourceUid) {
      res.status(400).json({ error: "No Prometheus datasource available on this stack" });
      return;
    }

    let tools: Record<string, unknown>;
    try {
      tools = (await getToolsByRole(providers, "metrics")) as Record<string, unknown>;
    } catch (err) {
      res.status(500).json({ error: `MCP error: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    const queryToolEntry = Object.entries(tools).find(
      ([name]) => name.endsWith("query_prometheus") || name.endsWith("get_metrics"),
    ) ?? Object.entries(tools).find(([name]) => {
      const lower = name.toLowerCase();
      return (lower.includes("query") || lower.includes("metric")) &&
        !lower.includes("loki") && !lower.includes("log") && !lower.includes("metadata");
    });
    if (!queryToolEntry) {
      res.status(400).json({ error: "No metric query tool available from MCP" });
      return;
    }
    const tool = queryToolEntry[1] as { execute: (args: unknown, ctx?: { abortSignal?: AbortSignal }) => Promise<unknown> };

    const safeService = resolvedService.replace(/[^a-zA-Z0-9_.\-]/g, "");
    const substituted = query.replaceAll("{service}", safeService);
    const now = new Date();
    const args = {
      expr: substituted,
      queryType: "instant",
      startTime: new Date(now.getTime() - 5 * 60 * 1000).toISOString(),
      endTime: now.toISOString(),
      datasourceUid,
    };

    const timeoutMs = 5_000;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const startedMs = Date.now();
    try {
      const raw = await tool.execute(args, { abortSignal: ac.signal });
      const entries = parsePrometheusResult(raw);
      const durationMs = Date.now() - startedMs;
      let value: number | null = null;
      if (entries.length > 0) {
        const first = entries[0]!;
        if (first.value && first.value.length >= 2) {
          const parsedVal = parseFloat(String(first.value[1]));
          value = Number.isFinite(parsedVal) ? parsedVal : null;
        }
      }
      const wouldTrip = value !== null && (() => {
        switch (threshold.op) {
          case "gt":  return value >  threshold.value;
          case "gte": return value >= threshold.value;
          case "lt":  return value <  threshold.value;
          case "lte": return value <= threshold.value;
        }
      })();
      res.json({
        testedService: resolvedService,
        query: substituted,
        value,
        wouldTrip,
        rawResultCount: entries.length,
        durationMs,
      });
    } catch (err) {
      res.status(502).json({
        error: `Query failed: ${err instanceof Error ? err.message : String(err)}`,
        testedService: resolvedService,
        query: substituted,
        durationMs: Date.now() - startedMs,
      });
    } finally {
      clearTimeout(timer);
    }
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
    const parsed = parseInvestigationFilters(req.query);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const rows = db.listInvestigations(req.stackId, parsed.filters);
    const total = db.countInvestigations(req.stackId, parsed.filters);
    const offset = parsed.filters.offset ?? 0;
    const services = db.listInvestigationServices(req.stackId);
    res.json({ rows, total, hasMore: offset + rows.length < total, services });
  });

  // Severity histogram for the /investigations breakdown strip. Re-uses the
  // same filter parser so the client can pass its current query verbatim and
  // get counts that match. The handler strips `severity` itself at the DB
  // layer (see countInvestigationsBySeverity) so clicking a pill never
  // self-filters the histogram.
  app.get("/api/investigations/severity-counts", (req: Request, res: Response) => {
    const parsed = parseInvestigationFilters(req.query);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    res.json(db.countInvestigationsBySeverity(req.stackId, parsed.filters));
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

  // Stack-agnostic lookup. Resolves an investigation id (ULID, globally
  // unique) to the stack that owns it. Used by the SPA when a legacy
  // /investigations/:id deep link is opened in a clean browser session: the
  // URL omits the stack, so the frontend hits this endpoint, switches to the
  // returned stack, and replaceState's the URL to the canonical
  // /stacks/:stackId/investigations/:id form.
  //
  // Auth posture: this endpoint is symmetric with /api/investigations/:id —
  // both bypass auth on GETs (see auth-middleware.ts:30-34, intentional
  // VPN-trust posture for the staging deploy). When `apiKey` is configured
  // and reads get gated in the future, locate MUST gate the same way as the
  // per-stack endpoint, otherwise it becomes a soft cross-stack enumeration
  // vector for an attacker with leaked ULIDs (one round-trip vs brute-forcing
  // X-Stack-Id per stack). Keep them as siblings — if you add auth to one,
  // add it to the other.
  app.get("/api/investigations/:id/locate", (req: Request, res: Response) => {
    const id = req.params["id"];
    const idStr = Array.isArray(id) ? id[0]! : id!;
    const stackId = db.findInvestigationStack(idStr);
    if (!stackId) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ stackId });
  });

  app.get("/api/events/recent", (req: Request, res: Response) => {
    const limitParam = Number(req.query.limit);
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 50;
    // Filter events to the active stack (plus global events like process-wide probes).
    // req.stackId is populated by the stack middleware; empty string means unresolved.
    const stackId = req.stackId && req.stackId !== "" ? req.stackId : undefined;
    res.json(eventLog.recent(limit, stackId));
  });

  /**
   * GET /api/events — list persisted events for the resolved stack with
   * optional filters + pagination. Source of truth for the
   * `/activity/events` tab (the in-memory ring at /api/events/recent stays
   * for the Ops Desk strip, which only needs the latest 25-50).
   *
   * Query params (all optional):
   *  - `kind`     — comma-separated event kinds (multi-select)
   *  - `severity` — comma-separated `info|warn|error|success`
   *  - `service`  — exact match (single)
   *  - `since`    — ISO 8601 timestamp, applied to ts >= since
   *  - `until`    — ISO 8601 timestamp, applied to ts <= until
   *  - `q`        — case-insensitive substring on summary
   *  - `limit`    — default 25, hard cap 200
   *  - `offset`   — default 0
   *
   * Response: `{ rows, total, hasMore, kinds, services }`. `kinds` and
   * `services` are the distinct lists for filter-dropdown population.
   */
  app.get("/api/events", (req: Request, res: Response) => {
    const stackId = req.stackId && req.stackId !== "" ? req.stackId : undefined;

    const kind = parseEnumCsvLoose(req.query["kind"] as string | undefined);
    const severity = parseEnumCsv(req.query["severity"] as string | undefined,
      ["info", "warn", "error", "success"] as const);
    const service = (req.query["service"] as string | undefined)?.trim() || undefined;
    const since = parseIsoToEpochMs(req.query["since"] as string | undefined);
    const until = parseIsoToEpochMs(req.query["until"] as string | undefined);
    const q = (req.query["q"] as string | undefined)?.trim() || undefined;

    const rawLimit = parseInt((req.query["limit"] as string) || "25", 10);
    const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 25, 200);
    const rawOffset = parseInt((req.query["offset"] as string) || "0", 10);
    const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

    const filterOpts = {
      stackId,
      ...(kind.length ? { kind } : {}),
      ...(severity.length ? { severity } : {}),
      ...(service ? { service } : {}),
      ...(since !== undefined ? { since } : {}),
      ...(until !== undefined ? { until } : {}),
      ...(q ? { q } : {}),
    };

    const rows = db.listEvents({ ...filterOpts, limit, offset });
    const total = db.countEvents(filterOpts);
    const hasMore = offset + rows.length < total;
    const kinds = db.listEventKinds(stackId);
    const services = db.listEventServices(stackId);
    res.json({ rows, total, hasMore, kinds, services });
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

  /**
   * Per-service scan override CRUD (Lane B Step 4).
   *
   * GET returns the effective override (null when no override) + per-field
   * source for the UI to show "global" vs "overridden".
   * PUT upserts an override — body must specify `disabled`, `rules`, or both.
   * DELETE clears the override (revert to global rules).
   *
   * All three trigger `reloadAllScanSchedulers` so the change takes effect
   * on the NEXT tick without a server restart. Scheduler's reload clears
   * any stale consecutiveState entries for rules that changed.
   */
  app.get("/api/services/:name/scan-override", (req: Request, res: Response) => {
    const name = req.params["name"] as string;
    if (!NAME_PATTERN.test(name)) { res.status(400).json({ error: "Invalid service name" }); return; }
    const raw = db.getScanOverride(req.stackId, name);
    res.json({ service: name, override: parseOverride(raw) });
  });

  app.put("/api/services/:name/scan-override", (req: Request, res: Response) => {
    const name = req.params["name"] as string;
    if (!NAME_PATTERN.test(name)) { res.status(400).json({ error: "Invalid service name" }); return; }
    const result = validateOverride(req.body);
    if (!result.ok) {
      res.status(400).json({ error: "Invalid override", details: result.errors });
      return;
    }
    db.setScanOverride(req.stackId, name, JSON.stringify(result.override));
    // Reset hysteresis for this service: the rule set may have changed, so
    // any in-flight breach counters from the prior set are now stale.
    stackManager.resetScanHysteresisForService(req.stackId, name);
    res.json({ service: name, override: result.override });
  });

  app.delete("/api/services/:name/scan-override", (req: Request, res: Response) => {
    const name = req.params["name"] as string;
    if (!NAME_PATTERN.test(name)) { res.status(400).json({ error: "Invalid service name" }); return; }
    db.clearScanOverride(req.stackId, name);
    stackManager.resetScanHysteresisForService(req.stackId, name);
    res.json({ service: name, override: null });
  });

  // ── Service Metrics REST API ────────────────────────────────────────────
  app.get("/api/services/:name/metrics", async (req: Request, res: Response) => {
    const name = req.params["name"] as string;
    if (!NAME_PATTERN.test(name)) { res.status(400).json({ error: "Invalid service name" }); return; }
    // Demo mode: providers are stubs, but we still want the page to look real.
    // Synthesize believable random-walk series keyed off the service name.
    if (isDemoMode()) {
      const { buildDemoMetrics } = await import("./demo-fixtures.js");
      const rawRange = (req.query["range"] as string) || "24h";
      const range = VALID_RANGES.has(rawRange) ? rawRange : "24h";
      const metrics = buildDemoMetrics(name, range);
      res.json({ metrics, cached: false, fetchedAt: Date.now(), demoMode: true });
      return;
    }
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
    // Demo mode: providers are stubs and the LLM key is a placeholder.
    // Return a fully-populated mock brief (summary + infra + changes) so the
    // service detail page shows what a live brief looks like end-to-end.
    if (isDemoMode()) {
      const { buildDemoBrief } = await import("./demo-fixtures.js");
      res.json(buildDemoBrief(name));
      return;
    }
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
    const id = Array.isArray(req.params["id"]) ? req.params["id"][0]! : (req.params["id"] as string);
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
    // Demo mode: serve a curated topology so visitors see a real call graph.
    // The seed services don't cross-reference each other in their metric/log
    // labels, so the live inference below would only return the center node.
    if (isDemoMode()) {
      const { buildDemoDependencyGraph } = await import("./demo-fixtures.js");
      const graph = buildDemoDependencyGraph(service);
      res.json({ nodes: graph.nodes, edges: graph.edges });
      return;
    }
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
      const id = Array.isArray(req.params["id"]) ? req.params["id"][0]! : (req.params["id"] as string);
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
        const id = Array.isArray(req.params["id"]) ? req.params["id"][0]! : (req.params["id"] as string);
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
        const id = Array.isArray(req.params["id"]) ? req.params["id"][0]! : (req.params["id"] as string);
        await skillStore.delete(id);
        res.status(204).end();
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : "Failed to delete skill" });
      }
    });

    app.put("/api/skills/:id/enabled", (req: Request, res: Response) => {
      const id = Array.isArray(req.params["id"]) ? req.params["id"][0]! : (req.params["id"] as string);
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
      const id = Array.isArray(req.params["id"]) ? req.params["id"][0]! : (req.params["id"] as string);
      const registryStore = req.stackContext.serviceRegistry;
      const services = registryStore.getVersion(id);
      res.json(services);
    } catch (err) {
      res.status(404).json({ error: String(err) });
    }
  });

  app.post("/api/services/versions/:id/restore", (req: Request, res: Response) => {
    try {
      const id = Array.isArray(req.params["id"]) ? req.params["id"][0]! : (req.params["id"] as string);
      const registryStore = req.stackContext.serviceRegistry;
      registryStore.rollback(id);
      res.json({ restored: true, services: registryStore.load() });
    } catch (err) {
      res.status(404).json({ error: String(err) });
    }
  });

  // ── Feedback + Patterns REST API ────────────────────────────────────────
  app.get("/api/investigations/:id/feedback", (req: Request, res: Response) => {
    const investigationId = Array.isArray(req.params["id"]) ? req.params["id"][0]! : (req.params["id"] as string);
    const existing = db.getFeedback(req.stackId, investigationId);
    res.json({ rating: existing?.rating ?? null, created_at: existing?.created_at ?? null });
  });

  app.post("/api/investigations/:id/feedback", async (req: Request, res: Response) => {
    try {
      const investigationId = Array.isArray(req.params["id"]) ? req.params["id"][0]! : (req.params["id"] as string);
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
      const { previousRating } = db.upsertFeedback(req.stackId, {
        id: `fb_${makeId()}`,
        investigationId,
        rating,
      });

      // Pattern extraction fires once per investigation per stack, no matter
      // how many times the user flips the rating. The `previousRating` check
      // alone isn't enough: a user who goes useful → not_useful → useful
      // would create a second pattern on the re-vote. The `hasPatternForInvestigation`
      // check is the hard backstop — if we've ever extracted a pattern from
      // this investigation in this stack, skip.
      if (
        rating === "useful" &&
        previousRating !== "useful" &&
        investigation.report &&
        !db.hasPatternForInvestigation(req.stackId, investigationId)
      ) {
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

      res.json({ ok: true, rating });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Failed to save feedback" });
    }
  });

  app.get("/api/patterns/:id", (req: Request, res: Response) => {
    const patternId = Array.isArray(req.params["id"]) ? req.params["id"][0]! : (req.params["id"] as string);
    const seed = db.getPattern(req.stackId, patternId);
    if (!seed) {
      res.status(404).json({ error: "Pattern not found" });
      return;
    }

    const candidates = db.listPatternsForService(req.stackId, seed.service);
    const cluster = buildPatternCluster(seed, candidates);
    const occurrences = cluster.occurrences.map((occurrence) => ({
      ...occurrence,
      investigation: occurrence.source_investigation_id
        ? db.getInvestigationSummary(req.stackId, occurrence.source_investigation_id) ?? null
        : null,
    }));

    res.json({
      ...cluster,
      occurrences,
    });
  });

  /**
   * GET /api/patterns — list learned `incident_patterns` for the resolved
   * stack, newest first.
   *
   * Query params (all optional — no required filter):
   *  - `service`      — exact match, single-select.
   *  - `severity`     — comma-separated subset of `low|medium|high|critical`.
   *  - `since`,`until`— ISO 8601 timestamps applied to created_at.
   *  - `q`            — case-insensitive substring across symptom, root_cause,
   *                     and recommended_actions.
   *  - `sort`         — `created_at` (default, desc) or `severity` (desc).
   *  - `limit`        — default 25, hard cap 200.
   *  - `offset`       — page offset, 0-indexed.
   *
   * Response shape: `{ rows, total, hasMore, services }`. `services` is the
   * distinct list of services with at least one pattern in this stack —
   * bundled here so the GUI service filter dropdown populates from a single
   * round-trip.
   *
   * Back-compat: previously the endpoint required `?service=X` and returned
   * a bare array. The Dashboard Learned Patterns section is the only caller
   * and is updated in this PR to read `data.rows`. No public consumers.
   */
  app.get("/api/patterns", (req: Request, res: Response) => {
    const service = req.query["service"] as string | undefined;
    const severity = parseEnumCsv(req.query["severity"] as string | undefined,
      ["low", "medium", "high", "critical"] as const);
    const since = parseIsoToEpochMs(req.query["since"] as string | undefined);
    const until = parseIsoToEpochMs(req.query["until"] as string | undefined);
    const q = (req.query["q"] as string | undefined)?.trim() || undefined;
    const sortRaw = (req.query["sort"] as string | undefined) ?? "created_at";
    const sort: "created_at" | "severity" = sortRaw === "severity" ? "severity" : "created_at";
    const rawLimit = parseInt((req.query["limit"] as string) || "25", 10);
    const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 25, 200);
    const rawOffset = parseInt((req.query["offset"] as string) || "0", 10);
    const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

    const filterOpts = {
      stackId: req.stackId,
      ...(service ? { service } : {}),
      ...(severity.length ? { severity } : {}),
      ...(since !== undefined ? { since } : {}),
      ...(until !== undefined ? { until } : {}),
      ...(q ? { q } : {}),
    };

    const rows = db.listPatterns({ ...filterOpts, limit, offset, sort });
    const total = db.countPatterns(filterOpts);
    const hasMore = offset + rows.length < total;
    const services = db.listPatternServices(req.stackId);
    res.json({ rows, total, hasMore, services });
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

  // ── Alert Webhooks (inbound, Alertmanager) ──────────────────────────
  //
  // Read-only inspection endpoints for the Settings → Alert Webhooks tab.
  // Both follow the existing API auth posture (passthrough on staging,
  // X-API-Key header in prod) — neither mutates state, neither exposes raw
  // tokens (masking is enforced server-side; full-token reveal is a separate
  // endpoint, deferred to PR 2 when the UI lands and the auth flow can be
  // wired end-to-end).

  app.get("/api/webhooks/info", (req: Request, res: Response) => {
    const wh = config.webhook;
    const stackId = req.stackId;
    const stackSlug = req.stackContext?.slug ?? DEFAULT_STACK_SLUG;

    // Token list. Legacy `webhook.secret` surfaces as a row named "default"
    // with `legacy: true` so the UI can render the rotation guidance
    // (move to per-sender tokens) inline. Per-sender tokens come from
    // `webhook.tokens`. Both go through `maskToken` — full token never
    // leaves this endpoint.
    const tokens: Array<{ name: string; masked: string; legacy: boolean }> = [];
    if (wh.secret) {
      tokens.push({ name: "default", masked: maskToken(wh.secret), legacy: true });
    }
    if (wh.tokens) {
      for (const [name, token] of Object.entries(wh.tokens)) {
        tokens.push({ name, masked: maskToken(token), legacy: false });
      }
    }

    res.json({
      // Path-only URLs. The frontend prepends `window.location.origin` plus
      // APP_BASE so the snippet generator produces the right absolute URL
      // for whatever ingress operators reach the UI through. Returning a
      // server-rendered absolute URL would require a config field the
      // current schema doesn't have (we'd need to add `webhook.publicUrl`)
      // and would diverge from the frontend's actual origin in split-DNS
      // setups.
      url: `/api/webhook/alert/${stackSlug}`,
      defaultUrl: "/api/webhook/alert",
      stackSlug,
      stackId,
      tokens,
      severityTemplateMap: wh.severityTemplateMap,
      defaultTemplate: wh.defaultTemplate,
      dedupWindowSeconds: wh.dedupWindowSeconds,
      maxConcurrent: wh.maxConcurrent,
      // The contract a Grafana-side label set must satisfy for an alert to
      // reach an investigation. Surfacing this kills the #1 self-service
      // failure mode (operator labels with `team` instead of `service` and
      // gets a silent 422 with no UI affordance).
      serviceLabelKeys: SERVICE_LABEL_KEYS,
      acceptsResolved: false,
    });
  });

  // GET /api/webhooks/recent — last 20 webhook deliveries for this stack.
  // Backed by the persistent `events` DB table (not the in-memory ring) so
  // the activity log doesn't drop entries during busy periods. Filters on
  // kind=alert_received + meta.source=alertmanager so future inbound
  // sources (PagerDuty, Datadog) don't conflate.
  app.get("/api/webhooks/recent", (req: Request, res: Response) => {
    const stackId = req.stackId;
    const rows = db.listEvents({
      stackId,
      kind: ["alert_received"],
      source: "alertmanager",
      limit: 20,
    });

    res.json({
      events: rows.map((r) => ({
        id: r.id,
        ts: r.ts,
        sender: typeof r.meta?.["sender"] === "string" ? r.meta["sender"] : "unknown",
        alertName: typeof r.meta?.["alertName"] === "string" ? r.meta["alertName"] : "unknown",
        alertSeverity: typeof r.meta?.["alertSeverity"] === "string" ? r.meta["alertSeverity"] : null,
        service: r.service,
        deliveryStatus: typeof r.meta?.["deliveryStatus"] === "string" ? r.meta["deliveryStatus"] : "unknown",
        summary: r.summary,
      })),
    });
  });

  // ── Notifications REST API ──────────────────────────────────────────

  const SLACK_ON_SCAN_COMPLETE_VALUES = new Set(["always", "hits-only", "off"]);

  app.get("/api/notifications", (_req: Request, res: Response) => {
    const slackUrl = db.getSetting("notifications.slack.webhookUrl");
    const slackEnabled = db.getSetting("notifications.slack.enabled");
    // Fall back to config.yaml if no GUI override
    const effectiveUrl = slackUrl ?? config.webhook.slackWebhookUrl ?? null;
    const effectiveEnabled = slackEnabled !== undefined ? slackEnabled === "true" : !!effectiveUrl;
    const onScanComplete = db.getSetting("notifications.slack.onScanComplete") ?? "hits-only";
    res.json({
      slack: {
        webhookUrl: effectiveUrl,
        enabled: effectiveEnabled,
        source: slackUrl ? "gui" : (config.webhook.slackWebhookUrl ? "config" : "none"),
        onScanComplete,
      },
    });
  });

  app.put("/api/notifications", (req: Request, res: Response) => {
    const { slack } = req.body as {
      slack?: {
        webhookUrl?: string | null;
        enabled?: boolean;
        onScanComplete?: "always" | "hits-only" | "off";
      };
    };
    if (!slack) {
      res.status(400).json({ error: "Missing slack configuration" });
      return;
    }
    if (slack.onScanComplete !== undefined) {
      if (!SLACK_ON_SCAN_COMPLETE_VALUES.has(slack.onScanComplete)) {
        res.status(400).json({ error: "onScanComplete must be one of: always, hits-only, off" });
        return;
      }
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
    if (slack.onScanComplete !== undefined) {
      db.setSetting("notifications.slack.onScanComplete", slack.onScanComplete);
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
      // Pass appBaseUrl so the operator can verify the "View Investigation"
      // button shape end-to-end. The button URL points at a synthetic id
      // that 404s in the SPA — the user is testing the wiring, not the
      // landing page, so a not-found pane is the honest outcome.
      const appBaseUrl = config.notifications?.email?.appBaseUrl;
      // Use the active stack so the test post emits the canonical
      // /stacks/:stackId/investigations/:id form — operators verifying
      // wiring should see the same URL shape as production traffic, even
      // though the synthetic id will 404 in the SPA.
      await notifySlack(
        { slackWebhookUrl: slackUrl, appBaseUrl, stackId: req.stackId },
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

  /**
   * POST /api/notifications/scan-run/send — user-initiated "Send to Slack"
   * for a specific scan run (from the ScanRunDetail Export menu). Builds
   * the same Block Kit payload as the automatic scan-complete notifier,
   * but surfaces errors instead of swallowing them so the UI can show
   * "webhook not configured" or "Slack post failed" to the operator.
   *
   * Response contract:
   *  - 200 { ok: true } — Slack POST succeeded.
   *  - 400 — runId missing or Slack webhook not configured.
   *  - 404 — scan run not found in this stack.
   *  - 502 — Slack endpoint rejected the payload or network error.
   */
  app.post("/api/notifications/scan-run/send", async (req: Request, res: Response) => {
    const body = req.body as { runId?: string };
    if (!body.runId || typeof body.runId !== "string") {
      res.status(400).json({ error: "runId required" });
      return;
    }
    const run = db.getScanRun(req.stackId, body.runId);
    if (!run) {
      res.status(404).json({ error: "Scan run not found" });
      return;
    }
    const url = db.getSetting("notifications.slack.webhookUrl") ?? config.webhook?.slackWebhookUrl;
    if (!url) {
      res.status(400).json({ error: "Slack webhook not configured" });
      return;
    }
    const investigations = db.getScanRunInvestigations(body.runId);
    const appBaseUrl = config.notifications?.email?.appBaseUrl;
    try {
      await sendSlackScanRunPost(
        { slackWebhookUrl: url, appBaseUrl },
        {
          runId: run.id,
          stackId: run.stackId,
          trigger: run.trigger,
          startedAt: run.startedAt,
          // Wall-clock duration of the full run, matching what the auto-notifier
          // posts on `scan:complete`. Falls back to 0 for unfinished runs.
          durationMs: (run.finishedAt ?? run.startedAt) - run.startedAt,
          servicesProbed: run.servicesProbed,
          hitsDispatched: run.hitsDispatched,
          dispatchedServices: investigations.map(i => i.service),
        },
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Email notifications ─────────────────────────────────────────────────

  const ALL_SOURCES_SET = new Set<string>(ALL_SOURCES);
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

  // ── Periodic discovery — listing & runs ────────────────────────────────
  app.get("/api/discoveries", (req: Request, res: Response) => {
    const stackId = req.stackId!;
    let ctx;
    try { ctx = stackManager.getContext(stackId); } catch { res.status(404).json({ error: "stack_not_found" }); return; }
    const additions = ctx.pendingDiscoveryStore.listQualified(stackId, "addition");
    const removals = ctx.pendingDiscoveryStore.listQualified(stackId, "removal");
    const dismissedCount = ctx.pendingDiscoveryStore.listDismissed(stackId).length;
    res.json({
      additions, removals,
      counts: { additions: additions.length, removals: removals.length, dismissed: dismissedCount },
    });
  });

  app.get("/api/discoveries/dismissed", (req: Request, res: Response) => {
    let ctx; try { ctx = stackManager.getContext(req.stackId!); } catch { res.status(404).json({ error: "stack_not_found" }); return; }
    res.json(ctx.pendingDiscoveryStore.listDismissed(req.stackId!));
  });

  app.get("/api/discoveries/badge", (req: Request, res: Response) => {
    let ctx; try { ctx = stackManager.getContext(req.stackId!); } catch { res.status(404).json({ error: "stack_not_found" }); return; }
    res.json({ count: ctx.pendingDiscoveryStore.countUnviewed(req.stackId!) });
  });

  app.get("/api/discoveries/runs", (req: Request, res: Response) => {
    let ctx; try { ctx = stackManager.getContext(req.stackId!); } catch { res.status(404).json({ error: "stack_not_found" }); return; }
    const limit = Math.min(parseInt(String(req.query["limit"] ?? "10"), 10) || 10, 100);
    res.json(ctx.pendingDiscoveryStore.listRuns(req.stackId!, limit));
  });

  app.get("/api/discovery/settings", (req: Request, res: Response) => {
    const stored = db.getPeriodicDiscoverySettings(req.stackId!);
    res.json(stored ?? config.discovery?.periodic ?? {
      enabled: false,
      cron: "",
      timezone: "UTC",
      consensusRuns: 2,
      consensusRunsForRemovals: 3,
    });
  });

  app.put("/api/discovery/settings", (req: Request, res: Response) => {
    const parsed = PeriodicDiscoverySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ error: "validation_failed", issues: parsed.error.issues });
      return;
    }
    db.setPeriodicDiscoverySettings(req.stackId!, parsed.data);
    let ctx; try { ctx = stackManager.getContext(req.stackId!); } catch { res.json({ ok: true }); return; }
    ctx.periodicDiscoveryScheduler.restart(parsed.data);
    res.json({ ok: true });
  });

  // ── Periodic discovery — mutations ──────────────────────────────────────
  app.post("/api/discoveries/:id/dismiss", (req: Request, res: Response) => {
    let ctx; try { ctx = stackManager.getContext(req.stackId!); } catch { res.status(404).json({ error: "stack_not_found" }); return; }
    const row = ctx.pendingDiscoveryStore.findById((req.params["id"] as string));
    if (!row || row.stackId !== req.stackId) { res.status(404).json({ error: "not_found" }); return; }
    ctx.pendingDiscoveryStore.dismiss((req.params["id"] as string));
    res.json({ ok: true });
  });

  app.post("/api/discoveries/dismissed/:id/restore", (req: Request, res: Response) => {
    let ctx; try { ctx = stackManager.getContext(req.stackId!); } catch { res.status(404).json({ error: "stack_not_found" }); return; }
    ctx.pendingDiscoveryStore.restoreDismissed((req.params["id"] as string));
    res.json({ ok: true });
  });

  app.post("/api/discoveries/mark-viewed", (req: Request, res: Response) => {
    let ctx; try { ctx = stackManager.getContext(req.stackId!); } catch { res.status(404).json({ error: "stack_not_found" }); return; }
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((x: unknown) => typeof x === "string") : null;
    if (ids === null) {
      const all = [
        ...ctx.pendingDiscoveryStore.listQualified(req.stackId!, "addition"),
        ...ctx.pendingDiscoveryStore.listQualified(req.stackId!, "removal"),
      ].filter((r) => r.viewedAt === null).map((r) => r.id);
      ctx.pendingDiscoveryStore.markViewed(all);
    } else {
      ctx.pendingDiscoveryStore.markViewed(ids);
    }
    res.json({ ok: true });
  });

  app.post("/api/discoveries/run-now", async (req: Request, res: Response) => {
    let ctx; try { ctx = stackManager.getContext(req.stackId!); } catch { res.status(404).json({ error: "stack_not_found" }); return; }
    const sched = ctx.periodicDiscoveryScheduler;
    if (sched.isTicking()) {
      const next = sched.status().nextRun;
      res.status(409).json({ kind: "tick_in_progress", nextEligibleAt: next });
      return;
    }
    sched.tickOnce().catch(() => {/* logged inside */});
    res.json({ ok: true });
  });

  // ── Accept route — Zod-validated, conflict-aware (T16 critical) ────────
  app.post("/api/discoveries/:id/accept", async (req: Request, res: Response) => {
    let ctx; try { ctx = stackManager.getContext(req.stackId!); } catch { res.status(404).json({ error: "stack_not_found" }); return; }
    const row = ctx.pendingDiscoveryStore.findById((req.params["id"] as string));
    if (!row || row.stackId !== req.stackId) { res.status(404).json({ error: "not_found" }); return; }

    if (row.changeKind === "removal") {
      const current = ctx.serviceRegistry.load();
      const next = current.filter((s) => s.name !== row.serviceName);
      ctx.serviceRegistry.save(next, "discovery");
      ctx.pendingDiscoveryStore.deleteById(row.id);
      res.json({ ok: true });
      return;
    }

    if (!row.payload) { res.status(422).json({ error: "missing_payload" }); return; }
    let parsedConfig: ServiceConfig;
    try {
      const json = JSON.parse(row.payload);
      const result = ServiceConfigSchema.safeParse(json);
      if (!result.success) { res.status(422).json({ error: "payload_corrupt", issues: result.error.issues }); return; }
      parsedConfig = result.data as ServiceConfig;
    } catch (err) {
      res.status(422).json({ error: "payload_corrupt", message: err instanceof Error ? err.message : String(err) });
      return;
    }

    const currentGlobals = JSON.stringify(ctx.serviceRegistry.loadAll().globalProbeRules ?? []);
    const snapshot = row.globalsSnapshot ?? "[]";
    if (currentGlobals !== snapshot) {
      res.status(409).json({
        kind: "globals_drift",
        current: JSON.parse(currentGlobals),
        snapshot: JSON.parse(snapshot),
      });
      return;
    }

    const currentVersion = ctx.serviceRegistry.listVersions().slice(-1)[0]?.id ?? "v-initial";
    if (row.registryVersionAtQualification && row.registryVersionAtQualification !== currentVersion) {
      res.status(409).json({
        kind: "registry_advanced",
        current_version: currentVersion,
        qualification_version: row.registryVersionAtQualification,
      });
      return;
    }

    const next = [...ctx.serviceRegistry.load(), parsedConfig];
    ctx.serviceRegistry.save(next, "discovery");
    ctx.pendingDiscoveryStore.deleteById(row.id);
    res.json({ ok: true });
  });

  // ── Accept-with-current-globals — re-runs sanity probe ─────────────────
  app.post("/api/discoveries/:id/accept-with-current-globals", async (req: Request, res: Response) => {
    let ctx; try { ctx = stackManager.getContext(req.stackId!); } catch { res.status(404).json({ error: "stack_not_found" }); return; }
    const row = ctx.pendingDiscoveryStore.findById((req.params["id"] as string));
    if (!row || row.stackId !== req.stackId || row.changeKind !== "addition") {
      res.status(404).json({ error: "not_found" }); return;
    }
    if (!row.payload) { res.status(422).json({ error: "missing_payload" }); return; }
    let parsedConfig: ServiceConfig;
    try {
      const json = JSON.parse(row.payload);
      const result = ServiceConfigSchema.safeParse(json);
      if (!result.success) { res.status(422).json({ error: "payload_corrupt", issues: result.error.issues }); return; }
      parsedConfig = result.data as ServiceConfig;
    } catch { res.status(422).json({ error: "payload_corrupt" }); return; }

    if (parsedConfig.metrics?.[0]) {
      const r = await ctx.buildInstantProbe(parsedConfig.metrics[0].query);
      if (r.kind !== "ok") {
        res.status(409).json({ kind: "sanity_probe_failed", probe: r });
        return;
      }
    }
    const next = [...ctx.serviceRegistry.load(), parsedConfig];
    ctx.serviceRegistry.save(next, "discovery");
    ctx.pendingDiscoveryStore.deleteById(row.id);
    res.json({ ok: true });
  });
}
