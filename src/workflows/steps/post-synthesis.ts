/**
 * Post-synthesis step for the investigation workflow.
 *
 * Saves the completed incident to the history store and finalizes the report.
 */

import { createStep } from "@mastra/core/workflows";
import type { WorkflowConfig } from "../investigation.js";
import { SynthesisOutputSchema, PostSynthesisOutputSchema } from "../schemas.js";
import { saveIncident } from "../history.js";
import { debug } from "../tool-utils.js";

/**
 * Build a post-synthesis step that saves incident to history.
 */
export function buildPostSynthesisStep(config: WorkflowConfig) {
  return createStep({
    id: "post-synthesis",
    description: "Save incident to history store and finalize report",
    inputSchema: SynthesisOutputSchema,
    outputSchema: PostSynthesisOutputSchema,
    execute: async ({ inputData }) => {
      const investigatedAt = new Date().toISOString();

      // Save to incident history if project root and service are configured
      let savedToHistory = false;
      const serviceName = config.services[0]?.name ?? "unknown";

      if (config.projectRoot && serviceName !== "unknown") {
        try {
          await saveIncident(config.projectRoot, {
            service: serviceName,
            severity: inputData.severity,
            summary: inputData.summary,
            rootCause: inputData.rootCause,
            trigger: inputData.trigger,
            confidence: inputData.confidence,
            investigatedAt,
          });
          savedToHistory = true;
        } catch {
          // Non-fatal — investigation can complete without saving
        }
      }

      debug("POST-SYNTHESIS step complete, savedToHistory:", savedToHistory);

      return {
        severity: inputData.severity,
        summary: inputData.summary,
        impact: inputData.impact,
        rootCause: inputData.rootCause,
        trigger: inputData.trigger,
        contributingFactors: inputData.contributingFactors,
        timeline: inputData.timeline,
        evidence: inputData.evidence,
        dashboardLinks: inputData.dashboardLinks,
        recommendedActions: inputData.recommendedActions,
        confidence: inputData.confidence,
        confidenceScore: inputData.confidenceScore,
        savedToHistory,
        investigatedAt,
      };
    },
  });
}
