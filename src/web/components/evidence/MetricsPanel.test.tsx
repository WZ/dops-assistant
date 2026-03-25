// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MetricsPanel } from "./MetricsPanel";
import type { TimeSeriesData } from "../MetricChart";

const mockSeries: TimeSeriesData[] = [
  {
    metric: "cpu_usage",
    values: [["1711360000", 42], ["1711360060", 55], ["1711360120", 48]],
    min: 42, max: 55, avg: 48.3,
  },
];

describe("MetricsPanel", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders charts from timeSeries data", () => {
    render(<MetricsPanel timeSeries={mockSeries} textObservations={[]} service="test-svc" />);
    expect(screen.getByText(/cpu_usage/)).toBeDefined();
  });

  it("shows empty state when no data", () => {
    render(<MetricsPanel timeSeries={[]} textObservations={[]} service="test-svc" />);
    expect(screen.getByText(/No metric data collected/)).toBeDefined();
  });

  it("triggers extraction for text observations", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ series: [{ metric: "cpu_usage", values: [["1711360000", 94]], min: 94, max: 94, avg: 94 }] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    render(<MetricsPanel timeSeries={[]} textObservations={["CPU usage spiked to 94% at 14:32"]} service="payments-api" />);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("/api/metrics/extract", expect.objectContaining({ method: "POST" }));
    });
  });

  it("limits extraction to first 5 text observations", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ series: [] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const texts = Array.from({ length: 8 }, (_, i) => `Metric observation ${i}`);
    render(<MetricsPanel timeSeries={[]} textObservations={texts} service="svc" />);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(5);
    });
  });

  it("shows text card as fallback when extraction returns empty", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ series: [] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    render(<MetricsPanel timeSeries={[]} textObservations={["CPU spiked"]} service="svc" />);

    await waitFor(() => {
      expect(screen.getByText("CPU spiked")).toBeDefined();
    });
  });
});
