import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildServiceBrief,
  clearBriefCache,
  setBriefCacheEntry,
  type ServiceBriefDeps,
} from "./service-brief.js";
import type { MastraProvider } from "../mcp/provider.js";
import type { ServiceConfig } from "../config/schema.js";
import type { ServiceHealthPoller, HealthStatus } from "./service-health-poller.js";
import type { LanguageModel } from "ai";

// ── Mock getToolsByRole ──────────────────────────────────────────────────────

// We need to control what getToolsByRole returns per test.
const mockGetToolsByRole = vi.fn();

vi.mock("../mcp/provider.js", () => ({
  getToolsByRole: (...args: unknown[]) => mockGetToolsByRole(...args),
}));

// ── Mock generateText ────────────────────────────────────────────────────────

const mockGenerateText = vi.fn();

vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => mockGenerateText(...args),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeProvider(name: string, roles: string[] = ["metrics"]): MastraProvider {
  return {
    name,
    roles: roles as MastraProvider["roles"],
    client: { listTools: vi.fn().mockResolvedValue({}) } as unknown as MastraProvider["client"],
  };
}

function makeServices(names: string[]): ServiceConfig[] {
  return names.map(name => ({
    name,
    metrics: [],
    logLabels: {},
  }));
}

function makeHealthPoller(healthMap: Record<string, HealthStatus> = {}): ServiceHealthPoller {
  return {
    getHealth: () => new Map(Object.entries(healthMap)),
  } as unknown as ServiceHealthPoller;
}

function makeLlmModel(): LanguageModel {
  // Just a marker object — the actual call goes through the mocked generateText
  return { modelId: "test-model" } as unknown as LanguageModel;
}

function makeTool(result: unknown, delay = 0): { execute: ReturnType<typeof vi.fn> } {
  return {
    execute: vi.fn(async () => {
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
      return result;
    }),
  };
}

function makeChangesTools(): Record<string, { execute: ReturnType<typeof vi.fn> }> {
  return {
    gitlab_list_deployments: makeTool({
      content: [{ type: "text", text: JSON.stringify([
        { ref: "main", pipelineId: 123, pipelineStatus: "success", environment: "production", deployedAt: "2026-03-26T10:00:00Z", deployedBy: "alice" },
      ]) }],
    }),
    gitlab_list_merge_requests: makeTool({
      content: [{ type: "text", text: JSON.stringify([
        { iid: 42, title: "Fix timeout bug", mergedAt: "2026-03-26T09:00:00Z", mergedBy: "bob", filesChanged: 5, webUrl: "https://gitlab.example/mr/42" },
      ]) }],
    }),
  };
}

function makeInfraTools(): Record<string, { execute: ReturnType<typeof vi.fn> }> {
  return {
    k8s_describe_pod: makeTool({
      content: [{ type: "text", text: JSON.stringify({
        workloadType: "Deployment",
        replicas: { desired: 3, ready: 3, available: 3 },
        containers: [
          { name: "app", cpuUsage: "100m", cpuLimit: "500m", memUsage: "256Mi", memLimit: "1Gi", restarts: 0 },
        ],
        recentEvents: [],
      }) }],
    }),
  };
}

function baseDeps(overrides: Partial<ServiceBriefDeps> = {}): ServiceBriefDeps {
  return {
    providers: [makeProvider("gitlab", ["changes"]), makeProvider("k8s", ["infrastructure"])],
    services: makeServices(["api-service", "db-service"]),
    healthPoller: makeHealthPoller({ "api-service": "healthy", "db-service": "degraded" }),
    llmModel: makeLlmModel(),
    ...overrides,
  };
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  clearBriefCache();

  // Default: changes role returns tools, infrastructure role returns tools
  mockGetToolsByRole.mockImplementation(async (_providers: unknown, role: string) => {
    if (role === "changes") return makeChangesTools();
    if (role === "infrastructure") return makeInfraTools();
    return {};
  });

  // Default: LLM returns a summary
  mockGenerateText.mockResolvedValue({
    text: "api-service is healthy with 3/3 replicas. A deployment landed 30 minutes ago with no issues.",
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("buildServiceBrief", () => {
  // 1. Happy path: all MCPs return data → all 4 sections populated
  it("returns all 4 sections when all MCPs succeed", async () => {
    const brief = await buildServiceBrief("api-service", baseDeps());

    // Changes populated
    expect(brief.changes).not.toBeNull();
    expect(brief.changes!.deployments).toHaveLength(1);
    expect(brief.changes!.mergeRequests).toHaveLength(1);

    // Infrastructure populated
    expect(brief.infrastructure).not.toBeNull();
    expect(brief.infrastructure!.replicas.ready).toBe(3);
    expect(brief.infrastructure!.containers).toHaveLength(1);

    // Dependencies populated (inferred from service list)
    expect(brief.dependencies).not.toBeNull();
    expect(brief.dependencies!.nodes.length).toBeGreaterThan(0);

    // Summary populated
    expect(brief.summary).not.toBeNull();
    expect(brief.summary!.text).toContain("api-service");

    // Section statuses all ok
    expect(brief.sections.changes.status).toBe("ok");
    expect(brief.sections.infrastructure.status).toBe("ok");
    expect(brief.sections.dependencies.status).toBe("ok");
    expect(brief.sections.summary.status).toBe("ok");

    // No errors
    expect(brief.errors).toHaveLength(0);
  });

  // 2. GitLab MCP fails → changes=null, infra+deps+summary still work
  it("returns null changes when GitLab MCP fails, other sections work", async () => {
    mockGetToolsByRole.mockImplementation(async (_providers: unknown, role: string) => {
      if (role === "changes") throw new Error("GitLab MCP connection refused");
      if (role === "infrastructure") return makeInfraTools();
      return {};
    });

    const brief = await buildServiceBrief("api-service", baseDeps());

    expect(brief.changes).toBeNull();
    // getToolsByRole threw → "error", not "unconfigured" (unconfigured = no tools found)
    expect(brief.sections.changes.status).toBe("error");

    // Other sections still populated
    expect(brief.infrastructure).not.toBeNull();
    expect(brief.dependencies).not.toBeNull();
    expect(brief.summary).not.toBeNull();
  });

  // 3. K8s MCP timeout → infra=null, other sections work
  it("returns null infrastructure when K8s MCP times out, other sections work", async () => {
    vi.useFakeTimers();

    mockGetToolsByRole.mockImplementation(async (_providers: unknown, role: string) => {
      if (role === "changes") return makeChangesTools();
      if (role === "infrastructure") {
        return {
          // Delay longer than the 3s section timeout — fake timers let us skip the wait
          k8s_describe_pod: makeTool(null, 10_000),
        };
      }
      return {};
    });

    // Start the call without awaiting
    const briefPromise = buildServiceBrief("api-service", baseDeps());

    // Advance fake time past the 3s section timeout to fire the AbortController + rejection
    await vi.advanceTimersByTimeAsync(4_000);

    const brief = await briefPromise;

    // Infrastructure should be null due to timeout
    expect(brief.infrastructure).toBeNull();

    // Other sections still work
    expect(brief.changes).not.toBeNull();
    expect(brief.dependencies).not.toBeNull();
    expect(brief.summary).not.toBeNull();
  });

  // 4. All MCPs fail → all data sections null, errors populated
  it("returns all null data sections when all MCPs fail", async () => {
    mockGetToolsByRole.mockRejectedValue(new Error("All MCP servers unreachable"));
    mockGenerateText.mockRejectedValue(new Error("LLM unavailable"));

    const brief = await buildServiceBrief("api-service", baseDeps());

    expect(brief.changes).toBeNull();
    expect(brief.infrastructure).toBeNull();
    // Dependencies are inferred from services list, not from MCP, so they may still work
    // but changes and infra are null.
    // getToolsByRole threw → "error" for changes and infrastructure
    expect(brief.sections.changes.status).toBe("error");
    expect(brief.sections.infrastructure.status).toBe("error");
    expect(brief.sections.summary.status).toBe("error");
    expect(brief.errors.length).toBeGreaterThan(0);
  });

  // 5. Cache hit → returns cached data, no MCP calls made
  it("returns cached data without making MCP calls on cache hit", async () => {
    // Prime the cache by building once
    const brief1 = await buildServiceBrief("api-service", baseDeps());
    expect(brief1.changes).not.toBeNull();

    // Clear mocks to track new calls
    mockGetToolsByRole.mockClear();
    mockGenerateText.mockClear();

    // Second call should hit cache
    const brief2 = await buildServiceBrief("api-service", baseDeps());

    expect(brief2.changes).not.toBeNull();
    expect(brief2.infrastructure).not.toBeNull();
    expect(brief2.dependencies).not.toBeNull();
    expect(brief2.summary).not.toBeNull();

    // No MCP calls should have been made
    expect(mockGetToolsByRole).not.toHaveBeenCalled();
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  // 6. Stale-while-revalidate → returns stale, triggers background refresh
  it("returns stale data immediately and triggers background refresh", async () => {
    // Manually set stale cache entries (fetchedAt far in the past: 3 min ago for 2-min TTL sections)
    const staleTime = Date.now() - 3 * 60_000;
    const changesData = { deployments: [{ ref: "old", pipelineId: 1, pipelineStatus: "success", environment: "prod", deployedAt: "2026-03-25T00:00:00Z", deployedBy: "stale-user" }], mergeRequests: [], configChanges: [] };
    const infraData = { workloadType: "Deployment", replicas: { desired: 2, ready: 2, available: 2 }, containers: [], recentEvents: [] };
    const depsData = { nodes: [{ id: "api-service", name: "api-service", type: "service" as const, status: "unknown" as const }], edges: [], source: "inferred" as const };
    const summaryData = { text: "Stale summary text." };

    setBriefCacheEntry("api-service", "changes", changesData, staleTime);
    setBriefCacheEntry("api-service", "infrastructure", infraData, staleTime);
    setBriefCacheEntry("api-service", "dependencies", depsData, staleTime);
    setBriefCacheEntry("api-service", "summary", summaryData, staleTime);

    const brief = await buildServiceBrief("api-service", baseDeps());

    // Should return data (from stale cache or refreshed)
    expect(brief.changes).not.toBeNull();
    expect(brief.dependencies).not.toBeNull();
    // Stale sections should be marked as stale
    expect(brief.sections.changes.status).toBe("stale");
    // The stale data should still be usable
    expect(brief.errors).toHaveLength(0);
  });

  // 7. In-flight dedup → concurrent calls share same Promise
  it("shares the same Promise for concurrent calls to the same service", async () => {
    // Make the tool calls slow enough that two calls overlap
    let callCount = 0;
    mockGetToolsByRole.mockImplementation(async (_providers: unknown, role: string) => {
      callCount++;
      if (role === "changes") return makeChangesTools();
      if (role === "infrastructure") return makeInfraTools();
      return {};
    });

    // Launch two concurrent calls
    const [brief1, brief2] = await Promise.all([
      buildServiceBrief("api-service", baseDeps()),
      buildServiceBrief("api-service", baseDeps()),
    ]);

    // Both should get the same result
    expect(brief1.changes).toEqual(brief2.changes);
    expect(brief1.infrastructure).toEqual(brief2.infrastructure);

    // getToolsByRole should have been called for the "changes" and "infrastructure" roles
    // only once each (2 total) — not doubled (4 total)
    // The first call owns the fetch; the second joins the same inflight promise.
    expect(callCount).toBe(2);
  });

  // 8. AI summary fails → summary=null, 3 data sections still returned
  it("returns null summary when AI generation fails, data sections still populated", async () => {
    mockGenerateText.mockRejectedValue(new Error("LLM rate limit exceeded"));

    const brief = await buildServiceBrief("api-service", baseDeps());

    // Summary should be null
    expect(brief.summary).toBeNull();
    expect(brief.sections.summary.status).toBe("error");
    expect(brief.errors.some(e => e.includes("summary"))).toBe(true);

    // Data sections still populated
    expect(brief.changes).not.toBeNull();
    expect(brief.infrastructure).not.toBeNull();
    expect(brief.dependencies).not.toBeNull();
    expect(brief.sections.changes.status).toBe("ok");
    expect(brief.sections.infrastructure.status).toBe("ok");
    expect(brief.sections.dependencies.status).toBe("ok");
  });
});
