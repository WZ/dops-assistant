import type { ServiceConfig } from "../../config/schema.js";
import type { McpClient } from "../client.js";
import type { LogProviderAdapter, TimeWindow } from "./types.js";
import pino from "pino";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

export class GrafanaLokiAdapter implements LogProviderAdapter {
  private readonly mcp: McpClient;
  private readonly lokiUid: string;

  constructor(mcp: McpClient, lokiUid: string) {
    this.mcp = mcp;
    this.lokiUid = lokiUid;
  }

  /**
   * Pre-fetch Loki label names so the LLM knows which labels exist
   * without calling list_loki_label_names.
   */
  async getLabelsHint(): Promise<string> {
    const toolNames = this.mcp.getTools().map((t) => t.function.name);
    if (!toolNames.includes("list_loki_label_names")) return "";

    try {
      const result = await this.mcp.callTool("list_loki_label_names", {
        datasourceUid: this.lokiUid,
      });
      const parsed = JSON.parse(result.text);
      const labels = Array.isArray(parsed) ? parsed : parsed?.labels ?? [];
      if (labels.length === 0) return "";
      return `Available Loki labels (do NOT call list_loki_label_names):\n${(labels as string[]).join(", ")}`;
    } catch {
      return "";
    }
  }

  /**
   * Find a Loki log selector that actually returns logs for a service.
   * Tries the configured logLabels first, then falls back through common label patterns.
   * Uses a time window for probing since Loki's default window may be too narrow.
   * Returns a LogQL selector string like `{job="default/ingestion-server"}` or empty string.
   */
  async getWorkingSelector(
    service: ServiceConfig,
    probeWindow?: TimeWindow,
  ): Promise<string> {
    const log = logger.child({ component: "log-selector-probe", service: service.name });
    const toolNames = this.mcp.getTools().map((t) => t.function.name);
    if (!toolNames.includes("query_loki_logs")) return "";

    // Build candidate selectors: configured labels first, then fallbacks
    const candidates: Array<{ selector: string; source: string }> = [];

    // 1. Configured logLabels (what the service config says)
    const configuredLabels = service.logLabels;
    if (Object.keys(configuredLabels).length > 0) {
      const parts = Object.entries(configuredLabels).map(([k, v]) => `${k}="${v}"`);
      candidates.push({ selector: `{${parts.join(", ")}}`, source: "configured" });
    }

    // 2. Common fallback patterns
    const svcName = service.name;
    candidates.push(
      { selector: `{job="default/${svcName}"}`, source: "job" },
      { selector: `{container_name="${svcName}"}`, source: "container_name" },
      { selector: `{app_fortidata_name="${svcName}"}`, source: "app_fortidata_name" },
      { selector: `{chart="${svcName}"}`, source: "chart" },
    );

    // Deduplicate
    const seen = new Set<string>();
    const unique = candidates.filter((c) => {
      if (seen.has(c.selector)) return false;
      seen.add(c.selector);
      return true;
    });

    // Build probe args with time window -- Loki's default range is often too narrow
    // to find logs for services that aren't actively logging right now
    const baseArgs: Record<string, unknown> = {
      datasourceUid: this.lokiUid,
      limit: 1,
    };
    if (probeWindow) {
      baseArgs.startRfc3339 = probeWindow.startRfc3339;
      baseArgs.endRfc3339 = probeWindow.endRfc3339;
    }

    // Test each candidate with a small query (limit 1) to see if it returns anything
    for (const candidate of unique) {
      try {
        const result = await this.mcp.callTool("query_loki_logs", {
          ...baseArgs,
          logql: candidate.selector,
        });
        // Check if we got actual log lines (non-empty, non-error result)
        if (result.text && result.text.length > 10 && !result.text.includes('"data":[]')) {
          log.info({ selector: candidate.selector, source: candidate.source }, "Found working log selector");
          return candidate.selector;
        }
      } catch (err) {
        log.debug({ selector: candidate.selector, err }, "Log selector probe failed");
      }
    }

    // Try regex fallback: service name as a regex across common labels
    const regexCandidates = [
      `{job=~".*${svcName}.*"}`,
      `{container_name=~".*${svcName}.*"}`,
    ];
    for (const selector of regexCandidates) {
      try {
        const result = await this.mcp.callTool("query_loki_logs", {
          ...baseArgs,
          logql: selector,
        });
        if (result.text && result.text.length > 10 && !result.text.includes('"data":[]')) {
          log.info({ selector }, "Found working log selector via regex");
          return selector;
        }
      } catch {
        // continue
      }
    }

    log.warn("No working log selector found for service");
    return "";
  }

  /**
   * Prompt fragment telling the LLM how to query logs via Grafana Loki.
   */
  getPromptFragment(): string {
    return `LOGS — Grafana Loki (tool: query_loki_logs):
1. FIRST: Check the user message for a VALIDATED LOG SELECTOR. If provided, use it — it has been pre-tested.
2. Query logs DURING the anomaly window. No logs = evidence of outage.
3. If empty, try: {job="default/SERVICE_NAME"}, {container_name="SERVICE_NAME"}, {chart="SERVICE_NAME"}.
4. Use regex: |~ "(?i)(error|exception|warn|disconnect|timeout|refused|reset|restart|kill|oom|crash|fail)"
5. query_loki_logs uses "startRfc3339"/"endRfc3339" (RFC3339 format, e.g. "2026-03-07T00:00:00Z"). Always use limit=30 or higher.
6. Common Loki labels: "app_fortidata_name", "chart", "namespace", "container_name", "job" (format: "namespace/name"), "host", "instance".
7. For each error pattern, capture 5-8 ACTUAL log lines in "sampleLines". Real lines, not summaries.
8. If no errors found, query without regex to check if ANY logs exist. Zero logs is evidence.
IMPORTANT: Only report VERIFIABLE counts. "count" must reflect actual Loki results, not extrapolations.`;
  }
}
