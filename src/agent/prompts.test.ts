import { describe, it, expect } from "vitest";
import {
  buildSystemPrompt,
  buildProactiveStructuredPrompt,
  ANOMALY_ASSESSMENT_RESPONSE_FORMAT,
} from "./prompts.js";

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
    const prompt = buildProactiveStructuredPrompt([]);
    expect(typeof prompt).toBe("string");
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
