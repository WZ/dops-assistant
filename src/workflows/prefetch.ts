/**
 * Extract dashboard and panel name hints from the user message and anomaly summary.
 * Looks for patterns like "(Panel Name in Dashboard Name)" or just quoted names.
 */
export function extractDashboardPanelHints(
  userMessage?: string,
  anomalySummary?: string,
): { dashboardHint: string | null; panelHint: string | null } {
  const text = `${userMessage ?? ""} ${anomalySummary ?? ""}`;

  // Pattern: "(Panel Name in Dashboard Name)" — e.g. "(Ingestion Log Rate in Ingestion monitor)"
  const parenMatch = text.match(/\(([^)]+?)\s+in\s+([^)]+?)\)/i);
  if (parenMatch) {
    return { panelHint: parenMatch[1]!.trim(), dashboardHint: parenMatch[2]!.trim() };
  }

  // Pattern: "Panel Name in Dashboard Name" without parens — less strict, require "dashboard"/"monitor" suffix
  const inMatch = text.match(/([A-Z][A-Za-z\s]+?)\s+in\s+([A-Z][A-Za-z\s]*(?:dashboard|monitor|overview))/i);
  if (inMatch) {
    return { panelHint: inMatch[1]!.trim(), dashboardHint: inMatch[2]!.trim() };
  }

  return { dashboardHint: null, panelHint: null };
}

/**
 * Extract keywords from a user query for scoring dashboards/panels.
 * Simple tokenizer — keeps words 4+ chars, skips common noise.
 */
export function extractQueryKeywords(userMessage?: string, anomalySummary?: string): string[] {
  const text = `${userMessage ?? ""} ${anomalySummary ?? ""}`.toLowerCase();
  return text.split(/[^a-z0-9]+/).filter((t) => t.length > 3);
}
