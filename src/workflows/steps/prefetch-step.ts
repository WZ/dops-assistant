/**
 * Prefetch step for the investigation workflow.
 *
 * Three parallel tracks:
 *   1. executePrefetch         — datasource UIDs, dashboards, log label hints
 *   2. fetchCorootNeighbors    — 1-hop neighbors with status + rate (Coroot)
 *   3. fetchNeighborEvidence   — PromQL + LogQL evidence for top-3 unhealthy neighbors
 *
 * See design doc Option 3 / F-Eng-4 / F-Eng-2-alt for the reasoning behind
 * pushing neighbor evidence into prefetch rather than routing it through the
 * metrics/logs evidence agents (which refuse to query non-primary services).
 */

import { createStep } from "@mastra/core/workflows";
import type { WorkflowConfig } from "../investigation.js";
import { WorkflowInputSchema, PrefetchOutputSchema } from "../schemas.js";
import { executePrefetch } from "./prefetch.js";
import { debug } from "../tool-utils.js";
import { fetchCorootNeighbors } from "../../server/coroot.js";
import {
  selectNeighborsForEvidenceFetch,
  fetchNeighborEvidence,
} from "../../server/neighbor-evidence.js";
import type { Neighbor } from "../../types/workflow-state.js";
import { createLogger } from "../../logger.js";

const logger = createLogger();

/**
 * Build a prefetch step that discovers datasources, dashboards, log labels,
 * and Coroot neighbor evidence for the investigation workflow.
 */
export function buildPrefetchStep(config: WorkflowConfig) {
  return createStep({
    id: "prefetch",
    description: "Pre-fetch datasource UIDs, dashboards, log labels, and Coroot neighbor evidence",
    inputSchema: WorkflowInputSchema,
    outputSchema: PrefetchOutputSchema,
    execute: async ({ inputData }) => {
      debug("PREFETCH step entered, keys:", Object.keys(inputData));
      config.onPhase?.("Detecting anomalies");
      config.onIteration?.("planning", 0, 6, "Pre-fetching datasource + dependency context");

      // Track 1 + Track 2 run in parallel. Track 3 (per-neighbor evidence) has
      // to wait for Track 2's output but runs in parallel across neighbors.
      const [prefetchContext, corootNeighborsRaw] = await Promise.all([
        executePrefetch(config.providers, config.services, {
          userMessage: inputData.userMessage,
          serviceName: inputData.serviceName,
        }),
        inputData.serviceName
          ? fetchCorootNeighbors(
              inputData.serviceName,
              config.providers,
              config.services,
            ).catch((err) => {
              debug("PREFETCH coroot-neighbors failed:", err);
              return null;
            })
          : Promise.resolve(null),
      ]);

      const corootNeighbors: Neighbor[] = corootNeighborsRaw ?? [];

      // Track 3: fetch per-neighbor evidence for the top-N unhealthy ones.
      const neighborsToEnrich = selectNeighborsForEvidenceFetch(corootNeighbors, {
        maxNeighbors: 3,
        minStatus: "degraded",
        requireInRegistry: true,
      });

      const enrichedMap = new Map<string, Neighbor>();
      for (const n of corootNeighbors) enrichedMap.set(n.name, n);

      if (neighborsToEnrich.length > 0) {
        const enrichResults = await Promise.all(
          neighborsToEnrich.map(async (n) => {
            try {
              const evidence = await fetchNeighborEvidence(
                n,
                config.providers,
                config.services,
              );
              return { ...n, evidence };
            } catch (err) {
              debug(`PREFETCH neighbor-evidence failed for ${n.name}:`, err);
              return {
                ...n,
                evidence: {
                  metrics: [],
                  logs: [],
                  fetchedAt: new Date().toISOString(),
                  fetchErrors: [String(err)],
                },
              };
            }
          }),
        );
        for (const enriched of enrichResults) {
          enrichedMap.set(enriched.name, enriched);
        }
      }

      const enrichedNeighbors = Array.from(enrichedMap.values());

      // Observability counts — addresses Codex C8 "silent degradation overused".
      const unhealthyCount = corootNeighbors.filter(
        (n) => n.status === "unhealthy" || n.status === "degraded",
      ).length;
      const withEvidence = enrichedNeighbors.filter((n) => n.evidence).length;
      const withFetchErrors = enrichedNeighbors.filter(
        (n) => n.evidence && n.evidence.fetchErrors.length > 0,
      ).length;
      logger.debug(
        {
          service: inputData.serviceName,
          total: corootNeighbors.length,
          unhealthy: unhealthyCount,
          enriched: neighborsToEnrich.length,
          withEvidence,
          withFetchErrors,
        },
        "prefetch: coroot neighbor discovery + evidence fetch complete",
      );

      return {
        ...prefetchContext,
        neighbors: enrichedNeighbors,
        userMessage: inputData.userMessage,
        alertName: inputData.alertName,
        serviceName: inputData.serviceName,
        skillContext: inputData.skillContext,
      };
    },
  });
}
