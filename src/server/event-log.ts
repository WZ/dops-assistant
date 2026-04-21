// src/server/event-log.ts
import type { RecentEvent, RecentEventsResponse } from "../types/events.js";

interface EventLogOptions { capacity?: number; }

type AppendInput = Pick<RecentEvent, "kind" | "severity" | "summary"> &
  Partial<Pick<RecentEvent, "stackId" | "service" | "href" | "meta">>;

export class EventLog {
  private readonly capacity: number;
  private buf: RecentEvent[] = [];
  private truncated = false;
  private seq = 0;

  constructor(opts: EventLogOptions = {}) {
    this.capacity = opts.capacity ?? 200;
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
}

export const eventLog = new EventLog({ capacity: 200 });
