// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { ChatPane } from "./ChatPane";
import { StackProvider } from "../contexts/StackContext";
import type { ReactNode } from "react";

function Wrapper({ children }: { children: ReactNode }) {
  return <StackProvider activeStackId="test-stack">{children}</StackProvider>;
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
