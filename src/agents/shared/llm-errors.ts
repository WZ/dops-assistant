export class LlmUnavailableError extends Error {
  constructor(public readonly cause: unknown) {
    super("LLM unavailable after retries");
    this.name = "LlmUnavailableError";
  }
}

const NETWORK_RX = /ECONNREFUSED|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|ECONNRESET|EAI_AGAIN|fetch failed|Cannot connect to API|connect.*refused|timeout|timed out|ETIMEDOUT|bad gateway|service unavailable|rate limit|\b429\b|\b502\b|\b503\b|\b504\b/i;

export function isLlmUnavailable(err: unknown): boolean {
  if (err == null) return false;
  let msg: string;
  if (err instanceof Error) {
    const causeMsg =
      (err as Error & { cause?: unknown }).cause instanceof Error
        ? (err as Error & { cause: Error }).cause.message
        : "";
    msg = `${err.message} ${causeMsg}`;
  } else {
    msg = String(err);
  }
  return NETWORK_RX.test(msg);
}
