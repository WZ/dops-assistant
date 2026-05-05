// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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

  it("renders chips reflecting recipient scope", async () => {
    render(
      <Wrapper>
        <EmailRecipientsSection
          stackFetch={makeStackFetch("alpha")}
          onOpenEditor={() => {}}
          activeStackName="alpha"
        />
      </Wrapper>,
    );
    await waitFor(() => {
      // Both addresses render
      expect(screen.getByText("g@example.com")).toBeDefined();
      expect(screen.getByText("p@example.com")).toBeDefined();
      // At least one Global chip and one stack chip
      expect(screen.getAllByText(/Global/i).length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText(/stack:/i).length).toBeGreaterThanOrEqual(1);
    });
  });

  it("re-scoping a global recipient PUTs with scope=stack", async () => {
    render(
      <Wrapper>
        <EmailRecipientsSection
          stackFetch={makeStackFetch("alpha")}
          onOpenEditor={() => {}}
          activeStackName="alpha"
        />
      </Wrapper>,
    );

    await waitFor(() => screen.getByText("g@example.com"));

    // Click the Global chip on the first row to open its menu, then "Pin to alpha"
    const chips = screen.getAllByText(/Global/i);
    // The first/last "Global" text on the page is the row 1 chip — click whichever is the chip button
    // (skip the section header banner which also says "Global"). Use the chip's button role.
    // Strategy: find a button whose text is exactly "Global"; that's the chip's clickable button.
    const globalChipButtons = screen.getAllByRole("button").filter(
      (btn) => /^Global$/.test(btn.textContent?.trim() ?? "") || /Global/.test(btn.textContent ?? "")
    );
    // Click the Global chip belonging to the row — it's adjacent to the row's address text.
    // Easier: chip button is the button with "Global" text inside <li> containing g@example.com.
    const globalChip = globalChipButtons.find((btn) => btn.textContent?.trim() === "Global");
    expect(globalChip).toBeDefined();
    fireEvent.click(globalChip!);

    // Then click the "Pin to alpha" option
    fireEvent.click(await screen.findByText(/Pin to alpha/));

    await waitFor(() => {
      const puts = fetchImpl.mock.calls.filter(([u, init]: any) =>
        String(u).match(/\/api\/notifications\/email\/recipients\/1$/) && init?.method === "PUT"
      );
      expect(puts.length).toBe(1);
      expect(JSON.parse(puts[0][1].body)).toMatchObject({ scope: "stack" });
    });
  });
});
