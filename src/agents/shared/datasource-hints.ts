/**
 * Pre-fetch datasource UIDs from a Grafana MCP toolset.
 *
 * Returns both:
 *   - `hintBlock`: an `<untrusted_datasource_hints>` prompt fragment listing
 *     each Prometheus/Loki datasource UID, with strict instructions to use
 *     them verbatim (agents on gpt-oss-120b otherwise hallucinate UIDs like
 *     "prometheus-k8s" or "loki" and burn an entire attempt).
 *   - `uidMap`: short-name → real-UID map for defensive coercion in the tool
 *     wrapper (`tool-utils.ts`).
 *
 * Returns an empty result if no `list_datasources` tool is available or the
 * call fails — logs the failure as a `warn` so cold-start MCP outages are
 * diagnosable from logs.
 */

import { createLogger } from "../../logger.js";
import { quirkHit } from "./quirk-telemetry.js";

const logger = createLogger("discover");

export interface DatasourceHintResult {
  hintBlock: string;
  uidMap: Map<string, string>;
}

export async function fetchDatasourceHints(
  tools: Record<string, { execute?: (args: unknown) => Promise<unknown> }>,
): Promise<DatasourceHintResult> {
  const empty: DatasourceHintResult = { hintBlock: "", uidMap: new Map() };
  const entry = Object.entries(tools).find(([name]) => name.includes("list_datasources"));
  if (!entry) return empty;
  const [toolName, tool] = entry;

  try {
    const raw = await tool.execute?.({ limit: 100, offset: 0 });
    if (!raw) return empty;

    let text: string;
    if (typeof raw === "string") {
      text = raw;
    } else if ((raw as { content?: Array<{ text?: string }> })?.content?.[0]?.text) {
      text = (raw as { content: Array<{ text: string }> }).content[0]!.text;
    } else {
      text = JSON.stringify(raw);
    }

    const parsed = JSON.parse(text);
    const datasources = (Array.isArray(parsed) ? parsed : parsed?.datasources ?? []) as Array<{
      uid: string;
      name: string;
      type: string;
    }>;
    const relevant = datasources.filter((d) => d.type === "prometheus" || d.type === "loki");
    if (relevant.length === 0) return empty;

    const uidMap = new Map<string, string>();
    for (const d of relevant) {
      if (!uidMap.has(d.type)) uidMap.set(d.type, d.uid);
    }

    const lines = relevant.map((d) => `- ${d.type}: datasourceUid="${d.uid}" (${d.name})`);
    const hintBlock =
      `<untrusted_datasource_hints>Available datasources (use these UIDs directly, do NOT guess or call list_datasources):\n${lines.join("\n")}\n` +
      `IMPORTANT: You MUST use the exact datasourceUid values above when calling query_prometheus, query_loki_logs, or list_loki_label_names. Do not invent short names like "loki" or "prometheus-k8s" — always use the real UIDs.</untrusted_datasource_hints>\n\n`;

    quirkHit("datasource-hints:emitted", { datasourceCount: relevant.length });
    return { hintBlock, uidMap };
  } catch (err) {
    // Silently proceeding leaves the agent to hallucinate datasource UIDs,
    // which usually burns an entire attempt. Surface the failure so cold-start
    // outages of the metrics MCP are diagnosable from logs.
    logger.warn({ err, toolName }, "discovery: datasource-hint prefetch failed; agent will guess UIDs");
    return empty;
  }
}
