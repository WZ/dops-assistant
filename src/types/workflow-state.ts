import { z } from "zod";

// ── Neighbor schemas ──────────────────────────────────────────────────────────
//
// Option 3 (see design doc): the prefetch step fetches 1-hop neighbors from Coroot
// and then issues deterministic PromQL/LogQL queries for the top-N unhealthy ones.
// The resulting `NeighborEvidence` is carried through PrefetchedContextSchema →
// AnomalyOutputSchema.prefetchContext → EvidenceOutputSchema.neighbors →
// SynthesisOutputSchema.neighbors → PostSynthesisOutputSchema.neighbors, mirroring
// the existing `timeRange` pass-through pattern.

export const NeighborMetricSampleSchema = z.object({
  query: z.string(),
  // [timestamp, value] pairs. Bounded to ~5 samples per query upstream.
  values: z.array(z.tuple([z.string(), z.string()])),
  error: z.string().optional(),
});
export type NeighborMetricSample = z.infer<typeof NeighborMetricSampleSchema>;

export const NeighborLogSampleSchema = z.object({
  query: z.string(),
  lines: z.array(z.string()),
  count: z.number(),
  error: z.string().optional(),
});
export type NeighborLogSample = z.infer<typeof NeighborLogSampleSchema>;

export const NeighborEvidenceSchema = z.object({
  metrics: z.array(NeighborMetricSampleSchema).default([]),
  logs: z.array(NeighborLogSampleSchema).default([]),
  fetchedAt: z.string(),
  fetchErrors: z.array(z.string()).default([]),
});
export type NeighborEvidence = z.infer<typeof NeighborEvidenceSchema>;

export const NeighborSchema = z.object({
  name: z.string(),
  directions: z.array(z.enum(["upstream", "downstream"])),
  status: z.enum(["healthy", "degraded", "unhealthy", "unknown"]),
  inServiceRegistry: z.boolean(),
  requestRate: z.string().optional(),
  evidence: NeighborEvidenceSchema.optional(),
});
export type Neighbor = z.infer<typeof NeighborSchema>;

export const PrefetchedContextSchema = z.object({
  datasourceHints: z.string(),
  dashboardContext: z.string(),
  panelQueryHints: z.string(),
  logLabelHints: z.string(),
  workingLogSelectors: z.array(z.string()),
  neighbors: z.array(NeighborSchema).default([]),
});

export type PrefetchedContext = z.infer<typeof PrefetchedContextSchema>;
