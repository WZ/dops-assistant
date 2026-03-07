import type { LlmClient } from "../llm/openai.js";
import type { ServiceConfig } from "../config/schema.js";
import type { InvestigationIntent } from "./rca-types.js";
import { buildIntentClassifierPrompt, INTENT_RESPONSE_FORMAT } from "./rca-prompts.js";
import pino from "pino";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

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
export function matchService(query: string | undefined, services: ServiceConfig[]): ServiceConfig | undefined {
  if (!query) return undefined;
  const q = normalizeHyphens(query).toLowerCase();

  // Exact match (normalized)
  const exact = services.find((s) => normalizeHyphens(s.name) === normalizeHyphens(query));
  if (exact) return exact;

  // Case-insensitive exact
  const ciExact = services.find((s) => normalizeHyphens(s.name).toLowerCase() === q);
  if (ciExact) return ciExact;

  // Service name contains query (e.g. "kudu" matches "kudu-tserver")
  const contains = services.find((s) => normalizeHyphens(s.name).toLowerCase().includes(q));
  if (contains) return contains;

  // Query contains service name (e.g. "kudu-tserver-cluster" matches "kudu-tserver")
  const reverse = services.find((s) => q.includes(normalizeHyphens(s.name).toLowerCase()));
  if (reverse) return reverse;

  // Token overlap: split on delimiters, find service with best token match
  // e.g. "log-ingestion-pipeline" shares "ingestion" with "ingestion-server"
  // Require tokens ≥ 3 chars to avoid false positives on short fragments like "in", "db"
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
  const tokens = normalizeHyphens(text).toLowerCase()
    .split(/[-_\s.,;:!?'"()]+/)
    .filter((t) => t.length >= 3);

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
    if (score > bestScore) {
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
