import { APICallError } from "@ai-sdk/provider";

export class LlmUnavailableError extends Error {
  constructor(public readonly cause: unknown) {
    super("LLM unavailable after retries");
    this.name = "LlmUnavailableError";
  }
}

// Connection-level network errors. These only bubble up before the AI SDK has
// a chance to wrap a response in APICallError, so they reliably indicate an
// LLM-side connectivity failure rather than a tool error.
const CONNECTION_RX = /ECONNREFUSED|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|ECONNRESET|EAI_AGAIN|ETIMEDOUT|fetch failed|Cannot connect to API|connect.*refused/i;

/**
 * Returns true when an error indicates the LLM provider is transiently
 * unreachable. Only matches:
 *   1. An AI SDK `APICallError` flagged retryable (HTTP 408/409/429/5xx)
 *   2. A bare connection-level error (ECONNREFUSED etc.) walked up the cause chain
 *
 * Generic substrings like `timeout` or `503` are intentionally NOT matched
 * here — tool errors (Prometheus, Loki, MCP) often contain the same words and
 * we must not misclassify them as LLM outages.
 */
export function isLlmUnavailable(err: unknown): boolean {
  if (err == null) return false;

  // Bare strings: only match connection-level patterns.
  if (typeof err === "string") return CONNECTION_RX.test(err);

  // Walk the cause chain (cap at 5) looking for an AI SDK APICallError or a
  // connection-level error message.
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current != null; depth++) {
    if (APICallError.isInstance(current) && current.isRetryable) return true;
    if (current instanceof Error && CONNECTION_RX.test(current.message)) return true;
    current = current instanceof Error ? (current as Error & { cause?: unknown }).cause : undefined;
  }
  return false;
}
