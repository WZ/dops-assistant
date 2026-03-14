import { describe, it, expect } from "vitest";
import { InvestigationStateSchema } from "./workflow-state.js";

describe("InvestigationStateSchema", () => {
  it("validates minimal input state", () => {
    const result = InvestigationStateSchema.safeParse({
      userMessage: "why is payments slow?",
    });
    expect(result.success).toBe(true);
  });

  it("validates full state with all fields", () => {
    const result = InvestigationStateSchema.safeParse({
      userMessage: "investigate latency",
      alertContext: { alertName: "HighLatency", labels: {} },
      prefetchedContext: {
        datasourceHints: "",
        dashboardContext: "",
        panelQueryHints: "",
        logLabelHints: "",
        workingLogSelectors: [],
      },
      anomalies: { isAnomaly: true, timeRange: { from: "now-1h", to: "now" }, summary: "test", affectedServices: [] },
      recentIncidents: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing userMessage", () => {
    const result = InvestigationStateSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
