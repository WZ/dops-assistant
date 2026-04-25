// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ActivityPage } from "./ActivityPage";
import type { ActivityView } from "../App";

// Stub heavy children so the tab-shell test stays focused on shell behavior
// (tab strip, ARIA, placeholder copy). Their own behavior is covered by their
// own tests.
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

beforeEach(() => cleanup());

const baseHandlers = {
  onChangeTab: vi.fn(),
  onUpdateInvestigationsQuery: vi.fn(),
  onUpdateScansQuery: vi.fn(),
  onViewInvestigation: vi.fn(),
  onOpenScanRun: vi.fn(),
};

const investigationsView = (query: Record<string, unknown> = {}): ActivityView => ({
  type: "activity", tab: "investigations", query: query as never,
});
const scansView = (query: Record<string, unknown> = {}): ActivityView => ({
  type: "activity", tab: "scans", query: query as never,
});
const eventsView: ActivityView = { type: "activity", tab: "events", query: {} };
const patternsView: ActivityView = { type: "activity", tab: "patterns", query: {} };

describe("ActivityPage", () => {
  it("renders four tabs in order", () => {
    render(<ActivityPage view={investigationsView()} {...baseHandlers} />);
    const tabs = screen.getAllByRole("tab");
    const labels = tabs.map((t) => t.textContent?.replace(/\s+/g, " ").trim());
    expect(labels[0]).toContain("Investigations");
    expect(labels[1]).toContain("Scans");
    expect(labels[2]).toContain("Events");
    expect(labels[3]).toContain("Patterns");
  });

  it("marks the current tab as selected via aria-selected", () => {
    render(<ActivityPage view={scansView()} {...baseHandlers} />);
    expect(screen.getByRole("tab", { name: /scans/i }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: /investigations/i }).getAttribute("aria-selected")).toBe("false");
  });

  it("renders InvestigationsPage on the investigations tab", () => {
    render(<ActivityPage view={investigationsView()} {...baseHandlers} />);
    expect(screen.getByTestId("investigations-page-stub")).toBeDefined();
    expect(screen.queryByTestId("scans-tab-stub")).toBeNull();
  });

  it("renders ScansTab on the scans tab", () => {
    render(<ActivityPage view={scansView()} {...baseHandlers} />);
    expect(screen.getByTestId("scans-tab-stub")).toBeDefined();
    expect(screen.queryByTestId("investigations-page-stub")).toBeNull();
  });

  it("renders the Events placeholder copy", () => {
    render(<ActivityPage view={eventsView} {...baseHandlers} />);
    expect(screen.getByText(/Events tab coming soon/i)).toBeDefined();
  });

  it("renders the Patterns placeholder copy", () => {
    render(<ActivityPage view={patternsView} {...baseHandlers} />);
    expect(screen.getByText(/Patterns tab coming soon/i)).toBeDefined();
  });

  it("calls onChangeTab when a tab is clicked", () => {
    const onChangeTab = vi.fn();
    render(<ActivityPage view={investigationsView()} {...baseHandlers} onChangeTab={onChangeTab} />);
    fireEvent.click(screen.getByRole("tab", { name: /scans/i }));
    expect(onChangeTab).toHaveBeenCalledWith("scans");
  });

  it("Events and Patterns tabs show a 'soon' badge; Investigations and Scans do not", () => {
    render(<ActivityPage view={investigationsView()} {...baseHandlers} />);
    const soonBadges = screen.getAllByText(/^soon$/i);
    expect(soonBadges.length).toBe(2);
  });

  it("threads the query prop through to InvestigationsPage on the investigations tab", () => {
    render(<ActivityPage view={investigationsView({ severity: ["high"], offset: 25 })} {...baseHandlers} />);
    const stub = screen.getByTestId("investigations-page-stub");
    expect(stub.getAttribute("data-query-keys")).toBe("severity,offset");
  });

  it("threads the query prop through to ScansTab on the scans tab", () => {
    render(<ActivityPage view={scansView({ status: ["failed"], offset: 10 })} {...baseHandlers} />);
    const stub = screen.getByTestId("scans-tab-stub");
    expect(stub.getAttribute("data-query-keys")).toBe("status,offset");
  });
});
