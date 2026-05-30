/**
 * Zod schemas for investigation workflow step I/O.
 *
 * PrefetchedContextSchema is defined in src/types/workflow-state.ts and re-exported
 * here so that all workflow schema imports can come from a single location.
 */

import { z } from "zod";
import { PrefetchedContextSchema } from "../types/workflow-state.js";

export { PrefetchedContextSchema };

/** Reusable time range schema for investigation window metadata. */
export const TimeRangeSchema = z.object({
  from: z.string(),
  to: z.string(),
});

export const WorkflowInputSchema = z.object({
  userMessage: z.string(),
  alertName: z.string().optional(),
  serviceName: z.string().optional(),
  skillContext: z.string().optional(),
});

export const PrefetchOutputSchema = PrefetchedContextSchema.extend({
  userMessage: z.string(),
  alertName: z.string().optional(),
  serviceName: z.string().optional(),
  skillContext: z.string().optional(),
});

export const AnomalyOutputSchema = z.object({
  isAnomaly: z.boolean(),
  severity: z.enum(["low", "medium", "high", "critical"]).optional(),
  summary: z.string(),
  affectedServices: z.array(z.string()).optional(),
  timeRangeFrom: z.string().optional(),
  timeRangeTo: z.string().optional(),
  // Pass through prefetch and input for downstream steps
  prefetchContext: PrefetchedContextSchema,
  userMessage: z.string(),
  serviceName: z.string().optional(),
  skillContext: z.string().optional(),
});

export const PlanningOutputSchema = z.object({
  hypotheses: z.array(z.object({
    hypothesis: z.string(),
    evidenceNeeded: z.string(),
  })).optional(),
  metricFocus: z.array(z.string()).optional(),
  logFocus: z.array(z.string()).optional(),
  infraFocus: z.array(z.string()).optional(),
  // Pass through
  anomalyContext: AnomalyOutputSchema,
});

const ToolCallRecordSchema = z.object({
  tool: z.string(),
  args: z.string(),
  resultChars: z.number(),
  /** Short snippet of the actual tool result, for inline receipts. */
  resultExcerpt: z.string().optional(),
});

export const EvidenceOutputSchema = z.object({
  summary: z.string(),
  observations: z.array(z.unknown()).optional(),
  // Pass-through: injected by buildEvidenceStep factory, not produced by agents
  timeRange: TimeRangeSchema.optional(),
  // Error classification when evidence gathering failed (e.g. LLM unreachable)
  error: z.string().optional(),
  // Tool calls made during this evidence phase — used for Grafana deep links
  toolCalls: z.array(ToolCallRecordSchema).optional(),
});

export const ParallelEvidenceSchema = z.object({
  metrics: EvidenceOutputSchema,
  logs: EvidenceOutputSchema,
  infra: EvidenceOutputSchema,
  changes: EvidenceOutputSchema.optional(),
  planningContext: PlanningOutputSchema,
});

// ── Hypothesis loop (Step 2) — additive, optional. Populated only when the
//    synthesis loop runs (N>1); the default single-pass path leaves these unset.
const HypothesisPredictionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("metric-threshold"), metric: z.string(), op: z.enum([">", "<", ">=", "<="]), value: z.number() }),
  z.object({ kind: z.literal("log-pattern"), pattern: z.string(), present: z.boolean().optional() }),
  z.object({ kind: z.literal("infra-status"), resource: z.string().optional(), status: z.string() }),
  z.object({ kind: z.literal("change-in-window"), withinMinutesBefore: z.number() }),
]);

export const RankedHypothesisSchema = z.object({
  hypothesis: z.string(),
  prediction: HypothesisPredictionSchema,
});

export const RuledOutSchema = z.object({
  hypothesis: z.string(),
  /** Deterministic verdict that demoted it: contradicted | absent. */
  reason: z.string(),
});

export const SynthesisOutputSchema = z.object({
  severity: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  summary: z.string().default("Investigation complete"),
  impact: z.object({
    duration: z.string(),
    description: z.string(),
  }).default({ duration: "Unknown", description: "" }),
  rootCause: z.string().default("Unable to determine"),
  trigger: z.string().default("Unknown"),
  contributingFactors: z.array(z.string()).default([]),
  timeline: z.array(z.object({
    time: z.string(),
    event: z.string(),
  })).default([]),
  evidence: z.object({
    metrics: z.array(z.string()),
    logs: z.array(z.string()),
    infra: z.array(z.string()),
    changes: z.array(z.string()).optional().default([]),
  }).default({ metrics: [], logs: [], infra: [], changes: [] }),
  // Tool calls from evidence phases, keyed by phase — used for Grafana deep links
  evidenceToolCalls: z.record(z.string(), z.array(ToolCallRecordSchema)).optional(),
  dashboardLinks: z.array(z.string()).default([]),
  recommendedActions: z.array(z.string()).default([]),
  confidence: z.enum(["low", "medium", "high"]).default("low"),
  confidenceScore: z.number().default(0.5),
  timeRange: TimeRangeSchema.optional(),
  // Hypothesis loop output (unset on the single-pass path).
  hypotheses: z.array(RankedHypothesisSchema).optional(),
  ruledOut: z.array(RuledOutSchema).optional(),
  loopOutcome: z.enum(["confirmed", "undetermined", "exhausted"]).optional(),
});

export const PostSynthesisOutputSchema = z.object({
  severity: z.enum(["low", "medium", "high", "critical"]),
  summary: z.string(),
  impact: z.object({
    duration: z.string(),
    description: z.string(),
  }),
  rootCause: z.string(),
  trigger: z.string(),
  contributingFactors: z.array(z.string()),
  timeline: z.array(z.object({
    time: z.string(),
    event: z.string(),
  })),
  evidence: z.object({
    metrics: z.array(z.string()),
    logs: z.array(z.string()),
    infra: z.array(z.string()),
    changes: z.array(z.string()).optional().default([]),
  }),
  evidenceToolCalls: z.record(z.string(), z.array(ToolCallRecordSchema)).optional(),
  dashboardLinks: z.array(z.string()),
  recommendedActions: z.array(z.string()),
  confidence: z.enum(["low", "medium", "high"]),
  confidenceScore: z.number(),
  savedToHistory: z.boolean(),
  investigatedAt: z.string(),
  timeRange: TimeRangeSchema.optional(),
  hypotheses: z.array(RankedHypothesisSchema).optional(),
  ruledOut: z.array(RuledOutSchema).optional(),
  loopOutcome: z.enum(["confirmed", "undetermined", "exhausted"]).optional(),
});
