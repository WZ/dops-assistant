import { describe, it, expect } from "vitest";
import {
  buildMetricDeepDivePrompt,
  buildLogCorrelationPrompt,
  buildInfraHealthPrompt,
  RCA_SYNTHESIS_PROMPT,
  buildIntentClassifierPrompt,
  INVESTIGATION_PLAN_PROMPT,
  RCA_REFLECTION_PROMPT,
  METRIC_FINDINGS_SCHEMA,
  LOG_FINDINGS_SCHEMA,
  INFRA_FINDINGS_SCHEMA,
  RCA_REPORT_SCHEMA,
  INTENT_RESPONSE_FORMAT,
  INVESTIGATION_PLAN_SCHEMA,
  RCA_REFLECTION_SCHEMA,
} from "./rca-prompts.js";

const testService = {
  name: "payments-api",
  metrics: [{ query: 'rate(errors[5m])', description: "error rate" }],
  logLabels: { app: "payments-api" },
};

describe("RCA prompt builders", () => {
  it("buildMetricDeepDivePrompt includes service name and metrics", () => {
    const prompt = buildMetricDeepDivePrompt(testService, "High error rate");
    expect(prompt).toContain("payments-api");
    expect(prompt).toContain("rate(errors[5m])");
    expect(prompt).toContain("error rate");
    expect(prompt).toContain("JSON");
    expect(prompt).toContain("query_prometheus");
  });

  it("buildMetricDeepDivePrompt includes plan focus areas when provided", () => {
    const prompt = buildMetricDeepDivePrompt(testService, "High error rate", ["Check p99 latency", "Monitor connection pool"]);
    expect(prompt).toContain("PLANNED FOCUS AREAS");
    expect(prompt).toContain("Check p99 latency");
    expect(prompt).toContain("Monitor connection pool");
  });

  it("buildLogCorrelationPrompt includes service log labels", () => {
    const prompt = buildLogCorrelationPrompt(testService, "High error rate");
    expect(prompt).toContain("payments-api");
    expect(prompt).toContain('"app"');
    expect(prompt).toContain("JSON");
    expect(prompt).toContain("log");
  });

  it("buildLogCorrelationPrompt includes plan focus areas when provided", () => {
    const prompt = buildLogCorrelationPrompt(testService, "High error rate", ["Search for timeout errors"]);
    expect(prompt).toContain("PLANNED FOCUS AREAS");
    expect(prompt).toContain("Search for timeout errors");
  });

  it("buildInfraHealthPrompt includes service name", () => {
    const prompt = buildInfraHealthPrompt(testService, "High error rate");
    expect(prompt).toContain("payments-api");
    expect(prompt).toContain("pod");
    expect(prompt).toContain("JSON");
  });

  it("buildInfraHealthPrompt includes plan focus areas when provided", () => {
    const prompt = buildInfraHealthPrompt(testService, "High error rate", ["Check OOMKilled pods"]);
    expect(prompt).toContain("PLANNED FOCUS AREAS");
    expect(prompt).toContain("Check OOMKilled pods");
  });
});

describe("RCA prompt builders – edge cases", () => {
  const emptyService = { name: "bare-service", metrics: [], logLabels: {} };

  it("buildMetricDeepDivePrompt handles service with no metrics", () => {
    const prompt = buildMetricDeepDivePrompt(emptyService, "Something broke");
    expect(prompt).toContain("bare-service");
    expect(prompt).toContain("(no pre-configured metrics)");
    expect(prompt).not.toContain("PLANNED FOCUS AREAS");
  });

  it("buildLogCorrelationPrompt handles service with empty logLabels", () => {
    const prompt = buildLogCorrelationPrompt(emptyService, "Something broke");
    expect(prompt).toContain("bare-service");
    expect(prompt).toContain("{}");
  });

  it("buildInfraHealthPrompt handles service with no config", () => {
    const prompt = buildInfraHealthPrompt(emptyService, "Something broke");
    expect(prompt).toContain("bare-service");
  });

  it("prompt builders omit focus section when planFocus is empty array", () => {
    const metricPrompt = buildMetricDeepDivePrompt(testService, "issue", []);
    const logPrompt = buildLogCorrelationPrompt(testService, "issue", []);
    const infraPrompt = buildInfraHealthPrompt(testService, "issue", []);
    expect(metricPrompt).not.toContain("PLANNED FOCUS AREAS");
    expect(logPrompt).not.toContain("PLANNED FOCUS AREAS");
    expect(infraPrompt).not.toContain("PLANNED FOCUS AREAS");
  });
});

describe("RCA prompt constants", () => {
  it("RCA_SYNTHESIS_PROMPT instructs SRE-standard reasoning", () => {
    expect(RCA_SYNTHESIS_PROMPT).toContain("root cause");
    expect(RCA_SYNTHESIS_PROMPT).toContain("TIMELINE");
    expect(RCA_SYNTHESIS_PROMPT).toContain("TRIGGER vs ROOT CAUSE");
    expect(RCA_SYNTHESIS_PROMPT).toContain("CONTRIBUTING FACTORS");
    expect(RCA_SYNTHESIS_PROMPT).toContain("IMPACT");
    expect(RCA_SYNTHESIS_PROMPT).toContain("VALIDATE");
    expect(RCA_SYNTHESIS_PROMPT).toContain("JSON");
  });

  it("buildIntentClassifierPrompt instructs intent classification", () => {
    const prompt = buildIntentClassifierPrompt();
    expect(prompt).toContain("investigation");
    expect(prompt).toContain("JSON");
  });

  it("buildIntentClassifierPrompt includes few-shot examples", () => {
    const prompt = buildIntentClassifierPrompt();
    expect(prompt).toContain("EXAMPLES");
    expect(prompt).toContain("connection errors");
    expect(prompt).toContain("what dashboards");
  });

  it("buildIntentClassifierPrompt includes symptom and error patterns", () => {
    const prompt = buildIntentClassifierPrompt();
    expect(prompt).toContain("slow");
    expect(prompt).toContain("error");
    expect(prompt).toContain("check");
  });

  it("buildIntentClassifierPrompt includes service names when provided", () => {
    const prompt = buildIntentClassifierPrompt(["ingestion-server", "payments-api"]);
    expect(prompt).toContain("known services");
    expect(prompt).toContain("ingestion-server");
    expect(prompt).toContain("payments-api");
  });

  it("INVESTIGATION_PLAN_PROMPT instructs planning", () => {
    expect(INVESTIGATION_PLAN_PROMPT).toContain("investigation plan");
    expect(INVESTIGATION_PLAN_PROMPT).toContain("root causes");
    expect(INVESTIGATION_PLAN_PROMPT).toContain("JSON");
  });

  it("RCA_REFLECTION_PROMPT instructs self-critique", () => {
    expect(RCA_REFLECTION_PROMPT).toContain("root cause");
    expect(RCA_REFLECTION_PROMPT).toContain("contradictory");
    expect(RCA_REFLECTION_PROMPT).toContain("confidence");
    expect(RCA_REFLECTION_PROMPT).toContain("JSON");
  });
});

describe("RCA schemas", () => {
  it("METRIC_FINDINGS_SCHEMA has structured observation objects", () => {
    const schema = METRIC_FINDINGS_SCHEMA.json_schema.schema as { required: string[]; properties: Record<string, unknown> };
    expect(schema.required).toContain("observations");
    expect(schema.required).toContain("anomalyWindow");
    expect(schema.required).toContain("summary");
    // observations should contain objects, not strings
    const obs = schema.properties.observations as { items: { properties: Record<string, unknown> } };
    expect(obs.items.properties).toHaveProperty("metric");
    expect(obs.items.properties).toHaveProperty("currentValue");
    expect(obs.items.properties).toHaveProperty("severity");
  });

  it("LOG_FINDINGS_SCHEMA has structured observation objects", () => {
    const schema = LOG_FINDINGS_SCHEMA.json_schema.schema as { required: string[]; properties: Record<string, unknown> };
    expect(schema.required).toContain("observations");
    expect(schema.required).toContain("summary");
    const obs = schema.properties.observations as { items: { properties: Record<string, unknown> } };
    expect(obs.items.properties).toHaveProperty("pattern");
    expect(obs.items.properties).toHaveProperty("count");
    expect(obs.items.properties).toHaveProperty("sample");
    expect(obs.items.properties).toHaveProperty("sampleLines");
  });

  it("INFRA_FINDINGS_SCHEMA has structured observation objects", () => {
    const schema = INFRA_FINDINGS_SCHEMA.json_schema.schema as { required: string[]; properties: Record<string, unknown> };
    expect(schema.required).toContain("observations");
    expect(schema.required).toContain("summary");
    const obs = schema.properties.observations as { items: { properties: Record<string, unknown> } };
    expect(obs.items.properties).toHaveProperty("resource");
    expect(obs.items.properties).toHaveProperty("status");
    expect(obs.items.properties).toHaveProperty("timestamp");
  });

  it("INVESTIGATION_PLAN_SCHEMA has hypotheses and focus areas", () => {
    const schema = INVESTIGATION_PLAN_SCHEMA.json_schema.schema as { required: string[] };
    expect(schema.required).toContain("hypotheses");
    expect(schema.required).toContain("metricFocus");
    expect(schema.required).toContain("logFocus");
    expect(schema.required).toContain("infraFocus");
  });

  it("RCA_REFLECTION_SCHEMA has validation and revision fields", () => {
    const schema = RCA_REFLECTION_SCHEMA.json_schema.schema as { required: string[] };
    expect(schema.required).toContain("validationNotes");
    expect(schema.required).toContain("revisedRootCause");
    expect(schema.required).toContain("revisedTrigger");
    expect(schema.required).toContain("revisedConfidence");
    expect(schema.required).toContain("issues");
  });

  it("RCA_REPORT_SCHEMA has required fields", () => {
    const schema = RCA_REPORT_SCHEMA.json_schema.schema as { required: string[] };
    expect(schema.required).toContain("rootCause");
    expect(schema.required).toContain("trigger");
    expect(schema.required).toContain("impact");
    expect(schema.required).toContain("contributingFactors");
    expect(schema.required).toContain("timeline");
    expect(schema.required).toContain("confidence");
    expect(schema.required).toContain("recommendedActions");
    expect(schema.required).toContain("evidence");
    expect(schema.required).toContain("dashboardLinks");
  });
});
