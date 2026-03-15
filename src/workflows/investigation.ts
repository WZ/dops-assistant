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
import {
  WorkflowInputSchema,
  PrefetchOutputSchema,
  AnomalyOutputSchema,
  PlanningOutputSchema,
  EvidenceOutputSchema,
  SynthesisOutputSchema,
  PostSynthesisOutputSchema,
} from "./schemas.js";
import type { MastraProvider } from "../mcp/provider.js";
import type { ServiceConfig } from "../config/schema.js";
import { getToolsByRole } from "../mcp/provider.js";
import { executePrefetch } from "./prefetch.js";
import { buildTimeline, validateSeverity } from "./helpers.js";
import { wrapToolsWithCallbacks, selectToolsBySuffix, debug, ANOMALY_TOOLS } from "./tool-utils.js";
import { getRecentIncidents, saveIncident, formatIncidentHistory } from "../history/store.js";
import { getTimeContext } from "../agents/shared/time-context.js";
import { safeJsonParse } from "../agents/shared/processors.js";
import { createAnomalyDetectorAgent } from "../agents/anomaly-detector.js";
import { createPlannerAgent } from "../agents/planner.js";
import { createSynthesisAgent } from "../agents/synthesis.js";
import { buildMetricsStep, buildLogsStep, buildInfraStep } from "./steps/evidence.js";
// Re-export so callers can import evidence step builders from either location
export { buildMetricsStep, buildLogsStep, buildInfraStep } from "./steps/evidence.js";

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
          serviceName: inputData.serviceName,
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

      // For user-reported issues, skip full anomaly detection (matches legacy behavior).
      // The user already told us what's wrong — just extract the time range and pass through.
      // Running the anomaly agent wastes iterations on broad unfocused queries.
      const isUserReported = !!inputData.userMessage?.trim();

      let isAnomaly = true;
      let severity: "low" | "medium" | "high" | "critical" = "high";
      let summary = inputData.userMessage;

      if (!isUserReported) {
        // Proactive mode: run anomaly detection agent
        const allTools = await getToolsByRole(config.providers, "metrics").catch(() => ({}));
        const rawTools = selectToolsBySuffix(allTools, ANOMALY_TOOLS);
        const tools = wrapToolsWithCallbacks(rawTools, config.onToolCall);

        const agent = createAnomalyDetectorAgent({
          model: config.model,
          tools,
          useQuirkHandling: config.useQuirkHandling,
        });

        const prompt = [
          getTimeContext(),
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
                    const payload = tr.payload ?? tr;
                    const toolName = payload.toolName ?? payload.name ?? tr.toolName ?? "unknown";
                    const nestedContent = payload.result?.content?.[0]?.text;
                    const rawResult = nestedContent ?? payload.result ?? tr.result ?? tr.output ?? "";
                    const resultStr = typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult);
                    const truncated = resultStr.length > 2000 ? resultStr.slice(0, 2000) + "..." : resultStr;
                    anomalyToolData.push(`Tool: ${toolName}\nResult: ${truncated}`);
                  }
                }
                if (step.text) anomalyToolData.push(`Model: ${step.text}`);
              } catch (err) {
                debug("ANOMALY onStepFinish error:", err);
              }
            },
          });
        } catch (err) {
          debug("ANOMALY agent.generate error:", err);
        }

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

        const anomalyParsed = safeJsonParse(textToParse);
        debug("ANOMALY parsed:", anomalyParsed ? "OK" : "FAILED");
        if (anomalyParsed) {
          isAnomaly = anomalyParsed.isAnomaly ?? true;
          severity = anomalyParsed.severity ?? "medium";
          summary = anomalyParsed.summary ?? inputData.userMessage;
        }
      } else {
        debug("ANOMALY: user-reported issue, skipping agent — extracting time range only");
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

      // Inject service config so the planner knows what metrics/logs are available
      const service = inputData.serviceName
        ? config.services.find((s) => s.name === inputData.serviceName)
        : undefined;
      const serviceMetricsHint = service?.metrics.length
        ? `Service metrics: ${service.metrics.map((m) => `${m.description} (${m.query})`).join(", ")}`
        : "";
      const serviceLogLabelsHint = service?.logLabels && Object.keys(service.logLabels).length > 0
        ? `Log labels: ${JSON.stringify(service.logLabels)}`
        : "";

      const prompt = [
        `Anomaly: ${inputData.summary}`,
        `Severity: ${inputData.severity ?? "unknown"}`,
        inputData.serviceName ? `Service: ${inputData.serviceName}` : "",
        serviceMetricsHint,
        serviceLogLabelsHint,
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

      // Emit plan details so the UI can display them (matches legacy behavior)
      if (hypotheses.length > 0) {
        const hypothesisText = hypotheses.map((h) => `${h.hypothesis} → ${h.evidenceNeeded}`).join(" | ");
        config.onIteration?.("planning", 0, 1, `Hypotheses: ${hypothesisText}`);
      }
      if (metricFocus.length > 0 || logFocus.length > 0 || infraFocus.length > 0) {
        const focusItems = [
          ...metricFocus.map((f) => `metric: ${f}`),
          ...logFocus.map((f) => `log: ${f}`),
          ...infraFocus.map((f) => `infra: ${f}`),
        ];
        config.onIteration?.("planning", 0, 1, `Focus: ${focusItems.join(", ")}`);
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
      let impact = { duration: "Unknown", description: "" };
      let rootCause = "Unable to determine";
      let trigger = "Unknown";
      let contributingFactors: string[] = [];
      let timelineEvents: Array<{ time: string; event: string }> = [];
      let evidence = { metrics: [] as string[], logs: [] as string[], infra: [] as string[] };
      let dashboardLinks: string[] = [];
      let recommendedActions: string[] = [];
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
          instructions: 'You are a root cause analysis summarizer. Given investigation evidence, produce a JSON summary. Return ONLY valid JSON: {"severity": "low"|"medium"|"high"|"critical", "summary": "string", "impact": {"duration": "string", "description": "string"}, "rootCause": "string", "trigger": "string", "contributingFactors": ["string"], "timeline": [{"time": "string", "event": "string"}], "evidence": {"metrics": ["string"], "logs": ["string"], "infra": ["string"]}, "dashboardLinks": ["string"], "recommendedActions": ["string"], "confidence": "low"|"medium"|"high", "confidenceScore": number}',
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
        if (synthesisParsed.impact) impact = synthesisParsed.impact;
        rootCause = synthesisParsed.rootCause ?? rootCause;
        trigger = synthesisParsed.trigger ?? trigger;
        contributingFactors = synthesisParsed.contributingFactors ?? contributingFactors;
        timelineEvents = synthesisParsed.timeline ?? timelineEvents;
        if (synthesisParsed.evidence) evidence = synthesisParsed.evidence;
        dashboardLinks = synthesisParsed.dashboardLinks ?? dashboardLinks;
        recommendedActions = synthesisParsed.recommendedActions ?? recommendedActions;
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

      return {
        severity,
        summary,
        impact,
        rootCause,
        trigger,
        contributingFactors,
        timeline: timelineEvents,
        evidence,
        dashboardLinks,
        recommendedActions,
        confidence,
        confidenceScore,
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
        impact: inputData.impact,
        rootCause: inputData.rootCause,
        trigger: inputData.trigger,
        contributingFactors: inputData.contributingFactors,
        timeline: inputData.timeline,
        evidence: inputData.evidence,
        dashboardLinks: inputData.dashboardLinks,
        recommendedActions: inputData.recommendedActions,
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
