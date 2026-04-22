import { describe, it, expect } from "vitest";
import type { RcaReport } from "../types/rca-types.js";
import {
  scoreRootCause,
  scoreEvidence,
  scoreTrigger,
  scoreActionability,
  scoreFactualGrounding,
  scoreReport,
  classifyTriggerSource,
} from "./rca-eval.js";
import { buildInvestigationMessage, type ProbeHit } from "../server/anomaly-probe.js";

// ── Helper ─────────────────────────────────────────────────────────────────

function buildReport(overrides: Partial<RcaReport> = {}): RcaReport {
  return {
    service: "test-service",
    severity: "medium",
    summary: "Test incident summary",
    impact: { duration: "30m", description: "Service degraded" },
    trigger: "Unknown",
    rootCause: "",
    contributingFactors: [],
    timeline: [],
    evidence: { metrics: [], logs: [], infra: [] },
    dashboardLinks: [],
    recommendedActions: [],
    confidence: "low",
    confidenceScore: 0,
    investigatedAt: "2026-03-22T10:00:00Z",
    ...overrides,
  };
}

// ── scoreRootCause ─────────────────────────────────────────────────────────

describe("scoreRootCause", () => {
  it('returns 0 for "Unable to determine"', () => {
    expect(scoreRootCause(buildReport({ rootCause: "Unable to determine" }))).toBe(0);
  });

  it('returns 0 for "Under investigation"', () => {
    expect(scoreRootCause(buildReport({ rootCause: "Under investigation" }))).toBe(0);
  });

  it("returns 0 for vague phrases case-insensitively", () => {
    expect(scoreRootCause(buildReport({ rootCause: "UNABLE TO DETERMINE" }))).toBe(0);
    expect(scoreRootCause(buildReport({ rootCause: "under investigation right now" }))).toBe(0);
  });

  it("returns 0 for empty rootCause", () => {
    expect(scoreRootCause(buildReport({ rootCause: "" }))).toBe(0);
  });

  it("returns 0 when rootCause is undefined (missing field)", () => {
    const report = buildReport();
    // @ts-expect-error intentionally omitting field for test
    delete report.rootCause;
    expect(scoreRootCause(report)).toBe(0);
  });

  it("returns 10 for short generic text (<50 chars)", () => {
    expect(scoreRootCause(buildReport({ rootCause: "Memory leak in worker process" }))).toBe(10);
  });

  it("returns 20 for specific detailed rootCause (≥50 chars, no vague phrases)", () => {
    const detailed =
      "A memory leak in the payment-worker process caused heap exhaustion after 2h of sustained traffic, triggering OOM kills.";
    expect(scoreRootCause(buildReport({ rootCause: detailed }))).toBe(20);
  });
});

// ── scoreEvidence ──────────────────────────────────────────────────────────

describe("scoreEvidence", () => {
  it("returns 0 when all evidence arrays are empty", () => {
    expect(scoreEvidence(buildReport({ evidence: { metrics: [], logs: [], infra: [] } }))).toBe(0);
  });

  it("returns 0 when evidence field is absent", () => {
    const report = buildReport();
    // @ts-expect-error intentionally omitting field for test
    delete report.evidence;
    expect(scoreEvidence(report)).toBe(0);
  });

  it("returns 10 when items exist but none have timestamps or numeric values", () => {
    expect(
      scoreEvidence(
        buildReport({
          evidence: {
            metrics: ["CPU was high", "Memory was elevated"],
            logs: [],
            infra: [],
          },
        })
      )
    ).toBe(10);
  });

  it("returns 20 when ≥50% items contain timestamps", () => {
    expect(
      scoreEvidence(
        buildReport({
          evidence: {
            metrics: [
              "CPU spike observed at 2026-03-22 10:15",
              "Memory at 2026-03-22 10:16",
            ],
            logs: [],
            infra: [],
          },
        })
      )
    ).toBe(20);
  });

  it("returns 20 when ≥50% items contain numeric values with units", () => {
    expect(
      scoreEvidence(
        buildReport({
          evidence: {
            metrics: ["Throughput dropped to 120 req/s", "Latency spiked to 850 ms"],
            logs: [],
            infra: [],
          },
        })
      )
    ).toBe(20);
  });

  it("returns 10 when fewer than 50% of items are rich (has some rich, some plain)", () => {
    expect(
      scoreEvidence(
        buildReport({
          evidence: {
            metrics: ["CPU was high", "Memory was elevated", "Disk was full"],
            logs: ["Error occurred at 2026-03-22"],
            infra: [],
          },
        })
      )
    ).toBe(10);
  });

  it("returns 20 combining rich items across metrics, logs, and infra arrays", () => {
    expect(
      scoreEvidence(
        buildReport({
          evidence: {
            metrics: ["CPU at 2026-03-22"],
            logs: ["OOM at 2026-03-22"],
            infra: ["Pod restarted at 2026-03-22"],
          },
        })
      )
    ).toBe(20);
  });
});

// ── scoreTrigger ───────────────────────────────────────────────────────────

describe("scoreTrigger", () => {
  it('returns 0 for "Unknown"', () => {
    expect(scoreTrigger(buildReport({ trigger: "Unknown" }))).toBe(0);
  });

  it("returns 0 for empty trigger", () => {
    expect(scoreTrigger(buildReport({ trigger: "" }))).toBe(0);
  });

  it("returns 0 for blank/whitespace-only trigger", () => {
    expect(scoreTrigger(buildReport({ trigger: "   " }))).toBe(0);
  });

  it("returns 10 for a short trigger without a timestamp", () => {
    expect(scoreTrigger(buildReport({ trigger: "Traffic spike" }))).toBe(10);
  });

  it("returns 10 for a trigger ≥30 chars but without a timestamp", () => {
    expect(scoreTrigger(buildReport({ trigger: "Sudden surge in incoming HTTP requests" }))).toBe(10);
  });

  it("returns 20 for a specific trigger with a timestamp", () => {
    expect(
      scoreTrigger(
        buildReport({
          trigger: "Deployment at 2026-03-22 09:45 pushed a misconfigured env variable",
        })
      )
    ).toBe(20);
  });
});

// ── scoreActionability ─────────────────────────────────────────────────────

describe("scoreActionability", () => {
  it("returns 0 for empty recommendedActions array", () => {
    expect(scoreActionability(buildReport({ recommendedActions: [] }))).toBe(0);
  });

  it("returns 0 when recommendedActions is absent", () => {
    const report = buildReport();
    // @ts-expect-error intentionally omitting field for test
    delete report.recommendedActions;
    expect(scoreActionability(report)).toBe(0);
  });

  it("returns 10 for 1 action", () => {
    expect(scoreActionability(buildReport({ recommendedActions: ["Restart the service"] }))).toBe(10);
  });

  it("returns 10 for 2 actions", () => {
    expect(
      scoreActionability(buildReport({ recommendedActions: ["Restart the service", "Increase memory limit"] }))
    ).toBe(10);
  });

  it("returns 20 for exactly 3 actions", () => {
    expect(
      scoreActionability(
        buildReport({
          recommendedActions: ["Restart the service", "Increase memory limit", "Add memory alerting"],
        })
      )
    ).toBe(20);
  });

  it("returns 20 for more than 3 actions", () => {
    expect(
      scoreActionability(
        buildReport({
          recommendedActions: [
            "Restart the service",
            "Increase memory limit",
            "Add memory alerting",
            "Review deployment checklist",
          ],
        })
      )
    ).toBe(20);
  });
});

// ── scoreFactualGrounding ──────────────────────────────────────────────────

describe("scoreFactualGrounding", () => {
  it("returns 0 for 0 evidence items (all empty)", () => {
    expect(scoreFactualGrounding(buildReport({ evidence: { metrics: [], logs: [], infra: [] } }))).toBe(0);
  });

  it("returns 0 when evidence is absent", () => {
    const report = buildReport();
    // @ts-expect-error intentionally omitting field for test
    delete report.evidence;
    expect(scoreFactualGrounding(report)).toBe(0);
  });

  it("returns 10 for 1 evidence item", () => {
    expect(
      scoreFactualGrounding(buildReport({ evidence: { metrics: ["CPU was high"], logs: [], infra: [] } }))
    ).toBe(10);
  });

  it("returns 10 for 2 evidence items", () => {
    expect(
      scoreFactualGrounding(
        buildReport({ evidence: { metrics: ["CPU was high"], logs: ["Error log entry"], infra: [] } })
      )
    ).toBe(10);
  });

  it("returns 20 for exactly 3 evidence items", () => {
    expect(
      scoreFactualGrounding(
        buildReport({
          evidence: {
            metrics: ["CPU was high"],
            logs: ["Error log entry"],
            infra: ["Pod restarted"],
          },
        })
      )
    ).toBe(20);
  });

  it("returns 20 for more than 3 evidence items spread across arrays", () => {
    expect(
      scoreFactualGrounding(
        buildReport({
          evidence: {
            metrics: ["CPU", "Memory", "Disk"],
            logs: ["Error A", "Error B"],
            infra: [],
          },
        })
      )
    ).toBe(20);
  });
});

// ── scoreReport (integration) ──────────────────────────────────────────────

describe("scoreReport", () => {
  it("returns a perfect/high score (≥90) and pass=true for a well-formed report", () => {
    const report = buildReport({
      rootCause:
        "A memory leak in the payment-worker process caused heap exhaustion after sustained traffic at 2026-03-22, triggering OOM kills.",
      evidence: {
        metrics: [
          "Heap usage climbed to 95% at 2026-03-22 10:00",
          "GC pauses exceeded 500 ms at 2026-03-22 10:05",
          "Throughput fell to 80 req/s at 2026-03-22 10:10",
        ],
        logs: ["OOM kill recorded at 2026-03-22 10:12"],
        infra: ["payment-worker pod restarted 4 times at 2026-03-22"],
      },
      trigger:
        "Deployment at 2026-03-22 09:45 introduced a connection pool that was never released",
      recommendedActions: [
        "Fix the connection pool leak in payment-worker v2.3.1",
        "Add heap-memory alert at 85% threshold",
        "Run load test against the patched build before re-deploy",
        "Review all connection-pool usage in the service",
      ],
    });

    const result = scoreReport(report);
    expect(result.total).toBeGreaterThanOrEqual(90);
    expect(result.pass).toBe(true);
    expect(result.rootCause).toBe(20);
    expect(result.evidence).toBe(20);
    expect(result.trigger).toBe(20);
    expect(result.actionability).toBe(20);
    expect(result.factualGrounding).toBe(20);
  });

  it("returns a low score (≤30) and pass=false for a minimal/vague report", () => {
    const report = buildReport({
      rootCause: "Unable to determine",
      evidence: { metrics: [], logs: [], infra: [] },
      trigger: "Unknown",
      recommendedActions: [],
    });

    const result = scoreReport(report);
    expect(result.total).toBeLessThanOrEqual(30);
    expect(result.pass).toBe(false);
    expect(result.rootCause).toBe(0);
    expect(result.evidence).toBe(0);
    expect(result.trigger).toBe(0);
    expect(result.actionability).toBe(0);
    expect(result.factualGrounding).toBe(0);
  });

  it("returns a medium score for a partially-filled report", () => {
    const report = buildReport({
      rootCause: "Memory leak in worker",  // short but not vague → 10
      evidence: {
        metrics: ["CPU was high", "Memory was elevated"],  // no timestamps/values → 10 evidence quality
        logs: [],
        infra: [],
      },
      trigger: "Traffic spike on 2026-03-22 caused load to increase beyond capacity",  // ≥30 chars + timestamp → 20
      recommendedActions: ["Restart the service", "Increase memory limits"],  // 2 actions → 10
    });

    const result = scoreReport(report);
    // rootCause=10, evidence=10, trigger=20, actionability=10, factualGrounding=10 → total=60
    expect(result.total).toBeGreaterThan(30);
    expect(result.total).toBeLessThan(90);
    // factualGrounding: 2 metrics → 10
    expect(result.factualGrounding).toBe(10);
    // pass threshold is 70; 60 < 70
    expect(result.pass).toBe(false);
  });

  it("total equals sum of individual dimension scores", () => {
    const report = buildReport({
      rootCause: "Disk I/O saturation on the primary node caused write latency spikes during the peak window.",
      evidence: {
        metrics: ["IOPS exceeded 2026-03-22"],
        logs: [],
        infra: [],
      },
      trigger: "Backup job started at 2026-03-22 02:00 competed for disk bandwidth",
      recommendedActions: ["Schedule backup during off-peak", "Add IOPS alerting", "Upgrade disk tier"],
    });

    const result = scoreReport(report);
    expect(result.total).toBe(
      result.rootCause + result.evidence + result.trigger + result.actionability + result.factualGrounding
    );
  });

  it("pass is true when total is exactly 70", () => {
    // rootCause=20 (≥50 chars, no vague), evidence=10 (items but no rich data),
    // trigger=10 (present, <30 chars or no timestamp), actionability=20 (≥3), factualGrounding=10 (1-2 items)
    // total = 20+10+10+20+10 = 70
    const report = buildReport({
      rootCause:
        "High CPU utilization in the api-gateway service caused request timeouts after sustained load.",
      evidence: {
        metrics: ["CPU was elevated", "Latency increased"],
        logs: [],
        infra: [],
      },
      trigger: "Load spike on weekend",  // short, no timestamp → 10
      recommendedActions: ["Scale horizontally", "Add CPU alert", "Profile hot endpoints"],
    });

    const result = scoreReport(report);
    expect(result.total).toBe(70);
    expect(result.pass).toBe(true);
  });
});

// ── classifyTriggerSource ──────────────────────────────────────────────────

describe("classifyTriggerSource", () => {
  it('classifies as "scan" when query starts with the scan-message prefix', () => {
    const msg = "Proactive scan detected anomaly on api-gateway.";
    expect(classifyTriggerSource(msg)).toBe("scan");
  });

  it("classifies a real buildInvestigationMessage output as scan", () => {
    // Ensures the scan-side prefix and eval-side classifier never drift.
    const hit: ProbeHit = {
      service: "api-gateway",
      ruleName: "availability",
      value: 0,
      query: 'up{service="api-gateway"}',
      threshold: { op: "lt", value: 1 },
      consecutiveTicks: 1,
      severity: 1,
    };
    const msg = buildInvestigationMessage(hit);
    expect(classifyTriggerSource(msg)).toBe("scan");
  });

  it('classifies as "webhook" when query starts with "Alert: "', () => {
    expect(classifyTriggerSource("Alert: HighErrorRate (severity: warning)")).toBe("webhook");
  });

  it('classifies as "user" for anything else', () => {
    expect(classifyTriggerSource("why is api-gateway slow today?")).toBe("user");
    expect(classifyTriggerSource("")).toBe("user");
    expect(classifyTriggerSource("investigate api-gateway")).toBe("user");
  });

  it('does not misclassify "proactive scan" mid-sentence as scan-triggered', () => {
    // Prefix match only — a user-initiated chat mentioning scan in the middle
    // must not be bucketed into the scan-source metric.
    const confusing = "why did the proactive scan detected anomaly fire yesterday?";
    expect(classifyTriggerSource(confusing)).toBe("user");
  });
});

// ── Scan-triggered report end-to-end scoring ──────────────────────────────

describe("scan-triggered reports meet design-doc ≥60 criterion", () => {
  /**
   * The design doc's success criterion: RCA eval score on scan-triggered
   * investigations ≥ 60. Verifiable in CI via these synthetic reports —
   * if scoreReport would judge a "good-enough scan RCA" below 60, either the
   * rubric drifted or the fixture is stale. Either is a signal worth catching.
   */

  it("a realistic good scan-triggered RCA scores ≥ 60", () => {
    const report = buildReport({
      service: "payments-api",
      severity: "high",
      summary: "payments-api returned 5xx for 14 minutes starting 2026-04-21T10:15 UTC",
      rootCause:
        "Upstream database connection pool exhausted after a config push reduced max_connections from 200 to 50.",
      trigger: "Config rollout at 2026-04-21T10:14 UTC reduced DB connection limit below peak demand.",
      evidence: {
        metrics: [
          "error_rate climbed from 0.01 req/s to 8.2 req/s at 2026-04-21T10:15",
          "db_connections_in_use hit 50 of 50 at 2026-04-21T10:16",
        ],
        logs: [
          "2026-04-21T10:15:33 payments-api ERROR could not acquire connection after 30s",
        ],
        infra: [],
      },
      recommendedActions: [
        "Roll back the config change that lowered max_connections",
        "Add alerting on db_connections_in_use >= 0.9 * max_connections",
        "Review the config-review checklist so DB limit changes require canary",
      ],
    });

    const result = scoreReport(report);
    expect(result.total).toBeGreaterThanOrEqual(60);
  });

  it("a low-quality scan RCA (vague rootCause, no evidence) scores below 60", () => {
    const report = buildReport({
      service: "payments-api",
      severity: "medium",
      summary: "payments-api had issues",
      rootCause: "Unable to determine",
      trigger: "Unknown",
      evidence: { metrics: [], logs: [], infra: [] },
      recommendedActions: [],
    });
    const result = scoreReport(report);
    expect(result.total).toBeLessThan(60);
  });
});
