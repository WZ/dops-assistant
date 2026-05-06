// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SkillsPage } from "./SkillsPage";
import { StackProvider } from "../contexts/StackContext";

function Wrapper({ stackId, children }: { stackId: string; children: ReactNode }) {
  return <StackProvider activeStackId={stackId}>{children}</StackProvider>;
}

function deferredJson(body: unknown) {
  let resolve!: () => void;
  const promise = new Promise<Response>((r) => {
    resolve = () => r(new Response(JSON.stringify(body), { status: 200 }));
  });
  return { promise, resolve };
}

describe("SkillsPage", () => {
  const originalFetch = global.fetch;
  let fetchImpl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchImpl = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    global.fetch = fetchImpl as unknown as typeof global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  // Regression: switching the active stack must trigger a refetch so the panel
  // shows skills for the newly selected stack instead of stale data from the
  // previous one. Before the fix, the useEffect had an empty deps array.
  it("refetches /api/skills when the active stack changes", async () => {
    const { rerender } = render(
      <Wrapper stackId="alpha">
        <SkillsPage />
      </Wrapper>,
    );

    await waitFor(() => {
      const calls = fetchImpl.mock.calls.filter(([url]) =>
        String(url).endsWith("/api/skills"),
      );
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const headers = new Headers((calls[0]![1] as RequestInit | undefined)?.headers);
      expect(headers.get("X-Stack-Id")).toBe("alpha");
    });

    rerender(
      <Wrapper stackId="beta">
        <SkillsPage />
      </Wrapper>,
    );

    await waitFor(() => {
      const calls = fetchImpl.mock.calls.filter(([url]) =>
        String(url).endsWith("/api/skills"),
      );
      const stackIds = calls.map(
        ([, init]) => new Headers((init as RequestInit | undefined)?.headers).get("X-Stack-Id"),
      );
      expect(stackIds).toContain("beta");
    });
  });

  it("keeps newer stack skills when an older stack response resolves later", async () => {
    const alpha = deferredJson([
      { id: "alpha-skill", title: "Alpha Skill", services: [], alerts: [], tags: [] },
    ]);
    const beta = deferredJson([
      { id: "beta-skill", title: "Beta Skill", services: [], alerts: [], tags: [] },
    ]);
    fetchImpl.mockImplementation((url, init) => {
      const stackId = new Headers((init as RequestInit | undefined)?.headers).get("X-Stack-Id");
      if (String(url).endsWith("/api/skills") && stackId === "alpha") return alpha.promise;
      if (String(url).endsWith("/api/skills") && stackId === "beta") return beta.promise;
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    });

    const { rerender } = render(
      <Wrapper stackId="alpha">
        <SkillsPage />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(fetchImpl.mock.calls.some(([, init]) =>
        new Headers((init as RequestInit | undefined)?.headers).get("X-Stack-Id") === "alpha",
      )).toBe(true);
    });

    rerender(
      <Wrapper stackId="beta">
        <SkillsPage />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(fetchImpl.mock.calls.some(([, init]) =>
        new Headers((init as RequestInit | undefined)?.headers).get("X-Stack-Id") === "beta",
      )).toBe(true);
    });

    await act(async () => {
      beta.resolve();
      await beta.promise;
    });
    await screen.findByText("Beta Skill");

    await act(async () => {
      alpha.resolve();
      await alpha.promise;
    });
    await waitFor(() => {
      expect(screen.queryByText("Alpha Skill")).toBeNull();
      expect(screen.getByText("Beta Skill")).toBeTruthy();
    });
  });
});
