// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import {
  useUnreadInvestigations,
  __resetUnreadInvestigationsForTest,
} from "./useUnreadInvestigations";

// Two independent components using the hook. The whole point of the
// module-level state + subscriber fan-out is that a mutation in one
// hook instance immediately propagates to every other mounted instance —
// without that, "Mark all as read" in the Investigations tab leaves the
// chat-pane RCA cards still glowing as unread.
function ReaderA({ id }: { id: string }) {
  const { isUnread, markViewed } = useUnreadInvestigations();
  return (
    <div>
      <span data-testid="a-status">{isUnread(id) ? "UNREAD" : "READ"}</span>
      <button data-testid="a-mark" onClick={() => markViewed(id)}>mark A</button>
    </div>
  );
}

function ReaderB({ id }: { id: string }) {
  const { isUnread, markManyViewed } = useUnreadInvestigations();
  return (
    <div>
      <span data-testid="b-status">{isUnread(id) ? "UNREAD" : "READ"}</span>
      <button data-testid="b-mark-many" onClick={() => markManyViewed([id])}>mark many B</button>
    </div>
  );
}

function installLocalStorageStub() {
  const store: Record<string, string> = {};
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
      clear: () => { for (const k of Object.keys(store)) delete store[k]; },
      key: (i: number) => Object.keys(store)[i] ?? null,
      get length() { return Object.keys(store).length; },
    },
  });
  return store;
}

describe("useUnreadInvestigations", () => {
  beforeEach(() => {
    cleanup();
    __resetUnreadInvestigationsForTest();
    installLocalStorageStub();
  });

  it("propagates markViewed across mounted hook instances", async () => {
    render(<><ReaderA id="inv_x" /><ReaderB id="inv_x" /></>);
    expect(screen.getByTestId("a-status").textContent).toBe("UNREAD");
    expect(screen.getByTestId("b-status").textContent).toBe("UNREAD");

    fireEvent.click(screen.getByTestId("a-mark"));

    // B (a different hook instance) flips to READ without any extra action.
    await waitFor(() => expect(screen.getByTestId("b-status").textContent).toBe("READ"));
    expect(screen.getByTestId("a-status").textContent).toBe("READ");
  });

  it("propagates markManyViewed across mounted hook instances", async () => {
    render(<><ReaderA id="inv_y" /><ReaderB id="inv_y" /></>);

    fireEvent.click(screen.getByTestId("b-mark-many"));

    await waitFor(() => expect(screen.getByTestId("a-status").textContent).toBe("READ"));
    expect(screen.getByTestId("b-status").textContent).toBe("READ");
  });

  it("hydrates from localStorage on first read", async () => {
    const store = installLocalStorageStub();
    store["dops:viewed-investigations"] = JSON.stringify(["inv_seed"]);
    __resetUnreadInvestigationsForTest();

    render(<ReaderA id="inv_seed" />);
    expect(screen.getByTestId("a-status").textContent).toBe("READ");
  });
});
