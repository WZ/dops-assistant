// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ServerMessage, AgentStreamEvent } from "../../types/ws-types.js";
import { OrchestratorRunProvider } from "../contexts/OrchestratorRunContext";
import { StackProvider } from "../contexts/StackContext";
import { DeepInvestigationPanel } from "./DeepInvestigationPanel";

const ID = "inv_panel";
const step = (seq: number, target?: string): AgentStreamEvent => ({ seq, verb: "testing", target, status: "running" });

/** Mock global fetch (StackProvider's createStackFetch calls it). Default: a
 *  200 with a minimal investigation + no events (drives the empty/run states). */
function mockFetch(payload: unknown = { investigation: { service: "impala", query: "", status: "complete", report: null }, phases: [], events: [] }, status = 200) {
  global.fetch = vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => payload } as unknown as Response));
}

function renderPanel(messages: ServerMessage[], onBack = vi.fn()) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <StackProvider activeStackId="test-stack">
      <OrchestratorRunProvider wsMessages={messages} wsSend={vi.fn()} connectionStatus="connected">
        {children}
      </OrchestratorRunProvider>
    </StackProvider>
  );
  return render(<DeepInvestigationPanel investigationId={ID} onBack={onBack} service="impala" />, { wrapper });
}

beforeEach(() => {
  cleanup();
  (window as unknown as Record<string, unknown>).__ORCHESTRATOR_ENABLED__ = true;
  (window as unknown as Record<string, unknown>).__DEEP_MODE_ENABLED__ = true;
  mockFetch();
});
afterEach(() => { vi.restoreAllMocks(); });

const started: ServerMessage[] = [
  { type: "orchestrator:started", investigationId: ID },
  { type: "orchestrator:step", investigationId: ID, event: step(0, "impala-statestore") },
];

describe("DeepInvestigationPanel", () => {
  it("renders the wide panel for a live run: header, conclusion, move log, Stop, Back", () => {
    const onBack = vi.fn();
    renderPanel(started, onBack);
    expect(screen.getByRole("heading", { name: /Deep Investigation/ })).toBeTruthy();
    expect(screen.getAllByText(/impala-statestore/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Move log/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /stop the deep investigation/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /back to investigation/i }));
    expect(onBack).toHaveBeenCalled();
  });

  it("a paused run shows the docked decision bar", () => {
    renderPanel([...started, { type: "orchestrator:operator_pause", investigationId: ID, strikes: 3 }]);
    expect(screen.getByRole("group", { name: /operator decision required/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /continue/i })).toBeTruthy();
  });

  it("a parked run shows the Parked treatment, no Stop", () => {
    renderPanel([...started, { type: "orchestrator:parked", investigationId: ID }]);
    expect(screen.getByText(/parked itself while no one was watching/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /stop the deep investigation/i })).toBeNull();
  });

  it("empty state (no run) offers the Investigate-deeply menu to start one", async () => {
    renderPanel([]); // no run in the registry; GET resolves 200 with no events
    await waitFor(() => expect(screen.getByText(/No deep investigation yet/i)).toBeTruthy());
    expect(screen.getByRole("button", { name: /Investigate deeply/i })).toBeTruthy();
  });

  it("renders a not-found message when the investigation cannot be located", async () => {
    mockFetch({ error: "Not found" }, 404); // GET 404 → locate 404 → notFound
    renderPanel([]);
    await waitFor(() => expect(screen.getByText(/could not be found/i)).toBeTruthy());
  });
});
