/**
 * Evidence metadata for deep linking from investigation results to Grafana Explore.
 *
 * Two-tier strategy:
 * - Tier 1 (phase-level): tool call list per phase → generic Explore link with service + time range
 * - Tier 2 (observation-level): exact query from tool call args → precise Explore link
 */

/** Stripped-down tool call record stored with evidence. Only fields needed for deep links. */
export interface ToolCallRecord {
  tool: string;
  args: string; // JSON-stringified, contains query/expr/datasource fields
  resultChars: number;
}

/** Actions the UI can render for an evidence item. */
export interface EvidenceAction {
  label: string;
  url: string;
  provider: string;
  role: string; // "metrics" | "logs" | "infrastructure"
  tier: "observation" | "phase"; // controls icon opacity (solid vs dim)
}
