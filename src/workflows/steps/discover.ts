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

export async function runDiscoverStep(config: DiscoverStepConfig): Promise<ServiceConfig[]> {
  const rawTools = await getAllTools(config.providers).catch(() => ({}));
  const tools = config.onToolCall
    ? wrapToolsWithCallbacks(rawTools, config.onToolCall, "discovery")
    : rawTools;

  const agent = createDiscoverAgent({
    model: config.model,
    tools,
    maxSteps: config.discoveryConfig.maxIterations,
    excludeServices: config.discoveryConfig.excludeServices,
  });

  const toolCount = Object.keys(tools).length;
  console.error(`[DISCOVER] Starting discovery with ${toolCount} tools, maxSteps=${config.discoveryConfig.maxIterations}`);

  const result = await agent.generate("Discover all monitored services using the available tools. Return the complete list as JSON.");

  console.error(`[DISCOVER] Agent returned ${result.text?.length ?? 0} chars`);
  if (result.text) {
    console.error(`[DISCOVER] Response preview: ${result.text.slice(0, 500)}`);
  }

  const usage = (result as any).totalUsage ?? (result as any).usage;
  if (usage && config.onTokenUsage) {
    config.onTokenUsage({
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
    });
  }

  const parsed = safeJsonParse(result.text);
  if (Array.isArray(parsed)) {
    console.error(`[DISCOVER] Parsed ${parsed.length} services from array`);
    return parsed;
  }
  if (parsed?.services && Array.isArray(parsed.services)) {
    console.error(`[DISCOVER] Parsed ${parsed.services.length} services from .services`);
    return parsed.services;
  }
  console.error(`[DISCOVER] Failed to parse services from response`);
  return [];
}
