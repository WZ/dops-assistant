import { describe, it, expect } from "vitest";
import { DISCOVERY_PROMPT, DISCOVERED_SERVICES_SCHEMA, buildDiscoveryUserMessage } from "./discovery-prompts.js";
import type { DiscoveryConfig } from "../config/schema.js";

describe("discovery-prompts", () => {
  it("DISCOVERY_PROMPT is a non-empty string", () => {
    expect(DISCOVERY_PROMPT.length).toBeGreaterThan(100);
  });

  it("DISCOVERED_SERVICES_SCHEMA has correct structure", () => {
    expect(DISCOVERED_SERVICES_SCHEMA.type).toBe("json_schema");
    expect(DISCOVERED_SERVICES_SCHEMA.json_schema.name).toBe("discovered_services");
  });

  it("buildDiscoveryUserMessage includes consul metric and exclusions", () => {
    const cfg: DiscoveryConfig = {
      autoRefresh: false,
      excludeServices: ["consul", "grafana"],
      consulMetric: "consul_catalog_service_node_healthy",
    };
    const msg = buildDiscoveryUserMessage(cfg);
    expect(msg).toContain("consul_catalog_service_node_healthy");
    expect(msg).toContain("consul");
    expect(msg).toContain("grafana");
  });
});
