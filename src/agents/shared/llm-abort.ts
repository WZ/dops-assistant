/**
 * Abort + hard-timeout plumbing for agent LLM calls.
 *
 * `AbortSignal` is cooperative: it only helps if every layer in Mastra, the
 * AI SDK, undici, and the upstream gateway settles the promise on abort. The
 * `runWithHardTimeout` wrapper races the caller's work against:
 *   - an internal wall-clock timeout (so the agent always leaves "analyzing")
 *   - a caller-provided `parentSignal` (e.g. WebSocket disconnect)
 *
 * `sleepWithBackoff` is the cancellable counterpart for retry-loop pauses
 * so a 30s exponential-backoff sleep doesn't outlive a caller's disconnect.
 *
 * Names use the generic `Abort` prefix rather than `Discovery` because the
 * helpers were extracted from the discover step but aren't discovery-specific —
 * any agent path that needs caller-cancellation + hard-timeout can reuse them.
 */

export function createAbortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === "string" ? reason : "Operation aborted");
  err.name = "AbortError";
  return err;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError(signal.reason);
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

export function createLlmTimeoutError(timeoutMs: number): Error {
  const err = new Error(`LLM call timed out after ${timeoutMs}ms`);
  err.name = "TimeoutError";
  return err;
}

export function isLlmTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.name === "TimeoutError";
}

/**
 * Run `work` with a hard wall-clock timeout AND optional caller-cancellation.
 *
 * The work function receives an `AbortSignal` it should propagate to the
 * underlying agent/HTTP call. Three races, first to settle wins:
 *   1. `work(controllerSignal)` resolves or throws
 *   2. internal timeout fires → throws `TimeoutError` and aborts the controller
 *   3. `parentSignal` aborts → throws `AbortError` and aborts the controller
 *
 * When both `timeoutMs` and `parentSignal` are absent, `work(undefined)` runs
 * with no signal at all — the no-op path keeps existing call sites simple.
 */
export async function runWithHardTimeout<T>(
  timeoutMs: number | undefined,
  work: (abortSignal?: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  throwIfAborted(parentSignal);

  const hasTimeout = timeoutMs !== undefined && timeoutMs > 0;
  if (!hasTimeout && !parentSignal) return work(undefined);

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeParentAbortListener: (() => void) | undefined;
  const timeoutPromise = hasTimeout ? new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      const err = createLlmTimeoutError(timeoutMs!);
      controller.abort(err);
      reject(err);
    }, timeoutMs!);
  }) : undefined;
  const parentAbortPromise = parentSignal ? new Promise<never>((_, reject) => {
    const onAbort = () => {
      const err = createAbortError(parentSignal.reason);
      controller.abort(err);
      reject(err);
    };
    parentSignal.addEventListener("abort", onAbort, { once: true });
    removeParentAbortListener = () => parentSignal.removeEventListener("abort", onAbort);
  }) : undefined;

  try {
    const contenders: Array<Promise<T> | Promise<never>> = [
      Promise.resolve().then(() => work(controller.signal)),
    ];
    if (timeoutPromise) contenders.push(timeoutPromise);
    if (parentAbortPromise) contenders.push(parentAbortPromise);
    return await Promise.race(contenders);
  } finally {
    if (timeout) clearTimeout(timeout);
    removeParentAbortListener?.();
  }
}

/**
 * Exponential backoff sleep that wakes on abort. Defended against the case
 * where a flapping gateway would otherwise burn the full 1-2-4-8-…-30s delay
 * after the caller has already disconnected. Throws `createAbortError` on
 * abort so the surrounding `try/catch` flow handles cancellation uniformly.
 */
export function sleepWithBackoff(attempt: number, signal?: AbortSignal): Promise<void> {
  const baseDelay = Math.min(2000 * 2 ** (attempt - 1), 30_000);
  const jitter = Math.random() * 0.3 * baseDelay;
  return new Promise<void>((resolve, reject) => {
    const settle = (fn: () => void) => {
      clearTimeout(t);
      if (signal) signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => settle(() => reject(createAbortError(signal?.reason)));
    const t = setTimeout(() => settle(resolve), baseDelay + jitter);
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
