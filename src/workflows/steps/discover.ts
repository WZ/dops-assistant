import { createDiscoverAgent } from "../../agents/discover.js";
import { safeJsonParse } from "../../agents/shared/processors.js";
import { getAllTools } from "../../mcp/provider.js";
import { wrapToolsWithCallbacks } from "../tool-utils.js";
import type { LanguageModel } from "ai";
import type { MastraProvider } from "../../mcp/provider.js";
import type { ServiceConfig, DiscoveryConfig } from "../../config/schema.js";
import type { OnToolCallEnriched, OnIteration } from "../../types/agent-interfaces.js";

export interface DiscoverStepConfig {
  model: LanguageModel;
  providers: MastraProvider[];
  discoveryConfig: DiscoveryConfig;
  onToolCall?: OnToolCallEnriched;
  onIteration?: OnIteration;
  onTokenUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
}

const MAX_RETRIES = 3;

// Only give the discover agent Prometheus/metrics tools — no Loki/log tools.
// Log labels are populated deterministically in the validation step.
const LOKI_TOOL_PATTERNS = ["loki", "log_label", "log_pattern", "log_stats"];

function filterOutLokiTools(tools: Record<string, any>): Record<string, any> {
  const filtered: Record<string, any> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (!LOKI_TOOL_PATTERNS.some((p) => name.toLowerCase().includes(p))) {
      filtered[name] = tool;
    }
  }
  return filtered;
}

export async function runDiscoverStep(config: DiscoverStepConfig): Promise<ServiceConfig[]> {
  let rawTools: Record<string, any>;
  try {
    rawTools = await getAllTools(config.providers);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`MCP connection failed — cannot reach monitoring providers. ${msg}`);
  }
  if (Object.keys(rawTools).length === 0) {
    throw new Error("No MCP tools available — check that your Grafana MCP server is running and reachable.");
  }
  const metricsOnly = filterOutLokiTools(rawTools);
  const tools = config.onToolCall
    ? wrapToolsWithCallbacks(metricsOnly, config.onToolCall, "discovery")
    : metricsOnly;

  // Keep maxSteps capped so the quirk wind-down (which disables tools to
  // force JSON output) fires before the model exhausts all iterations.
  const maxSteps = Math.min(config.discoveryConfig.maxIterations, 25);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const agent = createDiscoverAgent({
      model: config.model,
      tools,
      maxSteps,
      excludeServices: config.discoveryConfig.excludeServices,
      useQuirkHandling: true,
    });

    const toolCount = Object.keys(tools).length;
    console.error(`[DISCOVER] Attempt ${attempt}/${MAX_RETRIES} with ${toolCount} tools, maxSteps=${maxSteps}`);

    try {
      const result = await agent.generate("Discover all monitored services using the available tools. Return the complete list as JSON.", {
        providerOptions: { "openai-compatible": { max_tokens: 16384 } },
      } as any);

      console.error(`[DISCOVER] Agent returned ${result.text?.length ?? 0} chars: ${JSON.stringify(result.text?.slice(0, 500))}`);

      const usage = (result as any).totalUsage ?? (result as any).usage;
      if (usage && config.onTokenUsage) {
        config.onTokenUsage({
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
        });
      }

      const parsed = safeJsonParse(result.text);
      if (Array.isArray(parsed) && parsed.length > 0) {
        console.error(`[DISCOVER] Parsed ${parsed.length} services (attempt ${attempt})`);
        return parsed;
      }
      if (parsed?.services && Array.isArray(parsed.services) && parsed.services.length > 0) {
        console.error(`[DISCOVER] Parsed ${parsed.services.length} services from .services (attempt ${attempt})`);
        return parsed.services;
      }

      console.error(`[DISCOVER] Empty result on attempt ${attempt}, ${attempt < MAX_RETRIES ? "retrying..." : "giving up"}`);
    } catch (err) {
      console.error(`[DISCOVER] Error on attempt ${attempt}: ${err instanceof Error ? err.message : err}`);
      if (attempt === MAX_RETRIES) throw err;
    }
  }

  return [];
}
