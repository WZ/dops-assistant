import { getAllTools } from "../../mcp/provider.js";
import type { MastraProvider } from "../../mcp/provider.js";
import type { ServiceConfig } from "../../config/schema.js";
import type { ValidatedServiceConfig } from "../../types/discovery-types.js";
import type { OnToolCallEnriched, OnIteration } from "../../types/agent-interfaces.js";

export interface ValidateStepConfig {
  providers: MastraProvider[];
  services: ServiceConfig[];
  onToolCall?: OnToolCallEnriched;
  onIteration?: OnIteration;
  onTokenUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
}

// Loki label keys that typically identify services, tried in priority order.
const SERVICE_LABEL_KEYS = [
  "app",
  "container_name",
  "job",
  "component",
  "name",
  "service",
  "chart",
  "release",
];

/**
 * Unwrap an MCP tool result to its parsed JSON payload.
 * MCP results may be raw JSON, a JSON string, or wrapped in {"content": [{"text": "..."}]}.
 */
function unwrapMcpJson(result: unknown): any {
  try {
    const outer = typeof result === "string" ? JSON.parse(result) : result;
    if (outer?.content?.[0]?.text) {
      return JSON.parse(outer.content[0].text);
    }
    return outer;
  } catch {
    return result;
  }
}

/**
 * Deterministic validation + log label enrichment.
 *
 * 1. Verify each service's Prometheus metric query returns data
 * 2. Enrich logLabels by fuzzy-matching service names against Loki label values
 * 3. Verify matched log labels return data
 */
export async function runValidateStep(config: ValidateStepConfig): Promise<ValidatedServiceConfig[]> {
  const rawTools = await getAllTools(config.providers).catch(() => ({}));

  const promTool = Object.entries(rawTools).find(([name]) => name.endsWith("query_prometheus"));
  const lokiLabelNamesTool = Object.entries(rawTools).find(([name]) => name.endsWith("list_loki_label_names"));
  const lokiLabelValuesTool = Object.entries(rawTools).find(([name]) => name.endsWith("list_loki_label_values"));
  const lokiTool = Object.entries(rawTools).find(([name]) => name.endsWith("query_loki_logs"));

  console.error(`[VALIDATE] Starting validation of ${config.services.length} services`);
  console.error(`[VALIDATE] Available tools: ${Object.keys(rawTools).join(", ")}`);

  // Find Loki datasource UID (required for label queries)
  const listDsTool = Object.entries(rawTools).find(([name]) => name.endsWith("list_datasources"));
  const lokiDsUid = await findLokiDatasourceUid(listDsTool, config);

  // Phase 1: Enrich log labels by matching service names against Loki label values
  const labelMap = await buildLabelMap(lokiLabelNamesTool, lokiLabelValuesTool, lokiDsUid, config);
  const enriched = enrichLogLabels(config.services, labelMap);

  // Phase 2: Validate metrics and logs for each service
  const results: ValidatedServiceConfig[] = [];

  for (let i = 0; i < enriched.length; i++) {
    const service = enriched[i];
    let metricsOk = false;
    let logsOk = false;
    const notes: string[] = [];

    config.onIteration?.("validation", i + 1, enriched.length, `Checking ${service.name}`);

    // Check metrics
    if (promTool && service.metrics.length > 0) {
      try {
        const query = service.metrics[0].query;
        const start = Date.now();
        const result = await promTool[1].execute!({ expr: query, queryType: "instant" }, {} as any);
        const duration = Date.now() - start;
        const resultStr = typeof result === "string" ? result : JSON.stringify(result);
        config.onToolCall?.(promTool[0], { expr: query }, resultStr, duration, undefined, "validation");

        metricsOk = resultStr.length > 10 && !resultStr.includes('"result":[]');
        notes.push(metricsOk ? "metrics \u2713" : "metrics \u2717 no data");
      } catch (err) {
        notes.push("metrics \u2717 query failed");
        config.onToolCall?.(promTool[0], { expr: service.metrics[0].query }, undefined, 0, String(err), "validation");
      }
    } else {
      notes.push("metrics \u2717 no tool or no query");
    }

    // Check logs (only if we enriched logLabels)
    if (lokiTool && Object.keys(service.logLabels).length > 0) {
      try {
        const labels = Object.entries(service.logLabels)
          .map(([k, v]) => `${k}="${v}"`)
          .join(",");
        const query = `{${labels}}`;
        const start = Date.now();
        const result = await lokiTool[1].execute!({ query, limit: 1 }, {} as any);
        const duration = Date.now() - start;
        const resultStr = typeof result === "string" ? result : JSON.stringify(result);
        config.onToolCall?.(lokiTool[0], { query, limit: 1 }, resultStr, duration, undefined, "validation");

        logsOk = resultStr.length > 10 && !resultStr.includes('"result":[]');
        notes.push(logsOk ? "logs \u2713" : "logs \u2717 no data");
      } catch (err) {
        notes.push("logs \u2717 query failed");
      }
    } else {
      notes.push("logs n/a");
    }

    const hasLogLabels = Object.keys(service.logLabels).length > 0;
    let confidence: "verified" | "partial" | "unverified";
    if (metricsOk && (logsOk || !hasLogLabels)) {
      confidence = "verified";
    } else if (metricsOk || logsOk) {
      confidence = "partial";
    } else {
      confidence = "unverified";
    }

    results.push({
      ...service,
      confidence,
      validationNotes: notes.join(", "),
    });
  }

  const verified = results.filter((r) => r.confidence === "verified").length;
  const partial = results.filter((r) => r.confidence === "partial").length;
  const unverified = results.filter((r) => r.confidence === "unverified").length;
  console.error(`[VALIDATE] Done: ${verified} verified, ${partial} partial, ${unverified} unverified`);

  return results;
}

/**
 * Find the Loki datasource UID by querying list_datasources.
 */
async function findLokiDatasourceUid(
  listDsTool: [string, any] | undefined,
  config: ValidateStepConfig,
): Promise<string | undefined> {
  if (!listDsTool) return undefined;

  try {
    const start = Date.now();
    const result = await listDsTool[1].execute!({}, {} as any);
    const duration = Date.now() - start;
    const resultStr = typeof result === "string" ? result : JSON.stringify(result);
    config.onToolCall?.(listDsTool[0], {}, resultStr, duration, undefined, "validation");

    const dsData = unwrapMcpJson(result);
    const datasources = Array.isArray(dsData) ? dsData : dsData?.datasources ?? [];
    console.error(`[VALIDATE] list_datasources returned ${datasources.length} datasources`);

    const loki = datasources.find((ds: any) =>
      ds.type === "loki" || ds.typeName === "Loki" || ds.name?.toLowerCase().includes("loki")
    );
    if (loki?.uid) {
      console.error(`[VALIDATE] Found Loki datasource: uid=${loki.uid}, name=${loki.name}`);
      return loki.uid;
    }
    console.error(`[VALIDATE] No Loki datasource found in: ${JSON.stringify(datasources.map((d: any) => ({ name: d.name, type: d.type, uid: d.uid }))).slice(0, 500)}`);
  } catch (err) {
    console.error(`[VALIDATE] Failed to find Loki datasource: ${err}`);
  }

  return undefined;
}

async function buildLabelMap(
  labelNamesTool: [string, any] | undefined,
  labelValuesTool: [string, any] | undefined,
  lokiDsUid: string | undefined,
  config: ValidateStepConfig,
): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>();
  if (!labelNamesTool || !labelValuesTool || !lokiDsUid) return map;

  try {
    const start = Date.now();
    const namesResult = await labelNamesTool[1].execute!({ datasourceUid: lokiDsUid }, {} as any);
    const duration = Date.now() - start;
    const namesStr = typeof namesResult === "string" ? namesResult : JSON.stringify(namesResult);
    config.onToolCall?.(labelNamesTool[0], { datasourceUid: lokiDsUid }, namesStr, duration, undefined, "validation");

    const parsed = unwrapMcpJson(namesResult);
    const allNames: string[] = Array.isArray(parsed) ? parsed : parsed?.labels ?? parsed?.data ?? parsed?.values ?? [];
    console.error(`[VALIDATE] Available label names (${allNames.length}): ${allNames.slice(0, 30).join(", ")}`);

    const available = allNames.filter(
      (k: string) => SERVICE_LABEL_KEYS.some((p) => k === p || k.toLowerCase().includes(p)),
    );
    console.error(`[VALIDATE] Found ${available.length} matching label keys: ${available.join(", ")}`);

    for (const key of available) {
      try {
        const vStart = Date.now();
        const valResult = await labelValuesTool[1].execute!({ datasourceUid: lokiDsUid, labelName: key }, {} as any);
        const vDuration = Date.now() - vStart;
        const valStr = typeof valResult === "string" ? valResult : JSON.stringify(valResult);
        config.onToolCall?.(labelValuesTool[0], { labelName: key }, valStr, vDuration, undefined, "validation");

        const valParsed = unwrapMcpJson(valResult);
        const values: string[] = Array.isArray(valParsed) ? valParsed : valParsed?.values ?? valParsed?.data ?? [];
        map.set(key, new Set(values.map((v: string) => v.toLowerCase())));
        console.error(`[VALIDATE] Label "${key}": ${values.length} values`);
      } catch { /* skip this label key */ }
    }
  } catch (err) {
    console.error(`[VALIDATE] Failed to build label map: ${err}`);
  }

  return map;
}

/**
 * For each service with empty logLabels, try to find a matching Loki label
 * by fuzzy-matching the service name against label values.
 */
function enrichLogLabels(
  services: ServiceConfig[],
  labelMap: Map<string, Set<string>>,
): ServiceConfig[] {
  if (labelMap.size === 0) return services;

  return services.map((service) => {
    if (Object.keys(service.logLabels).length > 0) return service;

    const nameLower = service.name.toLowerCase();
    const nameNoSuffix = nameLower.replace(/-headless$/, "");

    for (const [labelKey, values] of labelMap) {
      if (values.has(nameLower) || values.has(nameNoSuffix)) {
        return { ...service, logLabels: { [labelKey]: service.name } };
      }
      // For "job" labels, check "namespace/name" format
      if (labelKey === "job") {
        for (const v of values) {
          const parts = v.split("/");
          if (parts.length === 2 && parts[1] === nameLower) {
            return { ...service, logLabels: { [labelKey]: v } };
          }
        }
      }
    }

    return service;
  });
}
