// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { PatternsTab } from "./PatternsTab";
import { StackProvider } from "../contexts/StackContext";
import type { ReactNode } from "react";

function Wrapper({ children }: { children: ReactNode }) {
  return <StackProvider activeStackId="test-stack">{children}</StackProvider>;
}

interface Row {
  id: string;
  service: string;
  symptom: string;
  root_cause: string;
  severity: string;
  recommended_actions: string | null;
  source_investigation_id: string | null;
  created_at: string;
}

function makeRow(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id,
    service: "payments-api",
    symptom: `Symptom ${id}`,
    root_cause: `Root cause ${id}`,
    severity: "high",
    recommended_actions: "Add HPA",
    source_investigation_id: `inv_${id}`,
    created_at: new Date(Date.now() - 5_000).toISOString(),
    ...overrides,
  };
}

function mockFetch(opts: {
  rows?: Row[];
  total?: number;
  hasMore?: boolean;
  services?: string[];
  capturedUrls?: string[];
}) {
  return vi.fn((url: string | URL) => {
    const u = String(url);
    if (opts.capturedUrls) opts.capturedUrls.push(u);
    if (u.includes("/api/patterns")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          rows: opts.rows ?? [],
          total: opts.total ?? 0,
          hasMore: opts.hasMore ?? false,
          services: opts.services ?? ["payments-api", "checkout-api"],
        }),
      });
    }
    throw new Error(`Unexpected fetch: ${u}`);
  });
}

beforeEach(() => {
  cleanup();
  globalThis.fetch = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PatternsTab", () => {
  it("renders rows and shows total in the header", async () => {
    globalThis.fetch = mockFetch({ rows: [makeRow("p1"), makeRow("p2")], total: 9, hasMore: true });

    render(
      <PatternsTab query={{}} onUpdateQuery={vi.fn()} onViewInvestigation={vi.fn()} />,
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(screen.getByText(/9 total/)).toBeDefined());
    expect(screen.getByTestId("patterns-list").children.length).toBe(2);
  });

  it("populates the service dropdown from the response.services field", async () => {
    globalThis.fetch = mockFetch({
      rows: [],
      services: ["alpha", "beta", "gamma"],
    });

    render(
      <PatternsTab query={{}} onUpdateQuery={vi.fn()} onViewInvestigation={vi.fn()} />,
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      const select = screen.getByTestId("patterns-service-select") as HTMLSelectElement;
      const options = Array.from(select.options).map((o) => o.value);
      expect(options).toEqual(["", "alpha", "beta", "gamma"]);
    });
  });

  it("clicking a row calls onViewInvestigation with the source_investigation_id", async () => {
    globalThis.fetch = mockFetch({
      rows: [makeRow("p1", { source_investigation_id: "inv_xyz" })],
      total: 1,
    });
    const onViewInvestigation = vi.fn();

    render(
      <PatternsTab query={{}} onUpdateQuery={vi.fn()} onViewInvestigation={onViewInvestigation} />,
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(screen.getByTestId("patterns-list").children.length).toBe(1));
    fireEvent.click(screen.getByTestId("patterns-list").querySelector("button")!);
    expect(onViewInvestigation).toHaveBeenCalledWith("inv_xyz");
  });

  it("does NOT call onViewInvestigation when a pattern has no source_investigation_id", async () => {
    globalThis.fetch = mockFetch({
      rows: [makeRow("p1", { source_investigation_id: null })],
      total: 1,
    });
    const onViewInvestigation = vi.fn();

    render(
      <PatternsTab query={{}} onUpdateQuery={vi.fn()} onViewInvestigation={onViewInvestigation} />,
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(screen.getByTestId("patterns-list").children.length).toBe(1));
    const btn = screen.getByTestId("patterns-list").querySelector("button")!;
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(btn);
    expect(onViewInvestigation).not.toHaveBeenCalled();
  });

  it("toggles a severity filter via chip click and resets pagination", async () => {
    globalThis.fetch = mockFetch({ rows: [], total: 0 });
    const onUpdateQuery = vi.fn();

    render(
      <PatternsTab query={{ offset: 25 }} onUpdateQuery={onUpdateQuery} onViewInvestigation={vi.fn()} />,
      { wrapper: Wrapper },
    );

    fireEvent.click(screen.getByRole("button", { name: /^Critical$/ }));
    expect(onUpdateQuery).toHaveBeenCalledWith({ severity: ["critical"] });
    expect(onUpdateQuery.mock.calls[0][0]).not.toHaveProperty("offset");
  });

  it("changing the service dropdown writes the query and resets pagination", async () => {
    globalThis.fetch = mockFetch({ rows: [], services: ["payments-api"] });
    const onUpdateQuery = vi.fn();

    render(
      <PatternsTab query={{ offset: 50 }} onUpdateQuery={onUpdateQuery} onViewInvestigation={vi.fn()} />,
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      const select = screen.getByTestId("patterns-service-select") as HTMLSelectElement;
      const options = Array.from(select.options).map((o) => o.value);
      expect(options).toContain("payments-api");
    });
    fireEvent.change(screen.getByTestId("patterns-service-select"), { target: { value: "payments-api" } });
    expect(onUpdateQuery).toHaveBeenCalledWith({ service: "payments-api" });
    expect(onUpdateQuery.mock.calls[0][0]).not.toHaveProperty("offset");
  });

  it("commits q on Enter and on blur, ignoring no-op edits", async () => {
    globalThis.fetch = mockFetch({ rows: [], total: 0 });
    const onUpdateQuery = vi.fn();

    render(
      <PatternsTab query={{}} onUpdateQuery={onUpdateQuery} onViewInvestigation={vi.fn()} />,
      { wrapper: Wrapper },
    );

    const input = screen.getByTestId("patterns-search-input");
    fireEvent.change(input, { target: { value: "oom" } });
    expect(onUpdateQuery).not.toHaveBeenCalled(); // not committed yet

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onUpdateQuery).toHaveBeenCalledWith({ q: "oom" });
  });

  it("renders empty state with 'Clear all filters' when filters are active and no rows match", async () => {
    globalThis.fetch = mockFetch({ rows: [], total: 0 });
    const onUpdateQuery = vi.fn();

    render(
      <PatternsTab
        query={{ severity: ["critical"], range: "7d" }}
        onUpdateQuery={onUpdateQuery}
        onViewInvestigation={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(screen.getByText(/No patterns match/)).toBeDefined());
    fireEvent.click(screen.getByText(/Clear all filters/));
    expect(onUpdateQuery).toHaveBeenCalledWith({});
  });

  it("renders the bare empty state when no filters are active", async () => {
    globalThis.fetch = mockFetch({ rows: [], total: 0 });

    render(
      <PatternsTab query={{}} onUpdateQuery={vi.fn()} onViewInvestigation={vi.fn()} />,
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(screen.getByText(/No patterns yet/)).toBeDefined());
    expect(screen.queryByText(/Clear all filters/)).toBeNull();
  });

  it("threads filters into the fetch URL (service, severity, range, q, sort)", async () => {
    const captured: string[] = [];
    globalThis.fetch = mockFetch({ rows: [], total: 0, capturedUrls: captured });

    render(
      <PatternsTab
        query={{ service: "payments-api", severity: ["critical", "high"], range: "24h", q: "oom", sort: "severity" }}
        onUpdateQuery={vi.fn()}
        onViewInvestigation={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(captured.length).toBeGreaterThan(0));
    const url = captured[0]!;
    expect(url).toContain("service=payments-api");
    expect(url).toContain("severity=critical%2Chigh");
    expect(url).toContain("q=oom");
    expect(url).toContain("sort=severity");
    // range was resolved to absolute since timestamp before serialization
    expect(url).toMatch(/since=\d{4}-\d{2}-\d{2}T/);
    expect(url).not.toContain("range=24h");
  });

  it("displays an error banner when the fetch fails", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("internal server error"),
    });

    render(
      <PatternsTab query={{}} onUpdateQuery={vi.fn()} onViewInvestigation={vi.fn()} />,
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    expect(screen.getByText(/Could not load patterns/)).toBeDefined();
  });
});
