// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { InvestigationFilters } from "./InvestigationFilters";

describe("InvestigationFilters", () => {
  beforeEach(() => {
    cleanup();
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("search input debounces by 300ms then fires onUpdateQuery", async () => {
    const onUpdate = vi.fn();
    render(<InvestigationFilters query={{}} onUpdateQuery={onUpdate} />);

    const input = screen.getByPlaceholderText(/Search by service/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "redis" } });

    // Before 300ms: not called
    act(() => { vi.advanceTimersByTime(200); });
    expect(onUpdate).not.toHaveBeenCalled();

    // After 300ms: fired with q=redis
    act(() => { vi.advanceTimersByTime(150); });
    expect(onUpdate).toHaveBeenCalledWith({ q: "redis" });
  });

  it("search typing rapidly only fires once after the last keystroke", async () => {
    const onUpdate = vi.fn();
    render(<InvestigationFilters query={{}} onUpdateQuery={onUpdate} />);
    const input = screen.getByPlaceholderText(/Search by service/) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "r" } });
    act(() => { vi.advanceTimersByTime(100); });
    fireEvent.change(input, { target: { value: "re" } });
    act(() => { vi.advanceTimersByTime(100); });
    fireEvent.change(input, { target: { value: "red" } });
    act(() => { vi.advanceTimersByTime(400); });

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith({ q: "red" });
  });

  it("search reset to empty string drops q from the query entirely", async () => {
    const onUpdate = vi.fn();
    render(
      <InvestigationFilters query={{ q: "redis" }} onUpdateQuery={onUpdate} />,
    );

    const input = screen.getByPlaceholderText(/Search by service/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    act(() => { vi.advanceTimersByTime(350); });

    expect(onUpdate).toHaveBeenCalledWith({}); // no q key at all
  });

  it("status pills toggle on click and reset offset", () => {
    const onUpdate = vi.fn();
    render(
      <InvestigationFilters
        query={{ offset: 50 }}
        onUpdateQuery={onUpdate}
      />,
    );

    fireEvent.click(screen.getByText("Running"));
    expect(onUpdate).toHaveBeenCalledWith({ status: ["running"] });
  });

  it("clicking an already-active status removes it", () => {
    const onUpdate = vi.fn();
    render(
      <InvestigationFilters
        query={{ status: ["running", "complete"] }}
        onUpdateQuery={onUpdate}
      />,
    );

    fireEvent.click(screen.getByText("Running"));
    expect(onUpdate).toHaveBeenCalledWith({ status: ["complete"] });
  });

  it("date presets set since to an absolute ISO timestamp, reset pagination, and clear until", () => {
    const onUpdate = vi.fn();
    render(
      <InvestigationFilters
        query={{ offset: 50, until: "2020-01-01T00:00:00Z" }}
        onUpdateQuery={onUpdate}
      />,
    );

    fireEvent.click(screen.getByText("7d"));
    const call = onUpdate.mock.calls[0]![0];
    // since is an ISO timestamp roughly 7d before now
    expect(typeof call.since).toBe("string");
    expect(call.since).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    const since = Date.parse(call.since);
    const expected = Date.now() - 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(since - expected)).toBeLessThan(5_000);
    expect(call.offset).toBeUndefined();
    expect(call.until).toBeUndefined();
  });

  it("'All' preset clears since entirely", () => {
    const onUpdate = vi.fn();
    render(
      <InvestigationFilters
        query={{ since: "2026-04-01T00:00:00Z" }}
        onUpdateQuery={onUpdate}
      />,
    );

    fireEvent.click(screen.getByText("All"));
    expect(onUpdate).toHaveBeenCalledWith({});
  });

  it("sort dropdown emits the selected value; default 'created_at' drops the key", () => {
    const onUpdate = vi.fn();
    render(<InvestigationFilters query={{}} onUpdateQuery={onUpdate} />);

    const select = screen.getByLabelText(/Sort by/i) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "confidence" } });
    expect(onUpdate).toHaveBeenLastCalledWith({ sort: "confidence" });

    fireEvent.change(select, { target: { value: "created_at" } });
    // back to default -> no sort key at all (keeps URL clean)
    expect(onUpdate).toHaveBeenLastCalledWith({});
  });

  it("Clear button only appears when at least one filter is active", () => {
    const { rerender } = render(
      <InvestigationFilters query={{}} onUpdateQuery={vi.fn()} />,
    );
    expect(screen.queryByText("Clear")).toBeNull();

    rerender(
      <InvestigationFilters
        query={{ severity: ["critical"] }}
        onUpdateQuery={vi.fn()}
      />,
    );
    expect(screen.getByText("Clear")).toBeTruthy();
  });

  it("Clear empties the whole query", () => {
    const onUpdate = vi.fn();
    render(
      <InvestigationFilters
        query={{ severity: ["critical"], status: ["running"], q: "redis" }}
        onUpdateQuery={onUpdate}
      />,
    );
    fireEvent.click(screen.getByText("Clear"));
    expect(onUpdate).toHaveBeenCalledWith({});
  });
});
