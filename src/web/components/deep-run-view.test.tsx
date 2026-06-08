// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { CausalChain, OperatorPauseBar } from "./deep-run-view";
import type { CausalChainLink } from "../../types/ws-types.js";

afterEach(cleanup);

const prov = {
  tool: "query_prometheus",
  args: JSON.stringify({ expr: "pool_used", datasource: "ds-from-args" }),
  from: "2026-01-01T00:00:00Z",
  to: "2026-01-01T01:00:00Z",
};
const providers = [{ role: "metrics", webUrl: "https://grafana.example", datasource: "prom-uid" }];

const rootCause = (extra: Partial<CausalChainLink> = {}): CausalChainLink[] => [
  { label: "impala", kind: "incident" },
  { label: "root cause: pool starvation", kind: "root-cause", evidence: "pool_used = 100%", ...extra },
];

describe("CausalChain Grafana deep-link (PR-3)", () => {
  it("renders a Grafana Explore link when provenance + provider + extractable query are present", () => {
    render(<CausalChain chain={rootCause({ provenance: prov })} providers={providers} />);
    const link = screen.getByRole("link", { name: /grafana/i }) as HTMLAnchorElement;
    expect(link.href).toContain("grafana.example");
    expect(link.href).toContain("/explore?");
    // datasource from the tool args wins over the provider default
    expect(decodeURIComponent(link.href)).toContain("ds-from-args");
    // the query string is threaded through
    expect(decodeURIComponent(link.href)).toContain("pool_used");
  });

  it("falls back to the provider datasource when the tool args omit one", () => {
    const noDs = { ...prov, args: JSON.stringify({ expr: "pool_used" }) };
    render(<CausalChain chain={rootCause({ provenance: noDs })} providers={providers} />);
    const link = screen.getByRole("link", { name: /grafana/i }) as HTMLAnchorElement;
    expect(decodeURIComponent(link.href)).toContain("prom-uid");
  });

  it("renders text-only (no link) when no providers are configured", () => {
    render(<CausalChain chain={rootCause({ provenance: prov })} providers={[]} />);
    expect(screen.queryByRole("link", { name: /grafana/i })).toBeNull();
    expect(screen.getByText(/pool_used = 100%/)).toBeTruthy();
  });

  it("renders text-only when the query is not extractable from the tool call", () => {
    const noQuery = { ...prov, args: JSON.stringify({ unrelated: "field" }) };
    render(<CausalChain chain={rootCause({ provenance: noQuery })} providers={providers} />);
    expect(screen.queryByRole("link", { name: /grafana/i })).toBeNull();
  });

  it("REGRESSION: a link without provenance renders text-only, unchanged", () => {
    render(<CausalChain chain={rootCause()} providers={providers} />);
    expect(screen.queryByRole("link", { name: /grafana/i })).toBeNull();
    expect(screen.getByText("root cause: pool starvation")).toBeTruthy();
  });

  it("REGRESSION: provenance present but time window missing → no link (graceful)", () => {
    const noWindow = { tool: "query_prometheus", args: JSON.stringify({ expr: "pool_used" }) };
    render(<CausalChain chain={rootCause({ provenance: noWindow })} providers={providers} />);
    expect(screen.queryByRole("link", { name: /grafana/i })).toBeNull();
  });
});

describe("OperatorPauseBar continue-with-context (PR-4)", () => {
  it("typing a lead + Continue calls onDecide('continue', lead)", () => {
    const onDecide = vi.fn();
    render(<OperatorPauseBar strikes={3} locked={false} onDecide={onDecide} />);
    fireEvent.change(screen.getByLabelText(/optional lead/i), { target: { value: "check the DB pool" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(onDecide).toHaveBeenCalledWith("continue", "check the DB pool");
  });

  it("Escalate / Wait send no lead", () => {
    const onDecide = vi.fn();
    render(<OperatorPauseBar strikes={3} locked={false} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole("button", { name: /escalate/i }));
    expect(onDecide).toHaveBeenCalledWith("escalate");
    onDecide.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /instrument/i }));
    expect(onDecide).toHaveBeenCalledWith("wait");
  });

  it("when locked: hides the textarea, disables the buttons, shows the steered-with lead read-only", () => {
    render(<OperatorPauseBar strikes={2} locked operatorContext="started after the 14:00 deploy" onDecide={vi.fn()} />);
    expect(screen.queryByLabelText(/optional lead/i)).toBeNull();
    expect((screen.getByRole("button", { name: /continue/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/steered with:/i)).toBeTruthy();
    expect(screen.getByText(/started after the 14:00 deploy/)).toBeTruthy();
  });
});

import { computeRevision, RevisionDiff } from "./deep-run-view";
import type { DeepRunState } from "../contexts/OrchestratorRunContext";
import type { RcaReport } from "../../types/rca-types";

const baseReport = (over: Partial<RcaReport> = {}): RcaReport =>
  ({ rootCause: "memory exhaustion", ruledOut: [], ...over } as RcaReport);

const orchRun = (over: Partial<DeepRunState> = {}): DeepRunState =>
  ({ kind: "orchestrator", running: false, steps: [], ...over } as DeepRunState);
const deepRun = (over: Partial<DeepRunState> = {}): DeepRunState =>
  ({ kind: "deep-mode", running: false, steps: [], ...over } as DeepRunState);
const rootLink = (label: string) => [{ label: `root cause: ${label}`, kind: "root-cause" as const }];

describe("computeRevision (PR-5)", () => {
  it("orchestrator: revised root cause differs from the original → kind orchestrator", () => {
    const r = computeRevision(orchRun({ causalChain: rootLink("statestore pool starvation"), outcome: "confirmed" }), baseReport());
    expect(r).toEqual({ kind: "orchestrator", before: "memory exhaustion", after: "statestore pool starvation", outcome: "confirmed" });
  });

  it("orchestrator: revised equals original (normalized) → none, confirms", () => {
    const r = computeRevision(orchRun({ causalChain: rootLink("  Memory   Exhaustion ") }), baseReport());
    expect(r).toEqual({ kind: "none", confirms: true });
  });

  it("orchestrator: no root-cause link → none", () => {
    expect(computeRevision(orchRun({ causalChain: [{ label: "svc", kind: "incident" }] }), baseReport()).kind).toBe("none");
  });

  it("deep-mode: resurrected → kind deep-mode with hypothesis names", () => {
    const report = baseReport({ deepMode: { reexamined: [], resurrected: [{ hypothesis: "disk pressure", prediction: {} }], shaken: [], outcome: "resurrected-candidate" } as any });
    const r = computeRevision(deepRun({ report }), baseReport());
    expect(r).toMatchObject({ kind: "deep-mode", resurrected: ["disk pressure"], shaken: [] });
  });

  it("deep-mode: cold reload — verdict read from originalReport.deepMode when run.report is absent (D5)", () => {
    const persisted = baseReport({ deepMode: { reexamined: [], resurrected: [], shaken: [{ hypothesis: "the original cause", prediction: {} }], outcome: "confirmation-shaken" } as any });
    const r = computeRevision(deepRun({ report: undefined }), persisted);
    expect(r).toMatchObject({ kind: "deep-mode", shaken: ["the original cause"] });
  });

  it("deep-mode: holds (0 resurrected, 0 shaken) → none, confirms", () => {
    const report = baseReport({ deepMode: { reexamined: [], resurrected: [], shaken: [], outcome: "holds" } as any });
    expect(computeRevision(deepRun({ report }), report)).toEqual({ kind: "none", confirms: true });
  });

  it("no original report → none (nothing to diff)", () => {
    expect(computeRevision(orchRun({ causalChain: rootLink("x") }), null).kind).toBe("none");
  });

  it("a running run → none (only diff a finished run)", () => {
    expect(computeRevision(orchRun({ running: true, causalChain: rootLink("x") }), baseReport()).kind).toBe("none");
  });

  it("cold reload (no run) — reads the persisted deep-mode verdict from the report (codex P2)", () => {
    const persisted = baseReport({ deepMode: { reexamined: [], resurrected: [{ hypothesis: "disk pressure", prediction: {} }], shaken: [], outcome: "resurrected-candidate" } as any });
    expect(computeRevision(undefined, persisted)).toMatchObject({ kind: "deep-mode", resurrected: ["disk pressure"] });
  });

  it("cold reload (no run), deep-mode held → none, confirms", () => {
    const persisted = baseReport({ deepMode: { reexamined: [], resurrected: [], shaken: [], outcome: "holds" } as any });
    expect(computeRevision(undefined, persisted)).toEqual({ kind: "none", confirms: true });
  });

  it("cold reload (no run), no deep-mode on the report → none", () => {
    expect(computeRevision(undefined, baseReport()).kind).toBe("none");
  });
});

describe("RevisionDiff render (PR-5)", () => {
  it("orchestrator → shows BEFORE and AFTER", () => {
    render(<RevisionDiff result={{ kind: "orchestrator", before: "memory exhaustion", after: "pool starvation" }} />);
    expect(screen.getByText("memory exhaustion")).toBeTruthy();
    expect(screen.getByText("pool starvation")).toBeTruthy();
    expect(screen.getByText(/revised vs the original/i)).toBeTruthy();
  });

  it("deep-mode → lists resurrected and shaken cause names", () => {
    render(<RevisionDiff result={{ kind: "deep-mode", resurrected: ["disk pressure"], shaken: ["old cause"] }} />);
    expect(screen.getByText(/disk pressure/)).toBeTruthy();
    expect(screen.getByText(/old cause/)).toBeTruthy();
    expect(screen.getByText(/Resurrected/)).toBeTruthy();
    expect(screen.getByText(/Shaken/)).toBeTruthy();
  });

  it("none + confirms → quiet confirm line", () => {
    render(<RevisionDiff result={{ kind: "none", confirms: true }} />);
    expect(screen.getByText(/confirms the original/i)).toBeTruthy();
  });

  it("none without confirms → renders nothing", () => {
    const { container } = render(<RevisionDiff result={{ kind: "none" }} />);
    expect(container.textContent).toBe("");
  });
});
