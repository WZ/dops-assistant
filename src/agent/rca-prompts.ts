import type { ResponseFormat } from "../llm/openai.js";

// ── Phase prompts ─────────────────────────────────────────────────────────────

export const METRIC_DEEP_DIVE_PROMPT = `You are investigating a service anomaly. Analyse the metrics for the affected service.

1. search_dashboards to find relevant dashboards.
2. get_dashboard_by_uid to get panel details (PromQL, related panels).
3. query_prometheus with the exact PromQL from dashboard panels. Use "startTime"/"endTime" params.

Determine: abnormal values (exact numbers + timestamps), baseline range, anomaly window, upstream/downstream patterns.

Be efficient — make at most 3 tool calls per round. Respond ONLY with valid JSON matching the required schema.`;

export const LOG_CORRELATION_PROMPT = `You are investigating a service anomaly. Query logs using Loki tools.

1. Query logs DURING the anomaly window. No logs = evidence of outage.
2. If empty, query 5 min BEFORE and AFTER the anomaly for errors/recovery patterns.
3. Use regex: |~ "(?i)(error|exception|warn|disconnect|timeout|refused|reset|restart)"
4. query_loki_logs uses "startRfc3339"/"endRfc3339" (RFC3339 format).

Include: error patterns, up to 5 raw log samples, 1-3 reusable Loki search terms, first occurrence time.
Be efficient — make at most 3 tool calls per round. Respond ONLY with valid JSON matching the required schema.`;

export const INFRA_HEALTH_PROMPT = `You are investigating a service anomaly. Check infrastructure health.

Query Prometheus (use "startTime"/"endTime") for: pod restarts, CPU usage, memory, active alerts (list_alert_rules).

Be efficient — make at most 3 tool calls per round. Respond ONLY with valid JSON matching the required schema.`;

export const RCA_SYNTHESIS_PROMPT = `You are performing root cause analysis. Based on the metric, log, and infrastructure findings provided, identify the root cause of the anomaly.
Determine the confidence level based on evidence quality:
- high: all 3 evidence types present and consistent
- medium: 2 of 3 evidence types, or suggestive but not conclusive
- low: only 1 evidence type, or contradictory findings

Extract any Grafana dashboard URLs found in the metric findings observations and include them in dashboardLinks.

FORMATTING: Do NOT use markdown tables in the summary or any text fields. Use bullet lists or plain text instead. The output will be rendered in a terminal that does not support tables.

Respond ONLY with valid JSON matching the required schema. Do not include any other text.`;

export const INTENT_CLASSIFIER_PROMPT = `You are classifying a user message as either an investigation request or a regular question.
An investigation request asks you to diagnose, investigate, or find the root cause of an issue with a specific service.
A question asks for information, data, or status.

Extract the service name if mentioned. Common patterns: "investigate X", "why is X slow", "X is down", "what's wrong with X".

Respond ONLY with valid JSON matching the required schema. Do not include any other text.`;

// ── JSON schemas ──────────────────────────────────────────────────────────────

export const METRIC_FINDINGS_SCHEMA: ResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "metric_findings",
    strict: true,
    schema: {
      type: "object",
      properties: {
        observations: { type: "array", items: { type: "string" } },
        baseline: { type: "string" },
        anomalyWindow: { type: "string" },
      },
      required: ["observations", "baseline", "anomalyWindow"],
      additionalProperties: false,
    },
  },
};

export const LOG_FINDINGS_SCHEMA: ResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "log_findings",
    strict: true,
    schema: {
      type: "object",
      properties: {
        errorPatterns: { type: "array", items: { type: "string" } },
        stackTraces: { type: "array", items: { type: "string" } },
        logSamples: { type: "array", items: { type: "string" } },
        lokiSearchTerms: { type: "array", items: { type: "string" } },
        firstOccurrence: { type: "string" },
      },
      required: ["errorPatterns", "stackTraces", "logSamples", "lokiSearchTerms", "firstOccurrence"],
      additionalProperties: false,
    },
  },
};

export const INFRA_FINDINGS_SCHEMA: ResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "infra_findings",
    strict: true,
    schema: {
      type: "object",
      properties: {
        podHealth: { type: "array", items: { type: "string" } },
        nodeHealth: { type: "array", items: { type: "string" } },
        recentEvents: { type: "array", items: { type: "string" } },
      },
      required: ["podHealth", "nodeHealth", "recentEvents"],
      additionalProperties: false,
    },
  },
};

export const RCA_REPORT_SCHEMA: ResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "rca_report",
    strict: true,
    schema: {
      type: "object",
      properties: {
        severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
        summary: { type: "string" },
        rootCause: { type: "string" },
        evidence: {
          type: "object",
          properties: {
            metrics: { type: "array", items: { type: "string" } },
            logs: { type: "array", items: { type: "string" } },
            infra: { type: "array", items: { type: "string" } },
          },
          required: ["metrics", "logs", "infra"],
          additionalProperties: false,
        },
        dashboardLinks: { type: "array", items: { type: "string" } },
        recommendedActions: { type: "array", items: { type: "string" } },
        confidence: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["severity", "summary", "rootCause", "evidence", "dashboardLinks", "recommendedActions", "confidence"],
      additionalProperties: false,
    },
  },
};

export const INTENT_RESPONSE_FORMAT: ResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "intent_classification",
    strict: true,
    schema: {
      type: "object",
      properties: {
        intent: { type: "string", enum: ["investigation", "question"] },
        service: { type: "string" },
      },
      required: ["intent", "service"],
      additionalProperties: false,
    },
  },
};
