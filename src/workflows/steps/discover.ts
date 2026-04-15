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
import { logLlmCall, logLlmCallStart, newCallId, type ToolCallEvent } from "../../server/llm-logger.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("discover");

export interface DiscoverStepConfig {
  model: LanguageModel;
  providers: MastraProvider[];
  discoveryConfig: DiscoveryConfig;
  onToolCall?: OnToolCallEnriched;
  onIteration?: OnIteration;
  onTokenUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
  skills?: Skill[];
  maxCharsPerSkill?: number;
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

  // Format discovery-scoped skills BEFORE recipes so the LLM sees them first.
  // Skills contain stack-specific knowledge (e.g., bare-metal services via Consul)
  // that the default K8s recipes don't cover. If skills come after recipes,
  // the model exhausts iterations on K8s queries and never reaches skill queries.
  let fullHints = "";
  if (config.skills && config.skills.length > 0) {
    const maxChars = config.maxCharsPerSkill ?? 2000;
    const skillSections = config.skills.map((s) => {
      const body = s.body.length > maxChars ? s.body.slice(0, maxChars) + "\n...[truncated]" : s.body;
      return `### ${wrapUntrusted("skill", s.title)}\n${wrapUntrusted("skill_body", body)}`;
    });
    fullHints += `## PRIORITY: Team Knowledge (Discovery Skills)\nThese skills describe services that CANNOT be found via standard K8s queries. You MUST run these discovery queries IN ADDITION to the standard recipes below.\n\n${skillSections.join("\n\n")}\n\n`;
  }
  fullHints += recipeHints;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const agent = createDiscoverAgent({
      model: config.model,
      tools,
      maxSteps,
      excludeServices: config.discoveryConfig.excludeServices,
      useQuirkHandling: true,
      discoveryRecipes: fullHints,
    });

    const discoverCallId = newCallId();
    const discoverPrompt = "Discover all monitored services using the available tools. Return the complete list as JSON.";
    const discoverStartMs = Date.now();
    const discoverToolCalls: ToolCallEvent[] = [];
    logLlmCallStart({
      callId: discoverCallId,
      agent: "discover",
      phase: `attempt-${attempt}`,
      promptChars: discoverPrompt.length + fullHints.length,
    });

    try {
      const result = await agent.generate(discoverPrompt, {
        providerOptions: { "openai-compatible": { max_tokens: 16384 } },
        onStepFinish: (step: any) => {
          if (!step.toolResults?.length) return;
          for (const tr of step.toolResults) {
            const payload = tr.payload ?? tr;
            const toolName = payload.toolName ?? payload.name ?? tr.toolName ?? "unknown";
            const nestedContent = payload.result?.content?.[0]?.text;
            const rawResult = nestedContent ?? payload.result ?? tr.result ?? tr.output ?? "";
            const resultStr = typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult);
            const argsStr = JSON.stringify(payload.args ?? {});
            discoverToolCalls.push({
              tool: toolName,
              argsChars: argsStr.length,
              args: argsStr,
              resultChars: resultStr.length,
              result: resultStr.slice(0, 500),
            });
          }
        },
      } as any);

      const usage = (result as any).totalUsage ?? (result as any).usage;
      const inTok = usage?.inputTokens ?? 0;
      const outTok = usage?.outputTokens ?? 0;
      if (usage && config.onTokenUsage) {
        config.onTokenUsage({ inputTokens: inTok, outputTokens: outTok });
      }

      logLlmCall({
        callId: discoverCallId,
        agent: "discover",
        phase: `attempt-${attempt}`,
        promptChars: discoverPrompt.length + fullHints.length,
        prompt: `${discoverPrompt}\n\n[hints: ${fullHints.length} chars]`,
        responseChars: result.text?.length ?? 0,
        response: result.text,
        inputTokens: inTok,
        outputTokens: outTok,
        durationMs: Date.now() - discoverStartMs,
        toolCalls: discoverToolCalls,
      });

      const parsed = safeJsonParse(result.text);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
      if (parsed?.services && Array.isArray(parsed.services) && parsed.services.length > 0) {
        return parsed.services;
      }
      logger.warn({ attempt, maxRetries: MAX_RETRIES }, "discovery returned empty result");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logLlmCall({
        callId: discoverCallId,
        agent: "discover",
        phase: `attempt-${attempt}`,
        promptChars: discoverPrompt.length + fullHints.length,
        prompt: `${discoverPrompt}\n\n[hints: ${fullHints.length} chars]`,
        responseChars: 0,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: Date.now() - discoverStartMs,
        toolCalls: discoverToolCalls,
        error: message,
      });
      logger.warn({ attempt, err: message }, "discovery attempt failed");
      if (attempt === MAX_RETRIES) throw err;
    }
  }

  return [];
}
