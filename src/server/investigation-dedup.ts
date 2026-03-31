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
 *   if (dedup.shouldInvestigate("my-service")) {
 *     dedup.markStarted("my-service");
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

export class InvestigationDedup {
  private readonly dedupWindowMs: number;
  private readonly dedupWindowSeconds: number;
  private readonly maxConcurrent: number;
  private readonly db?: Database;

  /** Maps service name → timestamp (ms) of when the last investigation started */
  private readonly recentInvestigations = new Map<string, number>();
  /** Count of currently active investigations */
  private activeCount = 0;

  constructor(opts: InvestigationDedupOptions) {
    this.dedupWindowMs = opts.dedupWindowSeconds * 1000;
    this.dedupWindowSeconds = opts.dedupWindowSeconds;
    this.maxConcurrent = opts.maxConcurrent;
    this.db = opts.db;
  }

  /**
   * Returns true if an investigation for this service should proceed.
   *
   * Returns false if:
   *  - The service was investigated within the dedup window (in-memory or DB fallback), OR
   *  - The active investigation count has reached maxConcurrent
   */
  shouldInvestigate(stackId: string, service: string): boolean {
    this.cleanExpiredEntries();

    const key = `${stackId}:${service}`;
    const lastRun = this.recentInvestigations.get(key);

    // In-memory check (fast path)
    if (lastRun !== undefined && Date.now() - lastRun < this.dedupWindowMs) {
      return false;
    }

    // DB fallback check — catches recent investigations lost on server restart.
    // Only queries DB when in-memory map has no entry for this key.
    if (this.db && lastRun === undefined && this.dedupWindowSeconds > 0) {
      if (this.db.hasRecentInvestigation(stackId, service, this.dedupWindowSeconds)) {
        return false;
      }
    }

    if (this.activeCount >= this.maxConcurrent) {
      return false;
    }

    return true;
  }

  /**
   * Mark an investigation as started for the given service.
   * Records the timestamp and increments the active count.
   * Call this immediately before starting the investigation.
   */
  markStarted(stackId: string, service: string): void {
    const key = `${stackId}:${service}`;
    this.recentInvestigations.set(key, Date.now());
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
