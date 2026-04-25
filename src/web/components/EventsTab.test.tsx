// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { EventsTab } from "./EventsTab";
import { StackProvider } from "../contexts/StackContext";
import type { ReactNode } from "react";

function Wrapper({ children }: { children: ReactNode }) {
  return <StackProvider activeStackId="test-stack">{children}</StackProvider>;
}

interface Row {
  id: string;
  ts: number;
  kind: string;
  severity: string;
  summary: string;
  stackId: string | null;
  service: string | null;
  href: string | null;
  meta: Record<string, string | number | boolean> | null;
}

function makeRow(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id,
    ts: Date.now() - 5_000,
    kind: "investigation_started",
    severity: "info",
    summary: `Event ${id}`,
    stackId: "test-stack",
    service: "payments-api",
    href: `/investigations/inv_${id}`,
    meta: null,
    ...overrides,
  };
}

function mockFetch(opts: {
  rows?: Row[];
  total?: number;
  hasMore?: boolean;
  kinds?: string[];
  services?: string[];
  capturedUrls?: string[];
}) {
  return vi.fn((url: string | URL) => {
    const u = String(url);
    if (opts.capturedUrls) opts.capturedUrls.push(u);
    if (u.includes("/api/events")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          rows: opts.rows ?? [],
          total: opts.total ?? 0,
          hasMore: opts.hasMore ?? false,
          kinds: opts.kinds ?? ["investigation_started", "scan_run_complete"],
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

describe("EventsTab", () => {
  it("renders rows and shows total count in the header", async () => {
    globalThis.fetch = mockFetch({ rows: [makeRow("e1"), makeRow("e2")], total: 17, hasMore: true });

    render(
      <EventsTab query={{}} onUpdateQuery={vi.fn()} onNavigate={vi.fn()} />,
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(screen.getByText(/17 total/)).toBeDefined());
    expect(screen.getByTestId("events-list").children.length).toBe(2);
  });

  it("populates the kind dropdown from response.kinds with pretty-printed labels", async () => {
    globalThis.fetch = mockFetch({
      rows: [],
      kinds: ["alert_received", "investigation_started", "service_health_changed"],
    });

    render(
      <EventsTab query={{}} onUpdateQuery={vi.fn()} onNavigate={vi.fn()} />,
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      const select = screen.getByTestId("events-kind-select") as HTMLSelectElement;
      const options = Array.from(select.options).map((o) => ({ value: o.value, label: o.textContent }));
      expect(options).toEqual([
        { value: "", label: "All kinds" },
        { value: "alert_received", label: "Alert received" },
        { value: "investigation_started", label: "Investigation started" },
        { value: "service_health_changed", label: "Service health changed" },
      ]);
    });
  });

  it("populates the service dropdown from response.services", async () => {
    globalThis.fetch = mockFetch({ rows: [], services: ["alpha", "beta"] });

    render(
      <EventsTab query={{}} onUpdateQuery={vi.fn()} onNavigate={vi.fn()} />,
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      const select = screen.getByTestId("events-service-select") as HTMLSelectElement;
      const options = Array.from(select.options).map((o) => o.value);
      expect(options).toEqual(["", "alpha", "beta"]);
    });
  });

  it("clicking a row with href calls onNavigate", async () => {
    globalThis.fetch = mockFetch({
      rows: [makeRow("e1", { href: "/investigations/inv_xyz" })],
      total: 1,
    });
    const onNavigate = vi.fn();

    render(
      <EventsTab query={{}} onUpdateQuery={vi.fn()} onNavigate={onNavigate} />,
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(screen.getByTestId("events-list").children.length).toBe(1));
    fireEvent.click(screen.getByTestId("events-list").querySelector("button")!);
    expect(onNavigate).toHaveBeenCalledWith("/investigations/inv_xyz");
  });

  it("rows without href render disabled and don't fire onNavigate", async () => {
    globalThis.fetch = mockFetch({
      rows: [makeRow("e1", { href: null })],
      total: 1,
    });
    const onNavigate = vi.fn();

    render(
      <EventsTab query={{}} onUpdateQuery={vi.fn()} onNavigate={onNavigate} />,
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(screen.getByTestId("events-list").children.length).toBe(1));
    const btn = screen.getByTestId("events-list").querySelector("button")! as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("toggles a severity chip and resets pagination", async () => {
    globalThis.fetch = mockFetch({ rows: [], total: 0 });
    const onUpdateQuery = vi.fn();

    render(
      <EventsTab query={{ offset: 25 }} onUpdateQuery={onUpdateQuery} onNavigate={vi.fn()} />,
      { wrapper: Wrapper },
    );

    fireEvent.click(screen.getByRole("button", { name: /^Error$/ }));
    expect(onUpdateQuery).toHaveBeenCalledWith({ severity: ["error"] });
    expect(onUpdateQuery.mock.calls[0][0]).not.toHaveProperty("offset");
  });

  it("changing the kind dropdown writes a single-element kind array", async () => {
    globalThis.fetch = mockFetch({ rows: [], kinds: ["investigation_started"] });
    const onUpdateQuery = vi.fn();

    render(
      <EventsTab query={{}} onUpdateQuery={onUpdateQuery} onNavigate={vi.fn()} />,
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      const select = screen.getByTestId("events-kind-select") as HTMLSelectElement;
      const options = Array.from(select.options).map((o) => o.value);
      expect(options).toContain("investigation_started");
    });
    fireEvent.change(screen.getByTestId("events-kind-select"), { target: { value: "investigation_started" } });
    expect(onUpdateQuery).toHaveBeenCalledWith({ kind: ["investigation_started"] });
  });

  it("commits q on Enter", async () => {
    globalThis.fetch = mockFetch({ rows: [], total: 0 });
    const onUpdateQuery = vi.fn();

    render(
      <EventsTab query={{}} onUpdateQuery={onUpdateQuery} onNavigate={vi.fn()} />,
      { wrapper: Wrapper },
    );

    const input = screen.getByTestId("events-search-input");
    fireEvent.change(input, { target: { value: "timeout" } });
    expect(onUpdateQuery).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onUpdateQuery).toHaveBeenCalledWith({ q: "timeout" });
  });

  it("renders empty state with 'Clear all filters' when filters are active", async () => {
    globalThis.fetch = mockFetch({ rows: [], total: 0 });
    const onUpdateQuery = vi.fn();

    render(
      <EventsTab
        query={{ severity: ["error"], range: "1h" }}
        onUpdateQuery={onUpdateQuery}
        onNavigate={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(screen.getByText(/No events match/)).toBeDefined());
    fireEvent.click(screen.getByText(/Clear all filters/));
    expect(onUpdateQuery).toHaveBeenCalledWith({});
  });

  it("renders the bare empty state when no filters are active", async () => {
    globalThis.fetch = mockFetch({ rows: [], total: 0 });

    render(
      <EventsTab query={{}} onUpdateQuery={vi.fn()} onNavigate={vi.fn()} />,
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(screen.getByText(/No events yet/)).toBeDefined());
    expect(screen.queryByText(/Clear all filters/)).toBeNull();
  });

  it("threads filters into the fetch URL", async () => {
    const captured: string[] = [];
    globalThis.fetch = mockFetch({ rows: [], total: 0, capturedUrls: captured });

    render(
      <EventsTab
        query={{ severity: ["error"], kind: ["investigation_started"], service: "payments-api", range: "1h", q: "oom" }}
        onUpdateQuery={vi.fn()}
        onNavigate={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(captured.length).toBeGreaterThan(0));
    const url = captured[0]!;
    expect(url).toContain("severity=error");
    expect(url).toContain("kind=investigation_started");
    expect(url).toContain("service=payments-api");
    expect(url).toContain("q=oom");
    // range was resolved to absolute since
    expect(url).toMatch(/since=\d{4}-\d{2}-\d{2}T/);
    expect(url).not.toContain("range=1h");
  });

  it("displays an error banner when the fetch fails", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("internal server error"),
    });

    render(
      <EventsTab query={{}} onUpdateQuery={vi.fn()} onNavigate={vi.fn()} />,
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    expect(screen.getByText(/Could not load events/)).toBeDefined();
  });
});
