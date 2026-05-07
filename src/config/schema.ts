import { z } from "zod";

const MetricSchema = z.object({
  query: z.string(),
  description: z.string(),
});

// Threshold + ProbeMetricRuleSchema are declared up here (rather than alongside
// ProbeSchema below) so `ServiceSchema.probeRules` can reference them. The probe
// rule shape is shared between the global probe defaults (`ProbeSchema.metrics`)
// and per-service rules (`ServiceSchema.probeRules`). The `source` discriminator
// tells the probe which MCP tool role to dispatch against: "metrics" → Prometheus
// query tool, "logs" → Loki query tool with queryType:"metric".
const ThresholdSchema = z.object({
  op: z.enum(["gt", "lt", "gte", "lte"]),
  value: z.number(),
});

// Exported so the discovery-path validator in src/workflows/steps/discover.ts
// can safeParse LLM-written rules before they're persisted. Keep this in
// lockstep with scan-rule-validator's RuleSchema (same fields, same defaults);
// the only intentional divergence is that scan-rule-validator is `.strict()`
// (rejects unknown keys to catch typo'd GUI input) while this schema tolerates
// unknown keys so future field additions don't break in-flight rules.
export const ProbeMetricRuleSchema = z.object({
  name: z.string(),
  query: z.string(),
  threshold: ThresholdSchema,
  consecutiveTicks: z.number().int().min(1).default(1),
  source: z.enum(["metrics", "logs"]).default("metrics"),
});

const ServiceSchema = z.object({
  name: z.string(),
  metrics: z.array(MetricSchema).optional().default([]),
  logLabels: z.record(z.string()).optional().default({}),
  gitlabProject: z.string().optional(),
  /** Coroot application ID (e.g. "default:Deployment:ingestion-server"). Set by discovery. */
  corootAppId: z.string().optional(),
  /**
   * Per-service probe rules written by the discovery agent (e.g. `pod_restarts`
   * with the service's actual k8s namespace, `log_errors` using the service's
   * Loki labels). Empty by default; populated on `npm run discover` when the
   * agent has enough context to write a correctly-labeled query. The probe
   * merges these with the top-level `globalProbeRules` from services.yaml and
   * the hardcoded `ProbeSchema.metrics` defaults (four-track evaluator).
   */
  probeRules: z.array(ProbeMetricRuleSchema).optional().default([]),
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

const LlmRetrySchema = z.object({
  maxAttempts: z.number().int().min(1).max(15).default(8),
  initialDelayMs: z.number().int().min(100).max(60_000).default(2000),
  maxDelayMs: z.number().int().min(1000).max(600_000).default(60_000),
  jitterPercent: z.number().min(0).max(2).default(0.3),
}).default({});

const LlmSchema = z.object({
  model: z.string().default("gpt-4"),
  maxTokens: z.number().default(4096),
  apiKey: z.string(),
  baseURL: z.string().optional(),
  retry: LlmRetrySchema,
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

const PeriodicDiscoverySchema = z.object({
  enabled:                  z.boolean().default(false),
  cron:                     z.string().default(""),
  timezone:                 z.string().default("UTC"),
  consensusRuns:            z.number().int().min(1).max(10).default(2),
  consensusRunsForRemovals: z.number().int().min(1).max(10).default(3),
}).refine(
  (c) => !c.enabled || c.cron.length > 0,
  { message: "cron must be non-empty when enabled is true", path: ["cron"] },
);

const DiscoverySchema = z.object({
  autoRefresh: z.boolean().default(false),
  excludeServices: z.array(z.string()).default([]),
  maxIterations: z.number().default(40),
  discoveryRecipes: z.array(DiscoveryRecipeSchema).optional().default([]),
  periodic: PeriodicDiscoverySchema.optional().default({}),
  /**
   * Cap on each MCP tool result's character length before it enters the
   * agent's message history. Bounds prompt growth across iterations so the
   * accumulated context plus reserved completion budget stays under the
   * model's `max_model_len`. Without this cap a single unfiltered
   * `k8s_pods_list` (~83k chars) plus 30 more tool calls overflows even a
   * 128k-token window. Set 0 to disable.
   */
  maxToolResultChars: z.number().int().min(0).default(30_000),
  /**
   * Max completion tokens reserved for the discover agent's response.
   * Some OpenAI-compatible gateways reject requests with
   * `max_tokens must be at least 1, got -N` when prompt_tokens plus this
   * value exceed the upstream model's context window. Lower for stacks
   * with smaller context windows; raise for very large environments where
   * the JSON output truncates. Default 8192 leaves ~2x headroom on a 32k
   * model and accommodates roughly 25-40 services.
   */
  maxOutputTokens: z.number().int().min(256).max(65_536).default(8192),
});

export const InvestigationTemplateSchema = z.enum(["quick", "standard", "full"]);
export type InvestigationTemplate = z.infer<typeof InvestigationTemplateSchema>;

const WebhookSchema = z.object({
  /** Bearer token for authenticating incoming Alertmanager webhooks (legacy single-tenant). */
  secret: z.string().optional(),
  /**
   * Per-sender bearer tokens. Map of sender-name → token. Any token in this
   * map is accepted in addition to `secret`. The matching name is recorded in
   * logs and the event log so a noisy source can be traced and revoked
   * without rotating tokens for everyone.
   *
   * `min(16)` floor: the upcoming Settings → Alert Webhooks tab masks tokens
   * as `${first4}…${last4}` and leaks the whole value for short tokens.
   * Rejecting sub-16-char tokens at config load means the UI can rely on the
   * invariant without a runtime branch.
   */
  tokens: z.record(z.string(), z.string().min(16)).optional(),
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

/**
 * Scheduled proactive system scan config. Disabled by default.
 *
 * On cron fire, a deterministic PromQL probe pass runs across every registered
 * service. Services whose values exceed a rule's threshold for `consecutiveTicks`
 * consecutive ticks get a focused headless investigation (capped at
 * `maxInvestigationsPerTick`). Design doc:
 * ~/.gstack/projects/WZ-dops-assistant/wli02-main-design-20260421-012829.md
 */
const ProbeLogsSchema = z.object({
  enabled: z.boolean().default(true),
  window: z.string().default("15m"),
  errorRateThreshold: z.number().default(10),
  consecutiveTicks: z.number().int().min(1).default(2),
});

const ProbeSchema = z.object({
  concurrency: z.number().int().min(1).default(8),
  queryTimeoutMs: z.number().int().min(100).default(3_000),
  /**
   * Separate timeout for log-source probe rules. Loki `count_over_time` queries
   * across a 15m window on a busy log stream regularly take 5-20s; reusing the
   * 3s Prometheus-sized `queryTimeoutMs` produces silent false negatives (NaN
   * looks identical to "no errors"). Operators on slower Loki clusters can tune
   * up; fast Loki clusters can tune down to match the metric timeout.
   */
  logsQueryTimeoutMs: z.number().int().min(100).default(10_000),
  /**
   * Default probe rules — three k8s availability checks, one per workload type
   * (Deployment / StatefulSet / DaemonSet). A service will typically match
   * exactly one of these based on how it's scheduled; the others return empty
   * vector and score 0 (no trip) harmlessly.
   *
   * Why not `up{service="..."}` or `http_requests_total{service="..."}`?
   * Smoke test (2026-04-22) showed the `service=` label doesn't exist on
   * most k8s Prometheus setups (kube-state-metrics uses `deployment=` /
   * `statefulset=` / `daemonset=`). The service-health-poller compensates by
   * post-filtering bare `up` results (service-health-poller.ts:162-166), but
   * the probe needs a label-selector-scoped query to score per-service.
   *
   * Each query is ANDed against a "desired > 0" guard so that:
   *   - scaled-to-zero deployments (HPA min=0, maintenance mode, cron-style
   *     workloads) don't fire false positives on `available = 0`
   *   - arch-mismatched daemonsets (e.g. arm64 DS on amd64-only nodes —
   *     `desired_number_scheduled = 0`) don't fire. Observed in the smoke
   *     test: `kube-flannel-ds-arm` etc. would have tripped without the guard.
   *   - statefulsets paused for maintenance (replicas=0) don't fire.
   * When the guard fails (spec/desired = 0), the query returns an empty
   * vector, scored as NaN, evaluated as "no trip" (see
   * anomaly-probe.ts evaluateThreshold).
   *
   * Application-level rules (error rate, latency) are too environment-
   * specific for defaults — operators with labeled HTTP metrics add them via
   * the GUI rule editor (Settings → Scan) or config.yaml override.
   *
   * `consecutiveTicks: 3` on all: rolling deploys briefly drop `_available`
   * below desired. On the default 4h cron, 3 consecutive ticks = ~8h between
   * first breach and trip (breach detected at t=0, retained at t=4h, fires
   * at t=8h). Long enough to filter any reasonable rollout window; short
   * enough that a genuine outage gets caught on the next probe cadence.
   * Tune down for tighter cron intervals.
   */
  metrics: z.array(ProbeMetricRuleSchema).default([
    {
      name: "deployment_availability",
      query: 'kube_deployment_status_replicas_available{deployment="{service}"} and kube_deployment_spec_replicas{deployment="{service}"} > 0',
      threshold: { op: "lt", value: 1 },
      consecutiveTicks: 3,
    },
    {
      name: "statefulset_availability",
      query: 'kube_statefulset_status_replicas_ready{statefulset="{service}"} and kube_statefulset_replicas{statefulset="{service}"} > 0',
      threshold: { op: "lt", value: 1 },
      consecutiveTicks: 3,
    },
    {
      name: "daemonset_availability",
      query: 'kube_daemonset_status_number_ready{daemonset="{service}"} and kube_daemonset_status_desired_number_scheduled{daemonset="{service}"} > 0',
      threshold: { op: "lt", value: 1 },
      consecutiveTicks: 3,
    },
  ]),
  logs: ProbeLogsSchema.optional().default({}),
});

const ScanSchema = z.object({
  enabled: z.boolean().default(false),
  cron: z.string().default("0 */4 * * *"),
  timezone: z.string().default("UTC"),
  maxInvestigationsPerTick: z.number().int().min(1).default(5),
  investigationTemplate: InvestigationTemplateSchema.default("standard"),
  runOnEnable: z.boolean().default(true),
  dedupWindowMinutes: z.number().int().min(1).default(30),
  probe: ProbeSchema.optional().default({}),
});

const K8sEventsSchema = z.object({
  // Opt-in by default to match the existing `scan.enabled` pattern. New
  // auto-investigators ship OFF so operators consciously turn them on after
  // verifying their stack has a k8s infra MCP wired and they want the
  // additional dispatch volume.
  enabled: z.boolean().default(false),
  intervalSeconds: z.number().int().min(60).default(300),
  badReasons: z.array(z.string()).default([
    "OOMKilled",
    "CrashLoopBackOff",
    "Error",
    "ImagePullBackOff",
    "ErrImagePull",
    "Unhealthy",
    "Failed",
  ]),
  ignoreReasons: z.array(z.string()).default(["Completed"]),
  maxEventsPerTick: z.number().int().min(1).default(50),
  queryTimeoutMs: z.number().int().min(1_000).default(15_000),
});

const SmtpSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(587),
  secure: z.boolean().default(false),
  user: z.string().min(1),
  pass: z.string().min(1),
});

const EmailRetrySchema = z.object({
  attempts: z.number().int().min(1).max(10).default(4),
  backoffMs: z.array(z.number().int().min(0)).default([1000, 5000, 30000]),
}).refine(
  (r) => r.backoffMs.length === r.attempts - 1,
  { message: "retry.backoffMs.length must equal retry.attempts - 1" },
);

const NotificationsEmailSchema = z.object({
  enabled: z.boolean().default(false),
  smtp: SmtpSchema,
  from: z.string().min(1),
  appBaseUrl: z.string().url(),
  retry: EmailRetrySchema.default({ attempts: 4, backoffMs: [1000, 5000, 30000] }),
});

const NotificationsSchema = z.object({
  email: NotificationsEmailSchema.optional(),
}).optional();

/**
 * Persistent activity feed (the `events` table — backs `/activity/events`).
 * Currently only carries retention. Set `retentionDays: 0` to disable the
 * sweep entirely (for users with external archival pipelines who don't want
 * the server purging anything).
 */
const EventsSchema = z.object({
  retentionDays: z.number().int().min(0).default(30),
});

export type K8sEventsConfig = z.infer<typeof K8sEventsSchema>;
export type ScanConfig = z.infer<typeof ScanSchema>;
export type ProbeConfig = z.infer<typeof ProbeSchema>;
export type ProbeMetricRule = z.infer<typeof ProbeMetricRuleSchema>;
export type ProbeLogsConfig = z.infer<typeof ProbeLogsSchema>;
export type Threshold = z.infer<typeof ThresholdSchema>;

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
  scan: ScanSchema.optional().default({}),
  k8sEvents: K8sEventsSchema.optional().default({}),
  events: EventsSchema.optional().default({}),
  notifications: NotificationsSchema,
  branding: BrandingSchema.optional().default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type SkillsConfig = z.infer<typeof SkillsSchema>;
export type ServiceConfig = z.infer<typeof ServiceSchema>;
export { ServiceSchema as ServiceConfigSchema };
export type McpServerConfig = z.infer<typeof McpServerSchema>;
export type TimeoutsConfig = z.infer<typeof TimeoutsSchema>;
export type RetryConfig = z.infer<typeof RetrySchema>;
export type ObservabilityConfig = z.infer<typeof ObservabilitySchema>;
export type DiscoveryConfig = z.infer<typeof DiscoverySchema>;
export type DiscoveryRecipe = z.infer<typeof DiscoveryRecipeSchema>;
export type PeriodicDiscoveryConfig = z.infer<typeof PeriodicDiscoverySchema>;
export { PeriodicDiscoverySchema };
export type WebhookConfig = z.infer<typeof WebhookSchema>;
export type BrandingConfig = z.infer<typeof BrandingSchema>;
export type NotificationsConfig = z.infer<typeof NotificationsSchema>;
export type NotificationsEmailConfig = z.infer<typeof NotificationsEmailSchema>;
export type EventsConfig = z.infer<typeof EventsSchema>;
export type SmtpConfig = z.infer<typeof SmtpSchema>;
export type EmailRetryConfig = z.infer<typeof EmailRetrySchema>;
