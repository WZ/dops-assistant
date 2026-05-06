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

  it("shows tab-level [Global] chip when all sources are global/default/config", async () => {
    render(<Wrapper stackId="alpha"><NotificationsTab /></Wrapper>);
    await waitFor(() => {
      expect(screen.getAllByText(/Global/i).length).toBeGreaterThan(0);
    });
    // No per-field "Override" chip should appear when everything is global
    expect(screen.queryByText(/^Override$/)).toBeNull();
  });

  it("clicking 'Reset all to global' on the tab-level chip calls DELETE /api/notifications/override", async () => {
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

    // With one source overridden out of four, the tab chip shows "Mixed (1)"
    const mixedChip = await screen.findByText(/Mixed \(1\)/);
    fireEvent.click(mixedChip);
    fireEvent.click(await screen.findByText(/Reset all to global/));

    await waitFor(() => {
      const deleteCalls = fetchImpl.mock.calls.filter(([u, init]: any) =>
        String(u).endsWith("/api/notifications/override") && init?.method === "DELETE"
      );
      expect(deleteCalls.length).toBe(1);
    });
  });

  it("flips into global-edit mode via chip menu and PUTs to /api/notifications/global", async () => {
    fetchImpl.mockImplementation(async (url: any, init?: any) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/notifications") && method === "GET") {
        return new Response(JSON.stringify(baseView), { status: 200 });
      }
      if (u.endsWith("/api/notifications/global") && method === "PUT") {
        return new Response("{}", { status: 200 });
      }
      if (u.endsWith("/api/notifications") && method === "PUT") {
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

    render(<Wrapper stackId="alpha"><NotificationsTab /></Wrapper>);

    // Wait for the initial chip ("Global") to render
    const chip = await screen.findByRole("button", { name: /Global/ });
    fireEvent.click(chip);

    // Click "Edit global defaults…"
    const editGlobal = await screen.findByText(/Edit global defaults/);
    fireEvent.click(editGlobal);

    // Banner copy now reads "Editing global defaults"
    await waitFor(() => {
      expect(screen.getByText(/Editing global defaults/i)).toBeDefined();
    });

    // Toggle slack enabled — should hit /api/notifications/global
    // Slack toggle is the first switch in the rendered output (Email enabled is second).
    const slackToggle = screen.getAllByRole("switch")[0]!;
    fireEvent.click(slackToggle);

    await waitFor(() => {
      const globalPuts = fetchImpl.mock.calls.filter(([u, init]: any) =>
        String(u).endsWith("/api/notifications/global") && init?.method === "PUT"
      );
      expect(globalPuts.length).toBe(1);
      // Make sure we didn't accidentally hit the per-stack path
      const stackPuts = fetchImpl.mock.calls.filter(([u, init]: any) =>
        String(u).endsWith("/api/notifications") && init?.method === "PUT"
      );
      expect(stackPuts.length).toBe(0);
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
