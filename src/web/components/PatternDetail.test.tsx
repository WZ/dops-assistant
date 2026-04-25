// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { StackProvider } from "../contexts/StackContext";
import { PatternDetail } from "./PatternDetail";

function Wrapper({ children }: { children: ReactNode }) {
  return <StackProvider activeStackId="test-stack">{children}</StackProvider>;
}

const cluster = {
  seed: {
    id: "pat_seed",
    service: "payments-api",
    symptom: "Latency spikes and 5xx rate increase",
    root_cause: "Connection pool exhaustion due to leaked database connections",
    severity: "high",
    recommended_actions: "Increase pool max; Audit retry release path",
    source_investigation_id: "inv_seed",
    created_at: "2026-04-20T00:00:00.000Z",
  },
  clusterId: "cluster_pat_seed",
  recurrenceCount: 2,
  firstSeen: "2026-04-20T00:00:00.000Z",
  lastSeen: "2026-04-25T00:00:00.000Z",
  occurrences: [
    {
      id: "pat_match",
      service: "payments-api",
      symptom: "Elevated latency and 5xx",
      root_cause: "Leaked database connections exhausted the connection pool",
      severity: "medium",
      recommended_actions: "increase pool max; Add pool saturation alert",
      source_investigation_id: "inv_match",
      created_at: "2026-04-25T00:00:00.000Z",
      similarityScore: 0.82,
      investigation: {
        id: "inv_match",
        status: "complete",
        query: "why pool exhausted?",
        created_at: "2026-04-25T00:00:00.000Z",
        completed_at: "2026-04-25T12:00:00.000Z",
      },
    },
    {
      id: "pat_seed",
      service: "payments-api",
      symptom: "Latency spikes and 5xx rate increase",
      root_cause: "Connection pool exhaustion due to leaked database connections",
      severity: "high",
      recommended_actions: "Increase pool max; Audit retry release path",
      source_investigation_id: "inv_seed",
      created_at: "2026-04-20T00:00:00.000Z",
      similarityScore: 1,
      investigation: null,
    },
  ],
  dedupedRecommendedActions: [
    "increase pool max",
    "Add pool saturation alert",
    "Audit retry release path",
  ],
  matchBasis: {
    strategy: "same_service_root_cause_overlap_v1",
    serviceScoped: true,
    severity: "exact_or_adjacent",
    rootCauseThreshold: 0.45,
    symptomBoost: true,
  },
};

beforeEach(() => {
  cleanup();
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PatternDetail", () => {
  it("renders recurrence details, actions, match basis, and source investigations", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(cluster),
    });

    render(
      <PatternDetail patternId="pat_seed" onBack={vi.fn()} onViewInvestigation={vi.fn()} />,
      { wrapper: Wrapper },
    );

    expect(screen.getByText(/Loading pattern/)).toBeDefined();
    await waitFor(() => expect(screen.getByText(/Connection pool exhaustion/)).toBeDefined());
    expect(screen.getByText("payments-api")).toBeDefined();
    expect(screen.getByText(/seen 2 times/i)).toBeDefined();
    expect(screen.getByText("increase pool max")).toBeDefined();
    expect(screen.getByText(/same_service_root_cause_overlap_v1/)).toBeDefined();
    expect(screen.getByText("why pool exhausted?")).toBeDefined();
  });

  it("opens a source investigation from the occurrence list", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(cluster),
    });
    const onViewInvestigation = vi.fn();

    render(
      <PatternDetail patternId="pat_seed" onBack={vi.fn()} onViewInvestigation={onViewInvestigation} />,
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(screen.getByText("why pool exhausted?")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: /open investigation inv_match/i }));
    expect(onViewInvestigation).toHaveBeenCalledWith("inv_match");
  });

  it("renders missing source investigations without dropping the occurrence", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        ...cluster,
        recurrenceCount: 1,
        occurrences: [{ ...cluster.occurrences[0], investigation: null, source_investigation_id: "missing_inv" }],
      }),
    });

    render(
      <PatternDetail patternId="pat_seed" onBack={vi.fn()} onViewInvestigation={vi.fn()} />,
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(screen.getByText(/source investigation unavailable/i)).toBeDefined());
    expect(screen.getByText(/seen 1 time/i)).toBeDefined();
  });

  it("renders a not-found state for 404 responses", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("not found"),
    });

    render(
      <PatternDetail patternId="missing" onBack={vi.fn()} onViewInvestigation={vi.fn()} />,
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(screen.getByText(/Pattern not found/i)).toBeDefined());
  });

  it("renders fetch errors with a retry action", async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("boom"),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(cluster),
      });

    render(
      <PatternDetail patternId="pat_seed" onBack={vi.fn()} onViewInvestigation={vi.fn()} />,
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(screen.getByText(/Connection pool exhaustion/)).toBeDefined());
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});
