// @vitest-environment jsdom
/**
 * PR-6 (Console-only) — the deep run no longer renders in InvestigationPane;
 * it streams in the Console (InlineRunRegion), the single home for a deep run.
 * These regressions pin that the pane mounts the report normally but does NOT
 * resurrect the old in-pane orchestrator cards, even with a live run in the
 * registry. (Supersedes the T11 "pane renders the run from the registry" rule.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import { InvestigationPane } from "./InvestigationPane";
import { StackProvider } from "../contexts/StackContext";
import { OrchestratorRunProvider } from "../contexts/OrchestratorRunContext";
import type { ServerMessage } from "../../types/ws-types.js";

const ID = "inv_t11";

// A minimal "complete" investigation so the pane mounts past the skeleton and
// renders the report section (which hosts the orchestrator stream).
function mockFetch() {
  return vi.fn((url: string | URL) => {
    const u = String(url);
    if (u.includes("/api/providers")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }
    if (u.includes(`/api/investigations/${ID}`) && !u.includes("/locate")) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            investigation: {
              id: ID,
              service: "impala",
              query: "why is impala down",
              status: "complete",
              report: JSON.stringify({
                summary: "scrape unreachable",
                rootCause: "Prometheus scrape target for impala is unreachable.",
                trigger: "scrape config drift",
                impact: { description: "metrics collection gap" },
                confidenceScore: 0.9,
                severity: "medium",
                recommendedActions: [],
                contributingFactors: [],
                ruledOut: [],
                dashboardLinks: [],
                timeline: [],
                skillsUsed: [],
              }),
              total_input_tokens: 0,
              total_output_tokens: 0,
              total_duration_ms: 0,
            },
            phases: [],
            events: [],
          }),
      });
    }
    // Lenient default for any other incidental fetch.
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

function renderPane(runMessages: ServerMessage[]) {
  return render(
    <StackProvider activeStackId="test-stack">
      <OrchestratorRunProvider wsMessages={runMessages} wsSend={vi.fn()} connectionStatus="connected">
        <InvestigationPane investigationId={ID} wsMessages={[]} onBack={vi.fn()} />
      </OrchestratorRunProvider>
    </StackProvider>,
  );
}

describe("InvestigationPane — deep run is Console-only (PR-6)", () => {
  beforeEach(() => {
    cleanup();
    globalThis.fetch = mockFetch() as unknown as typeof fetch;
    // jsdom lacks scrollIntoView (the pane scrolls the report into view).
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => vi.restoreAllMocks());

  it("mounts the report but does NOT render the in-pane orchestrator card for a confirmed run", async () => {
    const messages: ServerMessage[] = [
      { type: "orchestrator:started", investigationId: ID },
      { type: "orchestrator:step", investigationId: ID, event: { seq: 0, verb: "root cause:", target: "statestore pool starvation", status: "strong" } },
      {
        type: "orchestrator:complete",
        investigationId: ID,
        outcome: "confirmed",
        stats: { moves: 5, toolCalls: 2, subagents: 1, tokensSpent: 100, strikes: 0, depth: 1, durationMs: 1234 },
        causalChain: [{ label: "impala", kind: "incident" }, { label: "root cause: statestore pool starvation", kind: "root-cause" }],
        traceSummary: "5 moves · 2 queries · confirmed at depth 1",
      },
    ];
    renderPane(messages);

    // The report still mounts...
    expect(await screen.findByText(/Prometheus scrape target for impala is unreachable/i)).toBeTruthy();
    // ...but the old in-pane orchestrator card (confirmed banner + trace) is gone:
    // the run now streams only in the Console (InlineRunRegion).
    expect(screen.queryByText(/Confirmed a root cause/i)).toBeNull();
    expect(screen.queryByText(/confirmed at depth 1/i)).toBeNull();
  });

  it("shows a re-synthesis progress bar above the report while the run is refining (PR-6b)", async () => {
    const messages: ServerMessage[] = [
      { type: "orchestrator:started", investigationId: ID },
      {
        type: "orchestrator:complete",
        investigationId: ID,
        outcome: "confirmed",
        stats: { moves: 3, toolCalls: 1, subagents: 0, tokensSpent: 50, strikes: 0, depth: 1, durationMs: 1000 },
        causalChain: [{ label: "impala", kind: "incident" }, { label: "root cause: pool starvation", kind: "root-cause" }],
      },
      // Operator clicked Apply → server acked it's regenerating the narrative.
      { type: "orchestrator:refining", investigationId: ID },
    ];
    renderPane(messages);
    expect(await screen.findByText(/Prometheus scrape target for impala is unreachable/i)).toBeTruthy();
    expect(screen.getByText(/Re-synthesizing report/i)).toBeTruthy();
  });

  it("does NOT render an in-pane operator-pause card for a paused run", async () => {
    const messages: ServerMessage[] = [
      { type: "orchestrator:started", investigationId: ID },
      { type: "orchestrator:operator_pause", investigationId: ID, strikes: 3, hypothesesTried: ["a", "b", "c"] },
    ];
    renderPane(messages);
    // Report mounts; the pause is handled by the Console pause bar, not the pane.
    expect(await screen.findByText(/Prometheus scrape target for impala is unreachable/i)).toBeTruthy();
    expect(screen.queryByText(/needs your call|Paused/i)).toBeNull();
  });
});
