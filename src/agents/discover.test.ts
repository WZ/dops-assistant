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

describe("buildDiscoverInstructions / layered structure (Option B)", () => {
  // These assertions pin the 7-layer organization. The prompt should read
  // top-to-bottom as one coherent document and consolidate previously-
  // duplicated guidance (omission policy was stated 4 times in the pre-Option-B
  // version).
  const prompt = buildDiscoverInstructions({ model: fakeModel });

  it("renders all 7 layer headers in order", () => {
    const expectedHeaders = [
      "## LAYER 1: IDENTITY & GOAL",
      "## LAYER 2: CONSTRAINTS",
      // LAYER 3 is conditional — skipped here
      "## LAYER 4: PROCESS",
      "## LAYER 5: OUTPUT CONTRACT",
      "## LAYER 6: DECISION GUIDES",
      "## LAYER 7: OUTPUT STRICTNESS",
    ];
    let lastIdx = -1;
    for (const header of expectedHeaders) {
      const idx = prompt.indexOf(header);
      expect(idx, `missing header: ${header}`).toBeGreaterThan(-1);
      expect(idx, `header out of order: ${header}`).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  it("omits LAYER 3 entirely when no stack hints are configured", () => {
    expect(prompt).not.toContain("## LAYER 3");
    expect(prompt).not.toContain("### Datasource UIDs");
    expect(prompt).not.toContain("### Provider-specific recipes");
  });

  it("renders LAYER 3 between LAYER 2 and LAYER 4 when stack hints are configured", () => {
    const promptWithHints = buildDiscoverInstructions({
      model: fakeModel,
      datasourceUidHints: "metrics: PA58DA793C7250F1B",
      discoveryRecipes: "recipe-1: example",
    });
    const layer2 = promptWithHints.indexOf("## LAYER 2: CONSTRAINTS");
    const layer3 = promptWithHints.indexOf("## LAYER 3: STACK HINTS");
    const layer4 = promptWithHints.indexOf("## LAYER 4: PROCESS");
    expect(layer2).toBeGreaterThan(-1);
    expect(layer3).toBeGreaterThan(layer2);
    expect(layer4).toBeGreaterThan(layer3);
    expect(promptWithHints).toContain("### Datasource UIDs (non-negotiable)");
    expect(promptWithHints).toContain("### Provider-specific recipes (suggestions)");
    expect(promptWithHints).toContain("PA58DA793C7250F1B");
  });

  it("declares the TypeScript output contract before any rationale", () => {
    // The schema lives in Layer 5; rationale (Why for service_availability)
    // lives in Layer 6. The model should encounter the contract first.
    const contractIdx = prompt.indexOf("type ServiceConfig");
    const rationaleIdx = prompt.indexOf(
      "globalProbeRules use one majority-wins label key",
    );
    expect(contractIdx).toBeGreaterThan(-1);
    expect(rationaleIdx).toBeGreaterThan(-1);
    expect(contractIdx).toBeLessThan(rationaleIdx);
  });

  it("states the per-rule omission policy exactly once (in 6.3.D)", () => {
    // Previously the omission policy was stated 4 times across the prompt
    // (lines 137, 197, 260, 287). Now it lives in one table in 6.3.D and is
    // not repeated inline in 6.3.A / 6.3.B / 6.3.C.
    const occurrences = [...prompt.matchAll(/Omit only when/g)];
    expect(occurrences.length).toBe(1);
    // And the single occurrence is in section 6.3.D.
    const omissionIdx = prompt.indexOf("Omit only when");
    const sectionDIdx = prompt.indexOf("6.3.D Omission policy");
    expect(sectionDIdx).toBeGreaterThan(-1);
    expect(omissionIdx).toBeGreaterThan(sectionDIdx);
  });

  it("places the workload-kind table in section 6.1 (a decision guide), not inline in a rule", () => {
    // The USE / DO NOT USE table is reusable guidance — it lives in 6.1
    // (Picking metrics[0].query), not inside the service_availability rule
    // shape. The rule references 6.1 by section name.
    const tableIdx = prompt.indexOf("| Workload kind");
    const section61Idx = prompt.indexOf("### 6.1 Picking metrics[0].query");
    const rule63aIdx = prompt.indexOf("#### 6.3.A service_availability");
    expect(section61Idx).toBeGreaterThan(-1);
    expect(rule63aIdx).toBeGreaterThan(-1);
    expect(tableIdx).toBeGreaterThan(section61Idx);
    expect(tableIdx).toBeLessThan(rule63aIdx);
  });

  it("places the selector-priority table as a markdown table (not plaintext list)", () => {
    // Pre-Option-B the priority list was 7 lines of prose. Now it's a
    // markdown table with explicit "(best)" and "(last-resort fallback)"
    // labels on the bounding rows so the model can scan-read.
    expect(prompt).toMatch(/\| Priority\s+\| Selector/);
    expect(prompt).toMatch(/1 \(best\)/);
    expect(prompt).toMatch(/4 \(last-resort fallback\)/);
  });

  it("appends the exclude list inside LAYER 2: CONSTRAINTS, not the strictness tail", () => {
    // Pre-Option-B excludeServices was tacked onto the end of the OUTPUT
    // STRICTNESS paragraph. Now it lives where it belongs — in CONSTRAINTS.
    const promptWithExcludes = buildDiscoverInstructions({
      model: fakeModel,
      excludeServices: ["consul", "prometheus"],
    });
    const constraintsIdx = promptWithExcludes.indexOf("## LAYER 2: CONSTRAINTS");
    const excludesIdx = promptWithExcludes.indexOf(
      "Exclude these services (case-insensitive)",
    );
    const layer4Idx = promptWithExcludes.indexOf("## LAYER 4: PROCESS");
    expect(constraintsIdx).toBeGreaterThan(-1);
    expect(excludesIdx).toBeGreaterThan(constraintsIdx);
    expect(excludesIdx).toBeLessThan(layer4Idx);
    expect(promptWithExcludes).toContain("consul, prometheus");
  });
});
