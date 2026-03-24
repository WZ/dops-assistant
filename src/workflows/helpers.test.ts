import { describe, it, expect } from "vitest";
import { buildTimeline, validateSeverity, extractTimeRange, suggestStepSeconds, toRfc3339Window, resolveTimeRangeToAbsolute } from "./helpers.js";
import type { MetricFindings, LogFindings, InfraFindings } from "../types/rca-types.js";

describe("buildTimeline", () => {
  it("builds chronologically sorted timeline from structured findings", () => {
    const metrics: MetricFindings = {
      observations: [
        { metric: "error_rate", currentValue: "18%", baselineValue: "0.2%", timestamp: "14:32", severity: "critical" },
      ],
      anomalyWindow: "14:28-15:10",
      summary: "Error rate spiked",
    };
    const logs: LogFindings = {
      observations: [
        { pattern: "connection timeout", count: "47", firstSeen: "14:30", lastSeen: "14:55", sample: "ERROR timeout", sampleLines: [] },
      ],
      summary: "Connection timeouts",
    };
    const infra: InfraFindings = {
      observations: [
        { resource: "pod-1", status: "CrashLoopBackOff", detail: "3 restarts", timestamp: "14:35" },
      ],
      summary: "Pod crash",
    };

    const timeline = buildTimeline(metrics, logs, infra);

    // Should be sorted chronologically: 14:30, 14:32, 14:35
    const lines = timeline.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("14:30");
    expect(lines[0]).toContain("[log]");
    expect(lines[1]).toContain("14:32");
    expect(lines[1]).toContain("[metric]");
    expect(lines[2]).toContain("14:35");
    expect(lines[2]).toContain("[infra]");
  });

  it("returns empty string when no timestamped observations exist", () => {
    const empty: MetricFindings = { observations: [], anomalyWindow: "unknown", summary: "" };
    const emptyLogs: LogFindings = { observations: [], summary: "" };
    const emptyInfra: InfraFindings = { observations: [], summary: "" };

    expect(buildTimeline(empty, emptyLogs, emptyInfra)).toBe("");
  });

  it("includes detail content in timeline entries", () => {
    const metrics: MetricFindings = {
      observations: [
        { metric: "http_errors", currentValue: "500/s", baselineValue: "10/s", timestamp: "10:00", severity: "critical" },
      ],
      anomalyWindow: "10:00-11:00",
      summary: "",
    };
    const logs: LogFindings = {
      observations: [
        { pattern: "OOM killed", count: "3", firstSeen: "10:05", lastSeen: "10:30", sample: "killed process", sampleLines: [] },
      ],
      summary: "",
    };
    const infra: InfraFindings = {
      observations: [
        { resource: "node-2", status: "NotReady", detail: "memory pressure", timestamp: "10:02" },
      ],
      summary: "",
    };

    const timeline = buildTimeline(metrics, logs, infra);
    expect(timeline).toContain("http_errors: 500/s (baseline: 10/s)");
    expect(timeline).toContain("OOM killed (count: 3)");
    expect(timeline).toContain("node-2: NotReady");
  });

  it("handles multiple observations from the same source", () => {
    const metrics: MetricFindings = {
      observations: [
        { metric: "latency_p99", currentValue: "800ms", baselineValue: "50ms", timestamp: "09:00", severity: "critical" },
        { metric: "error_rate", currentValue: "15%", baselineValue: "0.1%", timestamp: "09:05", severity: "critical" },
        { metric: "throughput", currentValue: "100/s", baselineValue: "1000/s", timestamp: "09:02", severity: "warning" },
      ],
      anomalyWindow: "09:00-10:00",
      summary: "",
    };
    const emptyLogs: LogFindings = { observations: [], summary: "" };
    const emptyInfra: InfraFindings = { observations: [], summary: "" };

    const timeline = buildTimeline(metrics, emptyLogs, emptyInfra);
    const lines = timeline.split("\n");
    expect(lines).toHaveLength(3);
    // Should be sorted: 09:00, 09:02, 09:05
    expect(lines[0]).toContain("09:00");
    expect(lines[0]).toContain("latency_p99");
    expect(lines[1]).toContain("09:02");
    expect(lines[1]).toContain("throughput");
    expect(lines[2]).toContain("09:05");
    expect(lines[2]).toContain("error_rate");
  });
});

describe("validateSeverity", () => {
  const normalMetrics: MetricFindings = {
    observations: [{ metric: "rate", currentValue: "200k", baselineValue: "200k", timestamp: "now", severity: "normal" }],
    anomalyWindow: "none",
    summary: "No anomaly detected. Metrics are within normal range.",
  };
  const normalLogs: LogFindings = {
    observations: [],
    summary: "No errors or anomalies found in logs.",
  };
  const normalInfra: InfraFindings = {
    observations: [],
    summary: "Infrastructure is stable and healthy.",
  };

  it("overrides high severity to low when all evidence says no anomaly", () => {
    const report = {
      severity: "high",
      summary: "No anomaly detected in the ingestion log rate.",
      rootCause: "No abnormal behavior was observed. The metric stayed within expected limits.",
    };
    expect(validateSeverity(report, normalMetrics, normalLogs, normalInfra)).toBe("low");
  });

  it("overrides medium severity to low when findings are all normal", () => {
    const report = {
      severity: "medium",
      summary: "The system operated normally with no issues.",
      rootCause: "Normal traffic — no anomaly found.",
    };
    expect(validateSeverity(report, normalMetrics, normalLogs, normalInfra)).toBe("low");
  });

  it("returns null when severity is already low", () => {
    const report = {
      severity: "low",
      summary: "No anomaly detected.",
      rootCause: "Everything is normal.",
    };
    expect(validateSeverity(report, normalMetrics, normalLogs, normalInfra)).toBeNull();
  });

  it("returns null when there are actual elevated metrics", () => {
    const elevatedMetrics: MetricFindings = {
      observations: [{ metric: "error_rate", currentValue: "50%", baselineValue: "1%", timestamp: "now", severity: "critical" }],
      anomalyWindow: "last 2h",
      summary: "Error rate spiked to 50%.",
    };
    const report = {
      severity: "high",
      summary: "Error rate spike detected.",
      rootCause: "Database connection failure causing errors.",
    };
    expect(validateSeverity(report, elevatedMetrics, normalLogs, normalInfra)).toBeNull();
  });

  it("overrides when report summary contradicts severity despite phase summaries being unavailable", () => {
    const unavailableMetrics: MetricFindings = { observations: [], anomalyWindow: "unknown", summary: "unavailable" };
    const unavailableLogs: LogFindings = { observations: [], summary: "unavailable" };
    const unavailableInfra: InfraFindings = { observations: [], summary: "unavailable" };
    const report = {
      severity: "high",
      summary: "No anomaly was found. Everything is stable.",
      rootCause: "No issues detected within the expected range.",
    };
    expect(validateSeverity(report, unavailableMetrics, unavailableLogs, unavailableInfra)).toBe("low");
  });
});

describe("extractTimeRange", () => {
  it("handles ISO date", () => {
    const range = extractTimeRange("anomaly on 2026-03-05", "");
    expect(range).toEqual({ from: "2026-03-05T00:00:00Z", to: "2026-03-05T23:59:59Z" });
  });

  it("handles Unicode dashes in ISO date", () => {
    const range = extractTimeRange("anomaly on 2026\u201103\u201105", "");
    expect(range).toEqual({ from: "2026-03-05T00:00:00Z", to: "2026-03-05T23:59:59Z" });
  });

  it("defaults to last 8h when no date found", () => {
    const range = extractTimeRange("ingestion rate anomaly", "investigate ingestion");
    expect(range).toEqual({ from: "now-8h", to: "now" });
  });

  it("parses named month + day (e.g. 'March 4')", () => {
    const range = extractTimeRange("", "any anomaly on the ingestion log rate on March 4");
    expect(range.from).toMatch(/^\d{4}-03-04T00:00:00Z$/);
    expect(range.to).toMatch(/^\d{4}-03-04T23:59:59Z$/);
  });

  it("parses 'last week' as 7d window", () => {
    const range = extractTimeRange("", "any anomaly last week");
    expect(range).toEqual({ from: "now-7d", to: "now" });
  });

  it("parses 'yesterday'", () => {
    const range = extractTimeRange("", "check ingestion logs from yesterday");
    expect(range).toEqual({ from: "now-1d", to: "now" });
  });

  it("parses 'last 3 days'", () => {
    const range = extractTimeRange("", "any errors in the last 3 days");
    expect(range).toEqual({ from: "now-3d", to: "now" });
  });

  it("parses 'last month'", () => {
    const range = extractTimeRange("", "show metrics from last month");
    expect(range).toEqual({ from: "now-30d", to: "now" });
  });

  it("parses 'last 24 hours'", () => {
    const range = extractTimeRange("", "any anomaly in the last 24 hours");
    expect(range).toEqual({ from: "now-24h", to: "now" });
  });

  it("parses 'Jan 15'", () => {
    const range = extractTimeRange("", "what happened on Jan 15");
    expect(range.from).toMatch(/^\d{4}-01-15T00:00:00Z$/);
    expect(range.to).toMatch(/^\d{4}-01-15T23:59:59Z$/);
  });

  it("parses 'September 22'", () => {
    const range = extractTimeRange("", "outage on September 22");
    expect(range.from).toMatch(/^\d{4}-09-22T00:00:00Z$/);
    expect(range.to).toMatch(/^\d{4}-09-22T23:59:59Z$/);
  });

  it("parses 'Feb 1'", () => {
    const range = extractTimeRange("", "Feb 1 error spike");
    expect(range.from).toMatch(/^\d{4}-02-01T00:00:00Z$/);
    expect(range.to).toMatch(/^\d{4}-02-01T23:59:59Z$/);
  });

  it("does NOT match 'last 3 deploys' as days", () => {
    const range = extractTimeRange("", "check the last 3 deploys");
    expect(range).toEqual({ from: "now-8h", to: "now" });
  });

  it("resolves 'December 25' to a date not in the future", () => {
    const range = extractTimeRange("", "outage on December 25");
    const fromDate = new Date(range.from);
    expect(fromDate.getTime()).not.toBeNaN();
    expect(fromDate <= new Date()).toBe(true);
  });

  it("falls back to default for invalid date 'February 30'", () => {
    const range = extractTimeRange("", "incident on February 30");
    expect(range).toEqual({ from: "now-8h", to: "now" });
  });
});

describe("suggestStepSeconds", () => {
  it("returns 300 minimum for very short windows", () => {
    const now = new Date().toISOString();
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const step = suggestStepSeconds({ from: fiveMinAgo, to: now });
    expect(step).toBe(300); // min is 300
  });

  it("returns larger step for 24h window (targets ~100 points)", () => {
    const step = suggestStepSeconds({ from: "now-24h", to: "now" });
    // 24h = 86400s, /100 = 864s => max(300, 864) = 864
    expect(step).toBe(864);
  });

  it("returns 900 fallback for unparseable expressions", () => {
    const step = suggestStepSeconds({ from: "invalid", to: "also-invalid" });
    expect(step).toBe(900);
  });

  it("handles ISO date window", () => {
    const step = suggestStepSeconds({ from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z" });
    // 24h = 86400s, /100 = 864 => max(300, 864) = 864
    expect(step).toBe(864);
  });
});

describe("toRfc3339Window", () => {
  it("converts ISO date to RFC3339", () => {
    const result = toRfc3339Window({ from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z" });
    expect(result.startRfc3339).toBe("2026-01-01T00:00:00.000Z");
    expect(result.endRfc3339).toBe("2026-01-02T00:00:00.000Z");
  });

  it("converts now-Xd to a date in the past", () => {
    const result = toRfc3339Window({ from: "now-7d", to: "now" });
    const start = new Date(result.startRfc3339);
    const end = new Date(result.endRfc3339);
    expect(start < end).toBe(true);
    // Start should be roughly 7 days ago (within 2 hours to account for DST differences)
    const sevenDaysAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(start.getTime() - sevenDaysAgoMs)).toBeLessThan(2 * 60 * 60 * 1000);
  });

  it("converts now-Xh to a date in the past", () => {
    const result = toRfc3339Window({ from: "now-24h", to: "now" });
    const start = new Date(result.startRfc3339);
    const end = new Date(result.endRfc3339);
    expect(start < end).toBe(true);
    const oneDayAgoMs = Date.now() - 24 * 60 * 60 * 1000;
    expect(Math.abs(start.getTime() - oneDayAgoMs)).toBeLessThan(5000);
  });

  it("falls back to 7 days ago for unrecognized expressions", () => {
    const result = toRfc3339Window({ from: "bogus", to: "also-bogus" });
    const start = new Date(result.startRfc3339);
    const sevenDaysAgoMs = Date.now() - 7 * 86400000;
    expect(Math.abs(start.getTime() - sevenDaysAgoMs)).toBeLessThan(5000);
  });
});

describe("resolveTimeRangeToAbsolute", () => {
  it("passes through absolute ISO dates unchanged", () => {
    const result = resolveTimeRangeToAbsolute({ from: "2026-03-20T15:00:00Z", to: "2026-03-20T17:00:00Z" });
    expect(result.from).toMatch(/^2026-03-20T15:00:00/);
    expect(result.to).toMatch(/^2026-03-20T17:00:00/);
  });

  it("resolves 'now' to current time", () => {
    const before = Date.now();
    const result = resolveTimeRangeToAbsolute({ from: "now-8h", to: "now" });
    const after = Date.now();
    const toMs = new Date(result.to).getTime();
    expect(toMs).toBeGreaterThanOrEqual(before - 1000);
    expect(toMs).toBeLessThanOrEqual(after + 1000);
  });

  it("resolves 'now-8h' to ~8 hours ago", () => {
    const result = resolveTimeRangeToAbsolute({ from: "now-8h", to: "now" });
    const fromMs = new Date(result.from).getTime();
    const toMs = new Date(result.to).getTime();
    const diffHours = (toMs - fromMs) / 3600000;
    expect(diffHours).toBeCloseTo(8, 0);
  });

  it("resolves 'now-7d' to ~7 days ago", () => {
    const result = resolveTimeRangeToAbsolute({ from: "now-7d", to: "now" });
    const fromMs = new Date(result.from).getTime();
    const toMs = new Date(result.to).getTime();
    const diffDays = (toMs - fromMs) / 86400000;
    expect(diffDays).toBeCloseTo(7, 0);
  });

  it("returns valid ISO strings for all outputs", () => {
    const result = resolveTimeRangeToAbsolute({ from: "now-1d", to: "now" });
    expect(new Date(result.from).toISOString()).toBe(result.from);
    expect(new Date(result.to).toISOString()).toBe(result.to);
  });
});
