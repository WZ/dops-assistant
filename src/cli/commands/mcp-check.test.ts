import { describe, it, expect, vi } from "vitest";
import { runMcpCheck } from "./mcp-check.js";
import type { MastraProvider } from "../../mcp/provider.js";

function makeMockProvider(name: string, tools: string[], shouldFail = false): MastraProvider {
  return {
    name,
    roles: ["metrics"],
    client: {
      listTools: shouldFail
        ? vi.fn().mockRejectedValue(new Error("connection refused"))
        : vi.fn().mockResolvedValue(Object.fromEntries(tools.map((t) => [t, {}]))),
    } as any,
  };
}

describe("runMcpCheck", () => {
  it("returns connected status with tool list", async () => {
    const providers = [makeMockProvider("grafana", ["search_dashboards", "query_prometheus"])];
    const result = await runMcpCheck(providers);

    expect(result.command).toBe("mcp-check");
    expect(result.status).toBe("success");
    expect(result.providers[0]).toEqual({
      name: "grafana",
      status: "connected",
      toolsCount: 2,
      tools: ["search_dashboards", "query_prometheus"],
      error: null,
    });
  });

  it("reports error for failed provider", async () => {
    const providers = [makeMockProvider("grafana", [], true)];
    const result = await runMcpCheck(providers);

    expect(result.status).toBe("error");
    expect(result.providers[0]!.status).toBe("error");
    expect(result.providers[0]!.error).toContain("connection refused");
  });

  it("reports mixed status when some providers fail", async () => {
    const providers = [
      makeMockProvider("grafana", ["tool1"]),
      makeMockProvider("loki", [], true),
    ];
    const result = await runMcpCheck(providers);

    expect(result.status).toBe("error");
    expect(result.providers[0]!.status).toBe("connected");
    expect(result.providers[1]!.status).toBe("error");
  });
});
