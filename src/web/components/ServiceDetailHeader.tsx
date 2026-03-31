import { Button } from "@/components/ui/button";
import { ArrowLeft, Search, ExternalLink, Pencil, Plus } from "lucide-react";
import { AliasEditor, TagEditor } from "./ServiceAliasEditor";

interface ServiceDetailHeaderProps {
  serviceName: string;
  healthStatus?: "healthy" | "degraded" | "down" | "unknown";
  healthCheckedAt?: number | null;
  alias?: string | null;
  tags?: string[];
  investigationCount?: number;
  aliasEditorOpen: boolean;
  tagEditorOpen: boolean;
  grafanaUrl?: string;
  metricQuery?: string;
  onBack: () => void;
  onInvestigate: () => void;
  onEditAlias: () => void;
  onAddTag: () => void;
  onAliasSaved: (newAlias: string | null) => void;
  onTagsSaved: (newTags: string[]) => void;
  onAliasEditorOpenChange: (open: boolean) => void;
  onTagEditorOpenChange: (open: boolean) => void;
}

function healthDotClass(status?: string): string {
  switch (status) {
    case "healthy":
      return "w-2.5 h-2.5 rounded-full bg-success ring-2 ring-success/20";
    case "degraded":
      return "w-2.5 h-2.5 rounded-full bg-warning ring-2 ring-warning/20";
    case "down":
      return "w-2.5 h-2.5 rounded-full bg-destructive ring-2 ring-destructive/20 animate-status-pulse";
    default:
      return "w-2.5 h-2.5 rounded-full bg-muted-foreground/30 ring-2 ring-muted-foreground/10";
  }
}

function healthLabel(status?: string): string {
  switch (status) {
    case "healthy": return "Healthy";
    case "degraded": return "Degraded";
    case "down": return "Down";
    default: return "Unknown";
  }
}

function buildGrafanaExploreUrl(baseUrl: string, query: string): string {
  const stripped = baseUrl.replace(/\/+$/, "");
  const left = JSON.stringify({
    datasource: "Prometheus",
    queries: [{ refId: "A", expr: query, datasource: { type: "prometheus", uid: "" } }],
    range: { from: "now-1h", to: "now" },
  });
  return `${stripped}/explore?orgId=1&left=${encodeURIComponent(left)}`;
}

function formatCheckedAgo(ts: number | null | undefined): string | null {
  if (!ts) return null;
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

export function ServiceDetailHeader({
  serviceName,
  healthStatus,
  healthCheckedAt,
  alias,
  tags = [],
  investigationCount = 0,
  aliasEditorOpen,
  tagEditorOpen,
  grafanaUrl,
  metricQuery,
  onBack,
  onInvestigate,
  onEditAlias,
  onAddTag,
  onAliasSaved,
  onTagsSaved,
  onAliasEditorOpenChange,
  onTagEditorOpenChange,
}: ServiceDetailHeaderProps) {
  const displayName = alias || serviceName;

  return (
    <div className="px-6 pt-5 pb-4 border-b border-border/25">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5 mb-3">
        <button
          onClick={onBack}
          className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground/60 hover:text-primary transition-colors"
        >
          Operations Desk
        </button>
        <span className="font-mono text-[9px] text-muted-foreground/30">&rsaquo;</span>
        <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground/40">
          Service Detail
        </span>
      </div>

      {/* Title row: name left, actions right */}
      <div className="flex items-center justify-between gap-4 mb-2">
        <div className="flex items-center gap-3 min-w-0">
          <Button
            variant="ghost"
            onClick={onBack}
            className="h-8 w-8 p-0 -ml-1 text-muted-foreground/50 hover:text-foreground/70 transition-colors shrink-0"
            aria-label="Back to dashboard"
          >
            <ArrowLeft size={16} />
          </Button>
          <div className={healthDotClass(healthStatus)} />
          <h1 className="font-display text-[28px] font-bold text-foreground/90 leading-tight text-pretty truncate">
            {displayName}
          </h1>
          {alias && (
            <span className="font-mono text-[11px] text-muted-foreground/40 shrink-0">
              {serviceName}
            </span>
          )}
          {tags.map((tag) => (
            <span
              key={tag}
              className="font-mono text-[11px] bg-secondary/50 text-muted-foreground/70 rounded px-1.5 py-0.5 shrink-0"
            >
              {tag}
            </span>
          ))}
        </div>

        {/* Action buttons — right aligned */}
        <div className="flex items-center gap-2 shrink-0">
          <div className="relative">
            <Button
              variant="ghost"
              onClick={onEditAlias}
              className="h-9 px-4 text-[12px] font-mono text-muted-foreground border border-border/50 rounded-lg hover:text-foreground/70 hover:bg-secondary/30 transition-colors"
            >
              <Pencil size={13} className="mr-1.5" />
              Edit Name
            </Button>
            <AliasEditor
              serviceName={serviceName}
              currentAlias={alias ?? null}
              onSaved={onAliasSaved}
              open={aliasEditorOpen}
              onOpenChange={onAliasEditorOpenChange}
            />
          </div>

          <div className="relative">
            <Button
              variant="ghost"
              onClick={onAddTag}
              className="h-9 px-4 text-[12px] font-mono text-muted-foreground border border-border/50 rounded-lg hover:text-foreground/70 hover:bg-secondary/30 transition-colors"
            >
              <Plus size={13} className="mr-1.5" />
              Tag
            </Button>
            <TagEditor
              serviceName={serviceName}
              currentTags={tags}
              onSaved={onTagsSaved}
              open={tagEditorOpen}
              onOpenChange={onTagEditorOpenChange}
            />
          </div>

          {grafanaUrl && metricQuery ? (
            <a
              href={buildGrafanaExploreUrl(grafanaUrl, metricQuery)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center h-9 px-4 text-[12px] font-mono bg-secondary border border-border rounded-lg text-foreground/70 hover:text-foreground/90 hover:bg-secondary/80 transition-colors"
            >
              <ExternalLink size={13} className="mr-1.5" />
              Open in Grafana
            </a>
          ) : (
            <Button
              variant="outline"
              disabled
              title={!grafanaUrl ? "Configure webUrl on your dashboards provider" : "No metrics discovered for this service"}
              className="h-9 px-4 text-[12px] font-mono bg-secondary border-border rounded-lg text-foreground/70 hover:text-foreground/90 hover:bg-secondary/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ExternalLink size={13} className="mr-1.5" />
              Open in Grafana
            </Button>
          )}

          <Button
            onClick={onInvestigate}
            className="h-9 px-5 text-[12px] font-mono bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
          >
            <Search size={13} className="mr-1.5" />
            Investigate
          </Button>
        </div>
      </div>

      {/* Status line — monospace bar with health */}
      <div className="mt-3 py-2.5 border-t border-b border-border/25 flex items-center gap-5 font-mono text-[11px] font-medium text-muted-foreground/70">
        <span className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${
            healthStatus === "healthy" ? "bg-success" :
            healthStatus === "degraded" ? "bg-warning" :
            healthStatus === "down" ? "bg-destructive animate-status-pulse" :
            "bg-muted-foreground/30"
          }`} />
          <span className="uppercase tracking-[0.06em]">{healthLabel(healthStatus)}</span>
        </span>
        {formatCheckedAgo(healthCheckedAt) && (
          <>
            <span className="text-border">·</span>
            <span className="text-muted-foreground/50">Last checked {formatCheckedAgo(healthCheckedAt)}</span>
          </>
        )}
      </div>
    </div>
  );
}
