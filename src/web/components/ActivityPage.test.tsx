// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ActivityPage } from "./ActivityPage";
import type { ActivityView } from "../App";

// Stub heavy children so the tab-shell test stays focused on shell behavior
// (tab strip, ARIA, placeholder copy). Their own behavior is covered by
// their own tests.
vi.mock("./InvestigationsPage", () => ({
  InvestigationsPage: ({ query }: { query: Record<string, unknown> }) => (
    <div data-testid="investigations-page-stub" data-query-keys={Object.keys(query).join(",")} />
  ),
}));
vi.mock("./ScansTab", () => ({
  ScansTab: ({ query }: { query: Record<string, unknown> }) => (
    <div data-testid="scans-tab-stub" data-query-keys={Object.keys(query).join(",")} />
  ),
}));
vi.mock("./PatternsTab", () => ({
  PatternsTab: ({ query }: { query: Record<string, unknown> }) => (
    <div data-testid="patterns-tab-stub" data-query-keys={Object.keys(query).join(",")} />
  ),
}));
vi.mock("./EventsTab", () => ({
  EventsTab: ({ query }: { query: Record<string, unknown> }) => (
    <div data-testid="events-tab-stub" data-query-keys={Object.keys(query).join(",")} />
  ),
}));

beforeEach(() => cleanup());

const baseHandlers = {
  onChangeTab: vi.fn(),
  onUpdateInvestigationsQuery: vi.fn(),
  onUpdateScansQuery: vi.fn(),
  onUpdatePatternsQuery: vi.fn(),
  onUpdateEventsQuery: vi.fn(),
  onViewInvestigation: vi.fn(),
  onOpenScanRun: vi.fn(),
  onNavigateHref: vi.fn(),
};

const investigationsView = (query: Record<string, unknown> = {}): ActivityView => ({
  type: "activity", tab: "investigations", query: query as never,
});
const scansView = (query: Record<string, unknown> = {}): ActivityView => ({
  type: "activity", tab: "scans", query: query as never,
});
const patternsView = (query: Record<string, unknown> = {}): ActivityView => ({
  type: "activity", tab: "patterns", query: query as never,
});
const eventsView = (query: Record<string, unknown> = {}): ActivityView => ({
  type: "activity", tab: "events", query: query as never,
});

describe("ActivityPage", () => {
  it("renders four tabs in order", () => {
    render(<ActivityPage view={investigationsView()} {...baseHandlers} />);
    const tabs = screen.getAllByRole("tab");
    const labels = tabs.map((t) => t.textContent?.replace(/\s+/g, " ").trim());
    expect(labels[0]).toContain("Investigations");
    expect(labels[1]).toContain("Scans");
    expect(labels[2]).toContain("Patterns");
    expect(labels[3]).toContain("Events");
  });

  it("marks the current tab as selected via aria-selected", () => {
    render(<ActivityPage view={eventsView()} {...baseHandlers} />);
    expect(screen.getByRole("tab", { name: /events/i }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: /investigations/i }).getAttribute("aria-selected")).toBe("false");
  });

  it("renders InvestigationsPage on the investigations tab", () => {
    render(<ActivityPage view={investigationsView()} {...baseHandlers} />);
    expect(screen.getByTestId("investigations-page-stub")).toBeDefined();
    expect(screen.queryByTestId("scans-tab-stub")).toBeNull();
    expect(screen.queryByTestId("patterns-tab-stub")).toBeNull();
    expect(screen.queryByTestId("events-tab-stub")).toBeNull();
  });

  it("renders ScansTab on the scans tab", () => {
    render(<ActivityPage view={scansView()} {...baseHandlers} />);
    expect(screen.getByTestId("scans-tab-stub")).toBeDefined();
    expect(screen.queryByTestId("investigations-page-stub")).toBeNull();
    expect(screen.queryByTestId("patterns-tab-stub")).toBeNull();
    expect(screen.queryByTestId("events-tab-stub")).toBeNull();
  });

  it("renders PatternsTab on the patterns tab", () => {
    render(<ActivityPage view={patternsView()} {...baseHandlers} />);
    expect(screen.getByTestId("patterns-tab-stub")).toBeDefined();
    expect(screen.queryByTestId("events-tab-stub")).toBeNull();
  });

  it("renders EventsTab on the events tab", () => {
    render(<ActivityPage view={eventsView()} {...baseHandlers} />);
    expect(screen.getByTestId("events-tab-stub")).toBeDefined();
    expect(screen.queryByTestId("patterns-tab-stub")).toBeNull();
  });

  it("calls onChangeTab when a tab is clicked", () => {
    const onChangeTab = vi.fn();
    render(<ActivityPage view={investigationsView()} {...baseHandlers} onChangeTab={onChangeTab} />);
    fireEvent.click(screen.getByRole("tab", { name: /events/i }));
    expect(onChangeTab).toHaveBeenCalledWith("events");
  });

  it("no tab shows a 'soon' badge — the Activity refactor is complete", () => {
    render(<ActivityPage view={investigationsView()} {...baseHandlers} />);
    expect(screen.queryAllByText(/^soon$/i)).toHaveLength(0);
  });

  it("threads the query prop through to InvestigationsPage on the investigations tab", () => {
    render(<ActivityPage view={investigationsView({ severity: ["high"], offset: 25 })} {...baseHandlers} />);
    const stub = screen.getByTestId("investigations-page-stub");
    expect(stub.getAttribute("data-query-keys")).toBe("severity,offset");
  });

  it("threads the query prop through to PatternsTab on the patterns tab", () => {
    render(<ActivityPage view={patternsView({ service: "payments-api", severity: ["critical"] })} {...baseHandlers} />);
    const stub = screen.getByTestId("patterns-tab-stub");
    expect(stub.getAttribute("data-query-keys")).toBe("service,severity");
  });

  it("threads the query prop through to EventsTab on the events tab", () => {
    render(<ActivityPage view={eventsView({ severity: ["error"], range: "24h" })} {...baseHandlers} />);
    const stub = screen.getByTestId("events-tab-stub");
    expect(stub.getAttribute("data-query-keys")).toBe("severity,range");
  });
});
