import { describe, it, expect } from "vitest";
import { deriveStatus } from "./HeaderStatusStrip";
import type { StackSummary } from "../../types/stack-types.js";
import type { HealthPollingResult, HealthStatus } from "./dashboard/useHealthPolling";

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

function makeHealth(
  overrides: Partial<HealthStatus> = {},
  state: HealthPollingResult["connectionState"] = "connected",
): HealthPollingResult {
  return {
    health: {
      status: "healthy",
      uptime: 60,
      version: "0.4.3.1",
      probes: {
        mcp: { status: "ok", latencyMs: 10 },
        db: { status: "ok", latencyMs: 5 },
      },
      lastCheck: new Date().toISOString(),
      ...overrides,
    },
    connectionState: state,
    consecutiveFailures: 0,
  };
}

describe("HeaderStatusStrip.deriveStatus", () => {
  it("reads MCP from the active stack's providerHealth, not the global probe", () => {
    // Regression: pre-fix the strip read health.probes.mcp directly. That probe
    // is global (default-stack only), so switching to a stack with all-dead
    // providers left the indicator showing mcp:ok from the default stack.
    const activeStack = makeStack({ providerHealth: { ok: 0, error: 3, total: 3 } });
    const health = makeHealth(); // global probe still says mcp:ok
    const result = deriveStatus(activeStack, health);
    expect(result.mcpOk).toBe(false);
    expect(result.overall).toBe("degraded");
  });

  it("reports healthy when active stack has at least one connected provider", () => {
    const activeStack = makeStack({ providerHealth: { ok: 2, error: 1, total: 3 } });
    const result = deriveStatus(activeStack, makeHealth());
    expect(result.mcpOk).toBe(true);
    expect(result.overall).toBe("healthy");
  });

  it("treats no-providers-configured as null (not an error)", () => {
    // A stack with zero providers shouldn't flip the strip to degraded — it's
    // an empty config, not an outage.
    const activeStack = makeStack({ providerHealth: { ok: 0, error: 0, total: 0 } });
    const result = deriveStatus(activeStack, makeHealth());
    expect(result.mcpOk).toBeNull();
    expect(result.overall).toBe("healthy");
  });

  it("falls back to global probe when active stack has no providerHealth field yet", () => {
    // Newly-created stack: registry hasn't reported back yet, no providerHealth
    // on the StackSummary. Use the global /api/health probe as a stand-in.
    const activeStack = makeStack({ providerHealth: undefined });
    const result = deriveStatus(activeStack, makeHealth({
      probes: {
        mcp: { status: "error", latencyMs: 0, error: "boom" },
        db: { status: "ok", latencyMs: 5 },
      },
    }));
    expect(result.mcpOk).toBe(false);
    expect(result.overall).toBe("degraded");
  });

  it("reports DB failure as degraded regardless of MCP state", () => {
    const activeStack = makeStack({ providerHealth: { ok: 2, error: 0, total: 2 } });
    const result = deriveStatus(activeStack, makeHealth({
      probes: {
        mcp: { status: "ok", latencyMs: 0 },
        db: { status: "error", latencyMs: 0, error: "locked" },
      },
    }));
    expect(result.dbOk).toBe(false);
    expect(result.overall).toBe("degraded");
  });

  it("reports unreachable when the connection itself is gone", () => {
    const result = deriveStatus(undefined, {
      health: null,
      connectionState: "unreachable",
      consecutiveFailures: 3,
    });
    expect(result.overall).toBe("unreachable");
    expect(result.mcpOk).toBeNull();
    expect(result.dbOk).toBeNull();
  });

  it("reports unknown during initial load (no health data yet)", () => {
    const result = deriveStatus(undefined, {
      health: null,
      connectionState: "unknown",
      consecutiveFailures: 0,
    });
    expect(result.overall).toBe("unknown");
  });
});
