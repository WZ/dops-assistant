import { Cron } from "croner";
import { createLogger } from "../logger.js";
import type { MastraProvider } from "../mcp/provider.js";
import type { ServiceRegistryStore } from "../services/registry.js";
import type { DiscoveryConfig, ServiceConfig } from "../config/schema.js";
import type { PendingDiscoveryStore } from "./pending-discovery-store.js";
import type { DiscoveryResult } from "../types/agent-interfaces.js";
import type { LlmRetryConfig } from "../agents/shared/llm-retry.js";
import type { InstantResult } from "./instant-query.js";
import { computeAdditionMutations, computeRemovalMutations } from "./discovery-consensus.js";

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

  // (concurrency helper at bottom of file)

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
        // ── Filter to verified ───────────────────────────────────────────
        const verified = (result.services ?? []).filter(
          (s: any) => s.confidence === "verified",
        ) as Array<ServiceConfig & { confidence?: string }>;

        // ── globals drift WARN (informational) ───────────────────────────
        const currentGlobals = JSON.stringify(this.deps.registryStore.loadAll().globalProbeRules ?? []);
        const runGlobals = JSON.stringify(result.globalProbeRules ?? []);
        if (currentGlobals !== runGlobals) {
          logger.warn(
            { stackId: this.deps.stackId, runId },
            "periodic-discovery: globalProbeRules drift detected — run npm run discover to refresh",
          );
        }

        // ── Sanity probe additions (parallel, capped at 10) ──────────────
        const probe = this.deps.sanityProbe;
        const sanityProbedServices: typeof verified = [];
        if (probe) {
          const tasks = verified.map((svc) => async () => {
            if (!svc.metrics || svc.metrics.length === 0) {
              sanityProbedServices.push(svc);
              return;
            }
            try {
              const r = await probe(svc.metrics[0]!.query);
              if (r.kind === "ok") {
                sanityProbedServices.push(svc);
              } else {
                logger.warn({ service: svc.name, kind: r.kind }, "periodic-discovery: sanity probe drop");
              }
            } catch (err) {
              logger.warn({ err, service: svc.name }, "periodic-discovery: sanity probe threw");
            }
          });
          await runWithConcurrency(tasks, 10);
        } else {
          sanityProbedServices.push(...verified);
        }

        // ── Diff vs registry ────────────────────────────────────────────
        const registry = this.deps.registryStore.loadAll();
        const registeredNames = new Set(registry.services.map((s) => s.name));
        const discoveredByName = new Map(sanityProbedServices.map((s) => [s.name, s]));
        const dismissed = this.deps.store.listDismissed(this.deps.stackId);
        const dismissedAdditionNames = new Set(dismissed.filter((d) => d.changeKind === "addition").map((d) => d.serviceName));
        const dismissedRemovalNames = new Set(dismissed.filter((d) => d.changeKind === "removal").map((d) => d.serviceName));

        const additionCandidates = sanityProbedServices
          .filter((s) => !registeredNames.has(s.name))
          .filter((s) => !dismissedAdditionNames.has(s.name))
          .map((s) => {
            const { confidence: _c, ...rest } = s as any;
            return {
              name: s.name,
              payload: rest as ServiceConfig,
              globalsSnapshot: result.globalProbeRules ?? [],
            };
          });

        // ── Consensus update — additions ────────────────────────────────
        const previousSuccessfulRunId = this.deps.store.getPreviousSuccessfulRunId(this.deps.stackId, runId);
        const pendingAdditionRows = this.deps.store.listPending(this.deps.stackId, "addition")
          .map((r) => ({ id: r.id, serviceName: r.serviceName, seenCount: r.seenCount, lastSeenRunId: r.lastSeenRunId, qualifiedAt: r.qualifiedAt }));
        const versions = (this.deps.registryStore as any).listVersions?.() ?? [];
        const registryVersion = versions.length > 0 ? versions[versions.length - 1].id : "v-initial";

        const additionMutations = computeAdditionMutations({
          stackId: this.deps.stackId,
          thisRunId: runId,
          previousSuccessfulRunId,
          consensusRuns: this.deps.settings.consensusRuns,
          consensusRunsForRemovals: this.deps.settings.consensusRunsForRemovals,
          registeredNames,
          dismissedAdditionNames,
          dismissedRemovalNames,
          pendingAdditionRows,
          pendingRemovalRows: [],
          registryVersion,
          additionCandidates,
          removalCandidates: [],
        });
        for (const c of additionMutations.upsertAdditions) {
          this.deps.store.upsertAddition({
            stackId: this.deps.stackId,
            serviceName: c.name,
            payload: c.payload,
            globalsSnapshot: c.globalsSnapshot,
            runId,
          });
        }
        for (const r of additionMutations.resets) this.deps.store.resetSeenCount(r.id, r.runId);
        for (const id of additionMutations.deletes) this.deps.store.deleteById(id);
        for (const q of additionMutations.qualifications) this.deps.store.markQualified(q.id, q.registryVersion);

        // ── Removal candidates: registered \ discovered ────────────────
        const removalCandidateServices = registry.services
          .filter((s) => !discoveredByName.has(s.name))
          .filter((s) => !dismissedRemovalNames.has(s.name));

        // ── Corroboration probe ─────────────────────────────────────────
        const corroboratedNames = new Set<string>();
        const removalProbe = this.deps.removalCorroborationProbe;
        if (removalProbe && removalCandidateServices.length > 0) {
          const probeTasks = removalCandidateServices.map((svc) => async () => {
            const q = svc.metrics?.[0]?.query;
            if (!q) return;
            try {
              const r = await removalProbe(q);
              if (r.kind === "empty" || (r.kind === "ok" && r.value === 0)) {
                corroboratedNames.add(svc.name);
              }
            } catch {
              // not corroborated
            }
          });
          await runWithConcurrency(probeTasks, 10);
        }

        const removalCandidates = removalCandidateServices.map((s) => ({
          name: s.name,
          corroborated: corroboratedNames.has(s.name),
        }));

        const pendingRemovalRows = this.deps.store.listPending(this.deps.stackId, "removal")
          .map((r) => ({ id: r.id, serviceName: r.serviceName, seenCount: r.seenCount, lastSeenRunId: r.lastSeenRunId, qualifiedAt: r.qualifiedAt }));

        const removalMutations = computeRemovalMutations({
          stackId: this.deps.stackId,
          thisRunId: runId,
          previousSuccessfulRunId,
          consensusRuns: this.deps.settings.consensusRuns,
          consensusRunsForRemovals: this.deps.settings.consensusRunsForRemovals,
          registeredNames,
          dismissedAdditionNames,
          dismissedRemovalNames,
          pendingAdditionRows: [],
          pendingRemovalRows,
          registryVersion,
          additionCandidates: [],
          removalCandidates,
        });
        for (const c of removalMutations.upsertRemovals) {
          this.deps.store.upsertRemoval({ stackId: this.deps.stackId, serviceName: c.name, runId });
        }
        for (const r of removalMutations.resets) this.deps.store.resetSeenCount(r.id, r.runId);
        for (const id of removalMutations.deletes) this.deps.store.deleteById(id);
        for (const q of removalMutations.qualifications) this.deps.store.markQualified(q.id, q.registryVersion);

        // ── Notifications (per-channel idempotent) ────────────────────
        const newlyQualified = [
          ...this.deps.store.listQualified(this.deps.stackId, "addition"),
          ...this.deps.store.listQualified(this.deps.stackId, "removal"),
        ].filter((row) =>
          !this.deps.store.hasSuccessfulNotification(row.id, "slack") ||
          !this.deps.store.hasSuccessfulNotification(row.id, "email")
        );

        for (const row of newlyQualified) {
          const msg = `Discovery ${row.changeKind === "addition" ? "found a new service" : "suggests removing a service"}: ${row.serviceName} (stack ${this.deps.stackId})`;
          if (!this.deps.store.hasSuccessfulNotification(row.id, "slack")) {
            try {
              const r = await this.deps.notifySlack(msg);
              this.deps.store.recordNotificationAttempt(row.id, "slack", r.ok ? "success" : "failed", r.error ?? null);
              if (r.ok) this.deps.store.markNotifiedNow(row.id);
            } catch (err) {
              this.deps.store.recordNotificationAttempt(row.id, "slack", "failed", err instanceof Error ? err.message : String(err));
            }
          }
          if (!this.deps.store.hasSuccessfulNotification(row.id, "email")) {
            try {
              const r = await this.deps.notifyEmail(msg);
              this.deps.store.recordNotificationAttempt(row.id, "email", r.ok ? "success" : "failed", r.error ?? null);
              if (r.ok) this.deps.store.markNotifiedNow(row.id);
            } catch (err) {
              this.deps.store.recordNotificationAttempt(row.id, "email", "failed", err instanceof Error ? err.message : String(err));
            }
          }
        }

        this.deps.store.finishRun(runId, {
          status: "success",
          serviceCount: sanityProbedServices.length,
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

async function runWithConcurrency(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  const queue = tasks.slice();
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (true) {
      const t = queue.shift();
      if (!t) return;
      await t();
    }
  });
  await Promise.all(workers);
}
