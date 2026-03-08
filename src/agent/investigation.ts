import type { LlmClient, Message, ResponseFormat, TokenUsage } from "../llm/openai.js";
import type { McpClient, PanelImage } from "../mcp/client.js";
import type { ServiceConfig } from "../config/schema.js";
import type { AnomalyAssessment } from "./types.js";
import type { MetricFindings, LogFindings, InfraFindings, RcaReport, InvestigationPlan, ReflectionResult } from "./rca-types.js";
import {
  buildMetricDeepDivePrompt,
  buildLogCorrelationPrompt,
  buildInfraHealthPrompt,
  RCA_SYNTHESIS_PROMPT,
  INVESTIGATION_PLAN_PROMPT,
  RCA_REFLECTION_PROMPT,
  METRIC_FINDINGS_SCHEMA,
  LOG_FINDINGS_SCHEMA,
  INFRA_FINDINGS_SCHEMA,
  RCA_REPORT_SCHEMA,
  INVESTIGATION_PLAN_SCHEMA,
  RCA_REFLECTION_SCHEMA,
} from "./rca-prompts.js";
import { buildProactiveStructuredPrompt, ANOMALY_ASSESSMENT_RESPONSE_FORMAT, getTimeContext } from "./prompts.js";
import pino from "pino";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

const MAX_TOOL_RESPONSE_CHARS = 1500;
const MAX_QUERY_TOOL_RESPONSE_CHARS = 12000;
const MAX_TOOL_CALLS_PER_ITERATION = 3;

/**
 * Truncate oversized tool responses to prevent context bloat.
 * Applies tool-specific extraction for known verbose tools before
 * falling back to generic character-limit truncation.
 */
function truncateToolResponse(text: string, toolName: string): string {
  // Tool-specific extraction — return only what the LLM needs
  if (toolName === "get_dashboard_by_uid") {
    try {
      const data = JSON.parse(text);
      const panels = (data.dashboard?.panels ?? data.panels ?? []) as Array<{
        id: number; title: string; type: string;
      }>;
      return JSON.stringify({
        title: data.dashboard?.title ?? data.title,
        uid: data.dashboard?.uid ?? data.meta?.slug,
        panels: panels.map((p) => ({ id: p.id, title: p.title, type: p.type })),
      });
    } catch { /* fall through */ }
  }

  if (toolName === "search_dashboards") {
    try {
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed) ? parsed : parsed?.dashboards ?? [];
      // Only uid + title, cap at 20 dashboards
      return JSON.stringify(
        (list as Array<{ uid: string; title: string }>).slice(0, 20).map((d) => ({ uid: d.uid, title: d.title })),
      );
    } catch { /* fall through */ }
  }

  // Compact Prometheus responses: extract metric name + value pairs, drop verbose labels
  if (toolName === "query_prometheus") {
    try {
      const parsed = JSON.parse(text);
      const results = parsed?.data ?? [];
      if (Array.isArray(results) && results.length > 0) {
        const compact = results.slice(0, 30).map((r: { metric: Record<string, string>; value?: [number, string]; values?: Array<[number, string]> }) => {
          const { __name__, job, instance, ...rest } = r.metric;
          const key = __name__ ?? Object.values(rest).join("/") ?? "unknown";
          if (r.value) {
            return { m: key, instance, v: r.value[1], t: r.value[0] };
          }
          if (r.values) {
            // Range query: preserve sampled data points so the LLM can see the shape.
            // Downsample to ~50 points max to fit in context while keeping trend visible.
            const vals = r.values;
            const step = Math.max(1, Math.floor(vals.length / 50));
            const sampled = vals.filter((_, i) => i % step === 0 || i === vals.length - 1);
            let min = Infinity, max = -Infinity, sum = 0;
            for (const [, v] of vals) {
              const n = parseFloat(v);
              if (n < min) min = n;
              if (n > max) max = n;
              sum += n;
            }
            return {
              m: key, instance,
              min: min.toFixed(0),
              max: max.toFixed(0),
              avg: (sum / vals.length).toFixed(0),
              points: vals.length,
              // Include actual [timestamp, value] pairs so LLM sees level changes
              values: sampled.map(([ts, v]) => [new Date(ts * 1000).toISOString(), parseFloat(v).toFixed(0)]),
            };
          }
          return { m: key, raw: r };
        });
        const compactJson = JSON.stringify({ data: compact, hints: parsed.hints });
        if (compactJson.length < text.length) return compactJson;
      }
    } catch { /* fall through */ }
  }

  // Compact Loki log responses: drop verbose labels, keep timestamp + line + level
  if (toolName === "query_loki_logs") {
    try {
      const parsed = JSON.parse(text);
      const data = parsed?.data ?? [];
      if (Array.isArray(data) && data.length > 0) {
        const compact = data
          .map((entry: { timestamp?: string; line?: string; labels?: Record<string, string> }) => {
            const line = (entry.line ?? "").trim().slice(0, 300);
            if (!line) return null;
            const level = entry.labels?.level ?? entry.labels?.severity ?? entry.labels?.loglevel;
            return {
              line,
              ...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
              ...(level ? { level } : {}),
            };
          })
          .filter((e): e is { line: string; timestamp?: string; level?: string } => e !== null);
        const compactJson = JSON.stringify({ data: compact, totalEntries: data.length });
        if (compactJson.length < text.length) return compactJson;
      }
    } catch { /* fall through */ }
  }

  // Query tools get a higher truncation limit — their data is the core evidence
  const queryTools = new Set(["query_prometheus", "query_loki_logs", "get_dashboard_panel_queries"]);
  const limit = queryTools.has(toolName) ? MAX_QUERY_TOOL_RESPONSE_CHARS : MAX_TOOL_RESPONSE_CHARS;
  if (text.length <= limit) return text;

  logger.debug({ toolName, originalLen: text.length, truncatedTo: limit }, "Truncating tool response");
  return text.slice(0, limit) + `\n... [truncated, ${text.length - limit} chars omitted]`;
}

export type PhaseResult<T> = {
  parsed: T;
  images: PanelImage[];
  toolData: string[];  // Raw tool response texts from the phase
};

/**
 * Extract dashboard and panel name hints from the user message and anomaly summary.
 * Looks for patterns like "(Panel Name in Dashboard Name)" or just quoted names.
 */
export function extractDashboardPanelHints(
  userMessage?: string,
  anomalySummary?: string,
): { dashboardHint: string | null; panelHint: string | null } {
  const text = `${userMessage ?? ""} ${anomalySummary ?? ""}`;

  // Pattern: "(Panel Name in Dashboard Name)" — e.g. "(Ingestion Log Rate in Ingestion monitor)"
  const parenMatch = text.match(/\(([^)]+?)\s+in\s+([^)]+?)\)/i);
  if (parenMatch) {
    return { panelHint: parenMatch[1]!.trim(), dashboardHint: parenMatch[2]!.trim() };
  }

  // Pattern: "Panel Name in Dashboard Name" without parens — less strict, require "dashboard"/"monitor" suffix
  const inMatch = text.match(/([A-Z][A-Za-z\s]+?)\s+in\s+([A-Z][A-Za-z\s]*(?:dashboard|monitor|overview))/i);
  if (inMatch) {
    return { panelHint: inMatch[1]!.trim(), dashboardHint: inMatch[2]!.trim() };
  }

  return { dashboardHint: null, panelHint: null };
}

/**
 * Extract keywords from a user query for scoring dashboards/panels.
 * Simple tokenizer — keeps words 4+ chars, skips common noise.
 */
export function extractQueryKeywords(userMessage?: string, anomalySummary?: string): string[] {
  const text = `${userMessage ?? ""} ${anomalySummary ?? ""}`.toLowerCase();
  return text.split(/[^a-z0-9]+/).filter((t) => t.length > 3);
}

/**
 * Build a chronological timeline from structured findings.
 * Programmatic — no LLM call needed.
 */
export function buildTimeline(
  metrics: MetricFindings,
  logs: LogFindings,
  infra: InfraFindings,
): string {
  const events: Array<{ time: string; source: string; detail: string }> = [];

  for (const obs of metrics.observations ?? []) {
    if (obs.timestamp) {
      events.push({
        time: obs.timestamp,
        source: "metric",
        detail: `${obs.metric}: ${obs.currentValue} (baseline: ${obs.baselineValue})`,
      });
    }
  }
  for (const obs of logs.observations ?? []) {
    if (obs.firstSeen) {
      events.push({
        time: obs.firstSeen,
        source: "log",
        detail: `${obs.pattern} (count: ${obs.count})`,
      });
    }
  }
  for (const obs of infra.observations ?? []) {
    if (obs.timestamp) {
      events.push({
        time: obs.timestamp,
        source: "infra",
        detail: `${obs.resource}: ${obs.status}`,
      });
    }
  }

  events.sort((a, b) => {
    const ta = Date.parse(a.time);
    const tb = Date.parse(b.time);
    const aValid = !Number.isNaN(ta);
    const bValid = !Number.isNaN(tb);
    if (aValid && bValid) return ta - tb;
    if (aValid) return -1;
    if (bValid) return 1;
    return a.time.localeCompare(b.time);
  });
  return events.map((e) => `[${e.time}] [${e.source}] ${e.detail}`).join("\n");
}

/**
 * Attempt to repair a truncated JSON string by closing open strings, arrays, and objects.
 * Returns the original string if repair fails.
 */
export function repairTruncatedJson(text: string): string {
  try {
    JSON.parse(text);
    return text; // Already valid
  } catch {
    // Continue to repair
  }

  let repaired = text.trimEnd();

  // Remove trailing comma
  repaired = repaired.replace(/,\s*$/, "");

  // If we're inside a string (odd number of unescaped quotes), close it
  let inString = false;
  for (let i = 0; i < repaired.length; i++) {
    if (repaired[i] === '"' && (i === 0 || repaired[i - 1] !== '\\')) {
      inString = !inString;
    }
  }
  if (inString) {
    repaired = repaired.replace(/\\$/, "");
    repaired += '"';
  }

  // Try balancing brackets first (preserves the most data)
  const balanced = balanceBrackets(repaired);
  try {
    JSON.parse(balanced);
    return balanced;
  } catch {
    // Balancing alone wasn't enough — try removing the last partial entry
  }

  // Strip trailing partial key-value pair and try again
  const lastComma = repaired.lastIndexOf(",");
  if (lastComma > 0) {
    const candidate = repaired.slice(0, lastComma);
    const candidateBalanced = balanceBrackets(candidate);
    try {
      JSON.parse(candidateBalanced);
      return candidateBalanced;
    } catch {
      // Still not parseable
    }
  }

  return text; // Unrepairable
}

/** Close unmatched { and [ brackets in order. */
function balanceBrackets(s: string): string {
  const stack: string[] = [];
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '"' && (i === 0 || s[i - 1] !== '\\')) {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  let result = s;
  while (stack.length > 0) {
    const opener = stack.pop()!;
    result += opener === "{" ? "}" : "]";
  }
  return result;
}

/**
 * Deterministic severity validator.
 * Checks whether the LLM-assigned severity is consistent with the actual findings.
 * Returns a corrected severity if the LLM got it wrong, or null if it's fine.
 *
 * Key rule: if all evidence summaries indicate "no anomaly" / "normal" / "stable"
 * and metric observations are all "normal" severity, the report severity must be "low".
 */
export function validateSeverity(
  report: { severity: string; summary: string; rootCause: string },
  metrics: MetricFindings,
  logs: LogFindings,
  infra: InfraFindings,
): "low" | "medium" | "high" | "critical" | null {
  // Patterns that indicate everything is normal
  const normalPatterns = /\b(no anomal\w*|normal\w*|stable|steady|within.{0,20}(range|limit|band|baseline|expect)|no.{0,20}(spike|drop|outage|issue|incident|degradation|error)|healthy|expected|no abnormal)\b/i;

  const summaryNormal = normalPatterns.test(report.summary);
  const rootCauseNormal = normalPatterns.test(report.rootCause);
  const metricSummaryNormal = normalPatterns.test(metrics.summary);
  const logSummaryNormal = normalPatterns.test(logs.summary);
  const infraSummaryNormal = normalPatterns.test(infra.summary);

  // Check if any metric observations have warning/critical severity
  const hasElevatedMetrics = metrics.observations.some(
    (o) => o.severity === "warning" || o.severity === "critical",
  );

  // If the report's own summary and root cause say "no anomaly" but severity is elevated — override
  if (summaryNormal && rootCauseNormal && !hasElevatedMetrics) {
    if (report.severity !== "low") {
      return "low";
    }
  }

  // If all three phase summaries say normal and no elevated metrics — override
  if (metricSummaryNormal && logSummaryNormal && infraSummaryNormal && !hasElevatedMetrics) {
    if (report.severity !== "low") {
      return "low";
    }
  }

  return null; // severity is fine
}

export class InvestigationAgent {
  private readonly llm: LlmClient;
  private readonly mcp: McpClient;
  private readonly maxIterations: number;

  constructor(llm: LlmClient, mcp: McpClient, opts: { maxIterations: number }) {
    this.llm = llm;
    this.mcp = mcp;
    this.maxIterations = opts.maxIterations;
  }

  async investigate(
    service: ServiceConfig,
    initialAnomaly?: AnomalyAssessment,
    correlationId?: string,
    onTokenUsage?: (usage: TokenUsage) => void,
    userMessage?: string,
    onToolCall?: (name: string, args: Record<string, unknown>) => void,
    onPhase?: (phase: string) => void,
  ): Promise<RcaReport> {
    const log = logger.child({ component: "investigation", service: service.name, correlationId });
    const collectedImages: PanelImage[] = [];

    // Pre-fetch datasource UIDs so phases don't waste iterations on list_datasources
    const datasourceHint = await this.getDatasourceHint();
    log.debug({ datasourceHint }, "Pre-fetched datasource UIDs");

    // Phase 1: detect anomaly if not provided
    let anomaly = initialAnomaly;
    if (!anomaly && userMessage) {
      // User explicitly reported an issue — skip full anomaly detection but extract time range via LLM
      log.info("User-reported issue, extracting time range via LLM");
      const timeWindow = await this.extractTimeRangeViaLlm(userMessage, onTokenUsage);
      anomaly = {
        isAnomaly: true,
        severity: "high",
        summary: userMessage,
        affectedMetrics: [],
        recommendedAction: "Investigate as reported by user",
        timeRangeFrom: timeWindow.from,
        timeRangeTo: timeWindow.to,
      };
    } else if (!anomaly) {
      onPhase?.("Detecting anomalies");
      log.debug("Running phase 1: anomaly detection");
      const phase1UserMessage = `${datasourceHint}\nCheck service: ${service.name}`;
      const result = await this.runPhase<AnomalyAssessment>(
        buildProactiveStructuredPrompt([service]),
        phase1UserMessage,
        ANOMALY_ASSESSMENT_RESPONSE_FORMAT,
        7,
        onTokenUsage,
        onToolCall,
      );
      anomaly = result.parsed;
      collectedImages.push(...result.images);
      log.debug({ phaseImages: result.images.length }, "Phase 1 images");
    }

    if (!anomaly.isAnomaly) {
      log.info("No anomaly detected, skipping investigation");
      return {
        service: service.name,
        severity: "low",
        summary: anomaly.summary,
        impact: { duration: "No impact detected", description: "No anomaly found during the investigation window." },
        trigger: "N/A",
        rootCause: "No anomaly detected",
        contributingFactors: [],
        timeline: [],
        evidence: { metrics: [], logs: [], infra: [] },
        dashboardLinks: [],
        panelImages: collectedImages,
        recommendedActions: [],
        confidence: "high",
        investigatedAt: new Date().toLocaleString(),
      };
    }

    // Phase 1.5: Investigation Planning
    onPhase?.("Planning investigation");
    log.debug("Running phase 1.5: investigation planning");
    const planMessage = [
      `Service: ${service.name}`,
      `Anomaly: ${anomaly.summary}`,
      `Severity: ${anomaly.severity}`,
      `Affected metrics: ${anomaly.affectedMetrics.join(", ")}`,
      `Service metrics: ${service.metrics.map((m) => `${m.description} (${m.query})`).join(", ") || "none configured"}`,
      `Log labels: ${JSON.stringify(service.logLabels)}`,
    ].join("\n");

    const PLAN_MAX_TOKENS = 2048;
    const planResult = await this.runPhase<InvestigationPlan>(
      INVESTIGATION_PLAN_PROMPT,
      planMessage,
      INVESTIGATION_PLAN_SCHEMA,
      3,
      onTokenUsage,
      onToolCall,
      false, // planning is pure reasoning, no tools needed
      PLAN_MAX_TOKENS,
    );
    const plan: InvestigationPlan = {
      hypotheses: planResult.parsed?.hypotheses ?? [],
      metricFocus: planResult.parsed?.metricFocus ?? [],
      logFocus: planResult.parsed?.logFocus ?? [],
      infraFocus: planResult.parsed?.infraFocus ?? [],
    };
    log.debug({ hypotheses: plan.hypotheses.length }, "Investigation plan created");

    // Phases 2/3/4 + panel capture in parallel
    onPhase?.("Analyzing metrics, logs & infrastructure");
    log.debug("Running phases 2/3/4 + panel capture in parallel");
    const timeCtx = getTimeContext();
    const anomalyContext = `${anomaly.summary} (severity: ${anomaly.severity})`;

    // Use LLM-extracted time range from anomaly assessment, fall back to static parser
    const investigationWindow = (anomaly.timeRangeFrom && anomaly.timeRangeTo)
      ? { from: anomaly.timeRangeFrom, to: anomaly.timeRangeTo }
      : this.extractTimeRange(anomaly.summary, userMessage);
    // Pick appropriate step size based on window width
    const stepHint = this.suggestStepSeconds(investigationWindow);
    const windowHint = `INVESTIGATION TIME WINDOW: from="${investigationWindow.from}" to="${investigationWindow.to}"\nYou MUST query this full window using a RANGE query as your FIRST tool call:\n  queryType="range", startTime="${investigationWindow.from}", endTime="${investigationWindow.to}", stepSeconds=${stepHint}\nDo NOT only check the current instant value — past anomalies are invisible to instant queries.`;
    log.debug({ investigationWindow, stepHint }, "Investigation time window");

    const fullContext = `${datasourceHint}\n${timeCtx}\nPresent all timestamps in the user's local timezone, not UTC.\n\n${windowHint}\n\nKnown issue: ${anomalyContext}`;
    const userContext = userMessage ? `\nUser reported: "${userMessage}"` : "";

    const metricPrompt = buildMetricDeepDivePrompt(service, anomalyContext, plan.metricFocus);
    const logPrompt = buildLogCorrelationPrompt(service, anomalyContext, plan.logFocus);
    const infraPrompt = buildInfraHealthPrompt(service, anomalyContext, plan.infraFocus);

    const metricMessage = `${fullContext}${userContext}\nService metrics: ${service.metrics.map((m) => m.query).join(", ")}`;
    const logMessage = `${fullContext}${userContext}\nLog labels: ${JSON.stringify(service.logLabels)}`;
    const infraMessage = `${fullContext}${userContext}\nService: ${service.name}`;

    // Pre-fetch panel queries so evidence phases don't waste iterations discovering them
    // Note: we no longer inject the full dashboard list — it's noise. Panel queries are enough.

    // Extract default Prometheus datasource UID from the datasource hint
    const promUidMatch = datasourceHint.match(/prometheus: datasourceUid="([^"]+)"/);
    const defaultPromUid = promUidMatch?.[1];

    const lokiUidMatch = datasourceHint.match(/loki: datasourceUid="([^"]+)"/);
    const lokiUid = lokiUidMatch?.[1];

    // Convert investigation window to RFC3339 for Loki probe queries
    const lokiProbeWindow = this.toRfc3339Window(investigationWindow);

    const [panelQueriesResult, lokiLabelsHint, workingLogSelector] = await Promise.all([
      this.getPanelQueriesContext(service.name, userMessage, anomaly.summary, defaultPromUid),
      lokiUid ? this.getLokiLabelsHint(lokiUid) : Promise.resolve(""),
      lokiUid ? this.getWorkingLogSelector(service, lokiUid, lokiProbeWindow) : Promise.resolve(""),
    ]);
    const panelQueriesContext = panelQueriesResult.context;
    const realDashboardUrls = panelQueriesResult.dashboardUrls;
    log.debug({ hasPanelQueries: panelQueriesContext.length > 0, hasLokiLabels: lokiLabelsHint.length > 0, workingLogSelector, realDashboardUrls }, "Pre-fetched panel queries, Loki labels, and log selector");

    const prefetchedContext = panelQueriesContext;
    const logSelectorHint = workingLogSelector
      ? `VALIDATED LOG SELECTOR (pre-tested, returns real logs — use this as your primary selector):\n  ${workingLogSelector}\nThe configured logLabels may NOT return results. Use the validated selector above as your FIRST query.`
      : "";
    const logPrefetchedContext = [lokiLabelsHint, logSelectorHint].filter(Boolean).join("\n\n");
    const metricMessageFull = prefetchedContext ? `${metricMessage}\n\n${prefetchedContext}` : metricMessage;
    const logMessageFull = logPrefetchedContext ? `${logMessage}\n\n${logPrefetchedContext}` : logMessage;
    const infraMessageFull = prefetchedContext ? `${infraMessage}\n\n${prefetchedContext}` : infraMessage;

    const EVIDENCE_MAX_TOKENS = 8192;
    const EVIDENCE_TIMEOUT_MS = 180_000; // 3min — evidence phases need headroom for slow models

    // Pre-fetched panel queries + datasource UIDs + Loki labels mean the LLM can
    // skip discovery and go straight to querying. 6 iterations = 4 productive + 2 wind-down.
    const EVIDENCE_ITERATIONS = 6;

    const [metricResult, logResult, infraResult, panelCaptureResult] = await Promise.allSettled([
      this.runPhase<MetricFindings>(metricPrompt, metricMessageFull, METRIC_FINDINGS_SCHEMA, EVIDENCE_ITERATIONS, onTokenUsage, onToolCall, true, EVIDENCE_MAX_TOKENS, EVIDENCE_TIMEOUT_MS),
      this.runPhase<LogFindings>(logPrompt, logMessageFull, LOG_FINDINGS_SCHEMA, EVIDENCE_ITERATIONS, onTokenUsage, onToolCall, true, EVIDENCE_MAX_TOKENS, EVIDENCE_TIMEOUT_MS),
      this.runPhase<InfraFindings>(infraPrompt, infraMessageFull, INFRA_FINDINGS_SCHEMA, EVIDENCE_ITERATIONS, onTokenUsage, onToolCall, true, EVIDENCE_MAX_TOKENS, EVIDENCE_TIMEOUT_MS),
      this.capturePanelImages(service.name, anomaly.summary, userMessage, onToolCall),
    ]);

    const defaultMetric: MetricFindings = { observations: [], anomalyWindow: "unknown", summary: "unavailable" };
    const defaultLog: LogFindings = { observations: [], summary: "unavailable" };
    const defaultInfra: InfraFindings = { observations: [], summary: "unavailable" };

    const metricFindings: MetricFindings = metricResult.status === "fulfilled"
      ? { ...defaultMetric, ...metricResult.value.parsed, observations: Array.isArray(metricResult.value.parsed.observations) ? metricResult.value.parsed.observations : [] }
      : defaultMetric;
    const logFindings: LogFindings = logResult.status === "fulfilled"
      ? { ...defaultLog, ...logResult.value.parsed, observations: Array.isArray(logResult.value.parsed.observations) ? logResult.value.parsed.observations : [] }
      : defaultLog;
    const infraFindings: InfraFindings = infraResult.status === "fulfilled"
      ? { ...defaultInfra, ...infraResult.value.parsed, observations: Array.isArray(infraResult.value.parsed.observations) ? infraResult.value.parsed.observations : [] }
      : defaultInfra;

    // Collect images from fulfilled phases
    if (metricResult.status === "fulfilled") {
      collectedImages.push(...metricResult.value.images);
      log.debug({ metricImages: metricResult.value.images.length }, "Metric phase images");
    }
    if (logResult.status === "fulfilled") {
      collectedImages.push(...logResult.value.images);
      log.debug({ logImages: logResult.value.images.length }, "Log phase images");
    }
    if (infraResult.status === "fulfilled") {
      collectedImages.push(...infraResult.value.images);
      log.debug({ infraImages: infraResult.value.images.length }, "Infra phase images");
    }

    // Deterministic panel images (guaranteed capture)
    if (panelCaptureResult.status === "fulfilled") {
      collectedImages.push(...panelCaptureResult.value);
      log.debug({ panelCaptureImages: panelCaptureResult.value.length }, "Deterministic panel capture images");
    }

    if (metricResult.status === "rejected") log.warn({ err: metricResult.reason }, "Metric phase failed");
    if (logResult.status === "rejected") log.warn({ err: logResult.reason }, "Log phase failed");
    if (infraResult.status === "rejected") log.warn({ err: infraResult.reason }, "Infra phase failed");
    if (panelCaptureResult.status === "rejected") log.warn({ err: panelCaptureResult.reason }, "Panel capture failed");

    // Build timeline before synthesis
    onPhase?.("Building event timeline");
    const timeline = buildTimeline(metricFindings, logFindings, infraFindings);
    log.debug({ timelineEvents: timeline.split("\n").filter(Boolean).length }, "Timeline built");

    // Phase 5: synthesise
    onPhase?.("Synthesizing root cause");
    log.debug("Running phase 5: synthesis");

    // Condense findings for synthesis to avoid context bloat
    const condensedMetrics = {
      summary: metricFindings.summary,
      anomalyWindow: metricFindings.anomalyWindow,
      observations: metricFindings.observations.slice(0, 8).map((o) => ({
        metric: o.metric, current: o.currentValue, baseline: o.baselineValue, severity: o.severity, time: o.timestamp,
      })),
    };
    const condensedLogs = {
      summary: logFindings.summary,
      observations: logFindings.observations.slice(0, 8).map((o) => ({
        pattern: o.pattern, count: o.count, firstSeen: o.firstSeen, lastSeen: o.lastSeen, sample: o.sample?.slice(0, 400),
        sampleLines: (o.sampleLines ?? []).slice(0, 5).map((l) => l.slice(0, 400)),
      })),
    };
    const condensedInfra = {
      summary: infraFindings.summary,
      observations: infraFindings.observations.slice(0, 8).map((o) => ({
        resource: o.resource, status: o.status, detail: o.detail?.slice(0, 150), time: o.timestamp,
      })),
    };

    // Extract raw Prometheus data from the metric phase for synthesis (sampled to stay compact).
    // Handles both original Prometheus format ({ data: { result: [...] } }) and compacted format
    // ({ data: [{ m, values, ... }] }) produced by truncateToolResponse().
    const rawMetricToolData = metricResult.status === "fulfilled"
      ? metricResult.value.toolData
        .map((text) => {
          try {
            const parsed = JSON.parse(text);
            // Original Prometheus format: { data: { result: [...] } }
            const results = parsed?.data?.result ?? parsed?.result ?? [];
            if (Array.isArray(results) && results.length > 0 && results[0]?.metric) {
              return results.slice(0, 3).map((r: { metric?: Record<string, string>; values?: [number, string][] }) => {
                const metricName = r.metric ? Object.values(r.metric).join("/") : "unknown";
                const values = (r.values ?? []).filter((_: [number, string], i: number) => i % 2 === 0).slice(0, 12);
                return `${metricName}: ${values.map((v: [number, string]) => `[${new Date(v[0] * 1000).toISOString()}, ${v[1]}]`).join(", ")}`;
              }).join("\n");
            }
            // Compacted format from truncateToolResponse(): { data: [{ m, min, max, avg, values }] }
            const compactData = parsed?.data;
            if (Array.isArray(compactData) && compactData.length > 0 && compactData[0]?.m) {
              return compactData.slice(0, 3).map((r: { m: string; instance?: string; min?: string; max?: string; avg?: string; values?: [string, string][] }) => {
                const label = r.instance ? `${r.m}(${r.instance})` : r.m;
                const stats = [r.min && `min=${r.min}`, r.max && `max=${r.max}`, r.avg && `avg=${r.avg}`].filter(Boolean).join(", ");
                const vals = (r.values ?? []).slice(0, 12).map(([t, v]) => `[${t}, ${v}]`).join(", ");
                return `${label}: ${stats}${vals ? ` | ${vals}` : ""}`;
              }).join("\n");
            }
          } catch { /* not JSON or not Prometheus data */ }
          return null;
        })
        .filter(Boolean)
        .join("\n")
        .slice(0, 3000)  // Hard cap to avoid bloating synthesis context
      : "";

    const dashboardLinksHint = realDashboardUrls.length > 0
      ? `\nREAL DASHBOARD URLS (use these verbatim in dashboardLinks — do NOT invent URLs):\n${realDashboardUrls.map((u) => `- ${u}`).join("\n")}`
      : "\nNo dashboard URLs available. Leave dashboardLinks as an empty array.";

    const synthesisMessage = [
      timeCtx,
      `Present all timestamps in the user's local timezone, not UTC.`,
      `Service: ${service.name}`,
      `Initial anomaly: ${anomaly.summary} (severity: ${anomaly.severity})`,
      timeline ? `\nEVENT TIMELINE:\n${timeline}` : "",
      `\nDetailed findings:`,
      `Metric findings: ${JSON.stringify(condensedMetrics)}`,
      rawMetricToolData ? `\nRaw metric data (sampled time series):\n${rawMetricToolData}` : "",
      `Log findings: ${JSON.stringify(condensedLogs)}`,
      `Infrastructure findings: ${JSON.stringify(condensedInfra)}`,
      `\nInvestigation hypotheses: ${JSON.stringify(plan.hypotheses)}`,
      dashboardLinksHint,
    ].join("\n");

    const SYNTHESIS_MAX_TOKENS = 8192;
    const REASONING_TIMEOUT_MS = 240_000; // 4min — synthesis/reflection are slow on large models

    type SynthesisResult = Omit<RcaReport, "service" | "investigatedAt" | "panelImages">;
    const defaultSynthesis: SynthesisResult = {
      severity: "medium",
      summary: anomaly.summary,
      impact: { duration: "Unknown", description: anomaly.summary },
      trigger: "Unable to determine — synthesis phase failed",
      rootCause: "Unable to determine — synthesis phase failed",
      contributingFactors: [],
      timeline: [],
      evidence: { metrics: [], logs: [], infra: [] },
      dashboardLinks: [],
      recommendedActions: [],
      confidence: "low",
    };

    let synthesisResult: PhaseResult<SynthesisResult>;
    try {
      synthesisResult = await this.runPhase<SynthesisResult>(
        RCA_SYNTHESIS_PROMPT,
        synthesisMessage,
        RCA_REPORT_SCHEMA,
        3,
        onTokenUsage,
        onToolCall,
        false, // synthesis is pure reasoning, no tools needed
        SYNTHESIS_MAX_TOKENS,
        REASONING_TIMEOUT_MS,
      );
      collectedImages.push(...synthesisResult.images);
    } catch (err) {
      log.error({ err }, "Synthesis phase failed, using default report");
      synthesisResult = { parsed: defaultSynthesis, images: [], toolData: [] };
    }

    // Phase 6: Reflection
    onPhase?.("Validating report");
    log.debug("Running phase 6: reflection");
    const reflectionMessage = [
      `RCA Report: ${JSON.stringify(synthesisResult.parsed)}`,
      `Metric summary: ${metricFindings.summary}`,
      `Log summary: ${logFindings.summary}`,
      `Infra summary: ${infraFindings.summary}`,
      `Investigation plan hypotheses: ${JSON.stringify(plan.hypotheses)}`,
    ].join("\n");

    const REFLECTION_MAX_TOKENS = 8192;
    let reflectionResult: PhaseResult<ReflectionResult>;
    try {
      reflectionResult = await this.runPhase<ReflectionResult>(
        RCA_REFLECTION_PROMPT,
        reflectionMessage,
        RCA_REFLECTION_SCHEMA,
        3,
        onTokenUsage,
        onToolCall,
        false, // reflection is pure reasoning, no tools needed
        REFLECTION_MAX_TOKENS,
        REASONING_TIMEOUT_MS,
      );
    } catch (err) {
      log.error({ err }, "Reflection phase failed, skipping corrections");
      reflectionResult = { parsed: { validationNotes: "", revisedRootCause: "", revisedTrigger: "", revisedSeverity: "medium", revisedConfidence: "low", revisedSummary: "", issues: [] }, images: [], toolData: [] };
    }

    // Apply corrections from reflection (guard against partial/empty responses)
    // Cap arrays to prevent bloated output from verbose LLMs
    const evidence = synthesisResult.parsed.evidence ?? { metrics: [], logs: [], infra: [] };
    evidence.metrics = (evidence.metrics ?? []).slice(0, 5);
    evidence.logs = (evidence.logs ?? []).slice(0, 5);
    evidence.infra = (evidence.infra ?? []).slice(0, 5);
    const report = {
      severity: synthesisResult.parsed.severity ?? "medium",
      summary: synthesisResult.parsed.summary ?? anomaly.summary,
      impact: synthesisResult.parsed.impact ?? { duration: "Unknown", description: anomaly.summary },
      trigger: synthesisResult.parsed.trigger ?? "Unable to determine",
      rootCause: synthesisResult.parsed.rootCause ?? "Unable to determine — insufficient data from evidence phases",
      contributingFactors: (synthesisResult.parsed.contributingFactors ?? []).slice(0, 4),
      timeline: (synthesisResult.parsed.timeline ?? []).slice(0, 8),
      evidence,
      dashboardLinks: realDashboardUrls.length > 0 ? realDashboardUrls.slice(0, 5) : (synthesisResult.parsed.dashboardLinks ?? []).slice(0, 5),
      recommendedActions: (synthesisResult.parsed.recommendedActions ?? []).filter((a: string) => a.trim().length > 0).slice(0, 5),
      confidence: synthesisResult.parsed.confidence ?? "low",
    } as Omit<RcaReport, "service" | "investigatedAt" | "panelImages">;
    const reflection = reflectionResult.parsed;
    const issues = reflection.issues ?? [];
    // Always apply revisedSeverity from reflection — it validates severity/evidence consistency
    if (reflection.revisedSeverity) {
      report.severity = reflection.revisedSeverity;
    }
    if (issues.length > 0 && reflection.revisedRootCause) {
      log.info({ issues }, "Reflection found issues, applying corrections");
      report.rootCause = reflection.revisedRootCause;
      if (reflection.revisedTrigger) report.trigger = reflection.revisedTrigger;
      report.confidence = reflection.revisedConfidence ?? report.confidence;
      report.summary = reflection.revisedSummary ?? report.summary;
    }

    // Deterministic severity check — catches LLM severity/evidence mismatches that
    // both synthesis and reflection failed to correct (common with weaker models).
    const correctedSeverity = validateSeverity(report, metricFindings, logFindings, infraFindings);
    if (correctedSeverity) {
      log.info({ from: report.severity, to: correctedSeverity }, "Severity override: evidence contradicts LLM-assigned severity");
      report.severity = correctedSeverity;
    }

    log.info({ totalPanelImages: collectedImages.length }, "Investigation complete");

    return {
      ...report,
      service: service.name,
      investigatedAt: new Date().toLocaleString(),
      panelImages: collectedImages,
    };
  }

  /**
   * Deterministic panel image capture — always runs, independent of LLM behavior.
   * Searches dashboards, finds ones relevant to the service and user query,
   * and captures up to 3 panel images with a time range derived from the anomaly context.
   */
  private async capturePanelImages(
    serviceName: string,
    anomalySummary: string,
    userMessage?: string,
    onToolCall?: (name: string, args: Record<string, unknown>) => void,
  ): Promise<PanelImage[]> {
    const log = logger.child({ component: "panel-capture", service: serviceName });
    log.info("Starting deterministic panel capture");
    const images: PanelImage[] = [];
    const maxImages = 3;

    const toolNames = this.mcp.getTools().map((t) => t.function.name);
    log.info({ availableTools: toolNames }, "Available tools for panel capture");
    if (!toolNames.includes("get_panel_image") || !toolNames.includes("search_dashboards")) {
      log.warn("Panel image tools not available, skipping capture");
      return images;
    }

    // Derive time range from anomaly context
    const timeRange = this.extractTimeRange(anomalySummary, userMessage);
    log.info({ timeRange }, "Derived time range for panel images");

    // Extract dashboard/panel hints from user message
    const { dashboardHint, panelHint } = extractDashboardPanelHints(userMessage, anomalySummary);
    log.debug({ dashboardHint, panelHint }, "Extracted dashboard/panel hints from query");

    // Build scoring tokens: service name tokens + query-derived tokens + keyword tokens
    const serviceTokens = serviceName.toLowerCase().split(/[-_\s]+/);
    const dashboardHintTokens = dashboardHint ? dashboardHint.toLowerCase().split(/[-_\s]+/).filter((t) => t.length > 1) : [];
    const panelHintTokens = panelHint ? panelHint.toLowerCase().split(/[-_\s]+/).filter((t) => t.length > 1) : [];
    // Extract keywords from user query for broader matching (e.g. "ingestion log rate drop" → ["ingestion", "log", "rate", "drop"])
    const queryKeywords = extractQueryKeywords(userMessage, anomalySummary);

    // Step 1: list all dashboards
    onToolCall?.("search_dashboards", { query: "" });
    const searchResult = await this.mcp.callTool("search_dashboards", { query: "" });

    let dashboards: Array<{ uid: string; title: string }>;
    try {
      const parsed = JSON.parse(searchResult.text);
      dashboards = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.dashboards) ? parsed.dashboards : [];
    } catch {
      log.warn("Failed to parse dashboard list");
      return images;
    }

    // Filter out temporary dashboards created by the agent itself
    dashboards = dashboards.filter((d) => !d.title.startsWith("dops-temp:"));

    if (dashboards.length === 0) return images;

    // Step 2: sort dashboards by relevance
    dashboards.sort((a, b) => {
      const aTitle = a.title.toLowerCase();
      const bTitle = b.title.toLowerCase();
      const aServiceScore = serviceTokens.filter((t) => aTitle.includes(t)).length;
      const bServiceScore = serviceTokens.filter((t) => bTitle.includes(t)).length;
      const aHintScore = dashboardHintTokens.filter((t) => aTitle.includes(t)).length * 3;
      const bHintScore = dashboardHintTokens.filter((t) => bTitle.includes(t)).length * 3;
      const aKeywordScore = queryKeywords.filter((t) => aTitle.includes(t)).length * 2;
      const bKeywordScore = queryKeywords.filter((t) => bTitle.includes(t)).length * 2;
      return (bServiceScore + bHintScore + bKeywordScore) - (aServiceScore + aHintScore + aKeywordScore);
    });

    log.debug({ dashboardCount: dashboards.length, topDashboards: dashboards.slice(0, 3).map((d) => d.title) }, "Dashboards ranked by relevance");

    // Step 3: get panels from top dashboards
    for (const db of dashboards.slice(0, 3)) {
      if (images.length >= maxImages) break;

      onToolCall?.("get_dashboard_by_uid", { uid: db.uid });
      const detailResult = await this.mcp.callTool("get_dashboard_by_uid", { uid: db.uid });

      let panels: Array<{ id: number; title: string; type: string }>;
      try {
        const data = JSON.parse(detailResult.text);
        panels = (data.dashboard?.panels ?? data.panels ?? []) as Array<{
          id: number; title: string; type: string;
        }>;
      } catch {
        continue;
      }

      // Filter to visual metric panels
      const graphTypes = new Set(["timeseries", "graph", "gauge", "stat", "bargauge", "heatmap"]);
      const metricPanels = panels.filter((p) => graphTypes.has(p.type));

      // Rank panels: panel hint tokens weighted 3x, query keywords 2x, service tokens 1x
      metricPanels.sort((a, b) => {
        const aTitle = a.title.toLowerCase();
        const bTitle = b.title.toLowerCase();
        const aHintScore = panelHintTokens.filter((t) => aTitle.includes(t)).length * 3;
        const bHintScore = panelHintTokens.filter((t) => bTitle.includes(t)).length * 3;
        const aKeywordScore = queryKeywords.filter((t) => aTitle.includes(t)).length * 2;
        const bKeywordScore = queryKeywords.filter((t) => bTitle.includes(t)).length * 2;
        const aServiceScore = serviceTokens.filter((t) => aTitle.includes(t)).length;
        const bServiceScore = serviceTokens.filter((t) => bTitle.includes(t)).length;
        return (bHintScore + bKeywordScore + bServiceScore) - (aHintScore + aKeywordScore + aServiceScore);
      });

      // Step 4: capture images with the correct time range
      for (const panel of metricPanels.slice(0, maxImages - images.length)) {
        try {
          const args: Record<string, unknown> = {
            dashboardUid: db.uid,
            panelId: panel.id,
            timeRange,
          };
          onToolCall?.("get_panel_image", args);
          const imgResult = await this.mcp.callTool("get_panel_image", args);
          images.push(...imgResult.images);
          log.debug({ panel: panel.title, dashboard: db.title }, "Captured panel image");
        } catch (err) {
          log.warn({ panel: panel.title, err }, "Failed to capture panel image");
        }
      }
    }

    log.info({ capturedImages: images.length }, "Panel image capture complete");
    return images;
  }

  /**
   * Extract a Grafana-compatible time range from the anomaly description.
   * Uses Grafana's day-rounding syntax (/d) to produce precise day boundaries.
   */
  extractTimeRange(anomalySummary: string, userMessage?: string): { from: string; to: string } {
    // Lightweight fallback for when LLM extraction fails or is skipped.
    // Only handles ISO dates — all other formats are handled by extractTimeRangeViaLlm.
    const text = `${anomalySummary} ${userMessage ?? ""}`.replace(/[\u2010-\u2015\u2212]/g, "-");
    const dateMatch = text.match(/(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) {
      return { from: `${dateMatch[1]}T00:00:00Z`, to: `${dateMatch[1]}T23:59:59Z` };
    }
    return { from: "now-6h", to: "now" };
  }

  /**
   * Use LLM to extract a time range from natural language (handles any date format).
   * Fast single-shot call with no tools. Falls back to static parser on failure.
   */
  private async extractTimeRangeViaLlm(
    userMessage: string,
    onTokenUsage?: (usage: TokenUsage) => void,
  ): Promise<{ from: string; to: string }> {
    const fallback = this.extractTimeRange(userMessage);
    try {
      const now = new Date().toISOString();
      const response = await this.llm.chat(
        [
          {
            role: "system",
            content: `Extract the investigation time window from the user message. Current time: ${now}\nRespond ONLY with JSON: {"from":"<ISO8601>","to":"<ISO8601>"}\nFor a specific day, use T00:00:00Z to T23:59:59Z. For relative references ("yesterday", "this Thursday"), compute the actual date. If no time reference, use the last 6 hours.`,
          },
          { role: "user", content: userMessage },
        ],
        [],
        { maxOutputTokens: 128 },
      );
      if (response.usage) onTokenUsage?.(response.usage);
      if (response.type === "text") {
        const parsed = JSON.parse(response.content) as { from: string; to: string };
        if (parsed.from && parsed.to) return parsed;
      }
    } catch (err) {
      logger.debug({ err }, "LLM time range extraction failed, using static fallback");
    }
    return fallback;
  }

  /**
   * Convert a Grafana-relative time window to RFC3339 timestamps for Loki queries.
   * Falls back to a 7-day window if parsing fails.
   */
  /** Convert time window to RFC3339 for Loki. Handles ISO dates and "now-Xd" relative expressions. */
  private toRfc3339Window(window: { from: string; to: string }): { startRfc3339: string; endRfc3339: string } {
    const resolve = (expr: string): string => {
      if (/^\d{4}-\d{2}-\d{2}/.test(expr)) return new Date(expr).toISOString();
      const m = expr.match(/^now(?:-(\d+)([dhm]))?/);
      if (m) {
        const d = new Date();
        if (m[1] && m[2]) {
          const n = parseInt(m[1], 10);
          if (m[2] === "d") d.setDate(d.getDate() - n);
          else if (m[2] === "h") d.setHours(d.getHours() - n);
          else d.setMinutes(d.getMinutes() - n);
        }
        return d.toISOString();
      }
      return new Date(Date.now() - 7 * 86400000).toISOString();
    };
    return { startRfc3339: resolve(window.from), endRfc3339: resolve(window.to) };
  }

  /** Suggest step size for range queries. Aims for ~100 data points. */
  private suggestStepSeconds(window: { from: string; to: string }): number {
    try {
      const parseTimeExpr = (expr: string): Date => {
        if (/^\d{4}-\d{2}-\d{2}/.test(expr)) return new Date(expr);
        const m = expr.match(/^now(?:-(\d+)([smhdw]))?(?:\/d)?$/);
        const d = new Date();
        if (m) {
          const amount = m[1] ? parseInt(m[1], 10) : 0;
          const unit = m[2];
          if (amount > 0 && unit) {
            switch (unit) {
              case "s": d.setSeconds(d.getSeconds() - amount); break;
              case "m": d.setMinutes(d.getMinutes() - amount); break;
              case "h": d.setHours(d.getHours() - amount); break;
              case "d": d.setDate(d.getDate() - amount); break;
              case "w": d.setDate(d.getDate() - amount * 7); break;
            }
          }
          return d;
        }
        return d;
      };
      const from = parseTimeExpr(window.from);
      const to = parseTimeExpr(window.to);
      const durationSec = Math.abs(to.getTime() - from.getTime()) / 1000;
      if (durationSec > 0 && Number.isFinite(durationSec)) {
        return Math.max(300, Math.round(durationSec / 100));
      }
    } catch { /* fall through */ }
    return 900;
  }

  /**
   * Pre-fetch dashboard list so evidence phases don't each independently call search_dashboards.
   * Returns a context string with dashboard names/UIDs, or empty string if unavailable.
   */
  private async getDashboardContext(): Promise<string> {
    const toolNames = this.mcp.getTools().map((t) => t.function.name);
    if (!toolNames.includes("search_dashboards")) return "";

    try {
      const result = await this.mcp.callTool("search_dashboards", { query: "" });
      const parsed = JSON.parse(result.text);
      const list = Array.isArray(parsed) ? parsed : parsed?.dashboards ?? [];
      const dashboards = (list as Array<{ uid: string; title: string }>)
        .filter((d) => !d.title.startsWith("dops-temp:"))
        .slice(0, 20);
      if (dashboards.length === 0) return "";
      const lines = dashboards.map((d) => `- "${d.title}" (uid: ${d.uid})`);
      return `Available dashboards (already fetched, do NOT call search_dashboards):\n${lines.join("\n")}`;
    } catch {
      return "";
    }
  }

  /**
   * Pre-fetch panel queries from the most relevant dashboards.
   * Returns actual PromQL/LogQL expressions the LLM can use directly,
   * saving 2-3 iterations that would be spent on get_dashboard_by_uid + get_dashboard_panel_queries.
   */
  private async getPanelQueriesContext(
    serviceName: string,
    userMessage?: string,
    anomalySummary?: string,
    defaultDatasourceUid?: string,
  ): Promise<{ context: string; dashboardUrls: string[] }> {
    const empty = { context: "", dashboardUrls: [] as string[] };
    const toolNames = this.mcp.getTools().map((t) => t.function.name);
    if (!toolNames.includes("get_dashboard_panel_queries") || !toolNames.includes("search_dashboards")) return empty;

    const log = logger.child({ component: "panel-queries-prefetch" });

    try {
      // Get all dashboards
      const searchResult = await this.mcp.callTool("search_dashboards", { query: "" });
      const parsed = JSON.parse(searchResult.text);
      const rawDashboards = (Array.isArray(parsed) ? parsed : parsed?.dashboards ?? []) as Array<{ uid: string; title: string }>;
      // Filter out temp dashboards created by the agent
      const allDashboards = rawDashboards.filter((d) => !d.title.startsWith("dops-temp:"));
      if (allDashboards.length === 0) return empty;

      // Score and rank dashboards by relevance to the service/query
      const serviceTokens = serviceName.toLowerCase().split(/[-_\s]+/);
      const queryKeywords = extractQueryKeywords(userMessage, anomalySummary);
      const { dashboardHint } = extractDashboardPanelHints(userMessage, anomalySummary);
      const hintTokens = dashboardHint ? dashboardHint.toLowerCase().split(/[-_\s]+/).filter((t) => t.length > 1) : [];

      const scored = allDashboards.map((d) => {
        const title = d.title.toLowerCase();
        const hintScore = hintTokens.filter((t) => title.includes(t)).length * 3;
        const keywordScore = queryKeywords.filter((t) => title.includes(t)).length * 2;
        const serviceScore = serviceTokens.filter((t) => title.includes(t)).length;
        return { ...d, score: hintScore + keywordScore + serviceScore };
      });
      scored.sort((a, b) => b.score - a.score);

      // Fetch queries from top 3 relevant dashboards
      const topDashboards = scored.filter((d) => d.score > 0).slice(0, 3);
      if (topDashboards.length === 0) {
        // Fallback: use first 2 dashboards
        topDashboards.push(...scored.slice(0, 2));
      }

      const sections: string[] = [];
      for (const db of topDashboards) {
        try {
          const result = await this.mcp.callTool("get_dashboard_panel_queries", { uid: db.uid });
          const queries = JSON.parse(result.text) as Array<{
            title: string; query: string; datasource: { uid: string; type: string };
          }>;

          // Map empty datasource UIDs to the default (usually Prometheus)
          const enriched = queries.map((q) => ({
            ...q,
            datasource: {
              uid: q.datasource.uid || defaultDatasourceUid || "(default)",
              type: q.datasource.type || "prometheus",
            },
          }));

          // Filter to queries relevant to the service by panel title matching service tokens.
          // Use only service name tokens (not generic keywords like "rate") to avoid over-matching.
          const relevant = enriched.filter((q) => {
            const title = q.title.toLowerCase();
            return serviceTokens.some((t) => title.includes(t));
          });
          // If no relevant queries found, include first 5 as fallback
          const selected = relevant.length > 0 ? relevant.slice(0, 15) : enriched.slice(0, 5);

          // Deduplicate by query text (same panel can have multiple targets with identical queries)
          const seen = new Set<string>();
          const deduped = selected.filter((q) => {
            if (seen.has(q.query)) return false;
            seen.add(q.query);
            return true;
          });

          const lines = deduped.map((q) =>
            `  - "${q.title}": \`${q.query}\` (datasource: ${q.datasource.uid})`
          );
          sections.push(`Dashboard "${db.title}" (uid: ${db.uid}):\n${lines.join("\n")}`);
        } catch (err) {
          log.debug({ dashboard: db.title, err }, "Failed to fetch panel queries");
        }
      }

      if (sections.length === 0) return empty;

      // Build real dashboard URLs from GRAFANA_URL env var
      const grafanaUrl = (process.env["GRAFANA_URL"] ?? "").replace(/\/+$/, "");
      const dashboardUrls = grafanaUrl
        ? topDashboards.map((d) => `${grafanaUrl}/d/${d.uid}`)
        : [];

      const context = [
        "PANEL QUERIES (pre-fetched — use these PromQL expressions directly, do NOT call get_dashboard_panel_queries or get_dashboard_by_uid):",
        ...sections,
      ].join("\n\n");
      return { context, dashboardUrls };
    } catch (err) {
      log.debug({ err }, "Failed to pre-fetch panel queries");
      return empty;
    }
  }

  /**
   * Pre-fetch Loki label names so the LLM knows which labels exist without calling list_loki_label_names.
   */
  private async getLokiLabelsHint(lokiUid: string): Promise<string> {
    const toolNames = this.mcp.getTools().map((t) => t.function.name);
    if (!toolNames.includes("list_loki_label_names")) return "";

    try {
      const result = await this.mcp.callTool("list_loki_label_names", { datasourceUid: lokiUid });
      const parsed = JSON.parse(result.text);
      const labels = Array.isArray(parsed) ? parsed : parsed?.labels ?? [];
      if (labels.length === 0) return "";
      return `Available Loki labels (do NOT call list_loki_label_names):\n${(labels as string[]).join(", ")}`;
    } catch {
      return "";
    }
  }

  /**
   * Find a Loki log selector that actually returns logs for a service.
   * Tries the configured logLabels first, then falls back through common label patterns.
   * Uses a time window for probing since Loki's default window may be too narrow.
   * Returns a LogQL selector string like `{job="default/ingestion-server"}` or empty string.
   */
  private async getWorkingLogSelector(
    service: ServiceConfig,
    lokiUid: string,
    probeWindow?: { startRfc3339: string; endRfc3339: string },
  ): Promise<string> {
    const log = logger.child({ component: "log-selector-probe", service: service.name });
    const toolNames = this.mcp.getTools().map((t) => t.function.name);
    if (!toolNames.includes("query_loki_logs")) return "";

    // Build candidate selectors: configured labels first, then fallbacks
    const candidates: Array<{ selector: string; source: string }> = [];

    // 1. Configured logLabels (what the service config says)
    const configuredLabels = service.logLabels;
    if (Object.keys(configuredLabels).length > 0) {
      const parts = Object.entries(configuredLabels).map(([k, v]) => `${k}="${v}"`);
      candidates.push({ selector: `{${parts.join(", ")}}`, source: "configured" });
    }

    // 2. Common fallback patterns
    const svcName = service.name;
    candidates.push(
      { selector: `{job="default/${svcName}"}`, source: "job" },
      { selector: `{container_name="${svcName}"}`, source: "container_name" },
      { selector: `{app_fortidata_name="${svcName}"}`, source: "app_fortidata_name" },
      { selector: `{chart="${svcName}"}`, source: "chart" },
    );

    // Deduplicate
    const seen = new Set<string>();
    const unique = candidates.filter((c) => {
      if (seen.has(c.selector)) return false;
      seen.add(c.selector);
      return true;
    });

    // Build probe args with time window — Loki's default range is often too narrow
    // to find logs for services that aren't actively logging right now
    const baseArgs: Record<string, unknown> = {
      datasourceUid: lokiUid,
      limit: 1,
    };
    if (probeWindow) {
      baseArgs.startRfc3339 = probeWindow.startRfc3339;
      baseArgs.endRfc3339 = probeWindow.endRfc3339;
    }

    // Test each candidate with a small query (limit 1) to see if it returns anything
    for (const candidate of unique) {
      try {
        const result = await this.mcp.callTool("query_loki_logs", {
          ...baseArgs,
          logql: candidate.selector,
        });
        // Check if we got actual log lines (non-empty, non-error result)
        if (result.text && result.text.length > 10 && !result.text.includes('"data":[]')) {
          log.info({ selector: candidate.selector, source: candidate.source }, "Found working log selector");
          return candidate.selector;
        }
      } catch (err) {
        log.debug({ selector: candidate.selector, err }, "Log selector probe failed");
      }
    }

    // Try regex fallback: service name as a regex across common labels
    const regexCandidates = [
      `{job=~".*${svcName}.*"}`,
      `{container_name=~".*${svcName}.*"}`,
    ];
    for (const selector of regexCandidates) {
      try {
        const result = await this.mcp.callTool("query_loki_logs", {
          ...baseArgs,
          logql: selector,
        });
        if (result.text && result.text.length > 10 && !result.text.includes('"data":[]')) {
          log.info({ selector }, "Found working log selector via regex");
          return selector;
        }
      } catch {
        // continue
      }
    }

    log.warn("No working log selector found for service");
    return "";
  }

  /**
   * Pre-fetch datasource UIDs so LLM phases don't waste iterations on list_datasources.
   */
  private async getDatasourceHint(): Promise<string> {
    const toolNames = this.mcp.getTools().map((t) => t.function.name);
    if (!toolNames.includes("list_datasources")) return "";

    try {
      const result = await this.mcp.callTool("list_datasources", {});
      const parsed = JSON.parse(result.text);
      // Handle both flat array and { datasources: [...] } response formats
      const datasources = (Array.isArray(parsed) ? parsed : parsed?.datasources ?? []) as Array<{ uid: string; name: string; type: string }>;
      const relevant = datasources.filter((d) => d.type === "prometheus" || d.type === "loki");
      if (relevant.length === 0) return "";
      const lines = relevant.map((d) => `- ${d.type}: datasourceUid="${d.uid}" (${d.name})`);
      return `Available datasources (use these UIDs directly, do NOT call list_datasources):\n${lines.join("\n")}\nIMPORTANT: You MUST use the exact datasourceUid values above (e.g. "${relevant[0]!.uid}") when calling query_prometheus or query_loki_logs. Do NOT use generic names like "prometheus" or "loki".`;
    } catch {
      return "";
    }
  }

  private async runPhase<T>(
    systemPrompt: string,
    userMessage: string,
    responseFormat: ResponseFormat,
    maxIterations = this.maxIterations,
    onTokenUsage?: (usage: TokenUsage) => void,
    onToolCall?: (name: string, args: Record<string, unknown>) => void,
    useTools = true,
    maxOutputTokens?: number,
    timeoutMs?: number,
  ): Promise<PhaseResult<T>> {
    // Exclude tools we pre-fetch (datasources, dashboards, panel queries)
    // and tools known to be unreliable (metric metadata returns 404, alert rules return 500).
    const excludedTools = new Set([
      "list_datasources",
      "search_dashboards",
      "get_dashboard_panel_queries",
      "get_dashboard_by_uid",
      // list_prometheus_metric_metadata: re-enabled — excluding it causes hallucinated calls that waste iterations
      "list_alert_rules",                 // Grafana-managed: empty; datasource-managed: 500
      "get_alert_rule_by_uid",
      "list_loki_label_names",            // Pre-fetched into context
      "list_loki_label_values",           // Rarely worth an iteration; labels provided in context
    ]);
    const tools = useTools
      ? this.mcp.getTools().filter((t) => !excludedTools.has(t.function.name))
      : [];
    const messages: Message[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];
    const phaseImages: PanelImage[] = [];
    const phaseToolData: string[] = [];

    const midpoint = Math.floor(maxIterations * 0.6);

    for (let i = 0; i < maxIterations; i++) {
      const isLastIteration = i === maxIterations - 1;
      // Last 2 iterations: withhold tools to force JSON output
      const isWindDown = i >= maxIterations - 2;
      const iterationTools = isWindDown ? [] : tools;

      // Midpoint nudge: remind the model to start wrapping up
      if (i === midpoint && tools.length > 0) {
        messages.push({
          role: "user",
          content: "You are past the halfway point of available iterations. Start wrapping up your investigation. After 1-2 more tool calls, respond with your JSON findings.",
        });
      }

      if (isWindDown && i > 0) {
        messages.push({
          role: "user",
          content: "You have used all available tool iterations. You MUST respond now with valid JSON matching the required schema. Do not call any more tools. Summarize what you found.",
        });
      }

      // Only send responseFormat when tools are empty — combining json_schema
      // with tools causes an output mode conflict where the model's attempt
      // to switch to JSON output gets misinterpreted as a tool call.
      const iterationFormat = iterationTools.length === 0 ? responseFormat : undefined;
      const response = await this.llm.chat(messages, iterationTools, { responseFormat: iterationFormat, maxOutputTokens, timeoutMs });

      if (response.usage) onTokenUsage?.(response.usage);

      if (response.type === "text") {
        logger.debug({ phaseImages: phaseImages.length, iteration: i }, "Phase complete");
        try {
          return { parsed: JSON.parse(response.content) as T, images: phaseImages, toolData: phaseToolData };
        } catch (err) {
          logger.warn(
            { err, contentLen: response.content.length, contentPreview: response.content.slice(0, 200) },
            "Failed to parse phase response as JSON, will retry with fresh prompt",
          );
          // Don't push the truncated content back — it can be 50k+ chars and crash the API.
          // Instead, use a fresh prompt with only the system prompt + a brief summary hint.
          try {
            const freshRetryMessages: Message[] = [
              { role: "system", content: systemPrompt },
              {
                role: "user",
                content: [
                  userMessage,
                  "",
                  "Your previous response was truncated. Produce a SHORTER, valid JSON response matching the schema.",
                  "Keep only the most important observations (max 5). Respond with ONLY valid JSON.",
                  "",
                  `Hint from truncated response: ${response.content.slice(0, 500)}`,
                ].join("\n"),
              },
            ];
            const retryResponse = await this.llm.chat(freshRetryMessages, [], { responseFormat, maxOutputTokens: maxOutputTokens ? Math.max(maxOutputTokens, 8192) : 8192, timeoutMs });
            if (retryResponse.usage) onTokenUsage?.(retryResponse.usage);
            if (retryResponse.type === "text") {
              return { parsed: JSON.parse(retryResponse.content) as T, images: phaseImages, toolData: phaseToolData };
            }
          } catch (retryErr) {
            logger.error({ retryErr }, "Fresh-prompt retry also failed");
          }
          // If retry also failed, return empty findings instead of crashing the pipeline
          logger.error("JSON parse retry exhausted, returning empty findings");
          return { parsed: JSON.parse("{}") as T, images: phaseImages, toolData: phaseToolData };
        }
      }

      // If LLM returned tool_calls during wind-down (tools withheld), skip execution
      if (isWindDown) {
        logger.warn({ iteration: i, callCount: response.calls.length }, "LLM returned tool calls during wind-down, forcing completion");
        break;
      }

      // Filter out hallucinated tool names (e.g. "<|constrain|>json") and cap per iteration
      const validToolNames = new Set(tools.map((t) => t.function.name));
      const validCalls = response.calls.filter((c) => validToolNames.has(c.name));
      if (validCalls.length < response.calls.length) {
        logger.warn({ hallucinated: response.calls.filter((c) => !validToolNames.has(c.name)).map((c) => c.name) }, "Filtered hallucinated tool calls");
      }
      const calls = validCalls.slice(0, MAX_TOOL_CALLS_PER_ITERATION);
      if (validCalls.length > MAX_TOOL_CALLS_PER_ITERATION) {
        logger.debug({ requested: validCalls.length, executed: calls.length }, "Capped tool calls per iteration");
      }

      // If all calls were hallucinated, the model is trying to output JSON but stuck in tool mode.
      // Break out of the loop and let the post-loop JSON extraction handle it.
      if (calls.length === 0) {
        logger.info({ iteration: i }, "All tool calls were hallucinated — model wants to produce JSON, breaking loop");
        break;
      }

      messages.push({
        role: "assistant",
        content: null,
        tool_calls: calls.map((c) => ({
          id: c.id, name: c.name, args: c.args,
        })),
      });

      const settled = await Promise.allSettled(
        calls.map((call) => {
          onToolCall?.(call.name, call.args);
          logger.debug({ toolName: call.name, isImageTool: call.name === "get_panel_image" }, "Tool call");
          return this.mcp.callTool(call.name, call.args);
        }),
      );
      for (let j = 0; j < calls.length; j++) {
        const outcome = settled[j]!;
        const call = calls[j]!;
        if (outcome.status === "fulfilled") {
          const text = truncateToolResponse(outcome.value.text, call.name);
          messages.push({
            role: "tool",
            content: text,
            tool_call_id: call.id,
          });
          phaseToolData.push(text);
          if (outcome.value.images.length > 0) {
            phaseImages.push(...outcome.value.images);
            logger.debug({ tool: call.name, newImages: outcome.value.images.length, totalPhaseImages: phaseImages.length }, "Images collected from tool call");
          }
        } else {
          messages.push({
            role: "tool",
            content: `[Transport Error] ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
            tool_call_id: call.id,
          });
        }
      }
    }

    // Post-loop extraction: The LLM burned through all iterations making tool calls
    // without producing JSON. Extract the data it gathered and create a fresh
    // summarization prompt that breaks the function-calling pattern.
    logger.warn("Phase loop exhausted, attempting forced JSON extraction via fresh prompt");

    // Collect tool response data from the conversation
    const toolData: string[] = [];
    for (const msg of messages) {
      if (msg.role === "tool" && msg.content && !msg.content.startsWith("[Error]") && !msg.content.startsWith("[Transport Error]")) {
        toolData.push(msg.content);
      }
    }

    const freshMessages: Message[] = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          userMessage,
          "",
          "DATA COLLECTED FROM TOOLS:",
          "---",
          toolData.join("\n---\n"),
          "---",
          "",
          "Based on the data above, produce your findings as valid JSON matching the required schema.",
          "Do NOT call any tools. Respond with ONLY valid JSON.",
        ].join("\n"),
      },
    ];

    const retryResponse = await this.llm.chat(freshMessages, [], { responseFormat, maxOutputTokens: maxOutputTokens ? Math.max(maxOutputTokens, 8192) : 8192 });
    if (retryResponse.usage) onTokenUsage?.(retryResponse.usage);

    if (retryResponse.type === "text") {
      logger.info({ phaseImages: phaseImages.length }, "Phase completed via fresh summarization prompt");
      try {
        return { parsed: JSON.parse(retryResponse.content) as T, images: phaseImages, toolData: phaseToolData };
      } catch (err) {
        logger.error({ err, contentLen: retryResponse.content.length, contentPreview: retryResponse.content.slice(0, 200) }, "Fresh prompt also failed to produce valid JSON");
      }
    }

    // If fresh prompt also failed, return empty findings instead of crashing
    logger.error("All extraction attempts failed, returning empty findings");
    return { parsed: JSON.parse("{}") as T, images: phaseImages, toolData: phaseToolData };
  }
}
