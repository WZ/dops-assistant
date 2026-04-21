// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { EvidenceColumn } from "./EvidenceColumn";

describe("EvidenceColumn", () => {
  it("renders the empty state when there are no charts", () => {
    render(<EvidenceColumn charts={[]} />);
    expect(screen.getByText(/no evidence/i)).toBeInTheDocument();
  });

  it("renders a mini-chart per item", () => {
    const charts = [
      {
        metric: "http_errors_total",
        query: "rate(http_errors[5m])",
        values: [
          ["1700000000", 1],
          ["1700000060", 2],
          ["1700000120", 3],
        ] as [string, number][],
      },
      {
        metric: "up",
        query: "up",
        values: [
          ["1700000000", 1],
          ["1700000060", 1],
          ["1700000120", 0],
        ] as [string, number][],
      },
    ];
    render(<EvidenceColumn charts={charts} />);
    expect(screen.getByText(/rate\(http_errors\[5m\]\)/)).toBeInTheDocument();
    expect(screen.getByText("up")).toBeInTheDocument();
  });
});
