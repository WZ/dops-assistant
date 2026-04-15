// src/web/components/RcaReport.test.tsx
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RcaReport } from "./RcaReport";
import type { Neighbor } from "../../types/workflow-state";

const baseReport = {
  rootCause: "Ingestion server failed to consume from Kafka",
  trigger: "Kafka broker-0 disk full at 14:23 UTC",
  confidence: "high",
  confidenceScore: 0.85,
  severity: "high",
  summary: "Ingestion-server rate drop due to Kafka broker failure",
  impact: { duration: "47 minutes", description: "Full ingestion pipeline halt" },
  contributingFactors: [],
  timeline: [],
  recommendedActions: [],
  dashboardLinks: [],
};

function mkNeighbor(overrides: Partial<Neighbor> = {}): Neighbor {
  return {
    name: "kafka-broker-0",
    directions: ["downstream"],
    status: "unhealthy",
    inServiceRegistry: true,
    ...overrides,
  };
}

describe("RcaReport — Dependency Context section", () => {
  it("does not render the section when report.neighbors is undefined", () => {
    const { container } = render(<RcaReport report={baseReport} />);
    expect(container.textContent).not.toContain("Dependency Context");
  });

  it("does not render the section when report.neighbors is empty", () => {
    const { container } = render(<RcaReport report={{ ...baseReport, neighbors: [] }} />);
    expect(container.textContent).not.toContain("Dependency Context");
  });

  it("renders the section header with a count badge when neighbors are present", () => {
    const neighbors = [mkNeighbor()];
    render(<RcaReport report={{ ...baseReport, neighbors }} />);
    expect(screen.getByText(/Dependency Context/i)).toBeDefined();
    // The CollapsibleSection renders "label (count)"; verify the 1 appears somewhere
    expect(screen.getByText(/\(1\)/)).toBeDefined();
  });

  it("renders neighbor names as links to /services/{name}", () => {
    const neighbors = [mkNeighbor({ name: "kafka-broker-0" })];
    const { container } = render(<RcaReport report={{ ...baseReport, neighbors }} />);
    const link = container.querySelector('a[href="/services/kafka-broker-0"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe("kafka-broker-0");
  });

  it("URL-encodes neighbor names with special characters", () => {
    // RcaReport uses encodeURIComponent on the href
    const neighbors = [mkNeighbor({ name: "svc with space" })];
    const { container } = render(<RcaReport report={{ ...baseReport, neighbors }} />);
    const link = container.querySelector("a[href^='/services/']");
    expect(link?.getAttribute("href")).toBe("/services/svc%20with%20space");
  });

  it("renders the status badge for each neighbor", () => {
    const neighbors = [
      mkNeighbor({ name: "kafka-broker-0", status: "unhealthy" }),
      mkNeighbor({ name: "web-frontend", status: "healthy", directions: ["upstream"] }),
    ];
    const { container } = render(<RcaReport report={{ ...baseReport, neighbors }} />);
    // Both status words appear somewhere in the rendered DOM
    expect(container.textContent).toContain("unhealthy");
    expect(container.textContent).toContain("healthy");
  });

  it("sorts neighbors by severity (unhealthy first) without mutating the prop", () => {
    const neighbors = [
      mkNeighbor({ name: "a-healthy", status: "healthy" }),
      mkNeighbor({ name: "b-unhealthy", status: "unhealthy" }),
      mkNeighbor({ name: "c-degraded", status: "degraded" }),
    ];
    const originalOrder = neighbors.map((n) => n.name);
    const { container } = render(<RcaReport report={{ ...baseReport, neighbors }} />);

    // Input prop must not be mutated
    expect(neighbors.map((n) => n.name)).toEqual(originalOrder);

    // Rendered order: unhealthy → degraded → healthy
    const links = Array.from(container.querySelectorAll("a[href^='/services/']"));
    const renderedNames = links.map((a) => a.textContent);
    expect(renderedNames).toEqual(["b-unhealthy", "c-degraded", "a-healthy"]);
  });

  it("shows the 'not in service registry' badge for off-registry neighbors", () => {
    const neighbors = [mkNeighbor({ name: "external-thing", inServiceRegistry: false })];
    const { container } = render(<RcaReport report={{ ...baseReport, neighbors }} />);
    expect(container.textContent).toContain("not in service registry");
  });

  it("renders metric samples when a neighbor has evidence", () => {
    const neighbors = [
      mkNeighbor({
        name: "kafka-broker-0",
        evidence: {
          metrics: [
            {
              query: 'up{service="kafka-broker-0"}',
              values: [
                ["1714060800", "0"],
                ["1714060815", "0"],
              ],
            },
          ],
          logs: [],
          fetchedAt: "2026-04-15T10:00:00Z",
          fetchErrors: [],
        },
      }),
    ];
    const { container } = render(<RcaReport report={{ ...baseReport, neighbors }} />);
    // The query string (truncated to 80 chars in the component) should appear
    expect(container.textContent).toContain('up{service="kafka-broker-0"}');
    expect(container.textContent).toContain("metric:");
  });

  it("renders log count when a neighbor has log evidence", () => {
    const neighbors = [
      mkNeighbor({
        name: "kafka-broker-0",
        evidence: {
          metrics: [],
          logs: [
            {
              query: '{service="kafka-broker-0"} |~ "error"',
              lines: ["2026-04-15T10:00:00Z broker shutdown"],
              count: 42,
            },
          ],
          fetchedAt: "2026-04-15T10:00:00Z",
          fetchErrors: [],
        },
      }),
    ];
    const { container } = render(<RcaReport report={{ ...baseReport, neighbors }} />);
    expect(container.textContent).toContain("logs:");
    expect(container.textContent).toContain("42 matches");
  });

  it("renders metric-fetch errors when evidence.metrics[*].error is set", () => {
    const neighbors = [
      mkNeighbor({
        name: "kafka-broker-0",
        evidence: {
          metrics: [
            { query: "up", values: [], error: "timeout" },
          ],
          logs: [],
          fetchedAt: "2026-04-15T10:00:00Z",
          fetchErrors: [],
        },
      }),
    ];
    const { container } = render(<RcaReport report={{ ...baseReport, neighbors }} />);
    expect(container.textContent).toContain("ERROR: timeout");
  });

  it("renders fetchErrors summary below the evidence when present", () => {
    const neighbors = [
      mkNeighbor({
        name: "kafka-broker-0",
        evidence: {
          metrics: [],
          logs: [],
          fetchedAt: "2026-04-15T10:00:00Z",
          fetchErrors: ["metrics: MCP unreachable"],
        },
      }),
    ];
    const { container } = render(<RcaReport report={{ ...baseReport, neighbors }} />);
    expect(container.textContent).toContain("metrics: MCP unreachable");
  });

  it("handles neighbors with both directions (bidirectional)", () => {
    const neighbors = [
      mkNeighbor({
        name: "shared-service",
        directions: ["downstream", "upstream"],
        status: "degraded",
      }),
    ];
    const { container } = render(<RcaReport report={{ ...baseReport, neighbors }} />);
    expect(container.textContent).toContain("downstream+upstream");
  });
});
