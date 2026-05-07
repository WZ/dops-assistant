import { describe, it, expect } from "vitest";
import { providerBadge, healthDotColor } from "./StackSwitcher";
import type { StackSummary } from "../../types/stack-types.js";

function makeStack(overrides: Partial<StackSummary> = {}): StackSummary {
  return {
    id: "s",
    name: "Stack",
    slug: "stack",
    isDefault: false,
    providerCount: 3,
    createdAt: "2026-01-01T00:00:00Z",
    status: "active",
    ...overrides,
  };
}

describe("StackSwitcher.providerBadge", () => {
  it("falls back to raw `Np` count when providerHealth is missing", () => {
    const s = makeStack({ providerCount: 2 });
    expect(providerBadge(s)).toEqual({ text: "2p", tone: "muted" });
  });

  it("renders 0/Np in destructive tone when every provider is dead", () => {
    const s = makeStack({ providerHealth: { ok: 0, error: 3, total: 3 } });
    expect(providerBadge(s)).toEqual({ text: "0/3p", tone: "destructive" });
  });

  it("renders X/Np in warning tone for partial outages", () => {
    const s = makeStack({ providerHealth: { ok: 2, error: 1, total: 3 } });
    expect(providerBadge(s)).toEqual({ text: "2/3p", tone: "warning" });
  });

  it("keeps the badge muted when every provider is healthy", () => {
    const s = makeStack({ providerHealth: { ok: 3, error: 0, total: 3 } });
    expect(providerBadge(s)).toEqual({ text: "3p", tone: "muted" });
  });
});

describe("StackSwitcher.healthDotColor", () => {
  it("turns destructive when all MCP providers are down even if no service health is present", () => {
    // Regression for the case where the provider fleet is dead but the
    // service health poller hasn't reported anything yet — pre-fix, the
    // dot stayed green/gray and hid the outage.
    const s = makeStack({ providerHealth: { ok: 0, error: 3, total: 3 } });
    expect(healthDotColor(s)).toBe("bg-destructive");
  });

  it("uses service health when MCP providers are fine", () => {
    const s = makeStack({
      providerHealth: { ok: 3, error: 0, total: 3 },
      healthSummary: { healthy: 5, degraded: 0, down: 0, unknown: 0, total: 5 },
    });
    expect(healthDotColor(s)).toBe("bg-success");
  });

  it("warning when services are degraded", () => {
    const s = makeStack({
      providerHealth: { ok: 3, error: 0, total: 3 },
      healthSummary: { healthy: 3, degraded: 2, down: 0, unknown: 0, total: 5 },
    });
    expect(healthDotColor(s)).toBe("bg-warning");
  });

  it("destructive when any service is down", () => {
    const s = makeStack({
      providerHealth: { ok: 3, error: 0, total: 3 },
      healthSummary: { healthy: 3, degraded: 0, down: 1, unknown: 0, total: 4 },
    });
    expect(healthDotColor(s)).toBe("bg-destructive");
  });

  it("muted when there is no health data at all", () => {
    const s = makeStack();
    expect(healthDotColor(s)).toBe("bg-muted-foreground/30");
  });
});
