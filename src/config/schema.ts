import { z } from "zod";

const MetricSchema = z.object({
  query: z.string(),
  description: z.string(),
});

const ServiceSchema = z.object({
  name: z.string(),
  metrics: z.array(MetricSchema).optional().default([]),
  logLabels: z.record(z.string()).optional().default({}),
});

const McpServerSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional().default([]),
  env: z.record(z.string()).optional().default({}),
  enabledTools: z.array(z.string()).optional(),
});

const GrafanaSchema = z.object({
  mcpServer: McpServerSchema,
});

const LlmSchema = z.object({
  model: z.string().default("gpt-4"),
  maxTokens: z.number().default(4096),
  apiKey: z.string(),
  baseURL: z.string().optional(),
});

const AnomalyCheckSchema = z.object({
  interval: z.string().default("5m"),
  services: z.array(z.string()).optional(),
  maxConcurrency: z.number().default(3),
  alertCooldownMinutes: z.number().default(30),
});

const SchedulerSchema = z.object({
  anomalyCheck: AnomalyCheckSchema.optional(),
});

const ConversationMemorySchema = z.object({
  maxMessages: z.number().default(20),
  ttlMinutes: z.number().default(60),
});

const AgentSchema = z.object({
  maxIterations: z.number().default(20),
  conversationMemory: ConversationMemorySchema.optional().default({}),
});

const SlackNotificationsSchema = z.object({
  webhookUrl: z.string(),
  channel: z.string().default("#ops-alerts"),
});

const NotificationsSchema = z.object({
  slack: SlackNotificationsSchema.optional(),
});

const SlackInterfaceSchema = z.object({
  enabled: z.boolean().default(false),
  botToken: z.string().optional(),
  appToken: z.string().optional(),
});

const InterfacesSchema = z.object({
  slack: SlackInterfaceSchema.optional(),
});

const TimeoutsSchema = z.object({
  mcpConnectMs: z.number().default(30_000),
  llmCallMs: z.number().default(60_000),
  toolExecutionMs: z.number().default(30_000),
  agentIterationMs: z.number().default(90_000),
});

const RetrySchema = z.object({
  maxAttempts: z.number().default(3),
  baseDelayMs: z.number().default(500),
});

const ObservabilitySchema = z.object({
  port: z.number().default(9090),
  logLevel: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
});

export const ConfigSchema = z.object({
  llm: LlmSchema,
  grafana: GrafanaSchema,
  services: z.array(ServiceSchema).default([]),
  scheduler: SchedulerSchema.optional().default({}),
  agent: AgentSchema.optional().default({}),
  notifications: NotificationsSchema.optional().default({}),
  interfaces: InterfacesSchema.optional().default({}),
  timeouts: TimeoutsSchema.optional().default({}),
  retry: RetrySchema.optional().default({}),
  observability: ObservabilitySchema.optional().default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ServiceConfig = z.infer<typeof ServiceSchema>;
export type McpServerConfig = z.infer<typeof McpServerSchema>;
export type AnomalyCheckConfig = z.infer<typeof AnomalyCheckSchema>;
export type TimeoutsConfig = z.infer<typeof TimeoutsSchema>;
export type RetryConfig = z.infer<typeof RetrySchema>;
export type ObservabilityConfig = z.infer<typeof ObservabilitySchema>;
