// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EvidenceTimeline } from "./EvidenceTimeline";
import { StackProvider } from "../contexts/StackContext";
import type { TimeSeriesData } from "./MetricChart";
import type { ReactNode } from "react";

function Wrapper({ children }: { children: ReactNode }) {
  return <StackProvider activeStackId="test-stack">{children}</StackProvider>;
}

vi.mock("./MetricChart", () => ({
  MetricChart: ({ series }: { series: { metric: string } }) => (
    <div data-testid="chart">{series.metric}</div>
  ),
}));

const mockTimeSeries: TimeSeriesData[] = [
  {
    metric: "cpu_usage",
    values: [["1711360000", 42], ["1711360060", 55]],
    min: 42,
    max: 55,
    avg: 48.5,
  },
];

const evidenceWithMetrics = {
  metrics: {
    observations: ["CPU usage spiked to 94% at 14:32", "Memory at 87%"],
    summary: "High resource usage",
  },
};

const evidenceWithLogs = {
  logs: {
    observations: [
      {
        pattern: "connection refused to postgres:5432",
        count: "247",
        firstSeen: "2026-03-25T14:31:00Z",
        lastSeen: "2026-03-25T14:45:00Z",
        sample: "ERROR connection refused",
        sampleLines: ["2026-03-25T14:31:12 ERROR connection refused"],
      },
    ],
  },
};

const evidenceWithInfra = {
  infra: {
    observations: [
      {
        resource: "pod/payments-api-7f8b9",
        status: "unhealthy",
        detail: "OOMKilled (memory limit 512Mi)",
        timestamp: "2026-03-25T14:28:00Z",
      },
    ],
  },
};

const evidenceWithBoth = {
  logs: {
    observations: [
      {
        pattern: "connection refused",
        count: "10",
        firstSeen: "2026-03-25T14:31:00Z",
        lastSeen: "2026-03-25T14:45:00Z",
      },
    ],
  },
  infra: {
    observations: [
      {
        resource: "pod/payments-api-7f8b9",
        status: "unhealthy",
        detail: "OOMKilled",
        timestamp: "2026-03-25T14:28:00Z",
      },
    ],
  },
};

describe("EvidenceTimeline", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ series: [] }),
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders metrics section when timeSeries present", () => {
    render(
      <EvidenceTimeline
        evidence={evidenceWithMetrics as any}
        timeSeries={mockTimeSeries}
        service="payments-api"
      />,
      { wrapper: Wrapper },
    );
    expect(screen.getByTestId("chart")).toBeDefined();
    expect(screen.getByText("cpu_usage")).toBeDefined();
  });

  it("hides metrics section when no metric data", () => {
    render(
      <EvidenceTimeline
        evidence={{} as any}
        timeSeries={[]}
        service="payments-api"
      />,
      { wrapper: Wrapper },
    );
    expect(screen.queryByTestId("chart")).toBeNull();
  });

  it("renders timeline entries sorted chronologically (infra at 14:28 before log at 14:31)", () => {
    render(
      <EvidenceTimeline
        evidence={evidenceWithBoth as any}
        timeSeries={[]}
        service="payments-api"
      />,
      { wrapper: Wrapper },
    );
    const items = screen.getAllByRole("listitem");
    expect(items.length).toBe(2);
    // infra OOMKilled (14:28) should come before log connection refused (14:31)
    expect(items[0].textContent).toContain("OOMKilled");
    expect(items[1].textContent).toContain("connection refused");
  });

  it("shows entry count in timeline header", () => {
    render(
      <EvidenceTimeline
        evidence={evidenceWithBoth as any}
        timeSeries={[]}
        service="payments-api"
      />,
      { wrapper: Wrapper },
    );
    // Count is shown in tab trigger as "Timeline (2)"
    expect(screen.getByText(/Timeline \(2\)/)).toBeDefined();
  });

  it("hides timeline when no log/infra evidence", () => {
    render(
      <EvidenceTimeline
        evidence={evidenceWithMetrics as any}
        timeSeries={mockTimeSeries}
        service="payments-api"
      />,
      { wrapper: Wrapper },
    );
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("renders log observations with pattern", () => {
    render(
      <EvidenceTimeline
        evidence={evidenceWithLogs as any}
        timeSeries={[]}
        service="payments-api"
      />,
      { wrapper: Wrapper },
    );
    expect(screen.getByText(/connection refused to postgres/)).toBeDefined();
  });

  it("renders infra observations with resource", () => {
    render(
      <EvidenceTimeline
        evidence={evidenceWithInfra as any}
        timeSeries={[]}
        service="payments-api"
      />,
      { wrapper: Wrapper },
    );
    expect(screen.getByText(/OOMKilled/)).toBeDefined();
  });

  it("surfaces a collapsed 'Queries run' receipt panel from evidenceToolCalls", () => {
    const providers = [{ role: "metrics", webUrl: "https://grafana.example", datasource: "prom" }];
    const evidenceToolCalls = {
      metrics: [{ tool: "query_prometheus", args: '{"expr":"up{job=\\"payments\\"}"}', resultChars: 64 }],
    };
    render(
      <EvidenceTimeline
        evidence={evidenceWithInfra as any}
        timeSeries={[]}
        service="payments-api"
        providers={providers}
        timeRange={{ from: "2026-03-14T11:00:00Z", to: "2026-03-14T12:00:00Z" }}
        evidenceToolCalls={evidenceToolCalls}
      />,
      { wrapper: Wrapper },
    );
    // Count is visible while collapsed
    expect(screen.getByText(/Queries run \(1\)/)).toBeDefined();
    // Expand to reveal the actual re-runnable query + Grafana link
    fireEvent.click(screen.getByText(/Queries run \(1\)/));
    expect(screen.getByText(/up\{job="payments"\}/)).toBeDefined();
    const link = screen.getByTitle("Open in Grafana") as HTMLAnchorElement;
    expect(link.href).toContain("grafana.example");
  });

  it("hides the 'Queries run' panel when no query is extractable", () => {
    const providers = [{ role: "metrics", webUrl: "https://grafana.example" }];
    render(
      <EvidenceTimeline
        evidence={evidenceWithInfra as any}
        timeSeries={[]}
        service="payments-api"
        providers={providers}
        timeRange={{ from: "2026-03-14T11:00:00Z", to: "2026-03-14T12:00:00Z" }}
        evidenceToolCalls={{ metrics: [{ tool: "list_datasources", args: "{}", resultChars: 10 }] }}
      />,
      { wrapper: Wrapper },
    );
    expect(screen.queryByText(/Queries run/)).toBeNull();
  });
});
