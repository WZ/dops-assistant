import { createDiscoverAgent } from "../../agents/discover.js";
import { safeJsonParse } from "../../agents/shared/processors.js";
import { getToolsByRole } from "../../mcp/provider.js";
import { wrapToolsWithCallbacks } from "../tool-utils.js";
import type { LanguageModel } from "ai";
import type { MastraProvider } from "../../mcp/provider.js";
import type { ServiceConfig, DiscoveryConfig, DiscoveryRecipe } from "../../config/schema.js";
import type { OnToolCallEnriched, OnIteration } from "../../types/agent-interfaces.js";
import type { Skill } from "../../skills/store.js";
import { wrapUntrusted } from "../../agents/shared/prompt-helpers.js";

export interface DiscoverStepConfig {
  model: LanguageModel;
  providers: MastraProvider[];
  discoveryConfig: DiscoveryConfig;
  onToolCall?: OnToolCallEnriched;
  onIteration?: OnIteration;
  onTokenUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
  skills?: Skill[];
}

const MAX_RETRIES = 3;

const DEFAULT_PROMETHEUS_RECIPE: DiscoveryRecipe = {
  providerType: "prometheus-k8s",
  serviceQueries: [
    'count by (deployment) (kube_deployment_status_replicas)',
    'count by (statefulset) (kube_statefulset_status_replicas)',
    'count by (daemonset) (kube_daemonset_status_desired_number_scheduled)',
    'count by (container) (kube_pod_container_info{container!="POD",container!=""})',
    'count by (app) (kube_pod_info)',
    'count by (job) (up)',
  ],
  labelKeys: ["app", "container_name", "job", "component", "name", "service", "chart", "release"],
};

/**
 * Format discovery recipes into a prompt-friendly string.
 */
function formatRecipeHints(recipes: DiscoveryRecipe[]): string {
  return recipes.map((recipe) => {
    const lines: string[] = [`### ${recipe.providerType}`];
    if (recipe.serviceQueries.length > 0) {
      lines.push("Suggested queries:");
      for (const q of recipe.serviceQueries) {
        lines.push(`- ${q}`);
      }
    }
    if (recipe.labelKeys.length > 0) {
      lines.push(`Service label keys: ${recipe.labelKeys.join(", ")}`);
    }
    return lines.join("\n");
  }).join("\n\n");
}

export async function runDiscoverStep(config: DiscoverStepConfig): Promise<ServiceConfig[]> {
  let discoveryTools: Record<string, any>;
  try {
    const [metrics, infra] = await Promise.all([
      getToolsByRole(config.providers, "metrics").catch(() => ({})),
      getToolsByRole(config.providers, "infrastructure").catch(() => ({})),
    ]);
    discoveryTools = { ...metrics, ...infra };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`MCP connection failed — cannot reach monitoring providers. ${msg}`);
  }
  if (Object.keys(discoveryTools).length === 0) {
    throw new Error("No MCP tools available — check that your monitoring MCP server is running and has the 'metrics' or 'infrastructure' role.");
  }

  // Build recipe hints for the discover agent prompt
  const configuredRecipes = config.discoveryConfig.discoveryRecipes ?? [];
  const effectiveRecipes = configuredRecipes.length > 0
    ? configuredRecipes
    : [DEFAULT_PROMETHEUS_RECIPE];
  const recipeHints = formatRecipeHints(effectiveRecipes);

  // Keep maxSteps capped so the quirk wind-down (which disables tools to
  // force JSON output) fires before the model exhausts all iterations.
  // The agent runs multiple discovery queries (deployments, statefulsets,
  // daemonsets, pods, scrape targets) so it needs enough iterations.
  const maxSteps = Math.min(config.discoveryConfig.maxIterations, 35);

  // Wrap tools with callbacks and emit synthetic iteration events based on tool call count
  let toolCallCount = 0;
  const wrappedOnToolCall: typeof config.onToolCall = config.onToolCall
    ? (name, args, result, durationMs, error, phase) => {
        toolCallCount++;
        config.onIteration?.("discovery", toolCallCount, maxSteps, `Querying ${name}`);
        config.onToolCall!(name, args, result, durationMs, error, phase);
      }
    : undefined;

  const tools = wrappedOnToolCall
    ? wrapToolsWithCallbacks(discoveryTools, wrappedOnToolCall, "discovery")
    : discoveryTools;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    // Format discovery-scoped skills and append after recipe hints
    let fullHints = recipeHints;
    if (config.skills && config.skills.length > 0) {
      const skillSections = config.skills.map((s) => {
        const body = s.body.length > 2000 ? s.body.slice(0, 2000) + "\n...[truncated]" : s.body;
        return `### ${wrapUntrusted("skill", s.title)}\n${wrapUntrusted("skill_body", body)}`;
      });
      fullHints += `\n\n## Team Knowledge (Discovery Skills)\n${skillSections.join("\n\n")}`;
    }

    const agent = createDiscoverAgent({
      model: config.model,
      tools,
      maxSteps,
      excludeServices: config.discoveryConfig.excludeServices,
      useQuirkHandling: true,
      discoveryRecipes: fullHints,
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
