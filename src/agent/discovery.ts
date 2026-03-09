import type { LlmClient, Message, TokenUsage } from "../llm/openai.js";
import type { MultiMcpClient } from "../mcp/multi-client.js";
import type { ServiceConfig, DiscoveryConfig } from "../config/schema.js";
import { sanitizeToolResult } from "./core.js";
import {
  DISCOVERY_PROMPT,
  DISCOVERED_SERVICES_SCHEMA,
  buildDiscoveryUserMessage,
} from "./discovery-prompts.js";

type DiscoveredServices = {
  services: Array<{
    name: string;
    metrics: Array<{ query: string; description: string }>;
    logLabels: Record<string, string>;
  }>;
};

const MAX_CONTINUATIONS = 5;

/**
 * Label keys to enumerate from Loki, in priority order.
 * More specific labels are preferred over generic ones.
 */
const LOKI_LABEL_PRIORITY = [
  "app_fortidata_name",
  "container_name",
  "job",
  "chart",
  "release",
  "app",
  "component",
  "name",
  "strimzi_io_name",
  "spark_app_name",
] as const;

/**
 * Fuzzy-match a service name against a set of label values.
 * Returns the matching label value, or undefined if no match.
 */
function findLabelMatch(serviceName: string, labelValues: string[], labelKey: string): string | undefined {
  const svc = serviceName.toLowerCase();

  // Exact match
  const exact = labelValues.find((v) => v.toLowerCase() === svc);
  if (exact) return exact;

  // Service name without common suffixes like "-headless"
  const stripped = svc.replace(/-headless$/, "");
  if (stripped !== svc) {
    const strippedMatch = labelValues.find((v) => v.toLowerCase() === stripped);
    if (strippedMatch) return strippedMatch;
  }

  // For "job" labels in "namespace/name" format, match against the name part
  if (labelKey === "job") {
    const jobMatch = labelValues.find((v) => {
      const parts = v.split("/");
      if (parts.length !== 2) return false;
      const name = parts[1]!.toLowerCase();
      return name === svc || name === stripped;
    });
    if (jobMatch) return jobMatch;
  }

  // Service name contains label value (e.g. "stream-kafka-cluster-kafka-bootstrap" contains "kafka")
  // Only for non-generic labels and values longer than 3 chars to avoid false positives
  if (labelKey !== "job" && labelKey !== "namespace") {
    const contained = labelValues.find((v) => v.length > 3 && svc.includes(v.toLowerCase()));
    if (contained) return contained;
  }

  return undefined;
}

/**
 * Deterministically enrich services with Loki logLabels by calling
 * list_loki_label_names / list_loki_label_values MCP tools directly
 * and doing fuzzy matching in code.
 */
export async function enrichLogLabels(
  services: ServiceConfig[],
  mcp: MultiMcpClient,
  lokiDatasourceUid: string,
  onToolCall?: (name: string, args: Record<string, unknown>) => void,
): Promise<ServiceConfig[]> {
  // Get available label names
  const labelNamesArgs = { datasourceUid: lokiDatasourceUid };
  onToolCall?.("list_loki_label_names", labelNamesArgs);
  const labelNamesResult = await mcp.callTool("list_loki_label_names", labelNamesArgs);
  let availableLabels: string[];
  try {
    availableLabels = JSON.parse(labelNamesResult.text) as string[];
  } catch {
    return services; // Can't parse labels, return as-is
  }

  // Filter to labels we care about that actually exist
  const labelsToQuery = LOKI_LABEL_PRIORITY.filter((l) => availableLabels.includes(l));

  // Enumerate values for each label key in parallel
  const labelValueResults = await Promise.allSettled(
    labelsToQuery.map(async (labelName) => {
      const args = { datasourceUid: lokiDatasourceUid, labelName };
      onToolCall?.(  "list_loki_label_values", args);
      const result = await mcp.callTool("list_loki_label_values", args);
      const values = JSON.parse(result.text) as string[];
      return { labelName, values };
    }),
  );

  // Build label-key → values map
  const labelMap = new Map<string, string[]>();
  for (const r of labelValueResults) {
    if (r.status === "fulfilled") {
      labelMap.set(r.value.labelName, r.value.values);
    }
  }

  // Match each service against label values (in priority order)
  return services.map((svc) => {
    // Skip if service already has logLabels from the LLM
    if (Object.keys(svc.logLabels).length > 0) return svc;

    for (const labelKey of labelsToQuery) {
      const values = labelMap.get(labelKey);
      if (!values) continue;

      const match = findLabelMatch(svc.name, values, labelKey);
      if (match) {
        return { ...svc, logLabels: { [labelKey]: match } };
      }
    }

    return svc;
  });
}

/**
 * Attempts to parse JSON, and if it's truncated, returns the partial string
 * so the LLM can be asked to continue.
 */
function tryParseJson(text: string): { parsed: DiscoveredServices } | { partial: string } {
  try {
    return { parsed: JSON.parse(text) as DiscoveredServices };
  } catch {
    return { partial: text };
  }
}

export class DiscoveryAgent {
  private readonly llm: LlmClient;
  private readonly mcp: MultiMcpClient;
  private readonly maxIterations: number;

  constructor(llm: LlmClient, mcp: MultiMcpClient, opts: { maxIterations: number }) {
    this.llm = llm;
    this.mcp = mcp;
    this.maxIterations = opts.maxIterations;
  }

  /**
   * If the LLM's JSON response was truncated (hit token limit), ask it to
   * continue from where it left off, up to MAX_CONTINUATIONS times.
   */
  private async completeJson(
    partial: string,
    messages: Message[],
    onTokenUsage?: (usage: TokenUsage) => void,
  ): Promise<DiscoveredServices> {
    let accumulated = partial;

    for (let c = 0; c < MAX_CONTINUATIONS; c++) {
      const continueMessages: Message[] = [
        ...messages,
        { role: "assistant", content: accumulated },
        { role: "user", content: "Your JSON response was truncated. Continue EXACTLY from where you left off — output only the remaining JSON, no preamble." },
      ];

      const response = await this.llm.chat(continueMessages, [], {
        maxOutputTokens: 16384,
      });

      if (response.usage) onTokenUsage?.(response.usage);

      if (response.type === "text") {
        accumulated += response.content;
        const result = tryParseJson(accumulated);
        if ("parsed" in result) return result.parsed;
        // Still truncated — loop and ask again
      }
    }

    throw new Error("JSON response still incomplete after continuations");
  }

  async discover(
    config: DiscoveryConfig,
    onTokenUsage?: (usage: TokenUsage) => void,
    onToolCall?: (name: string, args: Record<string, unknown>) => void,
  ): Promise<ServiceConfig[]> {
    const tools = this.mcp.getTools();
    const messages: Message[] = [
      { role: "system", content: DISCOVERY_PROMPT },
      { role: "user", content: buildDiscoveryUserMessage(config) },
    ];

    let services: ServiceConfig[] | undefined;

    for (let i = 0; i < this.maxIterations; i++) {
      const response = await this.llm.chat(messages, tools, {
        responseFormat: DISCOVERED_SERVICES_SCHEMA,
        maxOutputTokens: 16384,
      });

      if (response.usage) onTokenUsage?.(response.usage);

      if (response.type === "text") {
        const result = tryParseJson(response.content);
        const parsed = "parsed" in result
          ? result.parsed
          : await this.completeJson(result.partial, messages, onTokenUsage);

        const excludeSet = new Set(config.excludeServices.map((s) => s.toLowerCase()));
        services = parsed.services
          .filter((s) => !excludeSet.has(s.name.toLowerCase()))
          .map((s) => ({
            name: s.name,
            metrics: s.metrics,
            logLabels: s.logLabels,
          }));
        break;
      }

      messages.push({
        role: "assistant",
        content: null,
        tool_calls: response.calls.map((c) => ({
          id: c.id, name: c.name, args: c.args,
        })),
      });

      for (const call of response.calls) {
        onToolCall?.(call.name, call.args);
      }

      const settled = await Promise.allSettled(
        response.calls.map((call) => this.mcp.callTool(call.name, call.args)),
      );
      for (let j = 0; j < response.calls.length; j++) {
        const outcome = settled[j]!;
        const call = response.calls[j]!;
        messages.push({
          role: "tool",
          content: outcome.status === "fulfilled"
            ? sanitizeToolResult(outcome.value.text)
            : `[Error] ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
          tool_call_id: call.id,
        });
      }
    }

    if (!services) {
      throw new Error(`Discovery did not complete within ${this.maxIterations} iterations`);
    }

    // Enrich with Loki log labels (deterministic, code-based matching)
    const lokiUid = await this.findLokiDatasourceUid(onToolCall);
    if (lokiUid) {
      services = await enrichLogLabels(services, this.mcp, lokiUid, onToolCall);
    }

    return services;
  }

  /**
   * Find the Loki datasource UID by calling list_datasources.
   */
  private async findLokiDatasourceUid(
    onToolCall?: (name: string, args: Record<string, unknown>) => void,
  ): Promise<string | undefined> {
    try {
      onToolCall?.("list_datasources", {});
      const result = await this.mcp.callTool("list_datasources", {});
      const parsed = JSON.parse(result.text) as Record<string, unknown>;
      const list = Array.isArray(parsed) ? parsed : (parsed.datasources as Array<Record<string, unknown>> | undefined) ?? [];
      const loki = list.find(
        (d: Record<string, unknown>) => d.type === "loki" || d.typeName === "Loki",
      );
      return loki?.uid as string | undefined;
    } catch {
      return undefined;
    }
  }
}
