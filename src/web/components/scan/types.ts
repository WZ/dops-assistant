// src/web/components/scan/types.ts
//
// Shared types for the probe-rule editor UI. Keep in lockstep with the
// ProbeMetricRule shape in src/config/schema.ts — the editor only speaks this
// type locally; the server validates the final shape on PUT.

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
