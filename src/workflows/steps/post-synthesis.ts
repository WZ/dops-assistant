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
 * Build Grafana Explore deep links for logs and metrics, pre-filled with
 * the investigation's time range and service selector.
 */
function buildGrafanaExploreLinks(
  config: WorkflowConfig,
  serviceName: string,
  timeRange: { from: string; to: string },
): string[] {
  const links: string[] = [];

  for (const provider of config.providers) {
    const webUrl = (provider as any).webUrl;
    if (!webUrl) continue;

    const fromMs = new Date(timeRange.from).getTime();
    const toMs = new Date(timeRange.to).getTime();
    if (isNaN(fromMs) || isNaN(toMs)) continue;

    const base = webUrl.replace(/\/+$/, "");

    // Build Loki Explore link for providers with "logs" role
    if ((provider as any).roles?.includes("logs")) {
      const datasource = (provider as any).datasourceName ?? "loki";
      const logql = `{app="${serviceName}"} |~ "(?i)(error|exception|fail)"`;
      const pane = JSON.stringify({
        datasource,
        queries: [{ refId: "A", expr: logql }],
        range: { from: String(fromMs), to: String(toMs) },
      });
      links.push(`${base}/explore?schemaVersion=1&panes=${encodeURIComponent(`{"a":${pane}}`)}`);
    }

    // Build Prometheus Explore link for providers with "metrics" role
    if ((provider as any).roles?.includes("metrics")) {
      const datasource = (provider as any).datasourceName ?? "Prometheus";
      const promql = `up{service="${serviceName}"}`;
      const pane = JSON.stringify({
        datasource,
        queries: [{ refId: "A", expr: promql }],
        range: { from: String(fromMs), to: String(toMs) },
      });
      links.push(`${base}/explore?schemaVersion=1&panes=${encodeURIComponent(`{"a":${pane}}`)}`);
    }
  }

  return links;
}

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

      // Build Grafana Explore deep links for the investigation time range
      const dashboardLinks = [...(inputData.dashboardLinks ?? [])];
      if (inputData.timeRange) {
        const exploreLinks = buildGrafanaExploreLinks(config, serviceName, inputData.timeRange);
        dashboardLinks.push(...exploreLinks);
      }

      return {
        severity: inputData.severity,
        summary: inputData.summary,
        impact: inputData.impact,
        rootCause: inputData.rootCause,
        trigger: inputData.trigger,
        contributingFactors: inputData.contributingFactors,
        timeline: inputData.timeline,
        evidence: inputData.evidence,
        evidenceToolCalls: inputData.evidenceToolCalls,
        dashboardLinks,
        recommendedActions: inputData.recommendedActions,
        confidence: inputData.confidence,
        confidenceScore: inputData.confidenceScore,
        savedToHistory,
        investigatedAt,
        timeRange: inputData.timeRange,
        // Pass-through for the RCA report UI — neighbors flowed through the
        // evidence → synthesis → post-synthesis chain via schema fields (F-Eng-2 alt).
        neighbors: inputData.neighbors ?? [],
      };
    },
  });
}
