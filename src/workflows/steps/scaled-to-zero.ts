/**
 * Scaled-to-zero check.
 *
 * A workload that had 0 desired replicas for the whole investigation window
 * ran nothing, so it cannot be the source of a latency or error problem. The
 * metrics agent still reports such incidents when a metric is labelled by
 * model or job name rather than by deployment: vLLM's request-latency series
 * carry `model_name`, so the sibling deployment serving the same model shows up
 * as the target's. The agent prompt already says to report "not deployed" in
 * this case, but a model can skip that, so this verifies it from the cluster.
 *
 * The check needs the series to exist and every sample in the window to be 0.
 * A workload that was up at any point in the window (a real scale-down) or one
 * with no replica series at all is never matched.
 */

const WORKLOAD_REPLICA_METRICS = [
  (name: string) => `kube_deployment_spec_replicas{deployment="${name}"}`,
  (name: string) => `kube_statefulset_replicas{statefulset="${name}"}`,
  (name: string) => `kube_daemonset_status_desired_number_scheduled{daemonset="${name}"}`,
];

function labelEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * True only when the workload's desired replicas were 0 throughout the window.
 * Null means "cannot tell" (no series, query failure, or a non-absolute window).
 */
export async function wasScaledToZeroThroughout(
  serviceName: string,
  window: { from?: string; to?: string } | undefined,
  queryValue: (expr: string) => Promise<number | null>,
  now: number = Date.now(),
): Promise<boolean | null> {
  const from = Date.parse(window?.from ?? "");
  const to = Date.parse(window?.to ?? "");
  if (!serviceName || Number.isNaN(from) || Number.isNaN(to) || to <= from) return null;

  const windowSecs = Math.max(60, Math.round((to - from) / 1000));
  const offsetSecs = Math.round((now - to) / 1000);
  const offset = offsetSecs > 0 ? ` offset ${offsetSecs}s` : "";
  const safe = labelEscape(serviceName);

  for (const metricFor of WORKLOAD_REPLICA_METRICS) {
    const peak = await queryValue(`max(max_over_time((${metricFor(safe)})[${windowSecs}s:1m]${offset}))`);
    if (peak === null || !Number.isFinite(peak)) continue;
    return peak === 0;
  }
  return null;
}

export function scaledToZeroNote(serviceName: string): string {
  return `Note: ${serviceName} had 0 desired replicas for the whole investigation window, so nothing was running. Metrics labelled by model or job name belong to whichever deployment is serving that model, not to this workload.`;
}
