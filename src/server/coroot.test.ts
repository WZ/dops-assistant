import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  extractServiceName,
  mapCorootStatus,
  extractSloRates,
  fetchCorootNeighbors,
  resetCorootRegistryCache,
} from "./coroot.js";
import type { MastraProvider } from "../mcp/provider.js";
import type { ServiceConfig } from "../config/schema.js";

// Mock the role-based tool loader so we never touch real providers.
vi.mock("../mcp/provider.js", async (orig) => {
  const actual = await (orig as any)();
  return {
    ...actual,
    getToolsByRole: vi.fn(),
  };
});
import { getToolsByRole } from "../mcp/provider.js";
const mockGetToolsByRole = getToolsByRole as unknown as ReturnType<typeof vi.fn>;

// ── Pure helpers ────────────────────────────────────────────────────────────

describe("extractServiceName", () => {
  it("pulls the short name from a k8s-style Coroot ID", () => {
    expect(extractServiceName("default:Deployment:ingestion-server")).toBe("ingestion-server");
  });
  it("returns the same string when there are no colons", () => {
    expect(extractServiceName("plain-name")).toBe("plain-name");
  });
  it("handles external IDs", () => {
    expect(extractServiceName("external:ExternalService:payments.example.com")).toBe("payments.example.com");
  });
});

describe("mapCorootStatus", () => {
  it("maps known statuses", () => {
    expect(mapCorootStatus("ok")).toBe("healthy");
    expect(mapCorootStatus("warning")).toBe("degraded");
    expect(mapCorootStatus("critical")).toBe("unhealthy");
  });
  it("falls back to unknown for everything else", () => {
    expect(mapCorootStatus(undefined)).toBe("unknown");
    expect(mapCorootStatus("weird")).toBe("unknown");
  });
});

describe("extractSloRates", () => {
  it("pulls reqs/latency out of an SLO widget table", () => {
    const reports = [
      {
        name: "SLO",
        widgets: [
          {
            table: {
              rows: [
                {
                  cells: [
                    { value: "kafka-broker-0" },
                    { value: "ok" },
                    { value: "42" },
                    { value: "12ms" },
                  ],
                },
                {
                  cells: [
                    { value: "redis-primary" },
                    { value: "warning" },
                    { value: "8" },
                    { value: "3ms" },
                  ],
                },
              ],
            },
          },
        ],
      },
    ];
    const rates = extractSloRates(reports);
    expect(rates.get("kafka-broker-0")).toEqual({ reqs: "42", latency: "12ms" });
    expect(rates.get("redis-primary")).toEqual({ reqs: "8", latency: "3ms" });
  });

  it("returns empty map when no SLO report", () => {
    expect(extractSloRates([{ name: "Other" }]).size).toBe(0);
  });

  it("handles malformed reports gracefully", () => {
    expect(extractSloRates([]).size).toBe(0);
    expect(extractSloRates([null as any]).size).toBe(0);
  });
});

// ── fetchCorootNeighbors integration ─────────────────────────────────────────

interface MockTool {
  description?: string;
  execute: ReturnType<typeof vi.fn>;
}

function mcpEnvelope(json: unknown): unknown {
  return {
    content: [{ type: "text", text: JSON.stringify({ ...(json as object), success: true }) }],
  };
}

function makeToolMap(tools: Record<string, MockTool>): Record<string, unknown> {
  return tools;
}

const providers: MastraProvider[] = [];

describe("fetchCorootNeighbors", () => {
  beforeEach(() => {
    resetCorootRegistryCache();
    mockGetToolsByRole.mockReset();
  });

  it("returns null when no dependencies-role provider is configured", async () => {
    mockGetToolsByRole.mockResolvedValue({});
    const result = await fetchCorootNeighbors("ingestion-server", providers, []);
    expect(result).toBeNull();
  });

  it("returns null when get_application tool is absent", async () => {
    mockGetToolsByRole.mockResolvedValue(
      makeToolMap({
        list_projects: {
          execute: vi.fn().mockResolvedValue({ content: [{ type: "text", text: JSON.stringify({ projects: [{ id: "p1" }] }) }] }),
        },
      }),
    );
    const result = await fetchCorootNeighbors("ingestion-server", providers, []);
    expect(result).toBeNull();
  });

  it("returns null when app ID cannot be resolved", async () => {
    mockGetToolsByRole.mockResolvedValue(
      makeToolMap({
        list_projects: {
          execute: vi.fn().mockResolvedValue({ content: [{ type: "text", text: JSON.stringify({ projects: [{ id: "p1" }] }) }] }),
        },
        applications_overview: {
          execute: vi.fn().mockResolvedValue({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  overview: {
                    context: {
                      search: {
                        applications: [
                          { id: "default:Deployment:other-service", status: "ok" },
                        ],
                      },
                    },
                  },
                }),
              },
            ],
          }),
        },
        get_application: {
          execute: vi.fn(),
        },
      }),
    );
    const result = await fetchCorootNeighbors("ingestion-server", providers, []);
    expect(result).toBeNull();
  });

  it("parses neighbors from a successful get_application response", async () => {
    const appMap = {
      application: { icon: "box", status: "warning" },
      clients: [
        { id: "default:Deployment:web-frontend", status: "ok" },
      ],
      dependencies: [
        { id: "default:StatefulSet:kafka-broker-0", status: "critical" },
        { id: "default:StatefulSet:kafka-broker-1", status: "critical" },
      ],
    };
    const reports = [
      {
        name: "SLO",
        widgets: [
          {
            table: {
              rows: [
                { cells: [{ value: "kafka-broker-0" }, { value: "critical" }, { value: "25" }, { value: "5s" }] },
                { cells: [{ value: "web-frontend" }, { value: "ok" }, { value: "120" }, { value: "30ms" }] },
              ],
            },
          },
        ],
      },
    ];

    mockGetToolsByRole.mockResolvedValue(
      makeToolMap({
        list_projects: {
          execute: vi.fn().mockResolvedValue({
            content: [{ type: "text", text: JSON.stringify({ projects: [{ id: "p1" }] }) }],
          }),
        },
        applications_overview: {
          execute: vi.fn().mockResolvedValue({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  overview: {
                    context: {
                      search: {
                        applications: [
                          { id: "default:Deployment:ingestion-server", status: "warning" },
                        ],
                      },
                    },
                  },
                }),
              },
            ],
          }),
        },
        get_application: {
          execute: vi.fn().mockResolvedValue({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  application: { data: { app_map: appMap, reports } },
                }),
              },
            ],
          }),
        },
      }),
    );

    const services: ServiceConfig[] = [
      { name: "kafka-broker-0" } as any,
      { name: "kafka-broker-1" } as any,
    ];
    const result = await fetchCorootNeighbors("ingestion-server", providers, services);

    expect(result).not.toBeNull();
    expect(result).toHaveLength(3);

    const byName = new Map(result!.map((n) => [n.name, n]));

    // web-frontend is an upstream caller, not in registry, healthy, rate 120
    const web = byName.get("web-frontend");
    expect(web).toBeDefined();
    expect(web!.directions).toEqual(["upstream"]);
    expect(web!.status).toBe("healthy");
    expect(web!.inServiceRegistry).toBe(false);
    expect(web!.requestRate).toBe("120");

    // kafka-broker-0 is a downstream callee, in registry, unhealthy, rate 25
    const k0 = byName.get("kafka-broker-0");
    expect(k0).toBeDefined();
    expect(k0!.directions).toEqual(["downstream"]);
    expect(k0!.status).toBe("unhealthy");
    expect(k0!.inServiceRegistry).toBe(true);
    expect(k0!.requestRate).toBe("25");

    // kafka-broker-1 is also downstream, in registry, unhealthy, no rate
    const k1 = byName.get("kafka-broker-1");
    expect(k1).toBeDefined();
    expect(k1!.status).toBe("unhealthy");
    expect(k1!.inServiceRegistry).toBe(true);
    expect(k1!.requestRate).toBeUndefined();
  });

  it("dedupes bidirectional neighbors with worst-wins status", async () => {
    const appMap = {
      application: { icon: "box", status: "ok" },
      clients: [
        // foo appears as both client and dependency — bidirectional
        { id: "default:Deployment:foo", status: "ok" },
      ],
      dependencies: [
        { id: "default:Deployment:foo", status: "critical" },
      ],
    };
    mockGetToolsByRole.mockResolvedValue(
      makeToolMap({
        list_projects: {
          execute: vi.fn().mockResolvedValue({
            content: [{ type: "text", text: JSON.stringify({ projects: [{ id: "p1" }] }) }],
          }),
        },
        applications_overview: {
          execute: vi.fn().mockResolvedValue({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  overview: {
                    context: {
                      search: {
                        applications: [{ id: "default:Deployment:primary", status: "ok" }],
                      },
                    },
                  },
                }),
              },
            ],
          }),
        },
        get_application: {
          execute: vi.fn().mockResolvedValue({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  application: { data: { app_map: appMap, reports: [] } },
                }),
              },
            ],
          }),
        },
      }),
    );

    const result = await fetchCorootNeighbors("primary", providers, []);
    expect(result).toHaveLength(1);
    const foo = result![0]!;
    expect(foo.name).toBe("foo");
    expect(foo.directions.sort()).toEqual(["downstream", "upstream"]);
    // Worst-wins: critical (from deps) beats ok (from clients)
    expect(foo.status).toBe("unhealthy");
  });

  it("excludes the primary service from its own neighbor list", async () => {
    const appMap = {
      application: { icon: "box", status: "ok" },
      clients: [{ id: "default:Deployment:primary", status: "ok" }],
      dependencies: [{ id: "default:Deployment:other", status: "ok" }],
    };
    mockGetToolsByRole.mockResolvedValue(
      makeToolMap({
        list_projects: {
          execute: vi.fn().mockResolvedValue({
            content: [{ type: "text", text: JSON.stringify({ projects: [{ id: "p1" }] }) }],
          }),
        },
        applications_overview: {
          execute: vi.fn().mockResolvedValue({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  overview: {
                    context: {
                      search: {
                        applications: [{ id: "default:Deployment:primary", status: "ok" }],
                      },
                    },
                  },
                }),
              },
            ],
          }),
        },
        get_application: {
          execute: vi.fn().mockResolvedValue({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  application: { data: { app_map: appMap, reports: [] } },
                }),
              },
            ],
          }),
        },
      }),
    );
    const result = await fetchCorootNeighbors("primary", providers, []);
    expect(result).toHaveLength(1);
    expect(result![0]!.name).toBe("other");
  });
});
