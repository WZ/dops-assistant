/**
 * Alert webhook handler — receives Alertmanager v4 payloads and triggers
 * headless investigations.
 *
 * Request flow:
 *   POST /api/webhook/alert
 *     → validate bearer token
 *     → parse Alertmanager payload
 *     → match service from alert labels
 *     → check dedup window (skip if same service investigated recently)
 *     → check concurrency limit
 *     → return 202 Accepted
 *     → run investigation in background (headless, DB-only callbacks)
 */

import type { Request, Response } from "express";
import { createLogger } from "../logger.js";
import type { WebhookConfig, ServiceConfig, InvestigationTemplate } from "../config/schema.js";
import type { InvestigationRunner } from "./investigation-runner.js";
import { InvestigationDedup } from "./investigation-dedup.js";
import { matchServiceFromText } from "../agents/intent.js";
import { AlertPayloadSchema, type ValidatedAlertPayload } from "./sanitize.js";
import { wrapUntrusted } from "../agents/shared/prompt-helpers.js";
import { eventLog } from "./event-log.js";

const logger = createLogger();

// ── Alertmanager payload types ──────────────────────────────────────────────

interface AlertmanagerAlert {
  status: "firing" | "resolved";
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt?: string;
  endsAt?: string;
}

interface AlertmanagerPayload {
  version: string;
  groupKey: string;
  status: "firing" | "resolved";
  receiver: string;
  alerts: AlertmanagerAlert[];
}

// ── Service extraction from alert ───────────────────────────────────────────

function extractServiceFromAlert(alert: AlertmanagerAlert, services: ServiceConfig[]): ServiceConfig | undefined {
  // Try common label keys for service identification
  const serviceLabels = ["service", "service_name", "app", "job", "deployment"];
  for (const key of serviceLabels) {
    const value = alert.labels[key];
    if (value) {
      const match = matchServiceFromText(value, services);
      if (match) return match;
    }
  }
  // Fall back to matching the alertname + all labels as text
  const labelText = Object.values(alert.labels).join(" ");
  return matchServiceFromText(labelText, services);
}

function resolveTemplate(alert: AlertmanagerAlert, config: WebhookConfig): InvestigationTemplate {
  const severity = alert.labels["severity"];
  if (severity && config.severityTemplateMap?.[severity]) {
    return config.severityTemplateMap[severity]!;
  }
  return config.defaultTemplate;
}

// ── Handler factory ─────────────────────────────────────────────────────────

export interface WebhookHandlerDeps {
  runner: InvestigationRunner;
  config: WebhookConfig;
  services: ServiceConfig[];
  /** Stack ID for multi-stack data isolation */
  stackId?: string;
  /** Optional shared dedup instance. If not provided, one is created internally. */
  dedup?: InvestigationDedup;
  /** Optional getter for hidden services — alerts for hidden services are ignored */
  getHiddenServices?: () => Set<string>;
}

/**
 * AP9: Shared 503 body for the "webhook auth is unset" path. Exported so
 * `src/server/index.ts`'s fallback stub (the route registered when neither
 * `webhook.secret` nor `webhook.tokens` is configured) emits the same
 * operator-facing hint as this handler. Two sources of truth for
 * operator-facing text always drift.
 *
 * The hint mentions both forms because the legacy single-token path
 * (`webhook.secret`) and the per-sender path (`webhook.tokens.<name>`) are
 * both supported — operators can use either or both.
 */
export const WEBHOOK_NOT_CONFIGURED_BODY = {
  error: "Webhook not configured",
  hint: "Set webhook.secret (or webhook.tokens.<sender>) in config.yaml under the webhook section and restart the server",
} as const;

/** True when at least one auth credential (legacy `secret` or named token) is configured. */
export function isWebhookAuthConfigured(config: WebhookConfig): boolean {
  if (config.secret) return true;
  return Boolean(config.tokens && Object.keys(config.tokens).length > 0);
}

/**
 * Resolve the bearer header to a sender name, or null if the token is not
 * recognised. The legacy `secret` resolves to the sender name "default";
 * tokens in `webhook.tokens` resolve to their map key. Used to attribute
 * webhook calls in logs and the event log so a noisy source can be traced
 * and revoked without rotating tokens for everyone.
 *
 * Plain `===` rather than constant-time compare, matching the rest of the
 * auth posture in this server. Bearer tokens are random ≥32-byte strings,
 * so timing leakage is bounded by the longest matching prefix.
 */
function resolveSender(authHeader: string | undefined, config: WebhookConfig): string | null {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const presented = authHeader.slice("Bearer ".length);
  if (config.secret && presented === config.secret) return "default";
  if (config.tokens) {
    for (const [name, token] of Object.entries(config.tokens)) {
      if (presented === token) return name;
    }
  }
  return null;
}

export function createWebhookHandler(deps: WebhookHandlerDeps) {
  const { runner, config } = deps;
  const stackId = deps.stackId ?? "";
  // Filter hidden services from alert matching
  const getVisibleServices = () => {
    const hidden = deps.getHiddenServices?.() ?? new Set<string>();
    return hidden.size > 0 ? deps.services.filter(s => !hidden.has(s.name)) : deps.services;
  };
  const dedup = deps.dedup ?? new InvestigationDedup({
    dedupWindowSeconds: config.dedupWindowSeconds,
    maxConcurrent: config.maxConcurrent,
  });

  return async (req: Request, res: Response): Promise<void> => {
    // 1. Validate bearer token.
    // Without configured auth we respond 503 instead of silently accepting
    // traffic — this endpoint is unauthenticated-by-omission otherwise, and
    // without the clear hint operators were seeing Express's default HTML 404
    // ("Cannot POST /api/webhook/alert") in the QA logs, which looks like the
    // route is missing rather than misconfigured.
    if (!isWebhookAuthConfigured(config)) {
      res.status(503).json(WEBHOOK_NOT_CONFIGURED_BODY);
      return;
    }
    const sender = resolveSender(req.headers.authorization, config);
    if (!sender) {
      res.status(401).json({ error: "Invalid or missing authorization token" });
      return;
    }

    // 2. Parse and validate payload through Zod schema
    let payload: ValidatedAlertPayload;
    try {
      const result = AlertPayloadSchema.safeParse(req.body);
      if (!result.success) {
        const errors = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
        res.status(400).json({ error: "Invalid alert payload", details: errors });
        return;
      }
      payload = result.data;
    } catch {
      res.status(400).json({ error: "Invalid JSON payload" });
      return;
    }

    // Only process firing alerts
    const firingAlerts = payload.alerts.filter(a => a.status === "firing");
    if (firingAlerts.length === 0) {
      res.status(200).json({ message: "No firing alerts, nothing to investigate" });
      return;
    }

    // Process the first firing alert (dedup handles the rest)
    const alert = firingAlerts[0]!;

    // 3. Match service (exclude hidden services)
    const service = extractServiceFromAlert(alert, getVisibleServices());
    if (!service) {
      logger.warn({ labels: alert.labels, sender }, "Alert webhook: could not match service from labels");
      res.status(422).json({ error: "Could not identify service from alert labels" });
      return;
    }

    // 4. Dedup + concurrency check
    if (!dedup.shouldInvestigate(stackId, service.name).allowed) {
      const activeCount = dedup.getActiveCount();
      if (activeCount >= config.maxConcurrent) {
        logger.warn({ activeCount, maxConcurrent: config.maxConcurrent }, "Alert webhook: concurrency limit reached");
        res.status(429).json({ error: "Too many concurrent investigations", activeCount, maxConcurrent: config.maxConcurrent });
      } else {
        logger.info({ service: service.name }, "Alert webhook: dedup — investigation already running/recent");
        res.status(200).json({ message: "Investigation already in progress for this service", service: service.name });
      }
      return;
    }

    // 5. Mark as in-progress and respond immediately
    dedup.markStarted(stackId, service.name);
    const template = resolveTemplate(alert, config);
    const alertName = alert.labels["alertname"] ?? "unknown";
    const severity = alert.labels["severity"] ?? "unknown";
    const summary = alert.annotations["summary"] ?? alert.annotations["description"] ?? "";

    res.status(202).json({
      message: "Investigation started",
      service: service.name,
      template,
      alertName,
    });

    // 6. Build enriched message from alert metadata + service config
    const contextLabels = Object.entries(alert.labels)
      .filter(([k]) => !["alertname", "severity", "__name__"].includes(k))
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");

    const messageParts = [
      `Alert: ${wrapUntrusted("alert_name", alertName)} (severity: ${wrapUntrusted("alert_severity", severity)})`,
      `Service: ${service.name}`,
      summary ? `Summary: ${wrapUntrusted("alert_summary", summary)}` : "",
      contextLabels ? `Labels: ${wrapUntrusted("alert_labels", contextLabels)}` : "",
    ];
    if (service.metrics?.length) {
      messageParts.push(`Known metrics: ${service.metrics.map(m => m.query).slice(0, 3).join(", ")}`);
    }
    if (service.logLabels && Object.keys(service.logLabels).length > 0) {
      const labels = Object.entries(service.logLabels).map(([k, v]) => `${k}="${v}"`).join(",");
      messageParts.push(`Log selector: {${labels}}`);
    }

    // 7. Run investigation in background (headless — no WS callbacks)
    logger.info({ service: service.name, template, alertName, sender }, "Alert webhook: starting headless investigation");
    eventLog.append({
      kind: "alert_received",
      severity: "warn",
      summary: `alert · ${alertName} · ${service.name}`,
      stackId,
      service: service.name,
      meta: { source: "alertmanager", sender },
    });
    try {
      await runner.run({
        service,
        message: messageParts.filter(Boolean).join("\n"),
        template,
        stackId,
        readOnlyTools: true,
        source: "webhook",
      });
    } catch (err) {
      logger.error({ err, service: service.name }, "Alert webhook: headless investigation failed");
    } finally {
      dedup.markCompleted();
    }
  };
}
