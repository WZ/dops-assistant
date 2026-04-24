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

  it("date presets set range to the preset key, reset pagination, and clear since/until", () => {
    const onUpdate = vi.fn();
    render(
      <InvestigationFilters
        query={{ offset: 50, since: "2020-01-01T00:00:00Z", until: "2020-06-01T00:00:00Z" }}
        onUpdateQuery={onUpdate}
      />,
    );

    fireEvent.click(screen.getByText("7d"));
    expect(onUpdate).toHaveBeenCalledWith({ range: "7d" });
  });

  it("'All' preset clears range and since/until entirely", () => {
    const onUpdate = vi.fn();
    render(
      <InvestigationFilters
        query={{ range: "7d", since: "2026-04-01T00:00:00Z" }}
        onUpdateQuery={onUpdate}
      />,
    );

    fireEvent.click(screen.getByText("All"));
    expect(onUpdate).toHaveBeenCalledWith({});
  });

  it("active preset reads from range directly (no time drift)", () => {
    const { container } = render(
      <InvestigationFilters query={{ range: "7d" }} onUpdateQuery={vi.fn()} />,
    );
    const pressed = container.querySelectorAll('[aria-pressed="true"]');
    // Only the "7d" pill should be pressed, not "All"
    expect(Array.from(pressed).map((el) => el.textContent)).toEqual(["7d"]);
  });

  it("custom since with no range shows no preset as active (neither 'All' nor any preset)", () => {
    // User arrives via a hand-edited URL with a custom since timestamp. We
    // don't have a "custom" pill, but we must NOT light up "All" — that was
    // the UI-gaslighting bug where "All" said pressed while since was still
    // filtering the list.
    const { container } = render(
      <InvestigationFilters
        query={{ since: "2026-04-01T00:00:00Z" }}
        onUpdateQuery={vi.fn()}
      />,
    );
    const pressed = container.querySelectorAll('[aria-pressed="true"]');
    expect(pressed.length).toBe(0);
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

  it("sort change resets offset so the user doesn't land mid-list", () => {
    // On page 2+ with sort=created_at, switching to confidence would otherwise
    // drop the user into row 26 of the newly-sorted results instead of the
    // highest-confidence row they asked for.
    const onUpdate = vi.fn();
    render(
      <InvestigationFilters query={{ offset: 50 }} onUpdateQuery={onUpdate} />,
    );

    const select = screen.getByLabelText(/Sort by/i) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "confidence" } });
    const call = onUpdate.mock.calls[0]![0];
    expect(call.sort).toBe("confidence");
    expect(call.offset).toBeUndefined();
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
