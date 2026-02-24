import { describe, it, expect, vi } from "vitest";
import { withTimeout, TimeoutError } from "./timeout.js";

describe("withTimeout", () => {
  it("resolves when promise completes before timeout", async () => {
    const result = await withTimeout(Promise.resolve(42), 1000, "test");
    expect(result).toBe(42);
  });

  it("rejects with TimeoutError when promise exceeds deadline", async () => {
    vi.useFakeTimers();
    const hanging = new Promise<never>(() => {});
    const p = withTimeout(hanging, 500, "hang-op");
    vi.advanceTimersByTime(501);
    await expect(p).rejects.toBeInstanceOf(TimeoutError);
    vi.useRealTimers();
  });

  it("TimeoutError carries label and ms", async () => {
    vi.useFakeTimers();
    const p = withTimeout(new Promise<never>(() => {}), 200, "my-op");
    vi.advanceTimersByTime(201);
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).label).toBe("my-op");
    expect((err as TimeoutError).ms).toBe(200);
    vi.useRealTimers();
  });

  it("propagates rejection from the original promise", async () => {
    const cause = new Error("original");
    await expect(withTimeout(Promise.reject(cause), 1000, "test")).rejects.toThrow("original");
  });

  it("does not fire timeout after promise resolves", async () => {
    vi.useFakeTimers();
    const p = withTimeout(Promise.resolve("done"), 500, "test");
    const result = await p;
    vi.advanceTimersByTime(600);
    expect(result).toBe("done");
    vi.useRealTimers();
  });
});
