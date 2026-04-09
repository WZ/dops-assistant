import { describe, it, expect } from "vitest";
import { buildExploreUrl, buildPhaseLink, extractQueryFromToolCall, buildPhaseActions } from "./grafana-links.js";

describe("buildExploreUrl", () => {
  it("builds panes format URL with ISO timestamps", () => {
    const url = buildExploreUrl({
      webUrl: "https://grafana.example.com",
      datasource: "prometheus",
      query: 'rate(http_requests_total{service="api"}[5m])',
      from: "2026-04-08T17:30:00Z",
      to: "2026-04-08T17:35:00Z",
    });
    expect(url).toContain("schemaVersion=1");
    expect(url).toContain("panes=");
    expect(url).toContain("grafana.example.com/explore");
    expect(url).toContain("prometheus");
    expect(url).toContain("http_requests_total");
  });

  it("builds URL with epoch ms timestamps", () => {
    const url = buildExploreUrl({
      webUrl: "https://grafana.example.com",
      query: "up",
      from: "1712596200000",
      to: "1712596500000",
    });
    expect(url).toContain("1712596200000");
    expect(url).toContain("1712596500000");
  });

  it("returns empty string for invalid timestamps", () => {
    const url = buildExploreUrl({
      webUrl: "https://grafana.example.com",
      query: "up",
      from: "not-a-date",
      to: "also-not-a-date",
    });
    expect(url).toBe("");
  });

  it("strips trailing slashes from webUrl", () => {
    const url = buildExploreUrl({
      webUrl: "https://grafana.example.com///",
      query: "up",
      from: "2026-04-08T17:30:00Z",
      to: "2026-04-08T17:35:00Z",
    });
    expect(url).toContain("grafana.example.com/explore");
    expect(url).not.toContain("///");
  });
});

describe("buildPhaseLink", () => {
  it("builds Loki link for logs role", () => {
    const url = buildPhaseLink({
      webUrl: "https://grafana.example.com",
      service: "ingestion-server",
      from: "2026-04-08T17:30:00Z",
      to: "2026-04-08T17:35:00Z",
      role: "logs",
    });
    expect(url).toContain("ingestion-server");
    expect(url).toContain("error%7Cexception%7Cfail");
    expect(url).toContain("loki");
  });

  it("builds Prometheus link for metrics role", () => {
    const url = buildPhaseLink({
      webUrl: "https://grafana.example.com",
      service: "api",
      from: "2026-04-08T17:30:00Z",
      to: "2026-04-08T17:35:00Z",
      role: "metrics",
    });
    expect(url).toContain("api");
    expect(url).toContain("Prometheus");
  });
});

describe("extractQueryFromToolCall", () => {
  it("extracts expr from query_prometheus args", () => {
    const result = extractQueryFromToolCall(
      "query_prometheus",
      JSON.stringify({ expr: 'rate(http_errors[5m])', startTime: "2026-04-08T17:30:00Z" }),
    );
    expect(result).toEqual({ query: 'rate(http_errors[5m])', datasource: undefined });
  });

  it("extracts logql from query_loki_logs args", () => {
    const result = extractQueryFromToolCall(
      "query_loki_logs",
      JSON.stringify({ logql: '{app="api"} |= "error"', limit: 50 }),
    );
    expect(result).toEqual({ query: '{app="api"} |= "error"', datasource: undefined });
  });

  it("returns null for unrecognized args", () => {
    const result = extractQueryFromToolCall(
      "list_pods",
      JSON.stringify({ namespace: "default" }),
    );
    expect(result).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    const result = extractQueryFromToolCall("query_prometheus", "not json");
    expect(result).toBeNull();
  });
});

describe("buildPhaseActions", () => {
  const providers = [
    { role: "metrics", webUrl: "https://grafana.example.com", datasource: "prometheus" },
    { role: "logs", webUrl: "https://grafana.example.com", datasource: "loki" },
  ];
  const timeRange = { from: "2026-04-08T17:30:00Z", to: "2026-04-08T17:35:00Z" };

  it("builds phase actions for each provider", () => {
    const { phaseActions } = buildPhaseActions([], providers, "api", timeRange);
    expect(phaseActions.metrics).toBeDefined();
    expect(phaseActions.metrics.tier).toBe("phase");
    expect(phaseActions.logs).toBeDefined();
    expect(phaseActions.logs.tier).toBe("phase");
  });

  it("extracts observation actions from tool calls", () => {
    const toolCalls = [
      { tool: "query_prometheus", args: JSON.stringify({ expr: "up{service=\"api\"}" }), resultChars: 100 },
    ];
    const { observationActions } = buildPhaseActions(toolCalls, providers, "api", timeRange);
    expect(observationActions.length).toBe(1);
    expect(observationActions[0].tier).toBe("observation");
    expect(observationActions[0].url).toContain("up");
  });

  it("returns empty when no timeRange", () => {
    const { phaseActions, observationActions } = buildPhaseActions([], providers, "api", undefined);
    expect(Object.keys(phaseActions)).toHaveLength(0);
    expect(observationActions).toHaveLength(0);
  });

  it("handles undefined toolCalls gracefully", () => {
    const { phaseActions } = buildPhaseActions(undefined, providers, "api", timeRange);
    expect(phaseActions.metrics).toBeDefined();
  });
});
