export function isRetryable(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "status" in err) {
    const status = (err as { status: number }).status;
    return status === 429 || status === 503;
  }
  if (err instanceof Error) {
    return (
      err.message.includes("ECONNRESET") ||
      err.message.includes("ENOTFOUND") ||
      err.message.includes("ETIMEDOUT")
    );
  }
  return false;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    maxAttempts: number;
    baseDelayMs: number;
    retryOn?: (err: unknown) => boolean;
  },
): Promise<T> {
  const shouldRetry = opts.retryOn ?? isRetryable;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === opts.maxAttempts || !shouldRetry(err)) throw err;
      const delay =
        opts.baseDelayMs *
        Math.pow(2, attempt - 1) *
        (0.5 + Math.random() * 0.5);
      await new Promise<void>((r) => setTimeout(r, Math.round(delay)));
    }
  }
  // unreachable — loop always throws or returns
  throw new Error("withRetry: unreachable");
}
