// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { EmailRecipientsSection } from "./EmailRecipientsSection";
import { StackProvider } from "../contexts/StackContext";
import type { ReactNode } from "react";

function Wrapper({ children }: { children: ReactNode }) {
  return <StackProvider activeStackId="alpha">{children}</StackProvider>;
}

const recipients = [{
  id: 1,
  address: "g@example.com",
  minSeverity: "high",
  allowedSources: ["scan"],
  enabled: true,
}];

describe("EmailRecipientsSection", () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.endsWith("/api/notifications/email")) {
        return new Response(JSON.stringify({ enabled: true, recipients }), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    }) as any;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("renders recipients", async () => {
    const stackFetch = (path: string, init?: RequestInit) => fetch(path, init);
    render(<Wrapper><EmailRecipientsSection stackFetch={stackFetch} onOpenEditor={() => {}} /></Wrapper>);
    await waitFor(() => expect(screen.getByText("g@example.com")).toBeDefined());
  });
});
