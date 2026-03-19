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

export interface KpiData {
  total: number;
  active: number;
  complete: number;
  failed: number;
  totalServices: number;
  healthyCount: number;
  criticalCount: number;
  degradedCount: number;
  avgMttr7d: number;
  mttrTrend?: { direction: "up" | "down"; value: string; positive: boolean };
  completedLast7dCount: number;
  totalTokens: number;
  totalInput: number;
  totalOutput: number;
}

export function computeKpiData(
  investigations: InvestigationSummary[],
  services: { name: string }[]
): KpiData {
  const total = investigations.length;
  const active = investigations.filter(i => i.status === "running").length;
  const complete = investigations.filter(i => i.status === "complete").length;
  const failed = investigations.filter(i => i.status === "failed").length;

  // Services health based on most recent investigation per service
  const latestByService = new Map<string, InvestigationSummary>();
  for (const inv of investigations) {
    const existing = latestByService.get(inv.service);
    if (!existing || new Date(inv.created_at) > new Date(existing.created_at)) {
      latestByService.set(inv.service, inv);
    }
  }
  const totalServices = services.length;
  let criticalCount = 0;
  let degradedCount = 0;
  for (const inv of latestByService.values()) {
    if (inv.status === "failed") criticalCount++;
    else if (inv.status === "running") degradedCount++;
  }
  const healthyCount = totalServices - criticalCount - degradedCount;

  // MTTR (7d) — average duration of completed investigations in last 7 days
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  const fourteenDaysAgo = now - 14 * 24 * 60 * 60 * 1000;

  const completedLast7d = investigations.filter(
    i => i.status === "complete" && new Date(i.completed_at ?? i.created_at).getTime() >= sevenDaysAgo
  );
  const completedPrior7d = investigations.filter(
    i => i.status === "complete" &&
      new Date(i.completed_at ?? i.created_at).getTime() >= fourteenDaysAgo &&
      new Date(i.completed_at ?? i.created_at).getTime() < sevenDaysAgo
  );

  const avgMttr7d = completedLast7d.length > 0
    ? completedLast7d.reduce((sum, i) => sum + i.total_duration_ms, 0) / completedLast7d.length
    : 0;
  const avgMttrPrior = completedPrior7d.length > 0
    ? completedPrior7d.reduce((sum, i) => sum + i.total_duration_ms, 0) / completedPrior7d.length
    : 0;

  let mttrTrend: { direction: "up" | "down"; value: string; positive: boolean } | undefined;
  if (avgMttr7d > 0 && avgMttrPrior > 0) {
    const pctChange = ((avgMttr7d - avgMttrPrior) / avgMttrPrior) * 100;
    if (pctChange < 0) {
      mttrTrend = { direction: "down", value: `${Math.abs(Math.round(pctChange))}%`, positive: true };
    } else if (pctChange > 0) {
      mttrTrend = { direction: "up", value: `${Math.round(pctChange)}%`, positive: false };
    }
  }

  // Token usage
  const totalInput = investigations.reduce((sum, i) => sum + (i.total_input_tokens ?? 0), 0);
  const totalOutput = investigations.reduce((sum, i) => sum + (i.total_output_tokens ?? 0), 0);
  const totalTokens = totalInput + totalOutput;

  return {
    total, active, complete, failed,
    totalServices, healthyCount, criticalCount, degradedCount,
    avgMttr7d, mttrTrend, completedLast7dCount: completedLast7d.length,
    totalTokens, totalInput, totalOutput,
  };
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
