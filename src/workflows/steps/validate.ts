import { getToolsByRole } from "../../mcp/provider.js";
import type { MastraProvider } from "../../mcp/provider.js";
import type { ServiceConfig, DiscoveryRecipe } from "../../config/schema.js";
import type { ValidatedServiceConfig } from "../../types/discovery-types.js";
import type { OnToolCallEnriched, OnIteration } from "../../types/agent-interfaces.js";
import type { Tool } from "@mastra/core/tools";

export interface ValidateStepConfig {
  providers: MastraProvider[];
  services: ServiceConfig[];
  discoveryRecipes?: DiscoveryRecipe[];
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
 * Compute effective label keys from discovery recipes.
 * If recipes provide labelKeys, merge and deduplicate them (preserving order).
 * Otherwise fall back to the hardcoded SERVICE_LABEL_KEYS.
 */
function computeEffectiveLabelKeys(recipes?: DiscoveryRecipe[]): string[] {
  if (!recipes || recipes.length === 0) return SERVICE_LABEL_KEYS;

  const recipeKeys = recipes.flatMap((r) => r.labelKeys);
  if (recipeKeys.length === 0) return SERVICE_LABEL_KEYS;

  // Deduplicate while preserving order
  return [...new Set(recipeKeys)];
}

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
 * Find a tool by name suffix within a role's tool set.
 * Returns [toolName, tool] tuple or undefined if not found.
 */
function findToolBySuffix(tools: Record<string, Tool>, suffix: string): [string, Tool] | undefined {
  const entry = Object.entries(tools).find(([name]) => name.endsWith(suffix));
  return entry as [string, Tool] | undefined;
}

/**
 * Deterministic validation + log label enrichment.
 *
 * 1. Verify each service's Prometheus metric query returns data
 * 2. Enrich logLabels by fuzzy-matching service names against Loki label values
 * 3. Verify matched log labels return data
 */
export async function runValidateStep(config: ValidateStepConfig): Promise<ValidatedServiceConfig[]> {
  config.onIteration?.("validation", 0, config.services.length, "Resolving MCP tools...");

  // Resolve tools by role instead of scanning all providers
  const [metricsTools, logsTools, dashboardsTools, infraTools] = await Promise.all([
    getToolsByRole(config.providers, "metrics").catch(() => ({})),
    getToolsByRole(config.providers, "logs").catch(() => ({})),
    getToolsByRole(config.providers, "dashboards").catch(() => ({})),
    getToolsByRole(config.providers, "infrastructure").catch(() => ({})),
  ]);

  const promTool = findToolBySuffix(metricsTools, "query_prometheus");
  const lokiLabelNamesTool = findToolBySuffix(logsTools, "list_loki_label_names");
  const lokiLabelValuesTool = findToolBySuffix(logsTools, "list_loki_label_values");
  const lokiTool = findToolBySuffix(logsTools, "query_loki_logs");
  const podsListTool = findToolBySuffix(infraTools, "pods_list");

  console.error(`[VALIDATE] Starting validation of ${config.services.length} services`);
  console.error(`[VALIDATE] Metrics tools: ${Object.keys(metricsTools).join(", ") || "(none)"}`);
  console.error(`[VALIDATE] Logs tools: ${Object.keys(logsTools).join(", ") || "(none)"}`);
  console.error(`[VALIDATE] Dashboards tools: ${Object.keys(dashboardsTools).join(", ") || "(none)"}`);
  console.error(`[VALIDATE] Infra tools: ${Object.keys(infraTools).join(", ") || "(none)"}`);

  // Find datasource listing tool — try dashboards role first, fall back to metrics role
  const listDsTool = findToolBySuffix(dashboardsTools, "list_datasources")
    ?? findToolBySuffix(metricsTools, "list_datasources");
  const lokiDsUid = await findLokiDatasourceUid(listDsTool, config);

  // Compute effective label keys: merge recipe labelKeys (if any) with defaults
  const effectiveLabelKeys = computeEffectiveLabelKeys(config.discoveryRecipes);

  config.onIteration?.("validation", 0, config.services.length, "Enriching log labels from K8s...");

  // Phase 0: Enrich log labels from K8s pod data (ground truth — namespace + labels)
  const k8sEnriched = await enrichFromK8s(config.services, podsListTool, config);

  // Phase 1: Enrich remaining empty logLabels by matching service names against Loki label values (fallback)
  const labelMap = await buildLabelMap(lokiLabelNamesTool, lokiLabelValuesTool, lokiDsUid, config, effectiveLabelKeys);
  const enriched = enrichLogLabels(k8sEnriched, labelMap);

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
 * Enrich service logLabels using K8s pod data (ground truth).
 *
 * Calls pods_list once, parses the tabular output, and matches services
 * to pods by name. Extracts namespace and labels (app, component, etc.)
 * for each matched service.
 */
async function enrichFromK8s(
  services: ServiceConfig[],
  podsListTool: [string, Tool] | undefined,
  config: ValidateStepConfig,
): Promise<ServiceConfig[]> {
  if (!podsListTool) {
    console.error("[VALIDATE] No pods_list tool — skipping K8s enrichment");
    return services;
  }

  let podRows: Array<{ name: string; namespace: string; labels: Record<string, string> }>;
  try {
    const start = Date.now();
    const result = await podsListTool[1].execute!({}, {} as any);
    const duration = Date.now() - start;
    const resultStr = typeof result === "string" ? result : JSON.stringify(result);
    config.onToolCall?.(podsListTool[0], {}, resultStr.slice(0, 2000), duration, undefined, "validation");

    podRows = parsePodsList(resultStr);
    console.error(`[VALIDATE] K8s pods_list: parsed ${podRows.length} pods`);
  } catch (err) {
    console.error(`[VALIDATE] K8s pods_list failed: ${err}`);
    return services;
  }

  if (podRows.length === 0) return services;

  let enrichedCount = 0;

  const result = services.map((service) => {
    // Skip if logLabels already has namespace (fully enriched)
    if (service.logLabels?.namespace) return service;

    const nameVariants = normalizeName(service.name);

    // Match pod by: pod name contains service name, or labels.app matches
    const matched = podRows.find((pod) => {
      const podLower = pod.name.toLowerCase();
      for (const variant of nameVariants) {
        if (podLower.startsWith(variant) || podLower.includes(variant)) return true;
      }
      const appLabel = pod.labels["app"]?.toLowerCase();
      if (appLabel) {
        for (const variant of nameVariants) {
          if (appLabel === variant || appLabel.includes(variant)) return true;
        }
      }
      return false;
    });

    if (!matched) return service;

    // Merge K8s data into existing logLabels (preserve LLM-provided labels, add namespace)
    const logLabels: Record<string, string> = { ...service.logLabels, namespace: matched.namespace };

    // Add container label if not already present
    if (!logLabels["container"] && !logLabels["app"]) {
      if (matched.labels["app"]) {
        logLabels["container"] = matched.labels["app"];
      } else {
        logLabels["container"] = service.name;
      }
    }

    enrichedCount++;
    console.error(`[VALIDATE] K8s match: "${service.name}" → namespace=${matched.namespace}, container=${logLabels["container"]} (pod=${matched.name})`);
    return { ...service, logLabels };
  });

  console.error(`[VALIDATE] K8s enrichment: ${enrichedCount}/${services.length} services matched`);
  return result;
}

/**
 * Parse the tabular output from pods_list into structured rows.
 *
 * Expected format (space-separated with LABELS as last column):
 *   NAMESPACE   APIVERSION   KIND   NAME   READY   STATUS   RESTARTS   AGE   IP   NODE   ...   LABELS
 *   admin-new   v1           Pod    admin-ui-7bd9b7c579-qtcdr   1/1   Running   0   3d22h   ...   app=admin-ui,pod-template-hash=7bd9b7c579
 */
function parsePodsList(raw: string): Array<{ name: string; namespace: string; labels: Record<string, string> }> {
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  // Handle MCP content wrapping
  let content = text;
  try {
    const parsed = JSON.parse(text);
    if (parsed?.content?.[0]?.text) content = parsed.content[0].text;
    else if (typeof parsed === "string") content = parsed;
  } catch { /* use raw text */ }

  const lines = content.split("\n").filter((l: string) => l.trim());
  if (lines.length < 2) return [];

  // Find header line and column positions
  const headerLine = lines[0];
  const namespaceIdx = headerLine.indexOf("NAMESPACE");
  const nameIdx = headerLine.indexOf("NAME");
  const labelsIdx = headerLine.indexOf("LABELS");

  if (nameIdx === -1) return [];

  const results: Array<{ name: string; namespace: string; labels: Record<string, string> }> = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    // Split by whitespace for structured fields
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;

    const namespace = namespaceIdx !== -1 ? parts[0] : "";
    // NAME is typically the 4th column (NAMESPACE, APIVERSION, KIND, NAME)
    const name = parts[3] ?? "";

    // LABELS is the last whitespace-separated field, containing comma-separated key=value pairs
    const labels: Record<string, string> = {};
    const lastField = parts[parts.length - 1];
    if (lastField && lastField !== "<none>" && lastField.includes("=")) {
      for (const pair of lastField.split(",")) {
        const eq = pair.indexOf("=");
        if (eq > 0) {
          labels[pair.slice(0, eq)] = pair.slice(eq + 1);
        }
      }
    }

    if (name) results.push({ name, namespace, labels });
  }

  return results;
}

/**
 * Find the Loki datasource UID by querying list_datasources.
 */
async function findLokiDatasourceUid(
  listDsTool: [string, Tool] | undefined,
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
  labelKeys: string[] = SERVICE_LABEL_KEYS,
): Promise<Map<string, Map<string, string>>> {
  const map = new Map<string, Map<string, string>>();
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
      (k: string) => labelKeys.some((p) => k === p || k.toLowerCase().includes(p)),
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
        // Store lowercase → original mapping for case-preserving label selectors
        const valueMap = new Map<string, string>();
        for (const v of values) valueMap.set(v.toLowerCase(), v);
        map.set(key, valueMap);
        console.error(`[VALIDATE] Label "${key}": ${values.length} values`);
      } catch { /* skip this label key */ }
    }
  } catch (err) {
    console.error(`[VALIDATE] Failed to build label map: ${err}`);
  }

  return map;
}

/**
 * Normalize a service name for fuzzy matching:
 * - lowercase
 * - strip common suffixes (-headless, -server, -svc, -service, -master, -metrics, -proxy)
 * - strip trailing digits and hyphens (e.g., "redis-ha-announce-0" → "redis-ha-announce")
 * - collapse repeated hyphens
 */
function normalizeName(name: string): string[] {
  const lower = name.toLowerCase();
  const variants = new Set<string>([lower]);

  // Strip common suffixes
  const suffixes = ["-headless", "-server", "-svc", "-service", "-master", "-metrics", "-proxy", "-internal", "-external"];
  for (const suffix of suffixes) {
    if (lower.endsWith(suffix)) {
      variants.add(lower.slice(0, -suffix.length));
    }
  }

  // Strip trailing -N (numbered instances like redis-ha-announce-0)
  const noTrailingNum = lower.replace(/-\d+$/, "");
  if (noTrailingNum !== lower) variants.add(noTrailingNum);

  // Expand common abbreviations: svr→server, svc→service
  const expanded = lower
    .replace(/\bsvr\b/g, "server")
    .replace(/\bsvc\b/g, "service");
  if (expanded !== lower) variants.add(expanded);

  // Also try the abbreviated form of the full name
  const abbreviated = lower
    .replace(/\bserver\b/g, "svr")
    .replace(/\bservice\b/g, "svc");
  if (abbreviated !== lower) variants.add(abbreviated);

  return [...variants];
}

/**
 * For each service with empty logLabels, try to find a matching Loki label
 * by fuzzy-matching the service name against label values.
 *
 * Matching strategy (in priority order):
 * 1. Exact match on name or normalized variants
 * 2. namespace/name format match (for "job" labels)
 * 3. Substring containment — label value contains service name or vice versa
 */
function enrichLogLabels(
  services: ServiceConfig[],
  labelMap: Map<string, Map<string, string>>,
): ServiceConfig[] {
  if (labelMap.size === 0) return services;

  // Priority order: prefer specific label keys over generic ones
  const LABEL_PRIORITY = ["app", "service_name", "app_kubernetes_io_name", "job", "name",
    "app_kubernetes_io_component", "app_kubernetes_io_instance"];

  const sortedLabels = [...labelMap.entries()].sort(([a], [b]) => {
    const ai = LABEL_PRIORITY.indexOf(a);
    const bi = LABEL_PRIORITY.indexOf(b);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  let enrichedCount = 0;

  const result = services.map((service) => {
    if (Object.keys(service.logLabels).length > 0) return service;

    const nameVariants = normalizeName(service.name);

    // Pass 1: Exact match on any normalized variant
    for (const [labelKey, valueMap] of sortedLabels) {
      for (const variant of nameVariants) {
        const original = valueMap.get(variant);
        if (original) {
          enrichedCount++;
          console.error(`[VALIDATE] Log label match: "${service.name}" → ${labelKey}="${original}" (exact)`);
          return { ...service, logLabels: { [labelKey]: original } };
        }
      }
    }

    // Pass 2: namespace/name format match (for job, job_name labels)
    for (const [labelKey, valueMap] of sortedLabels) {
      if (labelKey !== "job" && labelKey !== "job_name") continue;
      for (const [lowerVal, originalVal] of valueMap) {
        const parts = lowerVal.split("/");
        if (parts.length === 2) {
          for (const variant of nameVariants) {
            if (parts[1] === variant) {
              enrichedCount++;
              console.error(`[VALIDATE] Log label match: "${service.name}" → ${labelKey}="${originalVal}" (namespace/name)`);
              return { ...service, logLabels: { [labelKey]: originalVal } };
            }
          }
        }
      }
    }

    // Pass 3: Substring containment with similarity threshold
    // The shorter string must cover ≥60% of the longer string's length to avoid
    // false positives like "controller" matching "kube-controller-manager"
    for (const [labelKey, valueMap] of sortedLabels) {
      if (labelKey === "filename" || labelKey === "namespace" || labelKey === "batch_kubernetes_io_job_name") continue;
      for (const variant of nameVariants) {
        if (variant.length < 5) continue;
        for (const [lowerVal, originalVal] of valueMap) {
          if (lowerVal.length < 5) continue;
          if (lowerVal.includes(variant) || variant.includes(lowerVal)) {
            const shorter = Math.min(variant.length, lowerVal.length);
            const longer = Math.max(variant.length, lowerVal.length);
            if (shorter / longer >= 0.6) {
              enrichedCount++;
              console.error(`[VALIDATE] Log label match: "${service.name}" → ${labelKey}="${originalVal}" (substring, ${Math.round(shorter/longer*100)}% coverage)`);
              return { ...service, logLabels: { [labelKey]: originalVal } };
            }
          }
        }
      }
    }

    console.error(`[VALIDATE] No log label match for "${service.name}"`);
    return service;
  });

  console.error(`[VALIDATE] Log label enrichment: ${enrichedCount}/${services.length} services matched`);
  return result;
}
