import { z } from "zod";

// ── AlertPayload ──────────────────────────────────────────────────────────────

export const AlertPayloadSchema = z.object({
  alertName: z.string(),
  labels: z.record(z.string()),
  annotations: z.record(z.string()).optional(),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  generatorURL: z.string().optional(),
  fingerprint: z.string().optional(),
});

export type AlertPayload = z.infer<typeof AlertPayloadSchema>;

// ── PrefetchedContext ─────────────────────────────────────────────────────────

export const PrefetchedContextSchema = z.object({
  datasourceHints: z.string(),
  dashboardContext: z.string(),
  panelQueryHints: z.string(),
  logLabelHints: z.string(),
  workingLogSelectors: z.array(z.string()),
});

export type PrefetchedContext = z.infer<typeof PrefetchedContextSchema>;

// ── AnomalyResult ─────────────────────────────────────────────────────────────

export const AnomalyResultSchema = z.object({
  isAnomaly: z.boolean(),
  timeRange: z.object({
    from: z.string(),
    to: z.string(),
  }),
  summary: z.string(),
  affectedServices: z.array(z.string()),
  severity: z.enum(["low", "medium", "high", "critical"]).optional(),
});

export type AnomalyResult = z.infer<typeof AnomalyResultSchema>;

// ── InvestigationState ────────────────────────────────────────────────────────

export const InvestigationStateSchema = z.object({
  userMessage: z.string(),
  alertContext: AlertPayloadSchema.optional(),
  prefetchedContext: PrefetchedContextSchema.optional(),
  anomalies: AnomalyResultSchema.optional(),
  recentIncidents: z.array(z.unknown()).optional(),
});

export type InvestigationState = z.infer<typeof InvestigationStateSchema>;
