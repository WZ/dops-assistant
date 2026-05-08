import { evalDiscoverOutput } from "./discover-eval.js";
import type { DiscoveryResult } from "../types/agent-interfaces.js";

export interface BenchmarkEvent {
  type: "phase" | "iteration" | "tool" | "retry";
  phase?: string;
  iteration?: number;
  maxIterations?: number;
  description?: string;
  tool?: string;
  durationMs?: number;
  error?: string;
  attempt?: number;
  maxRetries?: number;
  reason?: string;
  tMs: number;
}

export interface BenchmarkRunInput {
  round: string;
  iteration: number;
  expectedServices: string[];
  durationMs: number;
  events: BenchmarkEvent[];
  result?: DiscoveryResult;
  error?: string;
}

export interface BenchmarkRunScore {
  round: string;
  iteration: number;
  success: boolean;
  durationMs: number;
  serviceCount: number;
  expectedCount: number;
  matchedServices: string[];
  missingServices: string[];
  extraServices: string[];
  serviceRecall: number;
  servicePrecision: number;
  evalScore: number;
  ruleCoverage: number;
  requiredRuleCoverage: number;
  verifiedRatio: number;
  retryCount: number;
  toolCallCount: number;
  globalRuleCount: number;
  serviceRuleNames: Record<string, string[]>;
  serviceQueries: Record<string, string | undefined>;
  terminalPhase?: string;
  error?: string;
  dimensionScores: Record<string, number>;
}

export interface BenchmarkSummary {
  round: string;
  iterations: number;
  successRate: number;
  failureCount: number;
  errorCount: number;
  completeEmptyCount: number;
  avgDurationMs: number;
  avgServiceRecall: number;
  avgServicePrecision: number;
  avgEvalScore: number;
  avgRuleCoverage: number;
  avgRequiredRuleCoverage: number;
  avgVerifiedRatio: number;
  avgToolCalls: number;
  avgRetries: number;
  p95DurationMs: number;
}

const REQUIRED_RULES = ["service_availability", "pod_restarts", "log_errors"];

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? 0;
}

function lowerSet(values: string[]): Set<string> {
  return new Set(values.map((value) => value.toLowerCase()));
}

export function scoreBenchmarkRun(input: BenchmarkRunInput): BenchmarkRunScore {
  const services = input.result?.services ?? [];
  const expectedLower = lowerSet(input.expectedServices);
  const discoveredNames = services.map((service) => service.name);
  const discoveredLower = lowerSet(discoveredNames);
  const matchedServices = input.expectedServices.filter((name) => discoveredLower.has(name.toLowerCase()));
  const missingServices = input.expectedServices.filter((name) => !discoveredLower.has(name.toLowerCase()));
  const extraServices = discoveredNames.filter((name) => !expectedLower.has(name.toLowerCase()));
  const servicesWithRules = services.filter((service) => (service.probeRules ?? []).length > 0);
  const servicesWithRequiredRules = services.filter((service) => {
    const names = new Set((service.probeRules ?? []).map((rule) => rule.name));
    return REQUIRED_RULES.every((ruleName) => names.has(ruleName));
  });
  const verified = services.filter((service) => service.confidence === "verified");
  const evalResult = input.result
    ? evalDiscoverOutput(input.result)
    : { total: 0, dimensions: [] };
  const phaseEvents = input.events.filter((event) => event.type === "phase");
  const terminalPhase = phaseEvents[phaseEvents.length - 1]?.phase;
  const dimensionScores = Object.fromEntries(
    evalResult.dimensions.map((dimension) => [dimension.name, dimension.score]),
  );
  const serviceRecall = round(matchedServices.length / Math.max(1, input.expectedServices.length));
  const servicePrecision = round(matchedServices.length / Math.max(1, services.length));
  const success = !input.error && services.length > 0 && serviceRecall === 1 && servicePrecision === 1;

  return {
    round: input.round,
    iteration: input.iteration,
    success,
    durationMs: input.durationMs,
    serviceCount: services.length,
    expectedCount: input.expectedServices.length,
    matchedServices,
    missingServices,
    extraServices,
    serviceRecall,
    servicePrecision,
    evalScore: evalResult.total,
    ruleCoverage: round(servicesWithRules.length / Math.max(1, services.length)),
    requiredRuleCoverage: round(servicesWithRequiredRules.length / Math.max(1, services.length)),
    verifiedRatio: round(verified.length / Math.max(1, services.length)),
    retryCount: input.events.filter((event) => event.type === "retry").length,
    toolCallCount: input.events.filter((event) => event.type === "tool").length,
    globalRuleCount: input.result?.globalProbeRules.length ?? 0,
    serviceRuleNames: Object.fromEntries(services.map((service) => [
      service.name,
      (service.probeRules ?? []).map((rule) => rule.name),
    ])),
    serviceQueries: Object.fromEntries(services.map((service) => [
      service.name,
      service.metrics?.[0]?.query,
    ])),
    terminalPhase,
    error: input.error,
    dimensionScores,
  };
}

export function summarizeBenchmarkRuns(roundName: string, runs: BenchmarkRunScore[]): BenchmarkSummary {
  return {
    round: roundName,
    iterations: runs.length,
    successRate: average(runs.map((run) => run.success ? 1 : 0)),
    failureCount: runs.filter((run) => !run.success).length,
    errorCount: runs.filter((run) => Boolean(run.error)).length,
    completeEmptyCount: runs.filter((run) => run.terminalPhase === "complete-empty").length,
    avgDurationMs: Math.round(average(runs.map((run) => run.durationMs))),
    avgServiceRecall: average(runs.map((run) => run.serviceRecall)),
    avgServicePrecision: average(runs.map((run) => run.servicePrecision)),
    avgEvalScore: average(runs.map((run) => run.evalScore)),
    avgRuleCoverage: average(runs.map((run) => run.ruleCoverage)),
    avgRequiredRuleCoverage: average(runs.map((run) => run.requiredRuleCoverage)),
    avgVerifiedRatio: average(runs.map((run) => run.verifiedRatio)),
    avgToolCalls: average(runs.map((run) => run.toolCallCount)),
    avgRetries: average(runs.map((run) => run.retryCount)),
    p95DurationMs: percentile(runs.map((run) => run.durationMs), 95),
  };
}
