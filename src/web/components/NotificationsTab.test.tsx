// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { NotificationsTab } from "./NotificationsTab";
import { StackProvider } from "../contexts/StackContext";

function Wrapper({ stackId, children }: { stackId: string; children: ReactNode }) {
  return <StackProvider activeStackId={stackId}>{children}</StackProvider>;
}

const baseView = {
  slack: {
    webhookUrl: { value: "https://hooks.example.com/g", source: "global" },
    enabled: { value: true, source: "global" },
    onScanComplete: { value: "hits-only", source: "global" },
  },
  email: { enabled: { value: false, source: "default" } },
};

describe("NotificationsTab", () => {
  const originalFetch = global.fetch;
  let fetchImpl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchImpl = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.endsWith("/api/notifications")) return new Response(JSON.stringify(baseView), { status: 200 });
      if (u.endsWith("/api/notifications/email/recipients")) return new Response(JSON.stringify([]), { status: 200 });
      if (u.endsWith("/api/notifications/email")) return new Response(JSON.stringify({ enabled: false, recipients: [] }), { status: 200 });
      return new Response("{}", { status: 200 });
    });
    global.fetch = fetchImpl as any;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("renders [Global] chips when source is global", async () => {
    render(<Wrapper stackId="alpha"><NotificationsTab /></Wrapper>);
    await waitFor(() => {
      expect(screen.getAllByText(/Global/i).length).toBeGreaterThan(0);
    });
  });

  it("clicking 'Use global instead' on an override calls DELETE /api/notifications/override", async () => {
    const overrideView = JSON.parse(JSON.stringify(baseView));
    overrideView.slack.webhookUrl.source = "override";
    fetchImpl.mockImplementation(async (url: any, init?: any) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/notifications") && method === "GET") {
        return new Response(JSON.stringify(overrideView), { status: 200 });
      }
      if (u.endsWith("/api/notifications/override") && method === "DELETE") {
        return new Response("{}", { status: 200 });
      }
      if (u.endsWith("/api/notifications/email/recipients")) {
        return new Response("[]", { status: 200 });
      }
      if (u.endsWith("/api/notifications/email")) {
        return new Response(JSON.stringify({ enabled: false, recipients: [] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    window.confirm = vi.fn(() => true);
    render(<Wrapper stackId="alpha"><NotificationsTab /></Wrapper>);

    // Wait for the Override chip to appear
    const overrideChip = await screen.findByText(/Override/);
    fireEvent.click(overrideChip);
    fireEvent.click(await screen.findByText(/Use global instead/));

    await waitFor(() => {
      const deleteCalls = fetchImpl.mock.calls.filter(([u, init]: any) =>
        String(u).endsWith("/api/notifications/override") && init?.method === "DELETE"
      );
      expect(deleteCalls.length).toBe(1);
    });
  });

  // Regression: switching the active stack must trigger a refetch with the new X-Stack-Id.
  // Mirrors the pattern shipped in SkillsPage.test.tsx.
  it("refetches /api/notifications when the active stack changes", async () => {
    const { rerender } = render(<Wrapper stackId="alpha"><NotificationsTab /></Wrapper>);

    await waitFor(() => {
      const calls = fetchImpl.mock.calls.filter(([u]: any) =>
        String(u).endsWith("/api/notifications")
      );
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const headers = new Headers((calls[0]![1] as RequestInit | undefined)?.headers);
      expect(headers.get("X-Stack-Id")).toBe("alpha");
    });

    rerender(<Wrapper stackId="beta"><NotificationsTab /></Wrapper>);

    await waitFor(() => {
      const calls = fetchImpl.mock.calls.filter(([u]: any) =>
        String(u).endsWith("/api/notifications")
      );
      const stackIds = calls.map(
        ([, init]: any) => new Headers((init as RequestInit | undefined)?.headers).get("X-Stack-Id"),
      );
      expect(stackIds).toContain("beta");
    });
  });
});
