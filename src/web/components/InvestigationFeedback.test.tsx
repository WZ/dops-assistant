// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { InvestigationFeedback } from "./InvestigationFeedback";
import { StackProvider } from "../contexts/StackContext";
import type { ReactNode } from "react";

function Wrapper({ children }: { children: ReactNode }) {
  return <StackProvider activeStackId="test-stack">{children}</StackProvider>;
}

/**
 * Build a fetch mock that routes by URL + method. Each test supplies the
 * initial GET rating and the POST response; calls are recorded so assertions
 * can verify what the UI sent.
 */
function mockFetch(opts: {
  initialRating?: "useful" | "not_useful" | null;
  initialReVerified?: boolean | null;
  postFails?: boolean;
} = {}) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fn = vi.fn((url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({
      url: u,
      method,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    if (method === "GET") {
      if (u.includes("/reverify")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ reVerified: opts.initialReVerified ?? null }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ rating: opts.initialRating ?? null }),
      });
    }
    if (opts.postFails) {
      return Promise.resolve({
        ok: false,
        status: 500,
        text: () => Promise.resolve("server on fire"),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
  });
  return { fn, calls };
}

describe("InvestigationFeedback", () => {
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("mounts, fetches current rating (null), shows neutral buttons", async () => {
    const { fn } = mockFetch({ initialRating: null });
    globalThis.fetch = fn;

    render(<InvestigationFeedback investigationId="inv_1" />, { wrapper: Wrapper });

    const thumbs = await screen.findByLabelText("Mark as useful");
    expect(thumbs.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByText(/Thanks/)).toBeNull();
  });

  it("mounts with existing rating and reflects it in aria-pressed", async () => {
    const { fn } = mockFetch({ initialRating: "useful" });
    globalThis.fetch = fn;

    render(<InvestigationFeedback investigationId="inv_1" />, { wrapper: Wrapper });

    await waitFor(() => {
      const thumbs = screen.getByLabelText("Mark as useful");
      expect(thumbs.getAttribute("aria-pressed")).toBe("true");
    });
    expect(screen.getByText(/feeds the pattern learner/)).toBeTruthy();
  });

  it("clicking thumbs-up posts with rating=useful and flips optimistically", async () => {
    const { fn, calls } = mockFetch({ initialRating: null });
    globalThis.fetch = fn;

    render(<InvestigationFeedback investigationId="inv_1" />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(calls.find((c) => c.method === "GET")).toBeDefined();
    });

    fireEvent.click(screen.getByLabelText("Mark as useful"));

    await waitFor(() => {
      const thumbs = screen.getByLabelText("Mark as useful");
      expect(thumbs.getAttribute("aria-pressed")).toBe("true");
    });

    const post = calls.find((c) => c.method === "POST");
    expect(post).toBeDefined();
    expect(post?.url).toContain("/api/investigations/inv_1/feedback");
    expect(post?.body).toEqual({ rating: "useful" });
  });

  it("clicking thumbs-down when already useful flips the rating + pattern not re-extracted (server-side idempotency, UI just shows the new state)", async () => {
    const { fn, calls } = mockFetch({ initialRating: "useful" });
    globalThis.fetch = fn;

    render(<InvestigationFeedback investigationId="inv_1" />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByLabelText("Mark as useful").getAttribute("aria-pressed")).toBe("true");
    });

    fireEvent.click(screen.getByLabelText("Mark as not useful"));

    await waitFor(() => {
      expect(screen.getByLabelText("Mark as not useful").getAttribute("aria-pressed")).toBe("true");
      expect(screen.getByLabelText("Mark as useful").getAttribute("aria-pressed")).toBe("false");
    });
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({ rating: "not_useful" });
  });

  it("rolls back optimistic state and surfaces an error when POST fails", async () => {
    const { fn } = mockFetch({ initialRating: null, postFails: true });
    globalThis.fetch = fn;

    render(<InvestigationFeedback investigationId="inv_1" />, { wrapper: Wrapper });

    // Wait for initial GET to settle before we click.
    await waitFor(() => {
      expect(screen.getByLabelText("Mark as useful").getAttribute("aria-pressed")).toBe("false");
    });

    fireEvent.click(screen.getByLabelText("Mark as useful"));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    // Rolled back: button returned to neutral.
    expect(screen.getByLabelText("Mark as useful").getAttribute("aria-pressed")).toBe("false");
  });

  it("clicking a re-verify answer posts reVerified independently of the rating", async () => {
    const { fn, calls } = mockFetch({ initialRating: null, initialReVerified: null });
    globalThis.fetch = fn;

    render(<InvestigationFeedback investigationId="inv_1" />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(calls.some((c) => c.method === "GET" && c.url.includes("/reverify"))).toBe(true);
    });

    fireEvent.click(screen.getByLabelText("Yes, I re-checked in Grafana"));

    await waitFor(() => {
      expect(screen.getByLabelText("Yes, I re-checked in Grafana").getAttribute("aria-pressed")).toBe("true");
    });
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/reverify"));
    expect(post).toBeDefined();
    expect(post?.url).toContain("/api/investigations/inv_1/reverify");
    expect(post?.body).toEqual({ reVerified: true });
    // No rating was posted — the two signals are independent.
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/feedback"))).toBe(false);
  });

  it("reflects an existing re-verify signal in aria-pressed on mount", async () => {
    const { fn } = mockFetch({ initialReVerified: true });
    globalThis.fetch = fn;

    render(<InvestigationFeedback investigationId="inv_1" />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByLabelText("Yes, I re-checked in Grafana").getAttribute("aria-pressed")).toBe("true");
    });
  });

  it("a failed rating does not disable the re-verify control (state is per-instrument)", async () => {
    const { fn } = mockFetch({ initialRating: null, postFails: true });
    globalThis.fetch = fn;

    render(<InvestigationFeedback investigationId="inv_1" />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByLabelText("Mark as useful").getAttribute("aria-pressed")).toBe("false");
    });

    fireEvent.click(screen.getByLabelText("Mark as useful"));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy(); // rating error surfaced
    });
    // The re-verify buttons remain usable — the failure was isolated to rating.
    expect((screen.getByLabelText("Yes, I re-checked in Grafana") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByLabelText("No, I trusted the report") as HTMLButtonElement).disabled).toBe(false);
  });
});
