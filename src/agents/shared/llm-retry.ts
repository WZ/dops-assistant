import { createLogger } from "../../logger.js";
import { isLlmUnavailable, LlmUnavailableError } from "./llm-errors.js";

const logger = createLogger("llm-retry");

export interface LlmRetryConfig {
  maxAttempts: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  jitterPercent?: number;
}

/**
 * Picks a retry config that's safe to apply around an `agent.generate(...)` call.
 *
 * `withLlmRetry` re-runs its callback from scratch on transient failure. When the
 * callback is a tool-using agent run, replay re-invokes every tool the agent
 * already called — fine for read-only tools, unsafe for write-capable ones (a
 * Grafana annotation, a Slack message, anything non-idempotent could fire twice).
 *
 * If `readOnlyTools` is false/undefined, this returns `{ maxAttempts: 1 }` so
 * the wrapper performs no retries on tool-using paths. Read-only paths get the
 * configured retry budget. Tool-less call sites (e.g. `intent.ts`) should pass
 * the configured retry directly without going through this helper.
 */
export function safeAgentRetryConfig(
  configured: LlmRetryConfig | undefined,
  readOnlyTools: boolean | undefined,
): LlmRetryConfig {
  if (!readOnlyTools) return { maxAttempts: 1 };
  return configured ?? { maxAttempts: 1 };
}

export async function withLlmRetry<T>(
  fn: () => Promise<T>,
  config: LlmRetryConfig,
): Promise<T> {
  const {
    maxAttempts,
    initialDelayMs = 2000,
    maxDelayMs = 60_000,
    jitterPercent = 0.3,
  } = config;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isLlmUnavailable(err)) throw err;
      if (attempt === maxAttempts) break;
      const baseDelay = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const jitter = Math.random() * jitterPercent * baseDelay;
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
