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

  const result = await agent.generate("Discover all monitored services using the available tools. Return the complete list as JSON.");

  const parsed = safeJsonParse(result.text);
  if (Array.isArray(parsed)) return parsed;
  if (parsed?.services && Array.isArray(parsed.services)) return parsed.services;
  return [];
}
