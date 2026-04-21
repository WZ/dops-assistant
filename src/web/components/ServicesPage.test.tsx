// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { ServicesPage } from "./ServicesPage";
import { StackProvider } from "../contexts/StackContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ReactNode } from "react";

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <StackProvider activeStackId="test-stack">
      <TooltipProvider>{children}</TooltipProvider>
    </StackProvider>
  );
}

// Prevent the FirstRunBanner from leaking into counter-copy assertions.
vi.mock("./FirstRunBanner", () => ({
  FirstRunBanner: () => null,
}));

interface MockOpts {
  services?: Array<{ name: string; health?: string }>;
  hidden?: Array<{ service: string; reason: string | null; hidden_at: string }>;
}

function mockFetch(opts: MockOpts = {}) {
  const rawServices = opts.services ?? [];
  const hidden = opts.hidden ?? [];

  // Build ServiceListItem shapes from minimal stubs
  const services = rawServices.map((s) => ({
    name: s.name,
    health: (s.health ?? "unknown") as "healthy" | "degraded" | "down" | "unknown",
    metadata: { tags: [] },
    lastInvestigation: null,
  }));

  (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string | Request) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("/api/services/health/history")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }
    if (urlStr.includes("/api/services/hidden")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(hidden) });
    }
    if (urlStr.includes("/api/services/stale-unknown")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }
    if (urlStr.includes("/api/services")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ services }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  });
}

function renderPage(props: Partial<React.ComponentProps<typeof ServicesPage>> = {}) {
  const defaultProps: React.ComponentProps<typeof ServicesPage> = {
    ws: { send: vi.fn(), messages: [] as any[], status: "connected" } as any,
    onViewInvestigation: vi.fn(),
    discoveryState: {
      phase: "",
      status: "complete",
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
    stackName: "Default",
  };
  return render(<ServicesPage {...defaultProps} {...props} />, { wrapper: Wrapper });
}

describe("ServicesPage header counter", () => {
  beforeEach(() => {
    cleanup();
    globalThis.fetch = vi.fn();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows a single-unit counter when nothing is hidden", async () => {
    mockFetch({
      services: [{ name: "a" }, { name: "b" }, { name: "c" }],
      hidden: [],
    });
    renderPage();

    const counter = await screen.findByTestId("services-counter");
    expect(counter.textContent).toBe("3 services");
  });

  it("shows 'N of M services shown' when some are hidden", async () => {
    mockFetch({
      services: [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }],
      hidden: [
        { service: "c", reason: null, hidden_at: "2026-04-17T00:00:00Z" },
        { service: "d", reason: null, hidden_at: "2026-04-17T00:00:00Z" },
      ],
    });
    renderPage();

    const counter = await screen.findByTestId("services-counter");
    await waitFor(() => {
      expect(counter.textContent).toBe("2 of 4 services shown");
    });
  });

  it("singularizes 'service' when the visible count is 1", async () => {
    mockFetch({
      services: [{ name: "only-one" }],
      hidden: [],
    });
    renderPage();

    const counter = await screen.findByTestId("services-counter");
    expect(counter.textContent).toBe("1 service");
  });
});

describe("ServicesPage skeleton density", () => {
  beforeEach(() => {
    cleanup();
    globalThis.fetch = vi.fn();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders exactly 6 shimmer tiles while loading", () => {
    // Never-resolving fetch keeps us in the loading state.
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}));
    const { container } = renderPage();
    const shimmers = container.querySelectorAll(".shimmer-skeleton");
    expect(shimmers.length).toBe(6);
  });
});
