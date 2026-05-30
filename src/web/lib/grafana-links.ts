import type { EvidenceAction } from "../../types/evidence.js";
import type { ToolCallRecord } from "../../types/evidence.js";

/**
 * Build a Grafana Explore URL using the panes format (Grafana 10+, schemaVersion=1).
 */
export function buildExploreUrl(params: {
  webUrl: string;
  datasource?: string; // name or UID
  query: string;
  from: string; // ISO timestamp or epoch ms
  to: string;
}): string {
  const { webUrl, datasource, query, from, to } = params;
  // Separate base path from query params — webUrl may include ?orgId=1
  const [basePath, existingQuery] = webUrl.split("?");
  const base = basePath!.replace(/\/+$/, "");

  const fromMs = toEpochMs(from);
  const toMs = toEpochMs(to);
  if (isNaN(fromMs) || isNaN(toMs)) return "";

  const pane = JSON.stringify({
    datasource: datasource ?? "default",
    queries: [{ refId: "A", expr: query }],
    range: { from: String(fromMs), to: String(toMs) },
  });

  // Preserve existing query params (e.g. orgId=1) alongside explore params
  const extraParams = existingQuery ? `&${existingQuery}` : "";
  return `${base}/explore?schemaVersion=1&panes=${encodeURIComponent(`{"a":${pane}}`)}${extraParams}`;
}

/**
 * Build a phase-level deep link — generic Explore for a service + time range.
 * Used as fallback when per-observation links aren't available.
 */
export function buildPhaseLink(params: {
  webUrl: string;
  service: string;
  from: string;
  to: string;
  role: string;
  datasource?: string;
}): string {
  const { webUrl, service, from, to, role, datasource } = params;

  if (role === "logs") {
    const logql = `{app="${service}"} |~ "(?i)(error|exception|fail)"`;
    return buildExploreUrl({ webUrl, datasource: datasource ?? "loki", query: logql, from, to });
  }

  // Default: metrics query for the service
  const promql = `up{service="${service}"}`;
  return buildExploreUrl({ webUrl, datasource: datasource ?? "Prometheus", query: promql, from, to });
}

/**
 * Extract a query string from tool call args. Returns null if args don't contain
 * a recognizable query field.
 */
export function extractQueryFromToolCall(
  toolName: string,
  argsJson: string,
): { query: string; datasource?: string; kind: "metrics" | "logs" } | null {
  try {
    const args = JSON.parse(argsJson);

    // query_prometheus / query_* tools use expr or expression → PromQL (metrics)
    if (args.expr) return { query: args.expr, datasource: args.datasource, kind: "metrics" };
    if (args.expression) return { query: args.expression, datasource: args.datasource, kind: "metrics" };

    // query_loki_logs uses logql → LogQL (logs)
    if (args.logql) return { query: args.logql, datasource: args.datasource, kind: "logs" };

    // Generic query field — infer the language from the tool name.
    if (args.query && typeof args.query === "string") {
      const t = toolName.toLowerCase();
      const kind = t.includes("loki") || t.includes("log") ? "logs" : "metrics";
      return { query: args.query, datasource: args.datasource, kind };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Build evidence actions for a set of tool calls and provider config.
 * Returns phase-level actions (always) and observation-level actions (when query extractable).
 */
export function buildPhaseActions(
  toolCalls: ToolCallRecord[] | undefined,
  providers: Array<{ role: string; webUrl: string; datasource?: string }>,
  service: string,
  timeRange?: { from: string; to: string },
): { phaseActions: Record<string, EvidenceAction>; observationActions: EvidenceAction[] } {
  const phaseActions: Record<string, EvidenceAction> = {};
  const observationActions: EvidenceAction[] = [];

  if (!timeRange) return { phaseActions, observationActions };

  for (const provider of providers) {
    if (!provider.webUrl) continue;

    const url = buildPhaseLink({
      webUrl: provider.webUrl,
      service,
      from: timeRange.from,
      to: timeRange.to,
      role: provider.role,
      datasource: provider.datasource,
    });

    if (url) {
      phaseActions[provider.role] = {
        label: `Open in Grafana`,
        url,
        provider: provider.role,
        role: provider.role,
        tier: "phase",
      };
    }
  }

  // Try to extract observation-level links from tool calls
  if (toolCalls) {
    for (const tc of toolCalls) {
      const extracted = extractQueryFromToolCall(tc.tool, tc.args);
      if (!extracted) continue;

      // Find matching provider by tool name heuristic
      const role = tc.tool.includes("loki") || tc.tool.includes("log") ? "logs" : "metrics";
      const provider = providers.find(p => p.role === role);
      if (!provider?.webUrl) continue;

      const url = buildExploreUrl({
        webUrl: provider.webUrl,
        datasource: extracted.datasource ?? provider.datasource,
        query: extracted.query,
        from: timeRange.from,
        to: timeRange.to,
      });

      if (url) {
        observationActions.push({
          label: `Open in Grafana`,
          url,
          provider: provider.role,
          role,
          tier: "observation",
        });
      }
    }
  }

  return { phaseActions, observationActions };
}

function toEpochMs(ts: string): number {
  const n = Number(ts);
  if (!isNaN(n) && n > 1e12) return n; // already epoch ms
  return new Date(ts).getTime();
}
