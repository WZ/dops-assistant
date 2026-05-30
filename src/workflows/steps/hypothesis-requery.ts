/**
 * Hypothesis re-query — the tool-enabled `gatherEvidence` for the hypothesis loop.
 *
 * The pure loop (./hypothesis-loop.ts) injects a `gatherEvidence(leader, round)`
 * callback so its rank → test → rule-out control flow stays unit-testable
 * without an LLM or MCP. This module supplies the real implementation: it turns
 * the leading hypothesis's structured `prediction` into ONE targeted, READ-ONLY
 * MCP query against the right role, then normalizes the result into
 * `NormalizedObservation[]` the corroboration keystone can assess.
 *
 * Why a fresh query (vs. re-reasoning over the evidence already gathered): the
 * parallel evidence phase gathers broadly. A hypothesis *test* needs the one
 * observable that DISTINGUISHES the leader from its runner-up — which the broad
 * pass often never fetched. That discriminating re-query is the whole point of
 * the loop; without it the loop only re-reads what synthesis already saw.
 *
 * Always read-only: a verification query must never mutate. Tools are filtered
 * to read-only unconditionally here, independent of `config.readOnlyTools`.
 */

import { getToolsByRole, filterToReadOnlyTools } from "../../mcp/provider.js";
import {
  wrapToolsWithCallbacks,
  extractMastraToolResult,
  debug,
  type MastraToolResultLike,
} from "../tool-utils.js";
import { TOOL_RESULT_TRUNCATION_LIMIT } from "../../constants.js";
import { safeJsonParse } from "../../agents/shared/processors.js";
import { normalizeObservations } from "./observation-normalize.js";
import { createMetricsAgent } from "../../agents/metrics.js";
import { createLogsAgent } from "../../agents/logs.js";
import { createInfraAgent } from "../../agents/infra.js";
import { createChangesAgent } from "../../agents/changes.js";
import { withLlmRetry, safeAgentRetryConfig } from "../../agents/shared/llm-retry.js";
import type { ProviderRole } from "../../config/schema.js";
import type { MastraProvider } from "../../mcp/provider.js";
import type { WorkflowConfig } from "../investigation.js";
import type { LlmRetryConfig } from "../../agents/shared/llm-retry.js";
import type {
  RankedHypothesis,
  NormalizedObservation,
  CorroborationContext,
} from "./corroboration.js";

// ── Prediction → query plan (pure, unit-testable) ────────────────────────────

type Phase = "metrics" | "logs" | "infra" | "changes";

export interface PredictionQueryPlan {
  /** MCP provider role whose tools can test this prediction. */
  role: ProviderRole;
  /** Evidence phase, used to normalize the result back to observations. */
  phase: Phase;
  /** Focused, single-hypothesis prompt for the role agent. */
  prompt: string;
}

const PHASE_META: Record<Phase, { extractorSchema: string; createAgent: (opts: { model: any; tools: Record<string, any>; useQuirkHandling?: boolean }) => any }> = {
  metrics: {
    createAgent: createMetricsAgent,
    extractorSchema: '{"summary":"string","observations":[{"metric":"string","currentValue":"string","baselineValue":"string","severity":"string"}]}',
  },
  logs: {
    createAgent: createLogsAgent,
    extractorSchema: '{"summary":"string","observations":[{"pattern":"string","count":"string","firstSeen":"string","lastSeen":"string","sample":"string","sampleLines":["string"]}]}',
  },
  infra: {
    createAgent: createInfraAgent,
    extractorSchema: '{"summary":"string","observations":[{"resource":"string","status":"string","detail":"string","timestamp":"string"}]}',
  },
  changes: {
    createAgent: createChangesAgent,
    extractorSchema: '{"summary":"string","observations":[{"type":"string","title":"string","timestamp":"string","author":"string","detail":"string"}]}',
  },
};

/**
 * Map a leading hypothesis's structured prediction to the role + focused prompt
 * needed to test it. Returns null when the prediction kind is unrecognized.
 * Pure — no I/O — so the mapping is exhaustively unit-testable.
 */
export function planPredictionQuery(
  leader: RankedHypothesis,
  timeRange?: { from: string; to: string },
  ctx: CorroborationContext = {},
): PredictionQueryPlan | null {
  const p = leader.prediction;
  const window = timeRange ? ` Incident window: ${timeRange.from} to ${timeRange.to}.` : "";
  const preamble = `You are verifying a SINGLE hypothesis with the minimal read-only query — not running a fresh investigation.\nHypothesis: "${leader.hypothesis}"`;
  const ret = (phase: Phase) => `Return ONLY JSON: ${PHASE_META[phase].extractorSchema}`;

  switch (p.kind) {
    case "metric-threshold":
      return {
        role: "metrics",
        phase: "metrics",
        prompt: `${preamble}\nPrediction to test: metric "${p.metric}" is ${p.op} ${p.value} during the incident.${window}\nRun ONE or TWO targeted queries for that exact metric over the window and report its actual value(s). Do not query unrelated metrics.\n${ret("metrics")}`,
      };
    case "log-pattern": {
      const expectPresent = p.present !== false;
      return {
        role: "logs",
        phase: "logs",
        prompt: `${preamble}\nPrediction to test: log pattern "${p.pattern}" is ${expectPresent ? "PRESENT" : "ABSENT"} during the incident.${window}\nSearch the logs for that exact pattern and report matching lines (or confirm none found). One or two targeted queries only.\n${ret("logs")}`,
      };
    }
    case "infra-status":
      return {
        role: "infrastructure",
        phase: "infra",
        prompt: `${preamble}\nPrediction to test: resource "${p.resource ?? "(the affected resource)"}" has status "${p.status}".${window}\nQuery infrastructure/Kubernetes for that resource's status and report it. One or two targeted queries only.\n${ret("infra")}`,
      };
    case "change-in-window":
      return {
        role: "changes",
        phase: "changes",
        prompt: `${preamble}\nPrediction to test: a deployment or change landed within ${p.withinMinutesBefore} minutes before the incident${ctx.incidentTime ? ` (incident onset ${ctx.incidentTime})` : ""}.\nSearch recent deployments, merge requests, and pipeline runs and report any with their timestamps. One or two targeted queries only.\n${ret("changes")}`,
      };
    default:
      return null;
  }
}

// ── Tool-enabled gatherEvidence ──────────────────────────────────────────────

export interface GatherEvidenceOptions {
  providers: MastraProvider[];
  model: WorkflowConfig["model"];
  timeRange?: { from: string; to: string };
  useQuirkHandling?: boolean;
  onToolCall?: WorkflowConfig["onToolCall"];
  onTokenUsage?: WorkflowConfig["onTokenUsage"];
  llmRetry?: LlmRetryConfig;
  ctx?: CorroborationContext;
  /**
   * Test seam: run a planned role query and return normalized observations.
   * Defaults to the real MCP-backed implementation. Injected in unit tests so
   * the mapping/normalization can be verified without an LLM or MCP.
   */
  runRoleQuery?: (plan: PredictionQueryPlan, opts: GatherEvidenceOptions) => Promise<NormalizedObservation[]>;
}

/**
 * Build the `gatherEvidence(leader, round)` callback the hypothesis loop injects.
 * Each call issues one targeted read-only query for the leader's prediction and
 * returns the normalized observations. Always graceful: any failure (no tools,
 * LLM/MCP error, unparseable output) returns [] so the loop can still assess on
 * the evidence already gathered.
 */
export function createGatherEvidence(
  options: GatherEvidenceOptions,
): (leader: RankedHypothesis, round: number) => Promise<NormalizedObservation[]> {
  const runRoleQuery = options.runRoleQuery ?? defaultRunRoleQuery;
  return async (leader, round) => {
    try {
      const plan = planPredictionQuery(leader, options.timeRange, options.ctx);
      if (!plan) {
        debug("HYP REQUERY: no query plan for prediction", leader.prediction);
        return [];
      }
      debug(`HYP REQUERY round ${round}: ${plan.phase} query for "${leader.hypothesis}"`);
      return await runRoleQuery(plan, options);
    } catch (err) {
      // Graceful degradation — a failed re-query must not abort the loop.
      debug("HYP REQUERY error (non-fatal):", err);
      return [];
    }
  };
}

/** Real implementation: getTools (read-only) → role agent → generate → normalize. */
async function defaultRunRoleQuery(
  plan: PredictionQueryPlan,
  opts: GatherEvidenceOptions,
): Promise<NormalizedObservation[]> {
  // 1. Fetch tools for the role and force read-only — a verification query never writes.
  const rawTools = filterToReadOnlyTools(await getToolsByRole(opts.providers, plan.role).catch(() => ({})));
  if (Object.keys(rawTools).length === 0) {
    debug(`HYP REQUERY: no read-only tools for role "${plan.role}" — skipping`);
    return [];
  }

  const tools = wrapToolsWithCallbacks(rawTools, opts.onToolCall, `hyp:${plan.phase}`);
  const agent = PHASE_META[plan.phase].createAgent({
    model: opts.model,
    tools,
    useQuirkHandling: opts.useQuirkHandling,
  });

  // 2. Run the focused query, collecting tool results in case the model returns
  //    no parseable text (mirrors the evidence step's extractor fallback).
  const toolData: string[] = [];
  let agentResult: { text: string } = { text: "" };
  agentResult = await withLlmRetry(
    () => agent.generate(plan.prompt, {
      onStepFinish: (step: any) => {
        try {
          if (step.toolResults?.length) {
            for (const tr of step.toolResults as MastraToolResultLike[]) {
              const { toolName, resultStr } = extractMastraToolResult(tr);
              const truncated = resultStr.length > TOOL_RESULT_TRUNCATION_LIMIT
                ? resultStr.slice(0, TOOL_RESULT_TRUNCATION_LIMIT) + "..."
                : resultStr;
              toolData.push(`Tool: ${toolName}\nResult: ${truncated}`);
            }
          }
          if (step.usage) {
            opts.onTokenUsage?.({
              inputTokens: step.usage.inputTokens ?? 0,
              outputTokens: step.usage.outputTokens ?? 0,
            });
          }
        } catch (err) {
          debug("HYP REQUERY onStepFinish error:", err);
        }
      },
    }),
    // Read-only context → retries are safe (no write tool to replay).
    safeAgentRetryConfig(opts.llmRetry, true),
  );

  // 3. Parse observations; if the model returned no JSON, extract from tool data.
  let parsed = safeJsonParse(agentResult.text);
  if ((!parsed || !parsed.observations?.length) && toolData.length > 0) {
    const { Agent: ExtractAgent } = await import("@mastra/core/agent");
    const extractor = new ExtractAgent({
      name: `hyp-${plan.phase}-extractor`,
      id: `hyp-${plan.phase}-extractor`,
      instructions: `Extract structured data from these query results. Return ONLY valid JSON: ${PHASE_META[plan.phase].extractorSchema}`,
      model: opts.model as any,
    });
    try {
      const extraction = await extractor.generate(toolData.join("\n\n"));
      parsed = safeJsonParse(extraction.text ?? "") ?? parsed;
    } catch { /* keep parsed */ }
  }

  const observations = Array.isArray(parsed?.observations) ? parsed.observations : [];
  if (observations.length === 0) return [];

  // 4. Normalize into the flat shape the corroboration keystone consumes.
  return normalizeObservations({ [plan.phase]: { observations } });
}
