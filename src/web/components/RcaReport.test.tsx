// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { RcaReport } from "./RcaReport";

function baseReport(overrides: Record<string, unknown> = {}) {
  return {
    rootCause: "payments backpressure",
    trigger: "payments latency",
    confidence: "high",
    confidenceScore: 0.85,
    severity: "critical",
    summary: "checkout OOM",
    impact: { duration: "10m", description: "checkout degraded" },
    contributingFactors: [],
    timeline: [],
    recommendedActions: [],
    dashboardLinks: [],
    ...overrides,
  };
}

describe("RcaReport — hypothesis loop output", () => {
  afterEach(() => cleanup());

  it("renders a Ruled Out section with struck-through hypotheses + reason glosses", () => {
    render(
      <RcaReport
        report={baseReport({
          ruledOut: [
            { hypothesis: "memory leak", reason: "absent" },
            { hypothesis: "traffic spike", reason: "contradicted" },
          ],
        }) as any}
      />,
    );
    expect(screen.getByText(/Ruled Out/)).toBeDefined();
    expect(screen.getByText(/memory leak/)).toBeDefined();
    expect(screen.getByText(/no supporting evidence found/)).toBeDefined();
    expect(screen.getByText(/evidence contradicted it/)).toBeDefined();
  });

  it("omits the Ruled Out section on the single-pass path (no loop fields)", () => {
    render(<RcaReport report={baseReport() as any} />);
    expect(screen.queryByText(/Ruled Out/)).toBeNull();
  });

  it("shows the undetermined notice when the loop couldn't distinguish causes", () => {
    render(<RcaReport report={baseReport({ loopOutcome: "undetermined" }) as any} />);
    expect(screen.getByText(/none could be distinguished/)).toBeDefined();
  });

  it("shows no undetermined notice when the loop confirmed a cause", () => {
    render(<RcaReport report={baseReport({ loopOutcome: "confirmed" }) as any} />);
    expect(screen.queryByText(/none could be distinguished/)).toBeNull();
  });
});

describe("RcaReport — deep mode output (Step 3)", () => {
  afterEach(() => cleanup());

  it("surfaces a resurrected cause prominently", () => {
    render(
      <RcaReport
        report={baseReport({
          ruledOut: [{ hypothesis: "disk pressure", reason: "absent" }],
          deepMode: {
            reexamined: [{ hypothesis: "disk pressure", priorVerdict: "absent", deepVerdict: "satisfied", resurrected: true }],
            resurrected: [{ hypothesis: "disk pressure" }],
            outcome: "resurrected-candidate",
          },
        }) as any}
      />,
    );
    expect(screen.getByText(/Deep Mode/)).toBeDefined();
    expect(screen.getByText(/brought back/)).toBeDefined();
    expect(screen.getByText(/deeper evidence now supports it/)).toBeDefined();
  });

  it("shows the rule-outs-confirmed reassurance when nothing came back", () => {
    render(
      <RcaReport
        report={baseReport({
          ruledOut: [{ hypothesis: "disk pressure", reason: "contradicted" }],
          deepMode: {
            reexamined: [{ hypothesis: "disk pressure", priorVerdict: "contradicted", deepVerdict: "contradicted", resurrected: false }],
            resurrected: [],
            outcome: "rule-outs-confirmed",
          },
        }) as any}
      />,
    );
    expect(screen.getByText(/The original conclusion stands/)).toBeDefined();
  });

  it("omits the Deep Mode section when deep mode wasn't run", () => {
    render(<RcaReport report={baseReport({ ruledOut: [{ hypothesis: "x", reason: "absent" }] }) as any} />);
    expect(screen.queryByText(/Deep Mode/)).toBeNull();
  });
});
