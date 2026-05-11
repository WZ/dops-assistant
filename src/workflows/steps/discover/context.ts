/**
 * Setup phase for `runDiscoverStep`: fetch MCP tools, prefetch datasource
 * hints, wrap tools with observability, build the prompt, instantiate the
 * agent, and prepare the deterministic-candidate sink.
 *
 * Returns a `DiscoveryContext` the retry loop in discover.ts consumes —
 * everything per-call that doesn't change across retry attempts.
 */

import { createDiscoverAgent } from "../../../agents/discover.js";
import { getToolsByRole } from "../../../mcp/provider.js";
import { wrapToolsWithCallbacks } from "../../tool-utils.js";
import { wrapUntrusted } from "../../../agents/shared/prompt-helpers.js";
import { fetchDatasourceHints } from "../../../agents/shared/datasource-hints.js";
import type { LanguageModel } from "ai";
import {
  addCandidate,
  extractDiscoveryCandidates,
  mergeCandidatesIntoDiscoveryResult,
  type DiscoveryCandidate,
  type DiscoverStepResult,
} from "./candidates.js";

const MAX_DISCOVERY_STEPS = 35;

export interface PrepareDiscoveryStepArgs {
  model: LanguageModel;
  providers: Parameters<typeof getToolsByRole>[0];
  excludeServices: string[];
  maxIterations: number;
  maxToolResultChars: number;
  skills?: Array<{ title: string; body: string }>;
  maxCharsPerSkill?: number;
  onToolCall?: Parameters<typeof wrapToolsWithCallbacks>[1];
  onIteration?: (phase: string, current: number, max: number, description: string) => void;
}

export interface DiscoveryContext {
  agent: ReturnType<typeof createDiscoverAgent>;
  discoveredCandidates: Map<string, DiscoveryCandidate>;
  /** Stable per-call prompt — passed to `agent.generate` each retry attempt. */
  discoverPrompt: string;
  /** The prompt PLUS the hint blocks — logged for observability. */
  fullPrompt: string;
  fullPromptChars: number;
  excludeServices: string[];
  /**
   * Feed a raw Prometheus tool result into the deterministic-candidate path.
   * Both `wrapToolsWithCallbacks` (production) and the discover-step's
   * `onStepFinish` callback (so test mocks that bypass the wrapper still
   * exercise this path) push through here.
   */
  recordRawToolResult: (name: string, args: Record<string, unknown>, result: string) => void;
  /** Returns the deterministic-candidate-only fallback (used on terminal failure). */
  returnCandidatesOnly: () => DiscoverStepResult;
}

/**
 * Run all per-call setup. Throws on MCP failure or zero-tool init — caller
 * should let those bubble; both are diagnosable from the message.
 */
export async function prepareDiscoveryStep(args: PrepareDiscoveryStepArgs): Promise<DiscoveryContext> {
  let discoveryTools: Record<string, any>;
  try {
    const [metrics, infra] = await Promise.all([
      getToolsByRole(args.providers, "metrics").catch(() => ({})),
      getToolsByRole(args.providers, "infrastructure").catch(() => ({})),
    ]);
    discoveryTools = { ...metrics, ...infra };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`MCP connection failed — cannot reach monitoring providers. ${msg}`);
  }
  if (Object.keys(discoveryTools).length === 0) {
    throw new Error("No MCP tools available — check that your monitoring MCP server is running and has the 'metrics' or 'infrastructure' role.");
  }

  const maxSteps = Math.min(args.maxIterations, MAX_DISCOVERY_STEPS);

  const discoveredCandidates = new Map<string, DiscoveryCandidate>();
  let toolCallCount = 0;
  const wrappedOnToolCall: typeof args.onToolCall = args.onToolCall
    ? (name, callArgs, result, durationMs, error, phase) => {
        toolCallCount++;
        args.onIteration?.("discovery", toolCallCount, maxSteps, `Querying ${name}`);
        args.onToolCall!(name, callArgs, result, durationMs, error, phase);
      }
    : undefined;
  const recordRawDiscoveryToolResult = (name: string, callArgs: Record<string, unknown>, result: string) => {
    if (!name.includes("query_prometheus")) return;
    for (const candidate of extractDiscoveryCandidates(callArgs, result, args.excludeServices)) {
      addCandidate(discoveredCandidates, candidate, args.excludeServices);
    }
  };

  // wrapToolsWithCallbacks must run even when the caller didn't wire an
  // onToolCall — its execute path applies coercePrometheusArgs and coerceLokiArgs,
  // which are load-bearing for cold-start discovery.
  const { hintBlock: datasourceHints, uidMap: datasourceUidMap } = await fetchDatasourceHints(discoveryTools);

  // Cap each tool result so accumulated history doesn't blow past the model's
  // context window and trigger "max_tokens must be at least 1, got -N" from
  // the OpenAI-compatible gateway. 0 disables the cap (legacy behaviour).
  const maxToolResultChars = args.maxToolResultChars > 0 ? args.maxToolResultChars : undefined;
  const tools = wrapToolsWithCallbacks(
    discoveryTools,
    wrappedOnToolCall,
    "discovery",
    datasourceUidMap,
    maxToolResultChars,
    recordRawDiscoveryToolResult,
  );

  // Build skill hints. The standard K8s sweep queries are baked into the
  // prompt template itself (Layer 4 Process), so this builder only handles
  // per-stack discovery skills.
  let skillHints = "";
  if (args.skills && args.skills.length > 0) {
    const maxChars = args.maxCharsPerSkill ?? 2000;
    const skillSections = args.skills.map((s) => {
      const body = s.body.length > maxChars ? s.body.slice(0, maxChars) + "\n...[truncated]" : s.body;
      return `### ${wrapUntrusted("skill", s.title)}\n${wrapUntrusted("skill_body", body)}`;
    });
    skillHints = `## PRIORITY: Team Knowledge (Discovery Skills)\nThese skills describe services that CANNOT be found via standard K8s queries. You MUST run these discovery queries IN ADDITION to the standard K8s sweep.\n\n${skillSections.join("\n\n")}`;
  }

  const fullHints = datasourceHints + skillHints;
  const discoverPrompt = "Discover all monitored services using the available tools. Return the complete list as JSON.";
  const fullPrompt = `${discoverPrompt}\n\n${fullHints}`;

  const agent = createDiscoverAgent({
    model: args.model,
    tools,
    maxSteps,
    excludeServices: args.excludeServices,
    useQuirkHandling: true,
    datasourceUidHints: datasourceHints,
    discoverySkills: skillHints,
  });

  return {
    agent,
    discoveredCandidates,
    discoverPrompt,
    fullPrompt,
    fullPromptChars: fullPrompt.length,
    excludeServices: args.excludeServices,
    recordRawToolResult: recordRawDiscoveryToolResult,
    returnCandidatesOnly: () => mergeCandidatesIntoDiscoveryResult(
      { services: [], globalProbeRules: [] },
      discoveredCandidates,
      args.excludeServices,
    ),
  };
}
