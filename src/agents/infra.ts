import { Agent } from "@mastra/core/agent";
import type { LanguageModel } from "ai";
import { createQuirkPrepareStep } from "./shared/prepare-step.js";

interface InfraAgentConfig {
  model: LanguageModel;
  tools?: Record<string, any>;
  maxSteps?: number;
  useQuirkHandling?: boolean;
}

export function createInfraAgent(config: InfraAgentConfig) {
  const maxSteps = config.maxSteps ?? 10;
  return new Agent({
    id: "infra",
    name: "infra",
    instructions: `You are an infrastructure health specialist investigating a service anomaly.

INVESTIGATION STEPS:
1. Your user message contains PRE-FETCHED panel queries and datasource UIDs. Use these PromQL expressions directly — do NOT call get_dashboard_by_uid, get_dashboard_panel_queries, list_datasources, or search_dashboards.
2. Query Prometheus for pod restarts, CPU usage, memory using queries from relevant dashboards.
3. Check for OOMKilled, CrashLoopBackOff, or other pod issues.
4. Check node-level metrics (CPU, memory, disk) for the hosts running the service.

IMPORTANT query_prometheus parameters:
- queryType "instant": current values. Needs startTime.
- queryType "range": time series. Needs startTime, endTime, stepSeconds.
- startTime/endTime: use relative (e.g. "now-1h") or RFC3339 format.

For each observation, provide the resource name, status, details, and timestamp.
Keep observations concise — max 8 observations. Summary should be 1-3 sentences.
Be efficient — make at most 3 tool calls per round.

You MUST end your response with a JSON object matching this exact schema (no trailing text after the JSON):
{"summary": "string", "observations": [{"resource": "string", "status": "string", "detail": "string", "timestamp": "string"}]}`,
    model: config.model as any,
    tools: config.tools ?? {},
    defaultOptions: {
      maxSteps,
      prepareStep: config.useQuirkHandling
        ? createQuirkPrepareStep({ maxSteps })
        : undefined,
    },
  });
}
