/**
 * Extract dashboard and panel name hints from the user message and anomaly summary.
 * Looks for patterns like "(Panel Name in Dashboard Name)" or just quoted names.
 */
export function extractDashboardPanelHints(
  userMessage?: string,
  anomalySummary?: string,
): { dashboardHint: string | null; panelHint: string | null } {
  const text = `${userMessage ?? ""} ${anomalySummary ?? ""}`;

  // Pattern: "(Panel Name in Dashboard Name)" — e.g. "(Ingestion Log Rate in Ingestion monitor)"
  const parenMatch = text.match(/\(([^)]+?)\s+in\s+([^)]+?)\)/i);
  if (parenMatch) {
    return { panelHint: parenMatch[1]!.trim(), dashboardHint: parenMatch[2]!.trim() };
  }

  // Pattern: "Panel Name in Dashboard Name" without parens — less strict, require "dashboard"/"monitor" suffix
  const inMatch = text.match(/([A-Z][A-Za-z\s]+?)\s+in\s+([A-Z][A-Za-z\s]*(?:dashboard|monitor|overview))/i);
  if (inMatch) {
    return { panelHint: inMatch[1]!.trim(), dashboardHint: inMatch[2]!.trim() };
  }

  return { dashboardHint: null, panelHint: null };
}

/**
 * Extract keywords from a user query for scoring dashboards/panels.
 * Simple tokenizer — keeps words 4+ chars, skips common noise.
 */
export function extractQueryKeywords(userMessage?: string, anomalySummary?: string): string[] {
  const text = `${userMessage ?? ""} ${anomalySummary ?? ""}`.toLowerCase();
  return text.split(/[^a-z0-9]+/).filter((t) => t.length > 3);
}

// ── executePrefetch ────────────────────────────────────────────────────────────

import { listProviderTools, type MastraProvider } from "../../mcp/provider.js";
import type { ServiceConfig } from "../../config/schema.js";
import type { PrefetchedContext } from "../../types/workflow-state.js";
import type { Tool } from "@mastra/core/tools";
import { selectPrefetchStrategy } from "./prefetch/index.js";

/**
 * Consolidate all prefetch operations for an investigation:
 *   1. Datasource UIDs (Prometheus/Loki) — so phases don't waste iterations on list_datasources
 *   2. Dashboard list + panel queries — pre-fetched context string
 *   3. Loki label hints + working log selectors — discovered via log provider tools
 *
 * Gracefully degrades: if a provider is unavailable or a call fails, that section
 * is returned as an empty string / empty array.
 */
export async function executePrefetch(
  providers: MastraProvider[],
  services: ServiceConfig[],
  opts?: {
    userMessage?: string;
    anomalySummary?: string;
    serviceName?: string;
  },
): Promise<PrefetchedContext> {
  const emptyContext: PrefetchedContext = {
    datasourceHints: "",
    dashboardContext: "",
    panelQueryHints: "",
    logLabelHints: "",
    workingLogSelectors: [],
  };

  if (providers.length === 0) return emptyContext;

  // Fetch all tool maps up front (one call per provider)
  const toolMaps = await Promise.all(
    providers.map(async (p) => {
      try {
        return { provider: p, tools: await listProviderTools(p) };
      } catch {
        return { provider: p, tools: {} as Record<string, Tool> };
      }
    }),
  );

  // Select strategy based on available tools
  const strategy = selectPrefetchStrategy(toolMaps);

  // ── 1. Datasource UIDs ───────────────────────────────────────────────────
  const datasourceHints = await strategy.fetchDatasourceHints(toolMaps, providers);

  // ── 2. Dashboard list + panel queries ────────────────────────────────────
  const { dashboardContext, panelQueryHints } = await strategy.fetchDashboardContext(
    toolMaps,
    providers,
    {
      userMessage: opts?.userMessage,
      anomalySummary: opts?.anomalySummary,
      datasourceHints,
      serviceName: opts?.serviceName,
    },
  );

  // ── 3. Log adapter: label hints + working selectors ──────────────────────
  const { logLabelHints, workingLogSelectors } = await strategy.fetchLogContext(
    toolMaps,
    providers,
    services,
    datasourceHints,
    opts?.serviceName,
  );


  return {
    datasourceHints,
    dashboardContext,
    panelQueryHints,
    logLabelHints,
    workingLogSelectors,
  };
}
