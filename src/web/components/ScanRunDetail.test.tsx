// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { ScanRunDetail } from "./ScanRunDetail";
import { StackProvider } from "../contexts/StackContext";
import type { ReactNode } from "react";

function Wrapper({ children }: { children: ReactNode }) {
  return <StackProvider activeStackId="test-stack">{children}</StackProvider>;
}

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run_1",
    stackId: "test-stack",
    trigger: "manual" as const,
    status: "complete" as const,
    skipReason: null,
    startedAt: Date.parse("2026-04-23T12:00:00Z"),
    finishedAt: Date.parse("2026-04-23T12:00:15Z"),
    servicesProbed: 3,
    rulesApplied: 9,
    queriesExecuted: 27,
    probeErrors: 0,
    queriesEmpty: 0,
    probeDurationMs: 1200,
    probeDetailJson: null,
    hitsRaw: 0,
    hitsAfterDedup: 0,
    hitsDispatched: 0,
    droppedByCap: 0,
    triageDetailJson: null,
    errorMessage: null,
    createdAt: Date.parse("2026-04-23T12:00:00Z"),
    ...overrides,
  };
}

function mockFetch(opts: {
  run?: Record<string, unknown>;
  investigations?: unknown[];
  status?: number;
  body?: { expectedStackId?: string; error?: string };
}) {
  return vi.fn((url: string | URL) => {
    const u = String(url);
    if (u.includes("/api/scan/runs/")) {
      if (opts.status && opts.status >= 400) {
        return Promise.resolve({
          ok: false,
          status: opts.status,
          statusText: opts.body?.error ?? "Error",
          json: () => Promise.resolve(opts.body ?? {}),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          run: opts.run ?? makeRun(),
          investigations: opts.investigations ?? [],
        }),
      });
    }
    throw new Error(`Unexpected fetch: ${u}`);
  });
}

describe("ScanRunDetail — back button", () => {
  beforeEach(() => {
    cleanup();
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the back button in the loading state and fires onBack when clicked", () => {
    // Loading state renders through ScanRunShell immediately — no fetch has
    // resolved yet. This is the shell we'd regress to the old layout if the
    // wrapper ever got ripped out again.
    globalThis.fetch = mockFetch({}); // will resolve, but we assert pre-resolve
    const onBack = vi.fn();
    render(
      <ScanRunDetail runId="run_1" onBack={onBack} />,
      { wrapper: Wrapper },
    );
    const btn = screen.getByRole("button", { name: /back/i });
    fireEvent.click(btn);
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("renders the back button after data loads (success path) and fires onBack", async () => {
    globalThis.fetch = mockFetch({ run: makeRun({ status: "complete" }) });
    const onBack = vi.fn();
    render(
      <ScanRunDetail runId="run_1" onBack={onBack} />,
      { wrapper: Wrapper },
    );
    await waitFor(() => {
      // Probe card only renders after load — use it as a signal that the
      // component moved past the loading shell.
      expect(screen.getByText(/Probe/)).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("renders the back button on 404 (scan not found) and fires onBack", async () => {
    globalThis.fetch = mockFetch({ status: 404, body: { error: "not found" } });
    const onBack = vi.fn();
    render(
      <ScanRunDetail runId="run_ghost" onBack={onBack} />,
      { wrapper: Wrapper },
    );
    await waitFor(() => {
      expect(screen.getByText(/Scan run not found/)).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("renders the back button on 404+stack-mismatch and fires onBack", async () => {
    globalThis.fetch = mockFetch({
      status: 404,
      body: { expectedStackId: "other-stack", error: "wrong stack" },
    });
    const onBack = vi.fn();
    render(
      <ScanRunDetail runId="run_1" onBack={onBack} onSwitchStack={vi.fn()} />,
      { wrapper: Wrapper },
    );
    await waitFor(() => {
      expect(screen.getByText(/different stack/)).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(onBack).toHaveBeenCalledOnce();
  });
});

describe("ScanRunDetail — status dot", () => {
  beforeEach(() => {
    cleanup();
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // Header status dot encodes run.status via statusDotClass(). Lock in the
  // mapping so a future refactor doesn't silently flip "failed" to green or
  // "running" to static.
  it.each([
    ["complete", "bg-success"],
    ["running", "bg-primary"],
    ["failed", "bg-destructive"],
    ["skipped", "bg-muted-foreground/40"],
  ] as const)("status=%s → dot includes %s", async (status, expectedClass) => {
    globalThis.fetch = mockFetch({ run: makeRun({ status }) });
    const { container } = render(
      <ScanRunDetail runId="run_1" onBack={vi.fn()} />,
      { wrapper: Wrapper },
    );
    await waitFor(() => {
      expect(screen.getByText(/Probe/)).toBeTruthy();
    });
    // First `rounded-full` div in the header is the status dot (the phase
    // stepper dots live below in the left rail).
    const dot = container.querySelector("div.w-2.h-2.rounded-full");
    expect(dot).toBeTruthy();
    expect(dot!.className).toContain(expectedClass);
  });
});
