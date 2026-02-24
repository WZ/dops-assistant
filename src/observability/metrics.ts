import { Registry, Counter, Histogram } from "prom-client";

export const registry = new Registry();

export const agentRunsTotal = new Counter({
  name: "agent_runs_total",
  help: "Total number of agent runs",
  labelNames: ["status"] as const,
  registers: [registry],
});

export const agentIterations = new Histogram({
  name: "agent_iterations",
  help: "Number of iterations per agent run",
  buckets: [1, 3, 5, 10, 20],
  registers: [registry],
});

export const llmCallsTotal = new Counter({
  name: "llm_calls_total",
  help: "Total LLM API calls",
  labelNames: ["status"] as const,
  registers: [registry],
});

export const llmTokensUsedTotal = new Counter({
  name: "llm_tokens_used_total",
  help: "Total LLM tokens used",
  labelNames: ["type"] as const,
  registers: [registry],
});

export const toolCallsTotal = new Counter({
  name: "tool_calls_total",
  help: "Total MCP tool calls",
  labelNames: ["tool", "status"] as const,
  registers: [registry],
});

export const toolDurationSeconds = new Histogram({
  name: "tool_duration_seconds",
  help: "MCP tool call duration in seconds",
  labelNames: ["tool"] as const,
  registers: [registry],
});

export const schedulerChecksTotal = new Counter({
  name: "scheduler_checks_total",
  help: "Total scheduler service checks",
  labelNames: ["service", "status"] as const,
  registers: [registry],
});

export const slackMessagesTotal = new Counter({
  name: "slack_messages_total",
  help: "Total Slack messages handled",
  labelNames: ["status"] as const,
  registers: [registry],
});

export const alertNotificationsTotal = new Counter({
  name: "alert_notifications_total",
  help: "Total anomaly alert notifications sent",
  labelNames: ["status"] as const,
  registers: [registry],
});
