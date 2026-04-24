// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { SeverityBreakdown } from "./SeverityBreakdown";
import { StackProvider } from "../../contexts/StackContext";
import type { ReactNode } from "react";

function Wrapper({ children }: { children: ReactNode }) {
  return <StackProvider activeStackId="test-stack">{children}</StackProvider>;
}

describe("SeverityBreakdown", () => {
  beforeEach(() => {
    cleanup();
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("fetches counts and renders them on each pill", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ critical: 12, high: 34, medium: 78, low: 156 }),
    });

    render(
      <SeverityBreakdown query={{}} onToggleSeverity={vi.fn()} />,
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(screen.getByText("12")).toBeTruthy();
      expect(screen.getByText("34")).toBeTruthy();
      expect(screen.getByText("78")).toBeTruthy();
      expect(screen.getByText("156")).toBeTruthy();
    });
  });

  it("clicking a pill fires onToggleSeverity with the severity key", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ critical: 5, high: 0, medium: 0, low: 0 }),
    });

    const onToggle = vi.fn();
    render(
      <SeverityBreakdown query={{}} onToggleSeverity={onToggle} />,
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(screen.getByText("5")).toBeTruthy());

    fireEvent.click(screen.getByText("Critical"));
    expect(onToggle).toHaveBeenCalledWith("critical");
  });

  it("active severities show aria-pressed=true", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ critical: 5, high: 2, medium: 0, low: 0 }),
    });

    render(
      <SeverityBreakdown
        query={{ severity: ["high"] }}
        onToggleSeverity={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(screen.getByText("5")).toBeTruthy());

    // High is active
    const highBtn = screen.getByText("High").closest("button")!;
    expect(highBtn.getAttribute("aria-pressed")).toBe("true");
    // Critical is not
    const critBtn = screen.getByText("Critical").closest("button")!;
    expect(critBtn.getAttribute("aria-pressed")).toBe("false");
  });

  it("pill with zero count is disabled unless it's the active filter", async () => {
    // Zero + inactive = disabled (nothing to click for), zero + active = still
    // clickable so the user can untoggle it.
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ critical: 5, high: 0, medium: 0, low: 0 }),
    });

    render(
      <SeverityBreakdown
        query={{ severity: ["medium"] }} // medium has 0 but is active
        onToggleSeverity={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(screen.getByText("5")).toBeTruthy());

    const medBtn = screen.getByText("Medium").closest("button") as HTMLButtonElement;
    const lowBtn = screen.getByText("Low").closest("button") as HTMLButtonElement;
    expect(medBtn.disabled).toBe(false); // active — still clickable to untoggle
    expect(lowBtn.disabled).toBe(true); // zero + inactive
  });

  it("ignores stale responses when the query changes before an earlier fetch resolves", async () => {
    // Regression: previously, abort-only cleanup let a slow earlier response
    // call setCounts AFTER a faster later response, flashing the wrong counts
    // when the user toggled filters quickly.
    const pending: Array<(value: { critical: number; high: number; medium: number; low: number }) => void> = [];
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () => new Promise((resolve) => { pending.push(resolve); }),
      }),
    );

    const { rerender } = render(
      <SeverityBreakdown query={{}} onToggleSeverity={vi.fn()} />,
      { wrapper: Wrapper },
    );
    // Let the first fetch's .then fire so pending[0] is populated.
    await waitFor(() => expect(pending.length).toBeGreaterThanOrEqual(1));

    // Change the query before the first fetch resolves.
    rerender(
      <SeverityBreakdown
        query={{ status: ["running"] }}
        onToggleSeverity={vi.fn()}
      />,
    );
    await waitFor(() => expect(pending.length).toBeGreaterThanOrEqual(2));

    // Resolve out of order: second (latest) resolves first, then the stale
    // first resolves. Without the seq guard, the stale response would
    // overwrite the latest.
    pending[1]!({ critical: 9, high: 9, medium: 9, low: 9 });
    await waitFor(() => expect(screen.getAllByText("9").length).toBeGreaterThan(0));
    pending[0]!({ critical: 1, high: 1, medium: 1, low: 1 });

    // Stale response must NOT overwrite. Still see 9s, not 1s.
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText("1")).toBeNull();
    expect(screen.getAllByText("9").length).toBeGreaterThan(0);
  });

  it("fetches with the current filter minus severity/limit/offset/sort", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ critical: 0, high: 0, medium: 0, low: 0 }),
    });
    globalThis.fetch = fetchMock;

    render(
      <SeverityBreakdown
        query={{
          severity: ["critical"], // must NOT appear in the fetch URL
          status: ["running"],
          service: "payments-api",
          limit: 50, // pagination shouldn't affect the histogram
          offset: 100,
          sort: "confidence",
        }}
        onToggleSeverity={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      const call = fetchMock.mock.calls[0];
      expect(call).toBeDefined();
      const url = String(call![0]);
      expect(url).toContain("/api/investigations/severity-counts");
      expect(url).toContain("status=running");
      expect(url).toContain("service=payments-api");
      expect(url).not.toContain("severity=");
      expect(url).not.toContain("limit=");
      expect(url).not.toContain("offset=");
      expect(url).not.toContain("sort=");
    });
  });
});
