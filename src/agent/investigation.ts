import type { LlmClient, Message, TokenUsage } from "../llm/openai.js";
import type { McpClient } from "../mcp/client.js";
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
  ): Promise<RcaReport> {
    const log = logger.child({ component: "investigation", service: service.name, correlationId });

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
      );
      anomaly = result;
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
      };
    }

    log.debug("Running phases 2/3/4 in parallel");
    const anomalyContext = `Known issue: ${anomaly.summary} (severity: ${anomaly.severity})`;
    const metricMessage = `${anomalyContext}\nService metrics: ${service.metrics.map((m) => m.query).join(", ")}`;
    const logMessage = `${anomalyContext}\nLog labels: ${JSON.stringify(service.logLabels)}`;
    const infraMessage = `${anomalyContext}\nService: ${service.name}`;

    const [metricResult, logResult, infraResult] = await Promise.allSettled([
      this.runPhase<MetricFindings>(METRIC_DEEP_DIVE_PROMPT, metricMessage, METRIC_FINDINGS_SCHEMA, undefined, onTokenUsage),
      this.runPhase<LogFindings>(LOG_CORRELATION_PROMPT, logMessage, LOG_FINDINGS_SCHEMA, undefined, onTokenUsage),
      this.runPhase<InfraFindings>(INFRA_HEALTH_PROMPT, infraMessage, INFRA_FINDINGS_SCHEMA, undefined, onTokenUsage),
    ]);

    const metricFindings = metricResult.status === "fulfilled"
      ? metricResult.value
      : { observations: [], baseline: "unavailable", anomalyWindow: "unknown" };
    const logFindings = logResult.status === "fulfilled"
      ? logResult.value
      : { errorPatterns: [], stackTraces: [], firstOccurrence: "unknown" };
    const infraFindings = infraResult.status === "fulfilled"
      ? infraResult.value
      : { podHealth: [], nodeHealth: [], recentEvents: [] };

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

    const partial = await this.runPhase<Omit<RcaReport, "service" | "investigatedAt">>(
      RCA_SYNTHESIS_PROMPT,
      synthesisMessage,
      RCA_REPORT_SCHEMA,
      3,
      onTokenUsage,
    );

    return {
      ...partial,
      service: service.name,
      investigatedAt: new Date().toISOString(),
    };
  }

  private async runPhase<T>(
    systemPrompt: string,
    userMessage: string,
    responseFormat: OpenAI.ResponseFormatJSONSchema,
    maxIterations = this.maxIterations,
    onTokenUsage?: (usage: TokenUsage) => void,
  ): Promise<T> {
    const tools = this.mcp.getTools();
    const messages: Message[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    for (let i = 0; i < maxIterations; i++) {
      const response = await this.llm.chat(messages, tools, { responseFormat });

      if (response.usage) onTokenUsage?.(response.usage);

      if (response.type === "text") {
        return JSON.parse(response.content) as T;
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
        response.calls.map((call) => this.mcp.callTool(call.name, call.args)),
      );
      for (let j = 0; j < response.calls.length; j++) {
        const outcome = settled[j]!;
        const call = response.calls[j]!;
        messages.push({
          role: "tool",
          content: outcome.status === "fulfilled"
            ? outcome.value
            : `[Transport Error] ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
          tool_call_id: call.id,
        });
      }
    }

    throw new Error(`Phase did not complete within ${maxIterations} iterations`);
  }
}
