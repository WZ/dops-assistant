// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { ServiceDetail } from "./ServiceDetail.js";

// Mock child components that have heavy dependencies (ReactFlow, etc.)
vi.mock("./ServiceDependencyGraph", () => ({
  ServiceDependencyGraph: ({ serviceName }: { serviceName: string }) => (
    <div data-testid="dependency-graph">Dependencies for {serviceName}</div>
  ),
}));

// ── Test data ──────────────────────────────────────────────────────────────

const TEST_SERVICE = "payment-service";

function mockFetchResponses(overrides?: {
  metadata?: Record<string, unknown>;
  health?: Record<string, string>;
  investigations?: Record<string, unknown>;
}) {
  const metadata = overrides?.metadata ?? { alias: "Payments", tags: ["backend", "critical"] };
  const health = overrides?.health ?? { [TEST_SERVICE]: "healthy" };
  const investigations = overrides?.investigations ?? { total: 5, investigations: [{ id: "inv-1" }] };

  (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string | Request) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("/metadata")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(metadata) });
    }
    if (urlStr.includes("/api/services/health")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(health) });
    }
    if (urlStr.includes("/api/investigations")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(investigations) });
    }
    // Metrics endpoint for ServiceMetrics tab
    if (urlStr.includes("/metrics")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ metrics: [], cached: false }) });
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  });
}

function renderServiceDetail(overrides?: Partial<React.ComponentProps<typeof ServiceDetail>>) {
  const defaultProps = {
    serviceName: TEST_SERVICE,
    ws: { send: vi.fn(), messages: [] as any[] },
    onBack: vi.fn(),
    onViewInvestigation: vi.fn(),
    onViewService: vi.fn(),
  };
  return render(<ServiceDetail {...defaultProps} {...overrides} />);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("ServiceDetail", () => {
  beforeEach(() => {
    cleanup();
    globalThis.fetch = vi.fn();
    mockFetchResponses();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders header with service name", async () => {
    renderServiceDetail();
    await waitFor(() => {
      // The header should display the alias ("Payments") as the heading
      expect(screen.getByText("Payments")).toBeTruthy();
    });
  });

  it("defaults to Metrics tab active", () => {
    renderServiceDetail();
    const metricsTab = screen.getByRole("tab", { name: /Metrics/i });
    expect(metricsTab.getAttribute("aria-selected")).toBe("true");
  });

  it("switches to History tab on click", async () => {
    renderServiceDetail();

    // Wait for initial fetches to settle
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /History/i })).toBeTruthy();
    });

    const historyTab = screen.getByRole("tab", { name: /History/i });
    fireEvent.click(historyTab);

    expect(historyTab.getAttribute("aria-selected")).toBe("true");
    // Metrics tab should no longer be selected
    const metricsTab = screen.getByRole("tab", { name: /Metrics/i });
    expect(metricsTab.getAttribute("aria-selected")).toBe("false");
  });

  it("back button triggers onBack callback", async () => {
    const onBack = vi.fn();
    renderServiceDetail({ onBack });

    await waitFor(() => {
      expect(screen.getByLabelText("Back to dashboard")).toBeTruthy();
    });

    fireEvent.click(screen.getByLabelText("Back to dashboard"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("shows investigation count in History tab label", async () => {
    renderServiceDetail();
    await waitFor(() => {
      // The mock returns total: 5, so tab should show "History (5)"
      expect(screen.getByRole("tab", { name: /History \(5\)/i })).toBeTruthy();
    });
  });
});
