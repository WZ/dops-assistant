import { z } from "zod";
import { type ServiceConfig } from "../config/schema.js";

export const ConfidenceSchema = z.enum(["verified", "partial", "unverified"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

// Minimal probe-rule shape carried through discovery validation. The canonical
// schema lives in src/config/schema.ts (ProbeMetricRuleSchema); this mirror
// stays structurally compatible so a validated discovery output can be passed
// directly to registryStore.save() as a ServiceConfig. Slice B teaches the
// discovery agent to emit these; Slice A just keeps the field present so the
// type flows through the existing code paths.
const ProbeRuleMirrorSchema = z.object({
  name: z.string(),
  query: z.string(),
  threshold: z.object({
    op: z.enum(["gt", "lt", "gte", "lte"]),
    value: z.number(),
  }),
  consecutiveTicks: z.number().int().min(1).default(1),
  source: z.enum(["metrics", "logs"]).default("metrics"),
});

export const ValidatedServiceConfigSchema = z.object({
  name: z.string(),
  metrics: z.array(z.object({ query: z.string(), description: z.string() })).optional().default([]),
  logLabels: z.record(z.string()).optional().default({}),
  probeRules: z.array(ProbeRuleMirrorSchema).optional().default([]),
  confidence: ConfidenceSchema,
  validationNotes: z.string(),
});
export type ValidatedServiceConfig = z.infer<typeof ValidatedServiceConfigSchema>;

export const ServiceRegistryVersionSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  services: z.array(z.object({
    name: z.string(),
    metrics: z.array(z.object({ query: z.string(), description: z.string() })).optional().default([]),
    logLabels: z.record(z.string()).optional().default({}),
    probeRules: z.array(ProbeRuleMirrorSchema).optional().default([]),
  })),
  source: z.enum(["discovery", "manual"]),
  serviceCount: z.number(),
});
export type ServiceRegistryVersion = z.infer<typeof ServiceRegistryVersionSchema>;
