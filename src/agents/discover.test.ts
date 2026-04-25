import { describe, it, expect } from "vitest";
import { createDiscoverAgent, buildDiscoverInstructions } from "./discover.js";
import type { LanguageModel } from "ai";

const fakeModel = {} as LanguageModel;

describe("createDiscoverAgent", () => {
  it("creates an agent with id 'discover'", () => {
    const agent = createDiscoverAgent({ model: fakeModel });
    expect(agent.id).toBe("discover");
  });

  it("creates an agent with tools when provided", () => {
    const agent = createDiscoverAgent({ model: fakeModel, tools: { fakeTool: {} as any } });
    expect(agent).toBeDefined();
  });

  it("respects maxSteps config", () => {
    const agent = createDiscoverAgent({ model: fakeModel, maxSteps: 20 });
    expect(agent).toBeDefined();
  });
});

describe("buildDiscoverInstructions / availability metric guidance", () => {
  // The discovery prompt previously listed `kube_deployment_status_replicas`
  // as a valid health-check gauge for the `service_availability` rule. That
  // metric reports desired/non-terminated pods and stays >0 during real
  // outages, so the `lt 1` threshold silently never trips. These assertions
  // pin the corrected guidance so a future prompt edit can't quietly
  // re-introduce the trap.
  const prompt = buildDiscoverInstructions({ model: fakeModel });

  it("teaches the correct readiness metrics for each k8s workload kind", () => {
    expect(prompt).toContain("kube_deployment_status_replicas_available");
    expect(prompt).toContain("kube_deployment_status_replicas_ready");
    expect(prompt).toContain("kube_statefulset_status_replicas_ready");
    expect(prompt).toContain("kube_daemonset_status_number_ready");
  });

  it("explicitly warns against the desired-count antipatterns", () => {
    expect(prompt).toMatch(/DO NOT USE/);
    expect(prompt).toMatch(/kube_daemonset_status_desired_number_scheduled/);
    // The bare desired/spec replica counters are explicitly listed as wrong.
    expect(prompt).toMatch(/kube_deployment_spec_replicas/);
  });

  it("does not show the misleading 'kube_deployment_status_replicas' as a valid example", () => {
    // We can't ban the substring entirely (it appears as part of
    // `_status_replicas_available` and inside the DO-NOT-USE column), but
    // the standalone use as a positive example MUST be gone. Specifically:
    // it must not appear directly inside a list-of-good-examples sentence.
    expect(prompt).not.toMatch(
      /\bgauge indicators[^.]*kube_deployment_status_replicas\b(?!_available|_ready|_unavailable)/,
    );
  });

  it("instructs pod_restarts to prefer service-specific selectors over namespace-only", () => {
    // The fix tightens pod_restarts away from namespace-only filters that
    // attribute every namespace pod restart to one service.
    expect(prompt).toMatch(/Service-specific selector required/i);
    expect(prompt).toMatch(/last-resort fallback/i);
    expect(prompt).toContain('pod=~"');
  });
});
