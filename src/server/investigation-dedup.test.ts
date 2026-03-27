import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InvestigationDedup } from "./investigation-dedup.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const S = "test-stack"; // default stackId for all tests

function makeDedup(dedupWindowSeconds = 300, maxConcurrent = 3): InvestigationDedup {
  return new InvestigationDedup({ dedupWindowSeconds, maxConcurrent });
}

// ── shouldInvestigate ─────────────────────────────────────────────────────────

describe("InvestigationDedup.shouldInvestigate", () => {
  it("returns true for a never-seen service", () => {
    const dedup = makeDedup();
    expect(dedup.shouldInvestigate(S, "my-service")).toBe(true);
  });

  it("returns false for a service within the dedup window", () => {
    const dedup = makeDedup(300, 3);
    dedup.markStarted(S, "my-service");
    // Same service — should be suppressed
    expect(dedup.shouldInvestigate(S, "my-service")).toBe(false);
  });

  it("returns true for a service after the dedup window has expired", () => {
    vi.useFakeTimers();
    const dedup = makeDedup(60, 3); // 60s window
    dedup.markStarted(S, "my-service");
    dedup.markCompleted();

    // Advance time past the window
    vi.advanceTimersByTime(61_000);

    expect(dedup.shouldInvestigate(S, "my-service")).toBe(true);
    vi.useRealTimers();
  });

  it("returns false when maxConcurrent is reached", () => {
    const dedup = makeDedup(300, 2); // max 2 concurrent
    dedup.markStarted(S, "service-a");
    dedup.markStarted(S, "service-b");

    // Both slots occupied — a new (unseen) service should be denied
    expect(dedup.shouldInvestigate(S, "service-c")).toBe(false);
  });

  it("returns true once an active slot is freed", () => {
    const dedup = makeDedup(300, 1); // max 1 concurrent
    dedup.markStarted(S, "service-a");
    expect(dedup.shouldInvestigate(S, "service-b")).toBe(false);

    dedup.markCompleted();
    expect(dedup.shouldInvestigate(S, "service-b")).toBe(true);
  });

  it("treats different services independently within the dedup window", () => {
    const dedup = makeDedup(300, 10);
    dedup.markStarted(S, "service-a");

    // service-b was never started — should be allowed
    expect(dedup.shouldInvestigate(S, "service-b")).toBe(true);
  });

  it("isolates dedup by stackId", () => {
    const dedup = makeDedup(300, 10);
    dedup.markStarted("stack-a", "my-service");

    // Same service on a different stack — should be allowed
    expect(dedup.shouldInvestigate("stack-b", "my-service")).toBe(true);
    // Same service on the same stack — should be suppressed
    expect(dedup.shouldInvestigate("stack-a", "my-service")).toBe(false);
  });
});

// ── markStarted / markCompleted ───────────────────────────────────────────────

describe("InvestigationDedup.markStarted + markCompleted", () => {
  it("increments and decrements activeCount correctly", () => {
    const dedup = makeDedup();
    expect(dedup.getActiveCount()).toBe(0);

    dedup.markStarted(S, "svc-a");
    expect(dedup.getActiveCount()).toBe(1);

    dedup.markStarted(S, "svc-b");
    expect(dedup.getActiveCount()).toBe(2);

    dedup.markCompleted();
    expect(dedup.getActiveCount()).toBe(1);

    dedup.markCompleted();
    expect(dedup.getActiveCount()).toBe(0);
  });

  it("does not go below 0 on excess markCompleted calls", () => {
    const dedup = makeDedup();
    dedup.markCompleted(); // called without a prior markStarted
    expect(dedup.getActiveCount()).toBe(0);
  });
});

// ── dedup window expiry ───────────────────────────────────────────────────────

describe("InvestigationDedup dedup window expiry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("cleans expired entries and allows re-investigation", () => {
    const dedup = makeDedup(10, 5); // 10s window
    dedup.markStarted(S, "api");
    dedup.markCompleted();

    // Still within window
    vi.advanceTimersByTime(5_000);
    expect(dedup.shouldInvestigate(S, "api")).toBe(false);

    // Past the window
    vi.advanceTimersByTime(6_000); // total 11s
    expect(dedup.shouldInvestigate(S, "api")).toBe(true);
  });

  it("does not clean entries that are still within the window", () => {
    const dedup = makeDedup(300, 5);
    dedup.markStarted(S, "api");
    dedup.markCompleted();

    vi.advanceTimersByTime(100_000); // 100s — still within 300s window
    expect(dedup.shouldInvestigate(S, "api")).toBe(false);
  });
});

// ── edge cases ────────────────────────────────────────────────────────────────

describe("InvestigationDedup edge cases", () => {
  it("maxConcurrent=0 always denies", () => {
    const dedup = makeDedup(300, 0);
    expect(dedup.shouldInvestigate(S, "any-service")).toBe(false);
  });

  it("dedupWindowSeconds=0 never deduplicates by time (relies only on concurrency)", () => {
    const dedup = makeDedup(0, 5);
    dedup.markStarted(S, "api");
    dedup.markCompleted();
    // With 0s window, the entry expires immediately — next shouldInvestigate sees clean slate
    expect(dedup.shouldInvestigate(S, "api")).toBe(true);
  });

  it("multiple services tracked independently", () => {
    const dedup = makeDedup(300, 10);
    dedup.markStarted(S, "svc-a");
    dedup.markStarted(S, "svc-b");

    expect(dedup.shouldInvestigate(S, "svc-a")).toBe(false);
    expect(dedup.shouldInvestigate(S, "svc-b")).toBe(false);
    expect(dedup.shouldInvestigate(S, "svc-c")).toBe(true);
  });
});
