// src/web/components/scan/types.ts
//
// Shared types for the probe-rule editor UI. Structurally aligned with the
// ProbeMetricRule shape in src/config/schema.ts. The GUI editor stays
// metrics-only for v1 — log-source rules come from discovery (Slice B),
// not this editor. The `source` field is intentionally omitted here; the
// server's scan-rule-validator defaults it to "metrics" on PUT.

export type ThresholdOp = "gt" | "lt" | "gte" | "lte";

export interface RuleDraft {
  name: string;
  query: string;
  threshold: { op: ThresholdOp; value: number };
  consecutiveTicks: number;
}

export interface RuleTestResponse {
  testedService: string;
  query: string;
  value: number | null;
  wouldTrip: boolean;
  rawResultCount: number;
  durationMs: number;
}

export interface RuleTestError {
  error: string;
  testedService?: string;
  query?: string;
  durationMs?: number;
}

export const DEFAULT_RULE: RuleDraft = {
  name: "",
  query: 'up{service="{service}"}',
  threshold: { op: "lt", value: 1 },
  consecutiveTicks: 1,
};
