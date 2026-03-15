/**
 * Anomaly detection step for the investigation workflow.
 *
 * For user-reported issues, skips full anomaly detection (matches legacy
 * behavior) and just passes through the context with default severity.
 * For proactive mode, runs the anomaly detector agent.
 */

import { createStep } from "@mastra/core/workflows";
import type { WorkflowConfig } from "../investigation.js";
import { PrefetchOutputSchema, AnomalyOutputSchema } from "../schemas.js";
import { getToolsByRole } from "../../mcp/provider.js";
import { wrapToolsWithCallbacks, selectToolsBySuffix, debug, ANOMALY_TOOLS } from "../tool-utils.js";
import { getTimeContext } from "../../agents/shared/time-context.js";
import { safeJsonParse } from "../../agents/shared/processors.js";
import { createAnomalyDetectorAgent } from "../../agents/anomaly-detector.js";

/**
 * Build an anomaly detection step using the anomaly detector agent.
 */
export function buildAnomalyStep(config: WorkflowConfig) {
  return createStep({
    id: "anomaly-detection",
    description: "Detect anomalies from metrics and dashboards",
    inputSchema: PrefetchOutputSchema,
    outputSchema: AnomalyOutputSchema,
    execute: async ({ inputData }) => {
      debug("ANOMALY step entered, keys:", Object.keys(inputData));
      config.onPhase?.("Detecting anomalies");

      // For user-reported issues, skip full anomaly detection (matches legacy behavior).
      // The user already told us what's wrong — just extract the time range and pass through.
      // Running the anomaly agent wastes iterations on broad unfocused queries.
      const isUserReported = !!inputData.userMessage?.trim();

      let isAnomaly = true;
      let severity: "low" | "medium" | "high" | "critical" = "high";
      let summary = inputData.userMessage;

      if (!isUserReported) {
        // Proactive mode: run anomaly detection agent
        const allTools = await getToolsByRole(config.providers, "metrics").catch(() => ({}));
        const rawTools = selectToolsBySuffix(allTools, ANOMALY_TOOLS);
        const tools = wrapToolsWithCallbacks(rawTools, config.onToolCall);

        const agent = createAnomalyDetectorAgent({
          model: config.model,
          tools,
          useQuirkHandling: config.useQuirkHandling,
        });

        const prompt = [
          getTimeContext(),
          inputData.datasourceHints,
          inputData.dashboardContext,
          `User message: ${inputData.userMessage}`,
          inputData.serviceName ? `Service: ${inputData.serviceName}` : "",
        ].filter(Boolean).join("\n");

        let agentResult: { text: string } = { text: "" };
        const anomalyToolData: string[] = [];
        let anomalyIterationCount = 0;
        try {
          agentResult = await agent.generate(prompt, {
            onStepFinish: (step: any) => {
              try {
                debug("ANOMALY onStepFinish, toolResults sample:", JSON.stringify(step.toolResults?.[0] ?? {}).slice(0, 300));
                anomalyIterationCount++;
                config.onIteration?.("anomaly", anomalyIterationCount, 10, `Step ${anomalyIterationCount}`);
                if (step.toolResults?.length) {
                  for (const tr of step.toolResults) {
                    const payload = tr.payload ?? tr;
                    const toolName = payload.toolName ?? payload.name ?? tr.toolName ?? "unknown";
                    const nestedContent = payload.result?.content?.[0]?.text;
                    const rawResult = nestedContent ?? payload.result ?? tr.result ?? tr.output ?? "";
                    const resultStr = typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult);
                    const truncated = resultStr.length > 2000 ? resultStr.slice(0, 2000) + "..." : resultStr;
                    anomalyToolData.push(`Tool: ${toolName}\nResult: ${truncated}`);
                  }
                }
                if (step.text) anomalyToolData.push(`Model: ${step.text}`);
              } catch (err) {
                debug("ANOMALY onStepFinish error:", err);
              }
            },
          });
        } catch (err) {
          debug("ANOMALY agent.generate error:", err);
        }

        let textToParse = agentResult.text;
        if (!textToParse?.trim() && anomalyToolData.length > 0) {
          debug("ANOMALY: empty text, extracting from", anomalyToolData.length, "captured tool results");
          const { Agent: ExtractAgent } = await import("@mastra/core/agent");
          const extractor = new ExtractAgent({
            name: "anomaly-extractor",
            id: "anomaly-extractor",
            instructions: 'Extract structured data from investigation results. Return ONLY valid JSON: {"isAnomaly": boolean, "severity": "low"|"medium"|"high"|"critical", "summary": "string", "affectedServices": ["string"]}',
            model: config.model as any,
          });
          try {
            const extraction = await extractor.generate(anomalyToolData.join("\n\n"));
            textToParse = extraction.text ?? "";
          } catch { /* keep empty */ }
        }
        debug("ANOMALY text to parse (first 500):", textToParse?.slice(0, 500));

        const anomalyParsed = safeJsonParse(textToParse);
        debug("ANOMALY parsed:", anomalyParsed ? "OK" : "FAILED");
        if (anomalyParsed) {
          isAnomaly = anomalyParsed.isAnomaly ?? true;
          severity = anomalyParsed.severity ?? "medium";
          summary = anomalyParsed.summary ?? inputData.userMessage;
        }
      } else {
        debug("ANOMALY: user-reported issue, skipping agent — extracting time range only");
      }

      const prefetchContext = {
        datasourceHints: inputData.datasourceHints,
        dashboardContext: inputData.dashboardContext,
        panelQueryHints: inputData.panelQueryHints,
        logLabelHints: inputData.logLabelHints,
        workingLogSelectors: inputData.workingLogSelectors,
      };

      return {
        isAnomaly,
        severity,
        summary,
        affectedServices: inputData.serviceName ? [inputData.serviceName] : [],
        prefetchContext,
        userMessage: inputData.userMessage,
        serviceName: inputData.serviceName,
        skillContext: inputData.skillContext,
      };
    },
  });
}
