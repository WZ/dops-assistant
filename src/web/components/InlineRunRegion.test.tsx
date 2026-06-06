// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import type { ServerMessage, ClientMessage, AgentStreamEvent } from "../../types/ws-types.js";
import { OrchestratorRunProvider, useOrchestratorRunActions } from "../contexts/OrchestratorRunContext";
import { InlineRunRegion } from "./InlineRunRegion";

const ID = "inv_region";
const step = (seq: number, target?: string): AgentStreamEvent => ({ seq, verb: "testing", target, status: "running" });

function renderRegion(messages: ServerMessage[], send: (m: ClientMessage) => void = vi.fn()) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <OrchestratorRunProvider wsMessages={messages} wsSend={send} connectionStatus="connected">
      {children}
    </OrchestratorRunProvider>
  );
  return render(<InlineRunRegion investigationId={ID} service="impala" />, { wrapper });
}

const startedRunning: ServerMessage[] = [
  { type: "orchestrator:started", investigationId: ID },
  { type: "orchestrator:step", investigationId: ID, event: step(0, "impala-statestore") },
];

const confirmed: ServerMessage[] = [
  ...startedRunning,
  {
    type: "orchestrator:complete",
    investigationId: ID,
    outcome: "confirmed",
    stats: { moves: 5, toolCalls: 2, subagents: 1, tokensSpent: 100, strikes: 0, depth: 1, durationMs: 6000 },
    causalChain: [
      { label: "impala", kind: "incident" },
      { label: "root cause: statestore pool starvation", kind: "root-cause", evidence: "pool_used = 100%" },
    ],
    traceSummary: "5 moves · 2 queries · confirmed at depth 1",
  },
];

const paused: ServerMessage[] = [
  ...startedRunning,
  { type: "orchestrator:operator_pause", investigationId: ID, strikes: 3, hypothesesTried: ["a", "b", "c"] },
];

beforeEach(() => cleanup());

describe("InlineRunRegion", () => {
  it("renders nothing when there is no run for this investigation", () => {
    const { container } = renderRegion([]);
    expect(container.firstChild).toBeNull();
  });

  it("running orchestrator: shows the title, ephemerality notice, and a Stop control", () => {
    const send = vi.fn();
    renderRegion(startedRunning, send);
    expect(screen.getByText(/Deep Investigation · impala/)).toBeTruthy();
    expect(screen.getByText(/Working theory/i)).toBeTruthy();
    expect(screen.getByText(/this run stops if you reload/i)).toBeTruthy();
    // Stop → orchestrator_stop
    fireEvent.click(screen.getByRole("button", { name: /stop the deep investigation/i }));
    expect(send).toHaveBeenCalledWith({ type: "orchestrator_stop", investigationId: ID });
  });

  it("running Challenge (deep-mode) run shows NO Stop — it has no abort path", () => {
    // Codex review of #234: stop() only aborts orchestrator runs server-side,
    // so a Stop on a deep-mode run would be a dead button.
    renderRegion([{ type: "deep_mode:started", investigationId: ID }]);
    expect(screen.queryByRole("button", { name: /stop the deep investigation/i })).toBeNull();
  });

  it("confirmed run: result-first view shows the root cause headline + causal chain + trace", () => {
    renderRegion(confirmed);
    expect(screen.getByText("Current conclusion")).toBeTruthy();
    // headline drops the "root cause:" prefix; the chain keeps it — assert both.
    expect(screen.getByText("statestore pool starvation")).toBeTruthy();
    expect(screen.getByText(/root cause: statestore pool starvation/)).toBeTruthy();
    expect(screen.getByText(/confirmed at depth 1/)).toBeTruthy();
    // no Stop once finished
    expect(screen.queryByRole("button", { name: /stop the deep/i })).toBeNull();
  });

  it("collapse toggle hides the body (DZ2)", () => {
    renderRegion(confirmed);
    expect(screen.getByText("statestore pool starvation")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /click to collapse/i }));
    expect(screen.queryByText("statestore pool starvation")).toBeNull();
  });

  it("Result/Live toggle switches to the move stream", () => {
    renderRegion(confirmed);
    fireEvent.click(screen.getByRole("button", { name: "LIVE LOG" }));
    // the AgentStream footer surfaces the move count
    expect(screen.getByText(/moves/i)).toBeTruthy();
  });

  it("paused run: docked pause bar, decision routes through the registry and locks (D7)", () => {
    const send = vi.fn();
    renderRegion(paused, send);
    const group = screen.getByRole("group", { name: /operator decision required/i });
    fireEvent.click(within(group).getByRole("button", { name: /continue/i }));
    expect(send).toHaveBeenCalledWith({ type: "orchestrator_decision", investigationId: ID, decision: "continue" });
    expect(screen.getByText(/decision sent — controls locked/i)).toBeTruthy();
    // a second click is ignored (buttons disabled)
    expect((within(group).getByRole("button", { name: /escalate/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("pause bar stays visible even when the region is collapsed (DZ2)", () => {
    renderRegion(paused);
    fireEvent.click(screen.getByRole("button", { name: /click to collapse/i }));
    expect(screen.getByText(/needs your call/i)).toBeTruthy();
  });

  it("exposes a scoped assertive live region announcing the pause (DZ4)", () => {
    const { container } = renderRegion(paused);
    const live = container.querySelector('[aria-live="assertive"]');
    expect(live).toBeTruthy();
    expect(live!.textContent).toMatch(/your decision is needed/i);
  });
});

// ── PR-2 (T7): hydrated runs reconstructed from persisted events render right ──
//
// Mirrors what InvestigationPane does on a cold GET /api/investigations/:id:
// it hands the persisted `events` to the registry's hydrate(). Here a harness
// hydrates on mount (standing in for the GET-success callback), then we assert
// the inline surface renders the reconstructed run correctly.
type Row = { event_type: string; payload: string };
const env = (message: unknown) => JSON.stringify({ schemaVersion: 1, message });

const MIDFLIGHT_ROWS: Row[] = [
  { event_type: "orchestrator:started", payload: env({ type: "orchestrator:started", investigationId: ID }) },
  { event_type: "orchestrator:step", payload: env({ type: "orchestrator:step", investigationId: ID, event: step(0, "impala-statestore") }) },
];

const COMPLETED_ROWS: Row[] = [
  ...MIDFLIGHT_ROWS,
  { event_type: "orchestrator:complete", payload: env({
      type: "orchestrator:complete", investigationId: ID, outcome: "confirmed",
      stats: { moves: 2, toolCalls: 4, subagents: 0, tokensSpent: 900, strikes: 0, depth: 2, durationMs: 4321 },
      causalChain: [{ label: "impala", kind: "incident" }, { label: "root cause: statestore pool starvation", kind: "root-cause" }],
      traceSummary: "2 moves · confirmed at depth 2",
    }) },
];

const PAUSED_MIDFLIGHT_ROWS: Row[] = [
  ...MIDFLIGHT_ROWS,
  { event_type: "orchestrator:operator_pause", payload: env({ type: "orchestrator:operator_pause", investigationId: ID, strikes: 3, hypothesesTried: ["a"] }) },
];

/** Hydrate-on-mount harness, standing in for InvestigationPane's GET-success. */
function HydrateThenRender({ rows }: { rows: Row[] }) {
  const { hydrate } = useOrchestratorRunActions();
  useEffect(() => { hydrate(ID, rows); }, [hydrate, rows]);
  return <InlineRunRegion investigationId={ID} service="impala" />;
}

function renderHydrated(rows: Row[]) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <OrchestratorRunProvider wsMessages={[]} wsSend={vi.fn()} connectionStatus="connected">
      {children}
    </OrchestratorRunProvider>
  );
  return render(<HydrateThenRender rows={rows} />, { wrapper });
}

describe("InlineRunRegion — hydrated/interrupted (PR-2 T7)", () => {
  it("a mid-flight hydrated run renders INTERRUPTED: notice shown, no Stop, no ephemerality warning", () => {
    renderHydrated(MIDFLIGHT_ROWS);
    expect(screen.getByText("Interrupted")).toBeTruthy(); // the kicker (exact)
    expect(screen.getByText(/interrupted while investigating: impala-statestore/i)).toBeTruthy();
    expect(screen.getByText(/steps above are what completed/i)).toBeTruthy(); // the visible notice
    // no live affordances — the server lost this run on reload
    expect(screen.queryByRole("button", { name: /stop the deep investigation/i })).toBeNull();
    expect(screen.queryByText(/this run stops if you reload/i)).toBeNull();
  });

  it("announces the interruption on the scoped live region (DZ4)", () => {
    const { container } = renderHydrated(MIDFLIGHT_ROWS);
    const live = container.querySelector('[aria-live="assertive"]');
    expect(live!.textContent).toMatch(/interrupted when the page reloaded/i);
  });

  it("a COMPLETED hydrated run renders as a normal finished result (NOT interrupted)", () => {
    renderHydrated(COMPLETED_ROWS);
    expect(screen.getByText("statestore pool starvation")).toBeTruthy();
    expect(screen.getByText(/confirmed at depth 2/)).toBeTruthy();
    expect(screen.queryByText(/interrupted when the page reloaded/i)).toBeNull();
    expect(screen.queryByText(/^Interrupted$/)).toBeNull();
  });

  it("an interrupted run that was paused does NOT show actionable decision buttons", () => {
    renderHydrated(PAUSED_MIDFLIGHT_ROWS);
    expect(screen.getByText(/steps above are what completed/i)).toBeTruthy();
    // the docked pause bar (and its continue/escalate/wait buttons) is suppressed
    expect(screen.queryByRole("group", { name: /operator decision required/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /continue/i })).toBeNull();
  });
});
