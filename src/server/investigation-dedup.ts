/**
 * InvestigationDedup — shared dedup + concurrency guard for investigations.
 *
 * Used by both the alert webhook handler and the service-health poller's
 * auto-investigate path so that the same dedup window and concurrency limit
 * apply regardless of how an investigation is triggered.
 *
 * Usage:
 *   const dedup = new InvestigationDedup({ dedupWindowSeconds: 300, maxConcurrent: 3 });
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

export interface InvestigationDedupOptions {
  /** Dedup window in seconds — suppress duplicate investigations for the same service */
  dedupWindowSeconds: number;
  /** Maximum number of concurrently running investigations */
  maxConcurrent: number;
}

export class InvestigationDedup {
  private readonly dedupWindowMs: number;
  private readonly maxConcurrent: number;

  /** Maps service name → timestamp (ms) of when the last investigation started */
  private readonly recentInvestigations = new Map<string, number>();
  /** Count of currently active investigations */
  private activeCount = 0;

  constructor(opts: InvestigationDedupOptions) {
    this.dedupWindowMs = opts.dedupWindowSeconds * 1000;
    this.maxConcurrent = opts.maxConcurrent;
  }

  /**
   * Returns true if an investigation for this service should proceed.
   *
   * Returns false if:
   *  - The service was investigated within the dedup window, OR
   *  - The active investigation count has reached maxConcurrent
   */
  shouldInvestigate(service: string): boolean {
    this.cleanExpiredEntries();

    const lastRun = this.recentInvestigations.get(service);
    if (lastRun !== undefined && Date.now() - lastRun < this.dedupWindowMs) {
      return false;
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
  markStarted(service: string): void {
    this.recentInvestigations.set(service, Date.now());
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
