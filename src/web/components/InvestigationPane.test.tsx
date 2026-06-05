// @vitest-environment jsdom
/**
 * T11 regression (IRON RULE) — after lifting orchestrator + deep-mode run state
 * into the run registry (OrchestratorRunContext), InvestigationPane must still
 * render the run by reading from the registry rather than its own WS handler.
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

describe("InvestigationPane — reads orchestrator run from the registry (T11)", () => {
  beforeEach(() => {
    cleanup();
    globalThis.fetch = mockFetch() as unknown as typeof fetch;
    // jsdom lacks scrollIntoView (the pane scrolls the report into view).
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => vi.restoreAllMocks());

  it("renders a confirmed orchestrator run that lives in the registry", async () => {
    // The run state comes ONLY from the registry (these messages reach the
    // provider, not the pane's own handler, which no longer processes them).
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

    // The pane mounts the report, then the OrchestratorStream (fed by the
    // registry) shows the confirmed outcome banner + trace summary.
    expect(await screen.findByText(/Confirmed a root cause/i)).toBeTruthy();
    expect(screen.getByText(/confirmed at depth 1/i)).toBeTruthy();
  });

  it("renders a paused orchestrator run from the registry", async () => {
    const messages: ServerMessage[] = [
      { type: "orchestrator:started", investigationId: ID },
      { type: "orchestrator:operator_pause", investigationId: ID, strikes: 3, hypothesesTried: ["a", "b", "c"] },
    ];
    renderPane(messages);
    // The operator-pause card renders from the registry's pause state.
    expect(await screen.findByText(/needs your call|Paused/i)).toBeTruthy();
  });
});
