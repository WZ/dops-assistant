// src/server/events-retention.ts
//
// Background task that purges expired rows from the `events` table. The
// table is unbounded by design — every server tick can produce events, and
// over months that becomes a real disk burden. Retention is the safety
// valve: 30 days by default, configurable via `config.events.retentionDays`.
//
// Runs once at boot (catches up after long downtime) and every 6 hours
// thereafter. Each call deletes up to 50k rows (DB-side cap in
// `purgeEventsOlderThan`); we loop until the count drops below the cap so
// a multi-million-row backlog clears in bounded time without a single
// long-running transaction.

import { createLogger } from "../logger.js";
import type { Database } from "./db.js";

const logger = createLogger();

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PURGE_BATCH_LIMIT = 50_000;

export interface EventsRetentionTask {
  /** Run a single sweep immediately. Exposed for tests + manual triggers. */
  sweep(): number;
  /** Stop the periodic timer (idempotent). */
  stop(): void;
}

/**
 * Start the retention task. Returns a handle exposing `sweep()` for tests
 * and `stop()` for graceful shutdown. `retentionDays <= 0` disables the
 * task — kept as a config escape hatch ("never delete events") for users
 * with external archival pipelines.
 */
export function startEventsRetentionTask(deps: {
  db: Database;
  retentionDays: number;
}): EventsRetentionTask {
  const { db, retentionDays } = deps;

  const sweep = (): number => {
    if (retentionDays <= 0) return 0;
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    let total = 0;
    // Loop until a single batch deletes fewer rows than the cap — meaning
    // the backlog is drained. Cap-aware so we never hold a giant
    // transaction; each batch is a self-contained DELETE.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const removed = db.purgeEventsOlderThan(cutoff);
      total += removed;
      if (removed < PURGE_BATCH_LIMIT) break;
    }
    if (total > 0) {
      logger.info({ removed: total, retentionDays, cutoffMs: cutoff }, "events retention sweep");
    }
    return total;
  };

  // Initial sweep on boot — catches up after downtime. Not awaited; the
  // caller doesn't need to block startup on this. Errors are logged but
  // never surface (retention is best-effort).
  setImmediate(() => {
    try { sweep(); } catch (err) { logger.warn({ err }, "events retention sweep failed"); }
  });

  if (retentionDays <= 0) {
    return { sweep, stop: () => {} };
  }

  const handle = setInterval(() => {
    try { sweep(); } catch (err) { logger.warn({ err }, "events retention sweep failed"); }
  }, SWEEP_INTERVAL_MS);
  // Keep the timer from blocking process exit.
  if (typeof handle === "object" && "unref" in handle) (handle as { unref: () => void }).unref();

  return {
    sweep,
    stop: () => clearInterval(handle),
  };
}
