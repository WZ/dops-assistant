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


function mockFetch(opts: {
  rows?: unknown[];
  total?: number;
  hasMore?: boolean;
  services?: string[];
  listError?: { status: number; body: string };
}) {
  return vi.fn((url: string | URL) => {
    const u = String(url);
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
          services: opts.services ?? [],
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
      />,
      { wrapper: Wrapper },
    );


    await waitFor(() => {
      expect(screen.getByText(/47 total/)).toBeTruthy();
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
      />,
      { wrapper: Wrapper },
    );


    await waitFor(() => {
      expect(screen.getByText(/No investigations match/)).toBeTruthy();
    });


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
    const rows = Array.from({ length: 25 }, (_, i) => makeRow(`inv_${i}`));
    globalThis.fetch = mockFetch({ rows, total: 100, hasMore: true });


    const onUpdateQuery = vi.fn();
    render(
      <InvestigationsPage
        query={{ offset: 25 }}
        onUpdateQuery={onUpdateQuery}
        onViewInvestigation={vi.fn()}
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
      />,
      { wrapper: Wrapper },
    );


    await waitFor(() => {
      expect(screen.getByText("Could not load investigations")).toBeTruthy();
      expect(screen.getByText(/invalid value 'bogus'/)).toBeTruthy();
    });
  });


  it("clears the service dropdown options when a fetch errors (no stale leakage across stacks)", async () => {
    // First render: success with services. Second render: the same component
    // sees an error response — the dropdown must drop the previously cached
    // service names so a stack switch + 400 doesn't leak the prior stack's
    // service list into the new context.
    let triggerError = false;
    globalThis.fetch = vi.fn(() => {
      if (triggerError) {
        return Promise.resolve({
          ok: false,
          status: 400,
          text: () => Promise.resolve("bad filter"),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          rows: [],
          total: 0,
          hasMore: false,
          services: ["payments-api", "checkout-api"],
        }),
      });
    });

    const { rerender } = render(
      <InvestigationsPage
        query={{}}
        onUpdateQuery={vi.fn()}
        onViewInvestigation={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    const select = await waitFor(
      () => screen.getByTestId("investigations-service-select") as HTMLSelectElement,
    );
    await waitFor(() => {
      expect(select.options.length).toBe(3); // "" + 2 services
    });

    triggerError = true;
    rerender(
      <InvestigationsPage
        query={{ severity: ["critical"] }}
        onUpdateQuery={vi.fn()}
        onViewInvestigation={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Could not load investigations")).toBeTruthy();
    });
    // Service dropdown reset to just the "All services" placeholder.
    expect(select.options.length).toBe(1);
  });


  it("title matches the sibling-page style (no back link, sidebar is the nav)", async () => {
    globalThis.fetch = mockFetch({ rows: [], total: 0, hasMore: false });


    render(
      <InvestigationsPage
        query={{}}
        onUpdateQuery={vi.fn()}
        onViewInvestigation={vi.fn()}
      />,
      { wrapper: Wrapper },
    );


    expect(screen.queryByLabelText("Back to dashboard")).toBeNull();
    expect(screen.queryByText(/← Dashboard/)).toBeNull();
    expect(screen.getByRole("heading", { name: "Investigations" })).toBeTruthy();
  });


  // ── Filter UI ──────────────────────────────────────────────────────────

  it("clicking a chip while a search draft is pending preserves the search text", async () => {
    // Regression: the prior implementation closed over `query` in chip
    // handlers, so typing into search → clicking a chip silently dropped the
    // pending text. Every handler now folds qDraft into the update.
    globalThis.fetch = mockFetch({ rows: [], total: 0 });
    const onUpdateQuery = vi.fn();
    render(
      <InvestigationsPage
        query={{}}
        onUpdateQuery={onUpdateQuery}
        onViewInvestigation={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    const input = await waitFor(
      () => screen.getByTestId("investigations-search-input") as HTMLInputElement,
    );
    fireEvent.change(input, { target: { value: "redis" } });
    fireEvent.click(screen.getByText("Critical"));

    expect(onUpdateQuery).toHaveBeenLastCalledWith({
      q: "redis",
      severity: ["critical"],
    });
  });


  it("clicking Next while a search draft is pending preserves the search text", async () => {
    // Regression: the chip-handler stale-closure fix didn't extend to the
    // pagination buttons. Same bug class — typing in search and clicking
    // Next without pressing Enter silently dropped the text.
    const rows = Array.from({ length: 25 }, (_, i) => makeRow(`inv_${i}`));
    globalThis.fetch = mockFetch({ rows, total: 100, hasMore: true });
    const onUpdateQuery = vi.fn();
    render(
      <InvestigationsPage
        query={{}}
        onUpdateQuery={onUpdateQuery}
        onViewInvestigation={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    const input = await waitFor(
      () => screen.getByTestId("investigations-search-input") as HTMLInputElement,
    );
    fireEvent.change(input, { target: { value: "redis" } });
    fireEvent.click(screen.getByText("Next →"));

    expect(onUpdateQuery).toHaveBeenLastCalledWith({
      q: "redis",
      offset: 25,
    });
  });


  it("clicking Prev while a search draft is pending preserves the search text", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => makeRow(`inv_${i}`));
    globalThis.fetch = mockFetch({ rows, total: 100, hasMore: true });
    const onUpdateQuery = vi.fn();
    render(
      <InvestigationsPage
        query={{ offset: 50 }}
        onUpdateQuery={onUpdateQuery}
        onViewInvestigation={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    const input = await waitFor(
      () => screen.getByTestId("investigations-search-input") as HTMLInputElement,
    );
    fireEvent.change(input, { target: { value: "redis" } });
    fireEvent.click(screen.getByText("← Prev"));

    expect(onUpdateQuery).toHaveBeenLastCalledWith({
      q: "redis",
      offset: 25,
    });
  });


  it("Clear all filters resets the search input draft, not just the URL", async () => {
    // Regression: clicking "Clear all filters" emptied query state but left
    // the search input still displaying whatever the user had typed —
    // visually inconsistent with the cleared URL.
    globalThis.fetch = mockFetch({ rows: [], total: 0 });
    const onUpdateQuery = vi.fn();
    render(
      <InvestigationsPage
        query={{ severity: ["critical"] }}
        onUpdateQuery={onUpdateQuery}
        onViewInvestigation={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    const input = await waitFor(
      () => screen.getByTestId("investigations-search-input") as HTMLInputElement,
    );
    fireEvent.change(input, { target: { value: "redis" } });
    expect(input.value).toBe("redis");

    fireEvent.click(screen.getByText("Clear all filters"));

    expect(onUpdateQuery).toHaveBeenLastCalledWith({});
    expect(input.value).toBe("");
  });


  it("severity chip toggles on click and resets offset", async () => {
    globalThis.fetch = mockFetch({ rows: [], total: 0 });
    const onUpdateQuery = vi.fn();
    render(
      <InvestigationsPage
        query={{ offset: 50 }}
        onUpdateQuery={onUpdateQuery}
        onViewInvestigation={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    await waitFor(() => screen.getByText("Critical"));
    fireEvent.click(screen.getByText("Critical"));
    expect(onUpdateQuery).toHaveBeenCalledWith({ severity: ["critical"] });
  });


  it("clicking an already-active status removes it", async () => {
    globalThis.fetch = mockFetch({ rows: [], total: 0 });
    const onUpdateQuery = vi.fn();
    render(
      <InvestigationsPage
        query={{ status: ["running", "complete"] }}
        onUpdateQuery={onUpdateQuery}
        onViewInvestigation={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    await waitFor(() => screen.getByText("Running"));
    fireEvent.click(screen.getByText("Running"));
    expect(onUpdateQuery).toHaveBeenCalledWith({ status: ["complete"] });
  });


  it("range chip sets range, drops since/until, and resets pagination", async () => {
    globalThis.fetch = mockFetch({ rows: [], total: 0 });
    const onUpdateQuery = vi.fn();
    render(
      <InvestigationsPage
        query={{ offset: 50, since: "2020-01-01T00:00:00Z" }}
        onUpdateQuery={onUpdateQuery}
        onViewInvestigation={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    await waitFor(() => screen.getByText("7d"));
    fireEvent.click(screen.getByText("7d"));
    expect(onUpdateQuery).toHaveBeenCalledWith({ range: "7d" });
  });


  it("'All' chip clears range, since, and until", async () => {
    globalThis.fetch = mockFetch({ rows: [], total: 0 });
    const onUpdateQuery = vi.fn();
    render(
      <InvestigationsPage
        query={{ range: "7d", since: "2026-04-01T00:00:00Z" }}
        onUpdateQuery={onUpdateQuery}
        onViewInvestigation={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    await waitFor(() => screen.getByText("All"));
    fireEvent.click(screen.getByText("All"));
    expect(onUpdateQuery).toHaveBeenCalledWith({});
  });


  it("'All' chip is NOT active when a custom since/until window is set without a range", async () => {
    // Defends the long-standing UI guarantee: "All says pressed while since
    // was still filtering the list" was the gaslighting bug we explicitly
    // fixed in the previous segmented-control implementation. Carry the
    // behavior forward in the chip refactor.
    globalThis.fetch = mockFetch({ rows: [], total: 0 });
    render(
      <InvestigationsPage
        query={{ since: "2026-04-01T00:00:00Z" }}
        onUpdateQuery={vi.fn()}
        onViewInvestigation={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    await waitFor(() => screen.getByText("All"));
    const allChip = screen.getByText("All");
    expect(allChip.getAttribute("aria-pressed")).toBe("false");
  });


  it("service dropdown is populated from response.services and emits onUpdateQuery", async () => {
    globalThis.fetch = mockFetch({
      rows: [],
      total: 0,
      services: ["payments-api", "checkout-api"],
    });
    const onUpdateQuery = vi.fn();
    render(
      <InvestigationsPage
        query={{}}
        onUpdateQuery={onUpdateQuery}
        onViewInvestigation={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    const select = await waitFor(
      () => screen.getByTestId("investigations-service-select") as HTMLSelectElement,
    );
    await waitFor(() => {
      expect(Array.from(select.options).map((o) => o.value)).toEqual([
        "",
        "payments-api",
        "checkout-api",
      ]);
    });
    fireEvent.change(select, { target: { value: "payments-api" } });
    expect(onUpdateQuery).toHaveBeenCalledWith({ service: "payments-api" });
  });


  it("search input commits on Enter and resets offset", async () => {
    globalThis.fetch = mockFetch({ rows: [], total: 0 });
    const onUpdateQuery = vi.fn();
    render(
      <InvestigationsPage
        query={{ offset: 25 }}
        onUpdateQuery={onUpdateQuery}
        onViewInvestigation={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    const input = await waitFor(
      () => screen.getByTestId("investigations-search-input") as HTMLInputElement,
    );
    fireEvent.change(input, { target: { value: "redis" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onUpdateQuery).toHaveBeenCalledWith({ q: "redis" });
  });


  it("sort dropdown emits the selected value; default 'created_at' drops the key", async () => {
    globalThis.fetch = mockFetch({ rows: [], total: 0 });
    const onUpdateQuery = vi.fn();
    render(
      <InvestigationsPage
        query={{}}
        onUpdateQuery={onUpdateQuery}
        onViewInvestigation={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    const select = await waitFor(
      () => screen.getByLabelText(/Sort by/i) as HTMLSelectElement,
    );
    fireEvent.change(select, { target: { value: "confidence" } });
    expect(onUpdateQuery).toHaveBeenLastCalledWith({ sort: "confidence" });

    fireEvent.change(select, { target: { value: "created_at" } });
    expect(onUpdateQuery).toHaveBeenLastCalledWith({});
  });


  it("sort change resets offset so the user doesn't land mid-list", async () => {
    globalThis.fetch = mockFetch({ rows: [], total: 0 });
    const onUpdateQuery = vi.fn();
    render(
      <InvestigationsPage
        query={{ offset: 50 }}
        onUpdateQuery={onUpdateQuery}
        onViewInvestigation={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    const select = await waitFor(
      () => screen.getByLabelText(/Sort by/i) as HTMLSelectElement,
    );
    fireEvent.change(select, { target: { value: "confidence" } });
    const call = onUpdateQuery.mock.calls.find(
      (c) => (c[0] as { sort?: string }).sort === "confidence",
    );
    expect(call).toBeDefined();
    expect((call![0] as { offset?: number }).offset).toBeUndefined();
  });

  it("'Mark all as read' clears the unread badge on completed/failed rows", async () => {
    // Stub localStorage with a real in-memory map so `safeSetItem` can actually
    // persist the viewed-set; the default jsdom env only stubs getItem.
    const store: Record<string, string> = {};
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => { store[k] = v; },
        removeItem: (k: string) => { delete store[k]; },
        clear: () => { for (const k of Object.keys(store)) delete store[k]; },
        key: (i: number) => Object.keys(store)[i] ?? null,
        get length() { return Object.keys(store).length; },
      },
    });

    const rows = [
      makeRow("inv_a", { status: "complete" }),
      makeRow("inv_b", { status: "failed" }),
      makeRow("inv_c", { status: "running" }),
    ];
    globalThis.fetch = mockFetch({ rows, total: rows.length });
    render(
      <InvestigationsPage
        query={{}}
        onUpdateQuery={vi.fn()}
        onViewInvestigation={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    // Two terminal rows are unread → button is visible with count "2 new".
    const button = await waitFor(() => screen.getByTestId("mark-all-read"));
    expect(screen.getByText(/2 new/i)).not.toBeNull();

    fireEvent.click(button);

    // Button disappears (no unread left) and the running row stays untouched.
    await waitFor(() => expect(screen.queryByTestId("mark-all-read")).toBeNull());
    const stored = JSON.parse(store["dops:viewed-investigations"] ?? "[]") as string[];
    expect(stored).toEqual(expect.arrayContaining(["inv_a", "inv_b"]));
    expect(stored).not.toContain("inv_c");
  });

  it("hides 'Mark all as read' when there are no unread terminal rows", async () => {
    // All rows are still running — none are eligible to be marked read.
    const rows = [makeRow("inv_x", { status: "running" })];
    globalThis.fetch = mockFetch({ rows, total: 1 });
    render(
      <InvestigationsPage
        query={{}}
        onUpdateQuery={vi.fn()}
        onViewInvestigation={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    await waitFor(() => screen.getByText(/1 total/i));
    expect(screen.queryByTestId("mark-all-read")).toBeNull();
  });
});
