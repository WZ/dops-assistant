import type OpenAI from "openai";

// ── Phase prompts ─────────────────────────────────────────────────────────────

export const METRIC_DEEP_DIVE_PROMPT = `You are investigating a service anomaly. Your job is to deeply analyse the metrics for the affected service.
Query the metrics to determine:
- What values are currently abnormal (include exact numbers and timestamps)
- What the baseline/normal range appears to be
- When the anomaly window started

Respond ONLY with valid JSON matching the required schema. Do not include any other text.`;

export const LOG_CORRELATION_PROMPT = `You are investigating a service anomaly. Query the recent logs for the affected service to find:
- Recurring error messages or exception patterns
- Stack traces or relevant error details
- When the errors first appeared

Respond ONLY with valid JSON matching the required schema. Do not include any other text.`;

export const INFRA_HEALTH_PROMPT = `You are investigating a service anomaly. Check the infrastructure health for the affected service:
- pod restart counts, OOMKilled events, CrashLoopBackOff status
- Node CPU or memory pressure
- Recent Kubernetes events or active alerts

Respond ONLY with valid JSON matching the required schema. Do not include any other text.`;

export const RCA_SYNTHESIS_PROMPT = `You are performing root cause analysis. Based on the metric, log, and infrastructure findings provided, identify the root cause of the anomaly.
Determine the confidence level based on evidence quality:
- high: all 3 evidence types present and consistent
- medium: 2 of 3 evidence types, or suggestive but not conclusive
- low: only 1 evidence type, or contradictory findings

Respond ONLY with valid JSON matching the required schema. Do not include any other text.`;

export const INTENT_CLASSIFIER_PROMPT = `You are classifying a user message as either an investigation request or a regular question.
An investigation request asks you to diagnose, investigate, or find the root cause of an issue with a specific service.
A question asks for information, data, or status.

Extract the service name if mentioned. Common patterns: "investigate X", "why is X slow", "X is down", "what's wrong with X".

Respond ONLY with valid JSON matching the required schema. Do not include any other text.`;

// ── JSON schemas ──────────────────────────────────────────────────────────────

export const METRIC_FINDINGS_SCHEMA: OpenAI.ResponseFormatJSONSchema = {
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

export const LOG_FINDINGS_SCHEMA: OpenAI.ResponseFormatJSONSchema = {
  type: "json_schema",
  json_schema: {
    name: "log_findings",
    strict: true,
    schema: {
      type: "object",
      properties: {
        errorPatterns: { type: "array", items: { type: "string" } },
        stackTraces: { type: "array", items: { type: "string" } },
        firstOccurrence: { type: "string" },
      },
      required: ["errorPatterns", "stackTraces", "firstOccurrence"],
      additionalProperties: false,
    },
  },
};

export const INFRA_FINDINGS_SCHEMA: OpenAI.ResponseFormatJSONSchema = {
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

export const RCA_REPORT_SCHEMA: OpenAI.ResponseFormatJSONSchema = {
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
        recommendedActions: { type: "array", items: { type: "string" } },
        confidence: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["severity", "summary", "rootCause", "evidence", "recommendedActions", "confidence"],
      additionalProperties: false,
    },
  },
};

export const INTENT_RESPONSE_FORMAT: OpenAI.ResponseFormatJSONSchema = {
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
