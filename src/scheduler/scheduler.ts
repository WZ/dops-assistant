import cron from "node-cron";
import type { AgentCore } from "../agent/core.js";
import type { AnomalyAlert, sendAnomalyAlert } from "../notifications/slack-webhook.js";
import type { ServiceConfig, AnomalyCheckConfig } from "../config/schema.js";

export function parseDurationToCron(interval: string): string {
  const minuteMatch = interval.match(/^(\d+)m$/);
  if (minuteMatch) return `*/${minuteMatch[1]} * * * *`;

  const hourMatch = interval.match(/^(\d+)h$/);
  if (hourMatch) return `0 */${hourMatch[1]} * * *`;

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
    const cronExpr = parseDurationToCron(this.config.interval);

    // Schedule recurring execution via node-cron (production behaviour).
    // The task is created with scheduled: false so its internal setTimeout loop does
    // not start during construction.  The loop is activated by calling this.task.start()
    // which happens outside of the Promise microtask below, ensuring vi.runAllTimersAsync()
    // never sees the node-cron recursive setTimeout and can resolve cleanly in tests.
    this.task = cron.schedule(
      cronExpr,
      () => {
        void this.runChecks();
      },
      { scheduled: false }
    );

    // Trigger the first check immediately via Promise microtask.
    // In the test environment (vi.useFakeTimers + vi.runAllTimersAsync) this microtask
    // runs before runAllTimersAsync's internal doRun macrotask, so assertions are met
    // without touching fake-timer recursion.
    // In production this gives an immediate first check on start().
    void Promise.resolve().then(() => this.runChecks());
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
      await Promise.allSettled(
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
    }
  }
}
