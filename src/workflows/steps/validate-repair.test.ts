import { describe, it, expect, vi, beforeEach } from "vitest";
import { runValidateStep } from "./validate.js";
import type { ServiceConfig } from "../../config/schema.js";

// Responses mirror grafana-mcp: content-wrapped JSON, `{"data":[]}` for no
// match, `isError: true` plain text for upstream failures.
const wrap = (payload: unknown) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });
const EMPTY = wrap({ data: [], hints: { summary: "The query returned no data for the specified time range." } });
const PROM_HIT = wrap({ data: [{ metric: { pod: "x" }, value: [1700000000, "0"] }] });
const LOKI_HIT = wrap({ data: [{ timestamp: "1700000000000000000", line: "hello", labels: {} }] });
const LOKI_400 = {
  isError: true,
  content: [{ type: "text", text: "loki API returned status code 400: parse error at line 1, col 42" }],
};

let promExecute: ReturnType<typeof vi.fn>;
let lokiExecute: ReturnType<typeof vi.fn>;
let lokiLabelNames: string[];

vi.mock("../../mcp/provider.js", async () => {
  const actual = await vi.importActual<typeof import("../../mcp/provider.js")>("../../mcp/provider.js");
  return {
    ...actual,
    getToolsByRole: async (_providers: unknown, role: string) => {
      if (role === "metrics") {
        return {
          query_prometheus: { execute: promExecute },
          list_datasources: {
            execute: async () => wrap([
              { uid: "loki-uid", name: "Loki", type: "loki" },
              { uid: "prom-uid", name: "Prometheus", type: "prometheus" },
            ]),
          },
        };
      }
      if (role === "logs") {
        return {
          query_loki_logs: { execute: lokiExecute },
          list_loki_label_names: { execute: async () => wrap(lokiLabelNames) },
          list_loki_label_values: { execute: async () => wrap([]) },
        };
      }
      return {};
    },
  };
});

function service(overrides: Partial<ServiceConfig>): ServiceConfig {
  return {
    name: "amd-gpu-exporter",
    metrics: [{ query: 'kube_daemonset_status_number_ready{daemonset="amd-gpu-exporter"}', description: "" }],
    logLabels: {},
    probeRules: [],
    ...overrides,
  } as ServiceConfig;
}

const exprOf = (call: unknown[]) => String((call[0] as { expr?: string }).expr);
const logqlOf = (call: unknown[]) => String((call[0] as { logql?: string }).logql);
const rule = (svc: ServiceConfig, name: string) => (svc.probeRules ?? []).find((r) => r.name === name);

beforeEach(() => {
  promExecute = vi.fn(async ({ expr }: { expr: string }) => (expr.startsWith("kube_daemonset") ? PROM_HIT : EMPTY));
  lokiExecute = vi.fn(async () => EMPTY);
  lokiLabelNames = ["namespace", "pod", "container", "app"];
});

describe("runValidateStep — pod_restarts verify and repair", () => {
  it("repairs a restart rule that matches no series with a pod-name-prefix selector", async () => {
    promExecute = vi.fn(async ({ expr }: { expr: string }) => {
      if (expr.startsWith("kube_daemonset")) return PROM_HIT;
      if (expr.includes('pod=~"amd-gpu-exporter-')) return PROM_HIT;
      return EMPTY;
    });
    const svc = service({
      logLabels: { namespace: "monitoring" },
      probeRules: [{
        name: "pod_restarts",
        query: 'rate(kube_pod_container_status_restarts_total{namespace="monitoring",container="amd-gpu-exporter"}[5m])',
        threshold: { op: "gt", value: 0.033 }, consecutiveTicks: 2, source: "metrics",
      }],
    });

    const [r] = await runValidateStep({ providers: [], services: [svc] });

    expect(rule(r!, "pod_restarts")?.query).toBe(
      'rate(kube_pod_container_status_restarts_total{namespace="monitoring",pod=~"amd-gpu-exporter-[a-z0-9]+(-[a-z0-9]+)?$"}[5m])',
    );
    expect(r!.validationNotes).toContain("restarts ✓ repaired via pod-name prefix");
  });

  it("matches truncated Deployment pod names with a single suffix segment", () => {
    const re = new RegExp("^pvc-1ae3-jiva-ctrl-[a-z0-9]+(-[a-z0-9]+)?$");
    expect(re.test("pvc-1ae3-jiva-ctrl-6bf8f6f54ths")).toBe(true);
    expect(re.test("pvc-1ae3-jiva-ctrl-6bf8f6f54-ths12")).toBe(true);
    expect(re.test("pvc-1ae3-jiva-ctrl-6bf8f6f54-ths12-extra")).toBe(false);
  });

  it("keeps the original restart rule when the fallback also matches nothing (scaled to zero)", async () => {
    const original = 'rate(kube_pod_container_status_restarts_total{namespace="m",pod=~"idle-[a-z0-9]+-[a-z0-9]+$"}[5m])';
    const svc = service({
      name: "idle",
      probeRules: [{ name: "pod_restarts", query: original, threshold: { op: "gt", value: 0.033 }, consecutiveTicks: 2, source: "metrics" }],
    });

    const [r] = await runValidateStep({ providers: [], services: [svc] });

    expect(rule(r!, "pod_restarts")?.query).toBe(original);
    expect(r!.validationNotes).toContain("restarts ✗ no series (kept");
  });

  it("adds a restart rule when none exists and the pod-name prefix returns series", async () => {
    promExecute = vi.fn(async ({ expr }: { expr: string }) =>
      expr.startsWith("kube_daemonset") || expr.includes("kube_pod_container_status_restarts_total") ? PROM_HIT : EMPTY);
    const svc = service({});

    const [r] = await runValidateStep({ providers: [], services: [svc] });

    expect(rule(r!, "pod_restarts")?.query).toContain('pod=~"amd-gpu-exporter-[a-z0-9]+(-[a-z0-9]+)?$"');
    expect(r!.validationNotes).toContain("restarts ✓ added via pod-name prefix");
  });

  it("treats grafana-mcp's {\"data\":[]} as empty for the metric check, so the metric fallback runs", async () => {
    const svc = service({ metrics: [{ query: 'up{job="amd-gpu-exporter"}', description: "" }] });

    const [r] = await runValidateStep({ providers: [], services: [svc] });

    expect(r!.metrics[0]?.query).toBe('kube_daemonset_status_number_ready{daemonset="amd-gpu-exporter"}');
    expect(r!.validationNotes).toMatch(/repaired via fallback/);
  });
});

describe("runValidateStep — log selector verify and repair", () => {
  const logRule = (selector: string) => ({
    name: "log_errors",
    query: `sum(count_over_time({${selector}} |~ "error|fatal" [15m]))`,
    threshold: { op: "gt" as const, value: 75 }, consecutiveTicks: 2, source: "logs" as const,
  });

  it("checks streams with the grafana-mcp argument names (logql + datasourceUid)", async () => {
    lokiExecute = vi.fn(async () => LOKI_HIT);
    const svc = service({ logLabels: { namespace: "monitoring", app: "amd-gpu-exporter" } });

    const [r] = await runValidateStep({ providers: [], services: [svc] });

    const args = lokiExecute.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.logql).toBe('{namespace="monitoring",app="amd-gpu-exporter"}');
    expect(args.datasourceUid).toBe("loki-uid");
    expect(args).not.toHaveProperty("query");
    expect(r!.validationNotes).toContain("logs ✓");
    expect(r!.confidence).toBe("verified");
  });

  it("repairs a selector that uses a label this Loki lacks, via a label it has", async () => {
    lokiLabelNames = ["namespace", "app", "container_name"];
    lokiExecute = vi.fn(async (args: { logql: string }) =>
      args.logql === '{namespace="storage",container_name="openebs-node"}' ? LOKI_HIT : EMPTY);
    const svc = service({
      name: "openebs-node",
      logLabels: { namespace: "storage", container: "openebs-node" },
      probeRules: [logRule('namespace="storage",container="openebs-node"')],
    });

    const [r] = await runValidateStep({ providers: [], services: [svc] });

    expect(r!.logLabels).toEqual({ namespace: "storage", container_name: "openebs-node" });
    expect(rule(r!, "log_errors")?.query).toBe('sum(count_over_time({namespace="storage",container_name="openebs-node"} |~ "error|fatal" [15m]))');
    expect(r!.validationNotes).toContain("logs ✓ repaired via container_name");
    // Only label keys this Loki has are tried.
    expect(lokiExecute.mock.calls.map(logqlOf).some((q) => q.includes("service_name="))).toBe(false);
  });

  it("falls back to a pod-name prefix when no equality label matches", async () => {
    lokiExecute = vi.fn(async (args: { logql: string }) => (args.logql.includes("pod=~") ? LOKI_HIT : EMPTY));
    const svc = service({
      logLabels: { namespace: "monitoring", container_name: "amd-gpu-exporter" },
      probeRules: [logRule('namespace="monitoring",container_name="amd-gpu-exporter"')],
    });

    const [r] = await runValidateStep({ providers: [], services: [svc] });

    expect(rule(r!, "log_errors")?.query).toBe(
      'sum(count_over_time({namespace="monitoring",pod=~"amd-gpu-exporter-[a-z0-9]+(-[a-z0-9]+)?"} |~ "error|fatal" [15m]))',
    );
    expect(r!.logLabels).toEqual({ namespace: "monitoring" });
  });

  it("drops log_errors and clears logLabels when no selector matches any stream", async () => {
    const svc = service({
      logLabels: { container_name: "amd-gpu-exporter" },
      probeRules: [logRule('container_name="amd-gpu-exporter"')],
    });

    const [r] = await runValidateStep({ providers: [], services: [svc] });

    expect(rule(r!, "log_errors")).toBeUndefined();
    expect(r!.logLabels).toEqual({});
    expect(r!.validationNotes).toContain("log_errors dropped");
  });

  it("keeps the selector untouched when Loki reports an error", async () => {
    lokiExecute = vi.fn(async () => LOKI_400);
    const svc = service({
      logLabels: { container_name: "amd-gpu-exporter" },
      probeRules: [logRule('container_name="amd-gpu-exporter"')],
    });

    const [r] = await runValidateStep({ providers: [], services: [svc] });

    expect(rule(r!, "log_errors")?.query).toBe(logRule('container_name="amd-gpu-exporter"').query);
    expect(r!.logLabels).toEqual({ container_name: "amd-gpu-exporter" });
    expect(lokiExecute).toHaveBeenCalledTimes(1);
  });
});
