// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, within, act } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import type { ServerMessage, ClientMessage, AgentStreamEvent } from "../../types/ws-types.js";
import { OrchestratorRunProvider, useOrchestratorRunActions } from "../contexts/OrchestratorRunContext";
import { InlineRunRegion } from "./InlineRunRegion";

// PR-3: InlineRunRegion reads Grafana providers via useGrafanaProviders. Stub it
// (no providers → deep-link path inert) so these tests stay free of StackContext
// + the async /api/providers fetch; the hook itself is covered in its own test.
vi.mock("../hooks/useGrafanaProviders", () => ({ useGrafanaProviders: () => [] }));

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

  it("running orchestrator: shows the band stamp + a Stop control (inline redesign)", () => {
    const send = vi.fn();
    renderRegion(startedRunning, send);
    // The band's "Deep Investigation" stamp identifies the run (no title bar / no
    // RESULT|LIVE toggle anymore — the live log is the only view while running).
    expect(screen.getByText("Deep Investigation")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "RESULT" })).toBeNull();
    expect(screen.queryByText(/this run stops if you reload/i)).toBeNull();
    // Stop → orchestrator_stop, then the control flips to a "Stopping…" status
    // while the abort is in flight (the server finishes the in-flight move first).
    fireEvent.click(screen.getByRole("button", { name: /stop the deep investigation/i }));
    expect(send).toHaveBeenCalledWith({ type: "orchestrator_stop", investigationId: ID });
    expect(screen.getByText(/Stopping/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /stop the deep investigation/i })).toBeNull();
  });

  it("running Challenge (deep-mode) run shows NO Stop — it has no abort path", () => {
    // Codex review of #234: stop() only aborts orchestrator runs server-side,
    // so a Stop on a deep-mode run would be a dead button.
    renderRegion([{ type: "deep_mode:started", investigationId: ID }]);
    expect(screen.queryByRole("button", { name: /stop the deep investigation/i })).toBeNull();
  });

  it("confirmed run: shows the conclusion + causal chain + trace inline (no toggle)", () => {
    renderRegion(confirmed);
    // The conclusion renders inline once finished — no RESULT click needed.
    // headline drops the "root cause:" prefix; the chain keeps it — assert both.
    expect(screen.getByText("statestore pool starvation")).toBeTruthy();
    expect(screen.getByText(/root cause: statestore pool starvation/)).toBeTruthy();
    expect(screen.getByText(/confirmed at depth 1/)).toBeTruthy();
    // the "DEEP INVESTIGATION" delimiter persists (state shows in the conclusion);
    // no Stop once finished.
    expect(screen.getByText("Deep Investigation")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /stop the deep/i })).toBeNull();
    // the move log is NOT hidden after finishing — the explored steps stay.
    expect(screen.getByText(/impala-statestore/)).toBeTruthy();
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

  it("the live timer is anchored to the run's start and survives a Console remount (PR-6)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-08T12:00:00.000Z"));
    // The provider holds the run (with startedAt); only InlineRunRegion toggles,
    // standing in for the operator navigating away from the Console and back.
    const Harness = ({ show }: { show: boolean }) => (
      <OrchestratorRunProvider wsMessages={startedRunning} wsSend={vi.fn()} connectionStatus="connected">
        {show ? <InlineRunRegion investigationId={ID} service="impala" /> : <div />}
      </OrchestratorRunProvider>
    );
    const { rerender } = render(<Harness show={true} />);

    // 30s pass (advanceTimersByTime moves the mocked clock + fires the 1s tick).
    // Both timers (strip "· 30s" + live header "· live · 30s") read 30s.
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(screen.getAllByText(/30s/).length).toBeGreaterThan(0);

    // "Click out" (unmount the region) then back — the timers must NOT reset to 0.
    rerender(<Harness show={false} />);
    rerender(<Harness show={true} />);
    expect(screen.getAllByText(/30s/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/· 0s/)).toBeNull();
    expect(screen.queryByText(/live · 0s/)).toBeNull();
    vi.useRealTimers();
  });

  it("exposes a scoped assertive live region announcing the pause (DZ4)", () => {
    const { container } = renderRegion(paused);
    const live = container.querySelector('[aria-live="assertive"]');
    expect(live).toBeTruthy();
    expect(live!.textContent).toMatch(/your decision is needed/i);
  });

  // ── PR-6b: Apply to report ──────────────────────────────────────────────
  it("confirmed orchestrator run: shows Apply to report; click sends orchestrator_accept", () => {
    const send = vi.fn();
    renderRegion(confirmed, send);
    const apply = screen.getByRole("button", { name: /apply this confirmed deep-investigation/i });
    fireEvent.click(apply);
    expect(send).toHaveBeenCalledWith({ type: "orchestrator_accept", investigationId: ID });
  });

  it("Apply flips to a '✓ applied to report' confirmation after orchestrator:accepted", () => {
    renderRegion([...confirmed, { type: "orchestrator:accepted", investigationId: ID, report: {} }]);
    expect(screen.getByText(/applied to report/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /apply this confirmed deep-investigation/i })).toBeNull();
  });

  it("surfaces an accept rejection notice and keeps the Apply button for a retry", () => {
    renderRegion([
      ...confirmed,
      { type: "orchestrator:accept_rejected", investigationId: ID, message: "Investigation report not found." },
    ]);
    expect(screen.getByText(/Investigation report not found/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /apply this confirmed deep-investigation/i })).toBeTruthy();
  });

  it("no Apply button while the orchestrator run is still running", () => {
    renderRegion(startedRunning);
    expect(screen.queryByRole("button", { name: /apply this confirmed deep-investigation/i })).toBeNull();
  });

  it("no Apply button when the run is NOT confirmed", () => {
    renderRegion([
      ...startedRunning,
      { type: "orchestrator:complete", investigationId: ID, outcome: "inconclusive",
        stats: { moves: 1, toolCalls: 0, subagents: 0, tokensSpent: 1, strikes: 0, depth: 0, durationMs: 100 } },
    ]);
    expect(screen.queryByRole("button", { name: /apply this confirmed deep-investigation/i })).toBeNull();
  });

  it("no Apply button for a deep-mode (Challenge) run, even when complete", () => {
    renderRegion([
      { type: "deep_mode:started", investigationId: ID },
      { type: "deep_mode:complete", investigationId: ID, report: { rootCause: "x" } },
    ]);
    expect(screen.queryByRole("button", { name: /apply this confirmed deep-investigation/i })).toBeNull();
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
  it("a mid-flight hydrated run renders INTERRUPTED: notice + Interrupted stamp, no Stop", () => {
    renderHydrated(MIDFLIGHT_ROWS);
    expect(screen.getByText(/steps above are what completed/i)).toBeTruthy();
    // no live affordances — the server lost this run on reload
    expect(screen.queryByRole("button", { name: /stop the deep investigation/i })).toBeNull();
    expect(screen.queryByText(/this run stops if you reload/i)).toBeNull();
    // The delimiter persists as "DEEP INVESTIGATION"; the interrupted state is
    // carried by the notice, not the stamp.
    expect(screen.getByText("Deep Investigation")).toBeTruthy();
  });

  it("announces the interruption on the scoped live region (DZ4)", () => {
    const { container } = renderHydrated(MIDFLIGHT_ROWS);
    const live = container.querySelector('[aria-live="assertive"]');
    expect(live!.textContent).toMatch(/interrupted when the page reloaded/i);
  });

  it("an interrupted run offers a RE-RUN button that relaunches the run (PR-6)", () => {
    const send = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <OrchestratorRunProvider wsMessages={[]} wsSend={send} connectionStatus="connected">
        {children}
      </OrchestratorRunProvider>
    );
    render(<HydrateThenRender rows={MIDFLIGHT_ROWS} />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: /re-run this deep investigation/i }));
    // An orchestrator (Full) run relaunches via orchestrator_investigate.
    expect(send).toHaveBeenCalledWith({ type: "orchestrator_investigate", investigationId: ID });
  });

  it("a COMPLETED hydrated run renders as a normal finished result (NOT interrupted)", () => {
    renderHydrated(COMPLETED_ROWS);
    expect(screen.queryByText(/interrupted when the page reloaded/i)).toBeNull();
    expect(screen.queryByText("Interrupted")).toBeNull();
    // The conclusion renders inline (no RESULT toggle).
    expect(screen.getByText("statestore pool starvation")).toBeTruthy();
    expect(screen.getByText(/confirmed at depth 2/)).toBeTruthy();
  });

  it("an interrupted run that was paused does NOT show actionable decision buttons", () => {
    renderHydrated(PAUSED_MIDFLIGHT_ROWS);
    expect(screen.getByText(/steps above are what completed/i)).toBeTruthy();
    // the docked pause bar (and its continue/escalate/wait buttons) is suppressed
    expect(screen.queryByRole("group", { name: /operator decision required/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /continue/i })).toBeNull();
  });
});

describe("InlineRunRegion — parked (PR-2c)", () => {
  const parked: ServerMessage[] = [
    { type: "orchestrator:started", investigationId: ID },
    { type: "orchestrator:step", investigationId: ID, event: step(0, "impala-statestore") },
    { type: "orchestrator:parked", investigationId: ID },
  ];

  it("a parked run renders the Parked state: resume notice + Parked stamp, no Stop control", () => {
    renderRegion(parked);
    expect(screen.getByText(/parked itself while no one was watching/i)).toBeTruthy();
    // not a live affordance and not "interrupted"
    expect(screen.queryByRole("button", { name: /stop the deep investigation/i })).toBeNull();
    expect(screen.queryByText(/can't be resumed here/i)).toBeNull();
    // The delimiter persists as "DEEP INVESTIGATION"; the parked state is carried
    // by the resume notice, not the stamp.
    expect(screen.getByText("Deep Investigation")).toBeTruthy();
  });

  it("a live step after parking clears the Parked state (resumed)", () => {
    renderRegion([...parked, { type: "orchestrator:step", investigationId: ID, event: step(1, "checking pool") }]);
    // The parked notice is gone — the run resumed.
    expect(screen.queryByText(/parked itself while no one was watching/i)).toBeNull();
    // Resumed → live band; the current-move indicator shows what it's checking.
    expect(screen.getByText(/checking pool/)).toBeTruthy();
  });
});
