// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { ServiceMetrics } from "./ServiceMetrics";

// Mock MetricChart to avoid SVG rendering complexity in jsdom
vi.mock("./MetricChart", () => ({
  MetricChart: ({ series }: { series: { metric: string } }) => (
    <div data-testid="metric-chart">{series.metric}</div>
  ),
}));

const TEST_SERVICE = "payment-service";

const SAMPLE_METRICS = [
  {
    name: "request_rate",
    query: "rate(http_requests_total[5m])",
    unit: "req/s",
    current: 142.5,
    values: [
      ["1711100000", 130],
      ["1711100060", 135],
      ["1711100120", 142.5],
    ] as [string, number][],
    min: 120,
    max: 155,
    avg: 138,
  },
  {
    name: "error_rate",
    query: "rate(http_errors_total[5m])",
    unit: "%",
    current: 0.5,
    values: [
      ["1711100000", 0.3],
      ["1711100060", 0.4],
      ["1711100120", 0.5],
    ] as [string, number][],
    min: 0.1,
    max: 0.8,
    avg: 0.4,
  },
];

describe("ServiceMetrics", () => {
  beforeEach(() => {
    cleanup();
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows loading shimmer initially", () => {
    // fetch never resolves — stays loading
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    render(<ServiceMetrics serviceName={TEST_SERVICE} />);
    // Loading state renders 4 shimmer divs with shimmer-skeleton
    const shimmers = document.querySelectorAll(".shimmer-skeleton");
    expect(shimmers.length).toBe(4);
  });

  it("shows error banner when fetch fails", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
    });

    render(<ServiceMetrics serviceName={TEST_SERVICE} />);

    await waitFor(() => {
      expect(screen.getByText(/Prometheus connection unavailable/)).toBeTruthy();
    });
  });

  it("shows metric cards when data loaded", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ metrics: SAMPLE_METRICS, cached: false }),
    });

    render(<ServiceMetrics serviceName={TEST_SERVICE} />);

    await waitFor(() => {
      // Both the label and the mocked chart show the name — use getAllByText
      expect(screen.getAllByText("request_rate").length).toBeGreaterThan(0);
      expect(screen.getAllByText("error_rate").length).toBeGreaterThan(0);
    });

    // Verify current values are displayed (142.50 formatted by toFixed(2))
    expect(screen.getByText("142.50")).toBeTruthy();
    expect(screen.getByText("0.50")).toBeTruthy();
  });

  it("time picker buttons exist (1h, 6h, 24h, 7d)", () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    render(<ServiceMetrics serviceName={TEST_SERVICE} />);

    expect(screen.getByText("1h")).toBeTruthy();
    expect(screen.getByText("6h")).toBeTruthy();
    expect(screen.getByText("24h")).toBeTruthy();
    expect(screen.getByText("7d")).toBeTruthy();
  });

  it("24h is default active time range", () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    render(<ServiceMetrics serviceName={TEST_SERVICE} />);

    const btn24h = screen.getByText("24h");
    // Active button has border-primary/60 class
    expect(btn24h.className).toContain("border-primary");
  });
});
