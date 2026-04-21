// src/web/components/ServicesTable.test.tsx
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ServicesTable } from "./ServicesTable";
import type { ServiceListItem } from "../../types/services";

const baseItem = (overrides: Partial<ServiceListItem> = {}): ServiceListItem => ({
  name: "svc",
  health: "healthy",
  metadata: { tags: [] },
  lastInvestigation: null,
  ...overrides,
});

describe("ServicesTable", () => {
  it("renders one row per service", () => {
    const items = [baseItem({ name: "a" }), baseItem({ name: "b" }), baseItem({ name: "c" })];
    render(<ServicesTable items={items} onOpenService={() => {}} onInvestigate={() => {}} />);
    expect(screen.getAllByRole("row")).toHaveLength(items.length + 1); // +1 header row
  });

  it("renders tier and owner tags from metadata", () => {
    const items = [baseItem({ metadata: { tags: ["tier:0", "owner:platform"] } })];
    render(<ServicesTable items={items} onOpenService={() => {}} onInvestigate={() => {}} />);
    expect(screen.getByText(/T0/i)).toBeInTheDocument();
    expect(screen.getByText(/platform/i)).toBeInTheDocument();
  });

  it("shows '—' when no last investigation", () => {
    render(<ServicesTable items={[baseItem()]} onOpenService={() => {}} onInvestigate={() => {}} />);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("shows relative time and confidence for last investigation", () => {
    const items = [baseItem({
      lastInvestigation: { id: "i1", createdAt: Date.now() - 3 * 86400_000, confidence: 0.82, status: "complete" },
    })];
    render(<ServicesTable items={items} onOpenService={() => {}} onInvestigate={() => {}} />);
    expect(screen.getByText(/3d ago/)).toBeInTheDocument();
    expect(screen.getByText(/82%/)).toBeInTheDocument();
  });

  it("calls onOpenService when row is clicked", () => {
    const onOpenService = vi.fn();
    render(<ServicesTable items={[baseItem({ name: "foo" })]} onOpenService={onOpenService} onInvestigate={() => {}} />);
    fireEvent.click(screen.getByText("foo"));
    expect(onOpenService).toHaveBeenCalledWith("foo");
  });

  it("calls onInvestigate when Investigate action is clicked", () => {
    const onInvestigate = vi.fn();
    render(<ServicesTable items={[baseItem({ name: "foo" })]} onOpenService={() => {}} onInvestigate={onInvestigate} />);
    fireEvent.click(screen.getByRole("button", { name: /investigate/i }));
    expect(onInvestigate).toHaveBeenCalledWith("foo");
  });
});
