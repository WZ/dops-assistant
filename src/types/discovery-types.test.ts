import { describe, it, expect } from "vitest";
import { ValidatedServiceConfigSchema, ServiceRegistryVersionSchema } from "./discovery-types.js";

describe("ValidatedServiceConfig", () => {
  it("parses a verified service", () => {
    const result = ValidatedServiceConfigSchema.safeParse({
      name: "ingestion-server",
      metrics: [{ query: "up{job='ingestion'}", description: "health" }],
      logLabels: { app: "ingestion-server" },
      confidence: "verified",
      validationNotes: "metrics ✓ logs ✓",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid confidence level", () => {
    const result = ValidatedServiceConfigSchema.safeParse({
      name: "svc",
      metrics: [],
      logLabels: {},
      confidence: "unknown",
      validationNotes: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("ServiceRegistryVersion", () => {
  it("parses a version entry", () => {
    const result = ServiceRegistryVersionSchema.safeParse({
      id: "01JQ7K",
      timestamp: "2026-03-14T10:30:00Z",
      services: [{ name: "svc", metrics: [], logLabels: {} }],
      source: "discovery",
      serviceCount: 1,
    });
    expect(result.success).toBe(true);
  });
});
