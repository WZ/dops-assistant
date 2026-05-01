import { Cron } from "croner";
import { createLogger } from "../logger.js";
import type { MastraProvider } from "../mcp/provider.js";
import type { ServiceRegistryStore } from "../services/registry.js";
import type { DiscoveryConfig } from "../config/schema.js";
import type { PendingDiscoveryStore } from "./pending-discovery-store.js";
import type { DiscoveryResult } from "../types/agent-interfaces.js";
import type { LlmRetryConfig } from "../agents/shared/llm-retry.js";
import type { InstantResult } from "./instant-query.js";

const logger = createLogger("periodic-discovery-scheduler");

export interface PeriodicDiscoverySettings {
  enabled: boolean;
  cron: string;
  timezone: string;
  consensusRuns: number;
  consensusRunsForRemovals: number;
}

export interface PeriodicDiscoverySchedulerDeps {
  store: PendingDiscoveryStore;
  stackId: string;
  providers: () => MastraProvider[];
  getPrometheusDatasourceUid: () => string | undefined;
  registryStore: ServiceRegistryStore;
  runDiscovery: (args: {
    discoveryConfig: DiscoveryConfig;
    providers: MastraProvider[];
    onTokenUsage?: (u: { inputTokens: number; outputTokens: number }) => void;
    llmRetry?: LlmRetryConfig;
  }) => Promise<DiscoveryResult>;
  notifySlack: (msg: string) => Promise<{ ok: boolean; error?: string }>;
  notifyEmail: (msg: string) => Promise<{ ok: boolean; error?: string }>;
  /** Wired by stack-manager — passes the metrics MCP tool through. */
  sanityProbe?: (query: string) => Promise<InstantResult>;
  /** Same primitive but for removal corroboration. */
  removalCorroborationProbe?: (query: string) => Promise<InstantResult>;
  settings: PeriodicDiscoverySettings;
  discoveryConfig?: DiscoveryConfig;
  llmRetry?: LlmRetryConfig;
}

export interface TickOutcome {
  skipped?: boolean;
  reason?: string;
  runId?: string;
}

export class PeriodicDiscoveryScheduler {
  private deps: PeriodicDiscoverySchedulerDeps;
  private cronJob: Cron | null = null;
  private ticking = false;
  private lastError: string | null = null;
  private lastRun: string | null = null;

  constructor(deps: PeriodicDiscoverySchedulerDeps) {
    this.deps = deps;
    deps.store.resetOrphanedRunningRuns();
  }

  start(): void {
    this.stop();
    const s = this.deps.settings;
    if (!s.enabled || !s.cron) {
      logger.info({ stackId: this.deps.stackId }, "periodic-discovery: disabled");
      return;
    }
    this.cronJob = new Cron(s.cron, { timezone: s.timezone, protect: true }, () => {
      this.tickOnce().catch((err) => {
        logger.error({ err, stackId: this.deps.stackId }, "periodic-discovery: tick failed");
      });
    });
    logger.info({ stackId: this.deps.stackId, cron: s.cron, timezone: s.timezone }, "periodic-discovery: started");
  }

  stop(): void {
    if (this.cronJob) { this.cronJob.stop(); this.cronJob = null; }
  }

  /** Replace settings and bounce the cron job. Used after PUT /api/discovery/settings. */
  restart(settings: PeriodicDiscoverySettings): void {
    this.deps.settings = settings;
    this.start();
  }

  status() {
    return {
      enabled: this.deps.settings.enabled,
      cron: this.deps.settings.cron,
      timezone: this.deps.settings.timezone,
      nextRun: this.cronJob?.nextRun()?.toISOString() ?? null,
      lastRun: this.lastRun,
      lastError: this.lastError,
      ticking: this.ticking,
    };
  }

  isTicking(): boolean { return this.ticking; }

  /** Public for "Run now" + tests. */
  async tickOnce(): Promise<TickOutcome> {
    if (this.ticking) return { skipped: true, reason: "tick already in progress" };
    this.ticking = true;
    try {
      const providers = this.deps.providers();
      if (providers.length === 0) {
        const runId = this.deps.store.startRun(this.deps.stackId);
        this.deps.store.finishRun(runId, { status: "skipped", error: "no metrics provider available" });
        return { skipped: true, reason: "no metrics provider available", runId };
      }
      const dsUid = this.deps.getPrometheusDatasourceUid();
      if (!dsUid) {
        const runId = this.deps.store.startRun(this.deps.stackId);
        this.deps.store.finishRun(runId, { status: "skipped", error: "no Prometheus datasource UID" });
        return { skipped: true, reason: "no Prometheus datasource UID", runId };
      }

      const runId = this.deps.store.startRun(this.deps.stackId);
      this.lastRun = new Date().toISOString();
      try {
        let tokensIn = 0, tokensOut = 0;
        const result = await this.deps.runDiscovery({
          discoveryConfig: this.deps.discoveryConfig ?? ({} as DiscoveryConfig),
          providers,
          onTokenUsage: (u) => { tokensIn += u.inputTokens; tokensOut += u.outputTokens; },
          llmRetry: this.deps.llmRetry,
        });
        // Tasks 10–12 add the per-tick processing. For Task 9 we only finalize
        // the run row so the lifecycle test passes.
        this.deps.store.finishRun(runId, {
          status: "success",
          serviceCount: result.services.length,
          tokensInput: tokensIn,
          tokensOutput: tokensOut,
        });
        this.lastError = null;
        return { runId };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.deps.store.finishRun(runId, { status: "failed", error: message });
        this.lastError = message;
        logger.error({ err, stackId: this.deps.stackId, runId }, "periodic-discovery: runDiscovery failed");
        return { runId };
      }
    } finally {
      this.ticking = false;
    }
  }
}
