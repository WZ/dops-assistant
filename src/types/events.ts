// src/types/events.ts

export type EventKind =
  | "investigation_started"
  | "investigation_completed"
  | "investigation_failed"
  | "alert_received"
  | "provider_health_changed"
  | "service_health_changed";

export interface RecentEvent {
  id: string;               // monotonic ulid
  ts: number;               // epoch ms
  kind: EventKind;
  severity: "info" | "warn" | "error" | "success";
  summary: string;          // one-line human description, <= 80 chars
  service?: string;         // optional service name association
  href?: string;            // optional deep link (investigation id path, etc.)
  meta?: Record<string, string | number | boolean>;
}

export interface RecentEventsResponse {
  events: RecentEvent[];    // newest first, capped by server
  truncated: boolean;       // true if older events were dropped
}
