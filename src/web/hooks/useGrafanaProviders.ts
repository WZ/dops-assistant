import { useEffect, useState } from "react";
import { useStackContext } from "../contexts/StackContext";

/** The provider shape the Grafana deep-link builders (`buildExploreUrl`,
 *  `buildPhaseActions`) consume: one entry per (provider × role). */
export type GrafanaProvider = { role: string; webUrl: string; datasource?: string };

/**
 * Fetch the active stack's providers and map them to the `{role, webUrl, datasource}`
 * shape the Grafana deep-link builders consume. Shared by the standard report
 * (`InvestigationPane` → `EvidenceTimeline`) and the deep-run surfaces (PR-3
 * `CausalChain`), so the `/api/providers` → deep-link mapping lives in one place.
 *
 * Stack-aware: uses `stackFetch` (carries X-Stack-Id) and re-fetches on
 * `activeStackId` change, so links don't go stale after a stack switch (the
 * `branding-fetch-not-stack-aware` footgun). Returns `[]` until loaded or on any
 * fetch error — callers degrade gracefully to text-only links.
 */
export function useGrafanaProviders(): GrafanaProvider[] {
  const { stackFetch, activeStackId } = useStackContext();
  const [providers, setProviders] = useState<GrafanaProvider[]>([]);

  useEffect(() => {
    let cancelled = false;
    stackFetch("/api/providers")
      .then((r) => (r.ok ? r.json() : []))
      .then((provs: Array<{ roles?: string[]; webUrl?: string; prometheusDatasourceUid?: string }>) => {
        if (cancelled) return;
        setProviders(
          provs
            .filter((p) => p.webUrl && p.roles?.length)
            .flatMap((p) =>
              (p.roles ?? []).map((role) => ({
                role,
                webUrl: p.webUrl!,
                // Metric deep links need the resolved Prometheus datasource UID so
                // Explore opens with Prometheus (not Grafana's default, often Loki).
                datasource: role === "metrics" ? p.prometheusDatasourceUid : undefined,
              })),
            ),
        );
      })
      .catch(() => {
        if (!cancelled) setProviders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [stackFetch, activeStackId]);

  return providers;
}
