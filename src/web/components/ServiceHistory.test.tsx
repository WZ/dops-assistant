// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { ServiceHistory } from "./ServiceHistory";

const TEST_SERVICE = "payment-service";

const SAMPLE_INVESTIGATIONS = [
  {
    id: "inv-001",
    service: TEST_SERVICE,
    query: "High error rate on payment-service",
    status: "complete" as const,
    confidence_score: 0.87,
    created_at: new Date(Date.now() - 3600_000).toISOString(), // 1h ago
    completed_at: new Date(Date.now() - 3500_000).toISOString(),
    total_duration_ms: 100_000,
  },
  {
    id: "inv-002",
    service: TEST_SERVICE,
    query: "Latency spike in checkout flow",
    status: "failed" as const,
    confidence_score: null,
    created_at: new Date(Date.now() - 86400_000).toISOString(), // 1d ago
    completed_at: null,
    total_duration_ms: null,
  },
  {
    id: "inv-003",
    service: TEST_SERVICE,
    query: "Memory usage investigation",
    status: "running" as const,
    confidence_score: null,
    created_at: new Date(Date.now() - 60_000).toISOString(), // 1m ago
    completed_at: null,
    total_duration_ms: null,
  },
];

describe("ServiceHistory", () => {
  beforeEach(() => {
    cleanup();
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows empty state when no investigations", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ investigations: [] }),
    });

    render(
      <ServiceHistory serviceName={TEST_SERVICE} onViewInvestigation={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.getByText(/No investigations yet/)).toBeTruthy();
    });
  });

  it("shows investigation list when data exists", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ investigations: SAMPLE_INVESTIGATIONS }),
    });

    render(
      <ServiceHistory serviceName={TEST_SERVICE} onViewInvestigation={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.getByText("High error rate on payment-service")).toBeTruthy();
      expect(screen.getByText("Latency spike in checkout flow")).toBeTruthy();
      expect(screen.getByText("Memory usage investigation")).toBeTruthy();
    });
  });

  it("each investigation shows query text and status dot", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ investigations: SAMPLE_INVESTIGATIONS }),
    });

    const { container } = render(
      <ServiceHistory serviceName={TEST_SERVICE} onViewInvestigation={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.getByText("High error rate on payment-service")).toBeTruthy();
    });

    // Status dots: green for complete, red for failed, blue for running
    const dots = container.querySelectorAll(".rounded-full");
    expect(dots.length).toBe(3);

    // Verify CSS classes map correctly to statuses
    const dotClasses = Array.from(dots).map((el) => el.className);
    expect(dotClasses.some((c) => c.includes("bg-green-500"))).toBe(true); // complete
    expect(dotClasses.some((c) => c.includes("bg-red-500"))).toBe(true); // failed
    expect(dotClasses.some((c) => c.includes("bg-blue-500"))).toBe(true); // running
  });

  it("click calls onViewInvestigation with correct ID", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ investigations: SAMPLE_INVESTIGATIONS }),
    });

    const onViewInvestigation = vi.fn();
    render(
      <ServiceHistory serviceName={TEST_SERVICE} onViewInvestigation={onViewInvestigation} />
    );

    await waitFor(() => {
      expect(screen.getByText("High error rate on payment-service")).toBeTruthy();
    });

    // Click the first investigation row
    fireEvent.click(screen.getByText("High error rate on payment-service"));
    expect(onViewInvestigation).toHaveBeenCalledWith("inv-001");

    // Click the second
    fireEvent.click(screen.getByText("Latency spike in checkout flow"));
    expect(onViewInvestigation).toHaveBeenCalledWith("inv-002");
  });

  it("shows confidence score when present", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ investigations: SAMPLE_INVESTIGATIONS }),
    });

    render(
      <ServiceHistory serviceName={TEST_SERVICE} onViewInvestigation={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.getByText("87% confidence")).toBeTruthy();
    });
  });
});
