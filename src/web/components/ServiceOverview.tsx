import { useState, useEffect } from "react";
import { ServiceBrief as ServiceBriefComponent, ServiceBriefSkeleton } from "./ServiceBrief";
import { RecentChanges } from "./RecentChanges";
import { InfrastructureStatus } from "./InfrastructureStatus";
import { ServiceDependencyGraph } from "./ServiceDependencyGraph";
import type { ServiceBrief, SectionStatus } from "../../types/service-brief.js";

interface ServiceOverviewProps {
  serviceName: string;
  onViewService: (name: string) => void;
}

const loadingStatus: SectionStatus = { status: "ok" as const };

export function ServiceOverview({ serviceName, onViewService }: ServiceOverviewProps) {
  const [brief, setBrief] = useState<ServiceBrief | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const controller = new AbortController();
    fetch(`/api/services/${encodeURIComponent(serviceName)}/brief`, { signal: controller.signal })
      .then(res => res.json())
      .then(data => setBrief(data))
      .catch(err => { if (err.name !== "AbortError") setBrief(null); })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [serviceName]);

  // Build healthMap from dependency nodes
  const healthMap: Record<string, "healthy" | "degraded" | "unhealthy" | "unknown"> | undefined =
    brief?.dependencies
      ? Object.fromEntries(brief.dependencies.nodes.map(n => [n.name, n.status]))
      : undefined;

  const dependencySource = brief?.dependencies?.source;

  return (
    <div className="space-y-4">
      {/* AI Brief — full-width */}
      {loading && !brief ? (
        <ServiceBriefSkeleton />
      ) : (
        <ServiceBriefComponent
          summary={brief?.summary ?? null}
          sectionStatus={brief?.sections.summary ?? loadingStatus}
        />
      )}

      {/* Changes + Infrastructure — side-by-side grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <RecentChanges
          changes={brief?.changes ?? null}
          sectionStatus={brief?.sections.changes ?? loadingStatus}
        />
        <InfrastructureStatus
          infrastructure={brief?.infrastructure ?? null}
          sectionStatus={brief?.sections.infrastructure ?? loadingStatus}
        />
      </div>

      {/* Dependency graph — full-width, condensed */}
      <div style={{ height: 300 }}>
        <ServiceDependencyGraph
          serviceName={serviceName}
          onViewService={onViewService}
          healthMap={healthMap}
          dependencySource={dependencySource}
        />
      </div>
    </div>
  );
}
