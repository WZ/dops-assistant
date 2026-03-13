import { describe, it, expect } from "vitest";
import {
  buildSystemPrompt,
  buildProactiveStructuredPrompt,
  ANOMALY_ASSESSMENT_RESPONSE_FORMAT,
} from "./prompts.js";

describe("buildSystemPrompt", () => {
  it("includes inline chart guidance only for inline-chart surfaces", () => {
    const prompt = buildSystemPrompt("conversational", [], undefined, true);
    expect(prompt).toContain("rendered as an inline chart automatically");
    expect(prompt).toContain("Charts are rendered automatically from the query results.");
  });

  it("avoids claiming inline chart rendering for CLI-style surfaces", () => {
    const prompt = buildSystemPrompt("conversational", [], undefined, false);
    expect(prompt).not.toContain("rendered as an inline chart automatically");
    expect(prompt).toContain("prefer image-producing Grafana tools");
    expect(prompt).toContain("do not promise automatic inline rendering");
  });
});

describe("buildProactiveStructuredPrompt", () => {
  it("includes service name and metrics", () => {
    const prompt = buildProactiveStructuredPrompt([
      {
        name: "payments-api",
        metrics: [{ query: 'rate(http_requests_total[5m])', description: "RPS" }],
        logLabels: { app: "payments" },
      },
    ]);
    expect(prompt).toContain("payments-api");
    expect(prompt).toContain("RPS");
    expect(prompt).toContain("json");
  });

  it("handles no services", () => {
    const promptEmpty = buildProactiveStructuredPrompt([]);
    expect(promptEmpty).toContain("No services configured.");
    const promptUndefined = buildProactiveStructuredPrompt(undefined);
    expect(promptUndefined).toContain("No services configured.");
  });
});

describe("ANOMALY_ASSESSMENT_RESPONSE_FORMAT", () => {
  it("is a json_schema response format", () => {
    expect(ANOMALY_ASSESSMENT_RESPONSE_FORMAT.type).toBe("json_schema");
    expect(ANOMALY_ASSESSMENT_RESPONSE_FORMAT.json_schema.name).toBe(
      "anomaly_assessment",
    );
    expect(ANOMALY_ASSESSMENT_RESPONSE_FORMAT.json_schema.strict).toBe(true);
  });

  it("schema requires all AnomalyAssessment fields", () => {
    const schema = ANOMALY_ASSESSMENT_RESPONSE_FORMAT.json_schema.schema as {
      required: string[];
    };
    expect(schema.required).toContain("isAnomaly");
    expect(schema.required).toContain("severity");
    expect(schema.required).toContain("summary");
    expect(schema.required).toContain("affectedMetrics");
    expect(schema.required).toContain("recommendedAction");
  });
});
