import type { LlmClient, Message, ResponseFormat, TokenUsage } from "../llm/openai.js";
import type { McpClient, PanelImage } from "../mcp/client.js";
import type { ServiceConfig } from "../config/schema.js";
import type { AnomalyAssessment } from "./types.js";
import type { MetricFindings, LogFindings, InfraFindings, RcaReport } from "./rca-types.js";
import {
  METRIC_DEEP_DIVE_PROMPT,
  LOG_CORRELATION_PROMPT,
  INFRA_HEALTH_PROMPT,
  RCA_SYNTHESIS_PROMPT,
  METRIC_FINDINGS_SCHEMA,
  LOG_FINDINGS_SCHEMA,
  INFRA_FINDINGS_SCHEMA,
  RCA_REPORT_SCHEMA,
} from "./rca-prompts.js";
import { buildProactiveStructuredPrompt, ANOMALY_ASSESSMENT_RESPONSE_FORMAT, getTimeContext } from "./prompts.js";
import pino from "pino";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

const MAX_TOOL_RESPONSE_CHARS = 1500;
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

  if (text.length <= MAX_TOOL_RESPONSE_CHARS) return text;

  logger.debug({ toolName, originalLen: text.length, truncatedTo: MAX_TOOL_RESPONSE_CHARS }, "Truncating tool response");
  return text.slice(0, MAX_TOOL_RESPONSE_CHARS) + `\n... [truncated, ${text.length - MAX_TOOL_RESPONSE_CHARS} chars omitted]`;
}

export type PhaseResult<T> = {
  parsed: T;
  images: PanelImage[];
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
  ): Promise<RcaReport> {
    const log = logger.child({ component: "investigation", service: service.name, correlationId });
    const collectedImages: PanelImage[] = [];

    // Pre-fetch datasource UIDs so phases don't waste iterations on list_datasources
    const datasourceHint = await this.getDatasourceHint();
    log.debug({ datasourceHint }, "Pre-fetched datasource UIDs");

    // Phase 1: detect anomaly if not provided
    let anomaly = initialAnomaly;
    if (!anomaly) {
      log.debug("Running phase 1: anomaly detection");
      const phase1UserMessage = userMessage
        ? `${datasourceHint}\nUser reported: "${userMessage}"\n\nSearch for relevant dashboards and metrics to verify this report. Check service: ${service.name}`
        : `${datasourceHint}\nCheck service: ${service.name}`;
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
        rootCause: "No anomaly detected",
        evidence: { metrics: [], logs: [], infra: [] },
        dashboardLinks: [],
        panelImages: collectedImages,
        recommendedActions: [],
        confidence: "high",
        investigatedAt: new Date().toLocaleString(),
      };
    }

    log.debug("Running phases 2/3/4 + panel capture in parallel");
    const timeCtx = getTimeContext();
    const anomalyContext = `${datasourceHint}\n${timeCtx}\nPresent all timestamps in the user's local timezone, not UTC.\n\nKnown issue: ${anomaly.summary} (severity: ${anomaly.severity})`;
    const userContext = userMessage ? `\nUser reported: "${userMessage}"` : "";
    const metricMessage = `${anomalyContext}${userContext}\nService metrics: ${service.metrics.map((m) => m.query).join(", ")}`;
    const logMessage = `${anomalyContext}${userContext}\nLog labels: ${JSON.stringify(service.logLabels)}`;
    const infraMessage = `${anomalyContext}${userContext}\nService: ${service.name}`;

    const [metricResult, logResult, infraResult, panelCaptureResult] = await Promise.allSettled([
      this.runPhase<MetricFindings>(METRIC_DEEP_DIVE_PROMPT, metricMessage, METRIC_FINDINGS_SCHEMA, 5, onTokenUsage, onToolCall),
      this.runPhase<LogFindings>(LOG_CORRELATION_PROMPT, logMessage, LOG_FINDINGS_SCHEMA, 5, onTokenUsage, onToolCall),
      this.runPhase<InfraFindings>(INFRA_HEALTH_PROMPT, infraMessage, INFRA_FINDINGS_SCHEMA, 5, onTokenUsage, onToolCall),
      this.capturePanelImages(service.name, anomaly.summary, userMessage, onToolCall),
    ]);

    const metricFindings = metricResult.status === "fulfilled"
      ? metricResult.value.parsed
      : { observations: [], baseline: "unavailable", anomalyWindow: "unknown" };
    const logFindings = logResult.status === "fulfilled"
      ? logResult.value.parsed
      : { errorPatterns: [], stackTraces: [], logSamples: [], lokiSearchTerms: [], firstOccurrence: "unknown" };
    const infraFindings = infraResult.status === "fulfilled"
      ? infraResult.value.parsed
      : { podHealth: [], nodeHealth: [], recentEvents: [] };

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

    // Phase 5: synthesise
    log.debug("Running phase 5: synthesis");
    const synthesisMessage = [
      timeCtx,
      `Present all timestamps in the user's local timezone, not UTC.`,
      `Service: ${service.name}`,
      `Initial anomaly: ${JSON.stringify(anomaly)}`,
      `Metric findings: ${JSON.stringify(metricFindings)}`,
      `Log findings: ${JSON.stringify(logFindings)}`,
      `Infrastructure findings: ${JSON.stringify(infraFindings)}`,
    ].join("\n");

    const synthesisResult = await this.runPhase<Omit<RcaReport, "service" | "investigatedAt" | "panelImages">>(
      RCA_SYNTHESIS_PROMPT,
      synthesisMessage,
      RCA_REPORT_SCHEMA,
      3,
      onTokenUsage,
      onToolCall,
      false, // synthesis is pure reasoning, no tools needed
    );
    collectedImages.push(...synthesisResult.images);

    log.info({ totalPanelImages: collectedImages.length }, "Investigation complete");

    return {
      ...synthesisResult.parsed,
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
    // e.g. "(Ingestion Log Rate in Ingestion monitor)" → dashboardHint="Ingestion monitor", panelHint="Ingestion Log Rate"
    const { dashboardHint, panelHint } = extractDashboardPanelHints(userMessage, anomalySummary);
    log.debug({ dashboardHint, panelHint }, "Extracted dashboard/panel hints from query");

    // Build scoring tokens: service name tokens + query-derived tokens
    const serviceTokens = serviceName.toLowerCase().split(/[-_\s]+/);
    const dashboardHintTokens = dashboardHint ? dashboardHint.toLowerCase().split(/[-_\s]+/).filter((t) => t.length > 1) : [];
    const panelHintTokens = panelHint ? panelHint.toLowerCase().split(/[-_\s]+/).filter((t) => t.length > 1) : [];

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

    if (dashboards.length === 0) return images;

    // Step 2: sort dashboards by relevance
    // Dashboard hint match is weighted 3x higher than service token match
    dashboards.sort((a, b) => {
      const aTitle = a.title.toLowerCase();
      const bTitle = b.title.toLowerCase();
      const aServiceScore = serviceTokens.filter((t) => aTitle.includes(t)).length;
      const bServiceScore = serviceTokens.filter((t) => bTitle.includes(t)).length;
      const aHintScore = dashboardHintTokens.filter((t) => aTitle.includes(t)).length * 3;
      const bHintScore = dashboardHintTokens.filter((t) => bTitle.includes(t)).length * 3;
      return (bServiceScore + bHintScore) - (aServiceScore + aHintScore);
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

      // Rank panels: panel hint tokens weighted 3x, service tokens 1x
      const allPanelTokens = [...panelHintTokens, ...serviceTokens];
      metricPanels.sort((a, b) => {
        const aTitle = a.title.toLowerCase();
        const bTitle = b.title.toLowerCase();
        const aHintScore = panelHintTokens.filter((t) => aTitle.includes(t)).length * 3;
        const bHintScore = panelHintTokens.filter((t) => bTitle.includes(t)).length * 3;
        const aServiceScore = serviceTokens.filter((t) => aTitle.includes(t)).length;
        const bServiceScore = serviceTokens.filter((t) => bTitle.includes(t)).length;
        return (bHintScore + bServiceScore) - (aHintScore + aServiceScore);
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
   * Looks for date/time references; defaults to last 24h if none found.
   */
  private extractTimeRange(anomalySummary: string, userMessage?: string): { from: string; to: string } {
    const text = `${anomalySummary} ${userMessage ?? ""}`;

    // Try to find an ISO-ish date or "March 2nd" style references
    const dateMatch = text.match(/(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) {
      // Found a date like 2026-03-02 — show that full day
      return { from: `${dateMatch[1]}T00:00:00`, to: `${dateMatch[1]}T23:59:59` };
    }

    // Try "March 2nd", "Mar 2", etc.
    const monthNames: Record<string, string> = {
      january: "01", february: "02", march: "03", april: "04",
      may: "05", june: "06", july: "07", august: "08",
      september: "09", october: "10", november: "11", december: "12",
      jan: "01", feb: "02", mar: "03", apr: "04",
      jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
    };
    const namedDateMatch = text.match(
      /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?\b/i,
    );
    if (namedDateMatch) {
      const month = monthNames[namedDateMatch[1]!.toLowerCase()];
      const day = namedDateMatch[2]!.padStart(2, "0");
      const year = new Date().getFullYear();
      return { from: `${year}-${month}-${day}T00:00:00`, to: `${year}-${month}-${day}T23:59:59` };
    }

    // Try relative references
    if (/yesterday/i.test(text)) {
      return { from: "now-2d", to: "now" };
    }

    // Default: last 24h
    return { from: "now-24h", to: "now" };
  }

  /**
   * Pre-fetch datasource UIDs so LLM phases don't waste iterations on list_datasources.
   */
  private async getDatasourceHint(): Promise<string> {
    const toolNames = this.mcp.getTools().map((t) => t.function.name);
    if (!toolNames.includes("list_datasources")) return "";

    try {
      const result = await this.mcp.callTool("list_datasources", {});
      const datasources = JSON.parse(result.text) as Array<{ uid: string; name: string; type: string }>;
      const relevant = datasources.filter((d) => d.type === "prometheus" || d.type === "loki");
      if (relevant.length === 0) return "";
      const lines = relevant.map((d) => `- ${d.type}: datasourceUid="${d.uid}" (${d.name})`);
      return `Available datasources (use these UIDs directly, do NOT call list_datasources):\n${lines.join("\n")}`;
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
  ): Promise<PhaseResult<T>> {
    const tools = useTools ? this.mcp.getTools() : [];
    const messages: Message[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];
    const phaseImages: PanelImage[] = [];

    for (let i = 0; i < maxIterations; i++) {
      const isLastIteration = i === maxIterations - 1;
      // On the last iteration, withhold tools and inject a "respond now" nudge
      const iterationTools = isLastIteration ? [] : tools;

      if (isLastIteration && i > 0) {
        messages.push({
          role: "user",
          content: "You have used all available tool iterations. You MUST respond now with valid JSON matching the required schema. Do not call any more tools.",
        });
      }

      const response = await this.llm.chat(messages, iterationTools, { responseFormat });

      if (response.usage) onTokenUsage?.(response.usage);

      if (response.type === "text") {
        logger.debug({ phaseImages: phaseImages.length, iteration: i }, "Phase complete");
        try {
          return { parsed: JSON.parse(response.content) as T, images: phaseImages };
        } catch (err) {
          logger.error(
            { err, contentLen: response.content.length, contentPreview: response.content.slice(0, 200) },
            "Failed to parse phase response as JSON",
          );
          throw new Error(
            `Phase returned invalid JSON (${response.content.length} chars): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // If LLM returned tool_calls on the last iteration (despite no tools), skip execution
      if (isLastIteration) {
        logger.warn({ iteration: i, callCount: response.calls.length }, "LLM returned tool calls on final iteration, forcing completion");
        break;
      }

      // Cap tool calls per iteration to limit context growth
      const calls = response.calls.slice(0, MAX_TOOL_CALLS_PER_ITERATION);
      if (response.calls.length > MAX_TOOL_CALLS_PER_ITERATION) {
        logger.debug({ requested: response.calls.length, executed: calls.length }, "Capped tool calls per iteration");
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
        const call = response.calls[j]!;
        if (outcome.status === "fulfilled") {
          const text = truncateToolResponse(outcome.value.text, call.name);
          messages.push({
            role: "tool",
            content: text,
            tool_call_id: call.id,
          });
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

    // Post-loop retry: the LLM burned through all iterations without producing JSON.
    // Try up to 3 times, adding mock error responses when the model keeps returning tool_calls.
    logger.warn("Phase loop exhausted, attempting forced JSON extraction");
    for (let retry = 0; retry < 3; retry++) {
      messages.push({
        role: "user",
        content: "All tool iterations are exhausted. You MUST respond NOW with ONLY a valid JSON object matching the required schema. Do NOT call any tools. Do NOT include any text outside the JSON.",
      });
      const retryResponse = await this.llm.chat(messages, [], { responseFormat });
      if (retryResponse.usage) onTokenUsage?.(retryResponse.usage);

      if (retryResponse.type === "text") {
        logger.info({ phaseImages: phaseImages.length, retry }, "Phase completed via post-loop retry");
        try {
          return { parsed: JSON.parse(retryResponse.content) as T, images: phaseImages };
        } catch (err) {
          throw new Error(
            `Phase returned invalid JSON on retry (${retryResponse.content.length} chars): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Model still wants tools — add mock error responses so it knows tools are gone
      logger.debug({ retry, callCount: retryResponse.calls.length }, "Model returned tool_calls on retry, injecting errors");
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: retryResponse.calls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
      });
      for (const call of retryResponse.calls) {
        messages.push({
          role: "tool",
          content: "[Error] No tools available. You must respond with JSON now.",
          tool_call_id: call.id,
        });
      }
    }

    throw new Error(`Phase did not complete within ${maxIterations} iterations (model refuses to produce JSON)`);
  }
}
