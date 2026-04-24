// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { ServiceDetail } from "./ServiceDetail.js";
import { StackProvider } from "../contexts/StackContext";
import type { ReactNode } from "react";

function Wrapper({ children }: { children: ReactNode }) {
  return <StackProvider activeStackId="test-stack">{children}</StackProvider>;
}

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
  const investigations = overrides?.investigations ?? [{ id: "inv-1" }, { id: "inv-2" }, { id: "inv-3" }, { id: "inv-4" }, { id: "inv-5" }];

  (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string | Request) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("/metadata")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(metadata) });
    }
    if (urlStr.includes("/api/services/health")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(health) });
    }
    if (urlStr.includes("/api/investigations")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          rows: investigations,
          total: investigations.length,
          hasMore: false,
        }),
      });
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
  return render(<ServiceDetail {...defaultProps} {...overrides} />, { wrapper: Wrapper });
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

  it("defaults to Overview tab active", () => {
    renderServiceDetail();
    const overviewTab = screen.getByRole("tab", { name: /Overview/i });
    expect(overviewTab.getAttribute("aria-selected")).toBe("true");
  });

  it("switches to Investigations tab on click", async () => {
    renderServiceDetail();

    // Wait for initial fetches to settle
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Investigations/i })).toBeTruthy();
    });

    const invTab = screen.getByRole("tab", { name: /Investigations/i });
    fireEvent.click(invTab);

    expect(invTab.getAttribute("aria-selected")).toBe("true");
    // Overview tab should no longer be selected
    const overviewTab = screen.getByRole("tab", { name: /Overview/i });
    expect(overviewTab.getAttribute("aria-selected")).toBe("false");
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

  it("shows investigation count in Investigations tab label", async () => {
    renderServiceDetail();
    await waitFor(() => {
      // The mock returns 5 items in the array, so tab should show "Investigations (5)"
      expect(screen.getByRole("tab", { name: /Investigations \(5\)/i })).toBeTruthy();
    });
  });
});
