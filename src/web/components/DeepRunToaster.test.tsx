// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ServerMessage, AgentStreamEvent } from "../../types/ws-types.js";
import { OrchestratorRunProvider } from "../contexts/OrchestratorRunContext";
import { DeepRunToaster } from "./DeepRunToaster";

const ID = "inv_toast";
const step = (seq: number): AgentStreamEvent => ({ seq, verb: "testing", status: "running" });

function setup(onView = vi.fn()) {
  const ref = { current: [] as ServerMessage[] };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <OrchestratorRunProvider wsMessages={ref.current} wsSend={vi.fn()} connectionStatus="connected">
      {children}
    </OrchestratorRunProvider>
  );
  const utils = render(<DeepRunToaster onView={onView} />, { wrapper });
  const emit = (msg: ServerMessage) => act(() => { ref.current = [...ref.current, msg]; utils.rerender(<DeepRunToaster onView={onView} />); });
  return { ...utils, emit, onView };
}

beforeEach(() => cleanup());

describe("DeepRunToaster", () => {
  it("toasts when a run transitions to paused, and the toast jumps to the run", () => {
    const { emit, onView } = setup();
    emit({ type: "orchestrator:started", investigationId: ID });
    emit({ type: "orchestrator:step", investigationId: ID, event: step(0) });
    expect(screen.queryByText(/Deep Investigation paused/i)).toBeNull();
    emit({ type: "orchestrator:operator_pause", investigationId: ID, strikes: 3 });
    const toast = screen.getByText(/Deep Investigation paused/i);
    expect(toast).toBeTruthy();
    fireEvent.click(toast);
    expect(onView).toHaveBeenCalledWith(ID);
    expect(screen.queryByText(/Deep Investigation paused/i)).toBeNull(); // dismissed on click
  });

  it("toasts 'Root cause confirmed' on a confirmed completion", () => {
    const { emit } = setup();
    emit({ type: "orchestrator:started", investigationId: ID });
    emit({
      type: "orchestrator:complete",
      investigationId: ID,
      outcome: "confirmed",
      stats: { moves: 5, toolCalls: 2, subagents: 0, tokensSpent: 100, strikes: 0, depth: 1, durationMs: 1000 },
    });
    expect(screen.getByText(/Root cause confirmed/i)).toBeTruthy();
  });

  it("renders nothing until a transition fires", () => {
    const { container } = setup();
    expect(container.firstChild).toBeNull();
  });
});
