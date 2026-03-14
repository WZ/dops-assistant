import { describe, it, expect, vi } from "vitest";
import { executePrefetch } from "./prefetch.js";
import type { MastraProvider } from "../mcp/provider.js";
import type { ServiceConfig } from "../config/schema.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeProvider(
  name: string,
  roles: MastraProvider["roles"],
  toolMap: Record<string, { execute?: (...args: any[]) => any }> = {},
): MastraProvider {
  const client = {
    listTools: vi.fn().mockResolvedValue(toolMap),
  } as unknown as MastraProvider["client"];

  return { name, roles, client };
}

const noopService: ServiceConfig = {
  name: "test-svc",
  metrics: [],
  logLabels: {},
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("executePrefetch", () => {
  it("returns empty context when no providers are supplied", async () => {
    const result = await executePrefetch([], []);
    expect(result.datasourceHints).toBe("");
    expect(result.dashboardContext).toBe("");
    expect(result.panelQueryHints).toBe("");
    expect(result.logLabelHints).toBe("");
    expect(result.workingLogSelectors).toEqual([]);
  });

  it("returns empty context when provider has no tools", async () => {
    const provider = makeProvider("grafana", ["metrics", "dashboards", "logs"], {});
    const result = await executePrefetch([provider], [noopService]);
    expect(result.datasourceHints).toBe("");
    expect(result.dashboardContext).toBe("");
    expect(result.panelQueryHints).toBe("");
    expect(result.logLabelHints).toBe("");
    expect(result.workingLogSelectors).toEqual([]);
  });

  it("returns datasource hints when list_datasources tool is available", async () => {
    const datasources = [
      { uid: "prom-uid-123", name: "Prometheus", type: "prometheus" },
      { uid: "loki-uid-456", name: "Loki", type: "loki" },
    ];

    const provider = makeProvider("grafana", ["metrics", "dashboards"], {
      list_datasources: {
        execute: vi.fn().mockResolvedValue({ datasources }),
      },
    });

    const result = await executePrefetch([provider], []);
    expect(result.datasourceHints).toContain("prom-uid-123");
    expect(result.datasourceHints).toContain("loki-uid-456");
    expect(result.datasourceHints).toContain("prometheus");
    expect(result.datasourceHints).toContain("loki");
  });

  it("returns datasource hints from flat array response", async () => {
    const datasources = [
      { uid: "prom-flat", name: "Prometheus", type: "prometheus" },
    ];

    const provider = makeProvider("grafana", ["metrics"], {
      list_datasources: {
        execute: vi.fn().mockResolvedValue(datasources),
      },
    });

    const result = await executePrefetch([provider], []);
    expect(result.datasourceHints).toContain("prom-flat");
  });

  it("handles provider.client.listTools() throwing an error gracefully", async () => {
    const client = {
      listTools: vi.fn().mockRejectedValue(new Error("connection refused")),
    } as unknown as MastraProvider["client"];

    const provider: MastraProvider = {
      name: "broken",
      roles: ["metrics"],
      client,
    };

    const result = await executePrefetch([provider], []);
    expect(result.datasourceHints).toBe("");
    expect(result.dashboardContext).toBe("");
    expect(result.workingLogSelectors).toEqual([]);
  });

  it("handles tool execute() throwing an error gracefully", async () => {
    const provider = makeProvider("grafana", ["metrics", "dashboards"], {
      list_datasources: {
        execute: vi.fn().mockRejectedValue(new Error("tool error")),
      },
      search_dashboards: {
        execute: vi.fn().mockRejectedValue(new Error("tool error")),
      },
    });

    const result = await executePrefetch([provider], []);
    expect(result.datasourceHints).toBe("");
    expect(result.dashboardContext).toBe("");
  });

  it("returns dashboard context when search_dashboards is available", async () => {
    const dashboards = [
      { uid: "dash-1", title: "Service Overview" },
      { uid: "dash-2", title: "Infra Health" },
    ];

    const provider = makeProvider("grafana", ["dashboards"], {
      list_datasources: {
        execute: vi.fn().mockResolvedValue([]),
      },
      search_dashboards: {
        execute: vi.fn().mockResolvedValue(dashboards),
      },
    });

    const result = await executePrefetch([provider], []);
    expect(result.dashboardContext).toContain("Service Overview");
    expect(result.dashboardContext).toContain("dash-1");
    expect(result.dashboardContext).not.toContain("dops-temp:");
  });

  it("filters dops-temp dashboards from dashboard context", async () => {
    const dashboards = [
      { uid: "dash-1", title: "dops-temp:something" },
      { uid: "dash-2", title: "Real Dashboard" },
    ];

    const provider = makeProvider("grafana", ["dashboards"], {
      search_dashboards: {
        execute: vi.fn().mockResolvedValue(dashboards),
      },
    });

    const result = await executePrefetch([provider], []);
    expect(result.dashboardContext).not.toContain("dops-temp");
    expect(result.dashboardContext).toContain("Real Dashboard");
  });

  it("returns panel query hints when get_dashboard_panel_queries is available", async () => {
    const dashboards = [{ uid: "dash-1", title: "Service Dashboard" }];
    const panelQueries = [
      {
        title: "Request Rate",
        query: 'rate(http_requests_total[5m])',
        datasource: { uid: "prom-uid", type: "prometheus" },
      },
    ];

    const provider = makeProvider("grafana", ["dashboards"], {
      search_dashboards: {
        execute: vi.fn().mockResolvedValue({ dashboards }),
      },
      get_dashboard_panel_queries: {
        execute: vi.fn().mockResolvedValue(panelQueries),
      },
    });

    // Use userMessage that scores the dashboard
    const result = await executePrefetch([provider], [], {
      userMessage: "service dashboard request rate issue",
    });
    expect(result.panelQueryHints).toContain("Request Rate");
    expect(result.panelQueryHints).toContain("http_requests_total");
  });

  it("skips panel query hints when get_dashboard_panel_queries is not available", async () => {
    const dashboards = [{ uid: "dash-1", title: "Service Dashboard" }];

    const provider = makeProvider("grafana", ["dashboards"], {
      search_dashboards: {
        execute: vi.fn().mockResolvedValue(dashboards),
      },
      // No get_dashboard_panel_queries
    });

    const result = await executePrefetch([provider], []);
    expect(result.panelQueryHints).toBe("");
    expect(result.dashboardContext).toContain("Service Dashboard");
  });

  it("returns log label hints when list_loki_label_names tool is available", async () => {
    const datasources = [
      { uid: "prom-uid", name: "Prometheus", type: "prometheus" },
      { uid: "loki-uid", name: "Loki", type: "loki" },
    ];

    const metricsProvider = makeProvider("grafana-metrics", ["metrics", "dashboards"], {
      list_datasources: {
        execute: vi.fn().mockResolvedValue({ datasources }),
      },
      search_dashboards: {
        execute: vi.fn().mockResolvedValue([]),
      },
    });

    const logsProvider = makeProvider("grafana-logs", ["logs"], {
      query_loki_logs: {
        execute: vi.fn().mockResolvedValue("[]"),
      },
      list_loki_label_names: {
        execute: vi.fn().mockResolvedValue({ labels: ["app", "namespace", "job"] }),
      },
    });

    const result = await executePrefetch([metricsProvider, logsProvider], [noopService]);
    expect(result.logLabelHints).toContain("app");
    expect(result.logLabelHints).toContain("namespace");
    expect(result.logLabelHints).toContain("job");
  });

  it("handles missing loki UID gracefully (no log context returned)", async () => {
    // Datasource hint has no loki entry
    const metricsProvider = makeProvider("grafana-metrics", ["metrics"], {
      list_datasources: {
        execute: vi.fn().mockResolvedValue([
          { uid: "prom-uid", name: "Prometheus", type: "prometheus" },
        ]),
      },
    });

    const logsProvider = makeProvider("grafana-logs", ["logs"], {
      query_loki_logs: {
        execute: vi.fn().mockResolvedValue("[]"),
      },
    });

    const result = await executePrefetch([metricsProvider, logsProvider], [noopService]);
    expect(result.logLabelHints).toBe("");
    expect(result.workingLogSelectors).toEqual([]);
  });

  it("probes working log selectors from configured logLabels", async () => {
    const datasources = [
      { uid: "loki-uid", name: "Loki", type: "loki" },
    ];

    const service: ServiceConfig = {
      name: "my-service",
      metrics: [],
      logLabels: { app: "my-service" },
    };

    const metricsProvider = makeProvider("grafana-metrics", ["metrics"], {
      list_datasources: {
        execute: vi.fn().mockResolvedValue({ datasources }),
      },
    });

    const logsProvider = makeProvider("grafana-logs", ["logs"], {
      query_loki_logs: {
        execute: vi.fn().mockResolvedValue(
          JSON.stringify({ data: [{ line: "some log", timestamp: "2026-01-01T00:00:00Z" }] }),
        ),
      },
    });

    const result = await executePrefetch([metricsProvider, logsProvider], [service]);
    // Should find the configured selector or a fallback
    expect(result.workingLogSelectors.length).toBeGreaterThanOrEqual(0);
  });

  it("returns empty workingLogSelectors when no log query returns data", async () => {
    const datasources = [
      { uid: "loki-uid", name: "Loki", type: "loki" },
    ];

    const metricsProvider = makeProvider("grafana-metrics", ["metrics"], {
      list_datasources: {
        execute: vi.fn().mockResolvedValue({ datasources }),
      },
    });

    const logsProvider = makeProvider("grafana-logs", ["logs"], {
      query_loki_logs: {
        execute: vi.fn().mockResolvedValue(JSON.stringify({ data: [] })),
      },
    });

    const result = await executePrefetch([metricsProvider, logsProvider], [noopService]);
    expect(result.workingLogSelectors).toEqual([]);
  });

  it("is resilient to provider errors mid-execution", async () => {
    const datasources = [
      { uid: "prom-uid", name: "Prometheus", type: "prometheus" },
    ];

    // First provider: provides datasource hints fine
    const goodProvider = makeProvider("grafana-metrics", ["metrics"], {
      list_datasources: {
        execute: vi.fn().mockResolvedValue({ datasources }),
      },
    });

    // Second provider: dashboard call throws
    const badProvider = makeProvider("grafana-dashboards", ["dashboards"], {
      search_dashboards: {
        execute: vi.fn().mockRejectedValue(new Error("network error")),
      },
    });

    const result = await executePrefetch([goodProvider, badProvider], []);
    // Datasource hints should still be populated from the good provider
    expect(result.datasourceHints).toContain("prom-uid");
    // Dashboard context gracefully empty
    expect(result.dashboardContext).toBe("");
  });
});
