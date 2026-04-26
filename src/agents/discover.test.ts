import { describe, it, expect } from "vitest";
import { createDiscoverAgent, buildDiscoverInstructions } from "./discover.js";
import { AVAILABILITY_ANTIPATTERN_METRICS } from "../eval/discover-eval.js";
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

  it("only mentions `kube_deployment_status_replicas` in the DO NOT USE column", () => {
    // \b on both sides excludes `_replicas_available` / `_replicas_ready`
    // (no word boundary between word chars), so we get only the bare form.
    // Then assert each occurrence has "DO NOT USE" within the preceding
    // window — ties the metric to the warning column structurally instead
    // of relying on the surrounding prose.
    const occurrences = [...prompt.matchAll(/\bkube_deployment_status_replicas\b/g)];
    expect(occurrences.length).toBeGreaterThan(0);
    for (const m of occurrences) {
      const context = prompt.slice(Math.max(0, m.index! - 300), m.index!);
      expect(context).toMatch(/DO NOT USE/);
    }
  });

  it("does not contain a literal `up{...}=1` example (the `lt 1` threshold owns the comparison)", () => {
    // A previous version of this prompt rendered the canonical `up` example
    // as `up{...}=1`. An LLM copying that into `metrics[0].query` would emit
    // `up{...}=1` which, paired with `lt 1`, never trips. The query itself
    // must be the raw gauge.
    expect(prompt).not.toMatch(/\bup\s*\{[^}]*\}\s*=\s*1\b/);
  });

  it("teaches pod_restarts selectors that disambiguate sibling-prefix services", () => {
    // The bare `pod=~"<svc>-.*"` form falsely matches sibling services that
    // share a name prefix (`api` matches `api-internal-*`). The fix steers
    // toward exact-match labels (`container=`, `deployment=`) and anchored
    // pod-name regexes (trailing `$`).
    expect(prompt).toMatch(/Service-specific selector required/i);
    expect(prompt).toMatch(/last-resort fallback/i);
    expect(prompt).toContain('container="');
    // Anchored pod-name regex (trailing `$`) must be present.
    expect(prompt).toMatch(/pod=~"[^"]+\$"/);
  });

  it("documents every AVAILABILITY_ANTIPATTERN_METRICS entry the prompt's table covers", () => {
    // The prompt's DO NOT USE table covers Deployment / StatefulSet / DaemonSet
    // primary counters. Less common variants (`_replicas_updated`,
    // `_replicas_current`) live only in the eval's bad set — they're real
    // antipatterns but rare enough that listing them in the prompt would add
    // more noise than signal. The well-known ones MUST appear in both places.
    const promptDocumented = [
      "kube_deployment_status_replicas",
      "kube_deployment_spec_replicas",
      "kube_statefulset_status_replicas",
      "kube_statefulset_replicas",
      "kube_daemonset_status_desired_number_scheduled",
      "kube_daemonset_status_current_number_scheduled",
    ];
    for (const metric of promptDocumented) {
      expect(AVAILABILITY_ANTIPATTERN_METRICS.has(metric)).toBe(true);
      // Each documented metric must appear in the prompt at least once.
      expect(prompt).toContain(metric);
    }
  });
});
