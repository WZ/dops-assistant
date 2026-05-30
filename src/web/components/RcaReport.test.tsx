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
