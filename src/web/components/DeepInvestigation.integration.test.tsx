// @vitest-environment jsdom
/**
 * T9 — frontend integration: the investigation→Console flow end-to-end through
 * the real components sharing ONE run registry. Exercises launch (menu + confirm
 * countdown) → stream → pause → decide → complete, the cross-component notifier,
 * and a navigation unmount/remount that proves the run survives in the registry.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, within } from "@testing-library/react";
import { useState } from "react";
import type { ServerMessage, ClientMessage, AgentStreamEvent } from "../../types/ws-types.js";
import { OrchestratorRunProvider } from "../contexts/OrchestratorRunContext";
import { ScopedDeepMenu } from "./ScopedDeepMenu";
import { InlineRunRegion } from "./InlineRunRegion";
import { DeepRunToaster } from "./DeepRunToaster";

// PR-3: stub the Grafana providers hook so InlineRunRegion needs no StackContext
// or async /api/providers fetch in this timer-driven integration harness.
vi.mock("../hooks/useGrafanaProviders", () => ({ useGrafanaProviders: () => [] }));

const ID = "inv_e2e";
const step = (seq: number, target?: string): AgentStreamEvent => ({ seq, verb: "testing", target, status: "running" });

beforeEach(() => {
  cleanup();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  (window as unknown as Record<string, unknown>).__ORCHESTRATOR_ENABLED__ = true;
  (window as unknown as Record<string, unknown>).__DEEP_MODE_ENABLED__ = true;
  vi.useFakeTimers();
});
afterEach(() => {
  (window as unknown as Record<string, unknown>).__ORCHESTRATOR_ENABLED__ = undefined;
  (window as unknown as Record<string, unknown>).__DEEP_MODE_ENABLED__ = undefined;
  vi.useRealTimers();
});

/** App-shaped harness: the report entry (menu) + the Console region + the
 *  toaster, all reading the one provider. `showRegion` simulates navigating
 *  away from / back to the Console. */
function Harness({ messages, send, showRegion }: { messages: ServerMessage[]; send: (m: ClientMessage) => void; showRegion: boolean }) {
  return (
    <OrchestratorRunProvider wsMessages={messages} wsSend={send} connectionStatus="connected">
      <ScopedDeepMenu investigationId={ID} canChallenge />
      {showRegion && <InlineRunRegion investigationId={ID} service="impala" />}
      <DeepRunToaster onView={vi.fn()} />
    </OrchestratorRunProvider>
  );
}

describe("Deep Investigation — investigation→Console flow (T9)", () => {
  it("launches, streams, pauses, resumes, completes, and survives navigation", async () => {
    const send = vi.fn();
    const ref = { current: [] as ServerMessage[] };
    let showRegion = true;
    const { rerender } = render(<Harness messages={ref.current} send={send} showRegion={showRegion} />);
    const sync = () => rerender(<Harness messages={ref.current} send={send} showRegion={showRegion} />);
    const emit = (m: ServerMessage) => act(() => { ref.current = [...ref.current, m]; sync(); });

    // 1. Launch a Full run from the single entry → confirm countdown → dispatch.
    fireEvent.pointerDown(screen.getByRole("button", { name: /Investigate deeply/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Full deep investigation/i }));
    for (let i = 0; i < 4; i++) { await act(async () => { await vi.advanceTimersByTimeAsync(900); }); }
    expect(send).toHaveBeenCalledWith({ type: "orchestrator_investigate", investigationId: ID });

    // 2. Server streams it → the inline region shows the running run.
    emit({ type: "orchestrator:started", investigationId: ID });
    emit({ type: "orchestrator:step", investigationId: ID, event: step(0, "impala-statestore") });
    expect(screen.getByText(/Deep Investigation · impala/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /stop the deep investigation/i })).toBeTruthy();

    // 3. Pause → region pause bar + a notification toast.
    emit({ type: "orchestrator:operator_pause", investigationId: ID, strikes: 3 });
    const pauseGroup = screen.getByRole("group", { name: /operator decision required/i });
    expect(screen.getByText(/Deep Investigation paused/i)).toBeTruthy(); // toast

    // 4. Operator decides "continue" from the region → client sends the decision.
    fireEvent.click(within(pauseGroup).getByRole("button", { name: /continue/i }));
    expect(send).toHaveBeenCalledWith({ type: "orchestrator_decision", investigationId: ID, decision: "continue" });
    expect(within(pauseGroup).getByText(/decision sent — controls locked/i)).toBeTruthy();

    // 5. Loop resumes (step clears the pause), then confirms a cause.
    emit({ type: "orchestrator:step", investigationId: ID, event: step(1) });
    expect(screen.queryByRole("group", { name: /operator decision required/i })).toBeNull();
    emit({
      type: "orchestrator:complete",
      investigationId: ID,
      outcome: "confirmed",
      stats: { moves: 6, toolCalls: 2, subagents: 1, tokensSpent: 100, strikes: 0, depth: 1, durationMs: 6000 },
      causalChain: [{ label: "impala", kind: "incident" }, { label: "root cause: statestore pool starvation", kind: "root-cause" }],
      traceSummary: "6 moves · confirmed at depth 1",
    });
    expect(screen.getByText("statestore pool starvation")).toBeTruthy();
    expect(screen.getByText(/Root cause confirmed/i)).toBeTruthy(); // completion toast

    // 6. Navigate away from the Console (unmount the region), then back — the run
    //    is still there because it lives in the registry, not the component.
    act(() => { showRegion = false; sync(); });
    expect(screen.queryByText("statestore pool starvation")).toBeNull();
    act(() => { showRegion = true; sync(); });
    expect(screen.getByText("statestore pool starvation")).toBeTruthy();
  });
});
