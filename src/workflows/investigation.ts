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

import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import type { LanguageModel } from "ai";
import type { MastraProvider } from "../mcp/provider.js";
import type { ServiceConfig } from "../config/schema.js";
import { getToolsByRole } from "../mcp/provider.js";
import { executePrefetch } from "./prefetch.js";
import { buildTimeline, validateSeverity } from "./helpers.js";
import { getRecentIncidents, saveIncident, formatIncidentHistory } from "../history/store.js";
import { createAnomalyDetectorAgent } from "../agents/anomaly-detector.js";
import { createPlannerAgent } from "../agents/planner.js";
import { createMetricsAgent } from "../agents/metrics.js";
import { createLogsAgent } from "../agents/logs.js";
import { createInfraAgent } from "../agents/infra.js";
import { createSynthesisAgent } from "../agents/synthesis.js";

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
  onToolCall?: (name: string, args: Record<string, unknown>, result?: string, duration?: number, error?: string) => void;
}

// ── Tool wrapping helper ──────────────────────────────────────────────────────

/**
 * Wrap each tool's execute function to emit onToolCall before/after invocation.
 * If no onToolCall callback is provided, tools are returned unchanged.
 */
function wrapToolsWithCallbacks(
  tools: Record<string, any>,
  onToolCall?: WorkflowConfig["onToolCall"],
): Record<string, any> {
  if (!onToolCall) return tools;
  const wrapped: Record<string, any> = {};
  for (const [name, tool] of Object.entries(tools)) {
    wrapped[name] = {
      ...tool,
      execute: async (...args: any[]) => {
        const start = Date.now();
        try {
          const result = await tool.execute(...args);
          const resultStr = typeof result === "string" ? result : JSON.stringify(result);
          onToolCall(name, args[0] ?? {}, resultStr, Date.now() - start);
          return result;
        } catch (err) {
          onToolCall(name, args[0] ?? {}, undefined, Date.now() - start, String(err));
          throw err;
        }
      },
    };
  }
  return wrapped;
}

// ── Zod schemas for step I/O ──────────────────────────────────────────────────

const PrefetchedContextSchema = z.object({
  datasourceHints: z.string(),
  dashboardContext: z.string(),
  panelQueryHints: z.string(),
  logLabelHints: z.string(),
  workingLogSelectors: z.array(z.string()),
});

const WorkflowInputSchema = z.object({
  userMessage: z.string(),
  alertName: z.string().optional(),
  serviceName: z.string().optional(),
});

const PrefetchOutputSchema = PrefetchedContextSchema.extend({
  userMessage: z.string(),
  alertName: z.string().optional(),
  serviceName: z.string().optional(),
});

const AnomalyOutputSchema = z.object({
  isAnomaly: z.boolean(),
  severity: z.enum(["low", "medium", "high", "critical"]).optional(),
  summary: z.string(),
  affectedServices: z.array(z.string()).optional(),
  timeRangeFrom: z.string().optional(),
  timeRangeTo: z.string().optional(),
  // Pass through prefetch and input for downstream steps
  prefetchContext: PrefetchedContextSchema,
  userMessage: z.string(),
  serviceName: z.string().optional(),
});

const PlanningOutputSchema = z.object({
  hypotheses: z.array(z.object({
    hypothesis: z.string(),
    evidenceNeeded: z.string(),
  })).optional(),
  metricFocus: z.array(z.string()).optional(),
  logFocus: z.array(z.string()).optional(),
  infraFocus: z.array(z.string()).optional(),
  // Pass through
  anomalyContext: AnomalyOutputSchema,
});

const EvidenceOutputSchema = z.object({
  summary: z.string(),
  observations: z.array(z.unknown()).optional(),
  // Generic evidence output from metrics/logs/infra agents
});

const ParallelEvidenceSchema = z.object({
  metrics: EvidenceOutputSchema,
  logs: EvidenceOutputSchema,
  infra: EvidenceOutputSchema,
  planningContext: PlanningOutputSchema,
});

const SynthesisOutputSchema = z.object({
  severity: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  summary: z.string().default("Investigation complete"),
  rootCause: z.string().default("Unable to determine"),
  trigger: z.string().default("Unknown"),
  confidence: z.enum(["low", "medium", "high"]).default("low"),
  confidenceScore: z.number().default(0.5),
  timeline: z.string().optional(),
  evidenceSummary: z.object({
    metrics: EvidenceOutputSchema,
    logs: EvidenceOutputSchema,
    infra: EvidenceOutputSchema,
  }),
  planningContext: PlanningOutputSchema,
});

const PostSynthesisOutputSchema = z.object({
  severity: z.enum(["low", "medium", "high", "critical"]),
  summary: z.string(),
  rootCause: z.string(),
  trigger: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
  confidenceScore: z.number(),
  savedToHistory: z.boolean(),
  investigatedAt: z.string(),
});

// ── Step factory helpers ──────────────────────────────────────────────────────

/**
 * Build a prefetch step that discovers datasources, dashboards, and log labels.
 */
function buildPrefetchStep(config: WorkflowConfig) {
  return createStep({
    id: "prefetch",
    description: "Pre-fetch datasource UIDs, dashboard list, and log label context",
    inputSchema: WorkflowInputSchema,
    outputSchema: PrefetchOutputSchema,
    execute: async ({ inputData }) => {
      config.onPhase?.("Detecting anomalies");
      config.onIteration?.("planning", 0, 6, "Pre-fetching datasource context");

      const prefetchContext = await executePrefetch(
        config.providers,
        config.services,
        {
          userMessage: inputData.userMessage,
        },
      );

      return {
        ...prefetchContext,
        userMessage: inputData.userMessage,
        alertName: inputData.alertName,
        serviceName: inputData.serviceName,
      };
    },
  });
}

/**
 * Build an anomaly detection step using the anomaly detector agent.
 */
function buildAnomalyStep(config: WorkflowConfig) {
  return createStep({
    id: "anomaly-detection",
    description: "Detect anomalies from metrics and dashboards",
    inputSchema: PrefetchOutputSchema,
    outputSchema: AnomalyOutputSchema,
    execute: async ({ inputData }) => {
      config.onPhase?.("Detecting anomalies");

      const metricsTools = await getToolsByRole(config.providers, "metrics").catch(() => ({}));
      const dashboardTools = await getToolsByRole(config.providers, "dashboards").catch(() => ({}));
      const rawTools = { ...metricsTools, ...dashboardTools };
      const tools = wrapToolsWithCallbacks(rawTools, config.onToolCall);

      const agent = createAnomalyDetectorAgent({
        model: config.model,
        tools,
        useQuirkHandling: config.useQuirkHandling,
      });

      const prompt = [
        inputData.datasourceHints,
        inputData.dashboardContext,
        `User message: ${inputData.userMessage}`,
        inputData.serviceName ? `Service: ${inputData.serviceName}` : "",
      ].filter(Boolean).join("\n");

      let agentResult: { text: string } = { text: "" };
      let anomalyIterationCount = 0;
      try {
        agentResult = await agent.generate(prompt, {
          onStepFinish: (step: any) => {
            anomalyIterationCount++;
            config.onIteration?.("anomaly", anomalyIterationCount, 10, `Step ${anomalyIterationCount}`);
            if (step.toolResults?.length) {
              for (const tr of step.toolResults) {
                const resultStr = typeof tr.result === "string" ? tr.result : JSON.stringify(tr.result);
                config.onToolCall?.(tr.toolName, tr.args ?? {}, resultStr, undefined);
              }
            }
          },
        });
      } catch {
        // Fall through to default
      }

      // Extract anomaly context from agent text response
      let isAnomaly = true;
      let severity: "low" | "medium" | "high" | "critical" = "medium";
      let summary = inputData.userMessage;

      try {
        const parsed = JSON.parse(agentResult.text);
        isAnomaly = parsed.isAnomaly ?? true;
        severity = parsed.severity ?? "medium";
        summary = parsed.summary ?? inputData.userMessage;
      } catch {
        // Keep defaults
      }

      const prefetchContext = {
        datasourceHints: inputData.datasourceHints,
        dashboardContext: inputData.dashboardContext,
        panelQueryHints: inputData.panelQueryHints,
        logLabelHints: inputData.logLabelHints,
        workingLogSelectors: inputData.workingLogSelectors,
      };

      return {
        isAnomaly,
        severity,
        summary,
        affectedServices: inputData.serviceName ? [inputData.serviceName] : [],
        prefetchContext,
        userMessage: inputData.userMessage,
        serviceName: inputData.serviceName,
      };
    },
  });
}

/**
 * Build a planning step that fetches recent incidents and creates an investigation plan.
 */
function buildPlanningStep(config: WorkflowConfig) {
  return createStep({
    id: "planning",
    description: "Fetch recent incidents and generate investigation hypotheses",
    inputSchema: AnomalyOutputSchema,
    outputSchema: PlanningOutputSchema,
    execute: async ({ inputData }) => {
      // Fetch recent incidents for context
      let historyContext = "";
      if (config.projectRoot && inputData.serviceName) {
        try {
          const recentIncidents = await getRecentIncidents(config.projectRoot, inputData.serviceName);
          historyContext = formatIncidentHistory(recentIncidents);
        } catch {
          // Graceful degradation
        }
      }

      config.onPhase?.("Planning investigation");
      config.onIteration?.("planning", 1, 6, "Building investigation plan");

      const agent = createPlannerAgent({ model: config.model });

      const prompt = [
        `Anomaly: ${inputData.summary}`,
        `Severity: ${inputData.severity ?? "unknown"}`,
        inputData.serviceName ? `Service: ${inputData.serviceName}` : "",
        historyContext ? `\nRecent incidents:\n${historyContext}` : "",
      ].filter(Boolean).join("\n");

      let agentResult: { text: string } = { text: "" };
      try {
        agentResult = await agent.generate(prompt);
      } catch {
        // Fall through to defaults
      }

      let hypotheses: Array<{ hypothesis: string; evidenceNeeded: string }> = [];
      let metricFocus: string[] = [];
      let logFocus: string[] = [];
      let infraFocus: string[] = [];

      try {
        const parsed = JSON.parse(agentResult.text);
        hypotheses = parsed.hypotheses ?? [];
        metricFocus = parsed.metricFocus ?? [];
        logFocus = parsed.logFocus ?? [];
        infraFocus = parsed.infraFocus ?? [];
      } catch {
        // Keep defaults
      }

      return {
        hypotheses,
        metricFocus,
        logFocus,
        infraFocus,
        anomalyContext: inputData,
      };
    },
  });
}

/**
 * Build a metrics evidence step.
 * Exported for testing.
 */
export function buildMetricsStep(config: WorkflowConfig) {
  return createStep({
    id: "metrics-evidence",
    description: "Deep-dive into metrics to identify anomalous patterns",
    inputSchema: PlanningOutputSchema,
    outputSchema: EvidenceOutputSchema,
    execute: async ({ inputData }) => {
      config.onPhase?.("Analyzing metrics");
      config.onIteration?.("metrics", 2, 6, "Analyzing metrics");

      const rawMetricsTools = await getToolsByRole(config.providers, "metrics").catch(() => ({}));
      const rawDashboardTools = await getToolsByRole(config.providers, "dashboards").catch(() => ({}));
      const metricsTools = wrapToolsWithCallbacks({ ...rawMetricsTools, ...rawDashboardTools }, config.onToolCall);

      const agent = createMetricsAgent({
        model: config.model,
        tools: metricsTools,
        useQuirkHandling: config.useQuirkHandling,
      });

      const { anomalyContext } = inputData;
      const prompt = [
        anomalyContext.prefetchContext.datasourceHints,
        anomalyContext.prefetchContext.panelQueryHints,
        `Anomaly: ${anomalyContext.summary}`,
        anomalyContext.serviceName ? `Service: ${anomalyContext.serviceName}` : "",
        inputData.metricFocus?.length
          ? `Focus areas: ${inputData.metricFocus.join(", ")}`
          : "",
      ].filter(Boolean).join("\n");

      let agentResult: { text: string } = { text: "" };
      let metricsIterationCount = 0;
      try {
        agentResult = await agent.generate(prompt, {
          onStepFinish: (step: any) => {
            metricsIterationCount++;
            config.onIteration?.("metrics", metricsIterationCount, 10, `Step ${metricsIterationCount}`);
            if (step.toolResults?.length) {
              for (const tr of step.toolResults) {
                const resultStr = typeof tr.result === "string" ? tr.result : JSON.stringify(tr.result);
                config.onToolCall?.(tr.toolName, tr.args ?? {}, resultStr, undefined);
              }
            }
          },
        });
      } catch {
        // Fall through
      }

      try {
        const parsed = JSON.parse(agentResult.text);
        return {
          summary: parsed.summary ?? "Metrics analysis unavailable",
          observations: parsed.observations ?? [],
          anomalyWindow: parsed.anomalyWindow,
        };
      } catch {
        return { summary: "Metrics analysis unavailable", observations: [] };
      }
    },
  });
}

/**
 * Build a logs evidence step.
 * Exported for testing.
 */
export function buildLogsStep(config: WorkflowConfig) {
  return createStep({
    id: "logs-evidence",
    description: "Correlate log patterns with the incident timeline",
    inputSchema: PlanningOutputSchema,
    outputSchema: EvidenceOutputSchema,
    execute: async ({ inputData }) => {
      config.onPhase?.("Analyzing logs");
      config.onIteration?.("logs", 3, 6, "Analyzing logs");

      const rawLogsTools = await getToolsByRole(config.providers, "logs").catch(() => ({}));
      const logsTools = wrapToolsWithCallbacks(rawLogsTools, config.onToolCall);

      const agent = createLogsAgent({
        model: config.model,
        tools: logsTools,
        useQuirkHandling: config.useQuirkHandling,
      });

      const { anomalyContext } = inputData;
      const { prefetchContext } = anomalyContext;
      const selectorHint = prefetchContext.workingLogSelectors.length > 0
        ? `VALIDATED LOG SELECTOR: ${prefetchContext.workingLogSelectors[0]}`
        : "";

      const prompt = [
        prefetchContext.datasourceHints,
        prefetchContext.logLabelHints,
        selectorHint,
        `Anomaly: ${anomalyContext.summary}`,
        anomalyContext.serviceName ? `Service: ${anomalyContext.serviceName}` : "",
        inputData.logFocus?.length
          ? `Focus areas: ${inputData.logFocus.join(", ")}`
          : "",
      ].filter(Boolean).join("\n");

      let agentResult: { text: string } = { text: "" };
      let logsIterationCount = 0;
      try {
        agentResult = await agent.generate(prompt, {
          onStepFinish: (step: any) => {
            logsIterationCount++;
            config.onIteration?.("logs", logsIterationCount, 10, `Step ${logsIterationCount}`);
            if (step.toolResults?.length) {
              for (const tr of step.toolResults) {
                const resultStr = typeof tr.result === "string" ? tr.result : JSON.stringify(tr.result);
                config.onToolCall?.(tr.toolName, tr.args ?? {}, resultStr, undefined);
              }
            }
          },
        });
      } catch {
        // Fall through
      }

      try {
        const parsed = JSON.parse(agentResult.text);
        return {
          summary: parsed.summary ?? "Log analysis unavailable",
          observations: parsed.observations ?? [],
        };
      } catch {
        return { summary: "Log analysis unavailable", observations: [] };
      }
    },
  });
}

/**
 * Build an infra evidence step.
 * Exported for testing.
 */
export function buildInfraStep(config: WorkflowConfig) {
  return createStep({
    id: "infra-evidence",
    description: "Check infrastructure health for resource issues and deployment changes",
    inputSchema: PlanningOutputSchema,
    outputSchema: EvidenceOutputSchema,
    execute: async ({ inputData }) => {
      config.onPhase?.("Checking infrastructure");
      config.onIteration?.("infra", 4, 6, "Checking infrastructure");

      const rawInfraMetricsTools = await getToolsByRole(config.providers, "metrics").catch(() => ({}));
      const rawInfraDashboardTools = await getToolsByRole(config.providers, "dashboards").catch(() => ({}));
      const infraTools = wrapToolsWithCallbacks({ ...rawInfraMetricsTools, ...rawInfraDashboardTools }, config.onToolCall);

      const agent = createInfraAgent({
        model: config.model,
        tools: infraTools,
        useQuirkHandling: config.useQuirkHandling,
      });

      const { anomalyContext } = inputData;
      const prompt = [
        anomalyContext.prefetchContext.datasourceHints,
        anomalyContext.prefetchContext.panelQueryHints,
        `Anomaly: ${anomalyContext.summary}`,
        anomalyContext.serviceName ? `Service: ${anomalyContext.serviceName}` : "",
        inputData.infraFocus?.length
          ? `Focus areas: ${inputData.infraFocus.join(", ")}`
          : "",
      ].filter(Boolean).join("\n");

      let agentResult: { text: string } = { text: "" };
      let infraIterationCount = 0;
      try {
        agentResult = await agent.generate(prompt, {
          onStepFinish: (step: any) => {
            infraIterationCount++;
            config.onIteration?.("infra", infraIterationCount, 10, `Step ${infraIterationCount}`);
            if (step.toolResults?.length) {
              for (const tr of step.toolResults) {
                const resultStr = typeof tr.result === "string" ? tr.result : JSON.stringify(tr.result);
                config.onToolCall?.(tr.toolName, tr.args ?? {}, resultStr, undefined);
              }
            }
          },
        });
      } catch {
        // Fall through
      }

      try {
        const parsed = JSON.parse(agentResult.text);
        return {
          summary: parsed.summary ?? "Infrastructure analysis unavailable",
          observations: parsed.observations ?? [],
        };
      } catch {
        return { summary: "Infrastructure analysis unavailable", observations: [] };
      }
    },
  });
}

/**
 * Build a synthesis step that combines evidence and runs quality validation.
 * Exported for testing.
 */
export function buildSynthesisStep(config: WorkflowConfig) {
  return createStep({
    id: "synthesis",
    description: "Synthesize root cause from all evidence phases",
    inputSchema: z.object({
      "metrics-evidence": EvidenceOutputSchema,
      "logs-evidence": EvidenceOutputSchema,
      "infra-evidence": EvidenceOutputSchema,
    }),
    outputSchema: SynthesisOutputSchema,
    execute: async ({ inputData }) => {
      const metricsFindings = inputData["metrics-evidence"];
      const logsFindings = inputData["logs-evidence"];
      const infraFindings = inputData["infra-evidence"];

      // Build timeline from structured observations
      const metricsForTimeline = {
        observations: ((metricsFindings.observations ?? []) as any[]).map((o: any) => ({
          metric: o.metric ?? "",
          currentValue: o.currentValue ?? o.current ?? "",
          baselineValue: o.baselineValue ?? o.baseline ?? "",
          timestamp: o.timestamp ?? o.time ?? "",
          severity: o.severity ?? "normal",
        })),
        anomalyWindow: "",
        summary: metricsFindings.summary,
      };
      const logsForTimeline = {
        observations: ((logsFindings.observations ?? []) as any[]).map((o: any) => ({
          pattern: o.pattern ?? "",
          count: o.count ?? "",
          firstSeen: o.firstSeen ?? "",
          lastSeen: o.lastSeen ?? "",
          sample: o.sample ?? "",
          sampleLines: o.sampleLines ?? [],
        })),
        summary: logsFindings.summary,
      };
      const infraForTimeline = {
        observations: ((infraFindings.observations ?? []) as any[]).map((o: any) => ({
          resource: o.resource ?? "",
          status: o.status ?? "",
          detail: o.detail ?? "",
          timestamp: o.timestamp ?? o.time ?? "",
        })),
        summary: infraFindings.summary,
      };

      const timeline = buildTimeline(metricsForTimeline, logsForTimeline, infraForTimeline);

      config.onPhase?.("Synthesizing root cause");
      config.onIteration?.("synthesis", 5, 6, "Synthesizing root cause");

      const agent = createSynthesisAgent({ model: config.model });

      const prompt = [
        "Synthesize a root cause analysis from the following evidence:",
        `\nMetrics: ${JSON.stringify({ summary: metricsFindings.summary, observations: metricsFindings.observations })}`,
        `\nLogs: ${JSON.stringify({ summary: logsFindings.summary, observations: logsFindings.observations })}`,
        `\nInfra: ${JSON.stringify({ summary: infraFindings.summary, observations: infraFindings.observations })}`,
        timeline ? `\nTimeline:\n${timeline}` : "",
      ].filter(Boolean).join("\n");

      let agentResult: { text: string } = { text: "" };
      try {
        agentResult = await agent.generate(prompt);
      } catch {
        // Fall through to defaults
      }

      let severity: "low" | "medium" | "high" | "critical" = "medium";
      let summary = "Investigation complete";
      let rootCause = "Unable to determine";
      let trigger = "Unknown";
      let confidence: "low" | "medium" | "high" = "low";
      let confidenceScore = 0.5;

      try {
        const parsed = JSON.parse(agentResult.text);
        severity = parsed.severity ?? severity;
        summary = parsed.summary ?? summary;
        rootCause = parsed.rootCause ?? rootCause;
        trigger = parsed.trigger ?? trigger;
        confidence = parsed.confidence ?? confidence;
        confidenceScore = parsed.confidenceScore ?? confidenceScore;
      } catch {
        // Keep defaults
      }

      // Deterministic severity validation
      const correctedSeverity = validateSeverity(
        { severity, summary, rootCause },
        metricsForTimeline,
        logsForTimeline,
        infraForTimeline,
      );
      if (correctedSeverity) severity = correctedSeverity;

      // TODO: Run quality eval when src/evals/investigation-quality.ts is created
      // try {
      //   const { runInvestigationQualityEval } = await import("../evals/investigation-quality.js");
      //   await runInvestigationQualityEval({ ... });
      // } catch { /* eval not yet available */ }

      return {
        severity,
        summary,
        rootCause,
        trigger,
        confidence,
        confidenceScore,
        timeline: timeline || undefined,
        evidenceSummary: {
          metrics: metricsFindings,
          logs: logsFindings,
          infra: infraFindings,
        },
        planningContext: {} as any, // populated from parallel context in a real wiring
      };
    },
  });
}

/**
 * Build a post-synthesis step that saves incident to history.
 */
function buildPostSynthesisStep(config: WorkflowConfig) {
  return createStep({
    id: "post-synthesis",
    description: "Save incident to history store and finalize report",
    inputSchema: SynthesisOutputSchema,
    outputSchema: PostSynthesisOutputSchema,
    execute: async ({ inputData }) => {
      const investigatedAt = new Date().toISOString();

      // Save to incident history if project root and service are configured
      let savedToHistory = false;
      const serviceName = config.services[0]?.name ?? "unknown";

      if (config.projectRoot && serviceName !== "unknown") {
        try {
          await saveIncident(config.projectRoot, {
            service: serviceName,
            severity: inputData.severity,
            summary: inputData.summary,
            rootCause: inputData.rootCause,
            trigger: inputData.trigger,
            confidence: inputData.confidence,
            investigatedAt,
          });
          savedToHistory = true;
        } catch {
          // Non-fatal — investigation can complete without saving
        }
      }

      return {
        severity: inputData.severity,
        summary: inputData.summary,
        rootCause: inputData.rootCause,
        trigger: inputData.trigger,
        confidence: inputData.confidence,
        confidenceScore: inputData.confidenceScore,
        savedToHistory,
        investigatedAt,
      };
    },
  });
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
