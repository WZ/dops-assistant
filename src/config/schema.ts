import { z } from "zod";

const MetricSchema = z.object({
  query: z.string(),
  description: z.string(),
});

const ServiceSchema = z.object({
  name: z.string(),
  metrics: z.array(MetricSchema).optional().default([]),
  logLabels: z.record(z.string()).optional().default({}),
  gitlabProject: z.string().optional(),
  /** Coroot application ID (e.g. "default:Deployment:ingestion-server"). Set by discovery. */
  corootAppId: z.string().optional(),
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

export const ProviderRoleSchema = z.enum([
  "metrics", "logs", "dashboards", "dependencies", "infrastructure", "changes",
]);

export const ProviderSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/, "Provider name must only contain alphanumeric characters, hyphens, and underscores"),
  roles: z.array(ProviderRoleSchema).min(1),
  mcpServer: McpServerSchema,
  region: z.string().optional(),
  webUrl: z.string().url().optional(),
});

export const StackConfigSchema = z.object({
  providers: z.array(ProviderSchema),
});

export type ProviderRole = z.infer<typeof ProviderRoleSchema>;
export type ProviderConfig = z.infer<typeof ProviderSchema>;

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

const MemorySchema = z.object({
  storage: z.enum(["memory", "libsql"]).default("memory"),
  dbPath: z.string().default(".dops/memory.db"),
});

const AgentSchema = z.object({
  maxIterations: z.number().default(20),
  // @deprecated: use top-level `memory` config instead; will be removed in a future version
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

const SkillsSchema = z.object({
  dir: z.string().default("./skills"),
  maxPerQuery: z.number().default(3),
  maxCharsPerSkill: z.number().default(2000),
});

const BrandingSchema = z.object({
  title: z.string().default("dops"),
  subtitle: z.string().default("assistant"),
});

const DiscoveryRecipeSchema = z.object({
  /** Provider type this recipe applies to, e.g. "prometheus-k8s", "datadog", "coroot" */
  providerType: z.string(),
  /** Example queries the discover agent should try (provider-specific syntax) */
  serviceQueries: z.array(z.string()).default([]),
  /** Label keys used to identify services in this provider's data */
  labelKeys: z.array(z.string()).default([]),
});

const DiscoverySchema = z.object({
  autoRefresh: z.boolean().default(false),
  excludeServices: z.array(z.string()).default([]),
  maxIterations: z.number().default(40),
  discoveryRecipes: z.array(DiscoveryRecipeSchema).optional().default([]),
});

export const InvestigationTemplateSchema = z.enum(["quick", "standard", "full"]);
export type InvestigationTemplate = z.infer<typeof InvestigationTemplateSchema>;

const WebhookSchema = z.object({
  /** Bearer token for authenticating incoming Alertmanager webhooks */
  secret: z.string().optional(),
  /** Dedup window in seconds — skip alerts for the same service within this period */
  dedupWindowSeconds: z.number().default(300),
  /** Max concurrent investigations triggered by webhooks */
  maxConcurrent: z.number().default(3),
  /** Default investigation template for alert-triggered investigations */
  defaultTemplate: InvestigationTemplateSchema.default("standard"),
  /** Severity → template mapping (overrides defaultTemplate when alert has severity label) */
  severityTemplateMap: z.record(InvestigationTemplateSchema).optional().default({
    critical: "full",
    warning: "standard",
    info: "quick",
  }),
  /** Slack incoming webhook URL for investigation completion notifications */
  slackWebhookUrl: z.string().url().optional(),
});

export const ConfigSchema = z.object({
  llm: LlmSchema,
  /** Optional API key for authenticating mutating (non-GET) API requests */
  apiKey: z.string().optional(),
  providers: z.array(ProviderSchema).default([]).refine(
    (providers) => new Set(providers.map((p) => p.name)).size === providers.length,
    { message: "Provider names must be unique" },
  ),
  services: z.array(ServiceSchema).default([]),
  serviceAliases: z.record(z.array(z.string())).optional().default({}),
  agent: AgentSchema.optional().default({}),
  timeouts: TimeoutsSchema.optional().default({}),
  retry: RetrySchema.optional().default({}),
  observability: ObservabilitySchema.optional().default({}),
  skills: SkillsSchema.optional().default({}),
  discovery: DiscoverySchema.optional().default({}),
  memory: MemorySchema.optional().default({}),
  webhook: WebhookSchema.optional().default({}),
  branding: BrandingSchema.optional().default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type SkillsConfig = z.infer<typeof SkillsSchema>;
export type ServiceConfig = z.infer<typeof ServiceSchema>;
export type McpServerConfig = z.infer<typeof McpServerSchema>;
export type TimeoutsConfig = z.infer<typeof TimeoutsSchema>;
export type RetryConfig = z.infer<typeof RetrySchema>;
export type ObservabilityConfig = z.infer<typeof ObservabilitySchema>;
export type DiscoveryConfig = z.infer<typeof DiscoverySchema>;
export type DiscoveryRecipe = z.infer<typeof DiscoveryRecipeSchema>;
export type WebhookConfig = z.infer<typeof WebhookSchema>;
export type BrandingConfig = z.infer<typeof BrandingSchema>;
