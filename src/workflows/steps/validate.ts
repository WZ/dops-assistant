import { getAllTools } from "../../mcp/provider.js";
import type { LanguageModel } from "ai";
import type { MastraProvider } from "../../mcp/provider.js";
import type { ServiceConfig } from "../../config/schema.js";
import type { ValidatedServiceConfig } from "../../types/discovery-types.js";
import type { OnToolCallEnriched, OnIteration } from "../../types/agent-interfaces.js";

export interface ValidateStepConfig {
  model: LanguageModel;
  providers: MastraProvider[];
  services: ServiceConfig[];
  onToolCall?: OnToolCallEnriched;
  onIteration?: OnIteration;
  onTokenUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
}

/**
 * Deterministic validation — directly executes metric queries and log queries
 * via MCP tools without using an LLM. Much faster and more reliable than
 * LLM-driven validation.
 */
export async function runValidateStep(config: ValidateStepConfig): Promise<ValidatedServiceConfig[]> {
  const rawTools = await getAllTools(config.providers).catch(() => ({}));

  // Find the prometheus and loki tools by suffix
  const promTool = Object.entries(rawTools).find(([name]) => name.endsWith("query_prometheus"));
  const lokiTool = Object.entries(rawTools).find(([name]) => name.endsWith("query_loki_logs"));

  console.error(`[VALIDATE] Starting deterministic validation of ${config.services.length} services`);
  console.error(`[VALIDATE] Prometheus tool: ${promTool?.[0] ?? "not found"}, Loki tool: ${lokiTool?.[0] ?? "not found"}`);

  const results: ValidatedServiceConfig[] = [];

  for (let i = 0; i < config.services.length; i++) {
    const service = config.services[i];
    let metricsOk = false;
    let logsOk = false;
    const notes: string[] = [];

    config.onIteration?.("validation", i + 1, config.services.length, `Checking ${service.name}`);

    // Check metrics
    if (promTool && service.metrics.length > 0) {
      try {
        const query = service.metrics[0].query;
        const start = Date.now();
        const result = await promTool[1].execute!({ expr: query, queryType: "instant" }, {} as any);
        const duration = Date.now() - start;
        const resultStr = typeof result === "string" ? result : JSON.stringify(result);
        config.onToolCall?.(promTool[0], { expr: query }, resultStr, duration, undefined, "validation");

        // Check if result contains actual data
        metricsOk = resultStr.length > 10 && !resultStr.includes('"result":[]');
        notes.push(metricsOk ? "metrics \u2713" : "metrics \u2717 no data");
      } catch (err) {
        notes.push("metrics \u2717 query failed");
        config.onToolCall?.(promTool[0], { expr: service.metrics[0].query }, undefined, 0, String(err), "validation");
      }
    } else {
      notes.push("metrics \u2717 no tool or no query");
    }

    // Check logs
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
        config.onToolCall?.(lokiTool[0], {}, undefined, 0, String(err), "validation");
      }
    } else if (Object.keys(service.logLabels).length === 0) {
      // No log labels defined — don't penalize
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
