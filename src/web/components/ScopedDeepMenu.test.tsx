// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ServerMessage, ClientMessage } from "../../types/ws-types.js";
import { OrchestratorRunProvider } from "../contexts/OrchestratorRunContext";
import { ScopedDeepMenu } from "./ScopedDeepMenu";

const ID = "inv_menu";

function renderMenu(opts: {
  canChallenge?: boolean;
  send?: (m: ClientMessage) => void;
  status?: "connecting" | "connected" | "disconnected";
  messages?: ServerMessage[];
} = {}) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <OrchestratorRunProvider wsMessages={opts.messages ?? []} wsSend={opts.send ?? vi.fn()} connectionStatus={opts.status ?? "connected"}>
      {children}
    </OrchestratorRunProvider>
  );
  return render(<ScopedDeepMenu investigationId={ID} canChallenge={opts.canChallenge ?? true} />, { wrapper });
}

// Radix DropdownMenu uses the Pointer Capture API, which jsdom doesn't implement.
beforeEach(() => {
  cleanup();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  (window as unknown as Record<string, unknown>).__ORCHESTRATOR_ENABLED__ = true;
  (window as unknown as Record<string, unknown>).__DEEP_MODE_ENABLED__ = true;
});

/** Radix DropdownMenu opens on pointerDown, not click (mirrors ScanRunDetail.test). */
function openMenu() {
  fireEvent.pointerDown(screen.getByRole("button", { name: /Investigate deeply/i }));
}
afterEach(() => {
  (window as unknown as Record<string, unknown>).__ORCHESTRATOR_ENABLED__ = undefined;
  (window as unknown as Record<string, unknown>).__DEEP_MODE_ENABLED__ = undefined;
  vi.useRealTimers();
});

describe("ScopedDeepMenu", () => {
  it("renders nothing when neither scope is enabled", () => {
    (window as unknown as Record<string, unknown>).__ORCHESTRATOR_ENABLED__ = false;
    (window as unknown as Record<string, unknown>).__DEEP_MODE_ENABLED__ = false;
    const { container } = renderMenu();
    expect(container.firstChild).toBeNull();
  });

  it("shows the single 'Investigate deeply' trigger when enabled", () => {
    renderMenu();
    expect(screen.getByRole("button", { name: /Investigate deeply/i })).toBeTruthy();
  });

  it("Challenge launches deep_mode immediately via the registry", () => {
    const send = vi.fn();
    renderMenu({ send });
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Challenge this RCA/i }));
    expect(send).toHaveBeenCalledWith({ type: "deep_mode_investigate", investigationId: ID });
  });

  it("Full routes through a cancellable confirm countdown that dispatches the orchestrator", async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    renderMenu({ send });
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Full deep investigation/i }));
    // countdown shows, nothing dispatched yet
    expect(screen.getByText(/Starting Full Deep Investigation in 3/)).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
    // Step each tick with an effect-flush between, so the chained setTimeout
    // (3→2→1→0) re-arms and the zero-render dispatches.
    for (let i = 0; i < 4; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    }
    expect(send).toHaveBeenCalledWith({ type: "orchestrator_investigate", investigationId: ID });
  });

  it("Full countdown can be cancelled before dispatch", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    renderMenu({ send });
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Full deep investigation/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancel the deep investigation/i }));
    act(() => { vi.advanceTimersByTime(900 * 4); });
    expect(send).not.toHaveBeenCalled();
  });

  it("hides the Challenge scope when there is nothing to re-examine", () => {
    renderMenu({ canChallenge: false });
    openMenu();
    expect(screen.queryByRole("menuitem", { name: /Challenge this RCA/i })).toBeNull();
    expect(screen.getByRole("menuitem", { name: /Full deep investigation/i })).toBeTruthy();
  });
});
