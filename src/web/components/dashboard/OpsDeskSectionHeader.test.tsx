// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { OpsDeskSectionHeader } from "./OpsDeskSectionHeader";

describe("OpsDeskSectionHeader", () => {
  it("renders title + count only when total is absent", () => {
    render(<OpsDeskSectionHeader title="Recent Events" count={5} />);
    expect(screen.getByRole("heading", { name: "Recent Events" })).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
    expect(screen.queryByText(/View all/)).toBeNull();
    expect(screen.queryByText(/of/)).toBeNull();
  });

  it("renders just the count when total equals count", () => {
    // 5 displayed, 5 exist — no "of" hint, no View all.
    render(<OpsDeskSectionHeader title="Recent Events" count={5} total={5} />);
    expect(screen.getByText("5")).toBeTruthy();
    expect(screen.queryByText(/of/)).toBeNull();
    expect(screen.queryByText(/View all/)).toBeNull();
  });

  it("shows 'N of M' hint when total > count and no onViewAll", () => {
    // Recent Scans / Recent Events shape — more exist but no dedicated page
    // to link to, so we fall back to a passive count hint.
    render(<OpsDeskSectionHeader title="Recent Scans" count={5} total={32} />);
    expect(screen.getByText("5 of 32")).toBeTruthy();
    expect(screen.queryByText(/View all/)).toBeNull();
  });

  it("renders View all link + plain count when total > count and onViewAll is set", () => {
    // Investigation Log shape — dedicated /investigations page exists.
    const onViewAll = vi.fn();
    render(
      <OpsDeskSectionHeader
        title="Investigation Log"
        count={5}
        total={191}
        onViewAll={onViewAll}
      />,
    );
    // When there's a View-all link, the count just shows the displayed
    // number — the link carries the "191" instead so we don't duplicate.
    expect(screen.getByText("5")).toBeTruthy();
    expect(screen.queryByText(/of/)).toBeNull();
    const link = screen.getByText("View all 191 →");
    fireEvent.click(link);
    expect(onViewAll).toHaveBeenCalled();
  });

  it("renders a right-aligned action node when provided", () => {
    render(
      <OpsDeskSectionHeader
        title="Recent Scans"
        count={5}
        total={5}
        action={<button>Scan now</button>}
      />,
    );
    expect(screen.getByRole("button", { name: "Scan now" })).toBeTruthy();
  });

  it("formats large counts with thousands separators", () => {
    render(
      <OpsDeskSectionHeader
        title="Investigation Log"
        count={5}
        total={12_345}
        onViewAll={vi.fn()}
      />,
    );
    expect(screen.getByText("View all 12,345 →")).toBeTruthy();
  });
});
