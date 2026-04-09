/**
 * InvestigationDedup — shared dedup + concurrency guard for investigations.
 *
 * Used by both the alert webhook handler and the service-health poller's
 * auto-investigate path so that the same dedup window and concurrency limit
 * apply regardless of how an investigation is triggered.
 *
 * Usage:
 *   const dedup = new InvestigationDedup({ dedupWindowSeconds: 300, maxConcurrent: 3, db });
 *
 *   if (dedup.shouldInvestigate(stackId, "my-service").allowed) {
 *     dedup.markStarted(stackId, "my-service");
 *     try {
 *       await runner.run(...);
 *     } finally {
 *       dedup.markCompleted();
 *     }
 *   }
 */

import type { Database } from "./db.js";

export interface InvestigationDedupOptions {
  /** Dedup window in seconds — suppress duplicate investigations for the same service */
  dedupWindowSeconds: number;
  /** Maximum number of concurrently running investigations */
  maxConcurrent: number;
  /** Optional DB for fallback dedup checks that survive server restarts */
  db?: Database;
}

export interface DedupResult {
  allowed: boolean;
  reason?: string;
  /** Milliseconds until the caller can retry (for cooldown UX) */
  retryAfterMs?: number;
}

export class InvestigationDedup {
  private readonly dedupWindowMs: number;
  private readonly dedupWindowSeconds: number;
  private readonly maxConcurrent: number;
  private readonly db?: Database;

  /** Maps service name → timestamp (ms) of when the last investigation started */
  private readonly recentInvestigations = new Map<string, number>();
  /** Maps service key → timestamp (ms) of last re-run (30s cooldown) */
  private readonly lastRerunAt = new Map<string, number>();
  /** Count of currently active investigations */
  private activeCount = 0;
  private static readonly RERUN_COOLDOWN_MS = 30_000;

  constructor(opts: InvestigationDedupOptions) {
    this.dedupWindowMs = opts.dedupWindowSeconds * 1000;
    this.dedupWindowSeconds = opts.dedupWindowSeconds;
    this.maxConcurrent = opts.maxConcurrent;
    this.db = opts.db;
  }

  /**
   * Returns whether an investigation for this service should proceed.
   *
   * @param force - Bypass dedup window (for user-initiated re-runs). Still enforces
   *   concurrency limit and a 30s rapid-fire cooldown.
   */
  shouldInvestigate(stackId: string, service: string, force?: boolean): DedupResult {
    this.cleanExpiredEntries();

    const key = `${stackId}:${service}`;

    // Concurrency limit always applies, even for force
    if (this.activeCount >= this.maxConcurrent) {
      return { allowed: false, reason: "max_concurrent", retryAfterMs: 5_000 };
    }

    if (force) {
      // Enforce 30s rapid-fire cooldown for re-runs
      const lastRerun = this.lastRerunAt.get(key);
      if (lastRerun !== undefined) {
        const elapsed = Date.now() - lastRerun;
        if (elapsed < InvestigationDedup.RERUN_COOLDOWN_MS) {
          return { allowed: false, reason: "rerun_cooldown", retryAfterMs: InvestigationDedup.RERUN_COOLDOWN_MS - elapsed };
        }
      }
      return { allowed: true };
    }

    const lastRun = this.recentInvestigations.get(key);

    // In-memory check (fast path)
    if (lastRun !== undefined && Date.now() - lastRun < this.dedupWindowMs) {
      return { allowed: false, reason: "dedup_window", retryAfterMs: this.dedupWindowMs - (Date.now() - lastRun) };
    }

    // DB fallback check — catches recent investigations lost on server restart.
    if (this.db && lastRun === undefined && this.dedupWindowSeconds > 0) {
      if (this.db.hasRecentInvestigation(stackId, service, this.dedupWindowSeconds)) {
        return { allowed: false, reason: "dedup_window_db" };
      }
    }

    return { allowed: true };
  }

  /**
   * Mark an investigation as started for the given service.
   * Records the timestamp and increments the active count.
   * Call this immediately before starting the investigation.
   */
  markStarted(stackId: string, service: string, isRerun?: boolean): void {
    const key = `${stackId}:${service}`;
    this.recentInvestigations.set(key, Date.now());
    if (isRerun) this.lastRerunAt.set(key, Date.now());
    this.activeCount++;
  }

  /**
   * Mark an investigation as completed (or failed).
   * Decrements the active count. Always call this in a finally block.
   */
  markCompleted(): void {
    this.activeCount = Math.max(0, this.activeCount - 1);
  }

  /** Current number of active investigations (for logging/metrics). */
  getActiveCount(): number {
    return this.activeCount;
  }

  /** Remove dedup entries that have aged out of the window. */
  private cleanExpiredEntries(): void {
    const now = Date.now();
    for (const [key, ts] of this.recentInvestigations) {
      if (now - ts > this.dedupWindowMs) {
        this.recentInvestigations.delete(key);
      }
    }
  }
}
