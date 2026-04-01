/**
 * Shared evidence step builder for the investigation workflow.
 *
 * All three evidence phases (metrics, logs, infra) follow the same pattern:
 *   1. Get tools by role → wrap with callbacks
 *   2. Create specialized agent
 *   3. Build prompt from anomaly context
 *   4. Run agent.generate() with onStepFinish to collect tool data
 *   5. If agent text is empty, create fallback extractor agent
 *   6. Parse JSON with safeJsonParse
 *   7. Return findings or empty fallback
 *
 * The only differences per phase are captured in EvidenceStepConfig.
 */

import { createStep } from "@mastra/core/workflows";
import type { WorkflowConfig } from "../investigation.js";
import { getToolsByRole } from "../../mcp/provider.js";
import { TOOL_RESULT_TRUNCATION_LIMIT } from "../../constants.js";
import type { ProviderRole } from "../../config/schema.js";
import {
  wrapToolsWithCallbacks,
  buildTimeWindowHint,
  buildServiceContextHint,
  debug,
} from "../tool-utils.js";
import { PlanningOutputSchema, EvidenceOutputSchema } from "../schemas.js";
import { safeJsonParse } from "../../agents/shared/processors.js";
import { createMetricsAgent } from "../../agents/metrics.js";
import { createLogsAgent } from "../../agents/logs.js";
import { createInfraAgent } from "../../agents/infra.js";
import { createChangesAgent } from "../../agents/changes.js";

// ── EvidenceStepConfig ────────────────────────────────────────────────────────

interface EvidenceStepConfig {
  /** Mastra step ID, e.g. "metrics-evidence" */
  id: string;
  /** Human-readable phase name used in onIteration callbacks, e.g. "metrics" */
  phaseName: string;
  /** Iteration number emitted at the start of this step (2=metrics, 3=logs, 4=infra) */
  iterationStart: number;
  /** MCP provider role(s) to fetch tools from. Array merges tools from multiple roles. */
  toolRole: ProviderRole | ProviderRole[];
  // toolAllowlist removed — agents now get all tools for their role (provider-agnostic)
  /** Factory that creates the specialized agent for this phase */
  createAgent: (opts: { model: any; tools: Record<string, any>; useQuirkHandling?: boolean }) => any;
  /** Build the prompt string from the planning step's inputData */
  buildPrompt: (inputData: any, config: WorkflowConfig) => string;
  /** JSON schema hint for the fallback extractor agent instructions */
  extractorSchema: string;
  /** Summary string to use when analysis is unavailable */
  fallbackMessage: string;
}

// ── Shared factory ────────────────────────────────────────────────────────────

/**
 * Create a Mastra evidence step from a config object.
 * Contains all the boilerplate shared across metrics/logs/infra steps.
 */
function buildEvidenceStep(workflowConfig: WorkflowConfig, stepConfig: EvidenceStepConfig) {
  const {
    id,
    phaseName,
    iterationStart,
    toolRole,
    createAgent,
    buildPrompt,
    extractorSchema,
    fallbackMessage,
  } = stepConfig;

  return createStep({
    id,
    description: `Evidence gathering phase: ${phaseName}`,
    inputSchema: PlanningOutputSchema,
    outputSchema: EvidenceOutputSchema,
    execute: async ({ inputData }) => {
      debug(`${phaseName.toUpperCase()} step entered, keys:`, Object.keys(inputData));
      workflowConfig.onPhase?.("Analyzing metrics, logs & infrastructure");
      workflowConfig.onIteration?.(phaseName, iterationStart, 6, `Analyzing ${phaseName}`);

      // 1. Get all tools for this role → wrap with callbacks (provider-agnostic)
      const roles = Array.isArray(toolRole) ? toolRole : [toolRole];
      const toolMaps = await Promise.all(roles.map(r => getToolsByRole(workflowConfig.providers, r).catch(() => ({}))));
      const rawTools: Record<string, any> = {};
      for (const m of toolMaps) Object.assign(rawTools, m);
      debug(`${phaseName.toUpperCase()} tools:`, Object.keys(rawTools));
      const tools = wrapToolsWithCallbacks(rawTools, workflowConfig.onToolCall, phaseName);

      // 2. Create specialized agent
      const agent = createAgent({
        model: workflowConfig.model,
        tools,
        useQuirkHandling: workflowConfig.useQuirkHandling,
      });

      // 3. Build prompt
      const prompt = buildPrompt(inputData, workflowConfig);

      // 4. Run agent.generate() with onStepFinish to collect tool data
      let agentResult: { text: string } = { text: "" };
      const toolData: string[] = [];
      let iterationCount = 0;
      try {
        agentResult = await agent.generate(prompt, {
          onStepFinish: (step: any) => {
            try {
              iterationCount++;
              workflowConfig.onIteration?.(phaseName, iterationCount, 10, `Step ${iterationCount}`);
              if (step.toolResults?.length) {
                for (const tr of step.toolResults) {
                  // Mastra wraps tool results: { payload: { toolName, args, result: { content: [{text}] } } }
                  const payload = tr.payload ?? tr;
                  const toolName = payload.toolName ?? payload.name ?? tr.toolName ?? "unknown";
                  const nestedContent = payload.result?.content?.[0]?.text;
                  const rawResult = nestedContent ?? payload.result ?? tr.result ?? tr.output ?? "";
                  const resultStr = typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult);
                  const truncated = resultStr.length > TOOL_RESULT_TRUNCATION_LIMIT ? resultStr.slice(0, TOOL_RESULT_TRUNCATION_LIMIT) + "..." : resultStr;
                  toolData.push(`Tool: ${toolName}\nResult: ${truncated}`);
                  // Tool call already emitted by wrapToolsWithCallbacks — don't double-emit
                }
              }
              if (step.text) toolData.push(`Model: ${step.text}`);
              // Emit token usage if available
              if (step.usage && workflowConfig.onTokenUsage) {
                workflowConfig.onTokenUsage({
                  inputTokens: step.usage.inputTokens ?? 0,
                  outputTokens: step.usage.outputTokens ?? 0,
                });
              }
            } catch (err) {
              debug(`${phaseName.toUpperCase()} onStepFinish error:`, err);
            }
          },
        });
      } catch (err) {
        debug(`${phaseName.toUpperCase()} agent.generate error:`, err);
      }

      // 5. If agent text is empty, create fallback extractor agent
      let agentText = agentResult.text;
      if (!agentText?.trim() && toolData.length > 0) {
        debug(`${phaseName.toUpperCase()}: empty text, extracting from`, toolData.length, "captured tool results");
        const { Agent: ExtractAgent } = await import("@mastra/core/agent");
        const extractor = new ExtractAgent({
          name: `${phaseName}-extractor`,
          id: `${phaseName}-extractor`,
          instructions: `Extract structured data from investigation results. Return ONLY valid JSON: ${extractorSchema}`,
          model: workflowConfig.model as any,
        });
        try {
          const extraction = await extractor.generate(toolData.join("\n\n"));
          agentText = extraction.text ?? "";
        } catch { /* keep empty */ }
      }

      // 6. Parse JSON with safeJsonParse
      debug(`${phaseName.toUpperCase()} text to parse (first 500):`, agentText?.slice(0, 500));
      const parsed = safeJsonParse(agentText);
      debug(`${phaseName.toUpperCase()} parsed:`, parsed ? "OK" : "FAILED");

      // 7. Build timeRange pass-through from anomaly context
      const ac = inputData.anomalyContext;
      const timeRange = ac?.timeRangeFrom && ac?.timeRangeTo
        ? { from: ac.timeRangeFrom, to: ac.timeRangeTo }
        : undefined;

      // 8. Return findings or empty fallback
      if (parsed) {
        return {
          summary: parsed.summary ?? fallbackMessage,
          observations: parsed.observations ?? [],
          timeRange,
        };
      }
      return { summary: fallbackMessage, observations: [], timeRange };
    },
  });
}

// ── Specific step builders ────────────────────────────────────────────────────

/**
 * Build a metrics evidence step.
 * Exported for testing.
 */
export function buildMetricsStep(config: WorkflowConfig) {
  return buildEvidenceStep(config, {
    id: "metrics-evidence",
    phaseName: "metrics",
    iterationStart: 2,
    toolRole: "metrics",
    createAgent: createMetricsAgent,
    buildPrompt: (inputData, workflowConfig) => {
      const { anomalyContext } = inputData;
      const resolvedRange = anomalyContext.timeRangeFrom && anomalyContext.timeRangeTo ? { from: anomalyContext.timeRangeFrom, to: anomalyContext.timeRangeTo } : undefined;
      const timeWindowHint = buildTimeWindowHint(anomalyContext.summary, anomalyContext.userMessage, resolvedRange);
      const { metricsHint } = buildServiceContextHint(workflowConfig.services, anomalyContext.serviceName);

      return [
        anomalyContext.prefetchContext.datasourceHints,
        timeWindowHint,
        anomalyContext.prefetchContext.panelQueryHints,
        metricsHint,
        `Known issue: ${anomalyContext.userMessage}`,
        anomalyContext.serviceName ? `Service: ${anomalyContext.serviceName}` : "",
        anomalyContext.skillContext
          ? `${anomalyContext.skillContext}\nFollow the investigation steps from matched skills when they're relevant to your current evidence-gathering focus.`
          : "",
        inputData.metricFocus?.length
          ? `Focus areas: ${inputData.metricFocus.join(", ")}`
          : "",
      ].filter(Boolean).join("\n");
    },
    extractorSchema: '{"summary": "string", "observations": [{"metric": "string", "currentValue": "string", "baselineValue": "string", "severity": "string"}]}',
    fallbackMessage: "Metrics analysis unavailable",
  });
}

/**
 * Build a logs evidence step.
 * Exported for testing.
 */
export function buildLogsStep(config: WorkflowConfig) {
  return buildEvidenceStep(config, {
    id: "logs-evidence",
    phaseName: "logs",
    iterationStart: 3,
    toolRole: "logs",
    createAgent: createLogsAgent,
    buildPrompt: (inputData, workflowConfig) => {
      const { anomalyContext } = inputData;
      const { prefetchContext } = anomalyContext;
      const resolvedRange = anomalyContext.timeRangeFrom && anomalyContext.timeRangeTo ? { from: anomalyContext.timeRangeFrom, to: anomalyContext.timeRangeTo } : undefined;
      const timeWindowHint = buildTimeWindowHint(anomalyContext.summary, anomalyContext.userMessage, resolvedRange);
      const { logLabelsHint } = buildServiceContextHint(workflowConfig.services, anomalyContext.serviceName);
      const selectorHint = prefetchContext.workingLogSelectors.length > 0
        ? `VALIDATED LOG SELECTOR (pre-tested, returns real logs — use this as your primary selector):\n  ${prefetchContext.workingLogSelectors[0]}\nThe configured logLabels may NOT return results. Use the validated selector above as your FIRST query.`
        : "";

      return [
        prefetchContext.datasourceHints,
        timeWindowHint,
        prefetchContext.logLabelHints,
        logLabelsHint,
        selectorHint,
        `Known issue: ${anomalyContext.userMessage}`,
        anomalyContext.serviceName ? `Service: ${anomalyContext.serviceName}` : "",
        anomalyContext.skillContext
          ? `${anomalyContext.skillContext}\nFollow the investigation steps from matched skills when they're relevant to your current evidence-gathering focus.`
          : "",
        inputData.logFocus?.length
          ? `Focus areas: ${inputData.logFocus.join(", ")}`
          : "",
      ].filter(Boolean).join("\n");
    },
    extractorSchema: '{"summary": "string", "observations": [{"pattern": "string", "count": "string", "firstSeen": "string", "lastSeen": "string", "sample": "string", "sampleLines": ["string"]}]}',
    fallbackMessage: "Log analysis unavailable",
  });
}

/**
 * Build an infra evidence step.
 * Exported for testing.
 */
export function buildInfraStep(config: WorkflowConfig) {
  return buildEvidenceStep(config, {
    id: "infra-evidence",
    phaseName: "infra",
    iterationStart: 4,
    toolRole: "infrastructure",
    createAgent: createInfraAgent,
    buildPrompt: (inputData, workflowConfig) => {
      const { anomalyContext } = inputData;
      const resolvedRange = anomalyContext.timeRangeFrom && anomalyContext.timeRangeTo ? { from: anomalyContext.timeRangeFrom, to: anomalyContext.timeRangeTo } : undefined;
      const timeWindowHint = buildTimeWindowHint(anomalyContext.summary, anomalyContext.userMessage, resolvedRange);

      return [
        anomalyContext.prefetchContext.datasourceHints,
        timeWindowHint,
        anomalyContext.prefetchContext.panelQueryHints,
        `Known issue: ${anomalyContext.userMessage}`,
        anomalyContext.serviceName ? `Service: ${anomalyContext.serviceName}` : "",
        anomalyContext.skillContext
          ? `${anomalyContext.skillContext}\nFollow the investigation steps from matched skills when they're relevant to your current evidence-gathering focus.`
          : "",
        inputData.infraFocus?.length
          ? `Focus areas: ${inputData.infraFocus.join(", ")}`
          : "",
      ].filter(Boolean).join("\n");
    },
    extractorSchema: '{"summary": "string", "observations": [{"resource": "string", "status": "string", "detail": "string"}]}',
    fallbackMessage: "Infrastructure analysis unavailable",
  });
}

/**
 * Build a changes evidence step (GitLab MCP).
 * Runs in parallel with metrics/logs/infra to correlate code changes with the incident.
 * Gracefully returns empty if no "changes" provider is configured.
 */
export function buildChangesStep(config: WorkflowConfig) {
  return buildEvidenceStep(config, {
    id: "changes-evidence",
    phaseName: "changes",
    iterationStart: 5,
    toolRole: "changes",
    createAgent: createChangesAgent,
    buildPrompt: (inputData, workflowConfig) => {
      const { anomalyContext } = inputData;
      const resolvedRange = anomalyContext.timeRangeFrom && anomalyContext.timeRangeTo ? { from: anomalyContext.timeRangeFrom, to: anomalyContext.timeRangeTo } : undefined;
      const timeWindowHint = buildTimeWindowHint(anomalyContext.summary, anomalyContext.userMessage, resolvedRange);

      return [
        timeWindowHint,
        `Known issue: ${anomalyContext.userMessage}`,
        anomalyContext.serviceName ? `Service: ${anomalyContext.serviceName}` : "",
        "Search for recent deployments, merge requests, and pipeline runs related to this service.",
        "Focus on changes that happened within 6 hours before the incident started.",
        anomalyContext.skillContext
          ? `${anomalyContext.skillContext}\nFollow the investigation steps from matched skills when they're relevant to your current evidence-gathering focus.`
          : "",
      ].filter(Boolean).join("\n");
    },
    extractorSchema: '{"summary": "string", "observations": [{"type": "string", "title": "string", "timestamp": "string", "author": "string", "detail": "string"}]}',
    fallbackMessage: "Change analysis unavailable",
  });
}
