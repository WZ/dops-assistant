// src/server/event-log.ts
import type { Database } from "./db.js";
import type { RecentEvent, RecentEventsResponse } from "../types/events.js";

interface EventLogOptions { capacity?: number; }

type AppendInput = Pick<RecentEvent, "kind" | "severity" | "summary"> &
  Partial<Pick<RecentEvent, "stackId" | "service" | "href" | "meta">>;

export class EventLog {
  private readonly capacity: number;
  private buf: RecentEvent[] = [];
  private truncated = false;
  private seq = 0;
  /**
   * Optional DB sink. When wired (via `bindDatabase` at server boot), every
   * `append` also writes a row to the persistent `events` table. Kept lazy
   * so the singleton can be imported by modules constructed before the DB
   * is open — and so unit tests can use the ring without a DB.
   */
  private db: Database | null = null;

  constructor(opts: EventLogOptions = {}) {
    this.capacity = opts.capacity ?? 200;
  }

  /**
   * Wire a DB sink. Call once at server boot, after the Database is
   * constructed. Subsequent appends write to both the ring and the DB.
   * Calling twice replaces the binding (no harm).
   */
  bindDatabase(db: Database): void {
    this.db = db;
  }

  append(input: AppendInput): void {
    const e: RecentEvent = {
      id: `${Date.now().toString(36)}-${(this.seq++).toString(36)}`,
      ts: Date.now(),
      kind: input.kind,
      severity: input.severity,
      summary: input.summary.slice(0, 80),
      stackId: input.stackId,
      service: input.service,
      href: input.href,
      meta: input.meta,
    };
    this.buf.push(e);
    if (this.buf.length > this.capacity) {
      this.buf.splice(0, this.buf.length - this.capacity);
      this.truncated = true;
    }
    // Persist to DB. Best-effort — a transient write failure must not break
    // the ring (the Ops Desk strip is the caller's primary surface and falls
    // back to the in-memory buffer cleanly).
    if (this.db) {
      try {
        this.db.insertEvent({
          id: e.id,
          ts: e.ts,
          kind: e.kind,
          severity: e.severity,
          summary: e.summary,
          stackId: e.stackId,
          service: e.service,
          href: e.href,
          meta: e.meta,
        });
      } catch {
        // Swallow — see comment above. Surfaces in server logs at WARN if
        // the DB layer chooses to log internally; we deliberately don't
        // re-throw because the operator's UI experience matters more than
        // the durability of one event row.
      }
    }
  }

  /**
   * Return recent events, newest first. If `stackId` is provided, filter to events
   * belonging to that stack AND global events (events with no stackId, e.g.,
   * process-wide probe transitions). Pass undefined to return everything.
   */
  recent(limit = this.capacity, stackId?: string): RecentEventsResponse {
    const scoped = stackId === undefined
      ? this.buf
      : this.buf.filter((e) => e.stackId === undefined || e.stackId === stackId);
    const events = scoped.slice(-limit).reverse();
    return { events, truncated: this.truncated };
  }

  reset(): void {
    this.buf = [];
    this.truncated = false;
    this.seq = 0;
  }
}

export const eventLog = new EventLog({ capacity: 200 });
