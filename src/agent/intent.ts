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
  const msgTokens = msgLower.split(/[-_\s.,;:!?'"()]+/).filter((t) => t.length >= 4);

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
  // Tiebreaker: prefer shorter service name (more specific match).
  let bestMatch: ServiceConfig | undefined;
  let bestScore = 0;

  for (const s of services) {
    const sTokens = normalizeHyphens(s.name).toLowerCase().split(/[-_\s]+/).filter((t) => t.length >= 3);
    let score = 0;
    for (const st of sTokens) {
      for (const t of tokens) {
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

export class IntentRouter {
  private readonly llm: LlmClient;

  constructor(llm: LlmClient) {
    this.llm = llm;
  }

  async route(message: string, serviceNames?: string[]): Promise<InvestigationIntent> {
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
