import type { ResponseFormat } from "../llm/openai.js";

// ── Phase prompts ─────────────────────────────────────────────────────────────

export const METRIC_DEEP_DIVE_PROMPT = `You are investigating a service anomaly. Your job is to deeply analyse the metrics for the affected service.

Strategy:
1. Use search_dashboards to find dashboards related to the service or mentioned by the user.
2. Use get_dashboard_by_uid to get the FULL dashboard JSON — this reveals the exact PromQL expressions used in each panel and related panels (Kafka, upstream/downstream services, etc.).
3. Query the key metrics using the EXACT PromQL from the dashboard panels, plus correlated panels (e.g. if there's a Kafka panel, query it too).
4. Capture panel screenshots with get_panel_image for the primary panel AND any correlated panels showing the anomaly.

Determine:
- What values are currently abnormal (include exact numbers and timestamps)
- What the baseline/normal range appears to be
- When the anomaly window started and ended
- Whether upstream/downstream services (Kafka, databases, etc.) show the same pattern

IMPORTANT tool parameter differences:
- query_prometheus uses "startTime" and "endTime" (supports RFC3339 or relative like "now-1h")
- query_loki_logs uses "startRfc3339" and "endRfc3339"
- get_panel_image uses timeRange: { from, to } (supports RFC3339 or relative)

You MUST capture at least one panel screenshot using get_panel_image with an appropriate timeRange that shows the anomaly clearly.

Respond ONLY with valid JSON matching the required schema. Do not include any other text.`;

export const LOG_CORRELATION_PROMPT = `You are investigating a service anomaly. Query the recent logs for the affected service using the available Loki query tools.

Strategy:
1. First query logs DURING the anomaly window. If no logs are found (common during outages where logging stops), this is itself evidence.
2. If the anomaly window returns empty, query the 5 minutes BEFORE the drop started — look for errors or warnings that preceded the outage.
3. Also query the 5 minutes AFTER recovery — look for reconnection messages, metadata resets, or startup logs that reveal what happened.
4. Use regex filters: |~ "(?i)(error|exception|warn|disconnect|timeout|refused|reset|restart|shutdown)"

5. If the service depends on Kafka/messaging, also check Kafka logs. Kafka may be under a DIFFERENT label (e.g. job="stream/stream-kafka-cluster-kafka" or similar). Use list_loki_label_values to find Kafka-related values in the "job" or "chart" labels.

Find:
- Recurring error messages or exception patterns
- Stack traces or relevant error details
- When the errors first appeared
- Recovery/reconnection log patterns (e.g. Kafka partition resets, reconnection messages)
- Upstream service errors (Kafka broker warnings, database errors)

IMPORTANT tool parameter differences:
- query_loki_logs uses "startRfc3339" and "endRfc3339" (RFC3339 format)
- query_prometheus uses "startTime" and "endTime"

For each error pattern found, include up to 5 raw log lines verbatim in the logSamples field.
Also generate 1-3 reusable Loki search terms (e.g. {job="myservice"} |= "exception") that a human could paste directly into Grafana Explore.
If no logs were found during the drop, note "No logs during outage window — logging stopped" as an errorPattern.

Respond ONLY with valid JSON matching the required schema. Do not include any other text.`;

export const INFRA_HEALTH_PROMPT = `You are investigating a service anomaly. Check the infrastructure health for the affected service.

Query Prometheus for (use "startTime"/"endTime" parameters, NOT "startRfc3339"):
- Pod restart counts: increase(kube_pod_container_status_restarts_total{container="SERVICE"}[1h])
- CPU usage: process_cpu_usage{chart="SERVICE"}
- JVM/memory: jvm_memory_used_bytes or container_memory_usage_bytes
- Node pressure metrics
- Check list_alert_rules for any active alerts

If the service depends on Kafka, also check:
- Kafka consumer lag: kafka_consumergroup_lag
- Kafka broker metrics: kafka_server_brokertopicmetrics_*

Respond ONLY with valid JSON matching the required schema. Do not include any other text.`;

export const RCA_SYNTHESIS_PROMPT = `You are performing root cause analysis. Based on the metric, log, and infrastructure findings provided, identify the root cause of the anomaly.
Determine the confidence level based on evidence quality:
- high: all 3 evidence types present and consistent
- medium: 2 of 3 evidence types, or suggestive but not conclusive
- low: only 1 evidence type, or contradictory findings

Extract any Grafana dashboard URLs found in the metric findings observations and include them in dashboardLinks.

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
