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
import { logLlmCall, logLlmCallStart, logToolCall, newCallId, type ToolCallEvent } from "../../server/llm-logger.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("discover");

export interface DiscoverStepConfig {
  model: LanguageModel;
  providers: MastraProvider[];
  discoveryConfig: DiscoveryConfig;
  onToolCall?: OnToolCallEnriched;
  onIteration?: OnIteration;
  onTokenUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
  onRetry?: (attempt: number, maxRetries: number, reason: string) => void;
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

interface DatasourceHintResult {
  hintBlock: string;
  uidMap: Map<string, string>;
}

/**
 * Call `list_datasources` on a discovery tool map and format the result as a
 * `<untrusted_datasource_hints>` block the agent can consume. Also returns a
 * short-name → real-UID map for tool-arg coercion. Returns empty hint block
 * and empty map if no tool is available or the call fails.
 */
async function fetchDatasourceHintsForDiscover(
  tools: Record<string, any>,
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
    } else if (raw?.content?.[0]?.text) {
      text = raw.content[0].text;
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

    return { hintBlock, uidMap };
  } catch {
    void toolName;
    return empty;
  }
}

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

  // Always wrap the discovery tools — wrapToolsWithCallbacks applies
  // coercePrometheusArgs and coerceLokiArgs inside the execute path, and
  // those coercions MUST run even when no user-facing onToolCall callback
  // is wired (e.g., auto-discovery on cold start). `wrappedOnToolCall` can
  // be undefined; the wrapper handles that with optional chaining.
  // Pre-fetch datasource UIDs so the agent doesn't hallucinate them.
  // Returns both a prompt hint block and a short-name → real-UID map for
  // defensive coercion in the tool wrapper.
  const { hintBlock: datasourceHints, uidMap: datasourceUidMap } =
    await fetchDatasourceHintsForDiscover(discoveryTools);

  const tools = wrapToolsWithCallbacks(discoveryTools, wrappedOnToolCall, "discovery", datasourceUidMap);

  // Build recipe hints (skills + recipes). Datasource UIDs are passed
  // separately as a strict "CRITICAL" block in the agent's system prompt.
  let recipeAndSkillHints = "";
  if (config.skills && config.skills.length > 0) {
    const maxChars = config.maxCharsPerSkill ?? 2000;
    const skillSections = config.skills.map((s) => {
      const body = s.body.length > maxChars ? s.body.slice(0, maxChars) + "\n...[truncated]" : s.body;
      return `### ${wrapUntrusted("skill", s.title)}\n${wrapUntrusted("skill_body", body)}`;
    });
    recipeAndSkillHints += `## PRIORITY: Team Knowledge (Discovery Skills)\nThese skills describe services that CANNOT be found via standard K8s queries. You MUST run these discovery queries IN ADDITION to the standard recipes below.\n\n${skillSections.join("\n\n")}\n\n`;
  }
  recipeAndSkillHints += recipeHints;

  // For logging: combine both blocks so the debug log shows the full prompt
  const fullHints = datasourceHints + recipeAndSkillHints;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const agent = createDiscoverAgent({
      model: config.model,
      tools,
      maxSteps,
      excludeServices: config.discoveryConfig.excludeServices,
      useQuirkHandling: true,
      datasourceUidHints: datasourceHints,
      discoveryRecipes: recipeAndSkillHints,
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
      prompt: `${discoverPrompt}\n\n${fullHints}`,
    });

    try {
      const result = await agent.generate(discoverPrompt, {
        providerOptions: { "openai-compatible": { max_tokens: 32768 } },
        onStepFinish: (step: any) => {
          if (!step.toolResults?.length) return;
          for (const tr of step.toolResults) {
            try {
              const payload = tr.payload ?? tr;
              const toolName = payload.toolName ?? payload.name ?? tr.toolName ?? "unknown";
              const nestedContent = payload.result?.content?.[0]?.text;
              const rawResult = nestedContent ?? payload.result ?? tr.result ?? tr.output ?? "";
              const resultStr = typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult);
              // JSON.stringify can throw on BigInt / circular / exotic return types.
              // Slice args/results to 500 chars to bound memory on long discovery runs.
              const argsStr = JSON.stringify(payload.args ?? {});
              const toolEvent: ToolCallEvent = {
                tool: toolName,
                argsChars: argsStr.length,
                args: argsStr.slice(0, 500),
                resultChars: resultStr.length,
                result: resultStr.slice(0, 500),
              };
              discoverToolCalls.push(toolEvent);
              logToolCall(discoverCallId, "discover", toolEvent);
            } catch (err) {
              // Never let observability crash the discover step.
              logger.warn({ err }, "discover: onStepFinish failed to record tool call");
            }
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
        prompt: `${discoverPrompt}\n\n${fullHints}`,
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
      const respLen = result.text?.length ?? 0;
      const first200 = result.text?.slice(0, 200) ?? "";
      const last200 = result.text?.slice(-200) ?? "";
      logger.warn(
        { attempt, maxRetries: MAX_RETRIES, responseChars: respLen, first200, last200 },
        `discovery: parse failed on ${respLen}-char response (attempt ${attempt}/${MAX_RETRIES})`,
      );
      config.onRetry?.(attempt, MAX_RETRIES, "parse failed");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logLlmCall({
        callId: discoverCallId,
        agent: "discover",
        phase: `attempt-${attempt}`,
        promptChars: discoverPrompt.length + fullHints.length,
        prompt: `${discoverPrompt}\n\n${fullHints}`,
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
