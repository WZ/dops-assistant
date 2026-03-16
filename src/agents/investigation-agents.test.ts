import { describe, it, expect } from "vitest";
import type { LanguageModel } from "ai";
import { createAnomalyDetectorAgent, extractTimeRangeViaLlm } from "./anomaly-detector.js";
import { createPlannerAgent } from "./planner.js";
import { createMetricsAgent } from "./metrics.js";
import { createLogsAgent } from "./logs.js";
import { createInfraAgent } from "./infra.js";
import { createSynthesisAgent } from "./synthesis.js";

const fakeModel = {} as LanguageModel;

describe("createAnomalyDetectorAgent", () => {
  it("creates an agent with name 'anomaly-detector'", () => {
    const agent = createAnomalyDetectorAgent({ model: fakeModel });
    expect(agent.name).toBe("anomaly-detector");
  });

  it("creates an agent with id 'anomaly-detector'", () => {
    const agent = createAnomalyDetectorAgent({ model: fakeModel });
    expect(agent.id).toBe("anomaly-detector");
  });

  it("creates without error when useQuirkHandling is true", () => {
    const agent = createAnomalyDetectorAgent({ model: fakeModel, useQuirkHandling: true });
    expect(agent).toBeDefined();
  });
});

describe("extractTimeRangeViaLlm", () => {
  it("returns from/to ISO strings", () => {
    const result = extractTimeRangeViaLlm("any message");
    expect(result.from).toBeDefined();
    expect(result.to).toBeDefined();
    expect(new Date(result.from).toISOString()).toBe(result.from);
    expect(new Date(result.to).toISOString()).toBe(result.to);
  });

  it("defaults to last 8 hours when no time reference", () => {
    const before = Date.now();
    const result = extractTimeRangeViaLlm("show me the error rate");
    const after = Date.now();
    const fromMs = new Date(result.from).getTime();
    const toMs = new Date(result.to).getTime();
    const diffHours = (toMs - fromMs) / 3600000;
    expect(diffHours).toBeCloseTo(8, 0);
    expect(toMs).toBeGreaterThanOrEqual(before);
    expect(toMs).toBeLessThanOrEqual(after);
  });

  it("parses 'last 2 hours' to a ~2 hour range", () => {
    const result = extractTimeRangeViaLlm("what happened in the last 2 hours");
    const fromMs = new Date(result.from).getTime();
    const toMs = new Date(result.to).getTime();
    const diffHours = (toMs - fromMs) / 3600000;
    expect(diffHours).toBeCloseTo(2, 0);
  });

  it("parses 'last 1 day' to a ~24 hour range", () => {
    const result = extractTimeRangeViaLlm("errors in last 1 day");
    const fromMs = new Date(result.from).getTime();
    const toMs = new Date(result.to).getTime();
    const diffHours = (toMs - fromMs) / 3600000;
    expect(diffHours).toBeCloseTo(24, 0);
  });
});

describe("createPlannerAgent", () => {
  it("creates an agent with name 'planner'", () => {
    const agent = createPlannerAgent({ model: fakeModel });
    expect(agent.name).toBe("planner");
  });

  it("creates an agent with id 'planner'", () => {
    const agent = createPlannerAgent({ model: fakeModel });
    expect(agent.id).toBe("planner");
  });
});

describe("createMetricsAgent", () => {
  it("creates an agent with name 'metrics'", () => {
    const agent = createMetricsAgent({ model: fakeModel });
    expect(agent.name).toBe("metrics");
  });

  it("creates an agent with id 'metrics'", () => {
    const agent = createMetricsAgent({ model: fakeModel });
    expect(agent.id).toBe("metrics");
  });
});

describe("createLogsAgent", () => {
  it("creates an agent with name 'logs'", () => {
    const agent = createLogsAgent({ model: fakeModel });
    expect(agent.name).toBe("logs");
  });

  it("creates an agent with id 'logs'", () => {
    const agent = createLogsAgent({ model: fakeModel });
    expect(agent.id).toBe("logs");
  });
});

describe("createInfraAgent", () => {
  it("creates an agent with name 'infra'", () => {
    const agent = createInfraAgent({ model: fakeModel });
    expect(agent.name).toBe("infra");
  });

  it("creates an agent with id 'infra'", () => {
    const agent = createInfraAgent({ model: fakeModel });
    expect(agent.id).toBe("infra");
  });
});

describe("createSynthesisAgent", () => {
  it("creates an agent with name 'synthesis'", () => {
    const agent = createSynthesisAgent({ model: fakeModel });
    expect(agent.name).toBe("synthesis");
  });

  it("creates an agent with id 'synthesis'", () => {
    const agent = createSynthesisAgent({ model: fakeModel });
    expect(agent.id).toBe("synthesis");
  });
});
