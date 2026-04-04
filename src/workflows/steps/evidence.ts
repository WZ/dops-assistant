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
import { getToolsByRole, filterToReadOnlyTools } from "../../mcp/provider.js";
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
import { wrapUntrusted } from "../../agents/shared/prompt-helpers.js";

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
      let rawTools: Record<string, any> = {};
      for (const m of toolMaps) Object.assign(rawTools, m);

      // Security: headless investigations (webhook/poller) are locked to read-only tools
      if (workflowConfig.readOnlyTools) {
        rawTools = filterToReadOnlyTools(rawTools);
        debug(`${phaseName.toUpperCase()} readOnlyTools enforced, filtered to:`, Object.keys(rawTools));
      }
      debug(`${phaseName.toUpperCase()} tools:`, Object.keys(rawTools));

      // Early exit: if no tools are available for this role, skip the agent entirely.
      // Running an LLM with zero tools produces empty results silently.
      if (Object.keys(rawTools).length === 0) {
        const roleStr = Array.isArray(toolRole) ? toolRole.join('" or "') : toolRole;
        const noToolsMsg = `No MCP tools available for ${phaseName} role — skipping. Configure a provider with role "${roleStr}" to enable.`;
        console.error(`[EVIDENCE] ${noToolsMsg}`);
        const ac = inputData.anomalyContext;
        const timeRange = ac?.timeRangeFrom && ac?.timeRangeTo
          ? { from: ac.timeRangeFrom, to: ac.timeRangeTo }
          : undefined;
        return { summary: noToolsMsg, observations: [], timeRange };
      }

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

      // 6b. If agent text has no useful structured data, run extractor.
      // This covers two cases:
      //   a) safeJsonParse returned null (text isn't JSON at all)
      //   b) safeJsonParse matched a {…} span but observations is empty — common
      //      when the agent mixes natural language with JSON fragments and
      //      safeJsonParse grabs a wide span that parses but lacks real content
      const parsedIsEmpty = parsed && (!parsed.observations || parsed.observations.length === 0);
      if ((!parsed || parsedIsEmpty) && agentText?.trim() && agentText.length > 50) {
        debug(`${phaseName.toUpperCase()}: non-JSON text (${agentText.length} chars), re-extracting`);
        const { Agent: ExtractAgent } = await import("@mastra/core/agent");
        const extractor = new ExtractAgent({
          name: `${phaseName}-extractor`,
          id: `${phaseName}-extractor`,
          instructions: `Convert this investigation analysis into structured JSON. Return ONLY valid JSON matching this schema: ${extractorSchema}`,
          model: workflowConfig.model as any,
        });
        try {
          const extraction = await extractor.generate(agentText.slice(0, 8000));
          const reParsed = safeJsonParse(extraction.text ?? "");
          if (reParsed) {
            debug(`${phaseName.toUpperCase()}: re-extraction succeeded`);
            const ac = inputData.anomalyContext;
            const timeRange = ac?.timeRangeFrom && ac?.timeRangeTo
              ? { from: ac.timeRangeFrom, to: ac.timeRangeTo }
              : undefined;
            return {
              summary: reParsed.summary ?? fallbackMessage,
              observations: reParsed.observations ?? [],
              timeRange,
            };
          }
        } catch { /* fall through */ }
      }

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

      // 9. Fallback: use agent text or raw tool data as summary so synthesis
      // can still work with real evidence instead of "unavailable".
      if (agentText?.trim()) {
        // Agent produced natural language analysis — use it as the summary
        debug(`${phaseName.toUpperCase()}: using agent text as summary (${agentText.length} chars)`);
        return { summary: agentText.slice(0, 3000), observations: [], timeRange };
      }
      if (toolData.length > 0) {
        const toolSummary = toolData
          .filter((d) => d.startsWith("Tool:"))
          .map((d) => d.slice(0, 500))
          .join("\n---\n")
          .slice(0, 3000);
        debug(`${phaseName.toUpperCase()}: forwarding ${toolData.length} raw tool results as summary`);
        return { summary: `${phaseName} tools returned data but structured extraction failed. Raw results:\n${toolSummary}`, observations: [], timeRange };
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
        wrapUntrusted("datasource_hints", anomalyContext.prefetchContext.datasourceHints),
        timeWindowHint,
        wrapUntrusted("panel_query_hints", anomalyContext.prefetchContext.panelQueryHints),
        metricsHint,
        `Known issue: ${wrapUntrusted("user_message", anomalyContext.userMessage)}`,
        anomalyContext.serviceName ? `Service: ${wrapUntrusted("service", anomalyContext.serviceName)}` : "",
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

      // Extract incident keywords from user message and logFocus for targeted log searching
      const incidentKeywords = extractIncidentKeywords(anomalyContext.userMessage, inputData.logFocus);
      const keywordsHint = incidentKeywords.length > 0
        ? `INCIDENT KEYWORDS (search for these as Loki line filters BEFORE generic error patterns):\n  ${incidentKeywords.join(", ")}\nThese are your highest-priority search terms. Use them with |= "keyword" in your first queries.`
        : "";

      // Pre-build LogQL queries so the model doesn't have to construct the syntax
      const baseSelector = prefetchContext.workingLogSelectors[0] || "";
      const prebuiltQueries = baseSelector && incidentKeywords.length > 0
        ? buildPrebuiltLogQueries(baseSelector, incidentKeywords)
        : "";

      return [
        wrapUntrusted("datasource_hints", prefetchContext.datasourceHints),
        timeWindowHint,
        wrapUntrusted("log_label_hints", prefetchContext.logLabelHints),
        logLabelsHint,
        selectorHint,
        prebuiltQueries,
        keywordsHint,
        `Known issue: ${wrapUntrusted("user_message", anomalyContext.userMessage)}`,
        anomalyContext.serviceName ? `Service: ${wrapUntrusted("service", anomalyContext.serviceName)}` : "",
        anomalyContext.skillContext
          ? `${anomalyContext.skillContext}\nFollow the investigation steps from matched skills when they're relevant to your current evidence-gathering focus.`
          : "",
        inputData.logFocus?.length
          ? `Focus areas from investigation plan:\n  ${inputData.logFocus.join("\n  ")}`
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

      // Resolve namespace from ServiceConfig for K8s resource queries
      const svcConfig = anomalyContext.serviceName
        ? workflowConfig.services.find(s => s.name === anomalyContext.serviceName)
        : undefined;
      const namespace = (svcConfig?.logLabels as Record<string, string> | undefined)?.namespace;

      return [
        wrapUntrusted("datasource_hints", anomalyContext.prefetchContext.datasourceHints),
        timeWindowHint,
        wrapUntrusted("panel_query_hints", anomalyContext.prefetchContext.panelQueryHints),
        `Known issue: ${wrapUntrusted("user_message", anomalyContext.userMessage)}`,
        anomalyContext.serviceName ? `Service: ${wrapUntrusted("service", anomalyContext.serviceName)}` : "",
        namespace ? `Kubernetes namespace: ${namespace}` : "",
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
        `Known issue: ${wrapUntrusted("user_message", anomalyContext.userMessage)}`,
        anomalyContext.serviceName ? `Service: ${wrapUntrusted("service", anomalyContext.serviceName)}` : "",
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

// ── Pre-built LogQL queries ──────────────────────────────────────────────────

/** Escape a string for safe interpolation inside LogQL double-quoted strings. */
function escapeLogQL(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Build ready-to-use LogQL queries from the validated selector and incident keywords.
 * Provides exact queries the model can copy-paste, avoiding the model constructing
 * wrong syntax or using bad parameters like direction:"forward" and limit:20.
 */
function buildPrebuiltLogQueries(selector: string, keywords: string[]): string {
  // Pick up to 3 most specific keywords (skip very short ones, escape for LogQL)
  const topKeywords = keywords
    .filter((k) => k.length >= 3 && !k.includes(" "))
    .slice(0, 3);

  const queries: string[] = [];

  // Query 1: keyword-filtered (most targeted)
  if (topKeywords.length > 0) {
    const filter = topKeywords.map((k) => `|= "${escapeLogQL(k)}"`).join(" ");
    queries.push(`Query 1 (keyword): ${selector} ${filter}`);
  }

  // Query 2: error-level entries
  queries.push(`Query 2 (errors):  ${selector} |~ "(?i)(error|exception|fail)"`);

  // Query 3: all logs (no filter, for context around errors)
  queries.push(`Query 3 (context): ${selector}`);

  return [
    "PRE-BUILT LOG QUERIES (use these logql values in order, with limit=50 and direction=backward):",
    ...queries.map((q) => `  ${q}`),
    "Run Query 1 first. If it returns results with errors, run Query 3 with a narrow ±60s time window around the errors for full context.",
  ].join("\n");
}

// ── Keyword extraction ───────────────────────────────────────────────────────

/** Stop words to filter out when extracting incident keywords from user messages. */
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "was", "were", "are", "been", "be", "have", "has",
  "had", "do", "does", "did", "will", "would", "could", "should", "may",
  "might", "shall", "can", "need", "must", "it", "its", "of", "in", "on",
  "at", "to", "for", "with", "from", "by", "about", "into", "through",
  "and", "or", "but", "not", "no", "if", "then", "than", "that", "this",
  "there", "here", "what", "when", "where", "how", "why", "which", "who",
  "all", "each", "every", "both", "few", "more", "most", "some", "any",
  "up", "out", "so", "just", "also", "very", "too", "quite", "rather",
  "around", "please", "check", "look", "see", "investigate", "service",
]);

/**
 * Extract incident-specific keywords from the user message and logFocus.
 * Filters out common stop words and short tokens, returning terms likely
 * to be useful as Loki line filters.
 */
function extractIncidentKeywords(userMessage: string, logFocus?: string[]): string[] {
  const keywords = new Set<string>();

  // Extract from user message: split on whitespace/punctuation, keep meaningful tokens
  const messageTokens = userMessage
    .replace(/['"`,.:;!?()[\]{}]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t.toLowerCase()) && !/^\d+$/.test(t));
  for (const token of messageTokens) keywords.add(token);

  // Add logFocus items directly (these are already curated by the planner)
  if (logFocus) {
    for (const focus of logFocus) keywords.add(focus);
  }

  return [...keywords].slice(0, 10);
}
