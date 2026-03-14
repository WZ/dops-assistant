// DEPRECATED: Use Mastra equivalents. Will be removed when USE_MASTRA migration is complete.
// Re-exports from src/types/rca-types.ts — consumers should import from there directly.
export * from "../types/rca-types.js";

// ReflectionResult is agent-internal; kept here rather than in shared types
export type ReflectionResult = {
  validationNotes: string;
  revisedRootCause: string;
  revisedTrigger: string;
  revisedSeverity: "low" | "medium" | "high" | "critical";
  revisedConfidence: "low" | "medium" | "high";
  revisedConfidenceScore: number;
  revisedSummary: string;
  issues: string[];
};
