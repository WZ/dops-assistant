import pino from "pino";
import { isLlmUnavailable, LlmUnavailableError } from "./llm-errors.js";

const logger = pino({ name: "llm-retry" });

export interface LlmRetryConfig {
  maxAttempts: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

export async function withLlmRetry<T>(
  fn: () => Promise<T>,
  config: LlmRetryConfig,
): Promise<T> {
  const { maxAttempts, initialDelayMs = 2000, maxDelayMs = 60_000 } = config;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isLlmUnavailable(err)) throw err;
      if (attempt === maxAttempts) break;
      const baseDelay = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const jitter = Math.random() * 0.3 * baseDelay;
      const delayMs = baseDelay + jitter;
      logger.warn(
        { attempt, maxAttempts, delayMs: Math.round(delayMs), err: String(err) },
        "LLM call failed, retrying",
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  logger.error(
    { maxAttempts, err: String(lastErr) },
    "LLM call failed after all retries",
  );
  throw new LlmUnavailableError(lastErr);
}
