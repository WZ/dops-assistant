import { useState, useEffect, useMemo } from "react";
import { ServiceBrief as ServiceBriefComponent, ServiceBriefSkeleton } from "./ServiceBrief";
import { ServiceMetrics } from "./ServiceMetrics";
import { RecentChanges } from "./RecentChanges";
import { InfrastructureStatus } from "./InfrastructureStatus";
import { ServiceDependencyGraph } from "./ServiceDependencyGraph";
import type { ServiceBrief, SectionStatus } from "../../types/service-brief.js";

interface ServiceOverviewProps {
  serviceName: string;
  onViewService: (name: string) => void;
}

const loadingStatus: SectionStatus = { status: "ok" as const };
const errorStatus: SectionStatus = { status: "error" as const, error: "Fetch failed" };

export function ServiceOverview({ serviceName, onViewService }: ServiceOverviewProps) {
  const [brief, setBrief] = useState<ServiceBrief | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const controller = new AbortController();
    fetch(`/api/services/${encodeURIComponent(serviceName)}/brief`, { signal: controller.signal })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(data => setBrief(data))
      .catch(err => {
        if (err.name !== "AbortError") {
          setBrief(null);
          setError("Failed to load service overview");
        }
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [serviceName]);

  // Build healthMap from dependency nodes included in the brief.
  const initialHealthMap: Record<string, "healthy" | "degraded" | "unhealthy" | "unknown"> | undefined =
    brief?.dependencies
      ? Object.fromEntries(brief.dependencies.nodes.map(n => [n.name, n.status]))
      : undefined;

  // Convert brief dependency nodes/edges to the shape ServiceDependencyGraph expects.
  const initialDepData = useMemo(() =>
    brief?.dependencies
      ? {
          nodes: brief.dependencies.nodes.map(n => ({ id: n.id, name: n.name, type: n.type })),
          edges: brief.dependencies.edges.map(e => ({ source: e.source, target: e.target, label: e.label })),
        }
      : undefined,
    [brief?.dependencies],
  );

  const dependencySource = brief?.dependencies?.source;

  // When fetch fails entirely, use errorStatus instead of loadingStatus
  const fallbackStatus = error ? errorStatus : loadingStatus;

  if (error && !brief) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-6 text-center">
          <p className="text-sm text-red-400">{error}</p>
          <button
            className="mt-2 text-xs text-zinc-400 hover:text-zinc-200 underline"
            onClick={() => window.location.reload()}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* ── AI Brief ──────────────────────────────────── */}
      <section>
        <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/50 mb-3">
          AI Brief
        </div>
        <div className="h-px bg-border/25 mb-4" />
        {loading && !brief ? (
          <ServiceBriefSkeleton />
        ) : (
          <ServiceBriefComponent
            summary={brief?.summary ?? null}
            sectionStatus={brief?.sections.summary ?? fallbackStatus}
          />
        )}
      </section>

      {/* ── Metrics ──────────────────────────────────── */}
      <section>
        <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/50 mb-3">
          Metrics
        </div>
        <div className="h-px bg-border/25 mb-4" />
        <ServiceMetrics serviceName={serviceName} />
      </section>

      {/* ── Infrastructure ────────────────────────────── */}
      <section>
        <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/50 mb-3">
          Infrastructure
        </div>
        <div className="h-px bg-border/25 mb-4" />
        <InfrastructureStatus
          infrastructure={brief?.infrastructure ?? null}
          sectionStatus={brief?.sections.infrastructure ?? fallbackStatus}
        />
      </section>

      {/* ── Recent Changes ────────────────────────────── */}
      <section>
        <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/50 mb-3">
          Recent Changes
        </div>
        <div className="h-px bg-border/25 mb-4" />
        <RecentChanges
          changes={brief?.changes ?? null}
          sectionStatus={brief?.sections.changes ?? fallbackStatus}
        />
      </section>

      {/* ── Dependencies ──────────────────────────────── */}
      <section>
        <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/50 mb-3">
          Dependencies
        </div>
        <div className="h-px bg-border/25 mb-4" />
        <div style={{ height: 300 }}>
          <ServiceDependencyGraph
            serviceName={serviceName}
            onViewService={onViewService}
            dependencySource={dependencySource}
            initialData={initialDepData}
            initialHealthMap={initialHealthMap}
          />
        </div>
      </section>
    </div>
  );
}
