import { describe, it, expect, vi } from "vitest";
import { wasScaledToZeroThroughout, scaledToZeroNote } from "./scaled-to-zero.js";

const WINDOW = { from: "2026-10-11T15:19:30.000Z", to: "2026-10-11T16:19:30.000Z" };
const NOW = Date.parse("2026-10-11T16:29:30.000Z");

describe("wasScaledToZeroThroughout", () => {
  it("is true when the deployment's desired replicas peaked at 0 in the window", async () => {
    const query = vi.fn(async () => 0);
    expect(await wasScaledToZeroThroughout("minimax-m3-vllm-8gpu", WINDOW, query, NOW)).toBe(true);
    expect(query).toHaveBeenCalledWith(
      'max(max_over_time((kube_deployment_spec_replicas{deployment="minimax-m3-vllm-8gpu"})[3600s:1m] offset 600s))',
    );
  });

  it("is false when it was up at any point in the window (a real scale-down)", async () => {
    expect(await wasScaledToZeroThroughout("api", WINDOW, async () => 2, NOW)).toBe(false);
  });

  it("falls through to statefulsets and daemonsets when there is no deployment series", async () => {
    const query = vi.fn(async (expr: string) => (expr.includes("kube_statefulset_replicas") ? 0 : null));
    expect(await wasScaledToZeroThroughout("db", WINDOW, query, NOW)).toBe(true);
    expect(query.mock.calls.map(([e]) => e.split("{")[0]!.replace(/.*\(/, ""))).toEqual(["kube_deployment_spec_replicas", "kube_statefulset_replicas"]);
  });

  it("stops at the first workload kind that has a series", async () => {
    const query = vi.fn(async (expr: string) => (expr.includes("kube_deployment_spec_replicas") ? 3 : 0));
    expect(await wasScaledToZeroThroughout("api", WINDOW, query, NOW)).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("cannot tell when no replica series exists for any workload kind", async () => {
    expect(await wasScaledToZeroThroughout("consul-service", WINDOW, async () => null, NOW)).toBeNull();
  });

  it("cannot tell without an absolute investigation window", async () => {
    const query = vi.fn(async () => 0);
    expect(await wasScaledToZeroThroughout("api", { from: "now-1h", to: "now" }, query, NOW)).toBeNull();
    expect(await wasScaledToZeroThroughout("api", undefined, query, NOW)).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it("escapes quotes in the service name", async () => {
    const query = vi.fn(async () => 0);
    await wasScaledToZeroThroughout('a"b', WINDOW, query, NOW);
    expect(query.mock.calls[0]![0]).toContain('deployment="a\\"b"');
  });
});

describe("scaledToZeroNote", () => {
  it("names the workload and explains why shared metrics don't count", () => {
    expect(scaledToZeroNote("minimax-m3-vllm-8gpu")).toBe(
      "Note: minimax-m3-vllm-8gpu had 0 desired replicas for the whole investigation window, so nothing was running. Metrics labelled by model or job name belong to whichever deployment is serving that model, not to this workload.",
    );
  });
});
