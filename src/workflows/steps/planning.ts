/**
 * Planning step for the investigation workflow.
 *
 * Fetches recent incidents and creates an investigation plan with hypotheses
 * and focus areas for the evidence gathering phases.
 */

import { createStep } from "@mastra/core/workflows";
import type { WorkflowConfig } from "../investigation.js";
import { AnomalyOutputSchema, PlanningOutputSchema } from "../schemas.js";
import { getRecentIncidents, formatIncidentHistory } from "../history.js";
import { debug } from "../tool-utils.js";
import { safeJsonParse } from "../../agents/shared/processors.js";
import { createPlannerAgent } from "../../agents/planner.js";
import { wrapUntrusted } from "../../agents/shared/prompt-helpers.js";

/**
 * Build a planning step that fetches recent incidents and creates an investigation plan.
 */
export function buildPlanningStep(config: WorkflowConfig) {
  return createStep({
    id: "planning",
    description: "Fetch recent incidents and generate investigation hypotheses",
    inputSchema: AnomalyOutputSchema,
    outputSchema: PlanningOutputSchema,
    execute: async ({ inputData }) => {
      debug("PLANNING step entered, keys:", Object.keys(inputData));
      // Fetch recent incidents for context
      let historyContext = "";
      if (config.projectRoot && inputData.serviceName) {
        try {
          const recentIncidents = await getRecentIncidents(config.projectRoot, inputData.serviceName);
          historyContext = formatIncidentHistory(recentIncidents);
        } catch {
          // Graceful degradation
        }
      }

      config.onPhase?.("Planning investigation");
      config.onIteration?.("planning", 1, 6, "Building investigation plan");

      const agent = createPlannerAgent({ model: config.model });

      // Inject service config so the planner knows what metrics/logs are available
      const service = inputData.serviceName
        ? config.services.find((s) => s.name === inputData.serviceName)
        : undefined;
      const serviceMetricsHint = service?.metrics.length
        ? `Service metrics: ${service.metrics.map((m) => `${m.description} (${m.query})`).join(", ")}`
        : "";
      const serviceLogLabelsHint = service?.logLabels && Object.keys(service.logLabels).length > 0
        ? `Log labels: ${JSON.stringify(service.logLabels)}`
        : "";

      const prompt = [
        `Anomaly: ${wrapUntrusted("anomaly_summary", inputData.summary)}`,
        `Severity: ${inputData.severity ?? "unknown"}`,
        inputData.serviceName ? `Service: ${wrapUntrusted("service", inputData.serviceName)}` : "",
        serviceMetricsHint ? wrapUntrusted("metrics", serviceMetricsHint) : "",
        serviceLogLabelsHint ? wrapUntrusted("log_labels", serviceLogLabelsHint) : "",
        inputData.skillContext
          ? `${wrapUntrusted("skill_context", inputData.skillContext)}\nUse these runbooks to inform your hypothesis planning. Prioritize investigation steps mentioned in matched skills.`
          : "",
        historyContext ? `\nRecent incidents:\n${historyContext}` : "",
      ].filter(Boolean).join("\n");

      let agentResult: { text: string; usage?: any } = { text: "" };
      try {
        agentResult = await agent.generate(prompt);
        if (agentResult.usage && config.onTokenUsage) {
          config.onTokenUsage({
            inputTokens: agentResult.usage.inputTokens ?? 0,
            outputTokens: agentResult.usage.outputTokens ?? 0,
          });
        }
      } catch {
        // Fall through to defaults
      }

      let hypotheses: Array<{ hypothesis: string; evidenceNeeded: string }> = [];
      let metricFocus: string[] = [];
      let logFocus: string[] = [];
      let infraFocus: string[] = [];

      const plannerParsed = safeJsonParse(agentResult.text);
      if (plannerParsed) {
        hypotheses = plannerParsed.hypotheses ?? [];
        metricFocus = plannerParsed.metricFocus ?? [];
        logFocus = plannerParsed.logFocus ?? [];
        infraFocus = plannerParsed.infraFocus ?? [];
      }

      // Emit plan details so the UI can display them (matches legacy behavior)
      if (hypotheses.length > 0) {
        const hypothesisText = hypotheses.map((h) => `${h.hypothesis} → ${h.evidenceNeeded}`).join(" | ");
        config.onIteration?.("planning", 0, 1, `Hypotheses: ${hypothesisText}`);
      }
      if (metricFocus.length > 0 || logFocus.length > 0 || infraFocus.length > 0) {
        const focusItems = [
          ...metricFocus.map((f) => `metric: ${f}`),
          ...logFocus.map((f) => `log: ${f}`),
          ...infraFocus.map((f) => `infra: ${f}`),
        ];
        config.onIteration?.("planning", 0, 1, `Focus: ${focusItems.join(", ")}`);
      }

      return {
        hypotheses,
        metricFocus,
        logFocus,
        infraFocus,
        anomalyContext: inputData,
      };
    },
  });
}
