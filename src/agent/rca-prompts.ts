import type { ResponseFormat } from "../llm/openai.js";
import type { ServiceConfig } from "../config/schema.js";

// ── Phase prompt builders ────────────────────────────────────────────────────

export function buildMetricDeepDivePrompt(service: ServiceConfig, anomalyContext: string, planFocus?: string[]): string {
  const metricList = service.metrics
    .map((m) => `- ${m.description}: \`${m.query}\``)
    .join("\n");

  const focusSection = planFocus?.length
    ? `\nPLANNED FOCUS AREAS:\n${planFocus.map((f) => `- ${f}`).join("\n")}`
    : "";

  return `You are investigating a service anomaly for "${service.name}".

KNOWN ISSUE: ${anomalyContext}

SERVICE METRICS TO CHECK:
${metricList || "(no pre-configured metrics)"}
${focusSection}

INVESTIGATION STEPS:
1. The user message contains PRE-FETCHED panel queries from relevant dashboards. Use these PromQL expressions directly with query_prometheus — do NOT call get_dashboard_by_uid or get_dashboard_panel_queries.
2. CRITICAL FIRST STEP: Run a RANGE query covering the FULL investigation window to see the trend over time. This is mandatory — you MUST see the historical shape of the data before concluding anything.
   Example: queryType="range", startTime="now-7d", endTime="now", stepSeconds=3600 (1h steps for 7-day window) or stepSeconds=900 (15m steps for 1-day window).
3. Look at the range query results for level changes, drops, spikes, or gaps. Compare different time segments (e.g. first half vs second half of the window).
4. Only AFTER seeing the range data, run additional queries to zoom into anomalous periods you found.
5. Also run the service's configured PromQL queries above if they differ from the panel queries.

IMPORTANT query_prometheus parameters:
- queryType "range" (required for trend detection): needs startTime, endTime, stepSeconds. Choose stepSeconds based on window: 7d→3600, 1d→900, 6h→300.
- queryType "instant": only shows current value, useless for detecting past anomalies. Only use for current health check AFTER range query.
- startTime/endTime: use relative (e.g. "now-7d") or RFC3339 format.

For each observation, provide the EXACT metric queried, current value, baseline value, and timestamp.
Keep observations concise — max 8 observations. Summary should be 1-3 sentences.
Be efficient — make at most 3 tool calls per round. Respond ONLY with valid JSON matching the required schema.`;
}

export function buildLogCorrelationPrompt(service: ServiceConfig, anomalyContext: string, planFocus?: string[]): string {
  const logLabels = JSON.stringify(service.logLabels);

  const focusSection = planFocus?.length
    ? `\nPLANNED FOCUS AREAS:\n${planFocus.map((f) => `- ${f}`).join("\n")}`
    : "";

  return `You are investigating a service anomaly for "${service.name}". Query logs using Loki tools.

KNOWN ISSUE: ${anomalyContext}

SERVICE LOG LABELS: ${logLabels}
${focusSection}

INVESTIGATION STEPS:
1. FIRST: Check the user message for a VALIDATED LOG SELECTOR. If one is provided, use it as your primary selector — it has been pre-tested and confirmed to return real logs. The configured SERVICE LOG LABELS above may NOT work.
2. Query logs DURING the anomaly window using the validated selector (or configured labels as fallback). No logs = evidence of outage.
3. If empty with configured labels, try alternative selectors: {job="default/SERVICE_NAME"}, {container_name="SERVICE_NAME"}, {chart="SERVICE_NAME"}. The "job" label often uses "namespace/service-name" format.
4. Use regex: |~ "(?i)(error|exception|warn|disconnect|timeout|refused|reset|restart|kill|oom|crash|fail)"
5. query_loki_logs uses "startRfc3339"/"endRfc3339" (RFC3339 format, e.g. "2026-03-07T00:00:00Z"). Always use limit=30 or higher to capture enough evidence.
6. Common Loki label names in this environment: "app_fortidata_name" (service name), "chart" (Helm chart), "namespace", "container_name", "job" (format: "namespace/name"), "host", "instance". Use these if the configured labels don't return results.
7. IMPORTANT: For each error pattern found, capture 5-8 ACTUAL log lines verbatim in the "sampleLines" array. These must be real log lines from Loki, not summaries. Include the full line with timestamp, level, and message.
8. If no errors are found, query without the error regex to see if ANY logs exist for this service during the window. Zero logs is itself significant evidence.

IMPORTANT: Only report VERIFIABLE counts. The "count" field must reflect the number of matching lines actually returned by Loki, not an extrapolated estimate. If Loki returned 15 error lines, report count as "15", not "hundreds" or "~500".

For each observation, provide the error pattern, occurrence count, first/last seen timestamps, a brief sample, AND an array of actual log line samples (sampleLines, max 8 lines each).
Keep observations concise — max 8 observations. Summary should be 1-3 sentences.
Be efficient — make at most 3 tool calls per round. Respond ONLY with valid JSON matching the required schema.`;
}

export function buildInfraHealthPrompt(service: ServiceConfig, anomalyContext: string, planFocus?: string[]): string {
  const focusSection = planFocus?.length
    ? `\nPLANNED FOCUS AREAS:\n${planFocus.map((f) => `- ${f}`).join("\n")}`
    : "";

  return `You are investigating a service anomaly for "${service.name}". Check infrastructure health.

KNOWN ISSUE: ${anomalyContext}
${focusSection}

INVESTIGATION STEPS:
1. The user message contains PRE-FETCHED panel queries from relevant dashboards. Use these PromQL expressions directly — do NOT call get_dashboard_by_uid or get_dashboard_panel_queries.
2. Query Prometheus for pod restarts, CPU usage, memory using queries from the System/Services dashboards.
3. Check for OOMKilled, CrashLoopBackOff, or other pod issues.
4. Check node-level metrics (CPU, memory, disk) for the hosts running the service.
IMPORTANT: query_prometheus requires "startTime" (e.g. "now-1h"). Use queryType "instant" for current values, "range" for time series (also requires "endTime" and "stepSeconds").

For each observation, provide the resource name, status, details, and timestamp.
Keep observations concise — max 8 observations. Summary should be 1-3 sentences.
Be efficient — make at most 3 tool calls per round. Respond ONLY with valid JSON matching the required schema.`;
}

// ── Planning & Reflection prompts ────────────────────────────────────────────

export const INVESTIGATION_PLAN_PROMPT = `Based on the detected anomaly, create a focused investigation plan.
Determine what specific metrics, logs, and infrastructure checks will be most relevant.
Consider: What are the most likely root causes? What evidence would confirm or rule out each?

Respond ONLY with valid JSON matching the required schema.`;

export const RCA_REFLECTION_PROMPT = `You are reviewing an RCA report for quality and accuracy.

Evaluate the report against the evidence provided:
1. Does the root cause EXPLAIN all the observed symptoms?
2. Is the TRIGGER (proximate cause) clearly separated from the ROOT CAUSE (systemic vulnerability)?
3. Is there contradictory evidence that was ignored?
4. Is the SEVERITY consistent with the findings? If the report says "no anomaly" or "within normal range" but severity is medium/high/critical, that is a BUG — revise severity to "low".
5. Are the recommended actions specific and actionable?
6. Is the confidence level justified by the evidence quality?
7. Are there alternative explanations that should be considered?

If the report has issues, provide corrections in the revised fields and list the issues found.
If the report is sound, return it unchanged (copy rootCause to revisedRootCause, trigger to revisedTrigger, summary to revisedSummary, confidence to revisedConfidence, severity to revisedSeverity) with empty issues array.

CRITICAL: Be concise. validationNotes should be 1-3 sentences. Each issue should be 1 sentence. Revised fields should be similar length to originals.
Respond ONLY with valid JSON matching the required schema. Do not include any explanatory text outside the JSON.`;

// ── Synthesis prompt (enhanced with chain-of-thought) ────────────────────────

export const RCA_SYNTHESIS_PROMPT = `You are performing root cause analysis following SRE postmortem standards. You have metric, log, and infrastructure findings plus a chronological timeline.

REASONING PROCESS — follow these steps:
1. TIMELINE: Order all events chronologically. Identify the first anomalous signal and the cascade that followed.
2. IMPACT: Quantify the blast radius — duration, affected metrics/users, severity of degradation.
3. TRIGGER vs ROOT CAUSE: The trigger is the proximate event that set off the incident (e.g. "kafka-5 disk filled up"). The root cause is the systemic vulnerability that allowed the trigger to cause damage (e.g. "no log rotation configured for Kafka audit logs"). These MUST be different — if you can only identify one, put it in trigger and set rootCause to "Under investigation".
4. CONTRIBUTING FACTORS: Other conditions that enabled or worsened the incident (e.g. "replication factor of 1", "no disk usage alerting"). These are NOT the root cause but made the impact worse.
5. VALIDATE: Does your causal chain explain ALL the evidence? Flag any contradictions.
6. CONCLUDE: State severity, confidence, and recommended actions.

Severity calibration:
- low: No anomaly found, or only cosmetic/informational findings with no user impact. USE THIS when all metrics are within normal range and no outage or degradation occurred.
- medium: Minor degradation detected (e.g. elevated latency, increased error rate) but service remains functional.
- high: Significant impact — service degradation, partial outage, data loss, or sustained error spike affecting users.
- critical: Full outage, complete data loss, or cascading failure across multiple services.
IMPORTANT: If the evidence shows NO anomaly, severity MUST be "low". Do NOT assign high severity to normal operations.

Confidence calibration:
- high: 3+ evidence types with corroborating timestamps, clear causal chain. Also use "high" when you are confident NO anomaly exists (all metrics normal, no errors).
- medium: 2 evidence types, or timestamps don't perfectly align
- low: 1 evidence type, speculative causation, or contradictory evidence

Extract any Grafana dashboard URLs found in the metric findings observations and include them in dashboardLinks.

TIMELINE: Include 3-8 events in chronological order. Each: timestamp + 1-sentence description. Start with first anomalous signal, end with resolution or current state.

IMPACT: duration = how long (e.g. "47 minutes (14:02–14:49 UTC)"). description = 1-2 sentences quantifying the blast radius.

SIZING:
- Summary: 2-4 sentences. Include the specific time window and quantify the impact.
- Trigger: 1-2 sentences. The specific event that initiated the incident.
- RootCause: 1-3 sentences. The systemic vulnerability that allowed the trigger to cause damage.
- Contributing factors: 1-4 items, each 1 sentence.
- Each recommended action: 1 sentence max. Max 5 actions. Max 5 dashboard links.

FORMATTING: Do NOT use markdown tables. Use bullet lists or plain text. Output renders in a terminal.

CRITICAL — EVIDENCE REQUIREMENTS (do NOT skip any category):
- evidence.metrics: MUST include 3-5 items. Each: metric name, anomalous value vs baseline, timestamp. Example: "ingestion_rate spiked to 45k/s (baseline: 12k/s) at 2026-03-03T14:00Z"
- evidence.logs: MUST include 3-5 items copied VERBATIM from the sampleLines in the log findings. Copy the FULL log line including timestamp, level, and message. Example: "2026-03-03 14:12:03 WARN NetworkClient: Error connecting to kafka-5:9092 (repeated 23 times)". If log findings have ANY sampleLines, you MUST include them. An empty logs array when log findings exist is a BUG.
- evidence.infra: Include 1-3 items if any infra anomalies found.
- If a category has NO findings at all, use an empty array — do NOT fabricate evidence.

Respond ONLY with valid JSON matching the required schema. Do not include any other text.`;

export function buildIntentClassifierPrompt(serviceNames?: string[]): string {
  const serviceList = serviceNames?.length
    ? `\nFor reference, known services include: ${serviceNames.join(", ")}\nIf the user mentions a service or component, extract the key identifying term (e.g. "ingestion log rate drop" → "ingestion", "kudu tserver is slow" → "kudu-tserver"). Prefer using a known service name if it clearly matches, but you may also extract the user's own wording.`
    : "";

  return `You are classifying a user message as either an "investigation" request or a "question".

CLASSIFY AS "investigation" when the user:
- Reports a problem, symptom, or error (slow, down, failing, errors, spike, drop, timeout, OOM, crash)
- Asks to investigate, diagnose, troubleshoot, or check a service/component
- Describes an anomaly or unexpected behavior
- Asks to check health, performance, or status of a specific service
- Uses words like: investigate, check, diagnose, troubleshoot, look into, what's wrong, why is

CLASSIFY AS "question" when the user:
- Asks for information without implying a problem ("what dashboards do we have?", "list services")
- Asks how something works ("how does ingestion work?")
- Asks for general status without concern ("show me the current metrics")

EXAMPLES:
- "data-server queries are running slow" → investigation, service: "data-server"
- "check ClickHouse cluster health" → investigation, service: "clickhouse"
- "data-server is throwing ClickHouse connection errors" → investigation, service: "data-server"
- "something seems off with the system, investigate" → investigation, service: ""
- "are there any issues with the Kafka cluster?" → investigation, service: "kafka"
- "check CPU usage across all nodes" → investigation, service: ""
- "what dashboards do we have available?" → question, service: ""
- "how does the ingestion pipeline work?" → question, service: ""

When in doubt, classify as "investigation" — it is better to investigate and find nothing than to miss a real issue.
${serviceList}
Extract the service name if mentioned. Respond ONLY with valid JSON matching the required schema.`;
}

// ── JSON schemas ──────────────────────────────────────────────────────────────

const metricObservationSchema = {
  type: "object" as const,
  properties: {
    metric: { type: "string" as const },
    currentValue: { type: "string" as const },
    baselineValue: { type: "string" as const },
    timestamp: { type: "string" as const },
    severity: { type: "string" as const, enum: ["normal", "warning", "critical"] },
  },
  required: ["metric", "currentValue", "baselineValue", "timestamp", "severity"] as const,
  additionalProperties: false as const,
};

export const METRIC_FINDINGS_SCHEMA: ResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "metric_findings",
    strict: true,
    schema: {
      type: "object",
      properties: {
        observations: { type: "array", items: metricObservationSchema },
        anomalyWindow: { type: "string" },
        summary: { type: "string" },
      },
      required: ["observations", "anomalyWindow", "summary"],
      additionalProperties: false,
    },
  },
};

const logObservationSchema = {
  type: "object" as const,
  properties: {
    pattern: { type: "string" as const },
    count: { type: "string" as const },
    firstSeen: { type: "string" as const },
    lastSeen: { type: "string" as const },
    sample: { type: "string" as const },
    sampleLines: { type: "array" as const, items: { type: "string" as const } },
  },
  required: ["pattern", "count", "firstSeen", "lastSeen", "sample", "sampleLines"] as const,
  additionalProperties: false as const,
};

export const LOG_FINDINGS_SCHEMA: ResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "log_findings",
    strict: true,
    schema: {
      type: "object",
      properties: {
        observations: { type: "array", items: logObservationSchema },
        summary: { type: "string" },
      },
      required: ["observations", "summary"],
      additionalProperties: false,
    },
  },
};

const infraObservationSchema = {
  type: "object" as const,
  properties: {
    resource: { type: "string" as const },
    status: { type: "string" as const },
    detail: { type: "string" as const },
    timestamp: { type: "string" as const },
  },
  required: ["resource", "status", "detail", "timestamp"] as const,
  additionalProperties: false as const,
};

export const INFRA_FINDINGS_SCHEMA: ResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "infra_findings",
    strict: true,
    schema: {
      type: "object",
      properties: {
        observations: { type: "array", items: infraObservationSchema },
        summary: { type: "string" },
      },
      required: ["observations", "summary"],
      additionalProperties: false,
    },
  },
};

export const INVESTIGATION_PLAN_SCHEMA: ResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "investigation_plan",
    strict: true,
    schema: {
      type: "object",
      properties: {
        hypotheses: {
          type: "array",
          items: {
            type: "object",
            properties: {
              hypothesis: { type: "string" },
              evidenceNeeded: { type: "string" },
            },
            required: ["hypothesis", "evidenceNeeded"],
            additionalProperties: false,
          },
        },
        metricFocus: { type: "array", items: { type: "string" } },
        logFocus: { type: "array", items: { type: "string" } },
        infraFocus: { type: "array", items: { type: "string" } },
      },
      required: ["hypotheses", "metricFocus", "logFocus", "infraFocus"],
      additionalProperties: false,
    },
  },
};

export const RCA_REFLECTION_SCHEMA: ResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "rca_reflection",
    strict: true,
    schema: {
      type: "object",
      properties: {
        validationNotes: { type: "string" },
        revisedRootCause: { type: "string" },
        revisedTrigger: { type: "string" },
        revisedSeverity: { type: "string", enum: ["low", "medium", "high", "critical"] },
        revisedConfidence: { type: "string", enum: ["low", "medium", "high"] },
        revisedSummary: { type: "string" },
        issues: { type: "array", items: { type: "string" } },
      },
      required: ["validationNotes", "revisedRootCause", "revisedTrigger", "revisedSeverity", "revisedConfidence", "revisedSummary", "issues"],
      additionalProperties: false,
    },
  },
};

const timelineEventSchema = {
  type: "object" as const,
  properties: {
    time: { type: "string" as const },
    event: { type: "string" as const },
  },
  required: ["time", "event"] as const,
  additionalProperties: false as const,
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
        impact: {
          type: "object",
          properties: {
            duration: { type: "string" },
            description: { type: "string" },
          },
          required: ["duration", "description"],
          additionalProperties: false,
        },
        trigger: { type: "string" },
        rootCause: { type: "string" },
        contributingFactors: { type: "array", items: { type: "string" } },
        timeline: { type: "array", items: timelineEventSchema },
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
      required: ["severity", "summary", "impact", "trigger", "rootCause", "contributingFactors", "timeline", "evidence", "dashboardLinks", "recommendedActions", "confidence"],
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
