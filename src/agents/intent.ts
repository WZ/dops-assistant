import { generateText, type LanguageModel } from "ai";
import type { ServiceConfig } from "../config/schema.js";
import type { InvestigationIntent } from "../types/rca-types.js";
import { createLogger } from "../logger.js";
import { wrapUntrusted } from "./shared/prompt-helpers.js";
import { withLlmRetry, type LlmRetryConfig } from "./shared/llm-retry.js";
import { LlmUnavailableError } from "./shared/llm-errors.js";

const logger = createLogger();

// ── Intent classifier prompt ────────────────────────────────────────────────

/**
 * Build the LLM intent-classifier prompt.
 *
 * The chat agent has direct Prometheus / Loki / k8s MCP tools — most messages
 * (including symptom reports and log queries) are best answered by it directly.
 * Investigation = the heavyweight multi-agent RCA workflow, and we only fire it
 * on EXPLICIT cues. Reports of problems alone are NOT enough; the user must
 * use an investigation verb (investigate / diagnose / troubleshoot / RCA /
 * postmortem). Operators escalate by typing `/investigate <service>` or by
 * clicking the "Run full investigation" pill the chat reply renders.
 */
function buildIntentClassifierPrompt(serviceNames?: string[]): string {
  const serviceList = serviceNames?.length
    ? `\nFor reference, known services include: ${serviceNames.join(", ")}\nIf the user mentions a service or component, extract the key identifying term. Prefer a known service name if it clearly matches; otherwise echo the user's own wording.`
    : "";

  return `You are classifying a user message as either an "investigation" request or a "question".

The chat agent has direct access to Prometheus, Loki, and Kubernetes MCP tools. It can query metrics, search logs, list pods, fetch dashboards, and answer technical questions with real data. Most user messages — including reports of problems and questions about service health — should be answered by the chat agent, not by spinning up a heavyweight multi-agent root cause investigation.

CLASSIFY AS "investigation" ONLY when the user EXPLICITLY asks for a formal investigation:
- "investigate <service>"
- "diagnose <service or symptom>"
- "troubleshoot <issue>"
- "RCA <incident>" or "root cause of <X>"
- "run a postmortem on <X>"

EVERYTHING ELSE is "question" — including:
- Reports of problems ("the api is down", "kafka is crashing")
- Symptom descriptions ("payments-api throws 503s", "ingestion rate dropped")
- Health, status, or performance checks ("is data-server healthy?", "check CPU usage")
- Log queries ("can you check errors in <job/log source>", "look at the logs for X")
- Service-availability questions ("are there any issues with kafka?")
- "Can you check X" or "look at Y" requests
- Informational asks ("what dashboards do we have?", "how does ingestion work?")
- Greetings and casual messages ("hi", "hello", "thanks")

EXAMPLES:
- "investigate kafka brokers" → investigation, service: "kafka"
- "diagnose the timeout spike on data-server" → investigation, service: "data-server"
- "RCA the outage from this morning" → investigation, service: ""
- "data-server queries are running slow" → question, service: "data-server"
- "kafka is throwing connection errors" → question, service: "kafka"
- "the api is down" → question, service: "api"
- "can you check errors in <job-name> job" → question, service: ""
- "can you check the logs for X" → question, service: ""
- "check ClickHouse cluster health" → question, service: "clickhouse"
- "are there any issues with the Kafka cluster?" → question, service: "kafka"
- "check CPU usage across all nodes" → question, service: ""
- "what dashboards do we have available?" → question, service: ""
- "hi" → question, service: ""

Default to "question" unless the user used one of the explicit investigation verbs above. The user can always escalate by typing "/investigate <service>" if they want a full RCA after seeing the chat answer.
${serviceList}
Extract the service name if mentioned. Respond with JSON: {"intent": "investigation"|"question", "service": "<name or empty>"}`;
}

// ── Fast-path regex patterns ────────────────────────────────────────────────

/**
 * Strong investigation keywords — if any of these appear in the user message,
 * we bypass the LLM and route directly to the investigation agent.
 * This eliminates non-determinism for obvious investigation requests.
 */
const STRONG_INVESTIGATION_RE = /\b(investigate|investigation|diagnose|diagnosis|troubleshoot|rca|root[\s-]*cause|postmortem|post[\s-]*mortem)\b/i;

/**
 * Display/visualization requests — "show me", "display", etc. indicate the user
 * wants to SEE data, not investigate an incident. When present without symptom
 * words, we fast-path to the conversation agent (which can call metric query
 * tools and render inline charts).
 */
const DISPLAY_REQUEST_RE = /\b(show\s+me|show\s+the|display|visualize|plot\b|graph\b)\b/i;

/**
 * Informational request patterns — "tell me about", "how is", "what about", etc.
 * indicate the user wants information, not a formal investigation. When present
 * without symptom words, we fast-path to the conversation agent.
 */
const INFORMATIONAL_REQUEST_RE = /\b(tell\s+me\s+about|how\s+is|how's|how\s+are|what\s+about|what\s+is|what's\s+the|describe|explain|overview|status\s+of|summary\s+of|info\s+on|details\s+on|report\s+on|give\s+me)\b/i;

/**
 * Symptom/problem indicators — when combined with a recognizable service mention,
 * these strongly suggest investigation rather than a question.
 */
const SYMPTOM_RE = /\b(down|slow|failing|failed|crash(?:ing|loop(?:ing)?)?|oom(?:killed)?|spik(?:e|ed|ing)|drop(?:ped|ping)?|timeout(?:s|ed|ing)?|timed?\s*out|degraded|degradation|error(?:s|ed)?|latency|unresponsive|unhealthy|flapping|outage|incident|issue[s]?|problem[s]?|broken|overloaded|check|5[0-9]{2})\b/i;

// ── Service matching ────────────────────────────────────────────────────────

/**
 * Normalize unicode look-alike hyphens (non-breaking, en-dash, etc.) to ASCII hyphen.
 */
function normalizeHyphens(s: string): string {
  return s.replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, "-");
}

// Tokens that are common enough across services or generic enough as platform
// references that they should NEVER count as service-identifying overlap.
// "k8s"/"kubernetes"/"docker"/"helm" etc. are platforms, not workloads —
// without this guard, a sentence about "a k8s job" would token-match an MCP
// provider service named "k8s-mcp" and silently route an investigation to it.
const GENERIC_INFRA_TOKENS = new Set([
  "server", "service", "cluster", "proxy",
  "headless", "master", "worker", "node",
  "metrics", "monitor", "agent",
  "k8s", "kubernetes", "docker", "helm", "linux",
]);

const DEFAULT_SERVICE_ALIASES: Record<string, string[]> = {
  kafka: ["kafka-brokers", "kafka-bootstrap"],
  clickhouse: ["ch-clickhouse"],
  postgres: ["stolon-proxy"],
  postgresql: ["stolon-proxy"],
  stolon: ["stolon-proxy"],
  redis: ["cache-redis-ha"],
  ingestion: ["ingestion-server"],
};

let SERVICE_ALIASES: Record<string, string[]> = { ...DEFAULT_SERVICE_ALIASES };

/** Initialize aliases from config (merges config over defaults). */
export function setServiceAliases(configAliases: Record<string, string[]>): void {
  SERVICE_ALIASES = { ...DEFAULT_SERVICE_ALIASES, ...configAliases };
}

export function messageMatchesAnyService(message: string, serviceNames: string[]): boolean {
  const msgLower = normalizeHyphens(message).toLowerCase();

  for (const name of serviceNames) {
    if (msgLower.includes(normalizeHyphens(name).toLowerCase())) return true;
  }

  const msgTokens = msgLower.split(/[-_\s.,;:!?'"()]+/).filter((t) => t.length >= 4 && !GENERIC_INFRA_TOKENS.has(t));

  for (const name of serviceNames) {
    const nameTokens = normalizeHyphens(name).toLowerCase().split(/[-_\s]+/).filter((t) => t.length >= 4);
    if (nameTokens.some((nt) => msgTokens.includes(nt))) return true;
  }

  for (const alias of Object.keys(SERVICE_ALIASES)) {
    if (alias.length >= 4 && msgTokens.includes(alias)) return true;
  }

  return false;
}

export function matchService(query: string | undefined, services: ServiceConfig[]): ServiceConfig | undefined {
  if (!query) return undefined;
  const q = normalizeHyphens(query).toLowerCase();

  const exact = services.find((s) => normalizeHyphens(s.name) === normalizeHyphens(query));
  if (exact) return exact;

  const ciExact = services.find((s) => normalizeHyphens(s.name).toLowerCase() === q);
  if (ciExact) return ciExact;

  const aliasTargets = SERVICE_ALIASES[q];
  if (aliasTargets) {
    for (const target of aliasTargets) {
      const aliased = services.find((s) => normalizeHyphens(s.name).toLowerCase().includes(target));
      if (aliased) return aliased;
    }
  }

  const containsMatches = services.filter((s) => normalizeHyphens(s.name).toLowerCase().includes(q));
  if (containsMatches.length > 0) {
    containsMatches.sort((a, b) => a.name.length - b.name.length);
    return containsMatches[0];
  }

  const reverseMatches = services.filter((s) => q.includes(normalizeHyphens(s.name).toLowerCase()));
  if (reverseMatches.length > 0) {
    reverseMatches.sort((a, b) => b.name.length - a.name.length);
    return reverseMatches[0];
  }

  const MIN_TOKEN_LEN = 3;
  const qTokens = q.split(/[-_\s]+/).filter((t) => t.length >= MIN_TOKEN_LEN);
  let bestMatch: ServiceConfig | undefined;
  let bestScore = 0;
  for (const s of services) {
    const sTokens = normalizeHyphens(s.name).toLowerCase().split(/[-_\s]+/).filter((t) => t.length >= MIN_TOKEN_LEN);
    const overlap = qTokens.filter((t) => sTokens.some((st) => st === t || (t.length >= 5 && (st.includes(t) || t.includes(st))))).length;
    if (overlap > bestScore) {
      bestScore = overlap;
      bestMatch = s;
    }
  }
  if (bestMatch && bestScore > 0) return bestMatch;

  return undefined;
}

export function matchServiceFromText(text: string, services: ServiceConfig[]): ServiceConfig | undefined {
  const normalized = normalizeHyphens(text).toLowerCase();

  const substringMatches = services
    .filter((s) => normalized.includes(normalizeHyphens(s.name).toLowerCase()))
    .sort((a, b) => b.name.length - a.name.length);
  if (substringMatches.length > 0) return substringMatches[0];

  const tokens = normalized
    .split(/[-_\s.,;:!?'"()]+/)
    .filter((t) => t.length >= 3);

  for (const token of tokens) {
    const aliasTargets = SERVICE_ALIASES[token];
    if (aliasTargets) {
      for (const target of aliasTargets) {
        const aliased = services.find((s) => normalizeHyphens(s.name).toLowerCase().includes(target));
        if (aliased) return aliased;
      }
    }
  }

  const msgTokens = tokens.filter((t) => !GENERIC_INFRA_TOKENS.has(t));

  let bestMatch: ServiceConfig | undefined;
  let bestScore = 0;

  for (const s of services) {
    const sTokens = normalizeHyphens(s.name).toLowerCase().split(/[-_\s]+/).filter((t) => t.length >= 3);
    let score = 0;
    for (const st of sTokens) {
      for (const t of msgTokens) {
        if (st === t) { score += 3; break; }
        if (st.length >= 5 && t.length >= 5 && (st.includes(t) || t.includes(st))) { score += 1; break; }
      }
    }
    if (score > bestScore || (score === bestScore && score > 0 && bestMatch && s.name.length < bestMatch.name.length)) {
      bestScore = score;
      bestMatch = s;
    }
  }

  return bestMatch && bestScore >= 3 ? bestMatch : undefined;
}

export function validateLlmServiceMatch(
  llmService: string | undefined,
  userMessage: string,
  services: ServiceConfig[],
): ServiceConfig | undefined {
  const resolved = matchService(llmService, services);
  if (!resolved) return undefined;

  const msgTokens = normalizeHyphens(userMessage).toLowerCase()
    .split(/[-_\s.,;:!?'"()]+/)
    .filter((t) => t.length >= 3 && !GENERIC_INFRA_TOKENS.has(t));
  const svcTokens = normalizeHyphens(resolved.name).toLowerCase()
    .split(/[-_\s]+/)
    .filter((t) => t.length >= 3);

  const hasOverlap = svcTokens.some((st) =>
    msgTokens.some((mt) =>
      st === mt ||
      (st.length >= 5 && mt.length >= 5 && (st.includes(mt) || mt.includes(st)))
    )
  );

  const llmNorm = normalizeHyphens(llmService ?? "").toLowerCase();
  const msgNorm = normalizeHyphens(userMessage).toLowerCase();
  const llmInMessage = llmNorm.length >= 3 && msgNorm.includes(llmNorm);

  return (hasOverlap || llmInMessage) ? resolved : undefined;
}

export function resolveServiceFromHistory(
  history: Array<{ role: string; content: string | null }>,
  services: ServiceConfig[],
): ServiceConfig | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const content = history[i]?.content;
    if (!content) continue;
    const match = matchServiceFromText(content, services);
    if (match) return match;
  }
  return undefined;
}

// ── IntentRouter ────────────────────────────────────────────────────────────

export class IntentRouter {
  private readonly model: LanguageModel;
  private readonly llmRetry: LlmRetryConfig;

  constructor(model: LanguageModel, llmRetry: LlmRetryConfig = { maxAttempts: 1 }) {
    this.model = model;
    this.llmRetry = llmRetry;
  }

  async route(message: string, serviceNames?: string[]): Promise<InvestigationIntent> {
    if (DISPLAY_REQUEST_RE.test(message) && !SYMPTOM_RE.test(message)) {
      logger.info({ routeSource: "fast-display", intent: "question" }, "Router: classified");
      return { intent: "question" };
    }

    if (INFORMATIONAL_REQUEST_RE.test(message) && !SYMPTOM_RE.test(message)) {
      logger.info({ routeSource: "fast-informational", intent: "question" }, "Router: classified");
      return { intent: "question" };
    }

    if (STRONG_INVESTIGATION_RE.test(message)) {
      logger.info({ routeSource: "fast-strong-keyword", intent: "investigation" }, "Router: classified");
      return { intent: "investigation", service: undefined };
    }

    // Fast-path 4 (symptom + service token) was removed — it was the source of
    // false-positive auto-investigations on prompts like "check errors in <job>".
    // Symptom-only prompts now go to the LLM (with a conservative prompt that
    // routes them to the chat agent), or the user can opt in via /investigate.

    try {
      const { text } = await withLlmRetry(
        () => generateText({
          model: this.model,
          system: buildIntentClassifierPrompt(serviceNames),
          prompt: wrapUntrusted("user_message", message),
          temperature: 0,
        }),
        this.llmRetry,
      );

      const parsed = JSON.parse(text) as { intent: string; service: string };
      const result: InvestigationIntent = parsed.intent === "investigation"
        ? { intent: "investigation", service: parsed.service || undefined }
        : { intent: "question" };

      logger.info(
        { routeSource: "llm", intent: result.intent, llmService: parsed.service || null },
        "Router: classified",
      );
      return result;
    } catch (err) {
      if (err instanceof LlmUnavailableError) throw err;
      logger.info({ routeSource: "llm-failed", intent: "question", err: String(err) }, "Router: classification failed, defaulting to question");
      return { intent: "question" };
    }
  }
}
