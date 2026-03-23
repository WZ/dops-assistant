import { useState, useEffect, useCallback } from "react";
import { ServiceDetailHeader } from "./ServiceDetailHeader";
import { ServiceMetrics } from "./ServiceMetrics";
import { ServiceHistory } from "./ServiceHistory";
import { ServiceDependencyGraph } from "./ServiceDependencyGraph";
import type { useWebSocket } from "../hooks/useWebSocket";

type TabId = "metrics" | "history" | "dependencies";

interface ServiceDetailProps {
  serviceName: string;
  ws: { send: ReturnType<typeof useWebSocket>["send"]; messages: ReturnType<typeof useWebSocket>["messages"] };
  onBack: () => void;
  onViewInvestigation: (id: string) => void;
  onViewService: (name: string) => void;
}

interface ServiceMetadata {
  alias?: string | null;
  tags?: string[];
}

type HealthStatus = "healthy" | "degraded" | "down" | "unknown";

const TABS: { id: TabId; label: string }[] = [
  { id: "metrics", label: "Metrics" },
  { id: "history", label: "History" },
  { id: "dependencies", label: "Dependencies" },
];

export function ServiceDetail({
  serviceName,
  ws,
  onBack,
  onViewInvestigation,
  onViewService,
}: ServiceDetailProps) {
  const [activeTab, setActiveTab] = useState<TabId>("metrics");
  const [metadata, setMetadata] = useState<ServiceMetadata | null>(null);
  const [healthStatus, setHealthStatus] = useState<HealthStatus>("unknown");
  const [investigationCount, setInvestigationCount] = useState(0);
  const [aliasEditorOpen, setAliasEditorOpen] = useState(false);
  const [tagEditorOpen, setTagEditorOpen] = useState(false);

  // Fetch metadata, health, and investigation count on mount / serviceName change
  useEffect(() => {
    let cancelled = false;

    async function fetchAll() {
      const [metaRes, healthRes, invRes] = await Promise.all([
        fetch(`/api/services/${encodeURIComponent(serviceName)}/metadata`).catch(() => null),
        fetch("/api/services/health").catch(() => null),
        fetch(`/api/investigations?service=${encodeURIComponent(serviceName)}&limit=1`).catch(() => null),
      ]);

      if (cancelled) return;

      // Metadata
      if (metaRes?.ok) {
        const data = await metaRes.json();
        setMetadata({ alias: data.alias ?? null, tags: data.tags ?? [] });
      } else {
        setMetadata({ alias: null, tags: [] });
      }

      // Health — response is a map of service name -> status
      if (healthRes?.ok) {
        const healthMap = await healthRes.json();
        const status = healthMap[serviceName];
        setHealthStatus(status ?? "unknown");
      }

      // Investigation count — use total from paginated response
      if (invRes?.ok) {
        const invData = await invRes.json();
        setInvestigationCount(invData.total ?? invData.investigations?.length ?? 0);
      }
    }

    fetchAll();
    return () => { cancelled = true; };
  }, [serviceName]);

  const handleInvestigate = useCallback(() => {
    ws.send({ type: "chat", message: `investigate ${serviceName}` } as any);
  }, [ws, serviceName]);

  const handleEditAlias = useCallback(() => {
    setTagEditorOpen(false);
    setAliasEditorOpen((prev) => !prev);
  }, []);

  const handleAddTag = useCallback(() => {
    setAliasEditorOpen(false);
    setTagEditorOpen((prev) => !prev);
  }, []);

  const handleAliasSaved = useCallback((newAlias: string | null) => {
    setMetadata((prev) => prev ? { ...prev, alias: newAlias } : { alias: newAlias, tags: [] });
  }, []);

  const handleTagsSaved = useCallback((newTags: string[]) => {
    setMetadata((prev) => prev ? { ...prev, tags: newTags } : { alias: null, tags: newTags });
  }, []);

  const tabLabel = (tab: typeof TABS[number]) => {
    if (tab.id === "history" && investigationCount > 0) {
      return `${tab.label} (${investigationCount})`;
    }
    return tab.label;
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <ServiceDetailHeader
        serviceName={serviceName}
        healthStatus={healthStatus}
        alias={metadata?.alias}
        tags={metadata?.tags}
        investigationCount={investigationCount}
        aliasEditorOpen={aliasEditorOpen}
        tagEditorOpen={tagEditorOpen}
        onBack={onBack}
        onInvestigate={handleInvestigate}
        onEditAlias={handleEditAlias}
        onAddTag={handleAddTag}
        onAliasSaved={handleAliasSaved}
        onTagsSaved={handleTagsSaved}
        onAliasEditorOpenChange={setAliasEditorOpen}
        onTagEditorOpenChange={setTagEditorOpen}
      />

      {/* Tab navigation */}
      <div className="px-6 pt-3 border-b border-border/25">
        <div className="flex items-center gap-1" role="tablist">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-3 py-2 text-[11px] font-mono rounded-t transition-colors relative ${
                activeTab === tab.id
                  ? "text-primary bg-primary/8"
                  : "text-muted-foreground/50 hover:text-foreground/70 hover:bg-secondary/30"
              }`}
            >
              {tabLabel(tab)}
              {activeTab === tab.id && (
                <div className="absolute bottom-0 left-1 right-1 h-[2px] bg-primary rounded-full" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-6">
        {activeTab === "metrics" && <ServiceMetrics serviceName={serviceName} />}
        {activeTab === "history" && (
          <ServiceHistory serviceName={serviceName} onViewInvestigation={onViewInvestigation} />
        )}
        {activeTab === "dependencies" && (
          <ServiceDependencyGraph serviceName={serviceName} onViewService={onViewService} />
        )}
      </div>
    </div>
  );
}
