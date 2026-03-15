/**
 * Investigation workflow — Mastra-based multi-step RCA pipeline.
 *
 * Structure:
 *   prefetchStep → anomalyStep → planningStep → [metricsStep || logsStep || infraStep] → synthesisStep → postSynthesisStep
 *
 * Each step accesses providers and services via closure over WorkflowConfig.
 * The workflow is created as a factory so it can be instantiated with different
 * model/provider configurations for testing and production.
 */

import { createWorkflow } from "@mastra/core/workflows";
import type { LanguageModel } from "ai";
import { WorkflowInputSchema, PostSynthesisOutputSchema } from "./schemas.js";
import type { MastraProvider } from "../mcp/provider.js";
import type { ServiceConfig } from "../config/schema.js";
import { buildPrefetchStep } from "./steps/prefetch-step.js";
import { buildAnomalyStep } from "./steps/anomaly.js";
import { buildPlanningStep } from "./steps/planning.js";
import { buildMetricsStep, buildLogsStep, buildInfraStep } from "./steps/evidence.js";
import { buildSynthesisStep } from "./steps/synthesis.js";
import { buildPostSynthesisStep } from "./steps/post-synthesis.js";

// Re-export so callers can import step builders from either location
export { buildMetricsStep, buildLogsStep, buildInfraStep } from "./steps/evidence.js";
export { buildSynthesisStep } from "./steps/synthesis.js";

// ── WorkflowConfig ────────────────────────────────────────────────────────────

export interface WorkflowConfig {
  model: LanguageModel;
  providers: MastraProvider[];
  services: ServiceConfig[];
  useQuirkHandling?: boolean;
  /** Project root path for incident history storage */
  projectRoot?: string;
  /** Progress callbacks for streaming to UI */
  onPhase?: (phase: string) => void;
  onIteration?: (phase: string, iteration: number, maxIterations: number, label: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>, result?: string, duration?: number, error?: string, phase?: string) => void;
}

// ── Workflow factory ──────────────────────────────────────────────────────────

/**
 * Create the investigation workflow.
 *
 * The workflow follows a 6-phase pipeline:
 *   1. prefetchStep    — discover datasources, dashboards, log labels
 *   2. anomalyStep     — detect anomalies with metrics + dashboards tools
 *   3. planningStep    — generate hypotheses using incident history
 *   4. [parallel]      — metricsStep, logsStep, infraStep run concurrently
 *   5. synthesisStep   — combine evidence into RCA report + severity validation
 *   6. postSynthesisStep — save incident to history store
 */
export function createInvestigationWorkflow(workflowConfig: WorkflowConfig) {
  const prefetchStep = buildPrefetchStep(workflowConfig);
  const anomalyStep = buildAnomalyStep(workflowConfig);
  const planningStep = buildPlanningStep(workflowConfig);
  const metricsStep = buildMetricsStep(workflowConfig);
  const logsStep = buildLogsStep(workflowConfig);
  const infraStep = buildInfraStep(workflowConfig);
  const synthesisStep = buildSynthesisStep(workflowConfig);
  const postSynthesisStep = buildPostSynthesisStep(workflowConfig);

  const workflow = createWorkflow({
    id: "investigation",
    description: "Multi-phase root cause analysis investigation pipeline",
    inputSchema: WorkflowInputSchema,
    outputSchema: PostSynthesisOutputSchema,
    steps: [
      prefetchStep,
      anomalyStep,
      planningStep,
      metricsStep,
      logsStep,
      infraStep,
      synthesisStep,
      postSynthesisStep,
    ],
  });

  workflow
    .then(prefetchStep)
    .then(anomalyStep)
    .then(planningStep)
    .parallel([metricsStep, logsStep, infraStep])
    .then(synthesisStep)
    .then(postSynthesisStep)
    .commit();

  return workflow;
}
