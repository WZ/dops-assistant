// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, act } from "@testing-library/react";
import { ChatPane } from "./ChatPane";
import { StackProvider } from "../contexts/StackContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ReactNode } from "react";

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <StackProvider activeStackId="test-stack">
      <TooltipProvider>{children}</TooltipProvider>
    </StackProvider>
  );
}

function renderChat(props: Partial<React.ComponentProps<typeof ChatPane>> = {}) {
  const defaultProps: React.ComponentProps<typeof ChatPane> = {
    ws: {
      send: vi.fn(),
      messages: [],
      status: "connected",
    } as any,
    onInvestigationStarted: vi.fn(),
    onViewInvestigation: vi.fn(),
  };
  return render(<ChatPane {...defaultProps} {...props} />, { wrapper: Wrapper });
}

describe("ChatPane loading skeleton", () => {
  beforeEach(() => {
    cleanup();
    globalThis.fetch = vi.fn();
    // jsdom doesn't implement Element#scrollTo; ChatPane's useAutoScroll
    // calls it on mount and will otherwise throw before the skeleton renders.
    if (!("scrollTo" in Element.prototype)) {
      // @ts-expect-error — patching jsdom prototype
      Element.prototype.scrollTo = () => {};
    } else {
      Element.prototype.scrollTo = vi.fn();
    }
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders a skeleton (not plain text) while initial history loads", () => {
    // Never-resolving fetch keeps the component in historyLoading=true forever.
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}));
    renderChat();

    // New skeleton UI is discoverable + announced, unlike the old plain
    // "Loading messages..." text which leaked to every screen reader.
    const skeleton = screen.getByTestId("chat-loading-skeleton");
    expect(skeleton).toBeDefined();
    expect(skeleton.getAttribute("role")).toBe("status");

    // 3 fake bubble rows, each animate-pulse.
    const pulsingBubbles = skeleton.querySelectorAll(".animate-pulse");
    expect(pulsingBubbles.length).toBe(3);
  });

  it("hides starter chips while initial history loads", () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}));
    renderChat();

    expect(screen.queryByRole("button", { name: "What's unhealthy?" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Try /investigate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Recent incidents" })).toBeNull();
  });

  it("removes the skeleton once history resolves", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });
    renderChat();

    await waitFor(() => {
      expect(screen.queryByTestId("chat-loading-skeleton")).toBeNull();
    });
  });
});

describe("ChatPane confirm-dispatch banner", () => {
  beforeEach(() => {
    cleanup();
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });
    if (!("scrollTo" in Element.prototype)) {
      // @ts-expect-error — patching jsdom prototype
      Element.prototype.scrollTo = () => {};
    } else {
      Element.prototype.scrollTo = vi.fn();
    }
    try { localStorage.removeItem("consoleFeed:migrationToastSeen"); } catch { /* test env may stub localStorage */ }
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the banner on investigation:confirm_dispatch and Cancel sends cancel_dispatch", async () => {
    const send = vi.fn();
    const { rerender } = render(
      <ChatPane
        ws={{ send, messages: [], status: "connected" } as any}
        onInvestigationStarted={vi.fn()}
        onViewInvestigation={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(screen.queryByTestId("chat-loading-skeleton")).toBeNull();
    });

    // Re-render with a confirm_dispatch WS message in the queue
    rerender(
      <Wrapper>
        <ChatPane
          ws={{
            send,
            messages: [
              {
                type: "investigation:confirm_dispatch",
                id: "inv_test_001",
                service: "kafka-brokers",
                query: "investigate kafka",
                timerMs: 5000,
              },
            ],
            status: "connected",
          } as any}
          onInvestigationStarted={vi.fn()}
          onViewInvestigation={vi.fn()}
        />
      </Wrapper>,
    );

    const banner = await screen.findByTestId("confirm-dispatch-banner");
    expect(banner).toBeDefined();
    expect(banner.getAttribute("data-confirm-id")).toBe("inv_test_001");
    expect(banner.textContent).toContain("DISPATCHING");
    expect(banner.textContent).toContain("kafka-brokers");

    // Click Cancel — verify cancel_dispatch is sent with the right id
    const cancelBtn = screen.getByTestId("confirm-dispatch-cancel");
    fireEvent.click(cancelBtn);

    expect(send).toHaveBeenCalledWith({
      type: "investigation:cancel_dispatch",
      id: "inv_test_001",
    });
  });

  it("clears the banner on investigation:dispatch_cancelled with matching id", async () => {
    const send = vi.fn();
    const { rerender } = render(
      <ChatPane
        ws={{
          send,
          messages: [
            {
              type: "investigation:confirm_dispatch",
              id: "inv_test_002",
              service: "payments-api",
              query: "/investigate payments-api",
              timerMs: 5000,
            },
          ],
          status: "connected",
        } as any}
        onInvestigationStarted={vi.fn()}
        onViewInvestigation={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    await screen.findByTestId("confirm-dispatch-banner");

    rerender(
      <Wrapper>
        <ChatPane
          ws={{
            send,
            messages: [
              {
                type: "investigation:confirm_dispatch",
                id: "inv_test_002",
                service: "payments-api",
                query: "/investigate payments-api",
                timerMs: 5000,
              },
              {
                type: "investigation:dispatch_cancelled",
                id: "inv_test_002",
                service: "payments-api",
              },
            ],
            status: "connected",
          } as any}
          onInvestigationStarted={vi.fn()}
          onViewInvestigation={vi.fn()}
        />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.queryByTestId("confirm-dispatch-banner")).toBeNull();
    });
  });
});

describe("ChatPane migration toast", () => {
  beforeEach(() => {
    cleanup();
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });
    if (!("scrollTo" in Element.prototype)) {
      // @ts-expect-error — patching jsdom prototype
      Element.prototype.scrollTo = () => {};
    } else {
      Element.prototype.scrollTo = vi.fn();
    }
    try { localStorage.removeItem("consoleFeed:migrationToastSeen"); } catch { /* test env may stub localStorage */ }
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the toast on first mount", async () => {
    renderChat();
    const toast = await screen.findByTestId("migration-toast");
    expect(toast.textContent).toMatch(/\/investigate/);
  });

  it("dismiss button hides the toast", async () => {
    renderChat();
    const toast = await screen.findByTestId("migration-toast");
    const dismiss = toast.querySelector("button[aria-label='Dismiss migration tip']") as HTMLButtonElement;
    expect(dismiss).toBeDefined();
    fireEvent.click(dismiss);
    await waitFor(() => {
      expect(screen.queryByTestId("migration-toast")).toBeNull();
    });
  });
});

describe("ChatPane in-reply 'Run full investigation' pill", () => {
  beforeEach(() => {
    cleanup();
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });
    if (!("scrollTo" in Element.prototype)) {
      // @ts-expect-error — patching jsdom prototype
      Element.prototype.scrollTo = () => {};
    } else {
      Element.prototype.scrollTo = vi.fn();
    }
    try { localStorage.removeItem("consoleFeed:migrationToastSeen"); } catch { /* test env may stub localStorage */ }
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the pill when chat:stream_end carries serviceContext, click sends /investigate", async () => {
    const send = vi.fn();
    render(
      <ChatPane
        ws={{
          send,
          messages: [
            { type: "chat:stream_start" },
            {
              type: "chat:stream_end",
              content: "Kafka brokers are down — 3/5 replicas unavailable.",
              id: "msg_1",
              createdAt: new Date().toISOString(),
              serviceContext: "kafka-brokers",
            },
          ],
          status: "connected",
        } as any}
        onInvestigationStarted={vi.fn()}
        onViewInvestigation={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    const pill = await screen.findByRole("button", { name: /Run full investigation on/ });
    expect(pill).toBeDefined();
    expect(pill.textContent).toContain("kafka-brokers");

    fireEvent.click(pill);
    expect(send).toHaveBeenCalledWith({
      type: "chat",
      message: "/investigate kafka-brokers",
    });
  });

  it("only sends one /investigate command on rapid pill double-click", async () => {
    const send = vi.fn();
    render(
      <ChatPane
        ws={{
          send,
          messages: [
            { type: "chat:stream_start" },
            {
              type: "chat:stream_end",
              content: "Kafka brokers are down — 3/5 replicas unavailable.",
              id: "msg_rapid",
              createdAt: new Date().toISOString(),
              serviceContext: "kafka-brokers",
            },
          ],
          status: "connected",
        } as any}
        onInvestigationStarted={vi.fn()}
        onViewInvestigation={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    const pill = await screen.findByRole("button", { name: /Run full investigation on/ });
    fireEvent.click(pill);
    fireEvent.click(pill);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: "chat",
      message: "/investigate kafka-brokers",
    });
  });

  it("does NOT render the pill when serviceContext is absent", async () => {
    render(
      <ChatPane
        ws={{
          send: vi.fn(),
          messages: [
            { type: "chat:stream_start" },
            {
              type: "chat:stream_end",
              content: "What dashboards do we have?",
              id: "msg_2",
              createdAt: new Date().toISOString(),
            },
          ],
          status: "connected",
        } as any}
        onInvestigationStarted={vi.fn()}
        onViewInvestigation={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(screen.queryByTestId("chat-loading-skeleton")).toBeNull();
    });

    expect(screen.queryByRole("button", { name: /Run full investigation on/ })).toBeNull();
  });
});

describe("ChatPane slash autocomplete popover", () => {
  beforeEach(() => {
    cleanup();
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });
    if (!("scrollTo" in Element.prototype)) {
      // @ts-expect-error — patching jsdom prototype
      Element.prototype.scrollTo = () => {};
    } else {
      Element.prototype.scrollTo = vi.fn();
    }
    try { localStorage.removeItem("consoleFeed:migrationToastSeen"); } catch { /* test env may stub localStorage */ }
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the slash popover when input starts with '/' and is hidden by default", async () => {
    renderChat();
    await waitFor(() => {
      expect(screen.queryByTestId("chat-loading-skeleton")).toBeNull();
    });

    expect(screen.queryByTestId("slash-popover")).toBeNull();

    const inputEl = screen.getByPlaceholderText(/Ask anything/);
    fireEvent.change(inputEl, { target: { value: "/" } });

    expect(screen.getByTestId("slash-popover")).toBeDefined();
  });
});
