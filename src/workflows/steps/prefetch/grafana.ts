import type { Tool } from "@mastra/core/tools";
import type { MastraProvider } from "../../../mcp/provider.js";
import type { ServiceConfig } from "../../../config/schema.js";
import { extractDashboardPanelHints, extractQueryKeywords } from "../prefetch.js";
import { type PrefetchStrategy, type ToolMap, hasTool, callProviderTool } from "./types.js";

export class GrafanaPrefetchStrategy implements PrefetchStrategy {
  name = "grafana";

  /**
   * Fetch datasource UIDs from providers that have metrics or dashboards roles.
   */
  async fetchDatasourceHints(
    toolMaps: ToolMap[],
    providers: MastraProvider[],
  ): Promise<string> {
    const eligible = toolMaps.filter(
      ({ provider }) => provider.roles.includes("metrics") || provider.roles.includes("dashboards"),
    );

    for (const { tools } of eligible) {
      if (!hasTool(tools, "list_datasources")) continue;

      const raw = await callProviderTool(tools, "list_datasources", {});
      if (!raw) continue;

      try {
        const parsed = JSON.parse(raw);
        const datasources = (Array.isArray(parsed) ? parsed : parsed?.datasources ?? []) as Array<{
          uid: string;
          name: string;
          type: string;
        }>;
        const relevant = datasources.filter((d) => d.type === "prometheus" || d.type === "loki");
        if (relevant.length === 0) continue;

        const lines = relevant.map((d) => `- ${d.type}: datasourceUid="${d.uid}" (${d.name})`);
        return (
          `Available datasources (use these UIDs directly, do NOT call list_datasources):\n${lines.join("\n")}\n` +
          `IMPORTANT: You MUST use the exact datasourceUid values above when calling query_prometheus or query_loki_logs.`
        );
      } catch {
        // Try next provider
      }
    }

    // Suppress unused warning — providers is used to filter toolMaps above
    void providers;
    return "";
  }

  /**
   * Fetch dashboard list and panel queries from dashboard-role providers.
   */
  async fetchDashboardContext(
    toolMaps: ToolMap[],
    providers: MastraProvider[],
    opts?: { userMessage?: string; anomalySummary?: string; datasourceHints?: string; serviceName?: string },
  ): Promise<{ dashboardContext: string; panelQueryHints: string }> {
    const empty = { dashboardContext: "", panelQueryHints: "" };

    // Suppress unused warning
    void providers;

    const dashboardMaps = toolMaps.filter(({ provider }) =>
      provider.roles.includes("dashboards"),
    );
    if (dashboardMaps.length === 0) return empty;

    for (const { tools } of dashboardMaps) {
      if (!hasTool(tools, "search_dashboards")) continue;

      const searchRaw = await callProviderTool(tools, "search_dashboards", { query: "" });
      if (!searchRaw) continue;

      let rawDashboards: Array<{ uid: string; title: string }>;
      try {
        const parsed = JSON.parse(searchRaw);
        rawDashboards = (Array.isArray(parsed) ? parsed : parsed?.dashboards ?? []) as Array<{
          uid: string;
          title: string;
        }>;
      } catch {
        continue;
      }

      const allDashboards = rawDashboards
        .filter((d) => !d.title.startsWith("dops-temp:"))
        .slice(0, 20);

      if (allDashboards.length === 0) return empty;

      const dashLines = allDashboards.map((d) => `- "${d.title}" (uid: ${d.uid})`);
      const dashboardContext = `Available dashboards (already fetched, do NOT call search_dashboards):\n${dashLines.join("\n")}`;

      if (!hasTool(tools, "get_dashboard_panel_queries")) {
        return { dashboardContext, panelQueryHints: "" };
      }

      // Score dashboards by relevance — include service name tokens for better targeting
      const queryKeywords = extractQueryKeywords(opts?.userMessage, opts?.anomalySummary);
      const { dashboardHint } = extractDashboardPanelHints(opts?.userMessage, opts?.anomalySummary);
      const hintTokens = dashboardHint
        ? dashboardHint.toLowerCase().split(/[-_\s]+/).filter((t) => t.length > 1)
        : [];
      const serviceTokens = opts?.serviceName
        ? opts.serviceName.toLowerCase().split(/[-_\s]+/).filter((t) => t.length > 1)
        : [];

      const scored = allDashboards.map((d) => {
        const title = d.title.toLowerCase();
        const hintScore = hintTokens.filter((t) => title.includes(t)).length * 3;
        const serviceScore = serviceTokens.filter((t) => title.includes(t)).length * 3;
        const keywordScore = queryKeywords.filter((t) => title.includes(t)).length * 2;
        return { ...d, score: hintScore + serviceScore + keywordScore };
      });
      scored.sort((a, b) => b.score - a.score);

      const topDashboards = scored.filter((d) => d.score > 0).slice(0, 3);
      if (topDashboards.length === 0) topDashboards.push(...scored.slice(0, 2));

      // Extract default Prometheus UID from datasource hints
      const promUidMatch = opts?.datasourceHints?.match(/prometheus: datasourceUid="([^"]+)"/);
      const defaultPromUid = promUidMatch?.[1];

      const sections: string[] = [];
      for (const db of topDashboards) {
        const panelRaw = await callProviderTool(tools, "get_dashboard_panel_queries", { uid: db.uid });
        if (!panelRaw) continue;

        try {
          const queries = JSON.parse(panelRaw) as Array<{
            title: string;
            query: string;
            datasource: { uid: string; type: string };
          }>;

          const enriched = queries.map((q) => ({
            ...q,
            datasource: {
              uid: q.datasource.uid || defaultPromUid || "(default)",
              type: q.datasource.type || "prometheus",
            },
          }));

          // Filter panel queries by service name relevance when available
          let filtered = enriched;
          if (serviceTokens.length > 0) {
            const serviceMatched = enriched.filter((q) =>
              serviceTokens.some((t) => q.title.toLowerCase().includes(t) || q.query.toLowerCase().includes(t)),
            );
            // Only apply filter if it keeps at least some results
            if (serviceMatched.length > 0) filtered = serviceMatched;
          }

          // Deduplicate by query text
          const seen = new Set<string>();
          const deduped = filtered.filter((q) => {
            if (seen.has(q.query)) return false;
            seen.add(q.query);
            return true;
          }).slice(0, 15);

          const lines = deduped.map(
            (q) => `  - "${q.title}": \`${q.query}\` (datasource: ${q.datasource.uid})`,
          );
          sections.push(`Dashboard "${db.title}" (uid: ${db.uid}):\n${lines.join("\n")}`);
        } catch {
          // Skip failing dashboards
        }
      }

      if (sections.length === 0) return { dashboardContext, panelQueryHints: "" };

      const panelQueryHints = [
        "PANEL QUERIES (pre-fetched — use these PromQL expressions directly, do NOT call get_dashboard_panel_queries or get_dashboard_by_uid):",
        ...sections,
      ].join("\n\n");

      return { dashboardContext, panelQueryHints };
    }

    return empty;
  }

  /**
   * Fetch Loki label hints and working log selectors for each service.
   */
  async fetchLogContext(
    toolMaps: ToolMap[],
    providers: MastraProvider[],
    services: ServiceConfig[],
    datasourceHints: string,
    targetServiceName?: string,
  ): Promise<{ logLabelHints: string; workingLogSelectors: string[] }> {
    const empty = { logLabelHints: "", workingLogSelectors: [] as string[] };

    // Suppress unused warning
    void providers;

    const logMaps = toolMaps.filter(({ provider }) => provider.roles.includes("logs"));
    if (logMaps.length === 0) return empty;

    // Find a provider with Loki tools
    const lokiMap = logMaps.find(({ tools }) => hasTool(tools, "query_loki_logs"));
    if (!lokiMap) return empty;

    const { tools } = lokiMap;

    // Extract Loki datasource UID
    const lokiUidMatch = datasourceHints.match(/loki: datasourceUid="([^"]+)"/);
    const lokiUid = lokiUidMatch?.[1];
    if (!lokiUid) return empty;

    // Fetch label hints
    let logLabelHints = "";
    if (hasTool(tools, "list_loki_label_names")) {
      const labelsRaw = await callProviderTool(tools, "list_loki_label_names", {
        datasourceUid: lokiUid,
      });
      if (labelsRaw) {
        try {
          const parsed = JSON.parse(labelsRaw);
          const labels = Array.isArray(parsed) ? parsed : parsed?.labels ?? [];
          if ((labels as string[]).length > 0) {
            logLabelHints = `Available Loki labels (do NOT call list_loki_label_names):\n${(labels as string[]).join(", ")}`;
          }
        } catch {
          // Keep empty
        }
      }
    }

    // Probe working selectors — limit to the target service if specified,
    // otherwise probe the first 5 services to avoid excessive API calls
    const targetServices = targetServiceName
      ? services.filter((s) => s.name === targetServiceName)
      : services.slice(0, 5);
    const workingLogSelectors: string[] = [];
    for (const service of targetServices) {
      try {
        const selector = await probeWorkingLogSelector(tools, lokiUid, service);
        if (selector) workingLogSelectors.push(selector);
      } catch {
        // Skip failing services
      }
    }

    return { logLabelHints, workingLogSelectors };
  }
}

// ── Loki helpers ──────────────────────────────────────────────────────────────

function escapeLogQLValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeLogQLRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasLogData(text: string | undefined): boolean {
  if (!text || text.length < 3) return false;
  try {
    const parsed = JSON.parse(text);
    const data = Array.isArray(parsed) ? parsed : parsed?.data;
    return Array.isArray(data) && data.length > 0;
  } catch {
    return text.length > 10;
  }
}

/**
 * Try candidate Loki selectors until one returns log data.
 * Returns the first working selector, or empty string if none work.
 */
async function probeWorkingLogSelector(
  tools: Record<string, Tool>,
  lokiUid: string,
  service: ServiceConfig,
): Promise<string> {
  const svcName = service.name;
  const escapedName = escapeLogQLValue(svcName);

  const candidates: string[] = [];

  // 1. Configured log labels
  const configuredLabels = service.logLabels;
  if (Object.keys(configuredLabels).length > 0) {
    const parts = Object.entries(configuredLabels).map(([k, v]) => `${k}="${escapeLogQLValue(v)}"`);
    candidates.push(`{${parts.join(", ")}}`);
  }

  // 2. Common fallback patterns
  candidates.push(
    `{job="default/${escapedName}"}`,
    `{container_name="${escapedName}"}`,
    `{app="${escapedName}"}`,
    `{chart="${escapedName}"}`,
  );

  // Deduplicate
  const seen = new Set<string>();
  const unique = candidates.filter((c) => {
    if (seen.has(c)) return false;
    seen.add(c);
    return true;
  });

  // Probe each candidate
  for (const selector of unique) {
    const result = await callProviderTool(tools, "query_loki_logs", {
      datasourceUid: lokiUid,
      logql: selector,
      limit: 1,
    });
    if (result && hasLogData(result)) return selector;
  }

  // Regex fallbacks
  const escapedRegex = escapeLogQLRegex(svcName);
  const regexCandidates = [
    `{job=~".*${escapedRegex}.*"}`,
    `{container_name=~".*${escapedRegex}.*"}`,
  ];
  for (const selector of regexCandidates) {
    const result = await callProviderTool(tools, "query_loki_logs", {
      datasourceUid: lokiUid,
      logql: selector,
      limit: 1,
    });
    if (result && hasLogData(result)) return selector;
  }

  return "";
}
