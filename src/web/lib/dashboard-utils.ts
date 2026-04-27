import { formatTimestamp } from "./formatTimestamp";

/** A single investigation row — returned as an element of InvestigationListResponse.rows */
export interface InvestigationSummary {
  id: string;
  service: string;
  /** Human-readable trigger text, e.g. "Proactive scan detected anomaly on X" or
   *  "Alert: HighErrorRate (severity: critical)". Used to infer `TriggerSource`
   *  for the list badge — see inferTriggerSource(). Optional on the client type
   *  because older callers that pre-date the list page may not care. */
  query?: string;
  status: string;
  report: string | null;
  created_at: string;
  completed_at: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_duration_ms: number;
  confidence_score: number | null;
  severity: "critical" | "high" | "medium" | "low" | null;
}

export type TriggerSource = "scan" | "alert" | "user";

/**
 * Derive the trigger source from the investigation's `query` text.
 *
 * No schema column for trigger source exists yet — proactive scans always
 * prefix with "Proactive scan detected anomaly" (see anomaly-probe.ts) and
 * alertmanager webhooks with "Alert:" (webhook-handler.ts). Anything else
 * came from the chat UI or CLI, so we bucket it as "user". A future PR can
 * promote this to a real column if we need to filter by source.
 */
export function inferTriggerSource(query: string | null | undefined): TriggerSource {
  if (!query) return "user";
  if (query.startsWith("Proactive scan detected anomaly")) return "scan";
  if (query.startsWith("Alert:")) return "alert";
  return "user";
}

/**
 * Shape returned by GET /api/investigations.
 *
 * `total` is the count of all rows matching the filter set (ignoring limit/offset)
 * so the client can render "N of M match filters" and page controls. `hasMore`
 * is a convenience derived from offset + rows.length < total.
 */
export interface InvestigationListResponse {
  rows: InvestigationSummary[];
  total: number;
  hasMore: boolean;
  /** Distinct service names with at least one investigation in this stack — populates the service-filter dropdown. Optional for legacy callers (Dashboard) that don't render filters. */
  services?: string[];
}

/** Shape returned by GET /api/stats/kpi */
export interface KpiStats {
  investigations: { total: number; active: number; complete: number; failed: number };
  successRate: number | null;
  confidence: { avg: number | null; scored: number; lowConfidence: number };
  mttr: { avg7d: number; completed7d: number; trend?: { direction: "up" | "down"; value: string; positive: boolean } };
}

/** Shape returned by GET /api/patterns */
export interface Pattern {
  id: string;
  service: string;
  symptom: string;
  rootCause: string;
  severity: string;
  recommendedActions: string;
  sourceInvestigationId: string;
}

export function severityVariant(severity: string): "destructive" | "warning" | "info" | "secondary" | "outline" {
  switch (severity?.toLowerCase()) {
    case "critical":
      return "destructive";
    case "high":
      return "warning";
    case "medium":
      return "info";
    case "low":
      return "secondary";
    default:
      return "outline";
  }
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const secs = totalSeconds % 60;
    return secs > 0 ? `${totalMinutes}m ${secs}s` : `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

/**
 * Relative "N ago" style. Thin wrapper over the unified `formatTimestamp`
 * formatter to keep existing callers (ServiceCard, InvestigationRow,
 * InvestigationLog) on the same output and rules.
 */
export function timeAgo(dateStr: string): string {
  return formatTimestamp(dateStr, "relative");
}

/** Normalize unknown confidence value from JSON to a display string like "87%" */
export function normalizeConfidence(raw: unknown): string {
  if (raw == null || raw === "") return "";
  if (typeof raw === "number") {
    // confidenceScore is 0-100, confidence as float is 0-1
    return raw <= 1 ? `${Math.round(raw * 100)}%` : `${Math.round(raw)}%`;
  }
  const str = String(raw);
  if (str.includes("%")) return str;
  // If it's a numeric string, append %
  if (/^\d+(\.\d+)?$/.test(str)) return `${str}%`;
  // Non-numeric strings (e.g. "high", "medium") returned as-is
  return str;
}
