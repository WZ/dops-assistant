import { describe, it, expect } from "vitest";
import { pickState } from "./ScanActivityBadge";
import type { ScanActivity } from "../hooks/useScanActivity";

function makeActivity(overrides: Partial<ScanActivity> = {}): ScanActivity {
  return {
    enabled: true,
    ticking: false,
    lastRun: null,
    nextRun: null,
    lastError: null,
    dropsByConcurrency: 0,
    windowHours: 24,
    recentAnomalies: 0,
    ...overrides,
  };
}

describe("ScanActivityBadge.pickState", () => {
  it("renders SCAN:— while loading (activity is null)", () => {
    const s = pickState(null);
    expect(s.label).toBe("SCAN:\u2014");
    expect(s.tone).toBe("muted");
  });

  it("SCAN:OFF when disabled, regardless of other fields", () => {
    const s = pickState(makeActivity({ enabled: false, recentAnomalies: 999 }));
    expect(s.label).toBe("SCAN:OFF");
    expect(s.tone).toBe("muted");
    expect(s.title).toContain("disabled");
  });

  it("SCAN:ERR when lastError is set, taking precedence over anomalies count", () => {
    const s = pickState(makeActivity({
      enabled: true,
      lastError: "no Prometheus datasource UID",
      recentAnomalies: 5,
    }));
    expect(s.label).toBe("SCAN:ERR");
    expect(s.tone).toBe("destructive");
    expect(s.title).toContain("no Prometheus datasource UID");
  });

  it("SCAN:ON when enabled but never ticked", () => {
    const s = pickState(makeActivity({ enabled: true, lastRun: null }));
    expect(s.label).toBe("SCAN:ON");
    expect(s.tone).toBe("muted");
  });

  it("SCAN:0 when enabled, ticked, nothing tripped", () => {
    const s = pickState(makeActivity({
      enabled: true,
      lastRun: new Date(Date.now() - 60_000).toISOString(),
      recentAnomalies: 0,
    }));
    expect(s.label).toBe("SCAN:0");
    expect(s.tone).toBe("success");
    expect(s.title).toContain("0 anomalies");
  });

  it("SCAN:3 when anomalies present with no overflow drops", () => {
    const s = pickState(makeActivity({
      enabled: true,
      lastRun: new Date().toISOString(),
      recentAnomalies: 3,
      dropsByConcurrency: 0,
    }));
    expect(s.label).toBe("SCAN:3");
    expect(s.tone).toBe("warning");
    expect(s.title).toContain("3 anomalies");
  });

  it("SCAN:1 singular in tooltip when recentAnomalies is exactly 1", () => {
    const s = pickState(makeActivity({
      enabled: true,
      lastRun: new Date().toISOString(),
      recentAnomalies: 1,
    }));
    expect(s.label).toBe("SCAN:1");
    expect(s.title).toMatch(/1 anomaly/);
    expect(s.title).not.toMatch(/anomalies/);
  });

  it("SCAN:N⚠ when overflow drops are present, warning tone", () => {
    const s = pickState(makeActivity({
      enabled: true,
      lastRun: new Date().toISOString(),
      recentAnomalies: 3,
      dropsByConcurrency: 4,
    }));
    expect(s.label).toBe("SCAN:3\u26A0");
    expect(s.tone).toBe("warning");
    expect(s.title).toContain("4 dropped by per-tick cap");
  });

  it("tooltip includes the windowHours period for healthy + anomaly states", () => {
    const healthy = pickState(makeActivity({
      enabled: true,
      lastRun: new Date().toISOString(),
      windowHours: 6,
    }));
    expect(healthy.title).toContain("last 6h");

    const anomaly = pickState(makeActivity({
      enabled: true,
      lastRun: new Date().toISOString(),
      recentAnomalies: 2,
      windowHours: 168,
    }));
    expect(anomaly.title).toContain("last 168h");
  });
});
