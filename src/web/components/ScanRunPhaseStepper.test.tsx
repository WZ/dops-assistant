// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ScanRunPhaseStepper, type ScanPhaseState } from "./ScanRunPhaseStepper";

describe("ScanRunPhaseStepper", () => {
  it("renders all three phases with their summaries", () => {
    const states: ScanPhaseState[] = [
      { phase: "probe", status: "complete", summary: "117 probed \u00B7 2.3s" },
      { phase: "triage", status: "running" },
      { phase: "investigate", status: "pending" },
    ];
    const { container } = render(<ScanRunPhaseStepper states={states} />);
    expect(container.textContent).toContain("probe");
    expect(container.textContent).toContain("117 probed");
    expect(container.textContent).toContain("triage");
    expect(container.textContent).toContain("investigate");
    expect(container.querySelectorAll("li")).toHaveLength(3);
  });

  it("marks running status with the pulse animation", () => {
    const states: ScanPhaseState[] = [
      { phase: "triage", status: "running" },
    ];
    const { container } = render(<ScanRunPhaseStepper states={states} />);
    const dot = container.querySelector("li span[aria-hidden='true']");
    expect(dot?.className).toContain("animate-status-pulse");
    expect(dot?.className).toContain("border-primary");
  });

  it("renders empty list gracefully", () => {
    const { container } = render(<ScanRunPhaseStepper states={[]} />);
    expect(container.querySelectorAll("li")).toHaveLength(0);
  });
});
