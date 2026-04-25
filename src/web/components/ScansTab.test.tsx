// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { ScansTab } from "./ScansTab";
import { StackProvider } from "../contexts/StackContext";
import type { ReactNode } from "react";

function Wrapper({ children }: { children: ReactNode }) {
  return <StackProvider activeStackId="test-stack">{children}</StackProvider>;
}

interface ScanRow {
  id: string;
  trigger: "manual" | "cron";
  status: "running" | "complete" | "failed" | "skipped";
  startedAt: number;
  finishedAt: number | null;
  servicesProbed: number;
  rulesApplied: number;
  hitsRaw: number;
  hitsDispatched: number;
  probeDurationMs: number | null;
  errorMessage: string | null;
}

function makeRow(id: string, overrides: Partial<ScanRow> = {}): ScanRow {
  return {
    id,
    trigger: "cron",
    status: "complete",
    startedAt: Date.now() - 60_000,
    finishedAt: Date.now() - 50_000,
    servicesProbed: 12,
    rulesApplied: 8,
    hitsRaw: 0,
    hitsDispatched: 0,
    probeDurationMs: 1200,
    errorMessage: null,
    ...overrides,
  };
}

function mockFetch(opts: {
  runs?: ScanRow[];
  total?: number;
  hasMore?: boolean;
  capturedUrls?: string[];
}) {
  return vi.fn((url: string | URL) => {
    const u = String(url);
    if (opts.capturedUrls) opts.capturedUrls.push(u);
    if (u.includes("/api/scan/runs")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          runs: opts.runs ?? [],
          total: opts.total ?? 0,
          hasMore: opts.hasMore ?? false,
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

describe("ScansTab", () => {
  it("renders rows and shows total count in the header", async () => {
    globalThis.fetch = mockFetch({
      runs: [makeRow("r1"), makeRow("r2", { hitsDispatched: 2 })],
      total: 14,
      hasMore: true,
    });

    render(
      <ScansTab query={{}} onUpdateQuery={vi.fn()} onOpenScanRun={vi.fn()} />,
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(screen.getByText(/14 total/)).toBeDefined());
    expect(screen.getByTestId("scans-list").children.length).toBe(2);
  });

  it("renders an empty state with 'Clear all filters' when filters are active and no rows match", async () => {
    globalThis.fetch = mockFetch({ runs: [], total: 0 });
    const onUpdateQuery = vi.fn();

    render(
      <ScansTab
        query={{ status: ["failed"], range: "24h" }}
        onUpdateQuery={onUpdateQuery}
        onOpenScanRun={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(screen.getByText(/No scans match/)).toBeDefined());
    fireEvent.click(screen.getByText(/Clear all filters/));
    expect(onUpdateQuery).toHaveBeenCalledWith({});
  });

  it("renders the bare empty state when no filters are active and no rows exist", async () => {
    globalThis.fetch = mockFetch({ runs: [], total: 0 });

    render(
      <ScansTab query={{}} onUpdateQuery={vi.fn()} onOpenScanRun={vi.fn()} />,
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(screen.getByText(/No scans yet/)).toBeDefined());
    expect(screen.queryByText(/Clear all filters/)).toBeNull();
  });

  it("toggles a status filter via chip click and resets pagination", async () => {
    globalThis.fetch = mockFetch({ runs: [], total: 0 });
    const onUpdateQuery = vi.fn();

    render(
      <ScansTab query={{ offset: 25 }} onUpdateQuery={onUpdateQuery} onOpenScanRun={vi.fn()} />,
      { wrapper: Wrapper },
    );

    fireEvent.click(screen.getByRole("button", { name: /^Failed$/ }));
    expect(onUpdateQuery).toHaveBeenCalledWith({ status: ["failed"] });
    // offset stripped — any filter change resets pagination
    expect(onUpdateQuery.mock.calls[0][0]).not.toHaveProperty("offset");
  });

  it("removes a status filter when its chip is clicked while active", async () => {
    globalThis.fetch = mockFetch({ runs: [], total: 0 });
    const onUpdateQuery = vi.fn();

    render(
      <ScansTab
        query={{ status: ["failed"] }}
        onUpdateQuery={onUpdateQuery}
        onOpenScanRun={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    fireEvent.click(screen.getByRole("button", { name: /^Failed$/ }));
    expect(onUpdateQuery).toHaveBeenCalledWith({});
  });

  it("clicking a row calls onOpenScanRun with the row id", async () => {
    globalThis.fetch = mockFetch({ runs: [makeRow("run_abc")], total: 1 });
    const onOpenScanRun = vi.fn();

    render(
      <ScansTab query={{}} onUpdateQuery={vi.fn()} onOpenScanRun={onOpenScanRun} />,
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(screen.getByTestId("scans-list").children.length).toBe(1));
    fireEvent.click(screen.getByTestId("scans-list").querySelector("button")!);
    expect(onOpenScanRun).toHaveBeenCalledWith("run_abc");
  });

  it("Next/Prev paginate by limit", async () => {
    globalThis.fetch = mockFetch({
      runs: [makeRow("r1"), makeRow("r2"), makeRow("r3")],
      total: 100,
      hasMore: true,
    });
    const onUpdateQuery = vi.fn();

    render(
      <ScansTab query={{}} onUpdateQuery={onUpdateQuery} onOpenScanRun={vi.fn()} />,
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(screen.getByText(/100 total/)).toBeDefined());
    fireEvent.click(screen.getByText(/Next/));
    expect(onUpdateQuery).toHaveBeenCalledWith({ offset: 25 });
  });

  it("threads filters into the fetch URL (status, trigger, outcome, range)", async () => {
    const captured: string[] = [];
    globalThis.fetch = mockFetch({ runs: [], total: 0, capturedUrls: captured });

    render(
      <ScansTab
        query={{ status: ["failed", "complete"], trigger: ["cron"], outcome: ["dispatched"], range: "24h" }}
        onUpdateQuery={vi.fn()}
        onOpenScanRun={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(captured.length).toBeGreaterThan(0));
    const url = captured[0]!;
    expect(url).toContain("status=failed%2Ccomplete");
    expect(url).toContain("trigger=cron");
    expect(url).toContain("outcome=dispatched");
    // `range=24h` was resolved to an absolute since timestamp before serialization
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
      <ScansTab query={{}} onUpdateQuery={vi.fn()} onOpenScanRun={vi.fn()} />,
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    expect(screen.getByText(/Could not load scans/)).toBeDefined();
  });
});
