// src/web/components/Sidebar.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar } from "./Sidebar";

function renderSidebar(props = {}) {
  const defaultProps = {
    activePage: "dashboard" as const,
    onNavigate: vi.fn(),
    dark: false,
    onToggleTheme: vi.fn(),
    ...props,
  };
  return render(
    <TooltipProvider>
      <Sidebar {...defaultProps} />
    </TooltipProvider>
  );
}

describe("Sidebar", () => {
  it("renders all four navigation buttons", () => {
    renderSidebar();
    expect(screen.getByTitle("Operations Desk")).toBeDefined();
    expect(screen.getByTitle("Activity")).toBeDefined();
    expect(screen.getByTitle("Services")).toBeDefined();
    expect(screen.getByTitle("Settings")).toBeDefined();
  });

  it("marks the active page button", () => {
    renderSidebar({ activePage: "services" });
    const btn = screen.getByTitle("Services");
    expect(btn.className).toContain("text-primary");
  });

  it("marks Activity active for both list and detail views", () => {
    // The parent maps leftPane.type === "activity" (any tab) and
    // leftPane.type === "investigation" (detail) to "activity" here, so
    // drilling in and out keeps the sidebar highlight stable.
    renderSidebar({ activePage: "activity" });
    const btn = screen.getByTitle("Activity");
    expect(btn.className).toContain("text-primary");
  });

  it("calls onNavigate when a button is clicked", () => {
    const onNavigate = vi.fn();
    renderSidebar({ onNavigate });
    fireEvent.click(screen.getByTitle("Services"));
    expect(onNavigate).toHaveBeenCalledWith("services");
  });

  it("calls onNavigate with 'activity' when Activity is clicked", () => {
    const onNavigate = vi.fn();
    renderSidebar({ onNavigate });
    fireEvent.click(screen.getByTitle("Activity"));
    expect(onNavigate).toHaveBeenCalledWith("activity");
  });

  it("Activity link href deep-links to the investigations tab", () => {
    // Cmd-click / right-click on the sidebar entry should give the user a
    // canonical URL — landing on /activity/investigations rather than the
    // bare /activity (which would also work, but is less obvious).
    renderSidebar();
    const link = screen.getByTitle("Activity") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/activity/investigations");
  });

  it("calls onToggleTheme when theme button is clicked", () => {
    const onToggleTheme = vi.fn();
    renderSidebar({ onToggleTheme });
    fireEvent.click(screen.getByTitle("Toggle theme"));
    expect(onToggleTheme).toHaveBeenCalled();
  });
});
