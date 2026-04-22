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
import type { ProbeMetricRule, ScanConfig } from "../config/schema.js";
import {
  runProbe,
  prioritizeHits,
  type ProbeHit,
} from "./anomaly-probe.js";
import { parseOverride } from "./scan-service-override.js";

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
  /**
   * Optional getter for Loki datasource UID. When undefined, log-source
   * probe rules and the probe.logs fallback both score NaN (no trip) —
   * metrics-source tracks continue unaffected. Re-read per tick so
   * operators can wire Loki later without restarting.
   */
  getLokiDatasourceUid?: () => string | undefined;
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

    // Reset hysteresis state for any rule that was removed, renamed, or
    // whose query/threshold changed. Services that were mid-breach under
    // an old rule shouldn't suddenly fire an investigation under a new
    // rule just because the name carries over. Unchanged rules keep
    // their counters so reload doesn't lose the breach momentum.
    this.resetHysteresisForChangedRules(prev.probe.metrics, newConfig.probe.metrics);

    const scheduleChanged =
      prev.cron !== newConfig.cron || prev.timezone !== newConfig.timezone;

    if (prev.enabled && !newConfig.enabled) {
      // Disabled: match stop()'s behavior so an in-flight tick is actually
      // cancelled — otherwise operator disables via GUI, the already-started
      // probe finishes, and investigations still fire from that tick's
      // scored hits. That's confusing UX at best (operator thinks "off"
      // means "no more firing") and wasteful LLM spend at worst.
      this.ac?.abort();
      this.cron?.stop();
      this.cron = undefined;
      // Don't set `stopped = true` here — the scheduler is *logically*
      // still alive, just with enabled=false. A subsequent reload with
      // enabled=true should re-start via start() (which gates on the new
      // config, not on `stopped`).
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

  /**
   * Drop all `consecutiveState` entries for a given service. Called when the
   * per-service override changes (set or cleared) — we can't cheaply diff the
   * before/after rule sets (the old override shape isn't known here), so the
   * safe move is to reset every counter for that service. The operator's
   * intent is "this service's rules just changed", so starting fresh matches
   * the behavior we already provide for global-rule changes.
   *
   * Keys are `"{service}:{origin}:{ruleName}"` (Slice C, origin-namespaced
   * for independent per-track hysteresis). Service always lives in the
   * leading segment, so a prefix match is sufficient and avoids any
   * ambiguity about how many colons are in the tail.
   */
  resetHysteresisForService(service: string): void {
    let cleared = 0;
    const prefix = service + ":";
    for (const key of Array.from(this.consecutiveState.keys())) {
      if (key.startsWith(prefix)) {
        this.consecutiveState.delete(key);
        cleared++;
      }
    }
    if (cleared > 0) {
      logger.info({ stackId: this.deps.stackId, service, clearedKeys: cleared }, "ScanScheduler: cleared hysteresis state for per-service override change");
    }
  }

  /**
   * Drop `consecutiveState` entries whose rule was removed or materially
   * changed. A rule is "materially changed" if its query or threshold changed
   * (same name, different semantics). Changes to `consecutiveTicks` alone
   * don't invalidate the counter — the operator just moved the firing bar.
   *
   * Keys in `consecutiveState` are `"{service}:{origin}:{ruleName}"` (Slice C).
   * The rule name is still the suffix after the last colon, so the existing
   * parser works unchanged — origin doesn't affect which rule-name a key
   * belongs to.
   */
  private resetHysteresisForChangedRules(
    prevRules: ProbeMetricRule[],
    nextRules: ProbeMetricRule[],
  ): void {
    const prevByName = new Map(prevRules.map((r) => [r.name, r]));
    const nextByName = new Map(nextRules.map((r) => [r.name, r]));

    const changedOrRemovedNames = new Set<string>();
    for (const [name, prevRule] of prevByName) {
      const nextRule = nextByName.get(name);
      if (!nextRule) {
        changedOrRemovedNames.add(name); // removed
        continue;
      }
      if (
        prevRule.query !== nextRule.query ||
        prevRule.threshold.op !== nextRule.threshold.op ||
        prevRule.threshold.value !== nextRule.threshold.value
      ) {
        changedOrRemovedNames.add(name); // materially changed
      }
    }

    if (changedOrRemovedNames.size === 0) return;

    let cleared = 0;
    for (const key of Array.from(this.consecutiveState.keys())) {
      // Key shape (Slice C): "service:origin:ruleName". Rule name is still
      // the suffix after the last colon — lastIndexOf + slice(+1) extracts
      // it correctly regardless of whether the key is the 2-part legacy
      // shape or the 3-part origin-namespaced one. DO NOT use this index
      // to extract the service prefix (it now includes ":origin"); use
      // `startsWith(service + ":")` for service matching as in
      // resetHysteresisForService.
      const colonIdx = key.lastIndexOf(":");
      if (colonIdx < 0) continue; // malformed key, ignore
      const ruleName = key.slice(colonIdx + 1);
      if (changedOrRemovedNames.has(ruleName)) {
        this.consecutiveState.delete(key);
        cleared++;
      }
    }

    if (cleared > 0) {
      logger.info({
        stackId: this.deps.stackId,
        clearedKeys: cleared,
        affectedRules: Array.from(changedOrRemovedNames),
      }, "ScanScheduler: cleared hysteresis state for changed/removed rules");
    }
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

      // Snapshot all per-service overrides once per tick (cheap: one SQL
      // query returning a small map), then serve a synchronous getter to the
      // probe. Avoids N DB hits during the tick's hot loop.
      const overridesRaw = this.deps.db.getAllScanOverrides(this.deps.stackId);
      const parsedOverrides = new Map<string, ReturnType<typeof parseOverride>>();
      for (const [svc, raw] of Object.entries(overridesRaw)) {
        parsedOverrides.set(svc, parseOverride(raw));
      }
      const getOverride = (service: string) => parsedOverrides.get(service) ?? null;

      const lokiDatasourceUid = this.deps.getLokiDatasourceUid?.();
      const probeResult = await runProbe({
        services,
        probe: this.scan.probe,
        providers: this.deps.providers(),
        datasourceUid,
        lokiDatasourceUid,
        signal: this.ac.signal,
        consecutiveState: this.consecutiveState,
        getOverride,
        registryStore: this.deps.registryStore,
      });
      const rawHits = probeResult.hits;
      // probeResult.queriesExecuted / probeResult.probeErrors will be consumed
      // by ScanRunTracker.recordProbeComplete in Task 7.

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
