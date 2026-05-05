// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { DiscoveryTab } from "./DiscoveryTab";
import { DiscoveriesPage } from "./DiscoveriesPage";
import { StackProvider } from "../contexts/StackContext";
import type { ReactNode } from "react";

function Wrapper({ children }: { children: ReactNode }) {
  return <StackProvider activeStackId="test-stack">{children}</StackProvider>;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("DiscoveryTab", () => {
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("uses the browser timezone when the API returns the built-in default settings", async () => {
    vi.spyOn(Intl, "DateTimeFormat").mockReturnValue({
      resolvedOptions: () => ({ timeZone: "America/Los_Angeles" }),
    } as Intl.DateTimeFormat);

    globalThis.fetch = vi.fn((url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/discovery/settings")) {
        return Promise.resolve(jsonResponse({
          enabled: false,
          cron: "",
          timezone: "UTC",
          consensusRuns: 2,
          consensusRunsForRemovals: 3,
        }));
      }
      if (u.includes("/api/discoveries/runs")) {
        return Promise.resolve(jsonResponse([]));
      }
      if (u.endsWith("/api/discoveries")) {
        return Promise.resolve(jsonResponse({
          additions: [],
          removals: [],
          counts: { additions: 0, removals: 0, dismissed: 0 },
        }));
      }
      if (u.includes("/api/discoveries/mark-viewed")) {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });

    render(<DiscoveryTab />, { wrapper: Wrapper });

    const textboxes = await screen.findAllByRole("textbox");
    const timezone = textboxes[1] as HTMLInputElement;
    expect(timezone.value).toBe("America/Los_Angeles");
  });
});

describe("DiscoveriesPage", () => {
  beforeEach(() => {
    cleanup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("surfaces bulk dismiss failures for non-OK responses", async () => {
    globalThis.fetch = vi.fn((url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      if (u.endsWith("/api/discoveries") && method === "GET") {
        return Promise.resolve(jsonResponse({
          additions: [
            {
              id: "add-1",
              serviceName: "payments-api",
              changeKind: "addition",
              firstSeenAt: "2026-05-05T12:00:00.000Z",
              seenCount: 2,
              qualifiedAt: "2026-05-05T12:00:00.000Z",
              payload: null,
            },
            {
              id: "add-2",
              serviceName: "checkout-api",
              changeKind: "addition",
              firstSeenAt: "2026-05-05T12:00:00.000Z",
              seenCount: 2,
              qualifiedAt: "2026-05-05T12:00:00.000Z",
              payload: null,
            },
          ],
          removals: [],
          counts: { additions: 2, removals: 0, dismissed: 0 },
        }));
      }
      if (u.includes("/api/discoveries/mark-viewed")) {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (u.includes("/api/discoveries/add-1/dismiss")) {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (u.includes("/api/discoveries/add-2/dismiss")) {
        return Promise.resolve(jsonResponse({ error: "failed" }, { status: 500 }));
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });

    render(<DiscoveriesPage embedded />, { wrapper: Wrapper });

    fireEvent.click(await screen.findByRole("button", { name: "Dismiss all (2)" }));

    await waitFor(() => {
      expect(screen.getByText("1 of 2 dismissals failed.")).toBeTruthy();
    });
  });
});
