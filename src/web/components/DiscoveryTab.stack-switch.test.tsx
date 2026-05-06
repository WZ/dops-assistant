// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, cleanup } from "@testing-library/react";
import { DiscoveryTab } from "./DiscoveryTab";
import { StackProvider } from "../contexts/StackContext";
import type { ReactNode } from "react";

function Wrapper({ stackId, children }: { stackId: string; children: ReactNode }) {
  return <StackProvider activeStackId={stackId}>{children}</StackProvider>;
}

const settingsBody = { enabled: false, cron: "", timezone: "UTC", consensusRuns: 2, consensusRunsForRemovals: 3 };
const inboxBody = { additions: [], removals: [], counts: { additions: 0, removals: 0, dismissed: 0 } };

describe("DiscoveryTab stack-switch refetch", () => {
  let fetchImpl: any;
  beforeEach(() => {
    fetchImpl = vi.fn(async (url: any) => {
      const u = String(url);
      const body =
        u.includes("/api/discovery/settings") ? settingsBody :
        u.includes("/api/discoveries/runs") ? [] :
        u.endsWith("/api/discoveries") ? inboxBody :
        u.includes("/api/discoveries/mark-viewed") ? { ok: true } :
        { ok: true };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    globalThis.fetch = fetchImpl as any;
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("refetches /api/discovery/settings + /api/discoveries/runs + /api/discoveries when activeStackId changes", async () => {
    const { rerender } = render(<DiscoveryTab />, { wrapper: ({ children }) => <Wrapper stackId="alpha">{children}</Wrapper> });

    await waitFor(() => {
      const initial = fetchImpl.mock.calls.filter(([u]: any) => /\/api\/discover(y|ies)/.test(String(u)));
      expect(initial.length).toBeGreaterThanOrEqual(3);
      const stackIds = new Set(initial.map(([, init]: any) => new Headers(init?.headers).get("X-Stack-Id")));
      expect([...stackIds]).toEqual(["alpha"]);
    });

    rerender(<Wrapper stackId="beta"><DiscoveryTab /></Wrapper>);

    await waitFor(() => {
      const all = fetchImpl.mock.calls.filter(([u]: any) => /\/api\/discover(y|ies)/.test(String(u)));
      const stackIds = new Set(all.map(([, init]: any) => new Headers(init?.headers).get("X-Stack-Id")));
      expect(stackIds.has("beta")).toBe(true);
      // Specifically confirm /api/discovery/settings was hit with X-Stack-Id: beta
      const settingsBetaCalls = all.filter(([u, init]: any) =>
        String(u).endsWith("/api/discovery/settings") &&
        new Headers(init?.headers).get("X-Stack-Id") === "beta"
      );
      expect(settingsBetaCalls.length).toBeGreaterThanOrEqual(1);
    });
  });
});
