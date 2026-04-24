import { useState, useEffect, useCallback, lazy, Suspense } from "react";
import { ServiceDetailHeader } from "./ServiceDetailHeader";
import { ServiceHistory } from "./ServiceHistory";
import { ServiceScanOverride } from "./scan/ServiceScanOverride";
const ServiceOverview = lazy(() => import("./ServiceOverview").then(m => ({ default: m.ServiceOverview })));
import { useStackContext } from "../contexts/StackContext";
import type { useWebSocket } from "../hooks/useWebSocket";

type TabId = "overview" | "history" | "scan";

interface ServiceDetailProps {
  serviceName: string;
  ws: { send: ReturnType<typeof useWebSocket>["send"]; messages: ReturnType<typeof useWebSocket>["messages"] };
  onBack: () => void;
  onViewInvestigation: (id: string) => void;
  onViewService: (name: string) => void;
  grafanaUrl?: string;
  prometheusDatasource?: string;
  metricQuery?: string;
}

interface ServiceMetadata {
  alias?: string | null;
  tags?: string[];
}

type HealthStatus = "healthy" | "degraded" | "down" | "unknown";

const TABS: { id: TabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "history", label: "Investigations" },
  { id: "scan", label: "Scan" },
];

export function ServiceDetail({
  serviceName,
  ws,
  onBack,
  onViewInvestigation,
  onViewService,
  grafanaUrl,
  prometheusDatasource,
  metricQuery,
}: ServiceDetailProps) {
  const { stackFetch } = useStackContext();
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [metadata, setMetadata] = useState<ServiceMetadata | null>(null);
  const [healthStatus, setHealthStatus] = useState<HealthStatus>("unknown");
  const [healthCheckedAt, setHealthCheckedAt] = useState<number | null>(null);
  const [investigationCount, setInvestigationCount] = useState(0);
  const [aliasEditorOpen, setAliasEditorOpen] = useState(false);
  const [tagEditorOpen, setTagEditorOpen] = useState(false);

  // Fetch metadata, health, and investigation count on mount / serviceName change
  useEffect(() => {
    let cancelled = false;

    async function fetchAll() {
      const [metaRes, healthRes, invRes] = await Promise.all([
        stackFetch(`/api/services/${encodeURIComponent(serviceName)}/metadata`).catch(() => null),
        stackFetch("/api/services/health").catch(() => null),
        stackFetch(`/api/investigations?service=${encodeURIComponent(serviceName)}&limit=100`).catch(() => null),
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
        setHealthCheckedAt(Date.now());
      }

      // Investigation count — API returns flat InvestigationRow[] array
      if (invRes?.ok) {
        const invData = await invRes.json();
        // API returns {rows, total, hasMore}. Use total (count matching filters
        // ignoring limit) so the badge stays accurate even if we cap the fetch.
        setInvestigationCount(typeof invData.total === "number" ? invData.total : 0);
      }
    }

    fetchAll();
    return () => { cancelled = true; };
  }, [serviceName]);

  const handleInvestigate = useCallback(() => {
    ws.send({ type: "chat", message: `investigate ${serviceName}`, serviceContext: serviceName });
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
      return `Investigations (${investigationCount})`;
    }
    return tab.label;
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <ServiceDetailHeader
        serviceName={serviceName}
        healthStatus={healthStatus}
        healthCheckedAt={healthCheckedAt}
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
        grafanaUrl={grafanaUrl}
        prometheusDatasource={prometheusDatasource}
        metricQuery={metricQuery}
      />

      {/* Tab navigation */}
      <div className="px-6 pt-3 border-b border-border/25">
        <div className="flex items-center gap-1" role="tablist">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              id={`tab-${tab.id}`}
              role="tab"
              aria-selected={activeTab === tab.id}
              aria-controls={`tabpanel-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2 text-[13px] font-body font-medium rounded-t transition-colors relative ${
                activeTab === tab.id
                  ? "text-primary"
                  : "text-muted-foreground/50 hover:text-foreground/70"
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
      <div
        id={`tabpanel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`tab-${activeTab}`}
        className="flex-1 overflow-y-auto p-6"
      >
        {activeTab === "overview" && (
          <Suspense fallback={<div className="h-40 rounded-lg bg-muted/30 shimmer-skeleton" />}>
            <ServiceOverview serviceName={serviceName} onViewService={onViewService} />
          </Suspense>
        )}
        {activeTab === "history" && (
          <ServiceHistory serviceName={serviceName} onViewInvestigation={onViewInvestigation} />
        )}
        {activeTab === "scan" && (
          <ServiceScanOverride serviceName={serviceName} />
        )}
      </div>
    </div>
  );
}
