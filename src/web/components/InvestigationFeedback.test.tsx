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
});
