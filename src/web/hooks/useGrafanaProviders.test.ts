// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";

const stackFetch = vi.fn();
vi.mock("../contexts/StackContext", () => ({
  useStackContext: () => ({ stackFetch, activeStackId: "s1" }),
}));

import { useGrafanaProviders } from "./useGrafanaProviders";

afterEach(() => {
  cleanup();
  stackFetch.mockReset();
});

describe("useGrafanaProviders (PR-3)", () => {
  it("fetches /api/providers (stack-aware) and maps to {role, webUrl, datasource}", async () => {
    stackFetch.mockResolvedValue({
      ok: true,
      json: async () => [
        { roles: ["metrics", "logs"], webUrl: "https://g", prometheusDatasourceUid: "prom-uid" },
        { roles: ["changes"] }, // no webUrl → filtered out
      ],
    });
    const { result } = renderHook(() => useGrafanaProviders());
    await waitFor(() => expect(result.current.length).toBeGreaterThan(0));

    expect(stackFetch).toHaveBeenCalledWith("/api/providers");
    expect(result.current).toEqual([
      { role: "metrics", webUrl: "https://g", datasource: "prom-uid" },
      { role: "logs", webUrl: "https://g", datasource: undefined },
    ]);
  });

  it("returns [] when the fetch rejects", async () => {
    stackFetch.mockRejectedValue(new Error("net"));
    const { result } = renderHook(() => useGrafanaProviders());
    await waitFor(() => expect(stackFetch).toHaveBeenCalled());
    expect(result.current).toEqual([]);
  });

  it("returns [] on a non-ok response", async () => {
    stackFetch.mockResolvedValue({ ok: false, json: async () => [] });
    const { result } = renderHook(() => useGrafanaProviders());
    await waitFor(() => expect(stackFetch).toHaveBeenCalled());
    expect(result.current).toEqual([]);
  });
});
