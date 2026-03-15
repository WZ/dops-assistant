/**
 * Prefetch step for the investigation workflow.
 *
 * Discovers datasources, dashboards, and log labels before the investigation
 * evidence phases begin.
 */

import { createStep } from "@mastra/core/workflows";
import type { WorkflowConfig } from "../investigation.js";
import { WorkflowInputSchema, PrefetchOutputSchema } from "../schemas.js";
import { executePrefetch } from "./prefetch.js";
import { debug } from "../tool-utils.js";

/**
 * Build a prefetch step that discovers datasources, dashboards, and log labels.
 */
export function buildPrefetchStep(config: WorkflowConfig) {
  return createStep({
    id: "prefetch",
    description: "Pre-fetch datasource UIDs, dashboard list, and log label context",
    inputSchema: WorkflowInputSchema,
    outputSchema: PrefetchOutputSchema,
    execute: async ({ inputData }) => {
      debug("PREFETCH step entered, keys:", Object.keys(inputData));
      config.onPhase?.("Detecting anomalies");
      config.onIteration?.("planning", 0, 6, "Pre-fetching datasource context");

      const prefetchContext = await executePrefetch(
        config.providers,
        config.services,
        {
          userMessage: inputData.userMessage,
          serviceName: inputData.serviceName,
        },
      );

      return {
        ...prefetchContext,
        userMessage: inputData.userMessage,
        alertName: inputData.alertName,
        serviceName: inputData.serviceName,
      };
    },
  });
}
