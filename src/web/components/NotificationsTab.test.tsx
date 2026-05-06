// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { NotificationsTab } from "./NotificationsTab";
import { StackProvider } from "../contexts/StackContext";

function Wrapper({ children }: { children: ReactNode }) {
  return <StackProvider activeStackId="alpha">{children}</StackProvider>;
}

const baseSlack = {
  webhookUrl: null,
  enabled: false,
  source: "none",
  onScanComplete: "hits-only",
};

describe("NotificationsTab", () => {
  const originalFetch = global.fetch;
  let fetchImpl: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchImpl = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.endsWith("/api/notifications")) return new Response(JSON.stringify({ slack: baseSlack }), { status: 200 });
      if (u.endsWith("/api/notifications/email")) return new Response(JSON.stringify({ enabled: false, recipients: [] }), { status: 200 });
      if (u.endsWith("/api/notifications/email/recipients")) return new Response(JSON.stringify([]), { status: 200 });
      return new Response("{}", { status: 200 });
    });
    global.fetch = fetchImpl as any;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("renders the global banner", async () => {
    render(<Wrapper><NotificationsTab /></Wrapper>);
    await waitFor(() => {
      expect(screen.getByText(/Global . applies to all stacks/i)).toBeDefined();
    });
  });
});
