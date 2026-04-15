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
    // 1. Validate bearer token
    if (config.secret) {
      const authHeader = req.headers.authorization;
      if (!authHeader || authHeader !== `Bearer ${config.secret}`) {
        res.status(401).json({ error: "Invalid or missing authorization token" });
        return;
      }
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
      logger.warn({ labels: alert.labels }, "Alert webhook: could not match service from labels");
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
    logger.info({ service: service.name, template, alertName }, "Alert webhook: starting headless investigation");
    try {
      await runner.run({
        service,
        message: messageParts.filter(Boolean).join("\n"),
        template,
        stackId,
        readOnlyTools: true,
      });
    } catch (err) {
      logger.error({ err, service: service.name }, "Alert webhook: headless investigation failed");
    } finally {
      dedup.markCompleted();
    }
  };
}
