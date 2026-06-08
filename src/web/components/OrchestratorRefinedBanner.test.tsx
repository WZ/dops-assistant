// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { OrchestratorRefinement } from "../../types/rca-types.js";
import { OrchestratorRefinedBanner } from "./OrchestratorRefinedBanner";

const base: OrchestratorRefinement = {
  outcome: "confirmed",
  causalChain: [{ label: "root cause: pool exhaustion", kind: "root-cause" }],
  refinedAt: "2026-06-08T12:00:00.000Z",
  originalRootCause: "timeout in payments-api",
};

afterEach(() => cleanup());

describe("OrchestratorRefinedBanner", () => {
  it("renders the refined kicker and the preserved original root cause", () => {
    render(<OrchestratorRefinedBanner refinement={base} />);
    expect(screen.getByText(/Refined by deep investigation/i)).toBeTruthy();
    expect(screen.getByText(/timeout in payments-api/)).toBeTruthy();
    expect(screen.getByText(/^was:/)).toBeTruthy();
  });

  it("shows the operator steer when present, omits it otherwise", () => {
    const { unmount } = render(
      <OrchestratorRefinedBanner refinement={{ ...base, operatorNotes: "check the DB pool config" }} />,
    );
    expect(screen.getByText(/operator steer: check the DB pool config/)).toBeTruthy();
    unmount();
    render(<OrchestratorRefinedBanner refinement={base} />);
    expect(screen.queryByText(/operator steer:/)).toBeNull();
  });

  it("tolerates a missing/invalid refinedAt without crashing (no date chip)", () => {
    render(<OrchestratorRefinedBanner refinement={{ ...base, refinedAt: "" }} />);
    expect(screen.getByText(/Refined by deep investigation/i)).toBeTruthy();
  });

  it("falls back to an em dash when the original root cause is empty", () => {
    render(<OrchestratorRefinedBanner refinement={{ ...base, originalRootCause: "" }} />);
    expect(screen.getByText("—")).toBeTruthy();
  });
});
