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
  for (const key of SERVICE_LABEL_KEYS) {
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

// ── Core alert processing (shared between HTTP path and internal callers) ───

/** Outcome of running an alert through the post-auth pipeline. */
export type AlertDeliveryStatus =
  | "investigated"
  | "no_firing"
  | "no_service_match"
  | "deduplicated"
  | "concurrency_skipped"
  | "failed";

export interface ProcessFiringAlertResult {
  deliveryStatus: AlertDeliveryStatus;
  service?: string;
  alertName?: string;
  severity?: string;
  template?: InvestigationTemplate;
  /** Set when deliveryStatus === "concurrency_skipped". */
  activeCount?: number;
  /** Set when deliveryStatus === "concurrency_skipped". */
  maxConcurrent?: number;
  /** Set when deliveryStatus === "investigated". */
  investigationStarted?: boolean;
}

export interface ProcessFiringAlertDeps {
  runner: InvestigationRunner;
  config: WebhookConfig;
  services: ServiceConfig[];
  stackId: string;
  dedup: InvestigationDedup;
  /** Sender name resolved from the bearer token. Used for the alert_received
   *  event log entry; "internal" for synthesized test alerts. */
  sender: string;
}

/**
 * Run an Alertmanager payload through the post-auth pipeline: service match,
 * dedup + concurrency check, eventLog emission, headless investigation.
 *
 * Pulled out of `createWebhookHandler` so the upcoming
 * `POST /api/webhooks/test` endpoint can drive the same logic without
 * synthesizing a fake `Request`/`Response` pair. The HTTP path keeps its
 * bearer auth and response shaping above this; this function is pure
 * post-auth orchestration.
 *
 * Emits one `alert_received` event per call regardless of outcome, with
 * `meta.deliveryStatus` carrying the result. Pre-fix only the accepted
 * path emitted, which made the activity log silent on dedup/concurrency
 * skips — exactly the cases an operator wants to see.
 */
export async function processFiringAlert(
  payload: ValidatedAlertPayload,
  deps: ProcessFiringAlertDeps,
  options: { hiddenServices?: Set<string> } = {},
): Promise<ProcessFiringAlertResult> {
  const { runner, config, stackId, dedup, sender } = deps;
  const visibleServices = options.hiddenServices && options.hiddenServices.size > 0
    ? deps.services.filter(s => !options.hiddenServices!.has(s.name))
    : deps.services;

  const firingAlerts = payload.alerts.filter(a => a.status === "firing");
  if (firingAlerts.length === 0) {
    return { deliveryStatus: "no_firing" };
  }

  const alert = firingAlerts[0]!;
  const alertName = alert.labels["alertname"] ?? "unknown";
  const severity = alert.labels["severity"] ?? "unknown";

  const service = extractServiceFromAlert(alert, visibleServices);
  if (!service) {
    logger.warn({ labels: alert.labels, sender }, "Alert webhook: could not match service from labels");
    eventLog.append({
      kind: "alert_received",
      severity: "warn",
      summary: `alert · ${alertName} · no service match`,
      stackId,
      meta: { source: "alertmanager", sender, deliveryStatus: "no_service_match", alertName, alertSeverity: severity },
    });
    return { deliveryStatus: "no_service_match", alertName, severity };
  }

  const dedupCheck = dedup.shouldInvestigate(stackId, service.name);
  if (!dedupCheck.allowed) {
    const activeCount = dedup.getActiveCount();
    const reachedConcurrencyLimit = activeCount >= config.maxConcurrent;
    const deliveryStatus: AlertDeliveryStatus = reachedConcurrencyLimit
      ? "concurrency_skipped"
      : "deduplicated";
    if (reachedConcurrencyLimit) {
      logger.warn({ activeCount, maxConcurrent: config.maxConcurrent, service: service.name }, "Alert webhook: concurrency limit reached");
    } else {
      logger.info({ service: service.name }, "Alert webhook: dedup — investigation already running/recent");
    }
    eventLog.append({
      kind: "alert_received",
      severity: "info",
      summary: `alert · ${alertName} · ${service.name} · ${deliveryStatus}`,
      stackId,
      service: service.name,
      meta: { source: "alertmanager", sender, deliveryStatus, alertName, alertSeverity: severity },
    });
    return {
      deliveryStatus,
      service: service.name,
      alertName,
      severity,
      ...(reachedConcurrencyLimit ? { activeCount, maxConcurrent: config.maxConcurrent } : {}),
    };
  }

  dedup.markStarted(stackId, service.name);
  const template = resolveTemplate(alert, config);
  const summary = alert.annotations["summary"] ?? alert.annotations["description"] ?? "";

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

  logger.info({ service: service.name, template, alertName, sender }, "Alert webhook: starting headless investigation");
  eventLog.append({
    kind: "alert_received",
    severity: "warn",
    summary: `alert · ${alertName} · ${service.name}`,
    stackId,
    service: service.name,
    meta: { source: "alertmanager", sender, deliveryStatus: "investigated", alertName, alertSeverity: severity },
  });

  // Background run — caller does not await this, but we still need the
  // dedup slot released regardless of outcome. The promise resolves with
  // whatever the runner produces; errors are logged here.
  void (async () => {
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
  })();

  return {
    deliveryStatus: "investigated",
    service: service.name,
    alertName,
    severity,
    template,
    investigationStarted: true,
  };
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
 * Mask a webhook bearer token for display in the GUI. Schema floor of 16 chars
 * (see WebhookSchema in src/config/schema.ts) means `${first4}…${last4}` always
 * leaves an 8-char gap minimum. The legacy `secret` is exempt from min(16) for
 * backwards compatibility with existing deployments — short legacy secrets get
 * the full-hide treatment.
 */
export function maskToken(token: string): string {
  if (token.length < 16) return "<short token, edit config.yaml to view>";
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

/**
 * The label keys the alertname-extraction routine probes when matching a
 * service. Exported for `/api/webhooks/info` so the GUI's "What dops expects"
 * panel renders the actual contract operators must label their alerts with —
 * pre-fix the only way to know was reading webhook-handler source.
 */
export const SERVICE_LABEL_KEYS = ["service", "service_name", "app", "job", "deployment"] as const;

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
  const dedup = deps.dedup ?? new InvestigationDedup({
    dedupWindowSeconds: config.dedupWindowSeconds,
    maxConcurrent: config.maxConcurrent,
  });

  return async (req: Request, res: Response): Promise<void> => {
    // 1. Validate bearer token.
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

    // 3. Hand off to the shared post-auth pipeline.
    const result = await processFiringAlert(
      payload,
      { runner, config, services: deps.services, stackId, dedup, sender },
      { hiddenServices: deps.getHiddenServices?.() },
    );

    switch (result.deliveryStatus) {
      case "no_firing":
        res.status(200).json({ message: "No firing alerts, nothing to investigate" });
        return;
      case "no_service_match":
        res.status(422).json({ error: "Could not identify service from alert labels" });
        return;
      case "concurrency_skipped":
        res.status(429).json({
          error: "Too many concurrent investigations",
          activeCount: result.activeCount,
          maxConcurrent: result.maxConcurrent,
        });
        return;
      case "deduplicated":
        res.status(200).json({
          message: "Investigation already in progress for this service",
          service: result.service,
        });
        return;
      case "investigated":
        res.status(202).json({
          message: "Investigation started",
          service: result.service,
          template: result.template,
          alertName: result.alertName,
        });
        return;
      case "failed":
        res.status(500).json({ error: "Failed to start investigation" });
        return;
    }
  };
}
