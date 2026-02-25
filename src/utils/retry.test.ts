import { describe, it, expect, vi } from "vitest";
import { withRetry, isRetryable } from "./retry.js";

describe("isRetryable", () => {
  it("returns true for HTTP 429", () => {
    expect(isRetryable({ status: 429 })).toBe(true);
  });
  it("returns true for HTTP 503", () => {
    expect(isRetryable({ status: 503 })).toBe(true);
  });
  it("returns false for HTTP 400", () => {
    expect(isRetryable({ status: 400 })).toBe(false);
  });
  it("returns true for ECONNRESET", () => {
    expect(isRetryable(new Error("ECONNRESET"))).toBe(true);
  });
  it("returns false for unknown error", () => {
    expect(isRetryable(new Error("some other error"))).toBe(false);
  });
});

describe("withRetry", () => {
  it("returns immediately on success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 0 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on retryable error and succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ status: 429 })
      .mockResolvedValue("ok");
    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 0 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws immediately on non-retryable error", async () => {
    const err = { status: 400 };
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 0 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("exhausts all attempts and throws last error", async () => {
    const err = { status: 503 };
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 0 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("respects custom retryOn predicate", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("custom"))
      .mockResolvedValue("done");
    const result = await withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 0,
      retryOn: (err) => err instanceof Error && err.message === "custom",
    });
    expect(result).toBe("done");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
