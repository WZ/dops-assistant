// src/web/components/ServicesPage.spa-click.test.tsx
// @vitest-environment jsdom
//
// Regression tests for Issue #13.
//
// The earlier `initialService` → detail-view wiring only moved to the detail
// sub-view via an effect that gated on `services.length > 0`. Between mount
// and the services fetch resolving, the component rendered the grid ("Services"
// H1). In practice the brief flash hardened into a "stuck on index" bug when
// the user clicked a service tile from the Home dashboard — React key-changes
// and re-mounts made the grid the user's first paint, and if anything else on
// the page triggered an unmount (e.g. a setupStage-driven reroute that clears
// initialService), the detail never rendered at all.
//
// The fix seeds `subView` from `initialService` eagerly via lazy useState init
// and guards the effect so it can't reset a detail view back to grid while
// services are still loading. These tests pin that behavior.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { ServicesPage } from "./ServicesPage";
import { StackProvider } from "../contexts/StackContext";
import type { ReactNode } from "react";

function Wrapper({ children }: { children: ReactNode }) {
  return <StackProvider activeStackId="test-stack">{children}</StackProvider>;
}

// ServiceDetail pulls in heavy charting + dependency graph wiring we don't
// care about here — mock it to a tiny component that echoes the service name.
vi.mock("./ServiceDetail", () => ({
  ServiceDetail: ({ serviceName }: { serviceName: string }) => (
    <h1 data-testid="detail-h1">{serviceName}</h1>
  ),
}));

vi.mock("./DiscoveryProgress", () => ({
  DiscoveryProgress: () => <div data-testid="discovery" />,
}));
vi.mock("./DiscoveryReview", () => ({
  DiscoveryReview: () => <div data-testid="discovery-review" />,
}));
vi.mock("./ServicesManage", () => ({
  ServicesManage: () => <div data-testid="services-manage" />,
}));
vi.mock("./VersionHistory", () => ({
  VersionHistory: () => <div data-testid="version-history" />,
}));

/** Baseline mock responses for all the API endpoints ServicesPage calls. */
function mockFetchResponses(services: Array<{ name: string }>) {
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string | Request) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("/api/services/health")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
    if (urlStr.includes("/api/services/hidden")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }
    if (urlStr.includes("/api/services/stale-unknown")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }
    if (urlStr.includes("/api/services")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(services) });
    }
    if (urlStr.includes("/api/investigations")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  });
}

function renderServicesPage(overrides?: Partial<React.ComponentProps<typeof ServicesPage>>) {
  const defaultProps: React.ComponentProps<typeof ServicesPage> = {
    ws: { send: vi.fn(), messages: [] as any[] } as any,
    onViewInvestigation: vi.fn(),
    initialService: undefined,
    onSelectService: vi.fn(),
    discoveryState: {
      phase: "",
      status: "complete" as const,
      iteration: { current: 0, max: 0, description: "" },
      toolCalls: [],
      results: [],
      error: null,
      retry: null,
      phaseTokens: {},
      totalUsage: null,
    },
    onStartDiscovery: vi.fn(),
    onResetDiscovery: vi.fn(),
  };
  return render(<ServicesPage {...defaultProps} {...overrides} />, { wrapper: Wrapper });
}

describe("ServicesPage — initialService honored on mount (Issue #13)", () => {
  beforeEach(() => {
    cleanup();
    globalThis.fetch = vi.fn();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the detail heading on the very first paint when initialService is set", () => {
    // Mock the fetch but don't resolve it — this is the critical moment: the
    // component has just mounted from an SPA click, services are loading, the
    // user must see the detail view, not the 'Services' grid.
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise(() => {}), // never resolves
    );
    renderServicesPage({ initialService: "admin-daphne" });
    // Under the bug: grid renders first and its <h1>Services</h1> wins.
    // Under the fix: the ServiceDetail mock's <h1>admin-daphne</h1> is shown.
    expect(screen.queryByText("Services", { selector: "h1" })).toBeNull();
    expect(screen.getByTestId("detail-h1").textContent).toBe("admin-daphne");
  });

  it("renders the detail view after services load when initialService is set", async () => {
    mockFetchResponses([{ name: "admin-daphne" }, { name: "other" }]);
    renderServicesPage({ initialService: "admin-daphne" });
    await waitFor(() => {
      expect(screen.getByTestId("detail-h1").textContent).toBe("admin-daphne");
    });
  });

  it("renders the grid view when no initialService is provided", async () => {
    mockFetchResponses([{ name: "admin-daphne" }]);
    renderServicesPage({ initialService: undefined });
    // The grid view renders the "Services" H1 as its page title.
    await waitFor(() => {
      expect(screen.queryByText("Services", { selector: "h1" })).not.toBeNull();
    });
  });
});
