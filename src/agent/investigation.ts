import type { LlmClient, Message, TokenUsage } from "../llm/openai.js";
import type { McpClient, PanelImage } from "../mcp/client.js";
import type { ServiceConfig } from "../config/schema.js";
import type { AnomalyAssessment } from "./types.js";
import type { MetricFindings, LogFindings, InfraFindings, RcaReport } from "./rca-types.js";
import type OpenAI from "openai";
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
import { buildProactiveStructuredPrompt, ANOMALY_ASSESSMENT_RESPONSE_FORMAT } from "./prompts.js";
import pino from "pino";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

const MAX_TOOL_RESPONSE_CHARS = 4000;

/**
 * Truncate oversized tool responses to prevent context bloat.
 * For get_dashboard_by_uid, extract only panel id/title/type.
 */
function truncateToolResponse(text: string, toolName: string): string {
  if (text.length <= MAX_TOOL_RESPONSE_CHARS) return text;

  if (toolName === "get_dashboard_by_uid") {
    try {
      const data = JSON.parse(text);
      const panels = (data.dashboard?.panels ?? data.panels ?? []) as Array<{
        id: number; title: string; type: string;
      }>;
      const summary = {
        title: data.dashboard?.title ?? data.title,
        uid: data.dashboard?.uid ?? data.meta?.slug,
        panels: panels.map((p) => ({ id: p.id, title: p.title, type: p.type })),
      };
      return JSON.stringify(summary);
    } catch {
      // fall through to generic truncation
    }
  }

  logger.debug({ toolName, originalLen: text.length, truncatedTo: MAX_TOOL_RESPONSE_CHARS }, "Truncating tool response");
  return text.slice(0, MAX_TOOL_RESPONSE_CHARS) + `\n... [truncated, ${text.length - MAX_TOOL_RESPONSE_CHARS} chars omitted]`;
}

export type PhaseResult<T> = {
  parsed: T;
  images: PanelImage[];
};

export type InvestigationResult = RcaReport & {
  panelImages: PanelImage[];
};

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
    onToolCall?: (name: string, args: Record<string, unknown>) => void,
  ): Promise<InvestigationResult> {
    const log = logger.child({ component: "investigation", service: service.name, correlationId });
    const collectedImages: PanelImage[] = [];

    // Phase 1: detect anomaly if not provided
    let anomaly = initialAnomaly;
    if (!anomaly) {
      log.debug("Running phase 1: anomaly detection");
      const result = await this.runPhase<AnomalyAssessment>(
        buildProactiveStructuredPrompt([service]),
        `Check service: ${service.name}`,
        ANOMALY_ASSESSMENT_RESPONSE_FORMAT,
        undefined,
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
        recommendedActions: [],
        confidence: "high",
        investigatedAt: new Date().toISOString(),
        panelImages: collectedImages,
      };
    }

    log.debug("Running phases 2/3/4 in parallel");
    const anomalyContext = `Known issue: ${anomaly.summary} (severity: ${anomaly.severity})`;
    const metricMessage = `${anomalyContext}\nService metrics: ${service.metrics.map((m) => m.query).join(", ")}`;
    const logMessage = `${anomalyContext}\nLog labels: ${JSON.stringify(service.logLabels)}`;
    const infraMessage = `${anomalyContext}\nService: ${service.name}`;

    const [metricResult, logResult, infraResult] = await Promise.allSettled([
      this.runPhase<MetricFindings>(METRIC_DEEP_DIVE_PROMPT, metricMessage, METRIC_FINDINGS_SCHEMA, undefined, onTokenUsage, onToolCall),
      this.runPhase<LogFindings>(LOG_CORRELATION_PROMPT, logMessage, LOG_FINDINGS_SCHEMA, undefined, onTokenUsage, onToolCall),
      this.runPhase<InfraFindings>(INFRA_HEALTH_PROMPT, infraMessage, INFRA_FINDINGS_SCHEMA, undefined, onTokenUsage, onToolCall),
    ]);

    const metricFindings = metricResult.status === "fulfilled"
      ? metricResult.value.parsed
      : { observations: [], baseline: "unavailable", anomalyWindow: "unknown" };
    const logFindings = logResult.status === "fulfilled"
      ? logResult.value.parsed
      : { errorPatterns: [], stackTraces: [], firstOccurrence: "unknown" };
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

    if (metricResult.status === "rejected") log.warn({ err: metricResult.reason }, "Metric phase failed");
    if (logResult.status === "rejected") log.warn({ err: logResult.reason }, "Log phase failed");
    if (infraResult.status === "rejected") log.warn({ err: infraResult.reason }, "Infra phase failed");

    // Phase 5: synthesise
    log.debug("Running phase 5: synthesis");
    const synthesisMessage = [
      `Service: ${service.name}`,
      `Initial anomaly: ${JSON.stringify(anomaly)}`,
      `Metric findings: ${JSON.stringify(metricFindings)}`,
      `Log findings: ${JSON.stringify(logFindings)}`,
      `Infrastructure findings: ${JSON.stringify(infraFindings)}`,
    ].join("\n");

    const synthesisResult = await this.runPhase<Omit<RcaReport, "service" | "investigatedAt">>(
      RCA_SYNTHESIS_PROMPT,
      synthesisMessage,
      RCA_REPORT_SCHEMA,
      3,
      onTokenUsage,
      onToolCall,
    );
    collectedImages.push(...synthesisResult.images);

    log.info({ totalPanelImages: collectedImages.length }, "Investigation complete");

    return {
      ...synthesisResult.parsed,
      service: service.name,
      investigatedAt: new Date().toISOString(),
      panelImages: collectedImages,
    };
  }

  private async runPhase<T>(
    systemPrompt: string,
    userMessage: string,
    responseFormat: OpenAI.ResponseFormatJSONSchema,
    maxIterations = this.maxIterations,
    onTokenUsage?: (usage: TokenUsage) => void,
    onToolCall?: (name: string, args: Record<string, unknown>) => void,
  ): Promise<PhaseResult<T>> {
    const tools = this.mcp.getTools();
    const messages: Message[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];
    const phaseImages: PanelImage[] = [];

    for (let i = 0; i < maxIterations; i++) {
      const response = await this.llm.chat(messages, tools, { responseFormat });

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

      messages.push({
        role: "assistant",
        content: null,
        tool_calls: response.calls.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      });

      const settled = await Promise.allSettled(
        response.calls.map((call) => {
          onToolCall?.(call.name, call.args);
          logger.debug({ toolName: call.name, isImageTool: call.name === "get_panel_image" }, "Tool call");
          return this.mcp.callTool(call.name, call.args);
        }),
      );
      for (let j = 0; j < response.calls.length; j++) {
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

    throw new Error(`Phase did not complete within ${maxIterations} iterations`);
  }
}
