import type { LlmClient } from "../llm/openai.js";
import type { ServiceConfig } from "../config/schema.js";
import type { InvestigationIntent } from "./rca-types.js";
import { buildIntentClassifierPrompt, INTENT_RESPONSE_FORMAT } from "./rca-prompts.js";
import pino from "pino";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

/**
 * Strong investigation keywords — if any of these appear in the user message,
 * we bypass the LLM and route directly to the investigation agent.
 * This eliminates non-determinism for obvious investigation requests.
 */
const STRONG_INVESTIGATION_RE = /\b(investigate|investigation|diagnose|diagnosis|troubleshoot|rca|root[\s-]*cause|postmortem|post[\s-]*mortem)\b/i;

/**
 * Display/visualization requests — "show me", "display", etc. indicate the user
 * wants to SEE data, not investigate an incident. When present without symptom
 * words, we fast-path to the conversation agent (which can call query_prometheus
 * and render inline charts).
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

/**
 * Check if the message mentions any known service (by matching significant tokens
 * from service names or aliases against message tokens). Used as a guard for
 * symptom-based routing to avoid false positives on generic messages.
 */
export function messageMatchesAnyService(message: string, serviceNames: string[]): boolean {
  const msgLower = normalizeHyphens(message).toLowerCase();

  // Check if any full service name appears as substring (catches explicit mentions like "faz-web-server")
  for (const name of serviceNames) {
    if (msgLower.includes(normalizeHyphens(name).toLowerCase())) return true;
  }

  // Token overlap (filters generic infra tokens to prevent "the server is slow" from matching)
  const msgTokens = msgLower.split(/[-_\s.,;:!?'"()]+/).filter((t) => t.length >= 4 && !GENERIC_INFRA_TOKENS.has(t));

  for (const name of serviceNames) {
    const nameTokens = normalizeHyphens(name).toLowerCase().split(/[-_\s]+/).filter((t) => t.length >= 4);
    if (nameTokens.some((nt) => msgTokens.includes(nt))) return true;
  }

  // Also check well-known aliases (kafka, redis, postgres, etc.)
  for (const alias of Object.keys(SERVICE_ALIASES)) {
    if (alias.length >= 4 && msgTokens.includes(alias)) return true;
  }

  return false;
}

/**
 * Normalize unicode look-alike hyphens (non-breaking, en-dash, etc.) to ASCII hyphen.
 * LLMs sometimes return visually identical but technically different characters.
 */
function normalizeHyphens(s: string): string {
  // U+2011 non-breaking hyphen, U+2013 en-dash, U+2014 em-dash, U+2010 hyphen, U+2212 minus
  return s.replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, "-");
}

/**
 * Generic infrastructure tokens that should not trigger service matching on their own.
 * These appear in many service names (e.g. "server", "cluster") and are commonly used
 * in generic context ("the server is slow", "check the cluster") without referring
 * to a specific service. Filtering them from user message tokens prevents false positives.
 */
const GENERIC_INFRA_TOKENS = new Set([
  "server", "service", "cluster", "proxy",
  "headless", "master", "worker", "node",
  "metrics", "monitor", "agent",
]);

/**
 * Fuzzy-match a user-provided service name against the configured services list.
 * Normalizes unicode hyphens, then tries exact → case-insensitive → substring matches.
 */
// Common aliases: LLMs return shorthand names for well-known infrastructure
const SERVICE_ALIASES: Record<string, string[]> = {
  kafka: ["kafka-brokers", "kafka-bootstrap"],
  clickhouse: ["ch-clickhouse"],
  postgres: ["stolon-proxy"],
  postgresql: ["stolon-proxy"],
  stolon: ["stolon-proxy"],
  redis: ["cache-redis-ha"],
  ingestion: ["ingestion-server"],
};

export function matchService(query: string | undefined, services: ServiceConfig[]): ServiceConfig | undefined {
  if (!query) return undefined;
  const q = normalizeHyphens(query).toLowerCase();

  // Exact match (normalized)
  const exact = services.find((s) => normalizeHyphens(s.name) === normalizeHyphens(query));
  if (exact) return exact;

  // Case-insensitive exact
  const ciExact = services.find((s) => normalizeHyphens(s.name).toLowerCase() === q);
  if (ciExact) return ciExact;

  // Alias resolution: "kafka" → "kafka-brokers", "clickhouse" → "ch-clickhouse", etc.
  const aliasTargets = SERVICE_ALIASES[q];
  if (aliasTargets) {
    for (const target of aliasTargets) {
      const aliased = services.find((s) => normalizeHyphens(s.name).toLowerCase().includes(target));
      if (aliased) return aliased;
    }
  }

  // Service name contains query — prefer shortest match (most specific)
  const containsMatches = services.filter((s) => normalizeHyphens(s.name).toLowerCase().includes(q));
  if (containsMatches.length > 0) {
    containsMatches.sort((a, b) => a.name.length - b.name.length);
    return containsMatches[0];
  }

  // Query contains service name — prefer longest match (most specific)
  const reverseMatches = services.filter((s) => q.includes(normalizeHyphens(s.name).toLowerCase()));
  if (reverseMatches.length > 0) {
    reverseMatches.sort((a, b) => b.name.length - a.name.length);
    return reverseMatches[0];
  }

  // Token overlap: split on delimiters, find service with best token match
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

/**
 * Match a service directly from the user's free-text message.
 * Tokenizes the message and scores each configured service by token overlap.
 * Returns the best match only if the score is strong enough (≥ 3).
 */
export function matchServiceFromText(text: string, services: ServiceConfig[]): ServiceConfig | undefined {
  const normalized = normalizeHyphens(text).toLowerCase();

  // Phase 1: Check if the full service name appears as a substring in the text.
  // Prefer the longest matching name to avoid "data-server" matching when "data-catalog-server" is present.
  const substringMatches = services
    .filter((s) => normalized.includes(normalizeHyphens(s.name).toLowerCase()))
    .sort((a, b) => b.name.length - a.name.length);
  if (substringMatches.length > 0) return substringMatches[0];

  // Phase 1.5: Alias resolution — if a message token matches a known alias, resolve it.
  // Catches "clickhouse" → "ch-clickhouse", "kafka" → "kafka-brokers", etc.
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

  // Phase 2: Token overlap scoring (for partial matches like "ingestion" → "ingestion-server")
  // Filter generic infra tokens from message to prevent false positives (e.g. "cluster" matching kafka-cluster).
  // Tiebreaker: prefer shorter service name (more specific match).
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

/**
 * Validate that an LLM-extracted service name is grounded in the user's message.
 * Resolves the LLM's pick via matchService, then checks that the resolved service
 * shares at least one significant token with the original message.
 * This prevents the LLM from hallucinating a service that the user never mentioned.
 */
export function validateLlmServiceMatch(
  llmService: string | undefined,
  userMessage: string,
  services: ServiceConfig[],
): ServiceConfig | undefined {
  const resolved = matchService(llmService, services);
  if (!resolved) return undefined;

  // Check: does the resolved service name share any significant token with the message?
  // Filter generic infra tokens to prevent "the server is slow" from matching any *-server service.
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

  // Also check if the LLM's raw query (before resolution) appears in the message
  const llmNorm = normalizeHyphens(llmService ?? "").toLowerCase();
  const msgNorm = normalizeHyphens(userMessage).toLowerCase();
  const llmInMessage = llmNorm.length >= 3 && msgNorm.includes(llmNorm);

  return (hasOverlap || llmInMessage) ? resolved : undefined;
}

/**
 * Resolve a service by scanning conversation history backwards.
 * Most recent mention wins — useful when the user says "investigate the rate drop"
 * without naming a service, but prior messages discussed a specific service.
 */
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

export class IntentRouter {
  private readonly llm: LlmClient;

  constructor(llm: LlmClient) {
    this.llm = llm;
  }

  async route(message: string, serviceNames?: string[]): Promise<InvestigationIntent> {
    // Fast-path 0a: display/visualization requests route to conversation agent.
    // "show me X" without symptom words = user wants to SEE data, not investigate.
    if (DISPLAY_REQUEST_RE.test(message) && !SYMPTOM_RE.test(message)) {
      logger.debug({ message }, "Router: display-request fast-path → question");
      return { intent: "question" };
    }

    // Fast-path 0b: informational requests route to conversation agent.
    // "tell me about X health" without symptom words = user wants info, not investigation.
    if (INFORMATIONAL_REQUEST_RE.test(message) && !SYMPTOM_RE.test(message)) {
      logger.debug({ message }, "Router: informational-request fast-path → question");
      return { intent: "question" };
    }

    // Fast-path 1: strong investigation keywords bypass the LLM entirely.
    if (STRONG_INVESTIGATION_RE.test(message)) {
      logger.debug({ message }, "Router: keyword fast-path → investigation");
      return { intent: "investigation", service: undefined };
    }

    // Fast-path 2: symptom keyword + recognizable service mention.
    // Catches "ingestion rate dropped" or "payments-api is slow" without needing "investigate".
    if (SYMPTOM_RE.test(message) && serviceNames?.length && messageMatchesAnyService(message, serviceNames)) {
      logger.debug({ message }, "Router: symptom+service fast-path → investigation");
      return { intent: "investigation", service: undefined };
    }

    try {
      const response = await this.llm.chat(
        [
          { role: "system", content: buildIntentClassifierPrompt(serviceNames) },
          { role: "user", content: message },
        ],
        [], // no tools needed for classification
        { responseFormat: INTENT_RESPONSE_FORMAT },
      );

      if (response.type !== "text") return { intent: "question" };

      const parsed = JSON.parse(response.content) as { intent: string; service: string };
      const result: InvestigationIntent = parsed.intent === "investigation"
        ? { intent: "investigation", service: parsed.service || undefined }
        : { intent: "question" };

      logger.debug({ message, intent: parsed.intent, service: parsed.service || null, routedTo: result.intent }, "Router: classified intent and routed to agent");
      return result;
    } catch (err) {
      logger.debug({ message, err }, "Router: classification failed, defaulting to question agent");
      return { intent: "question" };
    }
  }
}
