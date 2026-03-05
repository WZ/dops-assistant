import type { LlmClient } from "../llm/openai.js";
import type { ServiceConfig } from "../config/schema.js";
import type { InvestigationIntent } from "./rca-types.js";
import { INTENT_CLASSIFIER_PROMPT, INTENT_RESPONSE_FORMAT } from "./rca-prompts.js";

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

  return undefined;
}

export class IntentClassifier {
  private readonly llm: LlmClient;

  constructor(llm: LlmClient) {
    this.llm = llm;
  }

  async classify(message: string, _serviceNames?: string[]): Promise<InvestigationIntent> {
    try {
      const response = await this.llm.chat(
        [
          { role: "system", content: INTENT_CLASSIFIER_PROMPT },
          { role: "user", content: message },
        ],
        [], // no tools needed for classification
        { responseFormat: INTENT_RESPONSE_FORMAT },
      );

      if (response.type !== "text") return { intent: "question" };

      const parsed = JSON.parse(response.content) as { intent: string; service: string };
      if (parsed.intent === "investigation") {
        return {
          intent: "investigation",
          service: parsed.service || undefined,
        };
      }
      return { intent: "question" };
    } catch {
      return { intent: "question" };
    }
  }
}
