import { describe, it, expect } from "vitest";
import {
  METRIC_DEEP_DIVE_PROMPT,
  LOG_CORRELATION_PROMPT,
  INFRA_HEALTH_PROMPT,
  RCA_SYNTHESIS_PROMPT,
  INTENT_CLASSIFIER_PROMPT,
  METRIC_FINDINGS_SCHEMA,
  LOG_FINDINGS_SCHEMA,
  INFRA_FINDINGS_SCHEMA,
  RCA_REPORT_SCHEMA,
  INTENT_RESPONSE_FORMAT,
} from "./rca-prompts.js";

describe("RCA prompts", () => {
  it("METRIC_DEEP_DIVE_PROMPT instructs metric analysis", () => {
    expect(METRIC_DEEP_DIVE_PROMPT).toContain("metrics");
    expect(METRIC_DEEP_DIVE_PROMPT).toContain("JSON");
  });

  it("LOG_CORRELATION_PROMPT instructs log analysis", () => {
    expect(LOG_CORRELATION_PROMPT).toContain("logs");
    expect(LOG_CORRELATION_PROMPT).toContain("JSON");
  });

  it("INFRA_HEALTH_PROMPT instructs infra analysis", () => {
    expect(INFRA_HEALTH_PROMPT).toContain("pod");
    expect(INFRA_HEALTH_PROMPT).toContain("JSON");
  });

  it("RCA_SYNTHESIS_PROMPT instructs root cause synthesis", () => {
    expect(RCA_SYNTHESIS_PROMPT).toContain("root cause");
    expect(RCA_SYNTHESIS_PROMPT).toContain("JSON");
  });

  it("INTENT_CLASSIFIER_PROMPT instructs intent classification", () => {
    expect(INTENT_CLASSIFIER_PROMPT).toContain("investigation");
    expect(INTENT_CLASSIFIER_PROMPT).toContain("JSON");
  });

  it("METRIC_FINDINGS_SCHEMA has required fields", () => {
    const schema = METRIC_FINDINGS_SCHEMA.json_schema.schema as { required: string[] };
    expect(schema.required).toContain("observations");
    expect(schema.required).toContain("baseline");
    expect(schema.required).toContain("anomalyWindow");
  });

  it("RCA_REPORT_SCHEMA has required fields", () => {
    const schema = RCA_REPORT_SCHEMA.json_schema.schema as { required: string[] };
    expect(schema.required).toContain("rootCause");
    expect(schema.required).toContain("confidence");
    expect(schema.required).toContain("recommendedActions");
    expect(schema.required).toContain("evidence");
  });

  it("LOG_FINDINGS_SCHEMA has logSamples and lokiSearchTerms fields", () => {
    const schema = LOG_FINDINGS_SCHEMA.json_schema.schema as { required: string[] };
    expect(schema.required).toContain("logSamples");
    expect(schema.required).toContain("lokiSearchTerms");
  });

  it("RCA_REPORT_SCHEMA has dashboardLinks field", () => {
    const schema = RCA_REPORT_SCHEMA.json_schema.schema as { required: string[] };
    expect(schema.required).toContain("dashboardLinks");
  });

  it("LOG_CORRELATION_PROMPT instructs LLM to collect raw log samples", () => {
    expect(LOG_CORRELATION_PROMPT).toContain("raw log");
  });

  it("METRIC_DEEP_DIVE_PROMPT instructs LLM to include dashboard URL", () => {
    expect(METRIC_DEEP_DIVE_PROMPT).toContain("dashboard");
    expect(METRIC_DEEP_DIVE_PROMPT).toContain("URL");
  });
});
