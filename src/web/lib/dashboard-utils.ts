/** Shape returned by GET /api/investigations */
export interface InvestigationSummary {
  id: string;
  service: string;
  status: string;
  report: string | null;
  created_at: string;
  completed_at: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_duration_ms: number;
  confidence_score: number | null;
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

export function severityVariant(severity: string): "destructive" | "warning" | "secondary" | "outline" {
  switch (severity?.toLowerCase()) {
    case "critical":
      return "destructive";
    case "high":
      return "warning";
    case "medium":
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

export function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
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
