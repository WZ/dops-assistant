import cron from "node-cron";
import pino from "pino";
import type { AgentCore } from "../agent/core.js";
import type { InvestigationAgent } from "../agent/investigation.js";
import type { sendAnomalyAlert, AnomalyAlert } from "../notifications/slack-webhook.js";
import type { AnomalyAssessment } from "../agent/types.js";
import type { RcaReport } from "../agent/rca-types.js";
import type { ServiceConfig, AnomalyCheckConfig } from "../config/schema.js";
import {
  schedulerChecksTotal,
  alertNotificationsTotal,
} from "../observability/metrics.js";
import { randomUUID } from "node:crypto";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

export function parseDurationToCron(interval: string): string {
  const minuteMatch = interval.match(/^(\d+)m$/);
  if (minuteMatch) {
    const n = parseInt(minuteMatch[1]!, 10);
    if (n === 0)
      throw new Error(
        `Unsupported interval format: "${interval}". Use e.g. "5m" or "1h".`,
      );
    return `*/${n} * * * *`;
  }

  const hourMatch = interval.match(/^(\d+)h$/);
  if (hourMatch) {
    const n = parseInt(hourMatch[1]!, 10);
    if (n === 0)
      throw new Error(
        `Unsupported interval format: "${interval}". Use e.g. "5m" or "1h".`,
      );
    return `0 */${n} * * *`;
  }

  throw new Error(
    `Unsupported interval format: "${interval}". Use e.g. "5m" or "1h".`,
  );
}

export class AlertDeduplicator {
  private lastAlerts = new Map<string, number>();
  private cooldownMs: number;

  constructor(cooldownMinutes: number) {
    this.cooldownMs = cooldownMinutes * 60_000;
  }

  shouldAlert(service: string): boolean {
    const last = this.lastAlerts.get(service);
    return last === undefined || Date.now() - last >= this.cooldownMs;
  }

  record(service: string): void {
    this.lastAlerts.set(service, Date.now());
  }
}

export class Scheduler {
  private config: AnomalyCheckConfig;
  private services: ServiceConfig[];
  private agent: AgentCore;
  private notify: typeof sendAnomalyAlert;
  private task: cron.ScheduledTask | null = null;
  private webhookUrl: string;
  private deduplicator: AlertDeduplicator;
  private investigationAgent?: InvestigationAgent;

  constructor(
    config: AnomalyCheckConfig,
    services: ServiceConfig[],
    agent: AgentCore,
    notify: typeof sendAnomalyAlert,
    webhookUrl = "",
    investigationAgent?: InvestigationAgent,
  ) {
    this.config = config;
    this.services = services;
    this.agent = agent;
    this.notify = notify;
    this.webhookUrl = webhookUrl;
    this.deduplicator = new AlertDeduplicator(
      config.alertCooldownMinutes,
    );
    this.investigationAgent = investigationAgent;
  }

  start(): void {
    if (this.task !== null) return;
    const cronExpr = parseDurationToCron(this.config.interval);
    this.task = cron.schedule(cronExpr, () => {
      void this.runChecks();
    });
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
  }

  private async runChecks(): Promise<void> {
    const targetNames = this.config.services;
    const targets = targetNames
      ? this.services.filter((s) => targetNames.includes(s.name))
      : this.services;

    const limit = this.config.maxConcurrency;
    const chunks: ServiceConfig[][] = [];
    for (let i = 0; i < targets.length; i += limit) {
      chunks.push(targets.slice(i, i + limit));
    }

    for (const chunk of chunks) {
      const results = await Promise.allSettled(
        chunk.map((service) => this.checkService(service)),
      );

      for (const [i, outcome] of results.entries()) {
        if (outcome.status === "rejected") {
          logger.error(
            { err: outcome.reason, service: chunk[i]!.name },
            "Service check failed",
          );
          schedulerChecksTotal.inc({
            service: chunk[i]!.name,
            status: "error",
          });
        }
      }
    }
  }

  /** @internal - exposed for testing only */
  async checkService(service: ServiceConfig): Promise<void> {
    const correlationId = randomUUID().slice(0, 8);
    const log = logger.child({
      component: "scheduler",
      service: service.name,
      correlationId,
    });

    const result = await this.agent.run({
      mode: "proactive",
      message: `Check service: ${service.name}`,
      serviceContext: [service],
      correlationId,
    });

    let assessment: AnomalyAssessment;
    try {
      assessment = JSON.parse(result.response) as AnomalyAssessment;
    } catch {
      log.error({ response: result.response }, "Failed to parse anomaly assessment JSON");
      schedulerChecksTotal.inc({ service: service.name, status: "error" });
      return;
    }

    if (!assessment.isAnomaly) {
      schedulerChecksTotal.inc({ service: service.name, status: "healthy" });
      log.info("Service healthy");
      return;
    }

    schedulerChecksTotal.inc({ service: service.name, status: "anomaly" });

    if (!this.deduplicator.shouldAlert(service.name)) {
      log.info("Anomaly detected but suppressed by cooldown");
      alertNotificationsTotal.inc({ status: "deduplicated" });
      return;
    }

    // Run RCA investigation if available
    let rca: RcaReport | undefined;
    if (this.investigationAgent) {
      try {
        rca = await this.investigationAgent.investigate(service, assessment, correlationId);
        log.info({ confidence: rca.confidence }, "RCA investigation complete");
      } catch (err) {
        log.warn({ err }, "RCA investigation failed, alerting without RCA");
      }
    }

    const alert: AnomalyAlert = {
      service: service.name,
      severity: assessment.severity,
      summary: assessment.summary,
      affectedMetrics: assessment.affectedMetrics,
      recommendedAction: assessment.recommendedAction,
      ...(rca ? { rca } : {}),
    };

    try {
      await this.notify(this.webhookUrl, alert);
      this.deduplicator.record(service.name);
      alertNotificationsTotal.inc({ status: "success" });
      log.info({ severity: assessment.severity }, "Anomaly alert sent");
    } catch (err) {
      alertNotificationsTotal.inc({ status: "error" });
      log.error({ err }, "Failed to send anomaly alert");
    }
  }
}
