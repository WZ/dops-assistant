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
import { safeJsonParse } from "../agents/shared/processors.js";
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
/**
 * Coerce tool arguments to match expected schema types.
 * LLMs often pass strings where arrays are expected (e.g., matches: "{...}" instead of ["{...}"]).
 */
function coerceToolArgs(args: Record<string, unknown>, toolSchema: any): Record<string, unknown> {
  if (!toolSchema?.properties) return args;
  const coerced = { ...args };
  for (const [key, value] of Object.entries(coerced)) {
    const prop = toolSchema.properties[key];
    if (prop?.type === "array" && typeof value === "string") {
      coerced[key] = [value]; // Wrap string in array
    } else if (prop?.type === "number" && typeof value === "string") {
      const num = Number(value);
      if (!isNaN(num)) coerced[key] = num;
    }
  }
  return coerced;
}

function wrapToolsWithCallbacks(
  tools: Record<string, any>,
  onToolCall?: WorkflowConfig["onToolCall"],
): Record<string, any> {
  const wrapped: Record<string, any> = {};
  for (const [name, tool] of Object.entries(tools)) {
    wrapped[name] = {
      ...tool,
      execute: async (...execArgs: any[]) => {
        // Coerce args to match schema (fixes LLM type mismatches)
        if (execArgs[0] && typeof execArgs[0] === "object" && tool.inputSchema) {
          execArgs[0] = coerceToolArgs(execArgs[0], tool.inputSchema);
        }
        const start = Date.now();
        try {
          const result = await tool.execute(...execArgs);
          const resultStr = typeof result === "string" ? result : JSON.stringify(result);
          onToolCall?.(name, execArgs[0] ?? {}, resultStr, Date.now() - start);
          return result;
        } catch (err) {
          onToolCall?.(name, execArgs[0] ?? {}, undefined, Date.now() - start, String(err));
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
  }).optional(),
  planningContext: PlanningOutputSchema.optional(),
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

// ── Debug logger ─────────────────────────────────────────────────────────────
const debug = (...args: unknown[]) => console.error("[INVESTIGATION DEBUG]", ...args);

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
      debug("PREFETCH step entered, keys:", Object.keys(inputData));
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
      debug("ANOMALY step entered, keys:", Object.keys(inputData));
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
      const anomalyToolData: string[] = [];
      let anomalyIterationCount = 0;
      try {
        agentResult = await agent.generate(prompt, {
          onStepFinish: (step: any) => {
            try {
              debug("ANOMALY onStepFinish, toolResults sample:", JSON.stringify(step.toolResults?.[0] ?? {}).slice(0, 300));
              anomalyIterationCount++;
              config.onIteration?.("anomaly", anomalyIterationCount, 10, `Step ${anomalyIterationCount}`);
              if (step.toolResults?.length) {
                for (const tr of step.toolResults) {
                  // Mastra wraps tool results: { payload: { toolName, args, result: { content: [{text}] } } }
                  const payload = tr.payload ?? tr;
                  const toolName = payload.toolName ?? payload.name ?? tr.toolName ?? "unknown";
                  const toolArgs = payload.args ?? payload.input ?? tr.args ?? {};
                  const nestedContent = payload.result?.content?.[0]?.text;
                  const rawResult = nestedContent ?? payload.result ?? tr.result ?? tr.output ?? "";
                  const resultStr = typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult);
                  const truncated = resultStr.length > 2000 ? resultStr.slice(0, 2000) + "..." : resultStr;
                  anomalyToolData.push(`Tool: ${toolName}\nResult: ${truncated}`);
                  config.onToolCall?.(toolName, toolArgs, resultStr, undefined);
                }
              }
              if (step.text) anomalyToolData.push(`Model: ${step.text}`);
            } catch (err) {
              debug("ANOMALY onStepFinish error:", err);
            }
          },
        });
      } catch {
        // Fall through to default
      }

      // If agent text is empty, do fresh-prompt extraction from captured tool results
      let textToParse = agentResult.text;
      if (!textToParse?.trim() && anomalyToolData.length > 0) {
        debug("ANOMALY: empty text, extracting from", anomalyToolData.length, "captured tool results");
        const { Agent: ExtractAgent } = await import("@mastra/core/agent");
        const extractor = new ExtractAgent({
          name: "anomaly-extractor",
          id: "anomaly-extractor",
          instructions: 'Extract structured data from investigation results. Return ONLY valid JSON: {"isAnomaly": boolean, "severity": "low"|"medium"|"high"|"critical", "summary": "string", "affectedServices": ["string"]}',
          model: config.model as any,
        });
        try {
          const extraction = await extractor.generate(anomalyToolData.join("\n\n"));
          textToParse = extraction.text ?? "";
        } catch { /* keep empty */ }
      }
      debug("ANOMALY text to parse (first 500):", textToParse?.slice(0, 500));

      let isAnomaly = true;
      let severity: "low" | "medium" | "high" | "critical" = "medium";
      let summary = inputData.userMessage;

      const anomalyParsed = safeJsonParse(textToParse);
      debug("ANOMALY parsed:", anomalyParsed ? "OK" : "FAILED");
      if (anomalyParsed) {
        isAnomaly = anomalyParsed.isAnomaly ?? true;
        severity = anomalyParsed.severity ?? "medium";
        summary = anomalyParsed.summary ?? inputData.userMessage;
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
      debug("PLANNING step entered, keys:", Object.keys(inputData));
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

      const plannerParsed = safeJsonParse(agentResult.text);
      if (plannerParsed) {
        hypotheses = plannerParsed.hypotheses ?? [];
        metricFocus = plannerParsed.metricFocus ?? [];
        logFocus = plannerParsed.logFocus ?? [];
        infraFocus = plannerParsed.infraFocus ?? [];
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
      debug("METRICS step entered, keys:", Object.keys(inputData));
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
      const metricsToolData: string[] = [];
      let metricsIterationCount = 0;
      try {
        agentResult = await agent.generate(prompt, {
          onStepFinish: (step: any) => {
            try {
              metricsIterationCount++;
              config.onIteration?.("metrics", metricsIterationCount, 10, `Step ${metricsIterationCount}`);
              if (step.toolResults?.length) {
                for (const tr of step.toolResults) {
                  // Mastra wraps tool results: { payload: { toolName, args, result: { content: [{text}] } } }
                  const payload = tr.payload ?? tr;
                  const toolName = payload.toolName ?? payload.name ?? tr.toolName ?? "unknown";
                  const toolArgs = payload.args ?? payload.input ?? tr.args ?? {};
                  const nestedContent = payload.result?.content?.[0]?.text;
                  const rawResult = nestedContent ?? payload.result ?? tr.result ?? tr.output ?? "";
                  const resultStr = typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult);
                  const truncated = resultStr.length > 2000 ? resultStr.slice(0, 2000) + "..." : resultStr;
                  metricsToolData.push(`Tool: ${toolName}\nResult: ${truncated}`);
                  config.onToolCall?.(toolName, toolArgs, resultStr, undefined);
                }
              }
              if (step.text) metricsToolData.push(`Model: ${step.text}`);
            } catch (err) {
              debug("METRICS onStepFinish error:", err);
            }
          },
        });
      } catch {
        // Fall through
      }

      let metricsText = agentResult.text;
      if (!metricsText?.trim() && metricsToolData.length > 0) {
        debug("METRICS: empty text, extracting from", metricsToolData.length, "captured tool results");
        const { Agent: ExtractAgent } = await import("@mastra/core/agent");
        const extractor = new ExtractAgent({
          name: "metrics-extractor",
          id: "metrics-extractor",
          instructions: 'Extract structured data from investigation results. Return ONLY valid JSON: {"summary": "string", "observations": [{"metric": "string", "currentValue": "string", "baselineValue": "string", "severity": "string"}]}',
          model: config.model as any,
        });
        try {
          const extraction = await extractor.generate(metricsToolData.join("\n\n"));
          metricsText = extraction.text ?? "";
        } catch { /* keep empty */ }
      }
      debug("METRICS text to parse (first 500):", metricsText?.slice(0, 500));
      const metricsParsed = safeJsonParse(metricsText);
      debug("METRICS parsed:", metricsParsed ? "OK" : "FAILED");
      if (metricsParsed) {
        return {
          summary: metricsParsed.summary ?? "Metrics analysis unavailable",
          observations: metricsParsed.observations ?? [],
          anomalyWindow: metricsParsed.anomalyWindow,
        };
      }
      return { summary: "Metrics analysis unavailable", observations: [] };
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
      debug("LOGS step entered, keys:", Object.keys(inputData));
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
      const logsToolData: string[] = [];
      let logsIterationCount = 0;
      try {
        agentResult = await agent.generate(prompt, {
          onStepFinish: (step: any) => {
            try {
              logsIterationCount++;
              config.onIteration?.("logs", logsIterationCount, 10, `Step ${logsIterationCount}`);
              if (step.toolResults?.length) {
                for (const tr of step.toolResults) {
                  // Mastra wraps tool results: { payload: { toolName, args, result: { content: [{text}] } } }
                  const payload = tr.payload ?? tr;
                  const toolName = payload.toolName ?? payload.name ?? tr.toolName ?? "unknown";
                  const toolArgs = payload.args ?? payload.input ?? tr.args ?? {};
                  const nestedContent = payload.result?.content?.[0]?.text;
                  const rawResult = nestedContent ?? payload.result ?? tr.result ?? tr.output ?? "";
                  const resultStr = typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult);
                  const truncated = resultStr.length > 2000 ? resultStr.slice(0, 2000) + "..." : resultStr;
                  logsToolData.push(`Tool: ${toolName}\nResult: ${truncated}`);
                  config.onToolCall?.(toolName, toolArgs, resultStr, undefined);
                }
              }
              if (step.text) logsToolData.push(`Model: ${step.text}`);
            } catch (err) {
              debug("LOGS onStepFinish error:", err);
            }
          },
        });
      } catch {
        // Fall through
      }

      let logsText = agentResult.text;
      if (!logsText?.trim() && logsToolData.length > 0) {
        debug("LOGS: empty text, extracting from", logsToolData.length, "captured tool results");
        const { Agent: ExtractAgent } = await import("@mastra/core/agent");
        const extractor = new ExtractAgent({
          name: "logs-extractor",
          id: "logs-extractor",
          instructions: 'Extract structured data from investigation results. Return ONLY valid JSON: {"summary": "string", "observations": [{"pattern": "string", "count": "number", "firstSeen": "string", "lastSeen": "string"}]}',
          model: config.model as any,
        });
        try {
          const extraction = await extractor.generate(logsToolData.join("\n\n"));
          logsText = extraction.text ?? "";
        } catch { /* keep empty */ }
      }
      debug("LOGS text to parse (first 500):", logsText?.slice(0, 500));
      const logsParsed = safeJsonParse(logsText);
      debug("LOGS parsed:", logsParsed ? "OK" : "FAILED");
      if (logsParsed) {
        return {
          summary: logsParsed.summary ?? "Log analysis unavailable",
          observations: logsParsed.observations ?? [],
        };
      }
      return { summary: "Log analysis unavailable", observations: [] };
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
      debug("INFRA step entered, keys:", Object.keys(inputData));
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
      const infraToolData: string[] = [];
      let infraIterationCount = 0;
      try {
        agentResult = await agent.generate(prompt, {
          onStepFinish: (step: any) => {
            try {
              infraIterationCount++;
              config.onIteration?.("infra", infraIterationCount, 10, `Step ${infraIterationCount}`);
              if (step.toolResults?.length) {
                for (const tr of step.toolResults) {
                  // Mastra wraps tool results: { payload: { toolName, args, result: { content: [{text}] } } }
                  const payload = tr.payload ?? tr;
                  const toolName = payload.toolName ?? payload.name ?? tr.toolName ?? "unknown";
                  const toolArgs = payload.args ?? payload.input ?? tr.args ?? {};
                  const nestedContent = payload.result?.content?.[0]?.text;
                  const rawResult = nestedContent ?? payload.result ?? tr.result ?? tr.output ?? "";
                  const resultStr = typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult);
                  const truncated = resultStr.length > 2000 ? resultStr.slice(0, 2000) + "..." : resultStr;
                  infraToolData.push(`Tool: ${toolName}\nResult: ${truncated}`);
                  config.onToolCall?.(toolName, toolArgs, resultStr, undefined);
                }
              }
              if (step.text) infraToolData.push(`Model: ${step.text}`);
            } catch (err) {
              debug("INFRA onStepFinish error:", err);
            }
          },
        });
      } catch {
        // Fall through
      }

      let infraText = agentResult.text;
      if (!infraText?.trim() && infraToolData.length > 0) {
        debug("INFRA: empty text, extracting from", infraToolData.length, "captured tool results");
        const { Agent: ExtractAgent } = await import("@mastra/core/agent");
        const extractor = new ExtractAgent({
          name: "infra-extractor",
          id: "infra-extractor",
          instructions: 'Extract structured data from investigation results. Return ONLY valid JSON: {"summary": "string", "observations": [{"resource": "string", "status": "string", "detail": "string"}]}',
          model: config.model as any,
        });
        try {
          const extraction = await extractor.generate(infraToolData.join("\n\n"));
          infraText = extraction.text ?? "";
        } catch { /* keep empty */ }
      }
      const infraParsed = safeJsonParse(infraText);
      if (infraParsed) {
        return {
          summary: infraParsed.summary ?? "Infrastructure analysis unavailable",
          observations: infraParsed.observations ?? [],
        };
      }
      return { summary: "Infrastructure analysis unavailable", observations: [] };
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
      debug("SYNTHESIS step entered, keys:", Object.keys(inputData));
      debug("SYNTHESIS inputData:", JSON.stringify(inputData).slice(0, 500));
      const metricsFindings = inputData["metrics-evidence"];
      const logsFindings = inputData["logs-evidence"];
      const infraFindings = inputData["infra-evidence"];
      debug("SYNTHESIS findings:", { metrics: !!metricsFindings, logs: !!logsFindings, infra: !!infraFindings });

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

      let synthesisText = agentResult.text;
      if (!synthesisText?.trim()) {
        // Synthesis agent has no tools so agentResult.text should normally be populated.
        // As a fallback, re-prompt with the same content using a fresh extractor agent.
        debug("SYNTHESIS: empty text, re-prompting with extractor agent");
        const { Agent: ExtractAgent } = await import("@mastra/core/agent");
        const extractor = new ExtractAgent({
          name: "synthesis-extractor",
          id: "synthesis-extractor",
          instructions: 'You are a root cause analysis summarizer. Given investigation evidence, produce a JSON summary. Return ONLY valid JSON: {"severity": "low"|"medium"|"high"|"critical", "summary": "string", "rootCause": "string", "trigger": "string", "confidence": "low"|"medium"|"high", "confidenceScore": number}',
          model: config.model as any,
        });
        try {
          const extraction = await extractor.generate(prompt);
          synthesisText = extraction.text ?? "";
        } catch { /* keep empty */ }
      }
      const synthesisParsed = safeJsonParse(synthesisText);
      if (synthesisParsed) {
        severity = synthesisParsed.severity ?? severity;
        summary = synthesisParsed.summary ?? summary;
        rootCause = synthesisParsed.rootCause ?? rootCause;
        trigger = synthesisParsed.trigger ?? trigger;
        confidence = synthesisParsed.confidence ?? confidence;
        confidenceScore = synthesisParsed.confidenceScore ?? confidenceScore;
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
