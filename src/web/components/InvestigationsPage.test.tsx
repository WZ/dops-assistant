// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { InvestigationsPage } from "./InvestigationsPage";
import { StackProvider } from "../contexts/StackContext";
import type { ReactNode } from "react";

function Wrapper({ children }: { children: ReactNode }) {
  return <StackProvider activeStackId="test-stack">{children}</StackProvider>;
}

function makeRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    service: "payments-api",
    query: `why is ${id} slow`,
    status: "complete" as const,
    severity: "high" as const,
    confidence_score: 0.82,
    created_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    total_duration_ms: 45_000,
    total_input_tokens: 1200,
    total_output_tokens: 800,
    report: null,
    ...overrides,
  };
}

/**
 * Build a fetch mock that routes by URL. The page fires two parallel fetches
 * after PR 3: the main /api/investigations list AND a severity-counts fetch
 * driven by the SeverityBreakdown child. Tests that care about the list
 * response shape pass rows/total/hasMore here; tests that care about the
 * histogram pass a counts object. Everything else gets sensible defaults.
 */
function mockFetch(opts: {
  rows?: unknown[];
  total?: number;
  hasMore?: boolean;
  counts?: { critical: number; high: number; medium: number; low: number };
  listError?: { status: number; body: string };
}) {
  return vi.fn((url: string | URL) => {
    const u = String(url);
    if (u.includes("/api/investigations/severity-counts")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(opts.counts ?? { critical: 0, high: 0, medium: 0, low: 0 }),
      });
    }
    if (u.includes("/api/investigations")) {
      if (opts.listError) {
        return Promise.resolve({
          ok: false,
          status: opts.listError.status,
          text: () => Promise.resolve(opts.listError!.body),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          rows: opts.rows ?? [],
          total: opts.total ?? 0,
          hasMore: opts.hasMore ?? false,
        }),
      });
    }
    throw new Error(`Unexpected fetch: ${u}`);
  });
}

describe("InvestigationsPage", () => {
  beforeEach(() => {
    cleanup();
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders rows and shows total count in the header", async () => {
    const rows = [makeRow("inv_1"), makeRow("inv_2"), makeRow("inv_3")];
    globalThis.fetch = mockFetch({ rows, total: 47, hasMore: true });

    render(
      <InvestigationsPage
        query={{}}
        onUpdateQuery={vi.fn()}
        onViewInvestigation={vi.fn()}
        onBack={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(screen.getByText("47")).toBeTruthy();
      expect(screen.getByText(/1–3 of 47/)).toBeTruthy();
    });
  });

  it("shows empty state when no investigations match AND offers clear-all when filters are active", async () => {
    globalThis.fetch = mockFetch({ rows: [], total: 0, hasMore: false });
    const onUpdateQuery = vi.fn();

    render(
      <InvestigationsPage
        query={{ severity: ["critical"] }}
        onUpdateQuery={onUpdateQuery}
        onViewInvestigation={vi.fn()}
        onBack={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(screen.getByText(/No investigations match/)).toBeTruthy();
    });

    // Clear-all link only appears when filters are active — confirms the
    // empty state distinguishes "nothing here yet" from "your filter is too tight".
    fireEvent.click(screen.getByText(/Clear all filters/));
    expect(onUpdateQuery).toHaveBeenCalledWith({});
  });

  it("empty state without active filters shows the friendly copy, no clear link", async () => {
    globalThis.fetch = mockFetch({ rows: [], total: 0, hasMore: false });

    render(
      <InvestigationsPage
        query={{}}
        onUpdateQuery={vi.fn()}
        onViewInvestigation={vi.fn()}
        onBack={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(screen.getByText(/No investigations yet/)).toBeTruthy();
    });
    expect(screen.queryByText(/Clear all filters/)).toBeNull();
  });

  it("Next pagination bumps offset by limit via onUpdateQuery", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => makeRow(`inv_${i}`));
    globalThis.fetch = mockFetch({ rows, total: 100, hasMore: true });

    const onUpdateQuery = vi.fn();
    render(
      <InvestigationsPage
        query={{ severity: ["high"] }}
        onUpdateQuery={onUpdateQuery}
        onViewInvestigation={vi.fn()}
        onBack={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(screen.getByText("Next →")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Next →"));
    expect(onUpdateQuery).toHaveBeenCalledWith({
      severity: ["high"],
      offset: 25,
    });
  });

  it("Prev strips offset when it would reach 0", async () => {
    // UI choice: when we go back to the first page, drop `offset` from the
    // query entirely instead of emitting `offset=0`. Keeps the URL clean for
    // the default view.
    const rows = Array.from({ length: 25 }, (_, i) => makeRow(`inv_${i}`));
    globalThis.fetch = mockFetch({ rows, total: 100, hasMore: true });

    const onUpdateQuery = vi.fn();
    render(
      <InvestigationsPage
        query={{ offset: 25 }}
        onUpdateQuery={onUpdateQuery}
        onViewInvestigation={vi.fn()}
        onBack={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(screen.getByText("← Prev")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("← Prev"));
    expect(onUpdateQuery).toHaveBeenCalledWith({ offset: undefined });
  });

  it("Prev is disabled on the first page", async () => {
    const rows = [makeRow("inv_1")];
    globalThis.fetch = mockFetch({ rows, total: 1, hasMore: false });

    render(
      <InvestigationsPage
        query={{}}
        onUpdateQuery={vi.fn()}
        onViewInvestigation={vi.fn()}
        onBack={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      const prev = screen.getByText("← Prev") as HTMLButtonElement;
      expect(prev.disabled).toBe(true);
    });
  });

  it("builds the list fetch URL from the query", async () => {
    const fetchMock = mockFetch({});
    globalThis.fetch = fetchMock;

    render(
      <InvestigationsPage
        query={{ severity: ["critical", "high"], status: ["running"], offset: 50 }}
        onUpdateQuery={vi.fn()}
        onViewInvestigation={vi.fn()}
        onBack={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      const listCall = fetchMock.mock.calls.find((c) =>
        String(c[0]).includes("/api/investigations?"),
      );
      expect(listCall).toBeDefined();
      const url = String(listCall![0]);
      expect(url).toContain("severity=critical%2Chigh");
      expect(url).toContain("status=running");
      expect(url).toContain("offset=50");
      // The default limit (25) is injected by the page even when absent from
      // the URL — keeps the window a known size between pages.
      expect(url).toContain("limit=25");
    });
  });

  it("shows an error banner when the list fetch fails", async () => {
    globalThis.fetch = mockFetch({
      listError: { status: 400, body: "invalid value 'bogus'" },
    });

    render(
      <InvestigationsPage
        query={{}}
        onUpdateQuery={vi.fn()}
        onViewInvestigation={vi.fn()}
        onBack={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(screen.getByText("Could not load investigations")).toBeTruthy();
      expect(screen.getByText(/invalid value 'bogus'/)).toBeTruthy();
    });
  });

  it("Back button invokes onBack", async () => {
    globalThis.fetch = mockFetch({});

    const onBack = vi.fn();
    render(
      <InvestigationsPage
        query={{}}
        onUpdateQuery={vi.fn()}
        onViewInvestigation={vi.fn()}
        onBack={onBack}
      />,
      { wrapper: Wrapper },
    );

    fireEvent.click(screen.getByLabelText("Back to dashboard"));
    expect(onBack).toHaveBeenCalled();
  });
});
