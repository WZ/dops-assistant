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
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ rows, total: 47, hasMore: true }),
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
      expect(screen.getByText("47")).toBeTruthy();
      expect(screen.getByText(/1–3 of 47/)).toBeTruthy();
    });
  });

  it("shows empty state when no investigations match", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ rows: [], total: 0, hasMore: false }),
    });

    render(
      <InvestigationsPage
        query={{ severity: ["critical"] }}
        onUpdateQuery={vi.fn()}
        onViewInvestigation={vi.fn()}
        onBack={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(screen.getByText(/No investigations match/)).toBeTruthy();
    });
  });

  it("Next pagination bumps offset by limit via onUpdateQuery", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => makeRow(`inv_${i}`));
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ rows, total: 100, hasMore: true }),
    });

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
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ rows, total: 100, hasMore: true }),
    });

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
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ rows, total: 1, hasMore: false }),
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
      const prev = screen.getByText("← Prev") as HTMLButtonElement;
      expect(prev.disabled).toBe(true);
    });
  });

  it("builds the fetch URL from the query", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ rows: [], total: 0, hasMore: false }),
    });
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
      const call = fetchMock.mock.calls[0];
      expect(call).toBeDefined();
      const url = String(call![0]);
      expect(url).toContain("/api/investigations?");
      expect(url).toContain("severity=critical%2Chigh");
      expect(url).toContain("status=running");
      expect(url).toContain("offset=50");
      // The default limit (25) is injected by the page even when absent from
      // the URL — keeps the window a known size between pages.
      expect(url).toContain("limit=25");
    });
  });

  it("shows an error banner when the fetch fails", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve("invalid value 'bogus'"),
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
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ rows: [], total: 0, hasMore: false }),
    });

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
