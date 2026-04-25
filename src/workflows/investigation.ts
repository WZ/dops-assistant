/**
 * Investigation workflow — Mastra-based multi-step RCA pipeline.
 *
 * Templates control which phases run:
 *   full:     prefetch → anomaly → planning → [metrics || logs || infra || changes] → synthesis → post
 *   standard: prefetch → anomaly → planning → [metrics || logs]                     → synthesis → post
 *   quick:    prefetch → anomaly → planning → [metrics]                             → synthesis → post
 *
 * Each step accesses providers and services via closure over WorkflowConfig.
 * The workflow is created as a factory so it can be instantiated with different
 * model/provider configurations for testing and production.
 */

import { createWorkflow } from "@mastra/core/workflows";
import type { LanguageModel } from "ai";
import { WorkflowInputSchema, PostSynthesisOutputSchema } from "./schemas.js";
import type { MastraProvider } from "../mcp/provider.js";
import type { ServiceConfig, InvestigationTemplate } from "../config/schema.js";
import type { Skill } from "../skills/store.js";
import type { IncidentPatternRow } from "../agents/shared/patterns.js";
import { buildPrefetchStep } from "./steps/prefetch-step.js";
import { buildAnomalyStep } from "./steps/anomaly.js";
import { buildPlanningStep } from "./steps/planning.js";
import { buildMetricsStep, buildLogsStep, buildInfraStep, buildChangesStep } from "./steps/evidence.js";
import { buildSynthesisStep } from "./steps/synthesis.js";
import { buildPostSynthesisStep } from "./steps/post-synthesis.js";

// Re-export so callers can import step builders from either location
export { buildMetricsStep, buildLogsStep, buildInfraStep, buildChangesStep } from "./steps/evidence.js";
export { buildSynthesisStep } from "./steps/synthesis.js";

// ── WorkflowConfig ────────────────────────────────────────────────────────────

export interface WorkflowConfig {
  model: LanguageModel;
  providers: MastraProvider[];
  services: ServiceConfig[];
  useQuirkHandling?: boolean;
  /** Project root path for incident history storage */
  projectRoot?: string;
  /** When true, only read-only MCP tools are available to workflow steps.
   *  Used by headless investigations (webhook/poller) to prevent write operations. */
  readOnlyTools?: boolean;
  /** Pre-filtered skills for this investigation (investigation-scoped). */
  skills?: Skill[];
  /** Max chars per skill body for truncation (from config). */
  maxCharsPerSkill?: number;
  /** Progress callbacks for streaming to UI */
  onPhase?: (phase: string) => void;
  onIteration?: (phase: string, iteration: number, maxIterations: number, label: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>, result?: string, duration?: number, error?: string, phase?: string) => void;
  onTokenUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
  /** Short-name → real datasource UID map for intercepting LLM hallucinations. */
  datasourceUidMap?: Map<string, string>;
  /**
   * Fetch up-to-N learned `incident_patterns` rows scoped to the adapter's
   * stack, by service. Wired in by the adapter factory so workflow steps
   * stay decoupled from the database. When undefined (CLI/test paths with
   * no DB), planning + synthesis simply skip the pattern injection.
   */
  getSimilarPatterns?: (service: string, limit?: number) => IncidentPatternRow[];
}

// ── Workflow factory ──────────────────────────────────────────────────────────

/**
 * Create the investigation workflow for the given template.
 *
 * Template determines which phases are included:
 *   - "full" (default): all 6 phases, 3 parallel evidence streams (~2-3 min)
 *   - "standard": prefetch + anomaly + planning + metrics/logs + synthesis (~1 min)
 *   - "quick": prefetch + metrics + synthesis only (~30s)
 */
export function createInvestigationWorkflow(workflowConfig: WorkflowConfig, template: InvestigationTemplate = "full") {
  const prefetchStep = buildPrefetchStep(workflowConfig);
  const metricsStep = buildMetricsStep(workflowConfig);
  const synthesisStep = buildSynthesisStep(workflowConfig);
  const postSynthesisStep = buildPostSynthesisStep(workflowConfig);

  // All templates include anomaly + planning (they're fast, no tools, and produce
  // the PlanningOutputSchema that evidence steps require as input)
  const anomalyStep = buildAnomalyStep(workflowConfig);
  const planningStep = buildPlanningStep(workflowConfig);

  if (template === "quick") {
    // Quick: prefetch → anomaly → planning → metrics only → synthesis → post
    const workflow = createWorkflow({
      id: "investigation-quick",
      description: "Quick metrics-only investigation",
      inputSchema: WorkflowInputSchema,
      outputSchema: PostSynthesisOutputSchema,
      steps: [prefetchStep, anomalyStep, planningStep, metricsStep, synthesisStep, postSynthesisStep],
    });
    (workflow
      .then(prefetchStep)
      .then(anomalyStep)
      .then(planningStep)
      .then(metricsStep) as any)
      .then(synthesisStep)
      .then(postSynthesisStep)
      .commit();
    return workflow;
  }

  if (template === "standard") {
    // Standard: prefetch → anomaly → planning → [metrics || logs] → synthesis → post
    const logsStep = buildLogsStep(workflowConfig);
    const workflow = createWorkflow({
      id: "investigation-standard",
      description: "Standard metrics + logs investigation",
      inputSchema: WorkflowInputSchema,
      outputSchema: PostSynthesisOutputSchema,
      steps: [prefetchStep, anomalyStep, planningStep, metricsStep, logsStep, synthesisStep, postSynthesisStep],
    });
    (workflow
      .then(prefetchStep)
      .then(anomalyStep)
      .then(planningStep)
      .parallel([metricsStep, logsStep]) as any)
      .then(synthesisStep)
      .then(postSynthesisStep)
      .commit();
    return workflow;
  }

  // Full: all phases including changes evidence (4 parallel streams)
  const logsStep = buildLogsStep(workflowConfig);
  const infraStep = buildInfraStep(workflowConfig);
  const changesStep = buildChangesStep(workflowConfig);
  const workflow = createWorkflow({
    id: "investigation",
    description: "Multi-phase root cause analysis investigation pipeline",
    inputSchema: WorkflowInputSchema,
    outputSchema: PostSynthesisOutputSchema,
    steps: [prefetchStep, anomalyStep, planningStep, metricsStep, logsStep, infraStep, changesStep, synthesisStep, postSynthesisStep],
  });
  (workflow
    .then(prefetchStep)
    .then(anomalyStep)
    .then(planningStep)
    .parallel([metricsStep, logsStep, infraStep, changesStep]) as any)
    .then(synthesisStep)
    .then(postSynthesisStep)
    .commit();
  return workflow;
}
