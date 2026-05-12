import { describe, expect, it } from "vitest";
import { parsePrimaryOrReasoning } from "./parse.js";
import type { ServiceConfig } from "../../../config/schema.js";

describe("parsePrimaryOrReasoning — service-level backfills", () => {
  function parse(json: object): ServiceConfig[] | undefined {
    const result = parsePrimaryOrReasoning({ text: JSON.stringify(json) });
    return result?.services;
  }

  // `backfillServiceAvailability` was removed on main (PR #215) — 51 stress
  // iters showed 0 fires. The LLM emits service_availability reliably on
  // its own. Tests for it deleted alongside.

  describe("backfillPodRestarts (iter 7)", () => {
    it("backfills deployment-flavored pod_restarts with namespace plus pod regex", () => {
      const services = parse({
        services: [{
          name: "checkout-api",
          metrics: [{
            query: 'kube_deployment_status_replicas_available{deployment="checkout-api",namespace="shop"}',
            description: "ready",
          }],
          logLabels: { container: "checkout-api" },
          probeRules: [],
        }],
      });
      const restart = (services?.[0]?.probeRules ?? []).find((r) => r.name === "pod_restarts");
      expect(restart).toBeDefined();
      expect(restart?.query).toBe(
        'rate(kube_pod_container_status_restarts_total{namespace="shop",pod=~"checkout-api-[a-z0-9]+-[a-z0-9]+$"}[5m])',
      );
      expect(restart?.query).not.toContain('deployment="checkout-api"');
      expect(restart?.threshold).toEqual({ op: "gt", value: 0.033 });
      expect(restart?.consecutiveTicks).toBe(2);
    });

    it("backfills statefulset-flavored pod_restarts with ordinal-anchored pod regex", () => {
      const services = parse({
        services: [{
          name: "stolon-keeper",
          metrics: [{
            query: 'kube_statefulset_status_replicas_ready{statefulset="stolon-keeper",namespace="db"}',
            description: "ready",
          }],
          logLabels: {},
          probeRules: [],
        }],
      });
      const restart = (services?.[0]?.probeRules ?? []).find((r) => r.name === "pod_restarts");
      expect(restart?.query).toBe(
        'rate(kube_pod_container_status_restarts_total{namespace="db",pod=~"stolon-keeper-[0-9]+$"}[5m])',
      );
    });

    it("does NOT backfill pod_restarts for bare-metal Consul services (empty logLabels)", () => {
      // No deployment= / statefulset= label in metrics[0], no logLabels →
      // no safe selector → skip. Operator can still hand-add a rule.
      const services = parse({
        services: [{
          name: "hdfs-datanode",
          metrics: [{
            query: 'max by (service_name) (consul_health_service_status{service_name="hdfs-datanode",status="passing"})',
            description: "consul health",
          }],
          logLabels: {},
          probeRules: [],
        }],
      });
      const names = (services?.[0]?.probeRules ?? []).map((r) => r.name);
      expect(names).not.toContain("pod_restarts");
    });

    it("backfills pod_restarts from logLabels.container when metrics[0] is `up{job=...}` (iter 9)", () => {
      // The LLM sometimes converges on `up{job=<name>}` instead of
      // `kube_deployment_status_replicas_available{deployment=<name>}`. iter 9
      // falls back to log-label-derived selectors so this path doesn't lose
      // pod_restarts coverage on bad-seed runs.
      const services = parse({
        services: [{
          name: "ingestion-server",
          metrics: [{ query: 'up{job="ingestion-server"}', description: "up" }],
          logLabels: { namespace: "default", container: "ingestion-server" },
          probeRules: [],
        }],
      });
      const restart = (services?.[0]?.probeRules ?? []).find((r) => r.name === "pod_restarts");
      expect(restart).toBeDefined();
      expect(restart?.query).toBe(
        'rate(kube_pod_container_status_restarts_total{namespace="default",container="ingestion-server"}[5m])',
      );
    });

    it("falls back to `namespace + pod=~<svc>-.+$` when logLabels has namespace but no container", () => {
      const services = parse({
        services: [{
          name: "checkout-api",
          metrics: [{ query: 'up{job="checkout-api"}', description: "up" }],
          logLabels: { namespace: "shop" },
          probeRules: [],
        }],
      });
      const restart = (services?.[0]?.probeRules ?? []).find((r) => r.name === "pod_restarts");
      expect(restart?.query).toBe(
        'rate(kube_pod_container_status_restarts_total{namespace="shop",pod=~"checkout-api(-[0-9]+|-[a-z0-9]+-[a-z0-9]+)$"}[5m])',
      );
    });

    it("does NOT backfill pod_restarts when the LLM already emitted it", () => {
      const explicit: ProbeMetricRule = {
        name: "pod_restarts",
        query: 'rate(kube_pod_container_status_restarts_total{namespace="shop",container="checkout-api"}[5m])',
        threshold: { op: "gt", value: 0.05 },
        consecutiveTicks: 3,
        source: "metrics",
      };
      const services = parse({
        services: [{
          name: "checkout-api",
          metrics: [{ query: 'kube_deployment_status_replicas_available{deployment="checkout-api"}', description: "x" }],
          logLabels: {},
          probeRules: [explicit],
        }],
      });
      const restarts = (services?.[0]?.probeRules ?? []).filter((r) => r.name === "pod_restarts");
      expect(restarts).toHaveLength(1);
      // Preserves the LLM's explicit threshold (0.05) rather than overwriting to 0.033.
      expect(restarts[0]?.threshold).toEqual({ op: "gt", value: 0.05 });
    });
  });

  describe("backfillLogErrors (iter 7)", () => {
    it("backfills log_errors from logLabels when omitted", () => {
      const services = parse({
        services: [{
          name: "checkout-api",
          metrics: [{ query: 'up{job="checkout-api"}', description: "x" }],
          logLabels: { namespace: "shop", container: "checkout-api" },
          probeRules: [],
        }],
      });
      const log = (services?.[0]?.probeRules ?? []).find((r) => r.name === "log_errors");
      expect(log).toBeDefined();
      expect(log?.query).toBe(
        'sum(count_over_time({namespace="shop",container="checkout-api"} |= `error` or `fatal` [15m]))',
      );
      expect(log?.threshold).toEqual({ op: "gt", value: 75 });
      expect(log?.source).toBe("logs");
    });

    it("escapes quotes in logLabel values so the Loki query stays valid", () => {
      const services = parse({
        services: [{
          name: "edge-case",
          metrics: [{ query: 'up{job="edge-case"}', description: "x" }],
          // A label value with an embedded quote — rare but real on
          // app-emitted labels. Must be backslash-escaped so the Loki
          // stream selector parses.
          logLabels: { app: 'has"quote' },
          probeRules: [],
        }],
      });
      const log = (services?.[0]?.probeRules ?? []).find((r) => r.name === "log_errors");
      expect(log?.query).toContain('app="has\\"quote"');
    });

    it("does NOT backfill log_errors when logLabels is empty", () => {
      const services = parse({
        services: [{
          name: "hdfs-datanode",
          metrics: [{ query: 'max by (service_name) (consul_health_service_status{service_name="hdfs-datanode",status="passing"})', description: "x" }],
          logLabels: {},
          probeRules: [],
        }],
      });
      const names = (services?.[0]?.probeRules ?? []).map((r) => r.name);
      expect(names).not.toContain("log_errors");
    });

    it("does NOT backfill log_errors when the LLM already emitted it", () => {
      const services = parse({
        services: [{
          name: "checkout-api",
          metrics: [{ query: 'up{job="checkout-api"}', description: "x" }],
          logLabels: { container: "checkout-api" },
          probeRules: [{
            name: "log_errors",
            query: 'sum(rate({container="checkout-api"} |= `panic` [5m]))',
            threshold: { op: "gt", value: 1 },
            consecutiveTicks: 1,
            source: "logs",
          }],
        }],
      });
      const logs = (services?.[0]?.probeRules ?? []).filter((r) => r.name === "log_errors");
      expect(logs).toHaveLength(1);
      // Preserves the LLM-emitted form.
      expect(logs[0]?.query).toContain("|= `panic`");
    });
  });
});

// `backfillGlobalAvailabilityRules` was removed on main (PR #215) — 51 stress
// iters showed 0 fires. Tests for it deleted alongside.
