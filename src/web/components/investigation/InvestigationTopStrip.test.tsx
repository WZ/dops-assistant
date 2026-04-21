// src/web/components/investigation/InvestigationTopStrip.test.tsx
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { InvestigationTopStrip } from "./InvestigationTopStrip";

// PhaseState requires name + label (not "phase")
const noopPhases = [
  { name: "planning", label: "Planning", status: "complete" as const },
  { name: "metrics", label: "Metrics", status: "complete" as const },
  { name: "logs", label: "Logs", status: "running" as const },
];

describe("InvestigationTopStrip", () => {
  it("renders the phase stepper with all phases", () => {
    render(
      <InvestigationTopStrip
        phases={noopPhases}
        phaseTokens={{}}
        isRunning
        isComplete={false}
        confidencePct={null}
      />
    );
    expect(screen.getByText(/planning/i)).toBeInTheDocument();
    expect(screen.getByText(/metrics/i)).toBeInTheDocument();
    expect(screen.getByText(/logs/i)).toBeInTheDocument();
  });

  it("renders a confidence number when provided", () => {
    render(
      <InvestigationTopStrip
        phases={noopPhases}
        phaseTokens={{}}
        isRunning={false}
        isComplete={true}
        confidencePct={82}
      />
    );
    expect(screen.getByText("82%")).toBeInTheDocument();
  });

  it("does NOT render a confidence number when null", () => {
    const { container } = render(
      <InvestigationTopStrip
        phases={noopPhases}
        phaseTokens={{}}
        isRunning
        isComplete={false}
        confidencePct={null}
      />
    );
    // No element whose text is a percentage
    expect(container.textContent ?? "").not.toMatch(/\d+%/);
  });

  it("renders export and rerun slots when provided", () => {
    render(
      <InvestigationTopStrip
        phases={noopPhases}
        phaseTokens={{}}
        isRunning={false}
        isComplete={true}
        confidencePct={82}
        exportSlot={<button type="button">Export</button>}
        rerunSlot={<button type="button">Re-investigate</button>}
      />
    );
    expect(screen.getByRole("button", { name: /export/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /re-investigate/i })).toBeInTheDocument();
  });
});
