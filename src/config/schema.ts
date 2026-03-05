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

const McpServerSchema = z.discriminatedUnion("transport", [
  z.object({
    transport: z.literal("stdio"),
    command: z.string(),
    args: z.array(z.string()).optional().default([]),
    env: z.record(z.string()).optional().default({}),
    enabledTools: z.array(z.string()).optional(),
  }),
  z.object({
    transport: z.literal("http"),
    url: z.string().url(),
    enabledTools: z.array(z.string()).optional(),
  }),
]);

const GrafanaSchema = z.object({
  mcpServer: McpServerSchema,
});

const LlmSchema = z.object({
  model: z.string().default("gpt-4"),
  maxTokens: z.number().default(4096),
  apiKey: z.string(),
  baseURL: z.string().optional(),
});

const ConversationMemorySchema = z.object({
  maxMessages: z.number().default(20),
  ttlMinutes: z.number().default(60),
});

const AgentSchema = z.object({
  maxIterations: z.number().default(20),
  conversationMemory: ConversationMemorySchema.optional().default({}),
  investigationTriggerPhrases: z.array(z.string()).optional().default([
    "investigate",
    "why is",
    "what's wrong",
    "is down",
    "is slow",
    "root cause",
  ]),
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

const DiscoverySchema = z.object({
  autoRefresh: z.boolean().default(false),
  excludeServices: z.array(z.string()).default([]),
  consulMetric: z.string().default("consul_catalog_service_node_healthy"),
  maxIterations: z.number().default(40),
});

export const ConfigSchema = z.object({
  llm: LlmSchema,
  grafana: GrafanaSchema,
  services: z.array(ServiceSchema).default([]),
  agent: AgentSchema.optional().default({}),
  timeouts: TimeoutsSchema.optional().default({}),
  retry: RetrySchema.optional().default({}),
  observability: ObservabilitySchema.optional().default({}),
  discovery: DiscoverySchema.optional().default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ServiceConfig = z.infer<typeof ServiceSchema>;
export type McpServerConfig = z.infer<typeof McpServerSchema>;
export type TimeoutsConfig = z.infer<typeof TimeoutsSchema>;
export type RetryConfig = z.infer<typeof RetrySchema>;
export type ObservabilityConfig = z.infer<typeof ObservabilitySchema>;
export type DiscoveryConfig = z.infer<typeof DiscoverySchema>;
