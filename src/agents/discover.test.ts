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

  it("only mentions `kube_deployment_status_replicas` as a DO-NOT-USE health metric OR as a `count by` enumeration query", () => {
    // The bare counter is OK as an enumeration query in Layer 4's standard
    // K8s sweep (`count by (deployment) (kube_deployment_status_replicas)`)
    // because we're using it for service-name enumeration, not health.
    // The trap was using it as the service_availability `query` field, where
    // `lt 1` never trips because the counter doesn't drop during outages.
    //
    // For each bare-form occurrence, accept ONE of:
    //   (a) "DO NOT USE" appears within the preceding 300 chars (it's in
    //       Layer 6.1's USE/DO NOT USE table), OR
    //   (b) "count by" appears within the preceding ~50 chars (it's an
    //       enumeration query in Layer 4 Process, not a health metric).
    const occurrences = [...prompt.matchAll(/\bkube_deployment_status_replicas\b/g)];
    expect(occurrences.length).toBeGreaterThan(0);
    for (const m of occurrences) {
      const wideContext = prompt.slice(Math.max(0, m.index! - 300), m.index!);
      const narrowContext = prompt.slice(Math.max(0, m.index! - 50), m.index!);
      const isDoNotUseCell = /DO NOT USE/.test(wideContext);
      const isEnumerationQuery = /count by/.test(narrowContext);
      expect(
        isDoNotUseCell || isEnumerationQuery,
        `kube_deployment_status_replicas occurrence at idx=${m.index} is neither in a DO-NOT-USE cell nor in a count-by enumeration query`,
      ).toBe(true);
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
    // toward exact container labels and anchored pod-name regexes (trailing `$`).
    expect(prompt).toMatch(/Service-specific selector required/i);
    expect(prompt).toContain("does NOT have `deployment` or `statefulset` labels");
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
    expect(prompt).not.toContain("PRIORITY: Team Knowledge");
  });

  it("renders LAYER 3 between LAYER 2 and LAYER 4 when stack hints are configured", () => {
    const promptWithHints = buildDiscoverInstructions({
      model: fakeModel,
      datasourceUidHints: "metrics: PA58DA793C7250F1B",
      discoverySkills: "## PRIORITY: Team Knowledge (Discovery Skills)\nThese skills describe services that CANNOT be found via standard K8s queries.",
    });
    const layer2 = promptWithHints.indexOf("## LAYER 2: CONSTRAINTS");
    const layer3 = promptWithHints.indexOf("## LAYER 3: STACK HINTS");
    const layer4 = promptWithHints.indexOf("## LAYER 4: PROCESS");
    expect(layer2).toBeGreaterThan(-1);
    expect(layer3).toBeGreaterThan(layer2);
    expect(layer4).toBeGreaterThan(layer3);
    expect(promptWithHints).toContain("### Datasource UIDs (non-negotiable)");
    expect(promptWithHints).toContain("PRIORITY: Team Knowledge (Discovery Skills)");
    expect(promptWithHints).toContain("PA58DA793C7250F1B");
  });

  it("bakes the standard K8s sweep queries into Layer 4 (not in conditional Layer 3)", () => {
    // Pre-cleanup, the sweep queries came from config.discoveryRecipes
    // (or its DEFAULT_PROMETHEUS_RECIPE fallback) and were injected via a
    // recipe-hints block in Layer 3. They now live in the prompt template
    // itself so they're always present regardless of config.
    expect(prompt).toContain("count by (deployment) (kube_deployment_status_replicas)");
    expect(prompt).toContain("count by (statefulset) (kube_statefulset_status_replicas)");
    expect(prompt).toContain("count by (daemonset) (kube_daemonset_status_desired_number_scheduled)");
    expect(prompt).toContain("count by (container) (kube_pod_container_info");
    expect(prompt).toContain("count by (job) (up)");
    // They live in Layer 4 Process, not Layer 3 (which we just asserted is
    // absent in this no-hints build).
    const layer4 = prompt.indexOf("## LAYER 4: PROCESS");
    const sweepIdx = prompt.indexOf("count by (deployment)");
    const layer5 = prompt.indexOf("## LAYER 5: OUTPUT CONTRACT");
    expect(sweepIdx).toBeGreaterThan(layer4);
    expect(sweepIdx).toBeLessThan(layer5);
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

  it("includes section 6.0 (Discovery sources) before 6.1, ranking infra + catalogs as Tier 1 identity sources", () => {
    // 6.0 was added because Layer 6 originally documented how to fill fields
    // (6.1 metrics, 6.2 logLabels, 6.3 probeRules, 6.4 globals) but never
    // taught WHERE identity comes from. Empirics showed the LLM was choosing
    // sources ad-hoc; this section names the authority hierarchy explicitly.
    const section60 = prompt.indexOf("### 6.0 Discovery sources");
    const section61 = prompt.indexOf("### 6.1 Picking metrics[0].query");
    expect(section60).toBeGreaterThan(-1);
    expect(section61).toBeGreaterThan(section60);

    // Two-tier authority: Infrastructure + Catalogs are identity ground truth;
    // Metrics + Logs are projections (observability).
    expect(prompt).toMatch(/Tier 1 — IDENTITY/);
    expect(prompt).toMatch(/Tier 2 — OBSERVABILITY/);

    // Each source family appears in the new section.
    const section60End = section61;
    const section60Body = prompt.slice(section60, section60End);
    expect(section60Body).toMatch(/Infrastructure \(K8s\)/);
    expect(section60Body).toMatch(/Catalogs \(Consul/);
    expect(section60Body).toMatch(/Metrics \(Prometheus\)/);
    expect(section60Body).toMatch(/Logs \(Loki/);
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
    expect(prompt).toMatch(/3 \(last-resort fallback\)/);
  });

  it("documents the Consul status='passing' filter so per-service metrics are interpretable", () => {
    // Before this fix, the Consul row in Layer 6.1 said
    //   "USE: consul_health_service_status — DO NOT USE: n/a"
    // which is too vague: that metric returns 1 row per (node × status) and only
    // the row whose status equals the current health has value=1. The discover
    // agent dutifully emitted `consul_health_service_status{service_name="X"}`,
    // the health poller couldn't interpret the multi-row result, and all 11
    // bare-metal services on stack-120 stuck at UNKNOWN.
    expect(prompt).toContain('consul_health_service_status{service_name="X",status="passing"}');
    expect(prompt).toContain('max by (service_name)');
    // The "DO NOT USE" cell explicitly calls out the bare query as broken.
    expect(prompt).toContain('consul_health_service_status{service_name="X"}');
  });

  it("includes Layer 6.5 (application metrics, with deterministic enrichment) before LAYER 7", () => {
    // Iter 1 made 6.5 a hard requirement with a per-service `count by (__name__)`
    // probe; eval showed the LLM blew its iteration budget on those probes and
    // missed the global service-name sweep (recall dropped 0.998 → 0.779).
    // Iter 2 softens 6.5 to a brief note that defers app-metric enrichment to
    // a deterministic post-discovery step; the LLM keeps its budget for the
    // service sweep.
    const section65 = prompt.indexOf("### 6.5 Application metrics");
    const layer7 = prompt.indexOf("## LAYER 7: OUTPUT STRICTNESS");
    expect(section65).toBeGreaterThan(-1);
    expect(layer7).toBeGreaterThan(section65);
    // The section names the metrics[0] vs metrics[1..] split and points at the
    // deterministic enrichment step so the LLM doesn't try to do it itself.
    expect(prompt).toMatch(/metrics\[1\.\.\]/);
    expect(prompt).toMatch(/deterministic post-discovery step/);
    expect(prompt).toMatch(/Layer 4 service-name sweep/);
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
