// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRecentEvents } from "./useRecentEvents.js";
import type { ReactNode } from "react";

// Mock StackContext so we can inject a controllable stackFetch without a
// real HTTP layer. The mock path is relative from THIS file's directory.
const mockStackFetch = vi.fn();

vi.mock("../contexts/StackContext.js", () => ({
  useStackContext: () => ({
    activeStackId: "test-stack",
    stackFetch: mockStackFetch,
  }),
}));

const POLL_MS = 5_000;

/** Minimal successful response factory. */
function okResponse(events: unknown[] = [], truncated = false): Response {
  return {
    ok: true,
    json: () => Promise.resolve({ events, truncated }),
  } as unknown as Response;
}

function wrapper({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

describe("useRecentEvents", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockStackFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("fires once immediately on mount and resolves initial state", async () => {
    mockStackFetch.mockResolvedValue(okResponse([], false));

    const { result } = renderHook(() => useRecentEvents({ pollMs: POLL_MS }), { wrapper });

    // Allow the initial fetchOnce() microtasks (Promise resolution) to settle,
    // but only advance to just before the next scheduled poll to avoid an
    // infinite-timer loop (the hook always reschedules after each fetch).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(mockStackFetch).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual({
      events: [],
      loading: false,
      error: null,
      truncated: false,
    });
  });

  it("polls on interval", async () => {
    mockStackFetch.mockResolvedValue(okResponse([], false));

    renderHook(() => useRecentEvents({ pollMs: POLL_MS }), { wrapper });

    // Settle the initial fetch — advance just enough to flush the async fetch
    // without triggering the poll timer.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mockStackFetch).toHaveBeenCalledTimes(1);

    // Advance by one poll interval → second call.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(mockStackFetch).toHaveBeenCalledTimes(2);

    // Advance by two more poll intervals → third and fourth calls.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    });
    expect(mockStackFetch).toHaveBeenCalledTimes(4);
  });

  it("error sets error state and backs off; clears on recovery", async () => {
    // First call rejects; subsequent calls succeed.
    mockStackFetch
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(okResponse([], false));

    const { result } = renderHook(() => useRecentEvents({ pollMs: POLL_MS }), { wrapper });

    // Let the first (failing) fetch settle — advance just 1ms to flush microtasks.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    // Error state should be set after the first fetch fails.
    expect(result.current.error).toBe("boom");
    expect(mockStackFetch).toHaveBeenCalledTimes(1);

    // Backoff doubles to 2*POLL_MS — advancing by only POLL_MS should NOT
    // trigger another fetch yet.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(mockStackFetch).toHaveBeenCalledTimes(1);

    // Advance the remaining POLL_MS to reach the 2*POLL_MS backoff threshold.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(mockStackFetch).toHaveBeenCalledTimes(2);

    // After a successful call error clears and the next poll is back to POLL_MS.
    expect(result.current.error).toBeNull();

    // One normal-interval advance triggers the third call.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(mockStackFetch).toHaveBeenCalledTimes(3);
  });

  it("cancels polling on unmount", async () => {
    mockStackFetch.mockResolvedValue(okResponse([], false));

    const { unmount } = renderHook(() => useRecentEvents({ pollMs: POLL_MS }), { wrapper });

    // Let the initial fetch settle.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    const callsAtUnmount = mockStackFetch.mock.calls.length;

    // Unmount — the cleanup function cancels the pending timer.
    unmount();

    // Advance timers well past a normal poll window; no additional calls.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 10);
    });
    expect(mockStackFetch).toHaveBeenCalledTimes(callsAtUnmount);
  });

  it("enabled: false prevents all polling", async () => {
    mockStackFetch.mockResolvedValue(okResponse([], false));

    renderHook(() => useRecentEvents({ pollMs: POLL_MS, enabled: false }), { wrapper });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    });

    expect(mockStackFetch).not.toHaveBeenCalled();
  });
});
