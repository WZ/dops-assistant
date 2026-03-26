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
  it("renders three navigation buttons", () => {
    renderSidebar();
    expect(screen.getByTitle("Operations Desk")).toBeDefined();
    expect(screen.getByTitle("Services")).toBeDefined();
    expect(screen.getByTitle("Settings")).toBeDefined();
  });

  it("marks the active page button", () => {
    renderSidebar({ activePage: "services" });
    const btn = screen.getByTitle("Services");
    expect(btn.className).toContain("text-primary");
  });

  it("calls onNavigate when a button is clicked", () => {
    const onNavigate = vi.fn();
    renderSidebar({ onNavigate });
    fireEvent.click(screen.getByTitle("Services"));
    expect(onNavigate).toHaveBeenCalledWith("services");
  });

  it("calls onToggleTheme when theme button is clicked", () => {
    const onToggleTheme = vi.fn();
    renderSidebar({ onToggleTheme });
    fireEvent.click(screen.getByTitle("Toggle theme"));
    expect(onToggleTheme).toHaveBeenCalled();
  });
});
