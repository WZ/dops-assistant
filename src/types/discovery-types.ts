import { z } from "zod";
import { type ServiceConfig } from "../config/schema.js";

export const ConfidenceSchema = z.enum(["verified", "partial", "unverified"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const ValidatedServiceConfigSchema = z.object({
  name: z.string(),
  metrics: z.array(z.object({ query: z.string(), description: z.string() })).optional().default([]),
  logLabels: z.record(z.string()).optional().default({}),
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
  })),
  source: z.enum(["discovery", "manual"]),
  serviceCount: z.number(),
});
export type ServiceRegistryVersion = z.infer<typeof ServiceRegistryVersionSchema>;
