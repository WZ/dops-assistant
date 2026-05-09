import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";

const envPath = process.env["DOTENV_PATH"] ?? resolve(process.cwd(), "dev/.env");
loadDotenv({ path: envPath });

import express, { type NextFunction, type Request, type Response } from "express";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "node:fs";
import { Agent, setGlobalDispatcher } from "undici";
import { createLogger } from "../logger.js";

// Bump undici's default headers/body timeouts (5 min each) so slow upstreams
// — reasoning LLMs in particular — don't get cut off mid-response. The default
// kills tool-heavy discovery runs against models like gpt-oss-120b.
// Override per-deploy with HTTP_HEADERS_TIMEOUT_MS / HTTP_BODY_TIMEOUT_MS.
const httpHeadersTimeoutMs = Number(process.env["HTTP_HEADERS_TIMEOUT_MS"] ?? 1_200_000);
const httpBodyTimeoutMs = Number(process.env["HTTP_BODY_TIMEOUT_MS"] ?? 1_200_000);
setGlobalDispatcher(new Agent({
  headersTimeout: httpHeadersTimeoutMs,
  bodyTimeout: httpBodyTimeoutMs,
}));
import { Database } from "./db.js";
import { registerRoutes } from "./routes.js";
import { setupWebSocket } from "./ws-handler.js";
import { IntentRouter, matchServiceFromText, validateLlmServiceMatch, setServiceAliases } from "../agents/intent.js";
import { loadConfig } from "../config/loader.js";
import { SkillStore } from "../skills/store.js";
import { createModel } from "../mastra/index.js";
import { InvestigationRunner } from "./investigation-runner.js";
import { createWebhookHandler, WEBHOOK_NOT_CONFIGURED_BODY } from "./webhook-handler.js";
import { InvestigationDedup } from "./investigation-dedup.js";
import { createApiKeyMiddleware } from "./auth-middleware.js";
import { globalLimiter, strictLimiter, moderateLimiter } from "./rate-limit.js";
import { startHealthMonitor, stopHealthMonitor, healthHandler } from "./health-monitor.js";
import { eventLog } from "./event-log.js";
import { startEventsRetentionTask } from "./events-retention.js";
import { createDemoModeMiddleware, isDemoMode } from "./demo-mode.js";
import { StackManager } from "./stack-manager.js";
import { createMastraAdapters } from "./agents.js";
import { registerStackScopedWebhookRoute } from "./webhook-routes.js";
import { notifySlack } from "./slack-notifier.js";
import { buildInvestigationMessage } from "./anomaly-probe.js";
import nodemailer, { type Transporter } from "nodemailer";
import { notifyEmail } from "./email-notifier.js";
import { ulid } from "ulid";
import { importLegacyWebhookTokens } from "./webhook-token-migration.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logger = createLogger();

async function main() {
  const configPath = process.env["CONFIG_PATH"] ?? "config.yaml";
  const config = loadConfig(configPath);

  if (config.serviceAliases && Object.keys(config.serviceAliases).length > 0) {
    setServiceAliases(config.serviceAliases);
  }

  const dbPath = process.env["DB_PATH"] ?? "dops.sqlite";
  const db = new Database(dbPath);
  const configuredLegacyWebhookTokens = Object.keys(config.webhook.legacyTokens).length;

  // Wire the EventLog ring to also persist to the DB. After this call, every
  // `eventLog.append(...)` writes a row into the `events` table — that's
  // what powers /activity/events. Done at boot before any code path that
  // emits events runs (StackManager init, scan scheduler, health pollers).
  eventLog.bindDatabase(db);

  // Background sweep of expired event rows. Default 30-day retention,
  // configurable via `config.events.retentionDays`. `0` disables the sweep
  // (for users with external archival).
  startEventsRetentionTask({ db, retentionDays: config.events.retentionDays });

  // Clean up investigations left in 'running' state from prior crashes
  try {
    const staleCount = db.markStaleInvestigations();
    if (staleCount > 0) {
      logger.info({ staleCount }, "Marked stale investigations as failed");
    }
  } catch (err) {
    logger.warn({ err }, "Failed to clean up stale investigations");
  }

  // Initialize StackManager — replaces singleton registryStore, ProviderRegistry, memory, healthPoller
  const stackManager = new StackManager(db, config);
  await stackManager.initialize();

  // Legacy yaml-token migration runs AFTER StackManager — the default stack
  // must exist before we can scope imported tokens to it. Re-running is
  // safe (lookup-by-hash short-circuits duplicates).
  if (configuredLegacyWebhookTokens > 0) {
    const importedLegacyWebhookTokens = importLegacyWebhookTokens(
      db,
      config.webhook.legacyTokens,
      stackManager.getDefaultStackId(),
    );
    logger.warn(
      { configuredLegacyWebhookTokens, importedLegacyWebhookTokens },
      "Imported deprecated YAML webhook tokens into DB-backed webhook tokens (default stack); remove legacy webhook config after alert senders are updated"
    );
    config.webhook.legacyTokens = {};
  }

  const model = createModel(config.llm);
  stackManager.setLlmModel(model);
  const router = new IntentRouter(model, config.llm.retry, config.timeouts?.llmCallMs);

  // Initialize skill store
  const skillStore = new SkillStore(config.skills);
  await skillStore.loadAll();
  stackManager.setSkillStore(skillStore);

  const app = express();
  // Trust proxy configuration for Express.
  //
  // Default: 1 (trust one hop — correct for a single k8s ingress that
  // overwrites X-Forwarded-For, which is the nginx-ingress default when
  // `use-forwarded-headers: false`).
  //
  // Override with TRUST_PROXY_HOPS env var when the topology has more hops
  // (e.g., CDN + ingress = 2, service mesh + ingress = 2). Setting a wrong
  // value has consequences:
  //   - Too low: real clients share a single rate-limit bucket (false 429s).
  //   - Too high: attackers can spoof X-Forwarded-For and bypass rate limits.
  //
  // If the ingress is configured with `use-forwarded-headers: true` (pass
  // through client XFF unchanged), set TRUST_PROXY_HOPS to the number of
  // trusted hops in front of the application, NOT counting the client.
  const trustProxyHops = Number(process.env["TRUST_PROXY_HOPS"] ?? 1);
  app.set("trust proxy", Number.isFinite(trustProxyHops) && trustProxyHops >= 0 ? trustProxyHops : 1);
  app.use(express.json({ limit: "1mb" }));

  // ── JSON error shim for body-parser ──────────────────────────────
  // Without this, a malformed JSON POST falls through to Express's default
  // HTML error page (`<!DOCTYPE html>...<pre>Bad Request</pre>`). SPA clients
  // that `res.json()` on the response crash with "SyntaxError: Unexpected
  // token <". Only catches SyntaxError-shaped errors from express.json so
  // we don't accidentally intercept unrelated downstream errors.
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (err instanceof SyntaxError && "body" in (err as SyntaxError & { body?: unknown })) {
      res.status(400).json({ error: "Invalid JSON in request body" });
      return;
    }
    next(err);
  });

  // ── Rate limiting (applied before auth so abusive traffic is rejected early) ──
  // Global: 300 req/min per IP for all /api/* routes
  app.use("/api", globalLimiter);
  // Strict: 10 req/min per IP for LLM-triggering routes
  app.use("/api/skills/generate", strictLimiter);
  app.use("/api/metrics/extract", strictLimiter);
  app.use("/api/services/:name/brief", strictLimiter);
  // Moderate: 30 req/min per IP for remaining POST/PUT/DELETE (skips GET)
  app.use("/api", moderateLimiter);

  // Demo mode (read-only public showcase) — rejects non-GET requests with a
  // structured 403. No-op when DEMO_MODE env var is unset. Installed before
  // the API-key middleware so demo denials surface with a clear reason rather
  // than being masked by an auth challenge.
  app.use("/api", createDemoModeMiddleware());

  // API key auth on mutating routes (POST/PUT/DELETE/PATCH).
  // Webhook endpoints are exempt — they have their own bearer token auth.
  // Note: when mounted at "/api", Express strips the prefix from req.path,
  // so exempt paths are relative to the mount point.
  const apiKeyMiddleware = createApiKeyMiddleware(config.apiKey, [
    "/webhook/alert",
  ]);
  app.use("/api", apiKeyMiddleware);

  const server = createServer(app);
  const port = Number(process.env["PORT"] ?? 3000);

  // Shared dedup for both webhook and health-poller auto-investigate
  // Pass db for fallback dedup checks that survive server restarts
  const sharedDedup = new InvestigationDedup({
    dedupWindowSeconds: config.webhook.dedupWindowSeconds,
    maxConcurrent: config.webhook.maxConcurrent,
    db,
  });

  let emailTransport: Transporter | null = null;
  const getEmailTransport = (): Transporter | null => {
    const emailCfg = config.notifications?.email;
    if (!emailCfg) return null;
    if (!emailTransport) {
      emailTransport = nodemailer.createTransport({
        host: emailCfg.smtp.host,
        port: emailCfg.smtp.port,
        secure: emailCfg.smtp.secure,
        auth: { user: emailCfg.smtp.user, pass: emailCfg.smtp.pass },
      });
    }
    return emailTransport;
  };

  const buildEmailNotifierDeps = (): import("./email-notifier.js").EmailNotifierDeps | null => {
    const emailCfg = config.notifications?.email;
    const transport = getEmailTransport();
    if (!emailCfg || !transport) return null;
    return {
      isGloballyEnabled: () => {
        const dbEnabled = db.getSetting("notifications.email.enabled");
        return dbEnabled !== undefined ? dbEnabled === "true" : emailCfg.enabled;
      },
      listEnabledRecipients: () => db.listEmailRecipients({ enabledOnly: true }),
      transport,
      config: {
        from: emailCfg.from,
        appBaseUrl: emailCfg.appBaseUrl,
        retry: { attempts: emailCfg.retry.attempts, backoffMs: emailCfg.retry.backoffMs },
      },
    };
  };

  stackManager.setEmailNotifierDeps(buildEmailNotifierDeps());

  // Build a global onComplete handler for Slack + email notifications.
  // Reads URL/settings dynamically so GUI changes take effect without restart.
  const globalOnComplete = (
    investigationId: string,
    service: string,
    report: import("../types/rca-types.js").RcaReport,
    stackId: string | undefined,
    source: import("../types/notifications.js").NotificationSource,
  ) => {
    const slackUrl = db.getSetting("notifications.slack.webhookUrl") ?? config.webhook.slackWebhookUrl;
    const slackEnabled = db.getSetting("notifications.slack.enabled");
    if (slackUrl && slackEnabled !== "false") {
      const appBaseUrl = config.notifications?.email?.appBaseUrl;
      notifySlack(
        { slackWebhookUrl: slackUrl, appBaseUrl, stackId },
        investigationId,
        service,
        report,
      );
    }

    // ── Email ────────────────────────────────────────────────────────
    const emailDeps = buildEmailNotifierDeps();
    if (emailDeps && emailDeps.isGloballyEnabled()) {
      notifyEmail(emailDeps, investigationId, report, source).catch((err) => {
        logger.warn({ err, investigationId }, "notifyEmail rejected unexpectedly");
      });
    }
  };

  // Wire health transition handler for auto-investigate
  stackManager.onHealthTransition = (stackId, service, from, to) => {
    if (to !== "down") return;
    if (from !== "healthy" && from !== "unknown") return;
    // Defense in depth: skip hidden services
    if (db.isServiceHidden(stackId, service)) return;

    logger.info({ service, from, to, stackId }, "ServiceHealthPoller: service transitioned to down");

    if (!sharedDedup.shouldInvestigate(stackId, service).allowed) {
      logger.info({ service, activeCount: sharedDedup.getActiveCount(), stackId }, "ServiceHealthPoller: auto-investigate suppressed by dedup/concurrency");
      return;
    }

    // Find the service config from live registry or config.yaml
    const ctx = stackManager.getContext(stackId);
    const allServices = [
      ...config.services,
      ...ctx.serviceRegistry.load().filter((s) => !config.services.some((c) => c.name === s.name)),
    ];
    const serviceConfig = allServices.find((s) => s.name === service);
    if (!serviceConfig) {
      logger.warn({ service, stackId }, "ServiceHealthPoller: service not found in config or registry, skipping auto-investigate");
      return;
    }

    // Build enriched message with service context
    const messageParts = [
      `Service health check: ${service} transitioned from ${from} to down.`,
    ];
    if (serviceConfig.metrics?.length) {
      messageParts.push(`Known metrics: ${serviceConfig.metrics.map(m => `${m.description} (${m.query})`).slice(0, 3).join("; ")}`);
    }
    if (serviceConfig.logLabels && Object.keys(serviceConfig.logLabels).length > 0) {
      const labels = Object.entries(serviceConfig.logLabels).map(([k, v]) => `${k}="${v}"`).join(",");
      messageParts.push(`Log selector: {${labels}}`);
    }

    logger.info({ service, stackId }, "ServiceHealthPoller: triggering auto-investigate (template=standard)");
    sharedDedup.markStarted(stackId, service);

    // Create agents lazily for the investigation
    const providers = ctx.providerRegistry.getProviders();
    createMastraAdapters({ config, providers, registryStore: ctx.serviceRegistry, datasourceUidMap: ctx.providerRegistry.buildDatasourceUidMap(), db, stackId })
      .then(({ investigationAgent }) => {
        const runner = new InvestigationRunner({ db, investigationAgent, skillStore, globalOnComplete });
        return runner.run({
          service: serviceConfig,
          message: messageParts.join("\n"),
          template: "standard",
          stackId,
          readOnlyTools: true,
          source: "poller",
        });
      })
      .catch((err) => {
        logger.error({ err, service, stackId }, "ServiceHealthPoller: auto-investigate failed");
      })
      .finally(() => {
        sharedDedup.markCompleted();
      });
  };

  // Wire k8s event handler for auto-investigate. Same dispatch shape as
  // onHealthTransition above. SYNC GUARD: no await between
  // sharedDedup.shouldInvestigate and sharedDedup.markStarted — this is what
  // makes cross-detector dedup race-safe (see spec at
  // docs/superpowers/specs/2026-04-26-k8s-event-poller-design.md).
  stackManager.onK8sEvent = (stackId, hit) => {
    if (db.isServiceHidden(stackId, hit.service)) return;

    logger.info(
      { stackId, service: hit.service, reason: hit.reason, source: hit.source, podUid: hit.podUid },
      "K8sEventPoller: hit detected",
    );

    if (!sharedDedup.shouldInvestigate(stackId, hit.service).allowed) {
      logger.info(
        { stackId, service: hit.service, activeCount: sharedDedup.getActiveCount() },
        "K8sEventPoller: auto-investigate suppressed by dedup/concurrency",
      );
      return;
    }

    const ctx = stackManager.getContext(stackId);
    const allServices = [
      ...config.services,
      ...ctx.serviceRegistry.load().filter((s) => !config.services.some((c) => c.name === s.name)),
    ];
    const serviceConfig = allServices.find((s) => s.name === hit.service);
    if (!serviceConfig) {
      logger.warn(
        { stackId, service: hit.service },
        "K8sEventPoller: service not found in config or registry, skipping auto-investigate",
      );
      return;
    }

    const messageParts = [
      `K8s event detected on ${hit.service}: reason=${hit.reason} source=${hit.source}.`,
      `Pod UID: ${hit.podUid}. Occurred at: ${hit.occurredAt}.`,
    ];
    if (hit.message) messageParts.push(`Detail: ${hit.message}`);
    if (hit.restartCount !== undefined) messageParts.push(`restartCount: ${hit.restartCount}.`);
    if (serviceConfig.metrics?.length) {
      messageParts.push(
        `Known metrics: ${serviceConfig.metrics.map((m) => `${m.description} (${m.query})`).slice(0, 3).join("; ")}`,
      );
    }
    if (serviceConfig.logLabels && Object.keys(serviceConfig.logLabels).length > 0) {
      const labels = Object.entries(serviceConfig.logLabels).map(([k, v]) => `${k}="${v}"`).join(",");
      messageParts.push(`Log selector: {${labels}}`);
    }

    logger.info(
      { stackId, service: hit.service },
      "K8sEventPoller: triggering auto-investigate (template=standard)",
    );
    sharedDedup.markStarted(stackId, hit.service);   // SYNC — no await above

    const providers = ctx.providerRegistry.getProviders();
    createMastraAdapters({
      config,
      providers,
      registryStore: ctx.serviceRegistry,
      datasourceUidMap: ctx.providerRegistry.buildDatasourceUidMap(),
      db,
      stackId,
    })
      .then(({ investigationAgent }) => {
        const runner = new InvestigationRunner({ db, investigationAgent, skillStore, globalOnComplete });
        return runner.run({
          service: serviceConfig,
          message: messageParts.join("\n"),
          template: "standard",
          stackId,
          readOnlyTools: true,
          source: "k8s-event-poller",
        });
      })
      .catch((err) => {
        logger.error({ err, stackId, service: hit.service }, "K8sEventPoller: auto-investigate failed");
      })
      .finally(() => {
        sharedDedup.markCompleted();
      });
  };

  // Wire scan anomaly handler: for each flagged service, dedup-check + lazy-runner
  // This mirrors the onHealthTransition pattern above. Scheduler does NOT await
  // this callback, so each investigation runs in the background.
  stackManager.onScanAnomalies = ({ stackId, hits }) => {
    const ctx = stackManager.getContext(stackId);
    const allServices = [
      ...config.services,
      ...ctx.serviceRegistry.load().filter((s) => !config.services.some((c) => c.name === s.name)),
    ];

    for (const hit of hits) {
      const serviceConfig = allServices.find((s) => s.name === hit.service);
      if (!serviceConfig) {
        logger.warn({ service: hit.service, stackId }, "ScanScheduler: service not found in config or registry, skipping");
        continue;
      }
      // Defense in depth: hidden check is already done in the scheduler, but
      // re-check here in case the hidden set changed between tick and dispatch.
      if (db.isServiceHidden(stackId, hit.service)) continue;

      const dedupResult = sharedDedup.shouldInvestigate(stackId, hit.service);
      if (!dedupResult.allowed) {
        logger.info({
          stackId, service: hit.service, reason: dedupResult.reason, activeCount: sharedDedup.getActiveCount(),
        }, "ScanScheduler: investigation suppressed by shared dedup/concurrency");
        continue;
      }

      sharedDedup.markStarted(stackId, hit.service);
      const message = buildInvestigationMessage(hit);
      const template = config.scan.investigationTemplate;

      // Pre-generate the investigation ID so we can link it to the active
      // scan run SYNCHRONOUSLY — before we await the Mastra adapter build.
      // The scheduler clears `currentTracker` in the tick's `finally` block
      // right after this callback returns, so any async gap would risk
      // linking into a stale/null tracker. Passing the same ID into
      // runner.run below ensures the DB row the runner creates matches
      // what we linked. linkInvestigationOnCurrentRun is the sole authority
      // for scan_runs.hits_dispatched — skipping it leaves the column at 0.
      const invId = `inv_${ulid()}`;
      ctx.scanScheduler.linkInvestigationOnCurrentRun(invId, {
        service: hit.service,
        ruleName: hit.ruleName,
        value: hit.value,
        severity: hit.severity,
      });

      logger.info({
        stackId, service: hit.service, rule: hit.ruleName, severity: hit.severity, template, invId,
      }, "ScanScheduler: triggering auto-investigate");

      const providers = ctx.providerRegistry.getProviders();
      createMastraAdapters({ config, providers, registryStore: ctx.serviceRegistry, datasourceUidMap: ctx.providerRegistry.buildDatasourceUidMap(), db, stackId })
        .then(({ investigationAgent }) => {
          const runner = new InvestigationRunner({ db, investigationAgent, skillStore, globalOnComplete });
          return runner.run({
            service: serviceConfig,
            message,
            template,
            stackId,
            readOnlyTools: true,
            source: "scan",
            investigationId: invId,
          });
        })
        .catch((err) => {
          logger.error({ err, service: hit.service, stackId }, "ScanScheduler: auto-investigate failed");
        })
        .finally(() => {
          sharedDedup.markCompleted();
        });
    }
  };

  registerRoutes(app, { db, stackManager, config, skillStore, sharedDedup, llmModel: model, globalOnComplete });

  // Health check endpoint with background DB monitoring.
  // In demo mode the endpoint still works (for liveness probes / banner
  // freshness checks), but the background probe loop is skipped to keep
  // the static demo build noise-free.
  if (!isDemoMode()) {
    startHealthMonitor({ db });
  } else {
    logger.info("demo mode: skipping background health monitor");
  }
  app.get("/api/health", healthHandler);

  // Alert webhook endpoint.
  // The route is always registered. When no DB-managed webhook tokens exist,
  // the handler itself returns a structured 503 with
  // a hint, so operators posting to this URL see a meaningful error instead
  // of Express's default HTML 404 ("Cannot POST /api/webhook/alert"). When
  // any auth credential IS set, we eagerly build the runner/adapters so the
  // first webhook call doesn't pay that cost.
  //
  // Demo mode: never wire the real webhook handler even if auth is set —
  // demo-mode middleware would reject it anyway, but treating it as unconfigured
  // keeps the startup path free of adapter construction (which would try to
  // connect to stub MCP providers).
  if (!isDemoMode()) {
    // Adapter construction calls into Mastra, which builds MCP clients that
    // try SSE then HTTP transports against every configured upstream. When
    // an upstream is slow/unreachable (cold start, network blip), each retry
    // backs off for 10s+. Awaiting that here used to block server.listen()
    // long enough for kubelet's readiness probe to fail and the pod to
    // CrashLoopBackOff. Defer to a background init so the HTTP server starts
    // accepting /api/health immediately; the webhook returns a structured 503
    // until the adapter is ready.
    let defaultWebhookDelegate: (req: Request, res: Response) => void | Promise<void> = (_req, res) => {
      res.status(503).json({ error: "service warming up — webhook adapter still initializing", retryAfterSeconds: 5 });
    };
    // strictLimiter (60 req/min/IP) sits in front of the webhook routes
    // because each accepted call can fan out into a full investigation
    // (multiple LLM agents). The global moderate limiter (120/min on /api)
    // already applies; layering strict on top means the tighter bucket wins
    // for this specific endpoint without affecting GUI traffic.
    app.post("/api/webhook/alert", strictLimiter, (req, res) => defaultWebhookDelegate(req, res));

    // Stack-scoped variant builds adapters lazily per-request, so registering
    // it here does not block boot.
    registerStackScopedWebhookRoute(app, { db, stackManager, config, skillStore, sharedDedup, globalOnComplete });

    void (async () => {
      try {
        const defaultStackId = stackManager.getDefaultStackId();
        const defaultCtx = stackManager.getDefaultContext();
        const providers = defaultCtx.providerRegistry.getProviders();
        const { investigationAgent } = await createMastraAdapters({ config, providers, registryStore: defaultCtx.serviceRegistry, datasourceUidMap: defaultCtx.providerRegistry.buildDatasourceUidMap(), db, stackId: defaultStackId });
        const runner = new InvestigationRunner({ db, investigationAgent, skillStore, globalOnComplete });
        defaultWebhookDelegate = createWebhookHandler({
          runner,
          config: config.webhook,
          services: config.services,
          db,
          stackId: defaultStackId,
          dedup: sharedDedup,
          getHiddenServices: () => db.getHiddenServices(defaultStackId),
        });
        logger.info("Alert webhook adapter ready (POST /api/webhook/alert)");
      } catch (err) {
        logger.error({ err }, "Alert webhook adapter init failed; default-stack webhook stays in 503 mode");
      }
    })();

    logger.info("Alert webhook route registered at POST /api/webhook/alert (tokens managed via Settings → Alert Webhooks)");
  } else {
    // No webhook auth configured: register 503 stubs at both the default and
    // stack-scoped routes so clients receive a structured JSON error.
    const notConfiguredResponse = (_req: Request, res: Response) => {
      res.status(503).json(WEBHOOK_NOT_CONFIGURED_BODY);
    };
    app.post("/api/webhook/alert", notConfiguredResponse);
    app.post("/api/webhook/alert/:stackSlug", notConfiguredResponse);
    logger.warn("Alert webhook registered but DISABLED in demo mode — POST /api/webhook/alert will return 503");
  }

  setupWebSocket(server, {
    db, stackManager, config, router, skillStore,
    sharedDedup, globalOnComplete,
    validateLlmServiceMatch, matchServiceFromText,
  });

  // Resolve static dir relative to the working directory (worktree-safe), not __dirname
  const staticDir = path.resolve(process.cwd(), "dist/web");

  // Runtime sub-path configuration. The built bundle always references assets
  // at /assets/... (Vite base "/"), but a reverse proxy can serve the app at
  // a sub-path (e.g. https://host/dops/) that strips the prefix before it
  // reaches us. In that case the browser requests /dops/assets/..., which
  // the proxy rewrites to /assets/... — that part already works via
  // express.static. What fails without intervention is index.html itself:
  // its <script src="/assets/..."> tags send the browser to /assets/... under
  // the public host, which the proxy doesn't route. So we rewrite index.html
  // on the fly: prepend the base path to asset URLs and inject the base
  // into window.__APP_BASE__ so the web bundle's API/WS calls agree.
  //
  // Keep APP_BASE_PATH empty or "/" for root deploys — no rewriting, no cost.
  //
  // Strict allowlist for the input: only alphanumeric, slash, dash, underscore.
  // This blocks `$` (which String.replace would treat as a backreference in the
  // asset rewrite), `<` / `>` / quotes (HTML-context injection into the
  // inlined window.__APP_BASE__ script), and whitespace/unicode that silently
  // produce malformed URLs.
  const rawBase = (process.env["APP_BASE_PATH"] ?? "/").trim();
  let appBasePath = "/";
  if (rawBase !== "" && rawBase !== "/") {
    if (!/^[A-Za-z0-9/_-]+$/.test(rawBase)) {
      logger.warn(
        { rawBase },
        "APP_BASE_PATH contains disallowed characters (allowed: A-Z a-z 0-9 / _ -); ignoring and serving at root",
      );
    } else {
      appBasePath = "/" + rawBase.replace(/^\/+|\/+$/g, "") + "/";
    }
  }

  // Escape `<` so the inlined string can't break out of the <script> context.
  // JSON.stringify does NOT escape `<`; operator-controlled values that slip
  // past the allowlist above would otherwise create stored-XSS. Defence in
  // depth — with validation above, this is theoretically unreachable.
  const basePathForScript = JSON.stringify(appBasePath).replace(/</g, "\\u003c");
  const demoModeActive = isDemoMode();

  function buildIndexHtml(): string {
    const raw = readFileSync(path.resolve(staticDir, "index.html"), "utf-8");
    if (appBasePath === "/" && !demoModeActive) return raw;

    // Rewrite any absolute /assets/... reference to ${base}assets/... when a
    // sub-path is configured.
    const afterAssets = appBasePath === "/"
      ? raw
      : raw.replace(/(src|href)="\/assets\//g, `$1="${appBasePath}assets/`);

    // Build the inline globals script — APP_BASE and DEMO_MODE — so the web
    // bundle's API/WS calls + banner rendering agree with the server. Only
    // emits an assignment line when the value is non-default; empty script
    // when neither is set. Fail fast at boot if we can't find <head>, so a
    // silent HTML template regression doesn't ship broken demo UX.
    const globals: string[] = [];
    if (appBasePath !== "/") globals.push(`window.__APP_BASE__=${basePathForScript}`);
    if (demoModeActive) globals.push(`window.__DEMO_MODE__=true`);
    if (globals.length === 0) return afterAssets;

    const inlineScript = `<script>${globals.join(";")};</script>`;
    let injected = false;
    const finalHtml = afterAssets.replace(/<head(\s[^>]*)?>/i, (m) => {
      injected = true;
      return `${m}${inlineScript}`;
    });
    if (!injected) {
      throw new Error(
        "<head> tag not found in index.html; can't inject runtime globals (APP_BASE_PATH / DEMO_MODE)",
      );
    }
    return finalHtml;
  }

  // Warm the cache at startup so: (1) readFileSync failures fail fast, (2) no
  // request path does sync I/O, (3) the <head> injection assertion above runs
  // deterministically before we accept traffic.
  const cachedIndexHtml = buildIndexHtml();

  // Serve static assets at both the root (for the ingress-rewritten case) and
  // optionally under the configured base path (for direct access without a
  // rewriting proxy, e.g. local testing with `-p 3000:3000` and /dops/).
  //
  // `index: false` is CRUCIAL: without it, express.static serves index.html
  // directly from disk for GET / (as the directory index), which bypasses
  // the SPA catch-all and our sub-path rewriting entirely.
  app.use(express.static(staticDir, { index: false }));
  if (appBasePath !== "/") {
    app.use(appBasePath, express.static(staticDir, { index: false }));
  }

  // SPA catch-all: serve the cached (rewritten) index.html for any non-API
  // GET/HEAD that wasn't matched by static files. Enables client-side routing
  // (e.g. /investigations/:id, /services, /settings) AND sub-path deploys.
  //
  // `Cache-Control: no-cache` on index.html: content-hashed asset filenames
  // are safe to cache indefinitely, but index.html references those hashes by
  // name, so a stale cached index.html after redeploy would load the wrong
  // bundle version.
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path.startsWith("/api/") || req.path.startsWith("/ws")) return next();
    if (appBasePath !== "/" && req.path.startsWith(`${appBasePath}ws`)) return next();
    res.set("Cache-Control", "no-cache, must-revalidate");
    res.type("html").send(cachedIndexHtml);
  });

  logger.info({ appBasePath }, "static file serving configured");

  // Start all per-stack health pollers (staggered) + scan schedulers.
  // Both are skipped in demo mode — pollers would query stub MCP providers
  // and produce garbage health transitions; the scan scheduler would run
  // the probe on a cron and (if a rule tripped) try to launch an LLM
  // investigation, which demo mode forbids anyway.
  if (!isDemoMode()) {
    stackManager.startAllPollers();
    // Kick off the TTL reaper — marks idle stacks inactive (30d) and
    // soft-deletes long-dormant ones (60d). Runs once immediately, then hourly.
    stackManager.startTtlReaper();
  } else {
    logger.info("demo mode: skipping health pollers, scan schedulers, and TTL reaper");
  }

  server.listen(port, () => {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, "../../package.json"), "utf-8"));
    const ver = pkg.version ?? "unknown";
    logger.info({ port, version: ver }, `dops-assistant v${ver} web server running on port ${port}`);
  });

  const shutdown = async () => {
    logger.info("Shutting down...");
    stopHealthMonitor();
    stackManager.stopAllPollers();
    stackManager.stopTtlReaper();
    stackManager.destroyAllMemory();
    // Close SMTP connection pool if the email transport was lazily constructed.
    // Nodemailer's close() is synchronous and a no-op on non-pooled transports.
    try { emailTransport?.close(); } catch { /* best-effort on shutdown */ }
    db.close();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.error(err, "Failed to start web server");
  process.exit(1);
});
