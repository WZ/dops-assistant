// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useInvestigationRunHydration } from "./useInvestigationRunHydration.js";

const mockStackFetch = vi.fn();
const stackCtx = { stackFetch: mockStackFetch, activeStackId: "s1" };
const runActions = { hydrate: () => {}, subscribe: () => {}, unsubscribe: () => {}, connectionStatus: "connected" };
vi.mock("../contexts/StackContext", () => ({ useStackContext: () => stackCtx }));
vi.mock("../contexts/OrchestratorRunContext", () => ({ useOrchestratorRunActions: () => runActions }));

function payload(status: string) {
  return { ok: true, status: 200, json: () => Promise.resolve({ investigation: { service: "api", query: "q", status, report: null }, phases: [] }) } as unknown as Response;
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe("useInvestigationRunHydration pollWhileRunningMs", () => {
  beforeEach(() => { vi.useFakeTimers(); mockStackFetch.mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it("re-fetches while the investigation is running and stops once it finishes", async () => {
    mockStackFetch.mockResolvedValueOnce(payload("running")).mockResolvedValueOnce(payload("complete"));
    const { result } = renderHook(() => useInvestigationRunHydration("inv-1", { active: false, pollWhileRunningMs: 5000 }));
    await flush();
    expect(result.current.data?.investigation.status).toBe("running");

    await act(async () => { vi.advanceTimersByTime(5000); });
    await flush();
    expect(result.current.data?.investigation.status).toBe("complete");

    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(mockStackFetch).toHaveBeenCalledTimes(2);
  });

  it("keeps retrying while the server is unreachable", async () => {
    mockStackFetch.mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(payload("failed"));
    const { result } = renderHook(() => useInvestigationRunHydration("inv-1", { active: false, pollWhileRunningMs: 5000 }));
    await flush();
    expect(result.current.data).toBeNull();

    await act(async () => { vi.advanceTimersByTime(5000); });
    await flush();
    expect(result.current.data?.investigation.status).toBe("failed");
  });

  it("fetches once when polling is not requested", async () => {
    mockStackFetch.mockResolvedValue(payload("running"));
    renderHook(() => useInvestigationRunHydration("inv-1", { active: false }));
    await flush();
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(mockStackFetch).toHaveBeenCalledTimes(1);
  });
});
