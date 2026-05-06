// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { EmailRecipientsSection } from "./EmailRecipientsSection";
import { StackProvider } from "../contexts/StackContext";

function Wrapper({ children, stackId = "alpha" }: { children: ReactNode; stackId?: string }) {
  return <StackProvider activeStackId={stackId}>{children}</StackProvider>;
}

const recipients = [
  {
    id: 1, address: "g@example.com", minSeverity: "high", allowedSources: ["scan"],
    enabled: true, stackId: null, scope: "global",
  },
  {
    id: 2, address: "p@example.com", minSeverity: "high", allowedSources: ["scan"],
    enabled: true, stackId: "alpha", scope: "stack",
  },
];

describe("EmailRecipientsSection", () => {
  const originalFetch = global.fetch;
  let fetchImpl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchImpl = vi.fn(async (url: any, init?: any) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/notifications/email") && method === "GET") {
        return new Response(JSON.stringify({ enabled: true, recipients }), { status: 200 });
      }
      if (u.match(/\/api\/notifications\/email\/recipients\/\d+$/) && method === "PUT") {
        return new Response(JSON.stringify({ ...recipients[0], stackId: "alpha", scope: "stack" }), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    });
    global.fetch = fetchImpl as any;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  function makeStackFetch(activeStackId: string) {
    return async (path: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("X-Stack-Id", activeStackId);
      return fetch(path, { ...init, headers });
    };
  }

  it("shows inline 'stack:' label only on stack-pinned rows; global rows show no scope marker", async () => {
    const { container } = render(
      <Wrapper>
        <EmailRecipientsSection
          stackFetch={makeStackFetch("alpha")}
          onOpenEditor={() => {}}
          activeStackName="alpha"
        />
      </Wrapper>,
    );
    await waitFor(() => {
      expect(screen.getByText("g@example.com")).toBeDefined();
      expect(screen.getByText("p@example.com")).toBeDefined();
    });

    // Pinned row shows the inline "stack: alpha" indicator
    expect(screen.getAllByText(/stack: alpha/).length).toBeGreaterThanOrEqual(1);

    // Global row (g@example.com) should not have any scope marker — find its <li>
    // and verify it contains neither "stack:" nor "Global" text.
    const globalLi = container.querySelector('li[aria-label="Edit g@example.com"]');
    expect(globalLi).not.toBeNull();
    expect(globalLi!.textContent ?? "").not.toMatch(/stack:/);
    expect(globalLi!.textContent ?? "").not.toMatch(/Global/);
  });
});
