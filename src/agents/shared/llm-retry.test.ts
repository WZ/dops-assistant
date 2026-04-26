import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { withLlmRetry } from "./llm-retry.js";
import { LlmUnavailableError } from "./llm-errors.js";

describe("withLlmRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(withLlmRetry(fn, { maxAttempts: 3 })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries transient errors and eventually succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValue("ok");
    const p = withLlmRetry(fn, { maxAttempts: 5, initialDelayMs: 10, maxDelayMs: 100 });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("rethrows non-transient errors immediately without retry", async () => {
    const appErr = new SyntaxError("Unexpected token");
    const fn = vi.fn().mockRejectedValue(appErr);
    await expect(withLlmRetry(fn, { maxAttempts: 5, initialDelayMs: 10 })).rejects.toBe(appErr);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws LlmUnavailableError after maxAttempts on persistent transient error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const assertion = expect(
      withLlmRetry(fn, { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 100 }),
    ).rejects.toBeInstanceOf(LlmUnavailableError);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("disables retry when maxAttempts is 1", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const p = withLlmRetry(fn, { maxAttempts: 1, initialDelayMs: 10 });
    await expect(p).rejects.toBeInstanceOf(LlmUnavailableError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("caps delay at maxDelayMs", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    const assertion = expect(
      withLlmRetry(fn, { maxAttempts: 5, initialDelayMs: 100, maxDelayMs: 200 }),
    ).rejects.toBeInstanceOf(LlmUnavailableError);
    await vi.runAllTimersAsync();
    await assertion;
    const delays = setTimeoutSpy.mock.calls.map((c) => c[1] as number);
    // First delay 100, then 200 (capped), then 200, then 200 — each + 0–30% jitter
    expect(delays.every((d) => d <= 260)).toBe(true);
    expect(delays[2]).toBeGreaterThanOrEqual(200);
  });
});
