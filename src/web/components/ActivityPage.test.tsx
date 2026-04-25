// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ActivityPage } from "./ActivityPage";

// Stub the heavy InvestigationsPage so the tab-shell test stays focused on
// shell behavior (tab strip, ARIA, placeholder copy). Its own behavior is
// covered by InvestigationsPage's existing tests.
vi.mock("./InvestigationsPage", () => ({
  InvestigationsPage: ({ query }: { query: Record<string, unknown> }) => (
    <div data-testid="investigations-page-stub" data-query-keys={Object.keys(query).join(",")} />
  ),
}));

beforeEach(() => cleanup());

const baseProps = {
  query: {},
  onChangeTab: vi.fn(),
  onUpdateQuery: vi.fn(),
  onViewInvestigation: vi.fn(),
};

describe("ActivityPage", () => {
  it("renders four tabs in order", () => {
    render(<ActivityPage tab="investigations" {...baseProps} />);
    const tabs = screen.getAllByRole("tab");
    const labels = tabs.map((t) => t.textContent?.replace(/\s+/g, " ").trim());
    expect(labels[0]).toContain("Investigations");
    expect(labels[1]).toContain("Scans");
    expect(labels[2]).toContain("Events");
    expect(labels[3]).toContain("Patterns");
  });

  it("marks the current tab as selected via aria-selected", () => {
    render(<ActivityPage tab="scans" {...baseProps} />);
    const scansTab = screen.getByRole("tab", { name: /scans/i });
    expect(scansTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: /investigations/i }).getAttribute("aria-selected")).toBe("false");
  });

  it("renders InvestigationsPage on the investigations tab", () => {
    render(<ActivityPage tab="investigations" {...baseProps} />);
    expect(screen.getByTestId("investigations-page-stub")).toBeDefined();
  });

  it("renders the Scans placeholder copy with no InvestigationsPage", () => {
    render(<ActivityPage tab="scans" {...baseProps} />);
    expect(screen.queryByTestId("investigations-page-stub")).toBeNull();
    expect(screen.getByText(/Scans tab coming soon/i)).toBeDefined();
  });

  it("renders the Events placeholder copy", () => {
    render(<ActivityPage tab="events" {...baseProps} />);
    expect(screen.getByText(/Events tab coming soon/i)).toBeDefined();
  });

  it("renders the Patterns placeholder copy", () => {
    render(<ActivityPage tab="patterns" {...baseProps} />);
    expect(screen.getByText(/Patterns tab coming soon/i)).toBeDefined();
  });

  it("calls onChangeTab when a tab is clicked", () => {
    const onChangeTab = vi.fn();
    render(<ActivityPage tab="investigations" {...baseProps} onChangeTab={onChangeTab} />);
    fireEvent.click(screen.getByRole("tab", { name: /scans/i }));
    expect(onChangeTab).toHaveBeenCalledWith("scans");
  });

  it("non-investigations tabs show a 'soon' badge", () => {
    render(<ActivityPage tab="investigations" {...baseProps} />);
    // Three placeholders → three "soon" badges. Investigations has none.
    const soonBadges = screen.getAllByText(/^soon$/i);
    expect(soonBadges.length).toBe(3);
  });

  it("threads the query prop through to InvestigationsPage on the investigations tab", () => {
    render(
      <ActivityPage
        {...baseProps}
        tab="investigations"
        query={{ severity: ["high"], offset: 25 } as any}
      />,
    );
    const stub = screen.getByTestId("investigations-page-stub");
    // The mock surfaces the query object's keys for assertion.
    expect(stub.getAttribute("data-query-keys")).toBe("severity,offset");
  });
});
