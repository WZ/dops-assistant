// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FilterChips } from "./FilterChips";

describe("FilterChips", () => {
  it("renders status chips with counts", () => {
    const onChange = vi.fn();
    render(
      <FilterChips
        value={{ status: [], tiers: [], owners: [] }}
        onChange={onChange}
        availableTiers={["0", "1", "2"]}
        availableOwners={["platform", "payments"]}
        counts={{ healthy: 12, degraded: 2, down: 1, unknown: 5 }}
      />
    );
    expect(screen.getByRole("button", { name: /healthy.*12/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /down.*1/i })).toBeInTheDocument();
  });

  it("toggles a status chip on click", () => {
    const onChange = vi.fn();
    render(
      <FilterChips
        value={{ status: [], tiers: [], owners: [] }}
        onChange={onChange}
        availableTiers={[]}
        availableOwners={[]}
        counts={{ healthy: 1, degraded: 0, down: 0, unknown: 0 }}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /healthy/i }));
    expect(onChange).toHaveBeenCalledWith({ status: ["healthy"], tiers: [], owners: [] });
  });

  it("renders tier chips when availableTiers provided", () => {
    const onChange = vi.fn();
    render(
      <FilterChips
        value={{ status: [], tiers: [], owners: [] }}
        onChange={onChange}
        availableTiers={["0", "1"]}
        availableOwners={[]}
        counts={{ healthy: 0, degraded: 0, down: 0, unknown: 0 }}
      />
    );
    expect(screen.getByRole("button", { name: /T0/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /T1/i })).toBeInTheDocument();
  });
});
