/**
 * ScanScheduler — per-stack cron-driven proactive system scan.
 *
 * Lifecycle:
 *   start() → if scan.enabled: schedule Cron, optionally run first tick
 *             (runOnEnable). start() is idempotent.
 *   stop()  → abort in-flight tick, stop the Cron. Idempotent.
 *
 * Each tick:
 *   1. Skip if prev tick still running (no overlap, logged).
 *   2. Skip if metrics MCP provider / datasource unavailable.
 *   3. Run anomaly-probe across all live services.
 *   4. Consecutive-tick hysteresis handled inside probe; it returns only
 *      rules that have been breached for their configured tick count.
 *   5. Per-service dedup pre-check via db.hasRecentInvestigation using
 *      scan.dedupWindowMinutes — separate from the global webhook dedup
 *      window configured on sharedDedup.
 *   6. Prioritize (severity desc, then oldest last-investigated asc).
 *   7. Cap at maxInvestigationsPerTick. Emit onAnomaliesDetected for the
 *      selected hits. Caller owns the dedup-mark / runner / finally.
 *
 * Design doc: ~/.gstack/projects/WZ-dops-assistant/wli02-main-design-20260421-012829.md
 */

import { Cron } from "croner";
import { createLogger } from "../logger.js";
import type { MastraProvider } from "../mcp/provider.js";
import type { ServiceRegistryStore } from "../services/registry.js";
import type { Database } from "./db.js";
import type { ScanConfig } from "../config/schema.js";
import {
  runProbe,
  prioritizeHits,
  type ProbeHit,
} from "./anomaly-probe.js";

const logger = createLogger();

// ── Public types ────────────────────────────────────────────────────────────

export interface ScanStatus {
  enabled: boolean;
  cron: string;
  timezone: string;
  /** ISO timestamp of the next scheduled fire, or null if not running. */
  nextRun: string | null;
  /** ISO timestamp of the last tick that actually ran, or null. */
  lastRun: string | null;
  /** Last error message from a tick, or null if last tick was clean. */
  lastError: string | null;
  /**
   * Count of (service, tick) hits that were flagged by the probe but not
   * fired because maxInvestigationsPerTick was exceeded. Monotonic across
   * the scheduler's lifetime. Useful signal that the cap is too low.
   */
  dropsByConcurrency: number;
  /** Whether a tick is currently executing. */
  ticking: boolean;
}

/** Emitted when the probe flags services above threshold + within cap. */
export interface ScanAnomaliesEvent {
  stackId: string;
  hits: ProbeHit[];
  tickStartedAt: string;
}

export interface ScanSchedulerDeps {
  /** Provider resolution — function so it stays live as registry changes. */
  providers: () => MastraProvider[];
  registryStore: ServiceRegistryStore;
  db: Database;
  stackId: string;
  scan: ScanConfig;
  /** Getter for Prometheus datasource UID (re-read from provider registry). */
  getPrometheusDatasourceUid: () => string | undefined;
  /** Getter for hidden service names — they're excluded from probe. */
  getHiddenServices?: () => Set<string>;
  /**
   * Emitted at the end of each tick with the hits that passed dedup + cap.
   * The caller owns the follow-up (dedup.markStarted → runner.run →
   * dedup.markCompleted). Returning a promise is optional; the scheduler
   * does NOT await it — investigations run in the background so the next
   * tick is not blocked on LLM duration.
   */
  onAnomaliesDetected: (evt: ScanAnomaliesEvent) => void;
}

// ── Scheduler ───────────────────────────────────────────────────────────────

export class ScanScheduler {
  private readonly deps: ScanSchedulerDeps;
  /**
   * Live scan config. Mutated via `reload()` when the operator changes
   * settings in the GUI — lets the scheduler start/stop/re-schedule without
   * a server restart. Starts as a copy of `deps.scan` so reloads don't
   * mutate the caller's snapshot.
   */
  private scan: ScanConfig;
  private cron: Cron | undefined;
  private ac: AbortController | undefined;
  private ticking = false;
  private lastRunIso: string | null = null;
  private lastError: string | null = null;
  private dropsByConcurrency = 0;
  private stopped = false;
  /** (service:ruleName) → consecutive-ticks-breached counter */
  private readonly consecutiveState = new Map<string, number>();

  constructor(deps: ScanSchedulerDeps) {
    this.deps = deps;
    this.scan = deps.scan;
  }

  /**
   * Schedule the cron if scan.enabled. If runOnEnable is true, fires one tick
   * on the next event-loop turn so the operator doesn't wait up to cron-interval
   * hours to see the feature working.
   *
   * Idempotent: calling start() on an already-started scheduler is a no-op.
   */
  start(): void {
    if (this.cron) return;
    if (!this.scan.enabled) return;
    this.stopped = false;

    try {
      this.cron = new Cron(
        this.scan.cron,
        { timezone: this.scan.timezone, protect: true },
        () => { void this.tick(); },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, stackId: this.deps.stackId, cron: this.scan.cron }, "ScanScheduler: invalid cron expression — scheduler not started");
      this.lastError = `Invalid cron: ${msg}`;
      this.cron = undefined;
      return;
    }

    logger.info({
      stackId: this.deps.stackId,
      cron: this.scan.cron,
      timezone: this.scan.timezone,
      nextRun: this.cron.nextRun()?.toISOString(),
      runOnEnable: this.scan.runOnEnable,
    }, "ScanScheduler: started");

    if (this.scan.runOnEnable) {
      // Defer to next tick so start() returns before the first tick begins —
      // avoids surprising callers who expect start() to be synchronous.
      setImmediate(() => { void this.tick(); });
    }
  }

  /** Trigger a tick immediately (e.g. via on-demand API). No-op if disabled. */
  async triggerNow(): Promise<void> {
    if (!this.cron && !this.scan.enabled) return;
    await this.tick();
  }

  /**
   * Abort in-flight work and stop the Cron. Idempotent. Already-dispatched
   * investigations (onAnomaliesDetected already fired) run to completion.
   */
  stop(): void {
    this.stopped = true;
    this.ac?.abort();
    this.cron?.stop();
    this.cron = undefined;
  }

  /**
   * Apply a new scan config at runtime. Called by PUT /api/scan/settings
   * when an operator flips enable/cron/timezone via the GUI. Minimal-work:
   *  - if only non-schedule fields changed (e.g. maxInvestigationsPerTick,
   *    probe rules), just swap the config — the next tick picks it up.
   *  - if enabled flipped on: start()
   *  - if enabled flipped off: stop()
   *  - if cron or timezone changed while running: restart cron with new
   *    expression (tears down the Cron instance; next fire uses the new
   *    schedule).
   *
   * A currently-executing tick is NOT interrupted — it reads `this.scan`
   * at the top of the call path so ongoing work completes against its
   * snapshot. Next tick uses the new config.
   */
  reload(newConfig: ScanConfig): void {
    const prev = this.scan;
    this.scan = newConfig;

    const scheduleChanged =
      prev.cron !== newConfig.cron || prev.timezone !== newConfig.timezone;

    if (prev.enabled && !newConfig.enabled) {
      // Disabled: stop but keep `stopped` logic so start() can re-activate later.
      this.cron?.stop();
      this.cron = undefined;
      this.stopped = false; // allow start() to re-schedule if reload swings back
      logger.info({ stackId: this.deps.stackId }, "ScanScheduler: disabled via reload");
      return;
    }

    if (!prev.enabled && newConfig.enabled) {
      // Enabled for the first time (or after a previous disable): start from clean state.
      logger.info({ stackId: this.deps.stackId }, "ScanScheduler: enabling via reload");
      this.start();
      return;
    }

    if (newConfig.enabled && scheduleChanged) {
      // Still enabled but cadence changed: tear down the Cron and re-schedule.
      this.cron?.stop();
      this.cron = undefined;
      logger.info({
        stackId: this.deps.stackId,
        from: { cron: prev.cron, timezone: prev.timezone },
        to: { cron: newConfig.cron, timezone: newConfig.timezone },
      }, "ScanScheduler: schedule changed via reload");
      this.start();
      return;
    }

    // Non-schedule, non-enable change — e.g. maxInvestigationsPerTick, probe
    // rules, dedup window. Next tick picks up the new `this.scan` automatically.
  }

  getStatus(): ScanStatus {
    return {
      enabled: this.scan.enabled,
      cron: this.scan.cron,
      timezone: this.scan.timezone,
      nextRun: this.cron?.nextRun()?.toISOString() ?? null,
      lastRun: this.lastRunIso,
      lastError: this.lastError,
      dropsByConcurrency: this.dropsByConcurrency,
      ticking: this.ticking,
    };
  }

  // ── Internal tick orchestration ───────────────────────────────────────────

  private async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.ticking) {
      logger.info({ stackId: this.deps.stackId }, "ScanScheduler: skipping tick — previous still running");
      return;
    }

    this.ticking = true;
    this.ac = new AbortController();
    const tickStartedAt = new Date().toISOString();

    try {
      const datasourceUid = this.deps.getPrometheusDatasourceUid();
      if (!datasourceUid) {
        this.lastError = "no Prometheus datasource UID — metrics MCP unavailable";
        logger.info({ stackId: this.deps.stackId }, "ScanScheduler: no Prometheus datasource UID, skipping tick");
        return;
      }

      const hidden = this.deps.getHiddenServices?.() ?? new Set<string>();
      const services = this.deps.registryStore.load()
        .map((s) => s.name)
        .filter((n) => !hidden.has(n));

      if (services.length === 0) {
        logger.info({ stackId: this.deps.stackId }, "ScanScheduler: empty registry, skipping tick");
        this.lastError = null;
        return;
      }

      const rawHits = await runProbe({
        services,
        probe: this.scan.probe,
        providers: this.deps.providers(),
        datasourceUid,
        signal: this.ac.signal,
        consecutiveState: this.consecutiveState,
      });

      if (this.stopped || this.ac.signal.aborted) {
        logger.info({ stackId: this.deps.stackId }, "ScanScheduler: tick aborted");
        return;
      }

      // Pre-dedup: drop hits for services investigated within scan.dedupWindowMinutes
      // This is independent of the global webhook dedup (5min by default) —
      // a scan-dedup of 30min prevents the same service from being investigated
      // every 4 hours if it keeps tripping the same rule.
      const dedupSeconds = this.scan.dedupWindowMinutes * 60;
      const postDedupHits = rawHits.filter((hit) => {
        const recent = this.deps.db.hasRecentInvestigation(this.deps.stackId, hit.service, dedupSeconds);
        if (recent) {
          logger.info({ stackId: this.deps.stackId, service: hit.service, rule: hit.ruleName }, "ScanScheduler: skipping — recently investigated");
        }
        return !recent;
      });

      // Prioritize and cap
      const prioritized = prioritizeHits(postDedupHits, (service) =>
        this.deps.db.getLastInvestigationAt(this.deps.stackId, service),
      );
      const cap = this.scan.maxInvestigationsPerTick;
      const selected = prioritized.slice(0, cap);
      const dropped = prioritized.length - selected.length;
      if (dropped > 0) {
        this.dropsByConcurrency += dropped;
        logger.info({
          stackId: this.deps.stackId,
          flagged: prioritized.length,
          fired: selected.length,
          dropped,
          droppedServices: prioritized.slice(cap).map((h) => h.service),
        }, "ScanScheduler: per-tick cap reached, deferring overflow to next tick");
      }

      if (selected.length > 0) {
        this.deps.onAnomaliesDetected({
          stackId: this.deps.stackId,
          hits: selected,
          tickStartedAt,
        });
      }

      this.lastError = null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, stackId: this.deps.stackId }, "ScanScheduler: tick failed");
      this.lastError = msg;
    } finally {
      this.lastRunIso = tickStartedAt;
      this.ticking = false;
      this.ac = undefined;
    }
  }
}
