// src/web/components/HealthStrip.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { HealthStrip } from "./HealthStrip";

describe("HealthStrip", () => {
  const services = [
    { name: "auth-service", health: "degraded" as const },
    { name: "payments-api", health: "healthy" as const },
    { name: "user-service", health: "healthy" as const },
  ];

  it("renders all services as chips", () => {
    render(<HealthStrip services={services} onViewAll={() => {}} onClickService={() => {}} />);
    expect(screen.getByText("auth-service")).toBeDefined();
    expect(screen.getByText("payments-api")).toBeDefined();
    expect(screen.getByText("user-service")).toBeDefined();
  });

  it("sorts unhealthy services first", () => {
    render(<HealthStrip services={services} onViewAll={() => {}} onClickService={() => {}} />);
    const chips = screen.getAllByRole("button").filter(b => !b.textContent?.includes("View all"));
    expect(chips[0].textContent).toContain("auth-service");
  });

  it("calls onClickService when a chip is clicked", () => {
    const onClickService = vi.fn();
    render(<HealthStrip services={services} onViewAll={() => {}} onClickService={onClickService} />);
    fireEvent.click(screen.getByText("auth-service"));
    expect(onClickService).toHaveBeenCalledWith("auth-service");
  });

  it("calls onViewAll when View all link is clicked", () => {
    const onViewAll = vi.fn();
    render(<HealthStrip services={services} onViewAll={onViewAll} onClickService={() => {}} />);
    fireEvent.click(screen.getByText(/View all/));
    expect(onViewAll).toHaveBeenCalled();
  });

  it("renders nothing when services list is empty", () => {
    const { container } = render(<HealthStrip services={[]} onViewAll={() => {}} onClickService={() => {}} />);
    expect(container.querySelector("[data-testid='health-strip']")).toBeNull();
  });
});
