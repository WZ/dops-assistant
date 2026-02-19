import cron from "node-cron";
import pino from "pino";
import type { AgentCore } from "../agent/core.js";
import type { AnomalyAlert, sendAnomalyAlert } from "../notifications/slack-webhook.js";
import type { ServiceConfig, AnomalyCheckConfig } from "../config/schema.js";

const logger = pino({ level: "info" });

export function parseDurationToCron(interval: string): string {
  const minuteMatch = interval.match(/^(\d+)m$/);
  if (minuteMatch) {
    const n = parseInt(minuteMatch[1], 10);
    if (n === 0) throw new Error(`Unsupported interval format: "${interval}". Use e.g. "5m" or "1h".`);
    return `*/${n} * * * *`;
  }

  const hourMatch = interval.match(/^(\d+)h$/);
  if (hourMatch) {
    const n = parseInt(hourMatch[1], 10);
    if (n === 0) throw new Error(`Unsupported interval format: "${interval}". Use e.g. "5m" or "1h".`);
    return `0 */${n} * * *`;
  }

  throw new Error(`Unsupported interval format: "${interval}". Use e.g. "5m" or "1h".`);
}

function isAnomaly(response: string): boolean {
  const lower = response.toLowerCase();
  return !lower.includes("healthy") && !lower.includes("no anomalies");
}

export class Scheduler {
  private config: AnomalyCheckConfig;
  private services: ServiceConfig[];
  private agent: AgentCore;
  private notify: typeof sendAnomalyAlert;
  private task: cron.ScheduledTask | null = null;
  private webhookUrl: string;

  constructor(
    config: AnomalyCheckConfig,
    services: ServiceConfig[],
    agent: AgentCore,
    notify: typeof sendAnomalyAlert,
    webhookUrl = ""
  ) {
    this.config = config;
    this.services = services;
    this.agent = agent;
    this.notify = notify;
    this.webhookUrl = webhookUrl;
  }

  start(): void {
    if (this.task !== null) return; // already running
    const cronExpr = parseDurationToCron(this.config.interval);
    this.task = cron.schedule(cronExpr, () => {
      void this.runChecks();
    });
    // task.start() is called automatically by cron.schedule() unless scheduled: false is passed
    // The task is now running and will fire at each cron tick
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
        chunk.map(async (service) => {
          const result = await this.agent.run({
            mode: "proactive",
            message: `Check service: ${service.name}`,
            serviceContext: [service],
          });

          if (isAnomaly(result.response)) {
            const alert: AnomalyAlert = {
              service: service.name,
              severity: "medium",
              summary: result.response,
            };
            await this.notify(this.webhookUrl, alert);
          }
        })
      );

      for (const [i, outcome] of results.entries()) {
        if (outcome.status === "rejected") {
          logger.error({ err: outcome.reason, service: chunk[i].name }, "Service check failed");
        }
      }
    }
  }
}
